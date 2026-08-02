import { ItemView, Menu, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { GraphRenderer } from "./graph-renderer";
import { GraphNode, ProjectNode, TaskNode, NODE_HEIGHT, NODE_WIDTH } from "./graph-node";
import { DependencyEdge, GraphEdge, VirtualEdge, resolveEdges, type EdgeSpec } from "./graph-edge";
import { type LayoutSpacing } from "./graph-layout";
import { diffDays, formatDate } from "../model/dates";
import { isValidDependencyTarget } from "../model/project/task";
import { ancestorChain, buildChildMap, effectiveStatus, isCompletedWithOpenSubtasks, isOpenUnderCompletedParent } from "../model/project/task-tree";
import { isTask, type Project } from "../model/project/project";
import { type Task } from "../model/project/task";
import { loadVaultData } from "../model/project/vault-reader";
import { TaskModal, TaskModalMode, ProjectModal, addTaskDependency, removeTaskDependency, deleteTaskFile, patchTaskField, openDropdown, openNoteFile } from "./task-creator";
import { STATUS_COLORS, PRIORITY_COLORS, STATUS_LABELS, PRIORITY_LABELS, STATUSES, PRIORITIES, Priority, joinStatuses, isDoneStatus, toStatus } from "../model/base-task";
import { PatchableField } from "../model/project/project-task-file";
import { computeEffectiveValues, type EffectiveValues } from "../model/project/task-scoring";
import { priorityRibbonBackground, statusPillColors } from "./task-badges";
import { Icon } from "./icons";
import { openTaskContextMenu } from "./task-context-menu";
import { DASHBOARD_VIEW_TYPE } from "./dashboard-view";
import { OffscreenRefreshGate } from "./offscreen-refresh-gate";

export const TASK_GRAPH_VIEW_TYPE = "pm-compass-task-graph";

/** Spacing per graph: the drilled-in view has room the stacked project sections don't. */
const DRILL_SPACING: LayoutSpacing = { rankSep: 70, nodeSep: 50 };
const SECTION_SPACING: LayoutSpacing = { rankSep: 60, nodeSep: 20 };
const DRILL_PADDING = 30;
const SECTION_PADDING = 20;

/** A title as the card prints it: `[[page|shown]]` reads as `shown`. */
export function stripWikiLinks(str: string): string {
  return str.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match: string, page: string, display: string | undefined) => display?.trim() ?? page.trim(),
  );
}

/** A hex colour with an alpha suffix, for the translucent fills the cards use. */
export function withAlpha(hex: string, alphaHex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const expanded = h.length === 3 ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h;
  return `#${expanded}${alphaHex}`;
}

interface NodeData {
  id: string;
  label: string;
  /** The status in force — the task's own, or `cancelled` from an ancestor. */
  status: string;
  /** The task's own status, spelled out alongside `status` when the two differ. */
  ownStatus: string;
  priorityBackground: string;
  /** The deadline as the card prints it, already formatted — this record is what the
   *  node template renders. */
  dueLabel: string;
  isOverdue: boolean;
  childCount: number;
  warnSubtasks: boolean;
  warnParentDone: boolean;
  color: string;
  projId?: string;
  taskId?: string;
}

/** The whole-vault lookups every node card needs, built once per render and threaded
 *  through the per-project sections — each costs a pass over the vault. */
interface VaultIndex {
  childMap: Map<string | undefined, Task[]>;
  byId: Map<string, Task>;
  effectiveValues: Map<string, EffectiveValues>;
}

/** One graph's contents, as the view assembles them: the cards themselves, and the links
 *  between them named by id — `resolveEdges` ties the two together. */
export interface GraphElements {
  nodes: GraphNode[];
  edges: EdgeSpec[];
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

/** What a passed deadline paints the due label. */
const OVERDUE_COLOR = "#ef4444";

/** One of a card's completion-mismatch glyphs, its title carrying the explanation. */
function warnGlyph(parent: HTMLElement, icon: Icon, title: string): void {
  setIcon(parent.createSpan({ cls: "pm-node-warn", attr: { title } }), icon);
}

/** A card's icon button. */
function cardButton(parent: HTMLElement, cls: string, icon: Icon, title: string, attr: Record<string, string>): void {
  setIcon(parent.createEl("button", { cls, attr: { ...attr, title } }), icon);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The separator overlay for one graph's container, emptied ready to redraw. Found in the
 *  DOM rather than held: a re-render empties the container and takes it with it. */
function sepSvgFor(container: HTMLElement): SVGSVGElement {
  let svg = container.querySelector<SVGSVGElement>(".pm-sep-svg");
  if (!svg) {
    svg = activeDocument.createElementNS(SVG_NS, "svg");
    svg.classList.add("pm-sep-svg");
    container.appendChild(svg);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  return svg;
}

function drawSepLine(svg: SVGSVGElement, x1: number, y1: number, x2: number, y2: number): void {
  const line = activeDocument.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  line.classList.add("pm-sep-line");
  svg.appendChild(line);
}

/** The id a task's context card takes, its own being held by the task's own card. */
function contextNodeId(task: Task): string {
  return `${task.id}-ctx`;
}

/** A project's heading card. Only `label`, `color` and `projId` reach its template; the
 *  task fields sit empty so one record type covers every card. */
function projectNodeData(id: string, proj: Project): NodeData {
  return {
    id,
    label: proj.title,
    color: proj.color ?? "#888888",
    projId: proj.id,
    status: "", ownStatus: "", priorityBackground: "", dueLabel: "",
    isOverdue: false, childCount: 0, warnSubtasks: false, warnParentDone: false,
  };
}

/** Where the divide between the context column and the task columns falls. Null when
 *  either side is empty, or they overlap and no line belongs between them. */
function contextDivideX(graph: GraphRenderer): number | null {
  const contextNodes = graph.contextNodes();
  const taskNodes = graph.contentNodes();
  if (contextNodes.length === 0 || taskNodes.length === 0) return null;
  const contextMaxX = Math.max(
    ...contextNodes.map((n) => graph.renderedPosition(n).x + NODE_WIDTH / 2),
  );
  const taskMinX = Math.min(
    ...taskNodes.map((n) => graph.renderedPosition(n).x - NODE_WIDTH / 2),
  );
  return contextMaxX < taskMinX ? (contextMaxX + taskMinX) / 2 : null;
}

export class TaskGraphView extends ItemView {
  navigation = false;

  /** The drilled-in graph, or null when project sections are shown instead. */
  private graph: GraphRenderer | null = null;
  /** One per project section, in the all-projects view. */
  private graphs: GraphRenderer[] = [];
  private tasks: Task[] = [];
  private projects: Project[] = [];
  private drillPath: Array<Project | Task> = [];
  private showActiveOnly = true;
  private readonly plugin: PluginWithPanelConfig;
  private breadcrumbEl!: HTMLElement;
  private graphContainer!: HTMLElement;
  private readonly CHANGE_DEBOUNCE_MS = 300;
  private settingsPanelEl: HTMLElement | null = null;
  private settingsPanelOpen = false;
  private dragOverlaySvg: SVGSVGElement | null = null;
  private dragPointerMoveHandler: ((e: PointerEvent) => void) | null = null;
  private dragPointerUpHandler: (() => void) | null = null;
  private pendingSelectTaskId: string | null = null;
  private readonly refreshGate = new OffscreenRefreshGate(this, () => { void this.refresh(); });


  constructor(leaf: WorkspaceLeaf, plugin: PluginWithPanelConfig) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return TASK_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Task graph";
  }

  getIcon(): string {
    return Icon.TaskGraphTab;
  }

  async onOpen(): Promise<void> {
    this.refreshGate.register();
    this.showActiveOnly = this.plugin.settings.panelConfig.showActiveOnly;
    const breadcrumbBar = this.contentEl.createDiv({ cls: "pm-breadcrumb" });
    this.breadcrumbEl = breadcrumbBar.createSpan({ cls: "pm-breadcrumb-items" });
    this.buildGear(breadcrumbBar);
    const scrollWrapper = this.contentEl.createDiv({ cls: "pm-compass-scroll-wrapper" });
    this.graphContainer = scrollWrapper.createDiv({
      cls: "pm-compass-graph-container",
    });

    // Pointerdown on a card's own controls: each opens its picker, and none of them
    // should also start dragging the card.
    this.registerDomEvent(this.graphContainer, "pointerdown", (e: PointerEvent) => {
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

    this.registerDomEvent(this.graphContainer, "contextmenu", (e: MouseEvent) => {
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
    this.refreshGate.cancel();
    this.cancelDragConnect();
    this.destroyGraphs();
  }

  private destroyGraphs(): void {
    this.graph?.destroy();
    this.graph = null;
    for (const graph of this.graphs) graph.destroy();
    this.graphs = [];
  }

  private isInProjectsFolder(filePath: string): boolean {
    return filePath.startsWith(this.plugin.settings.projectsFolder + "/");
  }

  private scheduleRefresh(): void {
    this.refreshGate.schedule(this.CHANGE_DEBOUNCE_MS);
  }

  private openAddTaskMenu(e: MouseEvent, proj: Project, parentTask: Task | undefined): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Add task")
        .setIcon(Icon.AddTask)
        .onClick(() => {
          new TaskModal(this.app, {
            mode: TaskModalMode.Create,
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
    openTaskContextMenu(this.app, e, {
      task,
      projects: this.projects,
      allTasks: this.tasks,
      onRefresh: () => { void this.refresh(); },
      onDelete: (t, parentTask) => {
        void deleteTaskFile(this.app, t, parentTask, this.tasks).then(() => this.refresh());
      },
    });
  }

  private buildGear(bar: HTMLElement): void {
    const gearBtn = bar.createEl("button", { cls: "pm-compass-gear-btn" });
    setIcon(gearBtn, Icon.Settings);
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

    // Confirmed against the vault, not the parsed project list: a metadataCache read can
    // transiently miss frontmatter just written, bouncing the view up a level for nothing.
    if (this.drillPath.length > 0 && !isTask(this.drillPath[0])) {
      const proj = this.drillPath[0];
      if (!this.projects.find((p) => p.id === proj.id) && !this.app.vault.getAbstractFileByPath(proj.filePath)) {
        this.drillPath = [];
      }
    }

    // Trimmed at the first task that no longer exists, guarded as above.
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
    const sourceCard = this.graphContainer.querySelector<HTMLElement>(`.pm-node-card[data-task-id="${CSS.escape(sourceId)}"]`);
    sourceCard?.classList.add("pm-connect-source");

    const sr = sourceCard?.getBoundingClientRect();
    const sx = sr ? sr.left + sr.width / 2 : startEvent.clientX;
    const sy = sr ? sr.top + sr.height / 2 : startEvent.clientY;

    const svg = createSvg("svg");
    svg.classList.add("pm-drag-line-overlay");
    const line = createSvg("line");
    line.classList.add("pm-drag-line");
    line.setAttribute("x1", String(sx));
    line.setAttribute("y1", String(sy));
    line.setAttribute("x2", String(startEvent.clientX));
    line.setAttribute("y2", String(startEvent.clientY));
    svg.appendChild(line);
    activeDocument.body.appendChild(svg);
    this.dragOverlaySvg = svg;

    // Released so pointermove/pointerup fire on the document freely.
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

    // The target tracked in pointermove, elementFromPoint being unreliable at release
    // with the SVG overlay in the way.
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
    this.graphContainer?.querySelector(".pm-connect-source")?.classList.remove("pm-connect-source");
    this.graphContainer?.querySelector(".pm-connect-target")?.classList.remove("pm-connect-target");
    if (this.dragOverlaySvg) { this.dragOverlaySvg.remove(); this.dragOverlaySvg = null; }
    if (this.dragPointerMoveHandler) { activeDocument.removeEventListener("pointermove", this.dragPointerMoveHandler); this.dragPointerMoveHandler = null; }
    if (this.dragPointerUpHandler) {
      activeDocument.removeEventListener("pointerup", this.dragPointerUpHandler);
      activeDocument.removeEventListener("pointercancel", this.dragPointerUpHandler);
      this.dragPointerUpHandler = null;
    }
  }

  /** Adds the dependency once `isValidDependencyTarget` allows it, else a Notice. */
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

  private showRemoveDependencyMenu(edge: GraphEdge, evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item =>
      item.setTitle("Remove dependency").setIcon(Icon.RemoveDependency)
        .onClick(() => { void this.removeDependency(edge.source.id, edge.target.id); })
    );
    menu.showAtMouseEvent(evt);
  }

  /** Calls removeTaskDependency then refresh. */
  private async removeDependency(sourceId: string, targetId: string): Promise<void> {
    const target = this.tasks.find(t => t.id === targetId);
    if (!target) return;
    await removeTaskDependency(this.app, target, sourceId);
    await this.refresh();
  }

  private signalDashboard(taskId: string): void {
    const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (leaves.length === 0) return;
    const view = leaves[0].view as { selectTask?: (id: string) => boolean };
    view.selectTask?.(taskId);
  }

  selectGraphNode(taskId: string): void {

    this.graphContainer.querySelectorAll<HTMLElement>(".pm-node-card--selected").forEach((el) => {
      el.classList.remove("pm-node-card--selected");
    });
    const card = this.graphContainer.querySelector<HTMLElement>(`.pm-node-card[data-task-id="${CSS.escape(taskId)}"]`);
    if (card) card.classList.add("pm-node-card--selected");
  }

  private saveNodePosition(nodeId: string, pos: { x: number; y: number }): void {
    this.plugin.settings.nodePositions[nodeId] = { x: pos.x, y: pos.y };
    void this.plugin.saveSettings();
  }

  /** Navigates to a task, shown as a card in its parent task's or project's context. */
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

  /** Builds [project, ancestor…, task], which is what the breadcrumb walks. */
  private buildTaskDrillPath(project: Project, task: Task): Array<Project | Task> {
    return [project, ...ancestorChain(new Map(this.tasks.map((t) => [t.id, t])), task)];
  }

  private pruneStalePositions(): void {
    const validIds = new Set<string>();
    for (const t of this.tasks) validIds.add(t.id);
    for (const p of this.projects) validIds.add(`proj-${p.id}`);
    for (const entry of this.drillPath) {
      if (isTask(entry)) validIds.add(contextNodeId(entry));
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
    if (!this.graphContainer) return;

    this.cancelDragConnect();
    this.updateBreadcrumb();
    this.destroyGraphs();
    this.graphContainer.empty();
    // `minWidth` too: the single-project view fixes it on this very container, and left
    // behind it would floor the width a drilled-in graph asks for.
    this.graphContainer.setCssStyles({ width: "", height: "", minWidth: "" });

    this.renderGraphContent();

    // Consumed once the whole render is up, so a card in the last project section is
    // still found — the sections don't know which of them holds the task.
    if (this.pendingSelectTaskId) {
      const id = this.pendingSelectTaskId;
      this.pendingSelectTaskId = null;
      this.selectGraphNode(id);
    }
  }

  private renderGraphContent(): void {
    if (this.drillPath.length === 0) {
      this.renderAllProjectsTable();
      return;
    }

    // Single-project view: same display as the all-projects view
    if (this.drillPath.length === 1) {
      const proj = this.drillPath[0] as Project;
      let tasks = this.tasks.filter((t) => t.projectId === proj.id && !t.parentId);
      if (this.showActiveOnly) tasks = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
      this.createProjectSection(this.graphContainer, proj, tasks);
      return;
    }

    let elements = this.buildElements();

    // The context node is always there, so a lone node means no subtasks
    if (elements.nodes.length <= 1) {
      this.graphContainer.createEl("p", { text: "No tasks found.", cls: "pm-compass-empty" });
      return;
    }

    // On narrow displays, drop context/anchor nodes so only tasks are shown
    const isNarrow = this.graphContainer.clientWidth > 0 && this.graphContainer.clientWidth < 500;
    if (isNarrow) {
      elements = {
        nodes: elements.nodes.filter((n) => !n.isContext),
        edges: elements.edges.filter((e) => e.kind !== VirtualEdge),
      };
    }

    if (elements.nodes.length === 0) {
      this.graphContainer.createEl("p", { text: "No tasks found.", cls: "pm-compass-empty" });
      return;
    }

    this.graph = this.createGraph({
      container: this.graphContainer,
      elements,
      spacing: DRILL_SPACING,
      padding: DRILL_PADDING,
      onDrillTask: (task) => { this.drillPath.push(task); this.renderGraph(); },
      applySize: (size) => {
        this.graphContainer.style.width = `${size.width}px`;
        this.graphContainer.style.height = `${size.height}px`;
      },
      drawSeparators: (graph) => this.renderSeparators(graph),
    });
  }

  /**
   * Builds one graph in `container` and wires it up. Both the drilled-in view and a
   * project section land here; they differ in spacing, in what a tap drills into, and in
   * how much of the room they take is theirs to fix.
   */
  private createGraph(opts: {
    container: HTMLElement;
    elements: GraphElements;
    spacing: LayoutSpacing;
    padding: number;
    onDrillTask: (task: Task) => void;
    onDrillProject?: () => void;
    applySize: (size: { width: number; height: number }) => void;
    drawSeparators: (graph: GraphRenderer) => void;
  }): GraphRenderer {
    const nodes = opts.elements.nodes;

    const graph: GraphRenderer = new GraphRenderer({
      container: opts.container,
      nodes,
      edges: resolveEdges(nodes, opts.elements.edges),
      spacing: opts.spacing,
      storedPositions: this.plugin.settings.nodePositions,
      onNodeTap: (node, evt, origin) => this.handleNodeTap(node, evt, origin, opts),
      onNodeDoubleTap: (node, _evt, origin) => {
        if (!node.canDrillIn) return;
        if (origin?.closest?.(".pm-node-edit-btn")) return;
        const task = this.tasks.find((t) => t.id === node.id);
        if (task) opts.onDrillTask(task);
      },
      onEdgeContextMenu: (edge, evt) => this.showRemoveDependencyMenu(edge, evt),
      onNodeDragEnd: (node, pos) => {
        this.saveNodePosition(node.id, pos);
        opts.applySize(graph.fit(opts.padding));
        opts.drawSeparators(graph);
      },
    });

    opts.applySize(graph.fit(opts.padding));
    opts.drawSeparators(graph);
    return graph;
  }

  private projectNode(data: NodeData): ProjectNode {
    return new ProjectNode({ id: data.id, card: this.projectNodeCard(data) });
  }

  private taskNode(data: NodeData): TaskNode {
    return new TaskNode({ id: data.id, card: this.taskNodeCard(data) });
  }

  /**
   * A tap on a card: the edit button opens the modal, ctrl-click the note, and anything
   * else selects. The ribbon and status badge go through the container's pointerdown
   * handler instead, and the connect button starts a drag there.
   *
   * Read against `tapTarget` — where the press landed — rather than the release, which a
   * connect drag leaves over whichever card it was dropped on.
   */
  private handleNodeTap(
    node: GraphNode,
    evt: PointerEvent,
    tapTarget: Element | null,
    opts: { onDrillProject?: () => void },
  ): void {
    if (node instanceof ProjectNode) {
      const btn = tapTarget?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!btn) {
        opts.onDrillProject?.();
        return;
      }
      const proj = this.projects.find((p) => p.id === btn.dataset.projId);
      if (!proj) return;
      if (evt.ctrlKey) {
        openNoteFile(this.app, proj.filePath);
        return;
      }
      new ProjectModal(this.app, { project: proj, onSuccess: () => { void this.refresh(); } }).open();
      return;
    }

    if (!(node instanceof TaskNode)) return;
    if (tapTarget?.closest(".pm-node-connect-btn")) return;

    const editBtn = tapTarget?.closest<HTMLElement>(".pm-node-edit-btn");
    if (!editBtn) {
      this.selectGraphNode(node.taskId);
      this.signalDashboard(node.taskId);
      return;
    }
    const task = this.tasks.find((t) => t.id === editBtn.dataset.taskId);
    if (!task) return;
    if (evt.ctrlKey) {
      openNoteFile(this.app, task.filePath);
      return;
    }
    new TaskModal(this.app, {
      mode: TaskModalMode.Edit, task,
      existingTasks: this.tasks.filter((t) => t.projectId === task.projectId),
      onSuccess: () => { void this.refresh(); },
    }).open();
  }

  private renderAllProjectsTable(): void {
    if (this.projects.length === 0) {
      this.graphContainer.createEl("p", { text: "No projects found.", cls: "pm-compass-empty" });
      return;
    }
    const index = this.buildVaultIndex();

    // Grouped in one pass rather than scanned per project: every task of the vault is here.
    const rootsByProject = new Map<string, Task[]>();
    for (const t of this.tasks) {
      if (t.parentId) continue;
      if (this.showActiveOnly && !ACTIVE_STATUSES.has(t.status)) continue;
      const roots = rootsByProject.get(t.projectId);
      if (roots) roots.push(t);
      else rootsByProject.set(t.projectId, [t]);
    }

    for (const proj of this.projects) {
      const section = this.graphContainer.createDiv({ cls: "pm-project-section" });
      section.dataset.projId = proj.id;
      this.createProjectSection(section, proj, rootsByProject.get(proj.id) ?? [], index);
    }
  }

  private createProjectSection(container: HTMLElement, proj: Project, tasks: Task[], index?: VaultIndex): void {
    const today = new Date();
    const vaultIndex = index ?? this.buildVaultIndex();
    const projNodeId = `proj-${proj.id}`;

    const elements: GraphElements = {
      nodes: [
        this.projectNode(projectNodeData(projNodeId, proj)),
        ...tasks.map((t) => this.taskNode(this.taskNodeData(t, vaultIndex, today))),
      ],
      edges: [
        ...tasks.map((t) => ({ source: projNodeId, target: t.id, kind: VirtualEdge })),
        ...this.dependencyEdges(tasks),
      ],
    };

    this.graphs.push(this.createGraph({
      container,
      elements,
      spacing: SECTION_SPACING,
      padding: SECTION_PADDING,
      onDrillTask: (task) => { this.drillPath = [proj, task]; this.renderGraph(); },
      onDrillProject: () => { this.drillPath = [proj]; this.renderGraph(); },
      // No explicit width, so the section fills the scroll container and its separators
      // run the full display width; `minWidth` keeps far-right nodes visible.
      applySize: (size) => {
        container.style.height = `${size.height}px`;
        container.style.minWidth = `${size.width}px`;
      },
      drawSeparators: (graph) => this.renderSectionSeparator(graph, container),
    }));
  }

  private openPriorityDropdown(anchor: HTMLElement, task: Task): void {
    openDropdown(
      anchor,
      PRIORITIES.map((p) => ({
        label: PRIORITY_LABELS[p],
        color: p ? PRIORITY_COLORS[p] : undefined,
        // The card's ribbon is rolled up over the subtree, so the picker is the only
        // place the task's own level is legible.
        selected: p === (task.priority || Priority.None),
        onSelect: () => { void patchTaskField(this.app, task.filePath, PatchableField.Priority, p).then(() => this.refresh()); },
      })),
    );
  }

  private openStatusDropdown(anchor: HTMLElement, task: Task): void {
    openDropdown(
      anchor,
      STATUSES.map((s) => ({
        label: STATUS_LABELS[s],
        color: STATUS_COLORS[s],
        selected: s === toStatus(task.status),
        onSelect: () => { void patchTaskField(this.app, task.filePath, PatchableField.Status, s).then(() => this.refresh()); },
      })),
    );
  }

  /** The whole-vault lookups a render's node cards share — see `VaultIndex`. */
  private buildVaultIndex(): VaultIndex {
    const byId = new Map(this.tasks.map((t) => [t.id, t]));
    return { childMap: buildChildMap(this.tasks), byId, effectiveValues: computeEffectiveValues(this.tasks, byId) };
  }

  /**
   * The node card's priority bar — a row's ribbon fill, painted inline because the card is
   * an HTML card. Rolled up over the whole vault, since a card is a root task
   * whose ribbon must see the subtree the section doesn't draw. Its own level stands in
   * where the roll-ups are missing, the cache being able to drop it transiently.
   */
  private ribbonBackground(task: Task, effectiveValues: Map<string, EffectiveValues>): string {
    const rollup = (id: string) => effectiveValues.get(id);
    return priorityRibbonBackground(
      task.priorityFromAbove(rollup) ?? undefined,
      task.priorityFromBelow(rollup) ?? undefined,
    );
  }

  private taskNodeCard(data: NodeData): HTMLElement {
    const taskId = data.taskId ?? data.id;
    const card = createDiv({ cls: "pm-node-card", attr: { "data-task-id": taskId } });

    card.createDiv({ cls: "pm-node-ribbon", attr: { "data-task-id": taskId } })
      .setCssStyles({ background: data.priorityBackground || "transparent" });

    const body = card.createDiv({ cls: "pm-node-body" });
    body.createDiv({ cls: "pm-node-title", text: stripWikiLinks(data.label) });

    const meta = body.createDiv({ cls: "pm-node-meta" });
    const pill = statusPillColors(data.status);
    meta.createSpan({
      cls: "pm-node-status",
      text: joinStatuses(data.ownStatus, data.status),
      attr: { "data-task-id": taskId },
    }).setCssStyles({ background: pill.bg, color: pill.text, border: `1px solid ${pill.border}` });

    if (data.warnSubtasks) warnGlyph(meta, Icon.SubtaskWarning, "Completed, but has unfinished subtasks");
    if (data.warnParentDone) warnGlyph(meta, Icon.ParentDoneWarning, "Still open, but its parent task is completed");
    if (data.dueLabel) {
      const due = meta.createSpan({ cls: "pm-node-due", text: data.dueLabel });
      if (data.isOverdue) due.setCssStyles({ color: OVERDUE_COLOR, fontWeight: "600" });
    }

    if (data.childCount > 0) {
      const plural = data.childCount > 1 ? "s" : "";
      body.createDiv({ cls: "pm-node-subtask-row", text: `↳ ${data.childCount} subtask${plural}` });
    }

    const actions = card.createDiv({ cls: "pm-node-actions" });
    cardButton(actions, "pm-node-edit-btn", Icon.EditTask, "Edit task", { "data-task-id": taskId });
    cardButton(actions, "pm-node-connect-btn", Icon.AddDependency, "Add dependency", { "data-task-id": taskId });
    return card;
  }

  private projectNodeCard(data: NodeData): HTMLElement {
    const projId = data.projId ?? "";
    const card = createDiv({ cls: "pm-node-project-card", attr: { "data-proj-id": projId } });
    card.setCssStyles({
      border: `1.5px solid ${data.color}`,
      background: withAlpha(data.color, "26"),
      color: data.color,
    });
    card.createDiv({ cls: "pm-node-project-title", text: stripWikiLinks(data.label) });
    cardButton(card, "pm-node-edit-btn pm-node-project-edit-btn", Icon.EditTask, "Edit project", { "data-proj-id": projId });
    return card;
  }

  /** One graph section: the divide between its context column and its tasks. */
  private renderSectionSeparator(graph: GraphRenderer, container: HTMLElement): void {
    const svg = sepSvgFor(container);
    const x = contextDivideX(graph);
    if (x !== null) drawSepLine(svg, x, 0, x, container.clientHeight);
  }

  /** The main graph: the same vertical divide, plus a horizontal rule between adjacent
   *  context rows, which only a multi-project view has. */
  private renderSeparators(graph: GraphRenderer): void {
    if (!this.graphContainer) return;
    const svg = sepSvgFor(this.graphContainer);
    const w = this.graphContainer.clientWidth;

    const x = contextDivideX(graph);
    if (x !== null) drawSepLine(svg, x, 0, x, this.graphContainer.clientHeight);

    const ys = graph
      .contextNodes()
      .map((n) => graph.renderedPosition(n).y)
      .sort((a, b) => a - b);
    for (let i = 0; i < ys.length - 1; i++) {
      const midY = (ys[i] + NODE_HEIGHT / 2 + ys[i + 1] - NODE_HEIGHT / 2) / 2;
      drawSepLine(svg, 0, midY, w, midY);
    }
  }

  /** One task's card, as the templates read it. Every graph here draws the same card — a
   *  project section, the drilled-in view, and the context task heading it. */
  private taskNodeData(
    t: Task,
    index: VaultIndex,
    today: Date,
    asContext = false,
  ): NodeData {
    const { childMap, byId, effectiveValues } = index;
    const status = effectiveStatus(t, byId);
    return {
      // The context card stands beside the task's own, so it can't take its id. Its
      // markup still names the task, which is what a tap on it resolves through.
      id: asContext ? contextNodeId(t) : t.id,
      taskId: t.id,
      label: t.title,
      status,
      ownStatus: t.status,
      priorityBackground: this.ribbonBackground(t, effectiveValues),
      dueLabel: t.due ? formatDate(t.due) : "",
      isOverdue: !!t.due && diffDays(today, t.due) < 0 && !isDoneStatus(status),
      // The context card's subtasks are the graph around it, not a count on the card.
      childCount: asContext ? 0 : childMap.get(t.id)?.length ?? 0,
      warnSubtasks: isCompletedWithOpenSubtasks(t, childMap, byId),
      warnParentDone: isOpenUnderCompletedParent(t, byId),
      color: "",
    };
  }

  /** The dependency edges among `tasks`, dropping any pointing outside the graph. */
  private dependencyEdges(tasks: Task[]): EdgeSpec[] {
    const shown = new Set(tasks.map((t) => t.id));
    return tasks.flatMap((t) =>
      t.dependencies
        .filter((depId) => shown.has(depId))
        .map((depId) => ({ source: depId, target: t.id, kind: DependencyEdge })),
    );
  }

  private buildElements(): GraphElements {
    const today = new Date();
    const index = this.buildVaultIndex();
    const { byId } = index;

    // ── Task drill view ─────────────────────────────────────────────────────
    // drillPath always starts with a Project followed by one or more Tasks
    const lastEntry = this.drillPath[this.drillPath.length - 1];
    if (!isTask(lastEntry)) return { nodes: [], edges: [] }; // guard

    const contextData = this.taskNodeData(lastEntry, index, today, true);
    const contextNode = new TaskNode({
      id: contextData.id,
      taskId: lastEntry.id,
      isContext: true,
      card: this.taskNodeCard(contextData),
    });

    let targetTasks = this.tasks.filter((t) => t.parentId === lastEntry.id);
    if (this.showActiveOnly) {
      targetTasks = targetTasks.filter((t) => ACTIVE_STATUSES.has(effectiveStatus(t, byId)));
    }

    return {
      nodes: [contextNode, ...targetTasks.map((t) => this.taskNode(this.taskNodeData(t, index, today)))],
      edges: [
        ...targetTasks.map((t) => ({ source: contextNode.id, target: t.id, kind: VirtualEdge })),
        ...this.dependencyEdges(targetTasks),
      ],
    };
  }
}
