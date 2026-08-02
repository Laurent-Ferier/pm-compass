import { App, Component, Modal, Notice, setIcon } from "obsidian";
import { Icon } from "./icons";
import { renderTaskTitle } from "./day-task-row";
import {
  isValidMoveTarget, MoveChoiceKind, type MoveChoice, type Task,
} from "../model/project/task";
import type { Project } from "../model/project/project";
import { ancestorChain, buildChildMap, effectiveStatus } from "../model/project/task-tree";
import { isDoneStatus, Status, joinStatuses, statusLabel, toStatus } from "../model/base-task";
import { moveTask, type MoveDestination } from "../model/project/task-move";
import { renderPriorityRibbon, renderStatusPill } from "./task-badges";

export type { MoveChoice };

export interface MoveTargetModalOptions {
  heading: string;
  /** Label for the confirm button, e.g. "Move" or "Promote". */
  ctaLabel: string;
  projects: Project[];
  /** Full flat task list; each project's subtree is derived from it. */
  tasks: Task[];
  allowNewProject?: boolean;
  /** Task whose current home the tree opens onto, so the picker starts where the user
   *  is looking rather than at a wall of collapsed projects. */
  revealTaskId?: string;
  /** Return a reason to disable a destination, or undefined to allow it. */
  isDisabled?: (choice: MoveChoice) => string | undefined;
  onChoose: (choice: MoveChoice) => void;
}

const NEW_PROJECT_ROW = "__new__";

// Expansion keys are namespaced so a project and a task can't collide on id.
const projectKey = (id: string) => `p:${id}`;
const taskKey = (id: string) => `t:${id}`;

/** Opens the picker for an existing task and performs the move. Lives here rather than
 *  on BaseTabView, which the graph view's context menu can't import without a cycle. */
export function openMoveTaskModal(
  app: App,
  task: Task,
  projects: Project[],
  allTasks: Task[],
  onDone: () => void,
): void {
  new MoveTargetModal(app, {
    heading: `Move "${task.title}"`,
    ctaLabel: "Move",
    projects,
    tasks: allTasks,
    // Moving into a project that doesn't exist yet isn't a thing.
    allowNewProject: false,
    revealTaskId: task.id,
    isDisabled: (choice) => {
      if (choice.kind !== MoveChoiceKind.Existing) return undefined;
      const check = isValidMoveTarget(allTasks, task.id, {
        projectId: choice.projectId,
        parentTaskId: choice.parentTask?.id,
      });
      return check.valid ? undefined : check.reason;
    },
    onChoose: (choice) => {
      if (choice.kind !== MoveChoiceKind.Existing) return;
      applyTaskMove(app, task, {
        projectId: choice.projectId,
        projectFilePath: choice.projectFilePath,
        projectTitle: choice.projectTitle,
        parentTask: choice.parentTask,
      }, allTasks, projects, onDone);
    },
  }).open();
}

/** Performs the move and says how it went, whichever gesture asked for it — the picker
 *  above, or a card dropped on another in the graph. */
export function applyTaskMove(
  app: App,
  task: Task,
  destination: MoveDestination,
  allTasks: Task[],
  projects: Project[],
  onDone: () => void,
): void {
  moveTask(app, task, destination, allTasks, projects)
    .then(() => {
      new Notice(`Moved "${task.title}"`);
      onDone();
    })
    .catch((e) => {
      console.error("pm-compass: move failed", e);
      new Notice(`Move failed: ${e instanceof Error ? e.message : String(e)}`);
    });
}

/**
 * Picks where a task should land, as one tree: projects at the top level, each
 * expanding into its tasks. A project row means its root, a task row means under
 * that task. The promote and move flows differ only in what destinations are legal.
 */
export class MoveTargetModal extends Modal {
  private readonly opts: MoveTargetModalOptions;
  private selectedProject: Project | null = null;
  private selectedParent: Task | undefined;
  /** Set once the user commits to creating a project rather than picking one. */
  private newProjectTitle: string | null = null;
  /** One-shot: focus the project-name input on the render that follows activation. */
  private focusNewProjectInput = false;
  /** id→task over `opts.tasks`, which doesn't change while the modal is open. */
  private taskByIdCache?: Map<string, Task>;
  /** Hides done/cancelled tasks, rarely what a task is moved under. Projects are never
   *  hidden — their roots stay legal destinations whatever their tasks look like. */
  private hideCompleted = true;
  /**
   * Keys (see projectKey/taskKey) whose children are on show; every branch starts
   * collapsed. Purely visual — only a chevron writes here, and a selection survives
   * its row going off screen (see selectionMarkerKey).
   */
  private readonly expanded = new Set<string>();
  /** Owns the lifecycle of the markdown in task titles; a Modal isn't a Component, so
   *  this one keeps its own. Replaced per render pass and unloaded on close. */
  private renderHost = new Component();

  private projectList!: HTMLElement;
  private ctaBtn!: HTMLButtonElement;
  private hideBtn!: HTMLButtonElement;

  constructor(app: App, opts: MoveTargetModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("pm-move-target-modal");

    // Obsidian's close button duplicates Cancel and crowds the toggle out of the corner
    // on mobile. `parentElement` is the `.modal` wrapper, absent under the test mock.
    contentEl.parentElement?.querySelector(".modal-close-button")?.remove();

    // The heading shares its row with the toggle, taking the slack via flex.
    const header = contentEl.createDiv({ cls: "pm-mt-header" });
    header.createEl("h3", { text: this.opts.heading, cls: "pm-mt-heading" });
    this.hideBtn = header.createEl("button", { cls: "clickable-icon pm-mt-hide-completed" });
    this.hideBtn.addEventListener("click", () => this.toggleHideCompleted());
    this.syncHideBtn();

    this.projectList = contentEl.createDiv({ cls: "pm-mt-projects" });

    const btnRow = contentEl.createDiv({ cls: "pm-mt-buttons" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    this.ctaBtn = btnRow.createEl("button", { text: this.opts.ctaLabel, cls: "mod-cta" });
    this.ctaBtn.addEventListener("click", () => this.commit());

    this.revealCurrentHome();
    this.renderTree();
    this.scrollRevealedIntoView();
    this.syncCta();
  }

  onClose(): void {
    this.renderHost.unload();
    this.contentEl.empty();
  }

  /** Opens the branches leading to the reveal target, so the tree starts showing where
   *  the task lives today. Its own branch stays shut: the destination is elsewhere. */
  private revealCurrentHome(): void {
    const task = this.opts.revealTaskId ? this.byId().get(this.opts.revealTaskId) : undefined;
    if (!task) return;
    // A completed target the filter would cull can't be shown at all, so let it through.
    if (!this.visibleTaskIds().has(task.id)) {
      this.hideCompleted = false;
      this.syncHideBtn();
    }
    this.expanded.add(projectKey(task.projectId));
    for (const ancestor of ancestorChain(this.byId(), task)) {
      if (ancestor.id !== task.id) this.expanded.add(taskKey(ancestor.id));
    }
  }

  /** Brings the revealed row on screen; the list is taller than the modal once a deep
   *  branch is open. `scrollIntoView` is absent under jsdom, hence the optional call. */
  private scrollRevealedIntoView(): void {
    const id = this.opts.revealTaskId;
    if (!id) return;
    const row = this.projectList
      .querySelector<HTMLElement>(`.pm-mt-row[data-task-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView?.({ block: "center" });
  }

  /** The destination as currently selected, or null when nothing is chosen yet. */
  private currentChoice(): MoveChoice | null {
    if (this.newProjectTitle !== null) {
      return this.newProjectTitle.trim()
        ? { kind: MoveChoiceKind.NewProject, title: this.newProjectTitle.trim() }
        : null;
    }
    if (!this.selectedProject) return null;
    return {
      kind: MoveChoiceKind.Existing,
      projectId: this.selectedProject.id,
      projectFilePath: this.selectedProject.filePath,
      projectTitle: this.selectedProject.title,
      parentTask: this.selectedParent,
    };
  }

  private disabledReason(choice: MoveChoice): string | undefined {
    return this.opts.isDisabled?.(choice);
  }

  private syncCta(): void {
    const choice = this.currentChoice();
    this.ctaBtn.disabled = !choice || !!this.disabledReason(choice);
  }

  private commit(): void {
    const choice = this.currentChoice();
    if (!choice || this.disabledReason(choice)) return;
    this.close();
    this.opts.onChoose(choice);
  }

  /** The icon says which way the filter is now ("eye-off" = completed hidden); the
   *  tooltip says what a click would do. */
  private syncHideBtn(): void {
    setIcon(this.hideBtn, this.hideCompleted ? Icon.CompletedHidden : Icon.CompletedShown);
    const label = this.hideCompleted ? "Show completed tasks" : "Hide completed tasks";
    this.hideBtn.setAttribute("aria-label", label);
    this.hideBtn.setAttribute("aria-pressed", String(this.hideCompleted));
    this.hideBtn.title = label;
    this.hideBtn.toggleClass("is-active", this.hideCompleted);
  }

  private toggleHideCompleted(): void {
    this.hideCompleted = !this.hideCompleted;
    // A selection this culls is kept, marked on the nearest ancestor still on show
    // (see selectionMarkerKey), so flicking the filter costs nothing.
    this.syncHideBtn();
    this.renderTree();
    this.syncCta();
  }

  /** The tasks the tree is showing. A completed task is kept when open work survives
   *  below it, which hiding it would strand. */
  private visibleTaskIds(): Set<string> {
    const visible = new Set<string>();
    if (!this.hideCompleted) {
      for (const task of this.opts.tasks) visible.add(task.id);
      return visible;
    }

    const childMap = buildChildMap(this.opts.tasks);
    // Post-order: a task's fate depends on its descendants', so they settle first.
    const walk = (task: Task): boolean => {
      // A cancelled task takes its subtree with it: nothing below it counts as open.
      if (toStatus(task.status) === Status.Cancelled) return false;
      let keep = !isDoneStatus(task.status);
      for (const child of childMap.get(task.id) ?? []) {
        if (walk(child)) keep = true;
      }
      if (keep) visible.add(task.id);
      return keep;
    };
    for (const root of childMap.get(undefined) ?? []) walk(root);
    return visible;
  }

  private byId(): Map<string, Task> {
    if (!this.taskByIdCache) this.taskByIdCache = new Map(this.opts.tasks.map((t) => [t.id, t]));
    return this.taskByIdCache;
  }

  /** The row that should show "your choice is in here", or null when the choice is on
   *  show. A selection outlives whatever hid it, so it always keeps a breadcrumb. */
  private selectionMarkerKey(visible: Set<string>): string | null {
    if (!this.selectedProject || !this.selectedParent) return null;
    if (this.newProjectTitle !== null) return null;

    let host = projectKey(this.selectedProject.id);
    if (!this.expanded.has(host)) return host;

    for (const task of ancestorChain(this.byId(), this.selectedParent)) {
      // Culled by the filter: the trail goes cold at the last row still shown.
      if (!visible.has(task.id)) return host;
      if (task.id === this.selectedParent.id) return null; // the selection itself is on show
      if (!this.expanded.has(taskKey(task.id))) return taskKey(task.id);
      host = taskKey(task.id);
    }
    return null;
  }

  private renderTree(): void {
    // Retire the previous pass's markdown with its rows, or its child components pile
    // up on one host for the modal's whole life.
    this.renderHost.unload();
    this.renderHost = new Component();
    this.renderHost.load();
    // Emptying the container drops the scroll to the top, which would throw the row just
    // clicked out of view. `.pm-mt-projects` sets `overflow-anchor: none` so the markdown
    // reflow a frame later doesn't undo the restore.
    const scrollTop = this.projectList.scrollTop;
    this.projectList.empty();

    if (this.opts.projects.length === 0 && !this.opts.allowNewProject) {
      this.projectList.createDiv({ cls: "pm-mt-empty", text: "No projects" });
      return;
    }

    // Grouped once for the whole tree, rather than re-walking the task list per project.
    const byProject = new Map<string, Task[]>();
    for (const task of this.opts.tasks) {
      const group = byProject.get(task.projectId);
      if (group) group.push(task);
      else byProject.set(task.projectId, [task]);
    }

    const visible = this.visibleTaskIds();
    const markerKey = this.selectionMarkerKey(visible);
    for (const project of this.opts.projects) {
      this.renderProject(project, byProject.get(project.id) ?? [], visible, markerKey);
    }

    if (this.opts.allowNewProject) this.renderNewProjectRow();

    this.projectList.scrollTop = scrollTop;
  }

  /** A project row, plus its task tree when expanded. */
  private renderProject(
    project: Project,
    projectTasks: Task[],
    visible: Set<string>,
    markerKey: string | null,
  ): void {
    const childMap = buildChildMap(projectTasks);
    // A project whose tasks are all hidden gets no chevron.
    const hasTasks = (childMap.get(undefined) ?? []).some((t) => visible.has(t.id));
    const selected = this.newProjectTitle === null
      && this.selectedProject?.id === project.id
      && !this.selectedParent;
    const reason = this.disabledReason(this.choiceFor(project, undefined));
    const key = projectKey(project.id);

    const row = this.projectList.createDiv({
      cls: `pm-mt-row pm-mt-project-row${reason ? " pm-mt-row--disabled" : ""}${selected ? " pm-mt-row--selected" : ""}`,
    });
    row.dataset.projectId = project.id;
    this.markSelectionHost(row, key, markerKey, reason);
    this.addCollapseToggle(row, key, hasTasks, () =>
      this.expandThroughDone(childMap, undefined, visible));
    // The project's colour where its tasks show a ribbon, so every label lines up.
    const ribbon = row.createDiv({ cls: "pm-task-ribbon" });
    if (project.color) ribbon.style.setProperty("--pm-ribbon-color", project.color);
    row.createSpan({ cls: "pm-mt-row-label", text: project.title });

    if (reason) row.title = reason;
    else {
      row.addEventListener("click", () => {
        this.selectedProject = project;
        this.selectedParent = undefined;
        this.newProjectTitle = null;
        this.renderTree();
        this.syncCta();
      });
    }

    if (this.expanded.has(key)) {
      this.renderTaskLevel(project, childMap, undefined, 1, visible, markerKey);
    }
  }

  private renderNewProjectRow(): void {
    // Read once and narrowed, so the input below doesn't need a fallback for a null
    // the branch it sits in has already ruled out.
    const title = this.newProjectTitle;
    const row = this.projectList.createDiv({
      cls: `pm-mt-row pm-mt-new-project${title === null ? "" : " pm-mt-row--selected"}`,
    });

    if (title === null) {
      row.setText("New project…");
      row.dataset.id = NEW_PROJECT_ROW;
      row.addEventListener("click", () => {
        this.newProjectTitle = "";
        this.focusNewProjectInput = true;
        this.selectedProject = null;
        this.selectedParent = undefined;
        this.renderTree();
        this.syncCta();
      });
      return;
    }

    const input = row.createEl("input", {
      type: "text",
      cls: "pm-mt-new-project-input",
      attr: { placeholder: "Project name…" },
    });
    input.value = title;
    input.addEventListener("input", () => {
      this.newProjectTitle = input.value;
      this.syncCta();
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); this.commit(); }
    });
    // Only on activation: a re-render would yank the caret out of the box mid-word.
    if (this.focusNewProjectInput) {
      this.focusNewProjectInput = false;
      input.focus();
    }
  }

  private renderTaskLevel(
    project: Project,
    childMap: Map<string | undefined, Task[]>,
    parentId: string | undefined,
    depth: number,
    visible: Set<string>,
    markerKey: string | null,
  ): void {
    for (const task of childMap.get(parentId) ?? []) {
      if (!visible.has(task.id)) continue;
      this.addTaskRow(project, task, depth, childMap, visible, markerKey);
      if (this.expanded.has(taskKey(task.id))) {
        this.renderTaskLevel(project, childMap, task.id, depth + 1, visible, markerKey);
      }
    }
  }

  /** Opens on past the done tasks a newly-revealed level leads with — with the filter
   *  on those are signposts to the open work below, not destinations. */
  private expandThroughDone(
    childMap: Map<string | undefined, Task[]>,
    parentId: string | undefined,
    visible: Set<string>,
  ): void {
    if (!this.hideCompleted) return;
    for (const child of childMap.get(parentId) ?? []) {
      if (!visible.has(child.id) || !isDoneStatus(child.status)) continue;
      this.expanded.add(taskKey(child.id));
      this.expandThroughDone(childMap, child.id, visible);
    }
  }

  /** Flags the nearest row on show to a selection that isn't (see selectionMarkerKey).
   *  A disabled row's refusal reason keeps the tooltip; the outline still shows. */
  private markSelectionHost(
    row: HTMLElement,
    key: string,
    markerKey: string | null,
    reason: string | undefined,
  ): void {
    if (key !== markerKey) return;
    row.addClass("pm-mt-row--holds-selection");
    if (!reason) row.title = "The chosen destination is inside";
  }

  /** Prepends the collapse chevron, or an equally wide spacer for a leaf so sibling
   *  labels line up. */
  private addCollapseToggle(
    row: HTMLElement,
    key: string,
    hasChildren: boolean,
    onExpand: () => void,
  ): void {
    if (!hasChildren) {
      row.createSpan({ cls: "pm-mt-chevron-spacer" });
      return;
    }
    const isCollapsed = !this.expanded.has(key);
    const toggle = row.createEl("button", {
      cls: `pm-dash-section-chevron pm-mt-chevron${isCollapsed ? " pm-dash-section-chevron--collapsed" : ""}`,
      attr: {
        "aria-label": isCollapsed ? "Expand" : "Collapse",
        "aria-expanded": String(!isCollapsed),
        title: isCollapsed ? "Expand" : "Collapse",
      },
    });
    setIcon(toggle, Icon.FolderToggle);
    toggle.addEventListener("click", (e) => {
      // Without this the row's own handler would also select the row.
      e.stopPropagation();
      if (isCollapsed) {
        this.expanded.add(key);
        onExpand();
      } else this.expanded.delete(key);
      this.renderTree();
    });
  }

  private choiceFor(project: Project, parentTask: Task | undefined): MoveChoice {
    return {
      kind: MoveChoiceKind.Existing,
      projectId: project.id,
      projectFilePath: project.filePath,
      projectTitle: project.title,
      parentTask,
    };
  }

  private addTaskRow(
    project: Project,
    task: Task,
    depth: number,
    childMap: Map<string | undefined, Task[]>,
    visible: Set<string>,
    markerKey: string | null,
  ): void {
    const reason = this.disabledReason(this.choiceFor(project, task));
    const selected = !reason && this.selectedParent?.id === task.id;

    const row = this.projectList.createDiv({
      cls: `pm-mt-row pm-mt-parent-row${reason ? " pm-mt-row--disabled" : ""}${selected ? " pm-mt-row--selected" : ""}`,
    });
    row.style.paddingLeft = `${depth * 1.2 + 0.5}rem`;
    row.dataset.taskId = task.id;
    this.markSelectionHost(row, taskKey(task.id), markerKey, reason);

    // An illegal destination can still have legal descendants, so disabled rows get
    // a chevron too.
    const hasChildren = (childMap.get(task.id) ?? []).some((t) => visible.has(t.id));
    this.addCollapseToggle(row, taskKey(task.id), hasChildren, () =>
      this.expandThroughDone(childMap, task.id, visible));

    // Read-only echoes of the dashboard's ribbon and pill: the picker shows where a
    // task sits, it isn't a place to edit it.
    renderPriorityRibbon(row, task.priority);

    // Titles hold wikilinks and tags, rendered as the views do. CSS makes the links
    // inert — see .pm-mt-row-label a.
    renderTaskTitle(row, task.title, this.app, this.renderHost, "pm-mt-row-label");

    const statusInForce = effectiveStatus(task, this.byId());
    renderStatusPill(row, "pm-dash-task-status pm-mt-status", statusInForce, {
      text: joinStatuses(statusLabel(task.status), statusLabel(statusInForce)),
    });

    if (reason) {
      row.title = reason;
      return;
    }
    row.addEventListener("click", () => {
      this.selectedProject = project;
      this.selectedParent = task;
      this.newProjectTitle = null;
      this.renderTree();
      this.syncCta();
    });
  }
}
