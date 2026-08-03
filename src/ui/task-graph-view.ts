import { ItemView, Menu, Notice, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { GraphRenderer, type GraphRendererOptions } from "./graph-renderer";
import { ContainerNode, GraphNode, ProjectNode, TaskNode } from "./graph-node";
import { layoutContainerLevel, settleContainerLevel } from "./graph-container-layout";
import {
  DependencyEdge, EdgeEnd, GraphEdge, IndirectDependencyEdge, resolveEdges, type EdgeSpec,
} from "./graph-edge";
import {
  DependencyKind, ExternalEnd, liftDependencies,
  type DependencyOrigin, type LiftedDependency,
} from "../model/project/dependency-graph";
import { gridColumns, layoutGrid, type LayoutSpacing } from "./graph-layout";
import { diffDays, formatDate } from "../model/dates";
import { isValidDependencyTarget, isValidMoveTarget } from "../model/project/task";
import { ancestorChain, buildChildMap, effectiveStatus, isCompletedWithOpenSubtasks, isEffectivelyClosed, isOpenUnderCompletedParent } from "../model/project/task-tree";
import { isTask, type Project } from "../model/project/project";
import { type Task } from "../model/project/task";
import { loadVaultData } from "../model/project/vault-reader";
import { activeProjects } from "../model/project/archive";
import { confirmAction, TaskModal, TaskModalMode, ProjectModal, addTaskDependency, removeTaskDependency, deleteTaskFile, patchTaskField, openDropdown, openNoteFile } from "./task-creator";
import { ConfirmStyle } from "./pm-modal";
import { applyTaskMove } from "./move-target-modal";
import { compareTitles, STATUS_COLORS, PRIORITY_COLORS, STATUS_LABELS, PRIORITY_LABELS, STATUSES, PRIORITIES, Priority, joinStatuses, isDoneStatus, toStatus } from "../model/base-task";
import { PatchableField } from "../model/project/project-task-file";
import { computeEffectiveValues, type EffectiveValues } from "../model/project/task-scoring";
import { priorityRibbonBackground, statusPillColors } from "./task-badges";
import { Icon } from "./icons";
import { openTaskContextMenu } from "./task-context-menu";
import { DASHBOARD_VIEW_TYPE } from "./dashboard-view";
import { OffscreenRefreshGate } from "./offscreen-refresh-gate";

export const TASK_GRAPH_VIEW_TYPE = "pm-compass-task-graph";

/** Spacing per graph: the drilled-in view has room the stacked project sections don't, and
 *  the project grid is a list rather than a drawing, so it sits tighter than either. */
const DRILL_SPACING: LayoutSpacing = { rankSep: 70, nodeSep: 50 };
const GRID_SPACING: LayoutSpacing = { rankSep: 24, nodeSep: 16 };
const DRILL_PADDING = 30;
const GRID_PADDING = 16;

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
  /** Project nodes only: the card carries an "Archived" pill. */
  archived?: boolean;
}

/** The whole-vault lookups every node card needs, built once per render — each costs a
 *  pass over the vault. */
interface VaultIndex {
  childMap: Map<string | undefined, Task[]>;
  byId: Map<string, Task>;
  effectiveValues: Map<string, EffectiveValues>;
}

/** A move a gesture has asked for, once it is known to be one the vault will take. */
interface PendingMove {
  task: Task;
  parent: Task | undefined;
  project: Project;
}

/** A stored dependency an end dragged onto another card would move, and where it would land.
 *  One end keeps what it named; the other takes the task the card dropped on stands for. */
interface RepointChoice {
  origin: DependencyOrigin;
  prerequisiteId: string;
  dependentId: string;
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
    panelConfig: { showActiveOnly: boolean; showArchived: boolean };
    nodePositions: Record<string, { x: number; y: number }>;
    confirmDeletes: boolean;
    confirmTaskMoves: boolean;
    confirmDependencyRemoval: boolean;
  };
  saveSettings(): Promise<void>;
}


/** What a task card stands for, which is what can be done to it. */
enum TaskCardKind {
  /** A task of the level being drawn: the card carries its id and its controls. */
  Own = "own",
  /** A task outside the level, at one end of a dependency reaching in or out. Drawn to
   *  show the link and nothing more, so it carries neither — the id belongs to the real
   *  card wherever that is drawn, and nothing on this one is ours to act on. */
  External = "external",
}

/** What marks a card as standing for a task outside the level being drawn. Presentation
 *  only: what makes such a card inert is that it holds nothing to act on — see
 *  `TaskCardKind`. */
const EXTERNAL_CARD_CLASS = "pm-node-card--external";

/** What marks the breadcrumb entry a dragged card would be moved to. Its own class rather
 *  than the cards': a dashed outline round a line of text reads as an accident. */
const BREADCRUMB_DROP_CLASS = "pm-breadcrumb-item--drop";

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

/** Where a task's card is drawn, which is what its dragged-to position belongs to: among
 *  its parent's children, or among its project's root tasks. */
function taskHome(task: Task): string {
  return task.parentId ?? `root:${task.projectId}`;
}

/** The id the card for a task outside this level takes. The task's own id belongs to its
 *  real card, drawn at whichever level that task lives on. */
function externalNodeId(taskId: string): string {
  return `${taskId}-ext`;
}

/** The id the frame round a level takes. Its own, for the same reason a dotted card's is:
 *  the project or task it stands for is not something this level draws a card of. */
function containerNodeId(id: string): string {
  return `container:${id}`;
}

/** A project's heading card. Only `label`, `color` and `projId` reach its template; the
 *  task fields sit empty so one record type covers every card. */
function projectNodeData(proj: Project): NodeData {
  return {
    id: `proj-${proj.id}`,
    label: proj.title,
    color: proj.color ?? "#888888",
    projId: proj.id,
    archived: proj.archived,
    status: "", ownStatus: "", priorityBackground: "", dueLabel: "",
    isOverdue: false, childCount: 0, warnSubtasks: false, warnParentDone: false,
  };
}

export class TaskGraphView extends ItemView {
  navigation = false;

  /** The one graph the panel holds, whichever level is being drawn. */
  private graph: GraphRenderer | null = null;
  private tasks: Task[] = [];
  private projects: Project[] = [];
  private drillPath: Array<Project | Task> = [];
  /** What each drawn edge stands for, keyed by `GraphEdge.id`. Rebuilt with the graph, and
   *  what the remove menu works from. */
  private readonly liftedEdges = new Map<string, LiftedDependency>();
  private showActiveOnly = true;
  private showArchived = false;
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
  /** How many project cards the grid was last laid out across. A resize that leaves this
   *  alone changes nothing about the drawing, so it is what a reflow is judged against. */
  private gridColumnCount = 0;
  private readonly refreshGate = new OffscreenRefreshGate(
    this,
    () => { void this.refresh(); },
    // A view laid out while it had no width fitted one column into nothing; coming back on
    // screen is the first chance it gets to count them properly.
    () => this.reflowGrid(),
  );


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
    this.showArchived = this.plugin.settings.panelConfig.showArchived;
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
      // Right-click on a task card → task-specific menu. A card that names no task of ours
      // — a dotted one — offers nothing rather than falling through to the menu for the
      // empty room below, which is about the level, not about the card pressed.
      const taskCard = (e.target as HTMLElement).closest<HTMLElement>(".pm-node-card");
      if (taskCard) {
        e.preventDefault();
        const task = this.tasks.find((t) => t.id === taskCard.dataset.taskId);
        if (task) this.openTaskContextMenu(e, task);
        return;
      }

      // Right-click on empty space → add task/subtask menu
      if (this.drillPath.length === 0) {
        // The grid of projects: the card right-clicked is what says which project. Empty
        // room between the cards belongs to no project, and offers nothing.
        const card = (e.target as HTMLElement).closest<HTMLElement>(".pm-node-project-card");
        const proj = this.projects.find((p) => p.id === card?.dataset.projId);
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
    this.destroyGraph();
  }

  private destroyGraph(): void {
    this.graph?.destroy();
    this.graph = null;
  }

  private isInProjectsFolder(filePath: string): boolean {
    return filePath.startsWith(this.plugin.settings.projectsFolder + "/");
  }

  /** Held while an edit that takes more than one write is in flight — see `writeTogether`. */
  private writing = false;

  private scheduleRefresh(): void {
    // What a half-written edit looks like is not worth drawing: the write that finishes it
    // refreshes on its own, and this would only get there first.
    if (this.writing) return;
    this.refreshGate.schedule(this.CHANGE_DEBOUNCE_MS);
  }

  /** Runs an edit made of several writes as one, then redraws. Each write wakes the vault's
   *  own change events, and a refresh landing between them would draw the halfway state —
   *  for a re-pointed dependency, the same link at both its old end and its new. */
  private async writeTogether(work: () => Promise<void>): Promise<void> {
    this.writing = true;
    try {
      await work();
    } catch (e) {
      // Some of it may already have landed, and the refresh below runs either way: what the
      // vault holds now is what the graph has to draw, finished or not.
      new Notice(`Change failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.writing = false;
    }
    await this.refresh();
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
      // An archived project is no destination to move a task into.
      projects: activeProjects(this.projects),
      allTasks: this.tasks,
      onRefresh: () => { void this.refresh(); },
      onDelete: (t, parentTask) => {
        void deleteTaskFile(this.app, t, parentTask, this.tasks).then(() => this.refresh());
      },
      confirmDelete: this.plugin.settings.confirmDeletes,
      extraItems: (menu, t) => this.addOutsideLinkItems(menu, t, e),
    });
  }

  /** The tasks a card here can be linked to across levels: the ones sitting beside the task
   *  the level belongs to. Nothing draws them on this level, so no gesture over the drawing
   *  can reach them — which is what this menu is for. A project's level has none: its own
   *  neighbours are other projects, and a dependency never crosses one. */
  private outsideCandidates(): Task[] {
    const level = this.drillPath[this.drillPath.length - 1];
    if (!level || !isTask(level)) return [];
    return this.tasks
      .filter((t) => t.projectId === level.projectId && t.parentId === level.parentId && t.id !== level.id)
      .sort((a, b) => compareTitles(a.title, b.title));
  }

  /** Two entries, one per direction: a dependency has two ends, and which one the task is at
   *  is the whole of what the choice means. Each opens the same list of neighbours, minus
   *  whatever that direction couldn't take. */
  private addOutsideLinkItems(menu: Menu, task: Task, evt: MouseEvent): void {
    const candidates = this.outsideCandidates();
    if (candidates.length === 0) return;
    // Each direction says the whole link — prerequisite first, dependent second — so what is
    // checked and what is written are the one expression.
    const directions = [
      { title: "Wait on a task outside…", link: (other: Task) => [other.id, task.id] as const },
      { title: "Block a task outside…", link: (other: Task) => [task.id, other.id] as const },
    ];
    for (const { title, link } of directions) {
      const offered = candidates.filter((other) => isValidDependencyTarget(this.tasks, ...link(other)).valid);
      if (offered.length === 0) continue;
      menu.addItem((item) =>
        item.setTitle(title).setIcon(Icon.AddDependency).onClick(() => {
          this.pickOutsideTask(offered, evt, (other) => void this.addDependency(...link(other)));
        })
      );
    }
  }

  /** The neighbours themselves, as a menu: a handful of names is a list, not a dialogue. */
  private pickOutsideTask(offered: Task[], evt: MouseEvent, chosen: (task: Task) => void): void {
    const menu = new Menu();
    for (const other of offered) {
      menu.addItem((item) =>
        item.setTitle(stripWikiLinks(other.title)).onClick(() => chosen(other))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** A checkbox in the gear panel. `apply` records the new state; what it changes is what
   *  is drawn, not what is loaded, so the redraw needs no vault read. */
  private gearToggle(label: string, checked: boolean, apply: (on: boolean) => void): void {
    const row = this.settingsPanelEl!.createEl("label", { cls: "pm-compass-toggle" });
    const checkbox = row.createEl("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    row.createSpan({ text: label });
    checkbox.addEventListener("change", () => {
      apply(checkbox.checked);
      void this.plugin.saveSettings();
      this.renderGraph();
    });
  }

  private buildGear(bar: HTMLElement): void {
    const gearBtn = bar.createEl("button", { cls: "pm-compass-gear-btn" });
    setIcon(gearBtn, Icon.Settings);
    gearBtn.setAttribute("aria-label", "Graph settings");

    this.settingsPanelEl = bar.createDiv({ cls: "pm-compass-settings-panel" });
    this.settingsPanelEl.setCssStyles({ display: "none" });
    this.settingsPanelEl.createDiv({ cls: "pm-compass-settings-heading", text: "Display" });

    this.gearToggle("Active only", this.showActiveOnly, (on) => {
      this.showActiveOnly = on;
      this.plugin.settings.panelConfig.showActiveOnly = on;
    });
    this.gearToggle("Show archived", this.showArchived, (on) => {
      this.showArchived = on;
      this.plugin.settings.panelConfig.showArchived = on;
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

    // The level being looked at is left off: the frame in the drawing names it, and it is
    // the one entry the trail could never take a click or a drop for anyway.
    for (let i = 0; i < this.drillPath.length - 1; i++) {
      this.breadcrumbEl.createSpan({ cls: "pm-breadcrumb-sep", text: "›" });

      const item = this.breadcrumbEl.createSpan({
        cls: "pm-breadcrumb-item",
        text: this.drillPath[i].title,
        // What a card dropped here is moved to. "All" carries none: it names no
        // destination, so it is never a candidate rather than one to be refused.
        attr: { "data-drill-index": String(i) },
      });

      const targetLen = i + 1;
      item.addEventListener("click", () => {
        this.drillPath = this.drillPath.slice(0, targetLen);
        this.renderGraph();
      });
    }
  }

  private async refresh(): Promise<void> {
    const data = await loadVaultData(this.app, this.plugin.settings.projectsFolder);
    this.forgetMovedPositions(data.tasks);
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
    const sourceCard = this.graphContainer.querySelector<HTMLElement>(
      `.pm-node-card[data-task-id="${CSS.escape(sourceId)}"]`,
    );
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
      // A card naming no task of ours never lights up. A dotted card carries no id, being
      // inert everywhere, and the frame stands for the very task these cards sit under, so
      // neither is somewhere a link can be started against: carrying the end of a drawn
      // line is what reaches those.
      const card = el?.closest<HTMLElement>(".pm-node-card") ?? null;
      const cardId = card?.dataset.taskId ?? null;
      if (card !== currentTargetCard) {
        currentTargetCard?.classList.remove("pm-connect-target");
        currentTargetCard = cardId && cardId !== sourceId ? card : null;
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

  /** The move landing `taskId` in `into` — under it when that is a task, at the root of it
   *  when it is a project. Null when it means nothing: an id naming no task, or a
   *  destination `isValidMoveTarget` refuses — the task's own subtree, or where it sits. */
  private moveDestination(taskId: string, into: Task | Project): PendingMove | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const parent = isTask(into) ? into : undefined;
    const project = this.projects.find((p) => p.id === (parent ? parent.projectId : into.id));
    if (!project) return null;
    const check = isValidMoveTarget(this.tasks, task.id, {
      projectId: project.id,
      parentTaskId: parent?.id,
    });
    return check.valid ? { task, parent, project } : null;
  }

  /** The move a card dropped on another would make: under the task it landed on. Null when
   *  the drop means nothing — either card standing for something other than a task of this
   *  level, or a destination `moveDestination` refuses. */
  private dropMove(dragged: GraphNode, target: GraphNode): PendingMove | null {
    if (!(dragged instanceof TaskNode) || !(target instanceof TaskNode)) return null;
    // A dotted card is drawn where the level meets that task, not where it lives: neither
    // end of a move belongs to it.
    if (dragged.isExternal || target.isExternal) return null;
    const anchor = this.tasks.find((t) => t.id === target.taskId);
    return anchor ? this.moveDestination(dragged.taskId, anchor) : null;
  }

  /** What a drop gesture hands the renderer: a target counts when `move` reads one out of
   *  it, and landing on it makes that move. Both gestures are the same pair over a
   *  different sort of target, so what a drop commits is written once. */
  private dropOn<T>(move: (dragged: GraphNode, target: T) => PendingMove | null) {
    return {
      canDrop: (dragged: GraphNode, target: T) => move(dragged, target) !== null,
      onDrop: (dragged: GraphNode, target: T) => {
        const pending = move(dragged, target);
        if (pending) this.confirmMove(pending);
      },
    };
  }

  /** A drop asks before it writes, `confirmTaskMoves` allowing: the gesture is a couple of
   *  centimetres of travel, and what it commits relocates files. */
  private confirmMove(move: PendingMove): void {
    const { task, parent, project } = move;
    const destination = parent ? `under "${parent.title}"` : `to the root of "${project.title}"`;
    confirmAction(
      this.app,
      this.plugin.settings.confirmTaskMoves,
      `Move "${task.title}" ${destination}?`,
      () => applyTaskMove(
        this.app,
        task,
        {
          projectId: project.id,
          projectFilePath: project.filePath,
          projectTitle: project.title,
          parentTask: parent,
        },
        this.tasks,
        this.projects,
        () => { void this.refresh(); },
      ),
      { label: "Move", style: ConfirmStyle.Cta },
    );
  }

  /** The move a card dropped on a breadcrumb entry would make: under that task, or, for the
   *  project the trail starts at, to its root. This is how a task comes back *out* of where
   *  it sits — the one direction covering another card can't express. Null when the entry
   *  names nothing, or when the task is already there, which is what the entry for the level
   *  being looked at always is. */
  private breadcrumbMove(dragged: GraphNode, entry: HTMLElement): PendingMove | null {
    if (!(dragged instanceof TaskNode) || dragged.isExternal) return null;
    const step = this.drillPath[Number(entry.dataset.drillIndex)];
    return step ? this.moveDestination(dragged.taskId, step) : null;
  }

  /** The task a card at the end of a line stands for: an own or dotted card's, or the
   *  level's own for the frame. A project's frame names none — a project holds no
   *  dependencies. */
  private endTaskId(node: GraphNode): string | undefined {
    return node instanceof ContainerNode || node instanceof TaskNode ? node.taskId : undefined;
  }

  /** What moving one end of `edge` onto `target` would store, one entry per stored link the
   *  line stands for — a solid line stands for one, a dashed one for as many as lift onto
   *  it. A link the move would leave invalid is left out, so a line only takes an end its
   *  dependency can actually follow. */
  private repointChoices(edge: GraphEdge, end: EdgeEnd, target: GraphNode): RepointChoice[] {
    const landed = this.endTaskId(target);
    if (!landed) return [];
    const origins = this.liftedEdges.get(edge.id)?.origins ?? [];
    return origins
      .map((origin) => ({
        origin,
        prerequisiteId: end === EdgeEnd.Source ? landed : origin.prerequisiteId,
        dependentId: end === EdgeEnd.Target ? landed : origin.dependentId,
      }))
      .filter((c) => isValidDependencyTarget(this.tasks, c.prerequisiteId, c.dependentId).valid);
  }

  /** A line whose end has been dropped on a card: the one link it stands for follows at
   *  once, and a line standing for several asks which of them is meant. */
  private repoint(edge: GraphEdge, end: EdgeEnd, target: GraphNode, evt: PointerEvent): void {
    const choices = this.repointChoices(edge, end, target);
    if (choices.length === 0) return;
    if (choices.length === 1) {
      void this.applyRepoint(choices[0]);
      return;
    }
    const menu = new Menu();
    for (const choice of choices) {
      const { prerequisiteId, dependentId } = choice.origin;
      menu.addItem((item) =>
        item
          .setTitle(`Move: "${this.taskTitle(prerequisiteId)}" → "${this.taskTitle(dependentId)}"`)
          .setIcon(Icon.AddDependency)
          .onClick(() => { void this.applyRepoint(choice); })
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** Writes a re-pointed dependency: the new link first, the old one second. When the
   *  waiting end has moved these are two files, and a failure between them leaves the link
   *  where it was rather than losing it; when it hasn't, they are one file read and
   *  rewritten twice, which run together would clobber the first write. The pair is written
   *  as one, or the graph would redraw between them with the link at both its ends. */
  private async applyRepoint(choice: RepointChoice): Promise<void> {
    const gaining = this.tasks.find((t) => t.id === choice.dependentId);
    const losing = this.tasks.find((t) => t.id === choice.origin.dependentId);
    if (!gaining || !losing) return;
    await this.writeTogether(async () => {
      await addTaskDependency(this.app, gaining, choice.prerequisiteId);
      await removeTaskDependency(this.app, losing, choice.origin.prerequisiteId);
    });
  }

  /** What a right-click on an edge offers: the one dependency a solid line is, or, for a
   *  dotted one, each stored dependency it stands for, named by its two tasks. */
  private showRemoveDependencyMenu(edge: GraphEdge, evt: MouseEvent): void {
    const lifted = this.liftedEdges.get(edge.id);
    const origins = lifted?.origins ?? [];
    // A solid line is the one dependency it is, whichever card carries its prerequisite:
    // an external card names that task already, so its menu needn't spell the pair out.
    const isDirect = lifted?.kind === DependencyKind.Direct;

    const menu = new Menu();
    for (const origin of origins) {
      const title = isDirect
        ? "Remove dependency"
        : `Remove: "${this.taskTitle(origin.prerequisiteId)}" → "${this.taskTitle(origin.dependentId)}"`;
      menu.addItem(item =>
        item.setTitle(title).setIcon(Icon.RemoveDependency)
          .onClick(() => this.removeDependency(origin.prerequisiteId, origin.dependentId, isDirect))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private taskTitle(taskId: string): string {
    return this.tasks.find(t => t.id === taskId)?.title ?? taskId;
  }

  /** Asks, `confirmDependencyRemoval` allowing, then calls removeTaskDependency and
   *  refreshes. The question names both ends where the menu entry that opened it did —
   *  a dotted line stands for several links, so one end wouldn't tell them apart. */
  private removeDependency(sourceId: string, targetId: string, isDirect: boolean): void {
    const target = this.tasks.find(t => t.id === targetId);
    if (!target) return;
    confirmAction(
      this.app,
      this.plugin.settings.confirmDependencyRemoval,
      isDirect
        ? `Remove the dependency on "${this.taskTitle(sourceId)}"?`
        : `Remove the dependency of "${target.title}" on "${this.taskTitle(sourceId)}"?`,
      () => {
        void removeTaskDependency(this.app, target, sourceId).then(() => this.refresh());
      },
      { label: "Remove", style: ConfirmStyle.Warning },
    );
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
    const card = this.graphContainer.querySelector<HTMLElement>(
      `.pm-node-card[data-task-id="${CSS.escape(taskId)}"]`,
    );
    if (card) card.classList.add("pm-node-card--selected");
  }

  private saveNodePosition(nodeId: string, pos: { x: number; y: number }): void {
    this.plugin.settings.nodePositions[nodeId] = { x: pos.x, y: pos.y };
    void this.plugin.saveSettings();
  }

  /** Navigates to a task, shown as a card in its parent task's or project's context. */
  async openTask(projectId: string, taskId: string): Promise<void> {
    const data = await loadVaultData(this.app, this.plugin.settings.projectsFolder);
    this.forgetMovedPositions(data.tasks);
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

  /**
   * Drops the stored position of every task that has moved since the last read. A position
   * is where a card was dragged to *among its siblings*; a task that has changed parent is
   * drawn in another graph entirely, where that place means nothing — and where it would
   * strand the card on top of whatever the layout put there. The layout gives it a slot in
   * its new home instead.
   *
   * A move made anywhere lands here, this being a fact about the vault rather than about
   * the gesture that changed it.
   */
  private forgetMovedPositions(next: Task[]): void {
    // `this.tasks` is still the previous read, which is the only record of where these
    // tasks were — nothing in the vault says what has just changed.
    const before = new Map(this.tasks.map((t) => [t.id, taskHome(t)]));
    const positions = this.plugin.settings.nodePositions;
    let changed = false;
    for (const task of next) {
      const previous = before.get(task.id);
      // Unknown before now — the first read, or a task just created: found, not moved.
      if (previous === undefined || previous === taskHome(task)) continue;
      // Both the card the task is drawn on and the dotted one standing for it elsewhere:
      // a move redraws it in another graph, where either place would strand it.
      for (const id of [task.id, externalNodeId(task.id)]) {
        if (!(id in positions)) continue;
        delete positions[id];
        changed = true;
      }
    }
    if (changed) void this.plugin.saveSettings();
  }

  private pruneStalePositions(): void {
    const validIds = new Set<string>();
    // A task's own card and the dotted one standing for it beyond its level, both of which
    // a drag can place. A project card is placed by the grid, which reflows with the panel,
    // and a frame is sized rather than placed, so a position saved against either by an
    // earlier build is stale by definition.
    for (const t of this.tasks) validIds.add(t.id).add(externalNodeId(t.id));
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
    // Drilled into a project the archived toggle has just put away: back to the grid,
    // before the breadcrumb goes on naming a project the toggle says is not shown.
    const root = this.drillPath[0];
    if (root && !isTask(root) && root.archived && !this.showArchived) this.drillPath = [];
    this.updateBreadcrumb();
    this.destroyGraph();
    this.liftedEdges.clear();
    this.graphContainer.empty();
    // `minWidth` too: a level of tasks fixes it on this very container, and left behind it
    // would floor the width the next render asks for — and the grid is measured against it.
    this.graphContainer.setCssStyles({ width: "", height: "", minWidth: "" });

    this.renderGraphContent();

    // Consumed once the whole render is up, so the card is there to be found.
    if (this.pendingSelectTaskId) {
      const id = this.pendingSelectTaskId;
      this.pendingSelectTaskId = null;
      this.selectGraphNode(id);
    }
  }

  /** How many project cards the panel holds across, as it stands. Zero when it has no
   *  width at all: laid out off screen, the grid would file into one column and stay there,
   *  so there is no answer to give yet. */
  private gridColumns(): number {
    const width = this.graphContainer.clientWidth;
    return width === 0 ? 0 : gridColumns(width, GRID_SPACING, GRID_PADDING);
  }

  /** The room the grid takes: height only, since it is cut to the panel's width and so
   *  never asks for more. Applied on the first render and on every reflow alike. */
  private applyGridSize(size: { height: number }): void {
    this.graphContainer.style.height = `${size.height}px`;
  }

  /**
   * Lays the project grid out again when the panel's width has come to hold a different
   * number of cards across. Only then: Obsidian reports a resize per frame while a divider
   * is dragged, and anything the width doesn't decide — every level below the top, where
   * the cards are placed by what they depend on — is drawn the same whatever the room.
   *
   * A reflow moves the cards it already drew; it reads no vault and builds no DOM.
   */
  onResize(): void {
    this.reflowGrid();
  }

  private reflowGrid(): void {
    if (this.drillPath.length !== 0 || !this.graph || !this.graphContainer) return;
    // A panel with no width holds no answer. Coming back on screen asks again.
    const columns = this.gridColumns();
    if (columns === 0 || columns === this.gridColumnCount) return;
    this.gridColumnCount = columns;
    this.graph.relayout();
    this.applyGridSize(this.graph.fit(GRID_PADDING));
  }

  private renderGraphContent(): void {
    if (this.drillPath.length === 0) {
      this.renderProjectGrid();
      return;
    }

    this.graph = this.createGraph({
      elements: this.buildElements(),
      spacing: DRILL_SPACING,
      padding: DRILL_PADDING,
      layout: layoutContainerLevel,
      settle: settleContainerLevel,
      onDrillTask: (task) => { this.drillPath.push(task); this.renderGraph(); },
      // No width of its own: the panel is what the graph is drawn across, and `minWidth`
      // is what lets a wide one scroll sideways rather than being squeezed.
      applySize: (size) => {
        this.graphContainer.style.height = `${size.height}px`;
        this.graphContainer.style.minWidth = `${size.width}px`;
      },
    });
  }

  /**
   * Builds the panel's graph and wires it up. Every level lands here; they differ in
   * spacing, in where the cards go, in what a tap opens, and in how much of the room they
   * take is theirs to fix.
   */
  private createGraph(opts: {
    elements: GraphElements;
    spacing: LayoutSpacing;
    padding: number;
    /** Only a level of tasks has anything to drill into. */
    onDrillTask?: (task: Task) => void;
    onDrillProject?: (project: Project) => void;
    applySize: (size: { width: number; height: number }) => void;
    /** Where the cards go, `layoutGraph` unless the level says otherwise. */
    layout?: GraphRendererOptions["layout"];
    /** What is sized off where the cards ended up — the frame round a level of tasks. */
    settle?: GraphRendererOptions["settle"];
  }): GraphRenderer {
    const nodes = opts.elements.nodes;

    const graph: GraphRenderer = new GraphRenderer({
      container: this.graphContainer,
      nodes,
      edges: resolveEdges(nodes, opts.elements.edges),
      spacing: opts.spacing,
      layout: opts.layout,
      settle: opts.settle,
      storedPositions: this.plugin.settings.nodePositions,
      onNodeTap: (node, evt, origin) => this.handleNodeTap(node, evt, origin, opts.onDrillProject),
      onNodeDoubleTap: (node, _evt, origin) => {
        if (!(node instanceof TaskNode) || node.isExternal) return;
        if (origin?.closest?.(".pm-node-edit-btn")) return;
        const task = this.tasks.find((t) => t.id === node.taskId);
        if (task) opts.onDrillTask?.(task);
      },
      onEdgeContextMenu: (edge, evt) => this.showRemoveDependencyMenu(edge, evt),
      // Carrying an end of a line to another card is how a dependency reaching outside the
      // level is made: the cards it can be dropped on are the ones drawn, whichever level
      // the tasks behind them live on.
      edgeRepoint: {
        canDrop: (edge, end, target) => this.repointChoices(edge, end, target).length > 0,
        onDrop: (edge, end, target, evt) => this.repoint(edge, end, target, evt),
      },
      nodeDrop: this.dropOn((dragged, target: GraphNode) => this.dropMove(dragged, target)),
      // The trail above the graph names every level a task can be moved up into, so it is
      // what a card is dropped on to get there. Asked for afresh each gesture: a render
      // builds the entries again.
      outsideDrop: {
        targets: () => [...this.breadcrumbEl.querySelectorAll<HTMLElement>("[data-drill-index]")],
        markClass: BREADCRUMB_DROP_CLASS,
        ...this.dropOn((dragged, entry: HTMLElement) => this.breadcrumbMove(dragged, entry)),
      },
      onNodeDragEnd: (node, pos) => {
        this.saveNodePosition(node.id, pos);
        opts.applySize(graph.fit(opts.padding));
      },
    });

    opts.applySize(graph.fit(opts.padding));
    return graph;
  }

  private projectNode(proj: Project): ProjectNode {
    const data = projectNodeData(proj);
    return new ProjectNode({ id: data.id, projectId: proj.id, card: this.projectNodeCard(data) });
  }

  private taskNode(data: NodeData): TaskNode {
    return new TaskNode({ id: data.id, card: this.taskNodeCard(data) });
  }

  /** The frame round the level: the project or task its cards belong to, drawn as the box
   *  they sit in. It names that entry so an edge reaching the level from outside has
   *  something to point at, which the breadcrumb — being outside the drawing — cannot be. */
  private containerNode(entry: Project | Task, holds: number): ContainerNode {
    const taskId = isTask(entry) ? entry.id : undefined;
    const card = createDiv({ cls: "pm-graph-container" });
    // No `data-task-id`: every path to a task goes through a card carrying it, and the frame
    // is not one — what it stands for is read off the node, which `endTaskId` is.
    card.createDiv({ cls: "pm-graph-container-header", text: stripWikiLinks(entry.title) });
    // Said inside the frame rather than in place of the drawing: an empty box still names
    // where the trail has come to, which nothing else on screen does any more.
    if (holds === 0) card.createDiv({ cls: "pm-graph-container-empty", text: "No tasks here." });
    return new ContainerNode({ id: containerNodeId(entry.id), taskId, card });
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
    onDrillProject?: (project: Project) => void,
  ): void {
    if (node instanceof ProjectNode) {
      // What the card stands for comes from the node either way; the markup only says
      // which part of it was pressed.
      const proj = this.projects.find((p) => p.id === node.projectId);
      if (!proj) return;
      if (!tapTarget?.closest(".pm-node-edit-btn")) {
        onDrillProject?.(proj);
        return;
      }
      if (evt.ctrlKey) {
        openNoteFile(this.app, proj.filePath);
        return;
      }
      new ProjectModal(this.app, { project: proj, onSuccess: () => { void this.refresh(); } }).open();
      return;
    }

    // A card the level doesn't own selects nothing: what a selection points at is the card
    // the task really lives on, which is drawn at another level entirely.
    if (!(node instanceof TaskNode) || node.isExternal) return;
    if (tapTarget?.closest(".pm-node-connect-btn")) return;

    if (!tapTarget?.closest(".pm-node-edit-btn")) {
      this.selectGraphNode(node.taskId);
      this.signalDashboard(node.taskId);
      return;
    }
    const task = this.tasks.find((t) => t.id === node.taskId);
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

  /**
   * The top of the trail: every project, and nothing else. A project's tasks are one drill
   * away and named by the card, so the level is a plain list — and a list with no order of
   * its own, which is why it wraps to the room rather than filing down one column.
   */
  private renderProjectGrid(): void {
    if (this.projects.length === 0) {
      this.graphContainer.createEl("p", { text: "No projects found.", cls: "pm-compass-empty" });
      return;
    }
    const shown = this.showArchived ? this.projects : activeProjects(this.projects);
    if (shown.length === 0) {
      this.graphContainer.createEl("p", {
        text: "Every project is archived. The gear's archived toggle brings them back.",
        cls: "pm-compass-empty",
      });
      return;
    }

    // By title: reading order is the only order these cards have, and the vault hands them
    // over in whatever order it read the folder.
    const ordered = [...shown].sort((a, b) => compareTitles(a.title, b.title));

    // Counted here and by `reflowGrid`, the two places that decide the grid is to be laid
    // out; the layout itself only places the cards across however many that leaves. A panel
    // with no width yet counts none, and one column is still what has to be drawn.
    this.gridColumnCount = this.gridColumns();

    this.graph = this.createGraph({
      elements: { nodes: ordered.map((p) => this.projectNode(p)), edges: [] },
      spacing: GRID_SPACING,
      padding: GRID_PADDING,
      layout: (nodes, _edges, spacing) => layoutGrid(nodes, spacing, Math.max(1, this.gridColumnCount)),
      onDrillProject: (proj) => { this.drillPath = [proj]; this.renderGraph(); },
      applySize: (size) => this.applyGridSize(size),
    });
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
   * an HTML card. Rolled up over the whole vault, since a card's ribbon must answer for the
   * subtree this level doesn't draw. Its own level stands in where the roll-ups are missing,
   * the cache being able to drop it transiently.
   */
  private ribbonBackground(task: Task, effectiveValues: Map<string, EffectiveValues>): string {
    const rollup = (id: string) => effectiveValues.get(id);
    return priorityRibbonBackground(
      task.priorityFromAbove(rollup) ?? undefined,
      task.priorityFromBelow(rollup) ?? undefined,
    );
  }

  /** One task's card. An external one is the same card drawn inert: the task's id is what
   *  every gesture reaches a task through — the menu, the pickers, the connect drag — so a
   *  card that carries none can be pressed anywhere and asks nothing of the vault. */
  private taskNodeCard(data: NodeData, kind = TaskCardKind.Own): HTMLElement {
    const own = kind === TaskCardKind.Own;
    // Empty on an external card, so nothing it holds carries the attribute at all.
    const idAttr: Record<string, string> = own ? { "data-task-id": data.taskId ?? data.id } : {};
    const card = createDiv({ cls: "pm-node-card", attr: idAttr });
    if (!own) card.classList.add(EXTERNAL_CARD_CLASS);

    card.createDiv({ cls: "pm-node-ribbon", attr: idAttr })
      .setCssStyles({ background: data.priorityBackground || "transparent" });

    const body = card.createDiv({ cls: "pm-node-body" });
    body.createDiv({ cls: "pm-node-title", text: stripWikiLinks(data.label) });

    const meta = body.createDiv({ cls: "pm-node-meta" });
    const pill = statusPillColors(data.status);
    meta.createSpan({
      cls: "pm-node-status",
      text: joinStatuses(data.ownStatus, data.status),
      attr: idAttr,
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

    if (own) {
      const row = card.createDiv({ cls: "pm-node-actions" });
      cardButton(row, "pm-node-edit-btn", Icon.EditTask, "Edit task", idAttr);
      cardButton(row, "pm-node-connect-btn", Icon.AddDependency, "Add dependency", idAttr);
    }
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
    if (data.archived) {
      card.classList.add("pm-node-project-card--archived");
      card.createSpan({ cls: "pm-node-project-archived", text: "Archived" });
    }
    cardButton(card, "pm-node-edit-btn pm-node-project-edit-btn", Icon.EditTask, "Edit project", { "data-proj-id": projId });
    return card;
  }

  /** One task's card, as the templates read it. Every card the graph draws is this one,
   *  the level's own and the dotted ones standing for tasks outside it alike. */
  private taskNodeData(t: Task, index: VaultIndex, today: Date): NodeData {
    const { childMap, byId, effectiveValues } = index;
    const status = effectiveStatus(t, byId);
    return {
      id: t.id,
      taskId: t.id,
      label: t.title,
      status,
      ownStatus: t.status,
      priorityBackground: this.ribbonBackground(t, effectiveValues),
      dueLabel: t.due ? formatDate(t.due) : "",
      isOverdue: !!t.due && diffDays(today, t.due) < 0 && !isDoneStatus(status),
      childCount: childMap.get(t.id)?.length ?? 0,
      warnSubtasks: isCompletedWithOpenSubtasks(t, childMap, byId),
      warnParentDone: isOpenUnderCompletedParent(t, byId),
      color: "",
    };
  }

  /** The dependency edges `tasks` can show, and a card for each task from outside them at
   *  either end of one. Read from the whole vault, not from `tasks`: a dependency held by a
   *  task further down is drawn here against the cards standing for its ends, dotted, and
   *  one reaching outside brings that task in as a card of its own. `hidden` are the level's
   *  own cards a filter is holding back, so a filter hides a task rather than standing it
   *  back up as an outsider. Each lifted edge is kept for the menu that removes what it
   *  stands for. */
  private dependencyLinks(
    tasks: Task[],
    hidden: Task[],
    index: VaultIndex,
    today: Date,
    enclosingId?: string,
  ): GraphElements {
    const external = new Map<string, GraphNode>();
    const edges: EdgeSpec[] = [];
    const lifted = liftDependencies(this.tasks, tasks.map((t) => t.id), hidden.map((t) => t.id), enclosingId);
    for (const dep of lifted) {
      const kind = dep.kind === DependencyKind.Direct ? DependencyEdge : IndirectDependencyEdge;
      let { sourceId, targetId } = dep;
      // An end lifted onto the level itself belongs to the frame, which is drawn as a card
      // of its own — the level's own task holds no card among its children.
      if (sourceId === enclosingId) sourceId = containerNodeId(sourceId);
      if (targetId === enclosingId) targetId = containerNodeId(targetId);
      if (dep.external !== ExternalEnd.None) {
        const prerequisite = dep.external === ExternalEnd.Prerequisite;
        const outsideId = prerequisite ? sourceId : targetId;
        const nodeId = externalNodeId(outsideId);
        if (!external.has(nodeId)) {
          const task = index.byId.get(outsideId);
          if (!task) continue;
          external.set(nodeId, this.externalNode(task, index, today));
        }
        if (prerequisite) sourceId = nodeId;
        else targetId = nodeId;
      }
      edges.push({ source: sourceId, target: targetId, kind });
      this.liftedEdges.set(`${sourceId}->${targetId}`, dep);
    }
    return { nodes: [...external.values()], edges };
  }

  /** The card for a task outside this level: the same card, dotted, stripped of its action
   *  buttons and inert — it stands for what the level depends on or what depends on it,
   *  not for anything it holds, and nothing on it is there to be acted on. One
   *  card whichever way the arrows run, so a task the level both waits on and is waited on
   *  by reads as the one link it is. Given last, so the level's own cards are laid down
   *  first and what surrounds them settles around those. */
  private externalNode(task: Task, index: VaultIndex, today: Date): TaskNode {
    const card = this.taskNodeCard(this.taskNodeData(task, index, today), TaskCardKind.External);
    return new TaskNode({ id: externalNodeId(task.id), taskId: task.id, isExternal: true, card });
  }

  /**
   * One level's cards: the frame standing for the project or task the level belongs to, the
   * tasks it holds drawn inside it, and a dotted card outside it for each task at the far end
   * of a dependency. What the level *is* comes from the trail — a project's root tasks one
   * step in, a task's children further down.
   *
   * The frame comes first: the cards are absolutely positioned, so the order they are drawn
   * in is what puts the box under what it holds.
   */
  private buildElements(): GraphElements {
    const today = new Date();
    const index = this.buildVaultIndex();
    const { byId } = index;

    const last = this.drillPath[this.drillPath.length - 1];
    const own = isTask(last)
      ? this.tasks.filter((t) => t.parentId === last.id)
      : this.tasks.filter((t) => t.projectId === last.id && !t.parentId);

    // Partitioned in one pass: the filter walks each task's ancestors, and the cards it
    // holds back are what `dependencyLinks` must not stand back up as outsiders.
    const shows = (t: Task) => !this.showActiveOnly || !isEffectivelyClosed(t, byId);
    const tasks: Task[] = [];
    const hidden: Task[] = [];
    for (const t of own) (shows(t) ? tasks : hidden).push(t);

    const links = this.dependencyLinks(tasks, hidden, index, today, isTask(last) ? last.id : undefined);
    return {
      nodes: [
        this.containerNode(last, tasks.length),
        ...tasks.map((t) => this.taskNode(this.taskNodeData(t, index, today))),
        ...links.nodes,
      ],
      edges: links.edges,
    };
  }
}
