import { Notice, setIcon } from "obsidian";
import { ConfirmModal, openDropdown } from "./task-creator";
import { diffDays, formatDate } from "../model/dates";
import { formatPattern } from "../model/date-format";
import { DayTask, resolveHabitsTag } from "../model/day-task";
import {
  removeInboxItem, closeInboxItem, scheduleInboxItem, appendInboxItem, unscheduleInboxItem,
  resolveInboxSortDir, reorderChecklistItem, sortInboxItems, hasSortableDeadline,
} from "../model/day-task-actions";
import { InboxSortBy, InboxSortDir, ScheduleOutcome } from "../model/task-vocabulary";
import type { Project, Task } from "../model/shared";
import { selectUndatedTasks, type EffectiveValues } from "../model/task-scoring";
import { TaskList } from "./task-list";
import { BaseTabView } from "./base-tab-view";
import {
  appendEditTitleButton,
  dayTaskTitleEdit,
  appendNoteActionButton,
  appendRescheduleButton,
} from "./day-task-row";
import { PROMOTE_SVG, TRASH_SVG, setSvgIcon } from "./icons";
import type { AddDragHandle, ReorderDrop } from "./drag-reorder";
import { BadgeTone, createBadgeBand, renderMetaBadge } from "./task-badges";

const UNDATED_TITLE = "Project tasks with no deadline";
const UNDATED_TOOLTIP =
  "Prioritized project tasks that nothing dates. Give one a deadline and it moves to the dashboard.";

/** Sort modes in the order the dropdown offers them, and their button labels. */
const INBOX_SORT_MODES: InboxSortBy[] = [
  InboxSortBy.Created, InboxSortBy.Priority, InboxSortBy.Due, InboxSortBy.Title, InboxSortBy.File,
];
const INBOX_SORT_LABELS: Record<InboxSortBy, string> = {
  [InboxSortBy.Created]: "Created",
  [InboxSortBy.Priority]: "Priority",
  [InboxSortBy.Due]: "Deadline",
  [InboxSortBy.Title]: "Title",
  [InboxSortBy.File]: "Default",
};

/** What a mode actually orders by, for the mode button's tooltip: its own key, then what
 *  settles the rows that key can't tell apart. The final newest-first fallback is left out;
 *  it only ever decides between two otherwise identical rows. */
const INBOX_SORT_CHAINS: Record<InboxSortBy, string> = {
  [InboxSortBy.Created]: "Creation date, then priority",
  [InboxSortBy.Priority]: "Priority, then creation date",
  [InboxSortBy.Due]: "Deadline, then priority, then creation date",
  [InboxSortBy.Title]: "Title, then priority, then creation date",
  [InboxSortBy.File]: "File order, then creation date",
};

/** What each direction means for the mode it applies to, for the direction button's
 *  tooltip. */
const INBOX_SORT_DIR_LABELS: Record<InboxSortBy, Record<InboxSortDir, string>> = {
  [InboxSortBy.Created]: { [InboxSortDir.Asc]: "Oldest first", [InboxSortDir.Desc]: "Newest first" },
  [InboxSortBy.Priority]: { [InboxSortDir.Asc]: "Least urgent", [InboxSortDir.Desc]: "Most urgent" },
  [InboxSortBy.Due]: { [InboxSortDir.Asc]: "Soonest", [InboxSortDir.Desc]: "Latest" },
  [InboxSortBy.Title]: { [InboxSortDir.Asc]: "A → Z", [InboxSortDir.Desc]: "Z → A" },
  [InboxSortBy.File]: { [InboxSortDir.Asc]: "File order", [InboxSortDir.Desc]: "Reversed" },
};

export class InboxView extends BaseTabView {
  async render(
    container: HTMLElement,
    resolvedPath: string,
    items: DayTask[],
    staleAfterDays: number,
    projects: Project[] = [],
  ): Promise<void> {
    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);

    // Planned items are hidden, not dropped: the count drives the empty-state wording,
    // which would otherwise claim an inbox that still has items in it is empty.
    const hidePlanned = this.plugin.settings.inboxHidePlanned ?? false;
    const shown = hidePlanned ? items.filter((item) => !item.scheduledDate) : items;
    const hiddenCount = items.length - shown.length;

    // Project tasks nothing dates: the dashboard's horizons are days and its queue is
    // deadlines, so they wait here to be given one. Merged, they share the one list with
    // the inbox's own items; split, each list is named so neither is taken for the other.
    const undated = selectUndatedTasks(this.allTasks);
    const merged = this.plugin.settings.mergeDailyAndProjectTasks;

    // Everything the one list holds, which is what the sort applies to.
    const rows = merged ? [...shown, ...undated.tasks] : shown;
    // "Deadline" with nothing dated would leave the list untouched and read as broken. It
    // stays in the dropdown, disabled, and a stored pick of it falls back to the default.
    const available = hasSortableDeadline(rows, undated.effectiveValues)
      ? INBOX_SORT_MODES
      : INBOX_SORT_MODES.filter((mode) => mode !== InboxSortBy.Due);
    const { sortBy, dir } = this.resolveSort(available);

    // What the inbox has to say when it holds no line of its own — separately from the
    // undated tasks, which are not inbox items and so can't stand in for one.
    const emptyText = items.length === 0
      ? "Inbox is empty"
      : shown.length === 0
        ? `Nothing left to triage — ${hiddenCount} planned item${hiddenCount === 1 ? "" : "s"} hidden`
        : null;

    // ── Task list ─────────────────────────────────────────────────────────────
    if (emptyText && undated.tasks.length === 0) {
      // The bar is what unhides the planned items, so it stays while there are any.
      if (items.length > 0) this.renderSortBar(container, available, sortBy, dir, hidePlanned, hiddenCount);
      container.createDiv({ cls: "pm-dash-empty", text: emptyText });
    } else {
      this.renderSortBar(container, available, sortBy, dir, hidePlanned, hiddenCount);
      const projectMap = new Map(projects.map((p) => [p.id, p]));
      const list = new TaskList((task, ul, lead) => {
        if (task instanceof DayTask) {
          this.renderInboxRow(ul, task, resolvedPath, staleAfterDays, habitsTag, projects, lead);
        } else {
          this.renderProjectTaskRow(ul, task as Task, projectMap, undated.effectiveValues, true);
        }
      });
      // The view sorts what it shows rather than trusting the order it was handed: merged,
      // the project tasks have to take their place among the inbox's own lines.
      list.addAll(sortInboxItems(rows, sortBy, dir, undated.effectiveValues));
      const split = !merged && undated.tasks.length > 0;
      // Merged, the one list names nothing, so a note about the inbox's own lines reads as a
      // claim about the rows under it.
      this.renderInboxList(container, list, resolvedPath, sortBy, dir, split, split ? emptyText : null);
      if (split) {
        const { body } = this.createCollapsibleSection(container, UNDATED_TITLE, "inbox.undated", {
          tooltip: UNDATED_TOOLTIP,
        });
        // The Inbox's own gutter, so this list lines up with the one above it.
        this.taskListOf(undated.tasks, projectMap, undated.effectiveValues)
          .render(body, { cls: "pm-inbox-list" });
      }
    }

    this.renderAddBar(container, "➕ Add a task…", (title) => appendInboxItem(this.app, resolvedPath, title));
  }

  /** The inbox's own list, titled only when the undated project tasks sit in one of their
   *  own below it — one list needs no name. `emptyText` is what the inbox says when it has
   *  no line of its own, and only reads right under a name. */
  private renderInboxList(
    container: HTMLElement,
    list: TaskList,
    resolvedPath: string,
    sortBy: InboxSortBy,
    dir: InboxSortDir,
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
      // Only file order is one the file can hold; every other mode is a view of it, and
      // would recompute itself on the next refresh and undo the move.
      reorder: sortBy === InboxSortBy.File
        ? { canMove: (task) => task instanceof DayTask, onDrop: this.inboxDrop(resolvedPath, dir) }
        : undefined,
    });
  }

  /** A list of project-task rows alone, drawn as the dashboard draws them. */
  private taskListOf(
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValues: Map<string, EffectiveValues>,
  ): TaskList {
    return new TaskList(
      (task, ul) => this.renderProjectTaskRow(ul, task as Task, projectMap, effectiveValues, true),
    ).addAll(tasks);
  }

  /** One untriaged inbox line, drawn on `BaseTabView.renderDayTaskRow`'s skeleton — this
   *  adds only the badges and actions the Inbox puts at its ends. */
  private renderInboxRow(
    list: HTMLElement,
    item: DayTask,
    resolvedPath: string,
    staleAfterDays: number,
    habitsTag: string,
    projects: Project[],
    lead: { addDragHandle: AddDragHandle<DayTask>; movable: boolean },
  ): void {
    const isDailyItem = item.tags.includes(`#${habitsTag}`);

    this.renderDayTaskRow(list, item, {
      cls: "pm-inbox-row",
      titleCls: "pm-inbox-title",
      habitsTag,
      filePath: resolvedPath,
      addDragHandle: lead.addDragHandle,
      movable: lead.movable,
      toggleLabel: "Close task",
      onToggle: () => this.runMutation(
        () => closeInboxItem(this.app, resolvedPath, item),
        "Couldn't close the task",
      ),
      badges: (main) => {
        // Opened only when there is something to put in it — an empty band is still a
        // flex item, and would spend the row's 8px gap for nothing.
        const badges = item.dueDate || item.scheduledDate || item.createdAt
          ? createBadgeBand(main)
          : main;

        // Its deadline: what the "Deadline" sort orders by, and a row has to show the key
        // it is sorted on.
        if (item.dueDate) {
          const due = item.dueDate;
          this.renderDateBadge(badges, due, {
            title: `Deadline: ${formatDate(due)} — show that day`,
            onClick: () => this.showDay(due),
          });
        }

        // The day this item is waiting for: it lives here until that daily note exists.
        // A day already gone is the warning the age badge no longer gives a planned item —
        // that note never came, so the plan is the thing to act on.
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
          // The badge every row uses on either tab; only the threshold it warns at is the
          // Inbox's own. A planned item goes `quiet` — it shows its age without the alarm
          // or the red escalation (see `isStaleInboxItem`).
          this.renderDateBadge(badges, created, {
            warnAfterDays: staleAfterDays,
            quiet: item.scheduledDate != null,
            title: `Created on ${label} — show that day`,
            warnTitle: `In inbox for ${daysOld} days (threshold: ${staleAfterDays}) — created on ${label}, show that day`,
            onClick: () => this.showDay(created),
          });
        }
      },
      actions: (actions, row, titleSpan) => {
        const main = row.querySelector<HTMLElement>(".pm-day-task-row-main")!;
        actions.addClass("pm-inbox-actions");

        if (!isDailyItem) {
          appendEditTitleButton(
            actions, main, titleSpan,
            dayTaskTitleEdit(
              main, item, resolvedPath, this.app,
              "pm-inbox-title", this.openNoteKeys, () => this.onRefresh(),
            ),
          );
          // Habits are regenerated from their definition, so promoting one out of
          // the inbox into a project would only strand it.
          const promoteBtn = actions.createEl("button", {
            cls: "pm-task-action-btn",
            attr: { "aria-label": "Promote to project task" },
          });
          promoteBtn.title = "Promote to a project task";
          setSvgIcon(promoteBtn, PROMOTE_SVG);
          promoteBtn.addEventListener("click", () => this.openPromoteModal(item, resolvedPath, projects, habitsTag));
        }

        appendNoteActionButton(actions, row, item, resolvedPath, this.app, this.openNoteKeys, () => this.onRefresh());

        appendRescheduleButton(
          actions,
          (date) => {
            this.runMutation(
              async () => {
                const outcome = await scheduleInboxItem(
                  this.app, resolvedPath, item, date, this.plugin.settings.dailyTasksHeading,
                );
                // The item stays put in this case, so say where it went instead of leaving
                // the refreshed list looking like the click did nothing. A past day is
                // unlikely ever to get a note, so don't promise the item will move there.
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
                () => unscheduleInboxItem(this.app, resolvedPath, item),
                "Couldn't clear the target date",
              )
            : undefined,
        );

        const deleteBtn = actions.createEl("button", {
          cls: "pm-task-action-btn pm-task-action-btn--delete",
          attr: { "aria-label": "Delete" },
        });
        setSvgIcon(deleteBtn, TRASH_SVG);
        deleteBtn.addEventListener("click", () => {
          new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
            this.runMutation(() => removeInboxItem(this.app, resolvedPath, item), "Couldn't delete the task");
          }).open();
        });
      },
    });
  }


  /** The sort mode and direction in effect. The mode is narrowed against the modes on
   *  offer, so neither a stored value outside the enum nor one this list has nothing to
   *  sort on can reach the label lookups — one of them indexes twice and would throw. */
  private resolveSort(available: InboxSortBy[]): { sortBy: InboxSortBy; dir: InboxSortDir } {
    const stored = this.plugin.settings.inboxSortBy;
    const sortBy = available.includes(stored) ? stored : InboxSortBy.Created;
    return { sortBy, dir: resolveInboxSortDir(sortBy, this.plugin.settings.inboxSortDir) };
  }

  /** Persists a drag in the inbox file. "Reversed" reads the file bottom-up, so the task
   *  the dragged one must now precede on disk is the one shown *above* the drop. */
  private inboxDrop(resolvedPath: string, dir: InboxSortDir) {
    return ({ item, prev, next }: ReorderDrop<DayTask>) => {
      const anchor = dir === InboxSortDir.Asc ? next : prev;
      this.runMutation(
        () => reorderChecklistItem(this.app, resolvedPath, item, anchor),
        "Couldn't reorder the task",
      );
    };
  }

  /**
   * The list's ordering controls: a button opening the mode dropdown, then an arrow
   * toggling that mode's direction. Both persist to settings
   * (`inboxSortBy`/`inboxSortDir`); the reordering itself happens in `readInboxItems()`
   * on the refresh.
   */
  private renderSortBar(
    container: HTMLElement,
    /** The modes this list can actually be sorted by. The dropdown offers them all either
     *  way; the rest are disabled, since a mode missing altogether reads as one that never
     *  existed — see `render`. */
    available: InboxSortBy[],
    sortBy: InboxSortBy,
    dir: InboxSortDir,
    hidePlanned: boolean,
    hiddenCount: number,
  ): void {
    const bar = container.createDiv({ cls: "pm-inbox-sort-bar" });

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
          // Deadline is the only mode a list can leave with nothing to sort on, so its
          // reason is the only one there is to give.
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

    // The arrow shows the direction in effect, so the tooltip says the same thing — naming
    // the flipped one there made the two halves of one control contradict each other. What
    // a click would give is spelled out after it.
    const flipped = dir === InboxSortDir.Asc ? InboxSortDir.Desc : InboxSortDir.Asc;
    const dirLabel = `${INBOX_SORT_DIR_LABELS[sortBy][dir]} — click for ${INBOX_SORT_DIR_LABELS[sortBy][flipped]}`;
    const dirBtn = bar.createEl("button", {
      cls: "pm-inbox-sort-dir-btn",
      attr: { "aria-label": dirLabel, title: dirLabel },
    });
    setIcon(dirBtn, dir === InboxSortDir.Asc ? "arrow-up" : "arrow-down");
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
    setIcon(filterBtn, hidePlanned ? "calendar-off" : "calendar-clock");
    filterBtn.addEventListener("click", () => {
      this.plugin.settings.inboxHidePlanned = !hidePlanned;
      this.runMutation(() => this.plugin.saveSettings(), "Couldn't change the filter");
    });
  }
}
