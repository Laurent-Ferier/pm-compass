import { Notice, setIcon } from "obsidian";
import { ConfirmModal, openDropdown } from "./task-creator";
import { DayTask, formatDate, resolveHabitsTag } from "../model/day-task";
import { moment } from "../model/moment";
import {
  removeInboxItem, closeInboxItem, scheduleInboxItem, appendInboxItem, unscheduleInboxItem,
  resolveInboxSortDir, reorderChecklistItem,
} from "../model/day-task-actions";
import { InboxSortBy, InboxSortDir, ScheduleOutcome } from "../model/task-vocabulary";
import type { Project } from "../model/shared";
import { BaseTabView } from "./base-tab-view";
import {
  renderTaskTitle,
  appendEditTitleButton,
  dayTaskTitleEdit,
  renderNoteChevron,
  appendNoteActionButton,
  appendRescheduleButton,
  attachActionsTapToggle,
} from "./day-task-row";
import { ALERT_SVG, DAILY_ICON_SVG, PROMOTE_SVG, TRASH_SVG, setSvgIcon } from "./icons";
import { createDragReorder, type AddDragHandle } from "./drag-reorder";
import { createBadgeBand, renderMetaBadge, BadgeTone } from "./task-badges";

/** Items older than this show the "old" (red) age badge, regardless of the
 *  configurable `staleAfterDays` warning threshold — the two are independent:
 *  this is a fixed visual escalation, `staleAfterDays` is a user-tunable warning. */
const OLD_AGE_DAYS = 14;

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
    const { sortBy, dir } = this.resolveSort();

    // Planned items are hidden, not dropped: the count drives the empty-state wording,
    // which would otherwise claim an inbox that still has items in it is empty.
    const hidePlanned = this.plugin.settings.inboxHidePlanned ?? false;
    const shown = hidePlanned ? items.filter((item) => !item.scheduledDate) : items;
    const hiddenCount = items.length - shown.length;

    // ── Task list ─────────────────────────────────────────────────────────────
    if (items.length === 0) {
      container.createDiv({ cls: "pm-dash-empty", text: "Inbox is empty" });
    } else if (shown.length === 0) {
      this.renderSortBar(container, sortBy, dir, hidePlanned, hiddenCount);
      container.createDiv({
        cls: "pm-dash-empty",
        text: `Nothing left to triage — ${hiddenCount} planned item${hiddenCount === 1 ? "" : "s"} hidden`,
      });
    } else {
      this.renderSortBar(container, sortBy, dir, hidePlanned, hiddenCount);
      const list = container.createDiv({ cls: "pm-inbox-list" });
      const addDragHandle = this.createDragHandles(list, resolvedPath, sortBy, dir, shown.length);
      for (const item of shown) {
        const row = list.createDiv({ cls: "pm-day-task-row pm-inbox-row" });
        attachActionsTapToggle(row);

        const main = row.createDiv({ cls: "pm-day-task-row-main" });

        addDragHandle?.(main, row, item);
        this.renderChecklistPriority(main, item, resolvedPath, habitsTag);

        const cb = main.createEl("input", {
          type: "checkbox",
          cls: "pm-inbox-cb",
          attr: { "aria-label": "Close task" },
        });
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          this.runMutation(() => closeInboxItem(this.app, resolvedPath, item), "Couldn't close the task");
        });

        const isDailyItem = item.tags.includes(`#${habitsTag}`);
        const titleSpan = renderTaskTitle(main, item.habitMatchTitle(habitsTag), this.app, this.plugin, "pm-inbox-title");

        if (isDailyItem) {
          const icon = main.createSpan({ cls: "pm-inbox-daily-icon" });
          setSvgIcon(icon, DAILY_ICON_SVG);
        }

        renderNoteChevron(main, row, item, resolvedPath, this.app, this.plugin, this.openNoteKeys, () => this.onRefresh());

        // Opened only when there is something to put in it — an empty band is still a
        // flex item, and would spend the row's 8px gap for nothing.
        const badges = item.scheduledDate || item.createdAt ? createBadgeBand(main) : main;

        // The day this item is waiting for: it lives here until that day's note exists.
        if (item.scheduledDate) {
          renderMetaBadge(badges, {
            text: `⏳ ${moment(item.scheduledDate).format("MMM D")}`,
            title: `Planned for ${formatDate(item.scheduledDate)} — moves to that day once its note exists`,
          });
        }

        if (item.createdAt) {
          const daysOld = Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000);
          // Two independent signals on one badge: the tone escalates with the fixed
          // "old" threshold, the alert glyph appears at the user's own stale threshold.
          const isStale = staleAfterDays > 0 && daysOld >= staleAfterDays;
          renderMetaBadge(badges, {
            text: `${daysOld} d`,
            icon: isStale ? ALERT_SVG : undefined,
            tone: daysOld > OLD_AGE_DAYS
              ? BadgeTone.Danger
              : isStale ? BadgeTone.Warning : BadgeTone.Neutral,
            title: isStale
              ? `In inbox for ${daysOld} days (threshold: ${staleAfterDays}) — created on ${formatDate(item.createdAt)}`
              : `Created on ${formatDate(item.createdAt)}`,
          });
        }

        const actions = main.createDiv({ cls: "pm-task-actions pm-inbox-actions" });

        if (!isDailyItem) {
          appendEditTitleButton(
            actions, main, titleSpan,
            dayTaskTitleEdit(
              main, item, resolvedPath, this.app,
              "pm-inbox-title", this.openNoteKeys, () => this.onRefresh(),
            ),
          );
        }
        // Habits are regenerated from their definition, so promoting one out of
        // the inbox into a project would only strand it.
        if (!isDailyItem) {
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
                // the refreshed list looking like the click did nothing. A past day never
                // gets a note of its own, so promising one would be a lie: `migrateInboxTargets`
                // files the item under today on the very next refresh.
                if (outcome === ScheduleOutcome.Targeted) {
                  new Notice(date.isBefore(moment(), "day")
                    ? `${date.format("MMM D")} has no note — the task moves to today instead.`
                    : `Targeted for ${date.format("MMM D")} — it moves there once that day's note exists.`);
                }
              },
              "Couldn't schedule the task",
            );
          },
          { ariaLabel: "Schedule", title: "Schedule for a day" },
          item.scheduledDate ? moment(item.scheduledDate) : undefined,
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
      }
    }

    // ── Add-task bar (sticky at bottom, above keyboard on mobile) ────────────
    const addBar = container.createDiv({ cls: "pm-inbox-add-bar" });
    const addInput = addBar.createEl("input", {
      type: "text",
      cls: "pm-inbox-add-input",
      attr: { placeholder: "➕ Add a task…" },
    });
    addInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const title = addInput.value.trim();
        if (!title) return;
        addInput.value = "";
        addInput.disabled = true;
        void appendInboxItem(this.app, resolvedPath, title)
          .then(() => this.onRefresh())
          .catch((e) => {
            console.error("pm-compass: couldn't add the task", e);
            new Notice("Couldn't add the task");
          })
          .finally(() => { addInput.disabled = false; });
      }
    });
  }

  /** The sort mode and direction in effect. The mode is narrowed against
   *  `INBOX_SORT_MODES`, so a stored value outside the enum can't reach the label
   *  lookups — one of them indexes twice and would throw on an unknown mode. */
  private resolveSort(): { sortBy: InboxSortBy; dir: InboxSortDir } {
    const stored = this.plugin.settings.inboxSortBy;
    const sortBy = INBOX_SORT_MODES.includes(stored) ? stored : InboxSortBy.Created;
    return { sortBy, dir: resolveInboxSortDir(sortBy, this.plugin.settings.inboxSortDir) };
  }

  /**
   * Wires `list` for drag-to-reorder, or returns undefined when reordering wouldn't stick.
   * Only the "Default" mode shows the file's own order: every other mode recomputes the
   * order from the items' own fields on the next refresh, which would silently undo the
   * move the moment it was made.
   */
  private createDragHandles(
    list: HTMLElement,
    resolvedPath: string,
    sortBy: InboxSortBy,
    dir: InboxSortDir,
    itemCount: number,
  ): AddDragHandle<DayTask> | undefined {
    if (sortBy !== InboxSortBy.File || itemCount < 2) return undefined;
    return createDragReorder<DayTask>(list, ({ item, prev, next }) => {
      // "Reversed" reads the file bottom-up, so the task the dragged one must now
      // precede on disk is the one shown *above* the drop, not below it.
      const anchor = dir === InboxSortDir.Asc ? next : prev;
      this.runMutation(
        () => reorderChecklistItem(this.app, resolvedPath, item, anchor),
        "Couldn't reorder the task",
      );
    });
  }

  /**
   * The list's ordering controls: a button opening the mode dropdown, then an arrow
   * toggling that mode's direction. Both persist to settings
   * (`inboxSortBy`/`inboxSortDir`); the reordering itself happens in `readInboxItems()`
   * on the refresh.
   */
  private renderSortBar(
    container: HTMLElement,
    sortBy: InboxSortBy,
    dir: InboxSortDir,
    hidePlanned: boolean,
    hiddenCount: number,
  ): void {
    const bar = container.createDiv({ cls: "pm-inbox-sort-bar" });

    const label = INBOX_SORT_LABELS[sortBy];
    const btn = bar.createEl("button", {
      cls: "pm-inbox-sort-btn",
      attr: { "aria-label": `Change sort order — sorted by ${label}`, title: "Change sort order" },
    });
    btn.createSpan({ text: label });
    btn.addEventListener("click", () => {
      openDropdown(
        btn,
        INBOX_SORT_MODES.map((mode) => ({
          label: INBOX_SORT_LABELS[mode],
          onSelect: () => {
            if (mode === sortBy) return;
            this.plugin.settings.inboxSortBy = mode;
            this.runMutation(() => this.plugin.saveSettings(), "Couldn't change the sort order");
          },
        })),
      );
    });

    // Icon only, so the tooltip carries the label — naming the order a click would give,
    // not the one in effect.
    const flipped = dir === InboxSortDir.Asc ? InboxSortDir.Desc : InboxSortDir.Asc;
    const flippedLabel = INBOX_SORT_DIR_LABELS[sortBy][flipped];
    const dirBtn = bar.createEl("button", {
      cls: "pm-inbox-sort-dir-btn",
      attr: { "aria-label": flippedLabel, title: flippedLabel },
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
