import { App, Component, Modal, Notice, setIcon } from "obsidian";
import { Icon } from "./icons";
import { renderTaskTitle } from "./day-task-row";
import {
  isValidMoveTarget, MoveChoiceKind, type MoveChoice, type Task,
} from "../model/project/task";
import type { Project } from "../model/project/project";
import { buildChildMap, effectiveStatus } from "../model/project/task-tree";
import { isDoneStatus, Status, joinStatuses, statusLabel, toStatus } from "../model/base-task";
import { moveTask } from "../model/project/task-move";
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
  /** Return a reason to disable a destination, or undefined to allow it. */
  isDisabled?: (choice: MoveChoice) => string | undefined;
  onChoose: (choice: MoveChoice) => void;
}

const NEW_PROJECT_ROW = "__new__";

// Expansion keys are namespaced so a project and a task can't collide on id.
const projectKey = (id: string) => `p:${id}`;
const taskKey = (id: string) => `t:${id}`;

/**
 * Open the picker for an existing task and perform the move.
 *
 * Lives here rather than on BaseTabView because the graph view has its own
 * context menu and importing BaseTabView from it would close an import cycle.
 */
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
      moveTask(app, task, {
        projectId: choice.projectId,
        projectFilePath: choice.projectFilePath,
        projectTitle: choice.projectTitle,
        parentTask: choice.parentTask,
      }, allTasks, projects)
        .then(() => {
          new Notice(`Moved "${task.title}"`);
          onDone();
        })
        .catch((e) => {
          console.error("pm-compass: move failed", e);
          new Notice(`Move failed: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
  }).open();
}

/**
 * Picks where a task should land, as one tree: projects at the top level, each
 * expanding into its own task tree. Picking a project row means the project
 * root; picking a task row means under that task. Shared by the inbox-promote
 * flow and the move-existing-task flow, which differ only in whether a
 * brand-new project is on offer and which destinations are legal.
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
  /**
   * Hides done/cancelled tasks, which are the bulk of an old project's tree and
   * almost never what a task is being moved under. On by default for that
   * reason; the toggle is there for the rarer case of parking work under
   * something already closed.
   *
   * Projects are never hidden — a project has no status, and its root stays a
   * legal destination whatever its tasks look like.
   */
  private hideCompleted = true;
  /**
   * Keys (see projectKey/taskKey) whose children are on show. Every branch —
   * project and task alike — starts collapsed, so the modal opens as a plain
   * project list and each chevron reveals one level rather than a whole subtree.
   * Only a chevron writes here (plus the auto-open it triggers — see
   * expandThroughDone): selecting a row never opens or shuts one, so a branch
   * keeps whatever the user set until the modal is closed, at which point the
   * whole set goes with it.
   *
   * Purely visual. A selection survives its row going off screen, whether an
   * ancestor was collapsed or the completed filter culled it — the user picked
   * it deliberately, and renderTree marks the nearest ancestor still on show so
   * the choice is never invisible. See selectionMarkerKey.
   */
  private readonly expanded = new Set<string>();
  /**
   * Owns the lifecycle of the markdown rendered into task titles. A Modal isn't
   * a Component, so unlike the views (which hand `MarkdownRenderer` their
   * plugin) this one keeps its own. Replaced per render pass (see renderTree)
   * and unloaded on close.
   */
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

    // Obsidian's own close button (top-right X) duplicates the Cancel button in
    // the footer, and on mobile its 44px box crowds the toggle out of the corner.
    // Drop it and let Cancel be the one way out. parentElement is the `.modal`
    // wrapper at runtime; null under the test's bare-contentEl mock, hence `?.`.
    contentEl.parentElement?.querySelector(".modal-close-button")?.remove();

    // The heading shares its row with the toggle, which sits hard right (the
    // heading takes the slack via flex). Both belong to the tree below.
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

    this.renderTree();
    this.syncCta();
  }

  onClose(): void {
    this.renderHost.unload();
    this.contentEl.empty();
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

  /**
   * The icon carries the whole state, so it says which way it is now ("eye-off"
   * = completed are hidden) and the tooltip says what a click would do.
   */
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
    // A selection this has just culled is kept, not dropped: it stays marked on
    // the nearest ancestor still on show (see selectionMarkerKey), so it is
    // never committed to invisibly, and flicking the filter to look around
    // doesn't cost the user the destination they had already picked.
    this.syncHideBtn();
    this.renderTree();
    this.syncCta();
  }

  /**
   * The tasks the tree is currently showing, across every project.
   *
   * A completed task is kept when a task below it survives: a closed parent can
   * still hold open work, and hiding it outright would strand that work with no
   * route to it. The row is still shown as completed — its status pill says so —
   * it just isn't culled.
   */
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

  /** The selected task's line of descent, project-root-most first, itself last. */
  private ancestorChain(task: Task): Task[] {
    const byId = this.byId();
    const chain: Task[] = [];
    // `seen` guards against a parentId cycle looping this forever; the tree is
    // built from frontmatter, so it isn't guaranteed to be acyclic.
    const seen = new Set<string>();
    let cur: Task | undefined = task;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }

  /**
   * The row that should show "your choice is in here", or null when the choice
   * is on show and can speak for itself.
   *
   * A selection outlives whatever hid it — a collapsed ancestor or the completed
   * filter — so the CTA can be live with nothing selected-looking on screen. The
   * fix isn't to drop the selection (the user picked it deliberately, and a
   * collapse is not a change of mind) but to follow the trail from the project
   * down towards it and mark the last row still visible, so there is always a
   * breadcrumb back to it.
   */
  private selectionMarkerKey(visible: Set<string>): string | null {
    if (!this.selectedProject || !this.selectedParent) return null;
    if (this.newProjectTitle !== null) return null;

    let host = projectKey(this.selectedProject.id);
    if (!this.expanded.has(host)) return host;

    for (const task of this.ancestorChain(this.selectedParent)) {
      // Culled by the filter: the trail goes cold at the last row still shown.
      if (!visible.has(task.id)) return host;
      if (task.id === this.selectedParent.id) return null; // the selection itself is on show
      if (!this.expanded.has(taskKey(task.id))) return taskKey(task.id);
      host = taskKey(task.id);
    }
    return null;
  }

  private renderTree(): void {
    // Every pass renders every visible title afresh, so retire the previous
    // pass's markdown with its rows; otherwise its child components and their
    // now-detached spans pile up on one host for the modal's whole life.
    this.renderHost.unload();
    this.renderHost = new Component();
    this.renderHost.load();
    // A chevron rebuilds the whole list, and emptying a scroll container drops it
    // back to the top — which would throw the very row that was just clicked out
    // of view. Restoring afterwards is capped by the new content height, so a
    // pass that shortens the tree still settles somewhere sensible. The titles
    // render as markdown a frame later and reflow the rows; `.pm-mt-projects` sets
    // `overflow-anchor: none` so that reflow doesn't undo this restore.
    const scrollTop = this.projectList.scrollTop;
    this.projectList.empty();

    if (this.opts.projects.length === 0 && !this.opts.allowNewProject) {
      this.projectList.createDiv({ cls: "pm-mt-empty", text: "No projects" });
      return;
    }

    // Grouped once for the whole tree: a filter+scan per project would re-walk
    // the full task list for every project, expanded or not.
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
    // A project whose tasks are all hidden gets no chevron: there is nothing
    // behind it to open.
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
    // The project's own colour where its tasks show a priority ribbon, so every
    // label in the tree is preceded by a bar of the same width.
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
    const active = this.newProjectTitle !== null;
    const row = this.projectList.createDiv({
      cls: `pm-mt-row pm-mt-new-project${active ? " pm-mt-row--selected" : ""}`,
    });

    if (!active) {
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
    input.value = this.newProjectTitle ?? "";
    input.addEventListener("input", () => {
      this.newProjectTitle = input.value;
      this.syncCta();
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); this.commit(); }
    });
    // Only steal focus when the row was just activated, not on the re-renders a
    // chevron or a selection triggers — those would yank the caret out of the
    // name box mid-word.
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

  /**
   * Opens on past the done tasks a newly-revealed level leads with, so the level
   * the user actually gets holds something live.
   *
   * With the completed filter on, a done task is only on show because open work
   * sits somewhere below it (see visibleTaskIds) — it is a signpost, not a
   * plausible destination. Stopping there would leave the user clicking through a
   * chain of rows that exist purely to be clicked through. With the filter off
   * every done task is a destination in its own right, so this does nothing.
   */
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

  /**
   * Flags a row as the nearest thing on show to a selection that isn't (see
   * selectionMarkerKey). The tooltip goes on only where a disabled row's refusal
   * reason isn't already using it — that reason is the more urgent of the two,
   * and the outline still shows.
   */
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

  /**
   * Prepends the collapse chevron, or an equally wide spacer for a leaf so the
   * labels of siblings line up whether or not they have children.
   */
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

    // A row can be an illegal destination and still have legal descendants, so
    // the chevron goes on disabled rows too.
    const hasChildren = (childMap.get(task.id) ?? []).some((t) => visible.has(t.id));
    this.addCollapseToggle(row, taskKey(task.id), hasChildren, () =>
      this.expandThroughDone(childMap, task.id, visible));

    // Read-only echoes of the dashboard's ribbon and pill (hence the shared
    // helpers, minus their dropdowns): the picker shows where a task sits, it
    // isn't a place to edit it.
    renderPriorityRibbon(row, task.priority);

    // Titles hold wikilinks and tags; render them as the views do rather than
    // showing raw "[[…]]". CSS makes the links inert — see .pm-mt-row-label a.
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
