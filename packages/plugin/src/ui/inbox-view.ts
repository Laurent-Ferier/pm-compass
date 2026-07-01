import { moment as _moment } from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import { ConfirmModal } from "./task-creator";
import { DayTask, formatDate } from "../model/day-task";
import {
  BaseTabView,
  removeInboxItem,
  scheduleInboxItem,
  appendInboxItem,
  CALENDAR_SVG,
  TRASH_SVG,
} from "./dashboard-view";

export class InboxView extends BaseTabView {
  async render(
    container: HTMLElement,
    resolvedPath: string,
    items: DayTask[],
    staleAfterDays: number,
  ): Promise<void> {
    // ── Task list ─────────────────────────────────────────────────────────────
    if (items.length === 0) {
      container.createDiv({ cls: "pm-dash-empty", text: "Inbox is empty" });
    } else {
      const list = container.createDiv({ cls: "pm-inbox-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: "pm-day-task-row pm-inbox-row" });

        const cb = row.createEl("input", { type: "checkbox", cls: "pm-inbox-cb" });
        cb.addEventListener("change", () => {
          void removeInboxItem(this.app, resolvedPath, item).then(() => this.onRefresh());
        });

        row.createSpan({ cls: "pm-inbox-title", text: item.title });

        if (item.createdAt) {
          const daysOld = Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000);
          const isStale = staleAfterDays > 0 && daysOld >= staleAfterDays;
          if (isStale) {
            const warn = row.createSpan({ cls: "pm-inbox-stale-warn", text: "⚠️" });
            warn.title = `In inbox for ${daysOld} days (threshold: ${staleAfterDays})`;
          }
          const badge = row.createSpan({
            cls: `pm-inbox-age${daysOld > 14 ? " pm-inbox-age--old" : ""}`,
            text: `${daysOld} d`,
          });
          badge.title = `Created on ${formatDate(item.createdAt)}`;
        }

        const actions = row.createDiv({ cls: "pm-day-task-actions pm-inbox-actions" });

        const scheduleBtn = actions.createEl("button", {
          cls: "pm-inbox-btn",
          attr: { "aria-label": "Schedule" },
        });
        scheduleBtn.innerHTML = CALENDAR_SVG;
        const dateInput = actions.createEl("input", {
          type: "date",
          cls: "pm-inbox-date-picker",
        });
        dateInput.addEventListener("change", () => {
          if (!dateInput.value) return;
          const date = moment(dateInput.value, "YYYY-MM-DD");
          void scheduleInboxItem(this.app, resolvedPath, item, date).then(() =>
            this.onRefresh(),
          );
        });
        scheduleBtn.addEventListener("click", () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (dateInput as any).showPicker();
          } catch {
            dateInput.click();
          }
        });

        const deleteBtn = actions.createEl("button", {
          cls: "pm-inbox-btn pm-inbox-btn--delete",
          attr: { "aria-label": "Delete" },
        });
        deleteBtn.innerHTML = TRASH_SVG;
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
        void appendInboxItem(this.app, resolvedPath, title).then(() => this.onRefresh());
      }
    });
  }
}
