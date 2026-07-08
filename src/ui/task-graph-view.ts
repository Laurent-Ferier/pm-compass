import { ItemView, Menu, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import cytoscapeDagre from "cytoscape-dagre";
import nodeHtmlLabel from "cytoscape-node-html-label";
import { isTask, buildChildMap, isValidDependencyTarget, type Task, type Project } from "../model/shared";
import { loadVaultData } from "../model/vault-reader";
import { TaskModal, ProjectModal, ConfirmModal, addTaskDependency, removeTaskDependency, deleteTaskFile, patchTaskField, openDropdown, openNoteFile } from "./task-creator";
import {
  STATUS_COLORS, PRIORITY_COLORS, STATUS_LABELS, PRIORITY_LABELS, STATUSES,
  getStatusColor, getPriorityColor, escapeHtml, stripWikiLinks, withAlpha, DONE_STATUSES,
} from "../model/task-vocabulary";
import { PENCIL_SVG, LINK_SVG } from "./icons";
import { DASHBOARD_VIEW_TYPE } from "./dashboard-view";

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
    nodePositions: Record<string, { x: number; y: number }>;
  };
  saveSettings(): Promise<void>;
}


const ACTIVE_STATUSES = new Set(["todo", "in-progress", "blocked", "review"]);

/** Cytoscape node/edge styles shared by the main graph and each per-project section
 *  graph; `includeContextTask` adds the extra node type used only by the main graph's
 *  drilled-in view (the ancestor task shown for context above the current subtasks). */
function buildCyStyles(includeContextTask: boolean): cytoscape.StylesheetJson {
  const taskLikeNodeStyle = {
    shape: "round-rectangle" as const, width: 160, height: 72,
    "background-color": "transparent", "border-width": 0, label: "",
  };
  const styles: cytoscape.StylesheetJson = [
    { selector: "node[nodeType='task']", style: taskLikeNodeStyle },
    {
      selector: "node[nodeType='project']",
      // Only the main (drilled-in) graph's context project node needs to be fully
      // invisible; per-project section headers use the same transparent-but-solid style.
      style: includeContextTask ? { ...taskLikeNodeStyle, "background-opacity": 0 } : taskLikeNodeStyle,
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
    { selector: "edge[edgeType='virtual']", style: { opacity: 0 } },
  ];
  if (includeContextTask) {
    styles.splice(2, 0, { selector: "node[nodeType='context-task']", style: taskLikeNodeStyle });
  }
  return styles;
}

function getEventTarget(evt: { originalEvent?: Event }): Element | null {
  const oe = evt.originalEvent;
  if (!oe) return null;
  if (typeof TouchEvent !== "undefined" && oe instanceof TouchEvent) {
    const touch = oe.changedTouches[0];
    return touch ? activeDocument.elementFromPoint(touch.clientX, touch.clientY) : null;
  }
  return (oe as MouseEvent).target as Element | null;
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
  private pendingSelectTaskId: string | null = null;


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
      // Right-click on a task card → task-specific menu
      const taskCard = (e.target as HTMLElement).closest<HTMLElement>(".pm-node-card");
      if (taskCard) {
        const taskId = taskCard.dataset.taskId;
        const task = this.tasks.find((t) => t.id === taskId);
        if (task) {
          e.preventDefault();
          this.openTaskContextMenu(e, task);
          return;
        }
      }

      // Right-click on empty space → add task/subtask menu
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
        .setTitle("Add task")
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

  private openTaskContextMenu(e: MouseEvent, task: Task): void {
    const proj = this.projects.find((p) => p.id === task.projectId);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Add subtask").setIcon("plus").onClick(() => {
        if (!proj) return;
        new TaskModal(this.app, {
          mode: "create",
          projectId: proj.id,
          projectFilePath: proj.filePath,
          projectTitle: proj.title,
          parentTask: task,
          existingTasks: this.tasks.filter((t) => t.projectId === proj.id),
          onSuccess: () => { void this.refresh(); },
        }).open();
      })
    );
    menu.addItem((item) =>
      item.setTitle("Delete task").setIcon("trash").onClick(() => {
        const descendantCount = this.countDescendants(task.id);
        const msg = descendantCount > 0
          ? `Delete "${task.title}" and its ${descendantCount} subtask${descendantCount > 1 ? "s" : ""}?`
          : `Delete "${task.title}"?`;
        new ConfirmModal(this.app, msg, () => {
          const parentTask = task.parentId ? this.tasks.find((t) => t.id === task.parentId) : undefined;
          void deleteTaskFile(this.app, task, parentTask, this.tasks).then(() => this.refresh());
        }).open();
      })
    );
    menu.showAtMouseEvent(e);
  }

  private countDescendants(taskId: string): number {
    let count = 0;
    for (const child of this.tasks.filter((t) => t.parentId === taskId)) {
      count += 1 + this.countDescendants(child.id);
    }
    return count;
  }

  private buildGear(bar: HTMLElement): void {
    const gearBtn = bar.createEl("button", { cls: "pm-compass-gear-btn" });
    setIcon(gearBtn, "settings");
    gearBtn.setAttribute("aria-label", "Graph settings");

    this.settingsPanelEl = bar.createDiv({ cls: "pm-compass-settings-panel" });
    this.settingsPanelEl.setCssStyles({ display: "none" });

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

    const resetBtn = this.settingsPanelEl.createEl("button", {
      cls: "pm-compass-reset-layout-btn",
      text: "Reset layout",
    });
    resetBtn.addEventListener("click", () => {
      this.plugin.settings.nodePositions = {};
      void this.plugin.saveSettings();
      this.renderGraph();
    });

    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.settingsPanelOpen = !this.settingsPanelOpen;
      this.settingsPanelEl!.style.display = this.settingsPanelOpen ? "block" : "none";
      gearBtn.classList.toggle("is-active", this.settingsPanelOpen);
    });

    this.registerDomEvent(activeDocument, "click", () => {
      if (this.settingsPanelOpen) {
        this.settingsPanelOpen = false;
        this.settingsPanelEl!.setCssStyles({ display: "none" });
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

    // Reset drill if the pinned project no longer exists. Confirm against the vault itself,
    // not just the freshly parsed project list — a metadataCache read can transiently miss a
    // file's frontmatter right after that same file was just written (e.g. adding a subtask
    // to the drilled-in task), which would otherwise bounce the view up a level for no reason.
    if (this.drillPath.length > 0 && !isTask(this.drillPath[0])) {
      const proj = this.drillPath[0] as Project;
      if (!this.projects.find((p) => p.id === proj.id) && !this.app.vault.getAbstractFileByPath(proj.filePath)) {
        this.drillPath = [];
      }
    }

    // Trim drill path at the first task that no longer exists (same file-existence guard as above).
    if (this.drillPath.length > 1) {
      const taskIds = new Set(this.tasks.map((t) => t.id));
      const firstStaleIdx = this.drillPath.findIndex((entry, i) =>
        i > 0 && isTask(entry) && !taskIds.has(entry.id) && !this.app.vault.getAbstractFileByPath(entry.filePath),
      );
      if (firstStaleIdx !== -1) this.drillPath = this.drillPath.slice(0, firstStaleIdx);
    }

    this.pruneStalePositions();
    this.renderGraph();
  }

  /** Starts a drag-to-connect gesture from sourceId, drawing a live line to the cursor. */
  private startDragConnect(sourceId: string, startEvent: PointerEvent): void {
    const sourceCard = this.cyContainer.querySelector<HTMLElement>(`.pm-node-card[data-task-id="${sourceId}"]`);
    sourceCard?.classList.add("pm-connect-source");

    const sr = sourceCard?.getBoundingClientRect();
    const sx = sr ? sr.left + sr.width / 2 : startEvent.clientX;
    const sy = sr ? sr.top + sr.height / 2 : startEvent.clientY;

    const svg = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("pm-drag-line-overlay");
    const line = activeDocument.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("pm-drag-line");
    line.setAttribute("x1", String(sx));
    line.setAttribute("y1", String(sy));
    line.setAttribute("x2", String(startEvent.clientX));
    line.setAttribute("y2", String(startEvent.clientY));
    svg.appendChild(line);
    activeDocument.body.appendChild(svg);
    this.dragOverlaySvg = svg;

    // Release implicit pointer capture so pointermove/pointerup fire on document freely
    (startEvent.target as HTMLElement).releasePointerCapture(startEvent.pointerId);

    let currentTargetCard: HTMLElement | null = null;
    let currentTargetId: string | null = null;

    this.dragPointerMoveHandler = (e: PointerEvent) => {
      line.setAttribute("x2", String(e.clientX));
      line.setAttribute("y2", String(e.clientY));

      const el = activeDocument.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
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

    activeDocument.addEventListener("pointermove", this.dragPointerMoveHandler);
    activeDocument.addEventListener("pointerup", this.dragPointerUpHandler);
    activeDocument.addEventListener("pointercancel", this.dragPointerUpHandler);
  }

  /** Cleans up the drag-to-connect state, SVG overlay, and highlights. */
  private cancelDragConnect(): void {
    this.cyContainer?.querySelector(".pm-connect-source")?.classList.remove("pm-connect-source");
    this.cyContainer?.querySelector(".pm-connect-target")?.classList.remove("pm-connect-target");
    if (this.dragOverlaySvg) { this.dragOverlaySvg.remove(); this.dragOverlaySvg = null; }
    if (this.dragPointerMoveHandler) { activeDocument.removeEventListener("pointermove", this.dragPointerMoveHandler); this.dragPointerMoveHandler = null; }
    if (this.dragPointerUpHandler) {
      activeDocument.removeEventListener("pointerup", this.dragPointerUpHandler);
      activeDocument.removeEventListener("pointercancel", this.dragPointerUpHandler);
      this.dragPointerUpHandler = null;
    }
  }

  /** Validates via isValidDependencyTarget (Notice on failure), calls addTaskDependency, then refresh. */
  private async addDependency(sourceId: string, targetId: string): Promise<void> {
    const target = this.tasks.find(t => t.id === targetId);
    if (!target) return;
    const check = isValidDependencyTarget(this.tasks, sourceId, targetId);
    if (!check.valid) {
      // isValidDependencyTarget always sets `reason` alongside `valid: false`.
      new Notice(check.reason!);
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

  private applyStoredPositions(cy: Core): void {
    const positions = this.plugin.settings.nodePositions;
    cy.nodes().forEach(node => {
      const pos = positions[node.id()];
      if (pos) node.position(pos);
    });
  }

  private signalDashboard(taskId: string): void {
    const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (leaves.length === 0) return;
    const view = leaves[0].view as { selectTask?: (id: string) => boolean };
    view.selectTask?.(taskId);
  }

  selectGraphNode(taskId: string): void {

    this.cyContainer.querySelectorAll<HTMLElement>(".pm-node-card--selected").forEach((el) => {
      el.classList.remove("pm-node-card--selected");
    });
    const card = this.cyContainer.querySelector<HTMLElement>(`.pm-node-card[data-task-id="${CSS.escape(taskId)}"]`);
    if (card) card.classList.add("pm-node-card--selected");
  }

  private saveNodePosition(node: cytoscape.NodeSingular): void {
    const pos = node.position();
    this.plugin.settings.nodePositions[node.id()] = { x: pos.x, y: pos.y };
    void this.plugin.saveSettings();
  }

  /** Navigate to a specific task, showing it as a card in its parent context (parent task or project). */
  async openTask(projectId: string, taskId: string): Promise<void> {
    const data = await loadVaultData(this.app, this.plugin.settings.projectsFolder);
    this.projects = data.projects;
    this.tasks = data.tasks;

    const project = this.projects.find((p) => p.id === projectId);
    const task = this.tasks.find((t) => t.id === taskId);

    if (project && task) {
      if (task.parentId) {
        const parent = this.tasks.find((t) => t.id === task.parentId);
        this.drillPath = parent ? this.buildTaskDrillPath(project, parent) : [project];
      } else {
        this.drillPath = [project];
      }
    }

    this.pruneStalePositions();
    this.pendingSelectTaskId = taskId;
    this.renderGraph();
  }

  /** Builds [project, ancestor…, task] by walking parentId up the tree. */
  private buildTaskDrillPath(project: Project, task: Task): Array<Project | Task> {
    const chain: Task[] = [];
    const visited = new Set<string>();
    let current: Task | undefined = task;
    while (current) {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      chain.unshift(current);
      current = current.parentId
        ? this.tasks.find((t) => t.id === current!.parentId)
        : undefined;
    }
    return [project, ...chain];
  }

  private pruneStalePositions(): void {
    const validIds = new Set<string>();
    for (const t of this.tasks) validIds.add(t.id);
    for (const p of this.projects) validIds.add(`proj-${p.id}`);
    for (const entry of this.drillPath) {
      if (isTask(entry)) validIds.add(`${entry.id}-ctx`);
    }
    const positions = this.plugin.settings.nodePositions;
    let changed = false;
    for (const id of Object.keys(positions)) {
      if (!validIds.has(id)) {
        delete positions[id];
        changed = true;
      }
    }
    if (changed) void this.plugin.saveSettings();
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
    this.cyContainer.setCssStyles({ width: "", height: "" });

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

    // Context node is always included, so length <= 1 means no subtasks
    if (elements.length <= 1) {
      this.cyContainer.createEl("p", {
        text: "No tasks found.",
        cls: "pm-compass-empty",
      });
      return;
    }

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
      style: buildCyStyles(true),
    });

    this.cy.elements().unselectify();

    (this.cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[], options?: NodeHtmlLabelOptions) => void }).nodeHtmlLabel([
      { query: "node[nodeType='task']", cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
      { query: "node[nodeType='project']", cssClass: "pm-hl", tpl: (data: NodeData) => this.projectNodeTemplate(data) },
      { query: "node[nodeType='context-task']", cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
    ], { enablePointerEvents: true });

    // Task / context-task node tap: edit button opens modal (ctrl-click opens note); ribbon/status handled via DOM pointerdown
    this.cy.on("tap", "node[nodeType='task'], node[nodeType='context-task']", (evt) => {
      const tapTarget = getEventTarget(evt);
      if (tapTarget?.closest<HTMLElement>(".pm-node-connect-btn")) return;
      const editBtn = tapTarget?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!editBtn) {
        const taskId = (evt.target.data("taskId") ?? evt.target.data("id")) as string | undefined;
        if (taskId) { this.selectGraphNode(taskId); this.signalDashboard(taskId); }
        return;
      }
      const taskId = editBtn.dataset.taskId;
      if (!taskId) return;
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      if ((evt.originalEvent as MouseEvent | undefined)?.ctrlKey) {
        openNoteFile(this.app, task.filePath);
        return;
      }
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
      if ((evt.originalEvent as MouseEvent | undefined)?.ctrlKey) {
        openNoteFile(this.app, proj.filePath);
        return;
      }
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

    const fitMainCy = () => {
      const bb = this.cy!.elements().boundingBox({});
      const pad = 30;
      const w = Math.ceil(bb.w) + pad * 2;
      const h = Math.ceil(bb.h) + pad * 2;
      this.cyContainer.style.width = `${w}px`;
      this.cyContainer.style.height = `${h}px`;
      this.cy!.resize();
      this.cy!.viewport({ zoom: 1, pan: { x: pad - bb.x1, y: pad - bb.y1 } });
    };

    this.cy.one("layoutstop", () => {
      this.applyStoredPositions(this.cy!);
      fitMainCy();
      this.cy!.userPanningEnabled(false);
      this.cy!.userZoomingEnabled(false);
      this.renderSeparators();
      if (this.pendingSelectTaskId) {
        const id = this.pendingSelectTaskId;
        this.pendingSelectTaskId = null;
        window.setTimeout(() => this.selectGraphNode(id), 0);
      }
    });

    this.cy.on("dragfree", "node", (evt) => {
      this.saveNodePosition(evt.target as cytoscape.NodeSingular);
      fitMainCy();
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
          isOverdue: !!t.due && t.due < today && !DONE_STATUSES.has(t.status),
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
      style: buildCyStyles(false),
    });

    cy.elements().unselectify();

    (cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[], options?: NodeHtmlLabelOptions) => void }).nodeHtmlLabel([
      { query: "node[nodeType='task']", cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
      { query: "node[nodeType='project']", cssClass: "pm-hl", tpl: (data: NodeData) => this.projectNodeTemplate(data) },
    ], { enablePointerEvents: true });

    // Project node: edit button opens modal (ctrl-click opens note), card body drills into project
    cy.on("tap", "node[nodeType='project']", (evt) => {
      const btn = getEventTarget(evt)?.closest<HTMLElement>(".pm-node-edit-btn");
      if (btn) {
        const projId = btn.dataset.projId;
        if (!projId) return;
        const editProj = this.projects.find((p) => p.id === projId);
        if (!editProj) return;
        if ((evt.originalEvent as MouseEvent | undefined)?.ctrlKey) {
          openNoteFile(this.app, editProj.filePath);
          return;
        }
        new ProjectModal(this.app, { project: editProj, onSuccess: () => { void this.refresh(); } }).open();
      } else {
        this.drillPath = [proj];
        this.renderGraph();
      }
    });

    // Task node tap: edit button opens modal (ctrl-click opens note); ribbon/status handled via DOM pointerdown
    cy.on("tap", "node[nodeType='task']", (evt) => {
      const tapTarget = getEventTarget(evt);
      if (tapTarget?.closest<HTMLElement>(".pm-node-connect-btn")) return;
      const editBtn = tapTarget?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!editBtn) {
        const taskId = evt.target.data("id") as string | undefined;
        if (taskId) { this.selectGraphNode(taskId); this.signalDashboard(taskId); }
        return;
      }
      const taskId = editBtn.dataset.taskId;
      if (!taskId) return;
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      if ((evt.originalEvent as MouseEvent | undefined)?.ctrlKey) {
        openNoteFile(this.app, task.filePath);
        return;
      }
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

    const fitSectionCy = () => {
      const bb = cy.elements().boundingBox({});
      const pad = 20;
      // Don't set an explicit width — let the section fill the scroll container so
      // horizontal separators extend to the full display width. But set minWidth so
      // nodes at large x coordinates (from stored positions) remain visible.
      const h = Math.ceil(bb.h) + pad * 2;
      const minW = Math.ceil(bb.w) + pad * 2;
      container.style.height = `${h}px`;
      container.style.minWidth = `${minW}px`;
      cy.resize();
      cy.viewport({ zoom: 1, pan: { x: pad - bb.x1, y: pad - bb.y1 } });
    };

    cy.one("layoutstop", () => {
      this.applyStoredPositions(cy);
      fitSectionCy();
      cy.userPanningEnabled(false);
      cy.userZoomingEnabled(false);
      this.renderSectionSeparator(cy, container);
      if (this.pendingSelectTaskId) {
        const id = this.pendingSelectTaskId;
        this.pendingSelectTaskId = null;
        window.setTimeout(() => this.selectGraphNode(id), 0);
      }
    });

    cy.on("dragfree", "node", (evt) => {
      this.saveNodePosition(evt.target as cytoscape.NodeSingular);
      fitSectionCy();
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
    openDropdown(
      anchor,
      STATUSES.map((s) => ({
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
        <div class="pm-node-title">${escapeHtml(stripWikiLinks(data.label))}</div>
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
      <div class="pm-node-project-title">${escapeHtml(stripWikiLinks(data.label))}</div>
      <button class="pm-node-edit-btn pm-node-project-edit-btn" data-proj-id="${escapeHtml(data.projId ?? "")}" title="Edit project">${PENCIL_SVG}</button>
    </div>`;
  }

  private renderSectionSeparator(cy: Core, container: HTMLElement): void {
    const svgNS = "http://www.w3.org/2000/svg";
    let svg = container.querySelector<SVGSVGElement>(".pm-sep-svg");
    if (!svg) {
      svg = activeDocument.createElementNS(svgNS, "svg");
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
      const line = activeDocument.createElementNS(svgNS, "line");
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
      this.sepSvg = activeDocument.createElementNS(svgNS, "svg");
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
      const line = activeDocument.createElementNS(svgNS, "line");
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
        isOverdue: !!lastEntry.due && lastEntry.due < today && !DONE_STATUSES.has(lastEntry.status),
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
          isOverdue: !!t.due && t.due < today && !DONE_STATUSES.has(t.status),
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
