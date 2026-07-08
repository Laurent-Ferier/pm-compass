import { Notice } from "obsidian";
import { ConfirmModal } from "./task-creator";
import { DayTask, formatDate, resolveHabitsTag } from "../model/day-task";
import { removeInboxItem, closeInboxItem, scheduleInboxItem, appendInboxItem, isWithinPlanningWindow } from "../model/day-task-actions";
import { BaseTabView } from "./base-tab-view";
import {
  renderTaskTitle,
  appendEditTitleButton,
  renderNoteChevron,
  appendNoteActionButton,
  appendRescheduleButton,
  attachActionsTapToggle,
} from "./day-task-row";
import { DAILY_ICON_SVG, TRASH_SVG, setSvgIcon } from "./icons";

/** Items older than this show the "old" (red) age badge, regardless of the
 *  configurable `staleAfterDays` warning threshold — the two are independent:
 *  this is a fixed visual escalation, `staleAfterDays` is a user-tunable warning. */
const OLD_AGE_DAYS = 14;

export class InboxView extends BaseTabView {
  async render(
    container: HTMLElement,
    resolvedPath: string,
    items: DayTask[],
    staleAfterDays: number,
  ): Promise<void> {
    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);

    // ── Task list ─────────────────────────────────────────────────────────────
    if (items.length === 0) {
      container.createDiv({ cls: "pm-dash-empty", text: "Inbox is empty" });
    } else {
      const list = container.createDiv({ cls: "pm-inbox-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: "pm-day-task-row pm-inbox-row" });
        attachActionsTapToggle(row);

        const main = row.createDiv({ cls: "pm-day-task-row-main" });

        const cb = main.createEl("input", {
          type: "checkbox",
          cls: "pm-inbox-cb",
          attr: { "aria-label": "Close task" },
        });
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          void closeInboxItem(this.app, resolvedPath, item).then(() => this.onRefresh());
        });

        const isDailyItem = item.tags.includes(`#${habitsTag}`);
        const titleSpan = renderTaskTitle(main, item.habitMatchTitle(habitsTag), this.app, this.plugin, "pm-inbox-title");

        if (isDailyItem) {
          const icon = main.createSpan({ cls: "pm-inbox-daily-icon" });
          setSvgIcon(icon, DAILY_ICON_SVG);
        }

        renderNoteChevron(main, row, item, resolvedPath, this.app, this.plugin, this.openNoteKeys, () => this.onRefresh());

        if (item.createdAt) {
          const daysOld = Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000);
          const isStale = staleAfterDays > 0 && daysOld >= staleAfterDays;
          if (isStale) {
            const warn = main.createSpan({ cls: "pm-inbox-stale-warn", text: "⚠️" });
            warn.title = `In inbox for ${daysOld} days (threshold: ${staleAfterDays})`;
          }
          const badge = main.createSpan({
            cls: `pm-inbox-age${daysOld > OLD_AGE_DAYS ? " pm-inbox-age--old" : ""}`,
            text: `${daysOld} d`,
          });
          badge.title = `Created on ${formatDate(item.createdAt)}`;
        }

        const actions = main.createDiv({ cls: "pm-day-task-actions pm-inbox-actions" });

        if (!isDailyItem) {
          appendEditTitleButton(
            actions, main, titleSpan, item, resolvedPath, this.app,
            "pm-inbox-title", this.openNoteKeys, () => this.onRefresh(),
          );
        }
        appendNoteActionButton(actions, row, item, resolvedPath, this.app, this.openNoteKeys, () => this.onRefresh());

        appendRescheduleButton(
          actions,
          (date) => {
            if (!isDailyItem) {
              const check = isWithinPlanningWindow(date, this.plugin.settings.smallTaskMaxWeeksAhead);
              if (!check.valid) {
                new Notice(check.reason!);
                return;
              }
            }
            void scheduleInboxItem(this.app, resolvedPath, item, date, this.plugin.settings.dailyTasksHeading).then(() => this.onRefresh());
          },
          { ariaLabel: "Schedule", title: "Schedule for a day" },
        );

        const deleteBtn = actions.createEl("button", {
          cls: "pm-day-task-action-btn pm-day-task-action-btn--delete",
          attr: { "aria-label": "Delete" },
        });
        setSvgIcon(deleteBtn, TRASH_SVG);
        deleteBtn.addEventListener("click", () => {
          new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
            void removeInboxItem(this.app, resolvedPath, item).then(() => this.onRefresh());
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
          .finally(() => { addInput.disabled = false; });
      }
    });
  }
}
