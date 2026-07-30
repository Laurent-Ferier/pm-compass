import { ItemView, Menu, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import cytoscapeDagre from "cytoscape-dagre";
import nodeHtmlLabel from "cytoscape-node-html-label";
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
import { Icon, iconMarkup } from "./icons";
import { openTaskContextMenu } from "./task-context-menu";
import { DASHBOARD_VIEW_TYPE } from "./dashboard-view";
import { OffscreenRefreshGate } from "./offscreen-refresh-gate";

cytoscape.use(cytoscapeDagre);
cytoscape.use(nodeHtmlLabel as unknown as cytoscape.Ext);

export const TASK_GRAPH_VIEW_TYPE = "pm-compass-task-graph";

/** What a node on the graph stands for. Cytoscape matches on the stored string, so
 *  build selectors with `nodeSelector` rather than spelling one out. */
export enum GraphNodeType {
  Task = "task",
  Project = "project",
  /** A task shown only for context — an ancestor or dependency of the focused one. */
  ContextTask = "context-task",
}

/** A cytoscape selector matching the nodes of one or more types. */
function nodeSelector(...types: GraphNodeType[]): string {
  return types.map((t) => `node[nodeType='${t}']`).join(", ");
}

/** The node templates below are raw HTML strings, so every value interpolated into
 *  one is escaped here. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

/**
 * How far a finger travels before it drags a card rather than tapping it. Cytoscape's
 * default 8px is under what a thumb rolls while pressing a badge. Raising the distance
 * also makes the long-press menu more tolerant of wobble, where a delay would eat into
 * its timing. Touch only — a mouse keeps `desktopTapThreshold`.
 */
const TOUCH_DRAG_THRESHOLD = 24;

interface NodeData {
  id: string;
  label: string;
  /** The status in force — the task's own, or `cancelled` from an ancestor. */
  status: string;
  /** The task's own status, spelled out alongside `status` when the two differ. */
  ownStatus: string;
  priorityBackground: string;
  /** The deadline as the card prints it, already formatted — this record is what
   *  cytoscape holds and the node template renders. */
  dueLabel: string;
  isOverdue: boolean;
  nodeType: GraphNodeType;
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

/** Where the divide between the context column and the task columns falls. Null when
 *  either side is empty, or they overlap and no line belongs between them. */
function contextDivideX(cy: Core): number | null {
  const contextNodes = cy.nodes("[?isContext]").toArray();
  const taskNodes = cy.nodes(`[nodeType='${GraphNodeType.Task}']`).toArray();
  if (contextNodes.length === 0 || taskNodes.length === 0) return null;
  const contextMaxX = Math.max(
    ...contextNodes.map((n) => n.renderedPosition().x + n.renderedWidth() / 2),
  );
  const taskMinX = Math.min(
    ...taskNodes.map((n) => n.renderedPosition().x - n.renderedWidth() / 2),
  );
  return contextMaxX < taskMinX ? (contextMaxX + taskMinX) / 2 : null;
}

/** Cytoscape styles shared by the main graph and each per-project section.
 *  `includeContextTask` adds the ancestor node only the drilled-in view shows. */
function buildCyStyles(includeContextTask: boolean): cytoscape.StylesheetJson {
  const taskLikeNodeStyle = {
    shape: "round-rectangle" as const, width: 160, height: 72,
    "background-color": "transparent", "border-width": 0, label: "",
  };
  const styles: cytoscape.StylesheetJson = [
    { selector: nodeSelector(GraphNodeType.Task), style: taskLikeNodeStyle },
    {
      selector: nodeSelector(GraphNodeType.Project),
      // Only the drilled-in graph's context project node is fully invisible; a section
      // header keeps the transparent-but-solid style.
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
    styles.splice(2, 0, { selector: nodeSelector(GraphNodeType.ContextTask), style: taskLikeNodeStyle });
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
    this.cyContainer = scrollWrapper.createDiv({
      cls: "pm-compass-graph-container",
    });

    // On a touch screen `preventDefault` doesn't stop the sequence: cytoscape would still
    // put the node in `:active`, and the `style` event that follows rebuilds every card,
    // taking a picker's anchor with it. Capture phase keeps these touches from it.
    this.registerDomEvent(this.cyContainer, "touchstart", (e: TouchEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.(".pm-node-ribbon, .pm-node-status, .pm-node-connect-btn")) e.stopPropagation();
    }, true);

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
    this.refreshGate.cancel();
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
    const sourceCard = this.cyContainer.querySelector<HTMLElement>(`.pm-node-card[data-task-id="${sourceId}"]`);
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

  private showRemoveDependencyMenu(evt: cytoscape.EventObjectEdge): void {
    if ((evt.target.data("edgeType") as string) === "virtual") return;
    const sourceId = evt.target.data("source") as string;
    const targetId = evt.target.data("target") as string;
    if (!sourceId || !targetId) return;
    const menu = new Menu();
    menu.addItem(item =>
      item.setTitle("Remove dependency").setIcon(Icon.RemoveDependency)
        .onClick(() => { void this.removeDependency(sourceId, targetId); })
    );
    menu.showAtMouseEvent(evt.originalEvent);
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
      touchTapThreshold: TOUCH_DRAG_THRESHOLD,
    });

    this.cy.elements().unselectify();

    (this.cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[], options?: NodeHtmlLabelOptions) => void }).nodeHtmlLabel([
      { query: nodeSelector(GraphNodeType.Task), cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
      { query: nodeSelector(GraphNodeType.Project), cssClass: "pm-hl", tpl: (data: NodeData) => this.projectNodeTemplate(data) },
      { query: nodeSelector(GraphNodeType.ContextTask), cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
    ], { enablePointerEvents: true });

    this.wireNodeHandlers(this.cy, {
      // The drilled-in view's context task is tappable too, its card being a real one.
      taskSelector: nodeSelector(GraphNodeType.Task, GraphNodeType.ContextTask),
      onDrillTask: (task) => { this.drillPath.push(task); this.renderGraph(); },
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
    if (this.projects.length === 0) {
      this.cyContainer.createEl("p", { text: "No projects found.", cls: "pm-compass-empty" });
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
      const section = this.cyContainer.createDiv({ cls: "pm-project-section" });
      section.dataset.projId = proj.id;
      this.createProjectSectionCy(section, proj, rootsByProject.get(proj.id) ?? [], index);
    }
  }

  private createProjectSectionCy(container: HTMLElement, proj: Project, tasks: Task[], index?: VaultIndex): void {
    const today = new Date();
    const vaultIndex = index ?? this.buildVaultIndex();
    const projNodeId = `proj-${proj.id}`;

    const elements: ElementDefinition[] = [
      {
        data: {
          id: projNodeId,
          label: proj.title,
          nodeType: GraphNodeType.Project,
          isContext: true,
          color: proj.color ?? "#888888",
          projId: proj.id,
        },
      },
    ];

    for (const t of tasks) {
      elements.push({ data: this.taskNodeData(t, vaultIndex, today) });
      elements.push({ data: { id: `${projNodeId}->${t.id}`, source: projNodeId, target: t.id, edgeType: "virtual" } });
    }
    elements.push(...this.dependencyEdges(tasks));

    const cy = cytoscape({
      container,
      elements,
      style: buildCyStyles(false),
      touchTapThreshold: TOUCH_DRAG_THRESHOLD,
    });

    cy.elements().unselectify();

    (cy as unknown as { nodeHtmlLabel: (opts: HtmlLabelOption[], options?: NodeHtmlLabelOptions) => void }).nodeHtmlLabel([
      { query: nodeSelector(GraphNodeType.Task), cssClass: "pm-hl", tpl: (data: NodeData) => this.taskNodeTemplate(data) },
      { query: nodeSelector(GraphNodeType.Project), cssClass: "pm-hl", tpl: (data: NodeData) => this.projectNodeTemplate(data) },
    ], { enablePointerEvents: true });

    this.wireNodeHandlers(cy, {
      taskSelector: nodeSelector(GraphNodeType.Task),
      onDrillTask: (task) => { this.drillPath = [proj, task]; this.renderGraph(); },
      onDrillProject: () => { this.drillPath = [proj]; this.renderGraph(); },
    });

    const fitSectionCy = () => {
      const bb = cy.elements().boundingBox({});
      const pad = 20;
      // No explicit width, so the section fills the scroll container and its separators
      // run the full display width; `minWidth` keeps far-right nodes visible.
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
   * a cytoscape HTML label. Rolled up over the whole vault, since a card is a root task
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

  private taskNodeTemplate(data: NodeData): string {
    const editId = escapeHtml(data.taskId ?? data.id);
    const pill = statusPillColors(data.status);
    return `<div class="pm-node-card" data-task-id="${editId}">
      <div class="pm-node-ribbon" data-task-id="${editId}" style="background:${data.priorityBackground || "transparent"}"></div>
      <div class="pm-node-body">
        <div class="pm-node-title">${escapeHtml(stripWikiLinks(data.label))}</div>
        <div class="pm-node-meta">
          <span class="pm-node-status" data-task-id="${editId}" style="background:${pill.bg};color:${pill.text};border:1px solid ${pill.border}">${escapeHtml(joinStatuses(data.ownStatus, data.status))}</span>
          ${data.warnSubtasks ? `<span class="pm-node-warn" title="Completed, but has unfinished subtasks">${iconMarkup(Icon.SubtaskWarning)}</span>` : ""}
          ${data.warnParentDone ? `<span class="pm-node-warn" title="Still open, but its parent task is completed">${iconMarkup(Icon.ParentDoneWarning)}</span>` : ""}
          ${data.dueLabel ? `<span class="pm-node-due" style="${data.isOverdue ? "color:#ef4444;font-weight:600" : ""}">${escapeHtml(data.dueLabel)}</span>` : ""}
        </div>
        ${data.childCount > 0 ? `<div class="pm-node-subtask-row">↳ ${data.childCount} subtask${data.childCount > 1 ? "s" : ""}</div>` : ""}
      </div>
      <div class="pm-node-actions">
        <button class="pm-node-edit-btn" data-task-id="${editId}" title="Edit task">${iconMarkup(Icon.EditTask)}</button>
        <button class="pm-node-connect-btn" data-task-id="${editId}" title="Add dependency">${iconMarkup(Icon.AddDependency)}</button>
      </div>
    </div>`;
  }

  private projectNodeTemplate(data: NodeData): string {
    return `<div class="pm-node-project-card" data-proj-id="${escapeHtml(data.projId ?? "")}" style="border:1.5px solid ${data.color};background:${withAlpha(data.color, "26")};color:${data.color}">
      <div class="pm-node-project-title">${escapeHtml(stripWikiLinks(data.label))}</div>
      <button class="pm-node-edit-btn pm-node-project-edit-btn" data-proj-id="${escapeHtml(data.projId ?? "")}" title="Edit project">${iconMarkup(Icon.EditTask)}</button>
    </div>`;
  }

  /** One graph section: the divide between its context column and its tasks. */
  private renderSectionSeparator(cy: Core, container: HTMLElement): void {
    const svg = sepSvgFor(container);
    const x = contextDivideX(cy);
    if (x !== null) drawSepLine(svg, x, 0, x, container.clientHeight);
  }

  /** The main graph: the same vertical divide, plus a horizontal rule between adjacent
   *  context rows, which only a multi-project view has. */
  private renderSeparators(): void {
    if (!this.cy || !this.cyContainer) return;
    const svg = sepSvgFor(this.cyContainer);
    const w = this.cyContainer.clientWidth;

    const x = contextDivideX(this.cy);
    if (x !== null) drawSepLine(svg, x, 0, x, this.cyContainer.clientHeight);

    const contextNodes = this.cy
      .nodes("[?isContext]")
      .toArray()
      .sort((a, b) => a.renderedPosition().y - b.renderedPosition().y);
    for (let i = 0; i < contextNodes.length - 1; i++) {
      const y1 = contextNodes[i].renderedPosition().y + contextNodes[i].renderedHeight() / 2;
      const y2 =
        contextNodes[i + 1].renderedPosition().y - contextNodes[i + 1].renderedHeight() / 2;
      const midY = (y1 + y2) / 2;
      drawSepLine(svg, 0, midY, w, midY);
    }
  }

  /** One task's card as cytoscape holds it. Every graph here draws the same card — a
   *  project section, the drilled-in view, and the context task heading it. */
  private taskNodeData(
    t: Task,
    index: VaultIndex,
    today: Date,
    nodeType = GraphNodeType.Task,
  ): NodeData {
    const { childMap, byId, effectiveValues } = index;
    const status = effectiveStatus(t, byId);
    const isContext = nodeType === GraphNodeType.ContextTask;
    return {
      // The context node stands beside the task's own, so it can't take its id.
      id: isContext ? `${t.id}-ctx` : t.id,
      label: t.title,
      status,
      ownStatus: t.status,
      priorityBackground: this.ribbonBackground(t, effectiveValues),
      dueLabel: t.due ? formatDate(t.due) : "",
      isOverdue: !!t.due && diffDays(today, t.due) < 0 && !isDoneStatus(status),
      nodeType,
      // The context node's subtasks are the graph around it, not a count on the card.
      childCount: isContext ? 0 : childMap.get(t.id)?.length ?? 0,
      warnSubtasks: isCompletedWithOpenSubtasks(t, childMap, byId),
      warnParentDone: isOpenUnderCompletedParent(t, byId),
      color: "",
    };
  }

  /** The dependency edges among `tasks`, dropping any pointing outside the graph. */
  private dependencyEdges(tasks: Task[]): ElementDefinition[] {
    const shown = new Set(tasks.map((t) => t.id));
    return tasks.flatMap((t) =>
      t.dependencies
        .filter((depId) => shown.has(depId))
        .map((depId) => ({ data: { id: `${depId}->${t.id}`, source: depId, target: t.id } })),
    );
  }

  /** The tap handlers every graph shares: the cards' edit buttons, the dependency edges'
   *  menu, and the double-tap that drills in. A section also drills on a project card;
   *  the main graph, whose project node is just context, passes no `onDrillProject`. */
  private wireNodeHandlers(cy: Core, opts: {
    taskSelector: string;
    onDrillTask: (task: Task) => void;
    onDrillProject?: () => void;
  }): void {
    // The edit button opens the modal, ctrl-click the note; the ribbon and status go
    // through the DOM pointerdown handler instead.
    cy.on("tap", opts.taskSelector, (evt: cytoscape.EventObjectNode) => {
      const tapTarget = getEventTarget(evt);
      if (tapTarget?.closest<HTMLElement>(".pm-node-connect-btn")) return;
      const editBtn = tapTarget?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!editBtn) {
        // A context node carries the task it stands for in `taskId`, its own id being taken.
        const taskId = (evt.target.data("taskId") ?? evt.target.data("id")) as string | undefined;
        if (taskId) { this.selectGraphNode(taskId); this.signalDashboard(taskId); }
        return;
      }
      const task = this.tasks.find((t) => t.id === editBtn.dataset.taskId);
      if (!task) return;
      if ((evt.originalEvent as MouseEvent | undefined)?.ctrlKey) {
        openNoteFile(this.app, task.filePath);
        return;
      }
      new TaskModal(this.app, {
        mode: TaskModalMode.Edit, task,
        existingTasks: this.tasks.filter((t) => t.projectId === task.projectId),
        onSuccess: () => { void this.refresh(); },
      }).open();
    });

    cy.on("tap", nodeSelector(GraphNodeType.Project), (evt) => {
      const btn = getEventTarget(evt)?.closest<HTMLElement>(".pm-node-edit-btn");
      if (!btn) {
        opts.onDrillProject?.();
        return;
      }
      const proj = this.projects.find((p) => p.id === btn.dataset.projId);
      if (!proj) return;
      if ((evt.originalEvent as MouseEvent | undefined)?.ctrlKey) {
        openNoteFile(this.app, proj.filePath);
        return;
      }
      new ProjectModal(this.app, { project: proj, onSuccess: () => { void this.refresh(); } }).open();
    });

    cy.on("cxttap", "edge", (evt) => this.showRemoveDependencyMenu(evt));

    // Double-tap drills into subtasks, buttons excepted.
    cy.on("dbltap", nodeSelector(GraphNodeType.Task), (evt: cytoscape.EventObjectNode) => {
      const oe = evt.originalEvent as MouseEvent | undefined;
      if ((oe?.target as HTMLElement | undefined)?.closest(".pm-node-edit-btn")) return;
      const task = this.tasks.find((t) => t.id === (evt.target.data("id") as string));
      if (!task) return;
      opts.onDrillTask(task);
    });
  }

  private buildElements(): ElementDefinition[] {
    const today = new Date();
    const index = this.buildVaultIndex();
    const { byId } = index;

    // ── Task drill view ─────────────────────────────────────────────────────
    // drillPath always starts with a Project followed by one or more Tasks
    const lastEntry = this.drillPath[this.drillPath.length - 1];
    if (!isTask(lastEntry)) return []; // guard

    const contextId = `${lastEntry.id}-ctx`;
    const contextElement: ElementDefinition = {
      data: {
        ...this.taskNodeData(lastEntry, index, today, GraphNodeType.ContextTask),
        isContext: true,
        taskId: lastEntry.id,
      },
    };

    let targetTasks = this.tasks.filter((t) => t.parentId === lastEntry.id);
    if (this.showActiveOnly) {
      targetTasks = targetTasks.filter((t) => ACTIVE_STATUSES.has(effectiveStatus(t, byId)));
    }

    const elements: ElementDefinition[] = [contextElement];
    for (const t of targetTasks) {
      elements.push({ data: this.taskNodeData(t, index, today) });
      elements.push({
        data: { id: `${contextId}->${t.id}`, source: contextId, target: t.id, edgeType: "virtual" },
      });
    }
    elements.push(...this.dependencyEdges(targetTasks));

    return elements;
  }
}
