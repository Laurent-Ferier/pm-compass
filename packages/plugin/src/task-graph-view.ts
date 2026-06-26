import { ItemView, Menu, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import cytoscapeDagre from "cytoscape-dagre";
import nodeHtmlLabel from "cytoscape-node-html-label";
import { isTask, buildChildMap, isValidDependencyTarget, type Task, type Project } from "@pm-compass/shared";
import { loadVaultData } from "./vault-reader";
import { TaskModal, ProjectModal, addTaskDependency, removeTaskDependency, patchTaskField, openDropdown } from "./task-creator";

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
  nodeType: "task" | "project" | "context-task";
  childCount: number;
  color: string;
  projId?: string;
  taskId?: string;
}

interface HtmlLabelOption {
  query: string;
  tpl: (data: NodeData) => string;
  cssClass?: string;
}

interface NodeHtmlLabelOptions {
  enablePointerEvents?: boolean;
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

const STATUS_LABELS: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "blocked": "Blocked",
  "review": "Review",
  "done": "Done",
  "cancelled": "Cancelled",
};

const PRIORITY_LABELS: Record<string, string> = {
  "": "None",
  "critical": "Critical",
  "high": "High",
  "medium": "Medium",
  "low": "Low",
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

const ACTIVE_STATUSES = new Set(["todo", "in-progress", "blocked", "review"]);

const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const LINK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

function getEventTarget(evt: { originalEvent?: Event }): Element | null {
  const oe = evt.originalEvent;
  if (!oe) return null;
  if (typeof TouchEvent !== "undefined" && oe instanceof TouchEvent) {
    const touch = oe.changedTouches[0];
    return touch ? document.elementFromPoint(touch.clientX, touch.clientY) : null;
  }
  return (oe as MouseEvent).target as Element | null;
}

function withAlpha(hex: string, alphaHex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const expanded = h.length === 3 ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h;
  return `#${expanded}${alphaHex}`;
}

export class TaskGraphView extends ItemView {
  navigation = false;

  private cy: Core | null = null;
  private cys: Core[] = [];
  private tasks: Task[] = [];
  private projects: Project[] = [];
  private drillPath: Array<Project | Task> = [];
  private showActiveOnly = true;
  private readonly plugin: PluginWithPanelConfig;
  private breadcrumbEl!: HTMLElement;
  private cyContainer!: HTMLElement;
  private refreshTimer: ReturnType<typeof window.setTimeout> | null = null;
  private sepSvg: SVGSVGElement | null = null;
  private settingsPanelEl: HTMLElement | null = null;
  private settingsPanelOpen = false;
  private dragOverlaySvg: SVGSVGElement | null = null;
  private dragPointerMoveHandler: ((e: PointerEvent) => void) | null = null;
  private dragPointerUpHandler: (() => void) | null = null;

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
    this.buildGear(breadcrumbBar);
    const scrollWrapper = this.contentEl.createDiv({ cls: "pm-compass-scroll-wrapper" });
    this.cyContainer = scrollWrapper.createDiv({
      cls: "pm-compass-graph-container",
    });

    // Pointerdown on interactive node elements: prevent cytoscape from selecting the node
    this.registerDomEvent(this.cyContainer, "pointerdown", (e: PointerEvent) => {
      const el = e.target as HTMLElement;

      // Drag-to-connect: connect button starts a drag gesture
      const connectBtn = el.closest<HTMLElement>(".pm-node-connect-btn");
      if (connectBtn) {
        const taskId = connectBtn.dataset.taskId;
        if (!taskId) return;
        e.preventDefault();
        this.startDragConnect(taskId, e);
        return;
      }

      // Priority ribbon: open priority picker without selecting the node
      const ribbon = el.closest<HTMLElement>(".pm-node-ribbon");
      if (ribbon) {
        const taskId = ribbon.dataset.taskId;
        if (!taskId) return;
        const task = this.tasks.find((t) => t.id === taskId);
        if (!task) return;
        e.preventDefault();
        this.openPriorityDropdown(ribbon, task);
        return;
      }

      // Status badge: open status picker without selecting the node
      const statusBadge = el.closest<HTMLElement>(".pm-node-status");
      if (statusBadge) {
        const taskId = statusBadge.dataset.taskId;
        if (!taskId) return;
        const task = this.tasks.find((t) => t.id === taskId);
        if (!task) return;
        e.preventDefault();
        this.openStatusDropdown(statusBadge, task);
        return;
      }
    });

    this.registerDomEvent(this.cyContainer, "contextmenu", (e: MouseEvent) => {
      if (this.drillPath.length === 0) {
        // All-view: identify the project by which section was right-clicked
        const section = (e.target as HTMLElement).closest<HTMLElement>(".pm-project-section");
        const proj = this.projects.find((p) => p.id === section?.dataset.projId);
        if (!proj) return;
        e.preventDefault();
        this.openAddTaskMenu(e, proj, undefined);
      } else {
        e.preventDefault();
        const proj = this.drillPath[0] as Project;
        const last = this.drillPath[this.drillPath.length - 1];
        const parentTask = isTask(last) ? last : undefined;
        this.openAddTaskMenu(e, proj, parentTask);
      }
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
    this.cancelDragConnect();
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

  private openAddTaskMenu(e: MouseEvent, proj: Project, parentTask: Task | undefined): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(parentTask ? "Add subtask" : "Add task")
        .setIcon("plus")
        .onClick(() => {
          new TaskModal(this.app, {
            mode: "create",
            projectId: proj.id,
            projectFilePath: proj.filePath,
            projectTitle: proj.title,
            parentTask: parentTask,
            existingTasks: this.tasks.filter((t) => t.projectId === proj.id),
            onSuccess: () => { void this.refresh(); },
          }).open();
        }),
    );
    menu.showAtMouseEvent(e);
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

    // Trim drill path at the first task that no longer exists
    if (this.drillPath.length > 1) {
      const taskIds = new Set(this.tasks.map((t) => t.id));
      const firstStaleIdx = this.drillPath.findIndex((entry, i) => i > 0 && isTask(entry) && !taskIds.has(entry.id));
      if (firstStaleIdx !== -1) this.drillPath = this.drillPath.slice(0, firstStaleIdx);
    }

    this.renderGraph();
  }

  /** Starts a drag-to-connect gesture from sourceId, drawing a live line to the cursor. */
  private startDragConnect(sourceId: string, startEvent: PointerEvent): void {
    const sourceCard = this.cyContainer.querySelector<HTMLElement>(`.pm-node-card[data-task-id="${sourceId}"]`);
    sourceCard?.classList.add("pm-connect-source");

    const sr = sourceCard?.getBoundingClientRect();
    const sx = sr ? sr.left + sr.width / 2 : startEvent.clientX;
    const sy = sr ? sr.top + sr.height / 2 : startEvent.clientY;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    svg.classList.add("pm-drag-line-overlay");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line") as SVGLineElement;
    line.classList.add("pm-drag-line");
    line.setAttribute("x1", String(sx));
    line.setAttribute("y1", String(sy));
    line.setAttribute("x2", String(startEvent.clientX));
    line.setAttribute("y2", String(startEvent.clientY));
    svg.appendChild(line);
    document.body.appendChild(svg);
    this.dragOverlaySvg = svg;

    // Release implicit pointer capture so pointermove/pointerup fire on document freely
    (startEvent.target as HTMLElement).releasePointerCapture(startEvent.pointerId);

    let currentTargetCard: HTMLElement | null = null;
    let currentTargetId: string | null = null;

    this.dragPointerMoveHandler = (e: PointerEvent) => {
      line.setAttribute("x2", String(e.clientX));
      line.setAttribute("y2", String(e.clientY));

      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const card = el?.closest<HTMLElement>(".pm-node-card") ?? null;
      const cardId = card?.dataset.taskId ?? null;
      if (card !== currentTargetCard) {
        currentTargetCard?.classList.remove("pm-connect-target");
        currentTargetCard = card && cardId !== sourceId ? card : null;
        currentTargetId = currentTargetCard ? cardId : null;
        currentTargetCard?.classList.add("pm-connect-target");
      }
    };

    // Use the target tracked in pointermove instead of re-querying elementFromPoint at release,
    // which can be unreliable when the SVG overlay or pointer capture interferes.
    this.dragPointerUpHandler = () => {
      const savedTargetId = currentTargetId;
      this.cancelDragConnect();
      if (savedTargetId) void this.addDependency(sourceId, savedTargetId);
    };

    document.addEventListener("pointermove", this.dragPointerMoveHandler);
    document.addEventListener("pointerup", this.dragPointerUpHandler);
    document.addEventListener("pointercancel", this.dragPointerUpHandler);
  }

  /** Cleans up the drag-to-connect state, SVG overlay, and highlights. */
  private cancelDragConnect(): void {
    this.cyContainer?.querySelector(".pm-connect-source")?.classList.remove("pm-connect-source");
    this.cyContainer?.querySelector(".pm-connect-target")?.classList.remove("pm-connect-target");
    if (this.dragOverlaySvg) { this.dragOverlaySvg.remove(); this.dragOverlaySvg = null; }
    if (this.dragPointerMoveHandler) { document.removeEventListener("pointermove", this.dragPointerMoveHandler); this.dragPointerMoveHandler = null; }
    if (this.dragPointerUpHandler) {
      document.removeEventListener("pointerup", this.dragPointerUpHandler);
      document.removeEventListener("pointercancel", this.dragPointerUpHandler);
      this.dragPointerUpHandler = null;
    }
  }

  /** Validates via isValidDependencyTarget (Notice on failure), calls addTaskDependency, then refresh. */
  private async addDependency(sourceId: string, targetId: string): Promise<void> {
    const target = this.tasks.find(t => t.id === targetId);
    if (!target) return;
    const check = isValidDependencyTarget(this.tasks, sourceId, targetId);
    if (!check.valid) {
      new Notice(check.reason ?? "Cannot add dependency");
      return;
    }
    await addTaskDependency(this.app, target, sourceId);
    await this.refresh();
  }

  private showRemoveDependencyMenu(evt: cytoscape.EventObject): void {
    if ((evt.target.data("edgeType") as string) === "virtual") return;
    const sourceId = evt.target.data("source") as string;
    const targetId = evt.target.data("target") as string;
    if (!sourceId || !targetId) return;
    const menu = new Menu();
    menu.addItem(item =>
      item.setTitle("Remove dependency").setIcon("unlink")
        .onClick(() => { void this.removeDependency(sourceId, targetId); })
    );
    menu.showAtMouseEvent(evt.originalEvent as MouseEvent);
  }

  /** Calls removeTaskDependency then refresh. */
  private async removeDependency(sourceId: string, targetId: string): Promise<void> {
    const target = this.tasks.find(t => t.id === targetId);
    if (!target) return;
    await removeTaskDependency(this.app, target, sourceId);
    await this.refresh();
  }

  private renderGraph(): void {
    if (!this.cyContainer) return;

    this.cancelDragConnect();
    this.updateBreadcrumb();

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

    // Single-project view: same display as the all-projects view
    if (this.drillPath.length === 1) {
      const proj = this.drillPath[0] as Project;
      let tasks = this.tasks.filter((t) => t.projectId === proj.id && !t.parentId);
      if (this.showActiveOnly) tasks = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
      this.createProjectSectionCy(this.cyContainer, proj, tasks);
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
          style: { shape: "round-rectangle", width: 160, height: 72, "background-color": "transparent", "border-width": 0, label: "" },
        },
        {
          selector: "node[nodeType='project']",
          style: { shape: "round-rectangle", width: 160, height: 72, "background-color": "transparent", "background-opacity": 0, "border-width": 0, label: "" },
        },
        {
          selector: "node[nodeType='context-task']",
          style: { shape: "round-rectangle", width: 160, height: 72, "background-color": "transparent", "border-width": 0, label: "" },
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

    (this.cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[], options?: NodeHtmlLabelOptions) => void }).nodeHtmlLabel([
      { query: "node[nodeType='task']", cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
      { query: "node[nodeType='project']", cssClass: "pm-hl", tpl: (data: NodeData) => this.projectNodeTemplate(data) },
      { query: "node[nodeType='context-task']", cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
    ], { enablePointerEvents: true });

    // Task / context-task node tap: edit button opens modal (ribbon/status handled via DOM pointerdown)
    this.cy.on("tap", "node[nodeType='task'], node[nodeType='context-task']", (evt) => {
      const editBtn = getEventTarget(evt)?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!editBtn) return;
      const taskId = editBtn.dataset.taskId;
      if (!taskId) return;
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      new TaskModal(this.app, {
        mode: "edit", task,
        existingTasks: this.tasks.filter((t) => t.projectId === task.projectId),
        onSuccess: () => { void this.refresh(); },
      }).open();
    });

    // Edit button on the project context node
    this.cy.on("tap", "node[nodeType='project']", (evt) => {
      const btn = getEventTarget(evt)?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!btn) return;
      const projId = btn.dataset.projId;
      if (!projId) return;
      const proj = this.projects.find((p) => p.id === projId);
      if (!proj) return;
      new ProjectModal(this.app, { project: proj, onSuccess: () => { void this.refresh(); } }).open();
    });

    // Right-click on a dependency edge to remove it
    this.cy.on("cxttap", "edge", (evt) => this.showRemoveDependencyMenu(evt));

    // Double-tap drills into subtasks (skip when tapping a button)
    // this.cy only exists when drillPath.length >= 2, so drillPath is always non-empty here
    this.cy.on("dbltap", "node[nodeType='task']", (evt) => {
      const oe = evt.originalEvent as MouseEvent | undefined;
      if ((oe?.target as HTMLElement | undefined)?.closest(".pm-node-edit-btn")) return;

      const taskId = evt.target.data("id") as string;
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;

      this.drillPath.push(task);
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

    this.cy.layout(layoutOptions).run();
  }

  private renderAllProjectsTable(): void {
    const childMap = buildChildMap(this.tasks);
    let anyProject = false;

    for (const proj of this.projects) {
      let tasks = this.tasks.filter((t) => t.projectId === proj.id && !t.parentId);
      if (this.showActiveOnly) tasks = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));

      anyProject = true;
      const section = this.cyContainer.createDiv({ cls: "pm-project-section" });
      section.dataset.projId = proj.id;
      this.createProjectSectionCy(section, proj, tasks, childMap);
    }

    if (!anyProject) {
      this.cyContainer.createEl("p", { text: "No projects found.", cls: "pm-compass-empty" });
    }
  }

  private createProjectSectionCy(container: HTMLElement, proj: Project, tasks: Task[], childMap?: Map<string | undefined, Task[]>): void {
    const today = new Date().toISOString().slice(0, 10);
    const doneStatuses = new Set(["done", "cancelled"]);
    const sectionChildMap = childMap ?? buildChildMap(this.tasks);
    const taskIdSet = new Set(tasks.map((t) => t.id));
    const projNodeId = `proj-${proj.id}`;

    const elements: ElementDefinition[] = [
      {
        data: {
          id: projNodeId,
          label: proj.title,
          nodeType: "project",
          isContext: true,
          color: proj.color ?? "#888888",
          projId: proj.id,
        },
      },
    ];

    for (const t of tasks) {
      elements.push({
        data: {
          id: t.id,
          label: t.title,
          status: t.status,
          statusColor: getStatusColor(t.status),
          priorityColor: getPriorityColor(t.priority ?? ""),
          due: t.due ?? "",
          isOverdue: !!t.due && t.due < today && !doneStatuses.has(t.status),
          filePath: t.filePath,
          nodeType: "task",
          childCount: sectionChildMap.get(t.id)?.length ?? 0,
          color: "",
        },
      });
      elements.push({ data: { id: `${projNodeId}->${t.id}`, source: projNodeId, target: t.id, edgeType: "virtual" } });
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
          style: { shape: "round-rectangle", width: 160, height: 72, "background-color": "transparent", "border-width": 0, label: "" },
        },
        {
          selector: "node[nodeType='project']",
          style: { shape: "round-rectangle", width: 160, height: 72, "background-color": "transparent", "border-width": 0, label: "" },
        },
        {
          selector: "edge",
          style: { "curve-style": "bezier", "target-arrow-shape": "triangle", "line-color": "#888", "target-arrow-color": "#888", width: 1.5 },
        },
        { selector: "edge[edgeType='virtual']", style: { opacity: 0 } },
      ],
    });

    (cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[], options?: NodeHtmlLabelOptions) => void }).nodeHtmlLabel([
      { query: "node[nodeType='task']", cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
      { query: "node[nodeType='project']", cssClass: "pm-hl", tpl: (data: NodeData) => this.projectNodeTemplate(data) },
    ], { enablePointerEvents: true });

    // Project node: edit button opens modal, card body drills into project
    cy.on("tap", "node[nodeType='project']", (evt) => {
      const btn = getEventTarget(evt)?.closest<HTMLElement>(".pm-node-edit-btn");
      if (btn) {
        const projId = btn.dataset.projId;
        if (!projId) return;
        const editProj = this.projects.find((p) => p.id === projId);
        if (!editProj) return;
        new ProjectModal(this.app, { project: editProj, onSuccess: () => { void this.refresh(); } }).open();
      } else {
        this.drillPath = [proj];
        this.renderGraph();
      }
    });

    // Task node tap: edit button opens modal (ribbon/status handled via DOM pointerdown)
    cy.on("tap", "node[nodeType='task']", (evt) => {
      const editBtn = getEventTarget(evt)?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!editBtn) return;
      const taskId = editBtn.dataset.taskId;
      if (!taskId) return;
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      new TaskModal(this.app, {
        mode: "edit", task,
        existingTasks: this.tasks.filter((t) => t.projectId === task.projectId),
        onSuccess: () => { void this.refresh(); },
      }).open();
    });

    // Right-click on a dependency edge to remove it
    cy.on("cxttap", "edge", (evt) => this.showRemoveDependencyMenu(evt));

    // Double-tap drills into task subtasks (skip when tapping a button)
    cy.on("dbltap", "node[nodeType='task']", (evt) => {
      const oe = evt.originalEvent as MouseEvent | undefined;
      if ((oe?.target as HTMLElement | undefined)?.closest(".pm-node-edit-btn")) return;
      const task = this.tasks.find((t) => t.id === (evt.target.data("id") as string));
      if (!task) return;
      this.drillPath = [proj, task];
      this.renderGraph();
    });

    cy.one("layoutstop", () => {
      const bb = cy.elements().boundingBox({});
      const pad = 20;
      // Don't constrain width — let the section fill the scroll container so
      // horizontal separators extend to the full display width.
      const h = Math.ceil(bb.h) + pad * 2;
      container.style.height = `${h}px`;
      cy.resize();
      cy.viewport({ zoom: 1, pan: { x: pad - bb.x1, y: pad - bb.y1 } });
      cy.userPanningEnabled(false);
      cy.userZoomingEnabled(false);
      this.renderSectionSeparator(cy, container);
    });

    cy.layout({ name: "dagre", rankDir: "LR", nodeSep: 20, rankSep: 60, padding: 20 } as unknown as cytoscape.LayoutOptions).run();
    this.cys.push(cy);
  }

  private openPriorityDropdown(anchor: HTMLElement, task: Task): void {
    const priorities: Array<"" | "critical" | "high" | "medium" | "low"> = ["", "critical", "high", "medium", "low"];
    openDropdown(
      anchor,
      priorities.map((p) => ({
        label: PRIORITY_LABELS[p],
        color: p ? PRIORITY_COLORS[p] : undefined,
        onSelect: () => { void patchTaskField(this.app, task.filePath, "priority", p).then(() => this.refresh()); },
      })),
    );
  }

  private openStatusDropdown(anchor: HTMLElement, task: Task): void {
    const statuses = ["todo", "in-progress", "blocked", "review", "done", "cancelled"] as const;
    openDropdown(
      anchor,
      statuses.map((s) => ({
        label: STATUS_LABELS[s],
        color: STATUS_COLORS[s],
        onSelect: () => { void patchTaskField(this.app, task.filePath, "status", s).then(() => this.refresh()); },
      })),
    );
  }

  private taskNodeTemplate(data: NodeData): string {
    const editId = escapeHtml(data.taskId ?? data.id);
    return `<div class="pm-node-card" data-task-id="${editId}">
      <div class="pm-node-ribbon" data-task-id="${editId}" style="background:${data.priorityColor || "transparent"}"></div>
      <div class="pm-node-body">
        <div class="pm-node-title">${escapeHtml(data.label)}</div>
        <div class="pm-node-meta">
          <span class="pm-node-status" data-task-id="${editId}" style="background:${data.statusColor}22;color:${data.statusColor};border:1px solid ${data.statusColor}55">${escapeHtml(data.status)}</span>
          ${data.due ? `<span class="pm-node-due" style="${data.isOverdue ? "color:#ef4444;font-weight:600" : ""}">${escapeHtml(data.due)}</span>` : ""}
        </div>
        ${data.childCount > 0 ? `<div class="pm-node-subtask-row">↳ ${data.childCount} subtask${data.childCount > 1 ? "s" : ""}</div>` : ""}
      </div>
      <div class="pm-node-actions">
        <button class="pm-node-edit-btn" data-task-id="${editId}" title="Edit task">${PENCIL_SVG}</button>
        <button class="pm-node-connect-btn" data-task-id="${editId}" title="Add dependency">${LINK_SVG}</button>
      </div>
    </div>`;
  }

  private projectNodeTemplate(data: NodeData): string {
    return `<div class="pm-node-project-card" data-proj-id="${escapeHtml(data.projId ?? "")}" style="border:1.5px solid ${data.color};background:${withAlpha(data.color, "26")};color:${data.color}">
      <div class="pm-node-project-title">${escapeHtml(data.label)}</div>
      <button class="pm-node-edit-btn pm-node-project-edit-btn" data-proj-id="${escapeHtml(data.projId ?? "")}" title="Edit project">${PENCIL_SVG}</button>
    </div>`;
  }

  private renderSectionSeparator(cy: Core, container: HTMLElement): void {
    const svgNS = "http://www.w3.org/2000/svg";
    let svg = container.querySelector<SVGSVGElement>(".pm-sep-svg");
    if (!svg) {
      svg = document.createElementNS(svgNS, "svg") as SVGSVGElement;
      svg.classList.add("pm-sep-svg");
      container.appendChild(svg);
    }
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const contextNodes = cy.nodes("[?isContext]").toArray();
    const taskNodes = cy.nodes("[nodeType='task']");
    if (contextNodes.length === 0 || taskNodes.length === 0) return;

    const contextMaxX = Math.max(
      ...contextNodes.map((n) => n.renderedPosition().x + n.renderedWidth() / 2),
    );
    const taskMinX = Math.min(
      ...taskNodes.toArray().map((n) => n.renderedPosition().x - n.renderedWidth() / 2),
    );

    if (contextMaxX < taskMinX) {
      const x = (contextMaxX + taskMinX) / 2;
      const h = container.clientHeight;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", String(x));
      line.setAttribute("y1", "0");
      line.setAttribute("x2", String(x));
      line.setAttribute("y2", String(h));
      line.classList.add("pm-sep-line");
      svg.appendChild(line);
    }
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
    const today = new Date().toISOString().slice(0, 10);
    const doneStatuses = new Set(["done", "cancelled"]);
    const childMap = buildChildMap(this.tasks);

    // ── Task drill view ─────────────────────────────────────────────────────
    // drillPath always starts with a Project followed by one or more Tasks
    const lastEntry = this.drillPath[this.drillPath.length - 1];
    if (!isTask(lastEntry)) return []; // guard

    const targetTasksRaw = this.tasks.filter((t) => t.parentId === lastEntry.id);
    const contextId = `${lastEntry.id}-ctx`;
    const contextElement: ElementDefinition = {
      data: {
        id: contextId,
        label: lastEntry.title,
        nodeType: "context-task",
        isContext: true,
        status: lastEntry.status,
        statusColor: getStatusColor(lastEntry.status),
        priorityColor: getPriorityColor(lastEntry.priority ?? ""),
        due: lastEntry.due ?? "",
        isOverdue: !!lastEntry.due && lastEntry.due < today && !doneStatuses.has(lastEntry.status),
        filePath: lastEntry.filePath,
        childCount: 0,
        color: "",
        taskId: lastEntry.id,
      },
    };

    let targetTasks = targetTasksRaw;

    if (this.showActiveOnly) {
      targetTasks = targetTasks.filter((t) => ACTIVE_STATUSES.has(t.status));
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
