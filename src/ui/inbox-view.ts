import { Notice, setIcon } from "obsidian";
import { confirmAction, openDropdown, openNoteFile } from "./task-creator";
import { basenameOf, ensureNote } from "../model/operations/file-helpers";
import { diffDays, formatDate } from "../model/dates";
import { formatPattern } from "../model/date-format";
import { Task, resolveHabitsTag } from "../model/daily/task";
import {
  resolveTaskSortDir, sortInboxItems, hasSortableDeadline, ScheduleOutcome,
} from "../model/daily/day-task-actions";
import { TaskSortKey, TaskSortDir } from "../model/settings";
import type { Project } from "../model/project/project";
import type { ProjectTask } from "../model/project/project-task";
import type { EffectiveValues, UndatedSelection } from "../model/project/task-scoring";
import { TaskList } from "./task-list";
import { BaseTabView } from "./base-tab-view";
import {
  appendEditTitleButton,
  dayTaskTitleEdit,
  appendNoteActionButton,
  appendRescheduleButton,
} from "./day-task-row";
import { Icon } from "./icons";
import type { AddDragHandle, ReorderDrop } from "./drag-reorder";
import { BadgeTone, createBadgeBand, renderMetaBadge } from "./task-badges";

const UNDATED_TITLE = "Project tasks with no deadline";
const UNDATED_TOOLTIP =
  "Prioritized project tasks that nothing dates. Give one a deadline and it moves to the dashboard.";

/** What the project filter's button and picker are drawn from. */
interface ProjectFilterState {
  projects: Project[];
  /** The projects holding an undated task, which the rest say they don't in their tooltip. */
  withUndated: Set<string>;
  /** The ids of the projects held back, an empty list being every project shown. */
  hiddenProjects: string[];
  /** How many project tasks the filter is keeping out, for the button's tooltip. */
  hiddenTasks: number;
}

/** Sort modes in the order the dropdown offers them, and their button labels. */
const INBOX_SORT_MODES: TaskSortKey[] = [
  TaskSortKey.Created, TaskSortKey.Priority, TaskSortKey.Due, TaskSortKey.Title, TaskSortKey.File,
];
const INBOX_SORT_LABELS: Record<TaskSortKey, string> = {
  [TaskSortKey.Created]: "Created",
  [TaskSortKey.Priority]: "Priority",
  [TaskSortKey.Due]: "Deadline",
  [TaskSortKey.Title]: "Title",
  [TaskSortKey.File]: "Default",
};

/** What a mode orders by, for the mode button's tooltip. The final newest-first fallback
 *  is left out, deciding only between otherwise identical rows. */
const INBOX_SORT_CHAINS: Record<TaskSortKey, string> = {
  [TaskSortKey.Created]: "Creation date, then priority",
  [TaskSortKey.Priority]: "Priority, then creation date",
  [TaskSortKey.Due]: "Deadline, then priority, then creation date",
  [TaskSortKey.Title]: "Title, then priority, then creation date",
  [TaskSortKey.File]: "File order, then creation date",
};

/** What each direction means for the mode it applies to, for the direction button's
 *  tooltip. */
const INBOX_SORT_DIR_LABELS: Record<TaskSortKey, Record<TaskSortDir, string>> = {
  [TaskSortKey.Created]: { [TaskSortDir.Asc]: "Oldest first", [TaskSortDir.Desc]: "Newest first" },
  [TaskSortKey.Priority]: { [TaskSortDir.Asc]: "Least urgent", [TaskSortDir.Desc]: "Most urgent" },
  [TaskSortKey.Due]: { [TaskSortDir.Asc]: "Soonest", [TaskSortDir.Desc]: "Latest" },
  [TaskSortKey.Title]: { [TaskSortDir.Asc]: "A → Z", [TaskSortDir.Desc]: "Z → A" },
  [TaskSortKey.File]: { [TaskSortDir.Asc]: "File order", [TaskSortDir.Desc]: "Reversed" },
};

export class InboxView extends BaseTabView {
  /** The project tasks the inbox holds beside its own lines, as `InBox` picked them. */
  undated: UndatedSelection = { tasks: [], effectiveValues: new Map() };

  /** Closes the project picker while it is up. It outlives the render passes its own ticks
   *  set off, so nothing but `dispose` and a click outside it ends it. */
  private closeProjectPicker?: () => void;

  async render(
    container: HTMLElement,
    resolvedPath: string,
    items: Task[],
    staleAfterDays: number,
    projects: Project[] = [],
  ): Promise<void> {
    this.startRenderPass();
    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);

    // Planned items are hidden, not dropped: the count drives the empty-state wording.
    const hidePlanned = this.plugin.settings.inboxHidePlanned ?? false;
    const shown = hidePlanned ? items.filter((item) => !item.scheduledDate) : items;
    const hiddenCount = items.length - shown.length;

    // Project tasks nothing dates: no dashboard horizon holds them, so they wait here to
    // be given a day. Merged they join the inbox's own list; split, each list is named.
    const undated = this.undated;
    const merged = this.plugin.settings.mergeDailyAndProjectTasks;

    // Only the project tasks carry a project, so only they narrow. The inbox's own lines
    // are what there is to triage and stay whatever the filter says.
    const hiddenProjects = this.plugin.settings.inboxHiddenProjects ?? [];
    const undatedShown = undated.tasks.filter((task) => !hiddenProjects.includes(task.projectId));
    const undatedHidden = undated.tasks.length - undatedShown.length;
    const filterNote = undatedHidden > 0
      ? `${undatedHidden} project task${undatedHidden === 1 ? "" : "s"} hidden by the project filter`
      : null;

    // Everything the one list holds, which is what the sort applies to.
    const rows = merged ? [...shown, ...undatedShown] : shown;
    // "Deadline" with nothing dated would leave the list untouched and read as broken, so
    // it stays in the dropdown disabled, and a stored pick of it falls back.
    const available = hasSortableDeadline(rows, undated.effectiveValues)
      ? INBOX_SORT_MODES
      : INBOX_SORT_MODES.filter((mode) => mode !== TaskSortKey.Due);
    const { sortBy, dir } = this.resolveSort(available);

    // What the inbox says when it holds no line of its own. The undated tasks aren't
    // inbox items and can't stand in for one.
    const emptyText = items.length === 0
      ? "Inbox is empty"
      : shown.length === 0
        ? `Nothing left to triage — ${hiddenCount} planned item${hiddenCount === 1 ? "" : "s"} hidden`
        : null;

    // ── Task list ─────────────────────────────────────────────────────────────
    // The bar carries the note link, so it stays; only the ordering controls come and go.
    // Grouped as the dashboard's navigator buttons are, which leaves the link the bar's
    // middle column and so the same place as the other tabs' labels.
    const bar = container.createDiv({ cls: "pm-inbox-sort-bar" });
    // Nothing to narrow with no project task at all, and the filter's own doing is no
    // reason to drop the button that undoes it. It takes the bar's leading column, away
    // from the controls that order the list.
    if (undated.tasks.length > 0) {
      this.renderProjectFilter(bar.createDiv({ cls: "pm-dash-bar-lead" }), {
        projects,
        withUndated: new Set(undated.tasks.map((task) => task.projectId)),
        hiddenProjects,
        hiddenTasks: undatedHidden,
      });
    }
    this.renderFileLink(bar, resolvedPath);
    const controls = bar.createDiv({ cls: "pm-dash-bar-trail" });

    if (emptyText && undatedShown.length === 0) {
      // The controls are what unhide the planned items, so they stay while there are any.
      if (items.length > 0) this.renderSortControls(controls, available, sortBy, dir, hidePlanned, hiddenCount);
      const text = filterNote ? `${emptyText} — ${filterNote}` : emptyText;
      container.createDiv({ cls: "pm-dash-empty", text });
    } else {
      this.renderSortControls(controls, available, sortBy, dir, hidePlanned, hiddenCount);
      const projectMap = new Map(projects.map((p) => [p.id, p]));
      const list = new TaskList((task, ul, lead) => {
        if (task instanceof Task) {
          this.renderInboxRow(ul, task, resolvedPath, staleAfterDays, habitsTag, projects, lead);
        } else {
          this.renderProjectTaskRow(ul, task as ProjectTask, projectMap, undated.effectiveValues, true);
        }
      });
      // Sorted here rather than trusted as handed over: merged, the project tasks have to
      // take their place among the inbox's own lines.
      list.addAll(sortInboxItems(rows, sortBy, dir, undated.effectiveValues));
      // The section stays while any project task exists, filtered out or not: gone, it
      // would read as none existing rather than none passing the filter.
      const split = !merged && undated.tasks.length > 0;
      // Merged, the list names nothing, so a note about the inbox's lines would read as a
      // claim about every row under it.
      this.renderInboxList(container, list, resolvedPath, sortBy, dir, split, split ? emptyText : null);
      if (split) {
        const { body } = this.createCollapsibleSection(container, UNDATED_TITLE, "inbox.undated", {
          tooltip: UNDATED_TOOLTIP,
        });
        if (undatedShown.length > 0) {
          // The Inbox's own gutter, so this list lines up with the one above it.
          this.taskListOf(undatedShown, projectMap, undated.effectiveValues)
            .render(body, { cls: "pm-inbox-list" });
        }
        // What the filter is keeping out, said whether or not anything got through: a list
        // that names none of what it drops reads as all there is.
        if (filterNote) body.createDiv({ cls: "pm-dash-empty", text: filterNote });
      } else if (filterNote) {
        // Merged, the held-back tasks would otherwise leave the one list with no trace of
        // them at all.
        container.createDiv({ cls: "pm-dash-empty", text: filterNote });
      }
    }

    this.renderAddBar(container, "➕ Add a task…", (title) => this.plugin.tasks.addInboxItem(title));
  }

  /** A link to the note this tab is a view of, so hand-editing it means no hunt through
   *  the file explorer. */
  private renderFileLink(bar: HTMLElement, resolvedPath: string): void {
    const link = bar.createEl("a", {
      cls: "pm-inbox-file-link",
      attr: { href: "#", title: `Open ${resolvedPath}`, "aria-label": `Open ${resolvedPath}` },
    });
    // setIcon replaces the element's contents, so the icon gets its own span.
    setIcon(link.createSpan({ cls: "pm-inbox-file-icon" }), Icon.InboxNote);
    link.createSpan({ cls: "pm-inbox-file-name", text: basenameOf(resolvedPath) });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      // A modifier-click gets its own tab, as on any link.
      const newLeaf = e.ctrlKey || e.metaKey;
      // An inbox nothing has been added to has no file yet.
      void ensureNote(this.app, resolvedPath).then((file) => {
        if (file) openNoteFile(this.app, resolvedPath, newLeaf);
        else new Notice("Couldn't open the inbox note");
      });
    });
  }

  /** The inbox's own list, titled only when the undated tasks sit in one of their own
   *  below it. `emptyText` only reads right under that title. */
  private renderInboxList(
    container: HTMLElement,
    list: TaskList,
    resolvedPath: string,
    sortBy: TaskSortKey,
    dir: TaskSortDir,
    titled: boolean,
    emptyText: string | null,
  ): void {
    const body = titled
      ? this.createCollapsibleSection(container, "Inbox items", "inbox.items", {
          tooltip: "Untriaged tasks: schedule, promote or close each one.",
        }).body
      : container;
    if (emptyText) body.createDiv({ cls: "pm-dash-empty", text: emptyText });
    list.render(body, {
      cls: "pm-inbox-list",
      // Only file order is one the file can hold; another mode would recompute itself on
      // the next refresh and undo the move.
      reorder: sortBy === TaskSortKey.File
        ? { canMove: (task) => task instanceof Task, onDrop: this.inboxDrop(resolvedPath, dir) }
        : undefined,
    });
  }

  /** A list of project-task rows alone, drawn as the dashboard draws them. */
  private taskListOf(
    tasks: ProjectTask[],
    projectMap: Map<string, Project>,
    effectiveValues: Map<string, EffectiveValues>,
  ): TaskList {
    return new TaskList(
      (task, ul) => this.renderProjectTaskRow(ul, task as ProjectTask, projectMap, effectiveValues, true),
    ).addAll(tasks);
  }

  /** One untriaged inbox line on `renderRowShell`'s skeleton, adding only the badges and
   *  actions the Inbox puts at its ends. */
  private renderInboxRow(
    list: HTMLElement,
    item: Task,
    resolvedPath: string,
    staleAfterDays: number,
    habitsTag: string,
    projects: Project[],
    lead: { addDragHandle: AddDragHandle<Task>; movable: boolean },
  ): void {
    const isDailyItem = item.hasTag(habitsTag);

    this.renderRowShell(list, item, {
      cls: "pm-inbox-row",
      titleCls: "pm-inbox-title",
      habitsTag,
      filePath: resolvedPath,
      addDragHandle: (parent, row, draggable) => lead.addDragHandle(parent, row, item, draggable),
      movable: lead.movable,
      ...this.checklistSlots(item, resolvedPath, habitsTag),
      toggleLabel: "Close task",
      onToggle: () => this.runMutation(
        () => this.plugin.tasks.closeInboxItem(item),
        "Couldn't close the task",
      ),
      badges: (main) => {
        // Only opened with something to put in it: an empty band is still a flex item,
        // and would spend the row's gap for nothing.
        const badges = item.dueDate || item.scheduledDate || item.createdAt
          ? createBadgeBand(main)
          : main;

        // Its deadline, which the "Deadline" sort orders by — a row shows its sort key.
        if (item.dueDate) {
          const due = item.dueDate;
          this.renderDateBadge(badges, due, {
            title: `Deadline: ${formatDate(due)} — show that day`,
            onClick: () => this.showDay(due),
          });
        }

        // The day the item waits for, until that daily note exists. A day already gone is
        // the warning the age badge no longer gives a planned item.
        if (item.scheduledDate) {
          const planned = item.scheduledDate;
          const label = formatDate(planned);
          const missed = diffDays(new Date(), planned) < 0;
          renderMetaBadge(badges, {
            text: `⏳ ${formatPattern(planned, "MMM D")}`,
            tone: missed ? BadgeTone.Danger : BadgeTone.Neutral,
            title: missed
              ? `Planned for ${label}, which went by with no daily note — show that day`
              : `Planned for ${label} — moves there once that daily note exists; show that day`,
            onClick: () => this.showDay(planned),
          });
        }

        if (item.createdAt) {
          const created = item.createdAt;
          const label = formatDate(created);
          const daysOld = diffDays(created, new Date());
          // The badge every row uses; only the threshold is the Inbox's own. A planned
          // item goes `quiet`, showing its age without the alarm (see `isStaleInboxItem`).
          this.renderDateBadge(badges, created, {
            warnAfterDays: staleAfterDays,
            quiet: item.scheduledDate != null,
            title: `Created on ${label} — show that day`,
            warnTitle: `In inbox for ${daysOld} days (threshold: ${staleAfterDays}) — created on ${label}, show that day`,
            onClick: () => this.showDay(created),
          });
        }
      },
      actions: (main, row, titleSpan) => {
        const actions = main.createDiv({ cls: "pm-task-actions pm-inbox-actions" });

        if (!isDailyItem) {
          appendEditTitleButton(
            actions, main, titleSpan,
            dayTaskTitleEdit(
              item, resolvedPath, this.plugin.tasks,
              "pm-inbox-title", this.openNoteKeys, () => this.onRefresh(),
            ),
          );
          // Habits are regenerated from their definition, so promoting one strands it.
          const promoteBtn = actions.createEl("button", {
            cls: "pm-task-action-btn",
            attr: { "aria-label": "Promote to project task" },
          });
          promoteBtn.title = "Promote to a project task";
          setIcon(promoteBtn, Icon.PromoteToProjectTask);
          promoteBtn.addEventListener("click", () => this.openPromoteModal(item, resolvedPath, projects, habitsTag));
        }

        appendNoteActionButton(
          actions, row, item, resolvedPath, this.app, this.plugin.tasks, this.openNoteKeys,
          this.plugin.settings.confirmNoteRemoval, () => this.onRefresh(),
        );

        appendRescheduleButton(
          actions,
          (date) => {
            this.runMutation(
              async () => {
                const outcome = await this.plugin.tasks.scheduleInboxItem(item, date);
                // The item stays put here, so say so rather than leave the refreshed list
                // looking like the click did nothing. A past day promises no move.
                if (outcome === ScheduleOutcome.Targeted) {
                  const label = formatPattern(date, "MMM D");
                  new Notice(diffDays(new Date(), date) < 0
                    ? `${label} has no daily note — the task stays in the inbox, targeted for that day.`
                    : `Targeted for ${label} — it moves there once that daily note exists.`);
                }
              },
              "Couldn't schedule the task",
            );
          },
          { ariaLabel: "Schedule", title: "Schedule for a day" },
          item.scheduledDate ?? undefined,
          item.scheduledDate
            ? () => this.runMutation(
                () => this.plugin.tasks.unscheduleInboxItem(item),
                "Couldn't clear the target date",
              )
            : undefined,
        );

        const deleteBtn = actions.createEl("button", {
          cls: "pm-task-action-btn pm-task-action-btn--delete",
          attr: { "aria-label": "Delete" },
        });
        setIcon(deleteBtn, Icon.DeleteTask);
        deleteBtn.addEventListener("click", () => {
          confirmAction(this.app, this.plugin.settings.confirmDeletes, `Delete "${item.title}"?`, () => {
            this.runMutation(() => this.plugin.tasks.removeInboxItem(item), "Couldn't delete the task");
          });
        });
      },
    });
  }


  /** The sort mode and direction in effect. The mode is narrowed against what is on
   *  offer, so nothing outside it reaches the label lookups, one of which would throw. */
  private resolveSort(available: TaskSortKey[]): { sortBy: TaskSortKey; dir: TaskSortDir } {
    const stored = this.plugin.settings.inboxSortBy;
    const sortBy = available.includes(stored) ? stored : TaskSortKey.Created;
    return { sortBy, dir: resolveTaskSortDir(sortBy, this.plugin.settings.inboxSortDir) };
  }

  /** Persists a drag in the inbox file. "Reversed" reads the file bottom-up, so the task
   *  the dragged one must now precede on disk is the one shown *above* the drop. */
  private inboxDrop(resolvedPath: string, dir: TaskSortDir) {
    return ({ item, prev, next }: ReorderDrop<Task>) => {
      const anchor = dir === TaskSortDir.Asc ? next : prev;
      this.runMutation(
        () => this.plugin.tasks.reorderChecklistItem(resolvedPath, item, anchor),
        "Couldn't reorder the task",
      );
    };
  }

  /** The list's ordering controls: a button opening the mode dropdown, then an arrow
   *  toggling that mode's direction. Both persist to settings. */
  private renderSortControls(
    bar: HTMLElement,
    /** The modes this list can be sorted by. The dropdown offers them all, the rest
     *  disabled — a missing mode reads as one that never existed. */
    available: TaskSortKey[],
    sortBy: TaskSortKey,
    dir: TaskSortDir,
    hidePlanned: boolean,
    hiddenCount: number,
  ): void {
    const label = INBOX_SORT_LABELS[sortBy];
    const btn = bar.createEl("button", {
      cls: "pm-inbox-sort-btn",
      attr: { "aria-label": `Change sort order — sorted by ${label}`, title: INBOX_SORT_CHAINS[sortBy] },
    });
    btn.createSpan({ text: label });
    btn.addEventListener("click", () => {
      openDropdown(
        btn,
        INBOX_SORT_MODES.map((mode) => ({
          label: INBOX_SORT_LABELS[mode],
          selected: mode === sortBy,
          disabled: !available.includes(mode),
          // Deadline is the only mode a list can leave with nothing to sort on.
          title: available.includes(mode)
            ? INBOX_SORT_CHAINS[mode]
            : "Nothing in this list carries a deadline",
          onSelect: () => {
            if (mode === sortBy) return;
            this.plugin.settings.inboxSortBy = mode;
            this.runMutation(() => this.plugin.saveSettings(), "Couldn't change the sort order");
          },
        })),
      );
    });

    // The tooltip names the direction in effect, as the arrow does, then what a click
    // would give.
    const flipped = dir === TaskSortDir.Asc ? TaskSortDir.Desc : TaskSortDir.Asc;
    const dirLabel = `${INBOX_SORT_DIR_LABELS[sortBy][dir]} — click for ${INBOX_SORT_DIR_LABELS[sortBy][flipped]}`;
    const dirBtn = bar.createEl("button", {
      cls: "pm-inbox-sort-dir-btn",
      attr: { "aria-label": dirLabel, title: dirLabel },
    });
    setIcon(dirBtn, dir === TaskSortDir.Asc ? Icon.SortAscending : Icon.SortDescending);
    dirBtn.addEventListener("click", () => {
      this.plugin.settings.inboxSortDir = { ...this.plugin.settings.inboxSortDir, [sortBy]: flipped };
      this.runMutation(() => this.plugin.saveSettings(), "Couldn't change the sort order");
    });

    // Like the direction button, the label names what a click would do, not the state.
    const filterLabel = hidePlanned
      ? `Show planned items${hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}`
      : "Hide planned items";
    const filterBtn = bar.createEl("button", {
      cls: `pm-inbox-filter-btn${hidePlanned ? " pm-inbox-filter-btn--active" : ""}`,
      attr: { "aria-label": filterLabel, title: filterLabel },
    });
    setIcon(filterBtn, hidePlanned ? Icon.PlannedHidden : Icon.PlannedShown);
    filterBtn.addEventListener("click", () => {
      this.plugin.settings.inboxHidePlanned = !hidePlanned;
      this.runMutation(() => this.plugin.saveSettings(), "Couldn't change the filter");
    });
  }

  /** The project picker: a button naming what the project tasks are narrowed to, opening a
   *  multiple choice that stays up while several projects are ticked. */
  private renderProjectFilter(bar: HTMLElement, state: ProjectFilterState): void {
    const { projects, withUndated, hiddenProjects, hiddenTasks } = state;
    // Counted among the projects on offer, so a stored id left by a project since archived
    // neither narrows the button nor stands for a project of the count that isn't there.
    const count = projects.filter((p) => !hiddenProjects.includes(p.id)).length;
    const narrowed = count < projects.length;
    // The state, not what a click would do: a picker has no one next state to name.
    const label = narrowed
      ? `${count} of ${projects.length} project${projects.length === 1 ? "" : "s"}`
        + `${hiddenTasks > 0 ? ` — ${hiddenTasks} task${hiddenTasks === 1 ? "" : "s"} hidden` : ""}`
      : "All projects";
    const btn = bar.createEl("button", {
      cls: `pm-inbox-project-btn${narrowed ? " pm-inbox-project-btn--active" : ""}`,
      attr: { "aria-label": `Filter by project — ${label}`, title: `Filter by project — ${label}` },
    });
    setIcon(btn, narrowed ? Icon.ProjectFilterNarrowed : Icon.ProjectFilterAll);

    // The settings are what the open picker reads back, so a tick sees the ones before it
    // whatever the redraw behind it did.
    const stored = (): string[] => this.plugin.settings.inboxHiddenProjects ?? [];
    const shows = (id: string): boolean => !stored().includes(id);
    const allShown = (): boolean => projects.every((p) => shows(p.id));
    const apply = (hide: string[]): void => {
      // Written from the projects there are, so an id left by one since archived drops off
      // rather than hiding it again were it ever brought back.
      this.plugin.settings.inboxHiddenProjects = projects
        .filter((p) => hide.includes(p.id))
        .map((p) => p.id);
      this.runMutation(() => this.plugin.saveSettings(), "Couldn't change the project filter");
    };

    btn.addEventListener("click", () => {
      this.closeProjectPicker = openDropdown(btn, [
        {
          label: "All projects",
          selected: allShown,
          // Ticked already, it unticks, as any other row does — which is how the list is
          // cleared before ticking back only the one or two projects wanted.
          onSelect: () => apply(allShown() ? projects.map((p) => p.id) : []),
        },
        ...projects.map((project) => ({
          label: project.title,
          color: project.color,
          // A ticked project is a shown one, so with nothing hidden they all read as ticked.
          selected: () => shows(project.id),
          // Pickable whether or not it holds one: it says what the inbox would show, and a
          // task with no deadline can be given one at any time.
          title: withUndated.has(project.id) ? undefined : "No undated task in this project",
          onSelect: () => {
            const hidden = projects.filter((p) => !shows(p.id)).map((p) => p.id);
            apply(shows(project.id)
              ? [...hidden, project.id]
              : hidden.filter((id) => id !== project.id));
          },
        })),
      ], { keepOpen: true });
    });
  }

  /** Staying open costs the picker the watch that followed its button out of the document,
   *  so the view that owns it closes it rather than leaving it floating over what comes
   *  next. A dismiss already run does nothing. */
  dispose(): void {
    this.closeProjectPicker?.();
    this.closeProjectPicker = undefined;
    super.dispose();
  }
}
