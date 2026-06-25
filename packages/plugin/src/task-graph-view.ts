import { ItemView, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import cytoscapeDagre from "cytoscape-dagre";
import nodeHtmlLabel from "cytoscape-node-html-label";
import { isTask, buildChildMap, type Task, type Project } from "@pm-compass/shared";
import { loadVaultData } from "./vault-reader";
import { TaskModal } from "./task-creator";

cytoscape.use(cytoscapeDagre as cytoscape.Ext);
cytoscape.use(nodeHtmlLabel as unknown as cytoscape.Ext);

export const TASK_GRAPH_VIEW_TYPE = "pm-compass-task-graph";

interface NodeData {
  id: string;
  label: string;
  status: string;
  statusColor: string;
  priorityColor: string;
  due: string;
  isOverdue: boolean;
  filePath: string;
  nodeType: "task" | "project";
  childCount: number;
  color: string;
}

interface HtmlLabelOption {
  query: string;
  tpl: (data: NodeData) => string;
}

interface PluginWithPanelConfig {
  settings: {
    projectsFolder: string;
    panelConfig: { showActiveOnly: boolean };
  };
  saveSettings(): Promise<void>;
}

const STATUS_COLORS: Record<string, string> = {
  "todo": "#6b7280",
  "in-progress": "#3b82f6",
  "blocked": "#ef4444",
  "review": "#8b5cf6",
  "done": "#22c55e",
  "cancelled": "#9ca3af",
};

const PRIORITY_COLORS: Record<string, string> = {
  "critical": "#ef4444",
  "high": "#f97316",
  "medium": "#eab308",
  "low": "#22c55e",
};

function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

function getPriorityColor(priority: string | undefined): string {
  return priority ? (PRIORITY_COLORS[priority] ?? "") : "";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class TaskGraphView extends ItemView {
  private cy: Core | null = null;
  private cys: Core[] = [];
  private tasks: Task[] = [];
  private projects: Project[] = [];
  private drillPath: Array<Project | Task> = [];
  private showActiveOnly = true;
  private readonly plugin: PluginWithPanelConfig;
  private breadcrumbEl!: HTMLElement;
  private addTaskBtn!: HTMLElement;
  private cyContainer!: HTMLElement;
  private refreshTimer: ReturnType<typeof window.setTimeout> | null = null;
  private tapTimer: ReturnType<typeof window.setTimeout> | null = null;
  private sepSvg: SVGSVGElement | null = null;
  private settingsPanelEl: HTMLElement | null = null;
  private settingsPanelOpen = false;

  constructor(leaf: WorkspaceLeaf, plugin: PluginWithPanelConfig) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return TASK_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Task Graph";
  }

  getIcon(): string {
    return "workflow";
  }

  async onOpen(): Promise<void> {
    this.showActiveOnly = this.plugin.settings.panelConfig.showActiveOnly;
    const breadcrumbBar = this.contentEl.createDiv({ cls: "pm-breadcrumb" });
    this.breadcrumbEl = breadcrumbBar.createSpan({ cls: "pm-breadcrumb-items" });
    this.buildAddButton(breadcrumbBar);
    this.buildGear(breadcrumbBar);
    const scrollWrapper = this.contentEl.createDiv({ cls: "pm-compass-scroll-wrapper" });
    this.cyContainer = scrollWrapper.createDiv({
      cls: "pm-compass-graph-container",
    });
    await this.refresh();

    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        if (this.isInProjectsFolder(file.path)) this.scheduleRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (this.isInProjectsFolder(file.path)) this.scheduleRefresh();
      }),
    );
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.tapTimer !== null) window.clearTimeout(this.tapTimer);
    this.cy?.destroy();
    this.cy = null;
    for (const cy of this.cys) cy.destroy();
    this.cys = [];
  }

  private isInProjectsFolder(filePath: string): boolean {
    return filePath.startsWith(this.plugin.settings.projectsFolder + "/");
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 300);
  }

  private buildAddButton(bar: HTMLElement): void {
    this.addTaskBtn = bar.createEl("button", { cls: "pm-compass-add-btn" });
    setIcon(this.addTaskBtn, "plus");
    this.addTaskBtn.setAttribute("aria-label", "New task");
    this.addTaskBtn.style.display = "none";

    this.addTaskBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.drillPath.length === 0) return;
      const proj = this.drillPath[0] as Project;
      const last = this.drillPath[this.drillPath.length - 1];
      const parentTask = isTask(last) ? last : undefined;
      const projectTasks = this.tasks.filter((t) => t.projectId === proj.id);
      new TaskModal(this.app, {
        mode: "create",
        projectId: proj.id,
        projectFilePath: proj.filePath,
        parentId: parentTask?.id,
        existingTasks: projectTasks,
        onSuccess: () => { void this.refresh(); },
      }).open();
    });
  }

  private buildGear(bar: HTMLElement): void {
    const gearBtn = bar.createEl("button", { cls: "pm-compass-gear-btn" });
    setIcon(gearBtn, "settings");
    gearBtn.setAttribute("aria-label", "Graph settings");

    this.settingsPanelEl = bar.createDiv({ cls: "pm-compass-settings-panel" });
    this.settingsPanelEl.style.display = "none";

    const activeLabel = this.settingsPanelEl.createEl("label", { cls: "pm-compass-toggle" });
    const checkbox = activeLabel.createEl("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.showActiveOnly;
    activeLabel.createSpan({ text: " Active only" });
    checkbox.addEventListener("change", () => {
      this.showActiveOnly = checkbox.checked;
      this.plugin.settings.panelConfig.showActiveOnly = checkbox.checked;
      void this.plugin.saveSettings();
      this.renderGraph();
    });

    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.settingsPanelOpen = !this.settingsPanelOpen;
      this.settingsPanelEl!.style.display = this.settingsPanelOpen ? "block" : "none";
      gearBtn.classList.toggle("is-active", this.settingsPanelOpen);
    });

    this.registerDomEvent(document, "click", () => {
      if (this.settingsPanelOpen) {
        this.settingsPanelOpen = false;
        this.settingsPanelEl!.style.display = "none";
        gearBtn.classList.remove("is-active");
      }
    });
  }

  private updateBreadcrumb(): void {
    this.breadcrumbEl.empty();

    if (this.drillPath.length === 0) {
      this.breadcrumbEl.createSpan({ cls: "pm-breadcrumb-item current", text: "All" });
    } else {
      const allItem = this.breadcrumbEl.createSpan({ cls: "pm-breadcrumb-item", text: "All" });
      allItem.addEventListener("click", () => {
        this.drillPath = [];
        this.renderGraph();
      });
    }

    for (let i = 0; i < this.drillPath.length; i++) {
      const entry = this.drillPath[i];
      const isCurrent = i === this.drillPath.length - 1;

      this.breadcrumbEl.createSpan({ cls: "pm-breadcrumb-sep", text: "›" });

      const item = this.breadcrumbEl.createSpan({
        cls: "pm-breadcrumb-item" + (isCurrent ? " current" : ""),
        text: entry.title,
      });

      if (!isCurrent) {
        const targetLen = i + 1;
        item.addEventListener("click", () => {
          this.drillPath = this.drillPath.slice(0, targetLen);
          this.renderGraph();
        });
      }
    }

    this.addTaskBtn.style.display = this.drillPath.length > 0 ? "flex" : "none";
  }

  private async refresh(): Promise<void> {
    const data = await loadVaultData(this.app, this.plugin.settings.projectsFolder);
    this.projects = data.projects;
    this.tasks = data.tasks;

    // Reset drill if the pinned project no longer exists
    if (this.drillPath.length > 0 && !isTask(this.drillPath[0])) {
      const proj = this.drillPath[0] as Project;
      if (!this.projects.find((p) => p.id === proj.id)) {
        this.drillPath = [];
      }
    }

    this.renderGraph();
  }

  private renderGraph(): void {
    if (!this.cyContainer) return;

    this.updateBreadcrumb();

    if (this.tapTimer !== null) {
      window.clearTimeout(this.tapTimer);
      this.tapTimer = null;
    }

    this.cy?.destroy();
    this.cy = null;
    for (const cy of this.cys) cy.destroy();
    this.cys = [];
    this.sepSvg = null;
    this.cyContainer.empty();
    this.cyContainer.style.width = "";
    this.cyContainer.style.height = "";

    if (this.drillPath.length === 0) {
      this.renderAllProjectsTable();
      return;
    }

    let elements = this.buildElements();

    // On narrow displays, drop context/anchor nodes so only tasks are shown
    const isNarrow = this.cyContainer.clientWidth > 0 && this.cyContainer.clientWidth < 500;
    if (isNarrow) {
      elements = elements.filter(
        (e) => !e.data.isContext && e.data.edgeType !== "virtual",
      );
    }

    if (elements.length === 0) {
      this.cyContainer.createEl("p", {
        text: "No tasks found.",
        cls: "pm-compass-empty",
      });
      return;
    }

    const layoutOptions = {
      name: "dagre", rankDir: "LR", nodeSep: 50, rankSep: 70, padding: 20,
    } as unknown as cytoscape.LayoutOptions;

    this.cy = cytoscape({
      container: this.cyContainer,
      elements,
      style: [
        {
          selector: "node[nodeType='task']",
          style: {
            shape: "round-rectangle",
            width: 160,
            height: 60,
            "background-color": "transparent",
            "border-width": 0,
            label: "",
          },
        },
        {
          selector: "node[nodeType='project']",
          style: {
            shape: "round-rectangle",
            width: 160,
            height: 60,
            "background-color": "data(color)",
            "background-opacity": 0.15,
            "border-color": "data(color)",
            "border-width": 1.5,
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "center",
            "font-size": 11,
            "font-weight": "bold",
            color: "data(color)",
          },
        },
        {
          selector: "node[nodeType='context-task']",
          style: {
            shape: "round-rectangle",
            width: 160,
            height: 60,
            "background-color": "data(statusColor)",
            "background-opacity": 0.15,
            "border-color": "data(statusColor)",
            "border-width": 1.5,
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "center",
            "font-size": 11,
            "font-weight": "bold",
            color: "data(statusColor)",
          },
        },
        {
          selector: "edge",
          style: {
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": "#888",
            "target-arrow-color": "#888",
            width: 1.5,
          },
        },
        {
          selector: "edge[edgeType='virtual']",
          style: { opacity: 0 },
        },
      ],
    });

    (this.cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[]) => void }).nodeHtmlLabel([
      { query: "node[nodeType='task']", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
    ]);

    this.cy.on("tap", "node[nodeType='project']", (evt) => {
      const rawId = evt.target.data("id") as string;
      const proj = this.projects.find((p) => `proj-${p.id}` === rawId);
      if (!proj) return;
      this.drillPath = [proj];
      this.renderGraph();
    });

    // Single-click opens task editor; debounce to avoid firing on double-click
    this.cy.on("tap", "node[nodeType='task']", (evt) => {
      const taskId = evt.target.data("id") as string;
      if (this.tapTimer !== null) {
        window.clearTimeout(this.tapTimer);
        this.tapTimer = null;
        return;
      }
      this.tapTimer = window.setTimeout(() => {
        this.tapTimer = null;
        const task = this.tasks.find((t) => t.id === taskId);
        if (!task) return;
        const projectTasks = this.tasks.filter((t) => t.projectId === task.projectId);
        new TaskModal(this.app, {
          mode: "edit",
          task,
          existingTasks: projectTasks,
          onSuccess: () => { void this.refresh(); },
        }).open();
      }, 250);
    });

    // Double-click drills into subtasks
    this.cy.on("dbltap", "node[nodeType='task']", (evt) => {
      if (this.tapTimer !== null) {
        window.clearTimeout(this.tapTimer);
        this.tapTimer = null;
      }
      if ((evt.target.data("childCount") as number) === 0) return;

      const taskId = evt.target.data("id") as string;
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;

      if (this.drillPath.length === 0) {
        const proj = this.projects.find((p) => p.id === task.projectId);
        this.drillPath = proj ? [proj, task] : [task];
      } else {
        this.drillPath.push(task);
      }
      this.renderGraph();
    });

    this.cy.one("layoutstop", () => {
      const bb = this.cy!.elements().boundingBox({});
      const pad = 30;
      const w = Math.ceil(bb.w) + pad * 2;
      const h = Math.ceil(bb.h) + pad * 2;
      this.cyContainer.style.width = `${w}px`;
      this.cyContainer.style.height = `${h}px`;
      this.cy!.resize();
      this.cy!.viewport({ zoom: 1, pan: { x: pad - bb.x1, y: pad - bb.y1 } });
      this.cy!.userPanningEnabled(false);
      this.cy!.userZoomingEnabled(false);
      this.renderSeparators();
    });
    this.cy.on("render", () => this.renderSeparators());

    this.cy.layout(layoutOptions).run();
  }

  private renderAllProjectsTable(): void {
    const activeStatuses = new Set(["todo", "in-progress", "blocked", "review"]);
    const table = this.cyContainer.createDiv({ cls: "pm-projects-table" });
    let anyRow = false;

    for (const proj of this.projects) {
      let tasks = this.tasks.filter((t) => t.projectId === proj.id && !t.parentId);
      if (this.showActiveOnly) tasks = tasks.filter((t) => activeStatuses.has(t.status));

      anyRow = true;
      const row = table.createDiv({ cls: "pm-project-row" });

      // Left column: project badge
      const badgeCol = row.createDiv({ cls: "pm-project-badge-col" });
      const badge = badgeCol.createDiv({ cls: "pm-project-badge" });
      badge.setText(proj.title);
      const color = proj.color ?? "#888888";
      badge.style.setProperty("border-color", color);
      badge.style.setProperty("color", color);
      badge.style.setProperty("background-color", color + "26");
      badge.addEventListener("click", () => {
        this.drillPath = [proj];
        this.renderGraph();
      });

      // Right column: task graph
      const tasksCol = row.createDiv({ cls: "pm-project-tasks-col" });
      if (tasks.length === 0) {
        tasksCol.createEl("p", { text: "No active tasks.", cls: "pm-compass-empty pm-compass-empty--inline" });
      } else {
        const cyEl = tasksCol.createDiv({ cls: "pm-project-tasks-cy" });
        this.createProjectTaskCy(cyEl, proj, tasks);
      }
    }

    if (!anyRow) {
      this.cyContainer.createEl("p", { text: "No projects found.", cls: "pm-compass-empty" });
    }
  }

  private createProjectTaskCy(container: HTMLElement, proj: Project, tasks: Task[]): void {
    const today = new Date().toISOString().slice(0, 10);
    const doneStatuses = new Set(["done", "cancelled"]);
    const childMap = buildChildMap(this.tasks);
    const taskIdSet = new Set(tasks.map((t) => t.id));
    const elements: ElementDefinition[] = [];

    for (const t of tasks) {
      elements.push({
        data: {
          id: t.id,
          label: t.title,
          status: t.status,
          statusColor: getStatusColor(t.status),
          priorityColor: getPriorityColor(t.priority),
          due: t.due ?? "",
          isOverdue: !!t.due && t.due < today && !doneStatuses.has(t.status),
          filePath: t.filePath,
          nodeType: "task",
          childCount: childMap.get(t.id)?.length ?? 0,
          color: "",
        },
      });
    }
    for (const t of tasks) {
      for (const depId of t.dependencies) {
        if (taskIdSet.has(depId)) {
          elements.push({ data: { id: `${depId}->${t.id}`, source: depId, target: t.id } });
        }
      }
    }

    const cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: "node[nodeType='task']",
          style: { shape: "round-rectangle", width: 160, height: 60, "background-color": "transparent", "border-width": 0, label: "" },
        },
        {
          selector: "edge",
          style: { "curve-style": "bezier", "target-arrow-shape": "triangle", "line-color": "#888", "target-arrow-color": "#888", width: 1.5 },
        },
      ],
    });

    (cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[]) => void }).nodeHtmlLabel([
      {
        query: "node[nodeType='task']",
        tpl: (data: NodeData) => this.taskNodeTemplate(data),
      },
    ]);

    cy.on("tap", "node[nodeType='task']", (evt) => {
      const taskId = evt.target.data("id") as string;
      if (this.tapTimer !== null) { window.clearTimeout(this.tapTimer); this.tapTimer = null; return; }
      this.tapTimer = window.setTimeout(() => {
        this.tapTimer = null;
        const task = this.tasks.find((t) => t.id === taskId);
        if (!task) return;
        new TaskModal(this.app, {
          mode: "edit", task,
          existingTasks: this.tasks.filter((t) => t.projectId === task.projectId),
          onSuccess: () => { void this.refresh(); },
        }).open();
      }, 250);
    });

    cy.on("dbltap", "node[nodeType='task']", (evt) => {
      if (this.tapTimer !== null) { window.clearTimeout(this.tapTimer); this.tapTimer = null; }
      if ((evt.target.data("childCount") as number) === 0) return;
      const task = this.tasks.find((t) => t.id === (evt.target.data("id") as string));
      if (!task) return;
      this.drillPath = [proj, task];
      this.renderGraph();
    });

    cy.one("layoutstop", () => {
      const bb = cy.elements().boundingBox({});
      const pad = 20;
      const w = Math.ceil(bb.w) + pad * 2;
      const h = Math.ceil(bb.h) + pad * 2;
      container.style.width = `${w}px`;
      container.style.height = `${h}px`;
      cy.resize();
      cy.viewport({ zoom: 1, pan: { x: pad - bb.x1, y: pad - bb.y1 } });
      cy.userPanningEnabled(false);
      cy.userZoomingEnabled(false);
    });

    cy.layout({ name: "dagre", rankDir: "LR", nodeSep: 20, rankSep: 60, padding: 20 } as unknown as cytoscape.LayoutOptions).run();
    this.cys.push(cy);
  }

  private taskNodeTemplate(data: NodeData): string {
    return `<div class="pm-node-card" style="border:2px solid ${data.statusColor};border-left:none">
      ${data.priorityColor ? `<div class="pm-node-ribbon" style="background:${data.priorityColor}"></div>` : ""}
      <div class="pm-node-body">
        <div class="pm-node-header">
          <div class="pm-node-title">${escapeHtml(data.label)}</div>
          ${data.childCount > 0 ? `<svg class="pm-subtask-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="3" rx="2"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>` : ""}
        </div>
        <div class="pm-node-meta">
          <span class="pm-node-status" style="background:${data.statusColor}22;color:${data.statusColor};border:1px solid ${data.statusColor}55">${escapeHtml(data.status)}</span>
          ${data.due ? `<span class="pm-node-due" style="${data.isOverdue ? "color:#ef4444;font-weight:600" : ""}">${escapeHtml(data.due)}</span>` : ""}
        </div>
      </div>
    </div>`;
  }

  private renderSeparators(): void {
    if (!this.cy || !this.cyContainer) return;

    const svgNS = "http://www.w3.org/2000/svg";
    if (!this.sepSvg) {
      this.sepSvg = document.createElementNS(
        svgNS,
        "svg",
      ) as SVGSVGElement;
      this.sepSvg.classList.add("pm-sep-svg");
      this.cyContainer.appendChild(this.sepSvg);
    }

    while (this.sepSvg.firstChild) {
      this.sepSvg.removeChild(this.sepSvg.firstChild);
    }

    const contextNodes = this.cy
      .nodes("[?isContext]")
      .toArray()
      .sort((a, b) => a.renderedPosition().y - b.renderedPosition().y);

    if (contextNodes.length === 0) return;

    const w = this.cyContainer.clientWidth;
    const h = this.cyContainer.clientHeight;

    const makeLine = (x1: number, y1: number, x2: number, y2: number) => {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.classList.add("pm-sep-line");
      this.sepSvg!.appendChild(line);
    };

    // Vertical line between the context column and task columns
    const taskNodes = this.cy.nodes("[nodeType='task']");
    if (taskNodes.length > 0) {
      const contextMaxX = Math.max(
        ...contextNodes.map((n) => n.renderedPosition().x + n.renderedWidth() / 2),
      );
      const taskMinX = Math.min(
        ...taskNodes
          .toArray()
          .map((n) => n.renderedPosition().x - n.renderedWidth() / 2),
      );
      if (contextMaxX < taskMinX) {
        makeLine((contextMaxX + taskMinX) / 2, 0, (contextMaxX + taskMinX) / 2, h);
      }
    }

    // Horizontal lines between adjacent context rows (meaningful when multiple projects shown)
    for (let i = 0; i < contextNodes.length - 1; i++) {
      const y1 =
        contextNodes[i].renderedPosition().y + contextNodes[i].renderedHeight() / 2;
      const y2 =
        contextNodes[i + 1].renderedPosition().y -
        contextNodes[i + 1].renderedHeight() / 2;
      const midY = (y1 + y2) / 2;
      makeLine(0, midY, w, midY);
    }
  }

  private buildElements(): ElementDefinition[] {
    const activeStatuses = new Set(["todo", "in-progress", "blocked", "review"]);
    const today = new Date().toISOString().slice(0, 10);
    const doneStatuses = new Set(["done", "cancelled"]);
    const childMap = buildChildMap(this.tasks);

    // ── Single-project or drill view ────────────────────────────────────────
    const proj = this.drillPath[0];
    if (isTask(proj)) return []; // guard: drillPath should always start with a Project

    const lastEntry = this.drillPath[this.drillPath.length - 1];

    let targetTasks: Task[];
    let contextId: string;
    let contextElement: ElementDefinition;

    if (isTask(lastEntry)) {
      // Drill view: show subtasks, with the parent task as the context node
      targetTasks = this.tasks.filter((t) => t.parentId === lastEntry.id);
      contextId = `${lastEntry.id}-ctx`;
      contextElement = {
        data: {
          id: contextId,
          label: lastEntry.title,
          nodeType: "context-task",
          isContext: true,
          status: lastEntry.status,
          statusColor: getStatusColor(lastEntry.status),
          due: lastEntry.due ?? "",
          filePath: lastEntry.filePath,
          childCount: 0,
          color: "",
        },
      };
    } else {
      // Single-project view: top-level tasks, with the project as the context node
      targetTasks = this.tasks.filter(
        (t) => t.projectId === proj.id && !t.parentId,
      );
      contextId = `proj-${proj.id}`;
      contextElement = {
        data: {
          id: contextId,
          label: proj.title,
          nodeType: "project",
          isContext: true,
          color: proj.color ?? "#888888",
        },
      };
    }

    if (this.showActiveOnly) {
      targetTasks = targetTasks.filter((t) => activeStatuses.has(t.status));
    }

    const taskIdSet = new Set(targetTasks.map((t) => t.id));
    const elements: ElementDefinition[] = [contextElement];

    for (const t of targetTasks) {
      elements.push({
        data: {
          id: t.id,
          label: t.title,
          status: t.status,
          statusColor: getStatusColor(t.status),
          priorityColor: getPriorityColor(t.priority),
          due: t.due ?? "",
          isOverdue: !!t.due && t.due < today && !doneStatuses.has(t.status),
          filePath: t.filePath,
          nodeType: "task",
          childCount: childMap.get(t.id)?.length ?? 0,
          color: "",
        },
      });
      elements.push({
        data: {
          id: `${contextId}->${t.id}`,
          source: contextId,
          target: t.id,
          edgeType: "virtual",
        },
      });
    }

    for (const task of targetTasks) {
      for (const depId of task.dependencies) {
        if (taskIdSet.has(depId)) {
          elements.push({
            data: {
              id: `${depId}->${task.id}`,
              source: depId,
              target: task.id,
            },
          });
        }
      }
    }

    return elements;
  }
}
