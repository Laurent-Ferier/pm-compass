import { App, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import { buildChildMap, collectDescendants, isCompletedWithOpenSubtasks, isOpenUnderCompletedParent, type Task, type Project } from "../model/shared";
import { daysLabel, type EffectiveValues } from "../model/task-scoring";
import {
  PRIORITY_COLORS, PRIORITY_LABELS, Priority, STATUS_COLORS, STATUS_LABELS, STATUSES, PRIORITIES,
} from "../model/task-vocabulary";
import {
  renderPriorityRibbon, renderStatusPill, renderSubtaskWarning, renderParentDoneWarning,
  createBadgeBand, renderMetaBadge, BadgeTone,
} from "./task-badges";
import { INFO_SVG, setSvgIcon } from "./icons";
import {
  renderTaskTitle, appendEditTitleButton, appendRescheduleButton, attachActionsTapToggle,
} from "./day-task-row";
import { moment } from "../model/moment";
import { openDatePicker } from "./date-picker";
import { TaskModal, ConfirmModal, patchTaskField, deleteTaskFile, openDropdown, openNoteFile } from "./task-creator";
import { MoveTargetModal, openMoveTaskModal } from "./move-target-modal";
import { promoteChecklistItem } from "../model/checklist-promote";
import { setChecklistItemPriority } from "../model/day-task-actions";
import type { DayTask } from "../model/day-task";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";

/** Base class for the Dashboard/Inbox/Week Summary tabs: collapsible sections,
 *  a shared project-task row renderer, and the task-graph handoff used when a
 *  row is clicked. */
export abstract class BaseTabView {
  allTasks: Task[] = [];

  /** Keys (see `renderNoteChevron`) of tasks whose note panel is currently expanded.
   *  Survives across `render()` calls (unlike the DOM, which is torn down and rebuilt
   *  on every refresh), so editing a note doesn't collapse it back on save. */
  protected readonly openNoteKeys = new Set<string>();

  /** Cached `buildChildMap(this.allTasks)`, rebuilt when `allTasks` is replaced. */
  private childMapCache?: { tasks: Task[]; map: Map<string | undefined, Task[]> };
  /** Cached id→task map for the current `allTasks`, rebuilt when it is replaced. */
  private taskByIdCache?: { tasks: Task[]; map: Map<string, Task> };

  /** The child map for the current `allTasks`, built once per task-list identity. */
  protected childMap(): Map<string | undefined, Task[]> {
    if (this.childMapCache?.tasks !== this.allTasks) {
      this.childMapCache = { tasks: this.allTasks, map: buildChildMap(this.allTasks) };
    }
    return this.childMapCache.map;
  }

  /** The id→task map for the current `allTasks`, built once per task-list identity. */
  protected taskById(): Map<string, Task> {
    if (this.taskByIdCache?.tasks !== this.allTasks) {
      this.taskByIdCache = { tasks: this.allTasks, map: new Map(this.allTasks.map((t) => [t.id, t])) };
    }
    return this.taskByIdCache.map;
  }

  constructor(
    protected readonly app: App,
    protected readonly plugin: PMCompassPlugin,
    protected readonly onRefresh: () => void,
  ) {}

  /**
   * Run a mutating action, refresh on success, and surface a failure as a
   * Notice instead of letting the rejection vanish. A failed vault write
   * (locked or read-only file, a sync conflict) would otherwise leave the row
   * stale with no feedback at all.
   */
  protected runMutation(action: () => Promise<unknown>, failureMessage: string): void {
    void action()
      .then(() => this.onRefresh())
      .catch((e) => {
        console.error(`pm-compass: ${failureMessage}`, e);
        new Notice(failureMessage);
      });
  }

  protected createCollapsibleSection(
    container: HTMLElement,
    title: string,
    key: string,
    options?: { tooltip?: string; sub?: boolean },
  ): { section: HTMLElement; body: HTMLElement } {
    const isCollapsed = this.plugin.settings.dashboardCollapsed[key] ?? false;
    const section = container.createDiv({
      cls: `pm-dash-section${options?.sub ? " pm-dash-section--sub" : ""}`,
    });

    const header = section.createDiv({ cls: "pm-dash-section-header pm-dash-section-header--collapsible" });
    const chevron = header.createSpan({
      cls: `pm-dash-section-chevron${isCollapsed ? " pm-dash-section-chevron--collapsed" : ""}`,
    });
    setIcon(chevron, "chevron-down");
    header.createSpan({ cls: "pm-dash-section-title", text: title });

    if (options?.tooltip) {
      const info = header.createSpan({ cls: "pm-dash-section-info" });
      setSvgIcon(info, INFO_SVG);
      info.createDiv({ cls: "pm-dash-section-tooltip", text: options.tooltip });
      info.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = info.classList.toggle("pm-dash-section-info--open");
        if (isOpen) {
          const close = (ev: MouseEvent) => {
            if (!info.contains(ev.target as Node)) {
              info.classList.remove("pm-dash-section-info--open");
              activeDocument.removeEventListener("click", close, true);
            }
          };
          activeDocument.addEventListener("click", close, true);
        }
      });
    }

    const body = section.createDiv({ cls: "pm-dash-section-body" });
    if (isCollapsed) body.setCssStyles({ display: "none" });

    header.addEventListener("click", () => {
      const nowCollapsed = !(this.plugin.settings.dashboardCollapsed[key] ?? false);
      this.plugin.settings.dashboardCollapsed[key] = nowCollapsed;
      void this.plugin.saveSettings();
      chevron.toggleClass("pm-dash-section-chevron--collapsed", nowCollapsed);
      body.style.display = nowCollapsed ? "none" : "";
    });

    return { section, body };
  }

  /**
   * Makes a ribbon rendered by `renderPriorityRibbon` a dropdown trigger: same picker,
   * same affordance (pointer, hover, enlarged tap zone) on a checklist line and on a
   * project task, only `apply` differs — a marker in the checklist line one side, a
   * frontmatter field the other.
   */
  private attachPriorityDropdown(ribbon: HTMLElement, apply: (priority: Priority) => Promise<unknown>): void {
    ribbon.addClass("pm-task-ribbon--editable");
    ribbon.addEventListener("click", (e) => {
      e.stopPropagation();
      openDropdown(
        ribbon,
        PRIORITIES.map((p) => ({
          label: PRIORITY_LABELS[p],
          color: PRIORITY_COLORS[p] ?? "#6b7280",
          onSelect: () => this.runMutation(() => apply(p), "Couldn't update the priority"),
        })),
      );
    });
  }

  /**
   * The coloured priority ribbon at a checklist row's leading edge — the same badge (and
   * the same dropdown wiring) project-task rows get in `renderTaskRow`, writing the
   * Obsidian Tasks priority marker back into the checklist line instead of a frontmatter
   * field. Shared by the Inbox and the dashboard's day checklist so a task keeps a visible,
   * editable priority once it is scheduled onto a day.
   *
   * The ribbon is inert (no dropdown) for habit lines, which are regenerated from their
   * definition on every reconcile, and when the row has no file to write back to.
   */
  protected renderChecklistPriority(
    main: HTMLElement,
    item: DayTask,
    filePath: string | null,
    habitsTag: string,
  ): void {
    const ribbon = renderPriorityRibbon(main, item.priority ?? undefined);
    if (!filePath || item.tags.includes(`#${habitsTag}`)) return;

    this.attachPriorityDropdown(ribbon, (p) => setChecklistItemPriority(this.app, filePath, item, p));
  }

  protected renderTaskRow(
    container: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    effectivePriority?: Priority,
    effectiveDue?: string,
    readonly = false,
  ): void {
    const row = container.createDiv({ cls: `pm-dash-task-row${readonly ? " pm-dash-task-row--readonly" : ""}` });
    row.dataset.taskId = task.id;

    const ribbon = renderPriorityRibbon(row, task.priority, effectivePriority);
    if (!readonly) {
      this.attachPriorityDropdown(ribbon, (p) => patchTaskField(this.app, task.filePath, "priority", p));
    }

    const project = projectMap.get(task.projectId);
    const displayDue = effectiveDue ?? task.due;

    const body = row.createDiv({ cls: "pm-dash-task-body" });

    const line1 = body.createDiv({ cls: "pm-dash-task-line" });
    const titleSpan = renderTaskTitle(line1, task.title, this.app, this.plugin, "pm-dash-task-title");
    if (project) {
      const badge = line1.createSpan({ cls: "pm-dash-task-project", text: project.title });
      if (project.color) badge.style.setProperty("--pm-project-color", project.color);
    }

    const line2 = body.createDiv({ cls: "pm-dash-task-line" });
    const statusBadge = renderStatusPill(line2, "pm-dash-task-status", task.status);
    if (!readonly) {
      statusBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        openDropdown(
          statusBadge,
          STATUSES.map((s) => ({
            label: STATUS_LABELS[s],
            color: STATUS_COLORS[s],
            onSelect: () => {
              this.runMutation(
                () => patchTaskField(this.app, task.filePath, "status", s),
                "Couldn't update the status",
              );
            },
          })),
        );
      });
    }
    if (isCompletedWithOpenSubtasks(task, this.childMap())) {
      renderSubtaskWarning(line2, "pm-dash-task-warn");
    }
    if (isOpenUnderCompletedParent(task, this.taskById())) {
      renderParentDoneWarning(line2, "pm-dash-task-warn");
    }
    if (displayDue) {
      const { text, overdue } = daysLabel(displayDue);
      renderMetaBadge(createBadgeBand(line2), {
        text,
        tone: overdue ? BadgeTone.Danger : BadgeTone.Neutral,
        title: effectiveDue && effectiveDue !== task.due
          ? `Effective deadline: ${effectiveDue} (own: ${task.due ?? "none"})`
          : undefined,
        // The same affordance a checklist row's day badge has: the value you can see is
        // the one you click to change. An inherited date isn't that — it is the ancestor's,
        // and a picker opened on it would be seeded with a date it can't write back. The
        // toolbar's deadline button stays the way to give such a task one of its own, which
        // then becomes what this badge shows and edits.
        onClick: readonly || (effectiveDue && effectiveDue !== task.due)
          ? undefined
          : (badge) => this.openDueDatePicker(badge, task),
      });
    }

    if (readonly) {
      // No toolbar to reveal on these echoes, so the row keeps the graph on its own click.
      row.addEventListener("click", () => void this.openInGraph(task));
      return;
    }

    this.renderTaskActions(row, line1, titleSpan, task, projectMap);
    attachActionsTapToggle(row);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openTaskContextMenu(e, task, projectMap);
    });
  }

  /** Opens the shared calendar on a project task's own deadline, writing the pick (or the
   *  clear) straight back to its `due` field. */
  private openDueDatePicker(anchor: HTMLElement, task: Task): void {
    openDatePicker(anchor, {
      initial: task.due ? moment(task.due) : undefined,
      onPick: (date) => this.runMutation(
        () => patchTaskField(this.app, task.filePath, "due", date.format("YYYY-MM-DD")),
        "Couldn't update the deadline",
      ),
      onClear: task.due
        ? () => this.runMutation(
          () => patchTaskField(this.app, task.filePath, "due", ""),
          "Couldn't clear the deadline",
        )
        : undefined,
    });
  }

  /**
   * The floating toolbar a project-task row reveals when tapped — the same one a
   * checklist row carries, holding what a task can be *done to* from a list: rename it,
   * open its full editor, move its deadline, jump to it in the graph.
   *
   * The rarer structural actions (add a subtask, move, delete) stay behind the "More"
   * button, which opens the very menu the desktop right-click opens. That keeps the
   * toolbar the same size as a checklist row's, and — unlike the right-click it mirrors —
   * makes those actions reachable on a phone at all.
   */
  private renderTaskActions(
    row: HTMLElement,
    line1: HTMLElement,
    titleSpan: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
  ): void {
    const actions = row.createDiv({ cls: "pm-task-actions" });

    appendEditTitleButton(actions, line1, titleSpan, {
      current: task.title,
      cls: "pm-dash-task-title",
      editingHost: row,
      commit: (newTitle) => this.runMutation(
        () => patchTaskField(this.app, task.filePath, "title", newTitle),
        "Couldn't update the title",
      ),
    });

    const detailsBtn = actions.createEl("button", {
      cls: "pm-task-action-btn",
      attr: { "aria-label": "Edit task details", title: "Edit task details (ctrl-click to open the note)" },
    });
    setIcon(detailsBtn, "square-pen");
    detailsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        openNoteFile(this.app, task.filePath);
        return;
      }
      new TaskModal(this.app, {
        mode: "edit",
        task,
        existingTasks: this.allTasks.filter((t) => t.projectId === task.projectId),
        onSuccess: () => this.onRefresh(),
      }).open();
    });

    appendRescheduleButton(
      actions,
      (date) => this.runMutation(
        () => patchTaskField(this.app, task.filePath, "due", date.format("YYYY-MM-DD")),
        "Couldn't update the deadline",
      ),
      { ariaLabel: "Set deadline", title: "Set the deadline" },
      task.due ? moment(task.due) : undefined,
      task.due
        ? () => this.runMutation(
          () => patchTaskField(this.app, task.filePath, "due", ""),
          "Couldn't clear the deadline",
        )
        : undefined,
    );

    const graphBtn = actions.createEl("button", {
      cls: "pm-task-action-btn",
      attr: { "aria-label": "Open in graph", title: "Open in the task graph" },
    });
    setIcon(graphBtn, "git-fork");
    graphBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openInGraph(task);
    });

    const moreBtn = actions.createEl("button", {
      cls: "pm-task-action-btn",
      attr: { "aria-label": "More actions", title: "More actions" },
    });
    setIcon(moreBtn, "ellipsis");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openTaskContextMenu(e, task, projectMap);
    });
  }

  protected renderExpandList(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, EffectiveValues>,
  ): void {
    for (const task of tasks) {
      const eff = effectiveValuesMap.get(task.id);
      this.renderTaskRow(container, task, projectMap, eff?.priority, eff?.due, true);
    }
    if (tasks.length === 0) container.createDiv({ cls: "pm-dash-expand-empty", text: "No tasks" });
  }

  /**
   * Offers a destination for a checklist item — an existing project, a task
   * within it, or a brand-new project — then turns the line into a real task.
   *
   * Shared by the Inbox and the Dashboard: an inbox line and a day-note line are
   * the same thing, and both can turn out to be project work. `sourcePath` is
   * whichever file holds the line.
   */
  protected openPromoteModal(
    item: DayTask,
    sourcePath: string,
    projects: Project[],
    habitsTag: string,
  ): void {
    new MoveTargetModal(this.app, {
      heading: `Promote "${item.displayTitle(habitsTag)}"`,
      ctaLabel: "Promote",
      projects,
      tasks: this.allTasks,
      allowNewProject: true,
      // Any destination is legal: the task doesn't exist yet, so it has no
      // subtree to move into and no dependencies to invalidate.
      onChoose: (choice) => {
        promoteChecklistItem(this.app, sourcePath, item, choice, {
          projectsFolder: this.plugin.settings.projectsFolder,
          habitsTag,
        })
          .then(() => {
            new Notice(`Promoted "${item.displayTitle(habitsTag)}"`);
            this.onRefresh();
          })
          .catch((e) => {
            console.error("pm-compass: promote failed", e);
            new Notice(`Promote failed: ${e instanceof Error ? e.message : String(e)}`);
          });
      },
    }).open();
  }

  protected openTaskContextMenu(e: MouseEvent, task: Task, projectMap: Map<string, Project>): void {
    const project = projectMap.get(task.projectId);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Add subtask").setIcon("plus").onClick(() => {
        if (!project) return;
        new TaskModal(this.app, {
          mode: "create",
          projectId: project.id,
          projectFilePath: project.filePath,
          projectTitle: project.title,
          parentTask: task,
          existingTasks: this.allTasks.filter((t) => t.projectId === task.projectId),
          onSuccess: () => this.onRefresh(),
        }).open();
      })
    );
    menu.addItem((item) =>
      item.setTitle("Move task…").setIcon("folder-input").onClick(() => {
        openMoveTaskModal(this.app, task, [...projectMap.values()], this.allTasks, () => this.onRefresh());
      })
    );
    menu.addItem((item) =>
      item.setTitle("Delete task").setIcon("trash").onClick(() => {
        const descendantCount = this.countDescendants(task.id);
        const msg = descendantCount > 0
          ? `Delete "${task.title}" and its ${descendantCount} subtask${descendantCount > 1 ? "s" : ""}?`
          : `Delete "${task.title}"?`;
        new ConfirmModal(this.app, msg, () => {
          const parentTask = task.parentId ? this.allTasks.find((t) => t.id === task.parentId) : undefined;
          this.runMutation(
            () => deleteTaskFile(this.app, task, parentTask, this.allTasks),
            "Couldn't delete the task",
          );
        }).open();
      })
    );
    menu.showAtMouseEvent(e);
  }

  protected countDescendants(taskId: string): number {
    return collectDescendants(this.allTasks, taskId).length;
  }

  protected async openInGraph(task: Task): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(TASK_GRAPH_VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TASK_GRAPH_VIEW_TYPE, active: true });
      // Obsidian may defer view construction past setViewState resolution; wait
      // up to 500 ms for the view to be attached before proceeding.
      for (let i = 0; i < 10 && !(leaf.view instanceof TaskGraphView); i++) {
        await new Promise((r) => window.setTimeout(r, 50));
      }
    }
    await this.app.workspace.revealLeaf(leaf);

    if (leaf.view instanceof TaskGraphView) {
      await leaf.view.openTask(task.projectId, task.id);
    }
  }
}
