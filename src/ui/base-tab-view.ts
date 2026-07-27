import { App, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import { buildChildMap, collectDescendants, effectiveStatus, isCompletedWithOpenSubtasks, isOpenUnderCompletedParent, type Task, type Project } from "../model/shared";
import { daysLabel, type EffectiveValues } from "../model/task-scoring";
import {
  PRIORITY_COLORS, PRIORITY_LABELS, Priority, STATUS_COLORS, STATUS_LABELS, STATUSES, PRIORITIES,
  joinStatuses, statusLabel,
} from "../model/task-vocabulary";
import {
  renderPriorityRibbon, renderStatusIcon, renderSubtaskWarning, renderParentDoneWarning,
  createBadgeBand, renderMetaBadge, renderDaysBadge,
} from "./task-badges";
import { CALENDAR_SVG, DAILY_ICON_SVG, INBOX_SVG, INFO_SVG, PROJECT_ICON_SVG, setSvgIcon } from "./icons";
import {
  renderTaskTitle, appendRescheduleButton, attachActionsTapToggle, renderNoteChevron,
} from "./day-task-row";
import { moment } from "../model/moment";
import type { DatePickerOptions } from "./date-picker";
import { TaskModal, ConfirmModal, patchTaskField, deleteTaskFile, openDropdown, openNoteFile } from "./task-creator";
import { MoveTargetModal, openMoveTaskModal } from "./move-target-modal";
import { promoteChecklistItem } from "../model/checklist-promote";
import { setChecklistItemPriority } from "../model/day-task-actions";
import type { DayTask } from "../model/day-task";
import type { AddDragHandle } from "./drag-reorder";
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
    /** Takes the Dashboard to a day — where every date on a row leads, whichever tab and
     *  whichever kind of task it sits on. Defaulted so a view can be built without one. */
    protected readonly showDay: (date: string) => void = () => {},
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
  private attachPriorityDropdown(
    ribbon: HTMLElement,
    current: Priority | undefined,
    apply: (priority: Priority) => Promise<unknown>,
  ): void {
    ribbon.addClass("pm-task-ribbon--editable");
    ribbon.addEventListener("click", (e) => {
      e.stopPropagation();
      openDropdown(
        ribbon,
        PRIORITIES.map((p) => ({
          label: PRIORITY_LABELS[p],
          color: PRIORITY_COLORS[p] ?? "#6b7280",
          selected: p === (current || Priority.None),
          onSelect: () => this.runMutation(() => apply(p), "Couldn't update the priority"),
        })),
      );
    });
  }

  /** A project task as a row of a task list: its usual row, in the `li` a `ul` may hold.
   *  Both tabs' lists draw their non-day rows through this. */
  protected renderProjectTaskRow(
    list: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    effectiveValues: Map<string, EffectiveValues>,
  ): void {
    this.renderTaskRow(
      list.createEl("li", { cls: "pm-dash-task-item" }), task, projectMap, effectiveValues.get(task.id),
    );
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

    // A `Lowest` line has no rung in the picker, so nothing is marked — which is the truth.
    this.attachPriorityDropdown(ribbon, item.priority ?? undefined, (p) => setChecklistItemPriority(this.app, filePath, item, p));
  }

  /**
   * The day-task row both tab views draw, and the reason their lists sit on one grid: the
   * `<li>` and the middle of its main line — leading slot, priority ribbon, toggle box,
   * title, note chevron. Only the ends differ: `badges` after the title, `actions` at the
   * trailing edge (which only a row with a file to write to gets).
   */
  protected renderDayTaskRow(
    list: HTMLElement,
    item: DayTask,
    opts: {
      /** The row's own class, e.g. `pm-dash-checklist-item`; `--checked` is appended to it. */
      cls: string;
      titleCls: string;
      habitsTag: string;
      /** The file this row is written to. The task usually knows it; the Inbox passes the
       *  list's own path, which is the file its rows all live in. */
      filePath?: string | null;
      addDragHandle: AddDragHandle<DayTask>;
      /** True only for a row this list can reorder; the others put their day in the slot
       *  instead, having no order to persist from here. */
      movable: boolean;
      toggleLabel: string;
      /** What ticking the box does. Absent, the box is inert: there is nothing to write to. */
      onToggle?: (box: HTMLElement, li: HTMLElement) => void;
      badges?: (main: HTMLElement) => void;
      actions?: (actions: HTMLElement, li: HTMLElement, titleSpan: HTMLElement) => void;
    },
  ): void {
    const isHabit = item.tags.includes(`#${opts.habitsTag}`);
    const filePath = opts.filePath ?? item.filePath;

    const li = list.createEl("li", {
      cls: `pm-day-task-row ${opts.cls}${item.checked ? ` ${opts.cls}--checked` : ""}`,
    });
    attachActionsTapToggle(li);

    const main = li.createDiv({ cls: "pm-day-task-row-main" });

    // The leading slot, on every row and always the same width so the lists line up: the
    // recurring mark on a habit, else the grip where this list can persist the order, else
    // the day the line falls under, else the inbox a line no day holds yet waits in.
    const day = item.noteDate ?? item.plannedDate;
    if (isHabit) {
      const icon = main.createSpan({
        cls: "pm-day-task-lead pm-dash-checklist-daily-icon",
        attr: { "aria-label": "Recurring habit", title: "Recurring habit — reordered from the settings" },
      });
      setSvgIcon(icon, DAILY_ICON_SVG);
    } else if (opts.movable) {
      opts.addDragHandle(main, li, item, true);
    } else if (day) {
      const icon = main.createSpan({
        cls: "pm-day-task-lead pm-day-task-note-icon",
        attr: { "aria-label": "Show that day", title: `${day} — show that day on the dashboard` },
      });
      setSvgIcon(icon, CALENDAR_SVG);
      icon.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showDay(day);
      });
    } else {
      const icon = main.createSpan({
        cls: "pm-day-task-lead pm-day-task-inbox-icon",
        attr: { "aria-label": "In the inbox", title: "In the inbox — no day yet" },
      });
      setSvgIcon(icon, INBOX_SVG);
    }
    this.renderChecklistPriority(main, item, filePath, opts.habitsTag);

    // A control only where there is a file to write the tick back to: without `onToggle`
    // it is a picture of a checkbox, and announcing an unfocusable, stateless one as a
    // checkbox is worse than not announcing it.
    const box = main.createSpan({
      cls: `pm-dash-checkbox${item.checked ? " pm-dash-checkbox--checked" : ""}`,
      attr: opts.onToggle
        ? {
            role: "checkbox",
            "aria-label": opts.toggleLabel,
            "aria-checked": String(item.checked),
            tabindex: "0",
          }
        : { "aria-hidden": "true" },
    });
    if (opts.onToggle) {
      const toggle = (e: Event) => {
        // The row itself toggles its action bar on a tap; the box is not part of that.
        e.stopPropagation();
        e.preventDefault();
        opts.onToggle!(box, li);
      };
      box.addEventListener("click", toggle);
      // What a real checkbox answers to, so the span standing in for one answers to it too.
      box.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") toggle(e);
      });
    }

    const titleSpan = renderTaskTitle(
      main, item.habitMatchTitle(opts.habitsTag), this.app, this.plugin, opts.titleCls,
    );

    if (filePath) {
      renderNoteChevron(main, li, item, filePath, this.app, this.plugin, this.openNoteKeys, () => this.onRefresh());
    }

    opts.badges?.(main);

    if (filePath && opts.actions) {
      opts.actions(main.createDiv({ cls: "pm-task-actions" }), li, titleSpan);
    }
  }

  /** The day every date badge of the tab counts from, `YYYY-MM-DD`. Today, except on the
   *  dashboard, which reads its dates from the day it is showing. */
  protected referenceDate(): string {
    return moment().format("YYYY-MM-DD");
  }

  /** The one way a date reads on any row: `daysLabel`'s label, or the overdue chip once
   *  it is past. */
  protected renderDateBadge(
    container: HTMLElement,
    date: string,
    opts: {
      title: string;
      /** How many days past the date the warning glyph appears; a deadline warns the day
       *  after, the Inbox waits for its staleness threshold. `0` never warns. */
      warnAfterDays?: number;
      /** The count without the alarm — see `renderDaysBadge`. */
      quiet?: boolean;
      /** Replaces `title` once that glyph is showing. */
      warnTitle?: string;
      onClick?: (badge: HTMLElement) => void;
    },
  ): void {
    const { text, overdue, daysOverdue } = daysLabel(date, this.referenceDate());
    if (overdue) {
      // The default goes after the spread: before it, a caller passing the key at all —
      // an explicit `undefined` included — would take it back out again.
      renderDaysBadge(container, daysOverdue, { ...opts, warnAfterDays: opts.warnAfterDays ?? 1 });
    } else {
      renderMetaBadge(container, { text, ...opts });
    }
  }

  /** `eff` is the task's `computeEffectiveValues` entry — its roll-ups always travel
   *  together, so the row takes them as one value. */
  protected renderTaskRow(
    container: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    eff?: EffectiveValues,
    readonly = false,
  ): void {
    const row = container.createDiv({ cls: `pm-dash-task-row${readonly ? " pm-dash-task-row--readonly" : ""}` });
    row.dataset.taskId = task.id;

    // The leading slot, where a day task carries its grip: the project, in its own colour.
    // Always there — it is what names the project once the row is too narrow for the name.
    const leadProject = projectMap.get(task.projectId);
    if (leadProject) {
      const lead = row.createSpan({
        cls: "pm-day-task-lead pm-dash-task-project-icon",
        attr: { title: `${leadProject.title} — open in the task graph`, "aria-label": leadProject.title },
      });
      if (leadProject.color) lead.style.setProperty("--pm-project-color", leadProject.color);
      setSvgIcon(lead, PROJECT_ICON_SVG);
      lead.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.openInGraph(task);
      });
    }

    const ribbon = renderPriorityRibbon(row, task.priority, eff?.ancestorPriority, eff?.subtreePriority);
    if (!readonly) {
      this.attachPriorityDropdown(ribbon, task.priority, (p) => patchTaskField(this.app, task.filePath, "priority", p));
    }

    const project = projectMap.get(task.projectId);
    const displayDue = eff?.due ?? task.due;
    // A deadline the task doesn't own: shown, named on hover, but not editable from here.
    const inheritedDue = !!eff?.due && eff.due !== task.due;

    // Under a cancelled parent the tooltip spells out both: "In Progress / Cancelled".
    const statusInForce = effectiveStatus(task, this.taskById());
    const statusIcon = renderStatusIcon(row, "pm-dash-task-status-icon", statusInForce, {
      title: `Status: ${joinStatuses(statusLabel(task.status), statusLabel(statusInForce))}`,
      interactive: !readonly,
    });
    if (!readonly) {
      statusIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        openDropdown(
          statusIcon,
          STATUSES.map((s) => ({
            label: STATUS_LABELS[s],
            color: STATUS_COLORS[s],
            selected: s === task.status,
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

    const body = row.createDiv({ cls: "pm-dash-task-body" });

    const line1 = body.createDiv({ cls: "pm-dash-task-line" });
    renderTaskTitle(line1, task.title, this.app, this.plugin, "pm-dash-task-title");

    // A parent/subtask completion mismatch, right after the title it is about.
    if (isCompletedWithOpenSubtasks(task, this.childMap(), this.taskById())) {
      renderSubtaskWarning(line1, "pm-dash-task-warn");
    }
    if (isOpenUnderCompletedParent(task, this.taskById())) {
      renderParentDoneWarning(line1, "pm-dash-task-warn");
    }
    // Before the dates, so the date badge stays the row's last column as it is on a day
    // task's row: merged into one list, the two kinds' dates line up.
    if (project) {
      // Dropped on a narrow view, where the leading icon carries the project alone.
      const badge = line1.createSpan({
        cls: "pm-dash-task-project",
        text: project.title,
        attr: { title: `${project.title} — open in the task graph` },
      });
      if (project.color) badge.style.setProperty("--pm-project-color", project.color);
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.openInGraph(task);
      });
    }
    // The dates every row ends with: when it was written, then when it is due. Either opens
    // its day; the toolbar's "Set deadline" button is where a deadline is changed.
    const created = task.createdAt?.slice(0, 10);
    const dateBand = created || displayDue ? createBadgeBand(line1) : line1;

    if (created && /^\d{4}-\d{2}-\d{2}$/.test(created)) {
      // Quiet: a project task's age is how long it has been on the books, not a warning.
      this.renderDateBadge(dateBand, created, {
        quiet: true,
        title: `Created on ${created} — show that day`,
        onClick: readonly ? undefined : () => this.showDay(created),
      });
    }

    if (displayDue) {
      this.renderDateBadge(dateBand, displayDue, {
        // A relative label doesn't name the date itself.
        title: inheritedDue
          ? `Effective deadline: ${displayDue} (own: ${task.due ?? "none"}) — show that day`
          : `Deadline: ${displayDue} — show that day`,
        onClick: readonly ? undefined : () => this.showDay(displayDue),
      });
    }

    if (readonly) {
      // No toolbar to reveal on these echoes, so the row keeps the graph on its own click.
      row.addEventListener("click", () => void this.openInGraph(task));
      return;
    }

    this.renderTaskActions(row, task, projectMap);
    attachActionsTapToggle(row);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openTaskContextMenu(e, task, projectMap);
    });
  }

  /** A project task's deadline edit — seeded with its `due`, writing the pick or the clear
   *  back. Used by the toolbar's button. */
  private deadlineEdit(task: Task): DatePickerOptions {
    return {
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
    };
  }

  /**
   * The floating toolbar a project-task row reveals when tapped — the same one a
   * checklist row carries, holding what a task can be *done to* from a list: open its full
   * editor (where the title is edited too), move its deadline, jump to it in the graph.
   *
   * The rarer structural actions (add a subtask, move, delete) stay behind the "More"
   * button, which opens the very menu the desktop right-click opens. That keeps the
   * toolbar the same size as a checklist row's, and — unlike the right-click it mirrors —
   * makes those actions reachable on a phone at all.
   */
  private renderTaskActions(
    row: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
  ): void {
    const actions = row.createDiv({ cls: "pm-task-actions" });

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

    const { initial, onPick, onClear } = this.deadlineEdit(task);
    appendRescheduleButton(
      actions,
      onPick,
      { ariaLabel: "Set deadline", title: "Set the deadline" },
      initial,
      onClear,
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
      this.renderTaskRow(container, task, projectMap, effectiveValuesMap.get(task.id), true);
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
