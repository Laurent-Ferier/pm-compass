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
  renderTaskTitle,
  appendEditTitleButton,
  renderNoteChevron,
  appendNoteActionButton,
  attachActionsTapToggle,
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
    const habitsTag = (this.plugin.settings.dailyHabitsTag || "daily").replace(/^#/, "");

    // ── Task list ─────────────────────────────────────────────────────────────
    if (items.length === 0) {
      container.createDiv({ cls: "pm-dash-empty", text: "Inbox is empty" });
    } else {
      const list = container.createDiv({ cls: "pm-inbox-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: "pm-day-task-row pm-inbox-row" });
        attachActionsTapToggle(row);

        const main = row.createDiv({ cls: "pm-day-task-row-main" });

        const cb = main.createEl("input", { type: "checkbox", cls: "pm-inbox-cb" });
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          void removeInboxItem(this.app, resolvedPath, item).then(() => this.onRefresh());
        });

        const isDailyItem = item.tags.includes(`#${habitsTag}`);
        const titleSpan = renderTaskTitle(main, item.title, this.app, this.plugin, "pm-inbox-title");

        renderNoteChevron(main, row, item, resolvedPath, this.app, this.plugin, this.openNoteKeys, () => this.onRefresh());

        if (item.createdAt) {
          const daysOld = Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000);
          const isStale = staleAfterDays > 0 && daysOld >= staleAfterDays;
          if (isStale) {
            const warn = main.createSpan({ cls: "pm-inbox-stale-warn", text: "⚠️" });
            warn.title = `In inbox for ${daysOld} days (threshold: ${staleAfterDays})`;
          }
          const badge = main.createSpan({
            cls: `pm-inbox-age${daysOld > 14 ? " pm-inbox-age--old" : ""}`,
            text: `${daysOld} d`,
          });
          badge.title = `Created on ${formatDate(item.createdAt)}`;
        }

        const actions = row.createDiv({ cls: "pm-day-task-actions pm-inbox-actions" });

        if (!isDailyItem) {
          appendEditTitleButton(
            actions, main, titleSpan, item, resolvedPath, this.app,
            "pm-inbox-title", this.openNoteKeys, () => this.onRefresh(),
          );
        }
        appendNoteActionButton(actions, row, item, resolvedPath, this.app, this.openNoteKeys, () => this.onRefresh());

        const scheduleBtn = actions.createEl("button", {
          cls: "pm-day-task-action-btn",
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
          cls: "pm-day-task-action-btn pm-day-task-action-btn--delete",
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

    // On mobile, the on-screen keyboard shrinks the visual viewport without
    // resizing the layout viewport, which can leave this sticky input hidden
    // behind the keyboard. Nudge it back into view on focus and once the
    // keyboard finishes animating in.
    //
    // visualViewport fires several intermediate "resize" events while the
    // keyboard animates, so debounce and use an instant (non-"smooth") scroll —
    // firing overlapping smooth-scroll animations back-to-back on Android
    // WebView can drop a compositor frame as solid black until it recovers.
    let resizeDebounce: ReturnType<typeof window.setTimeout> | null = null;
    const keepInputVisible = () => addInput.scrollIntoView({ block: "center" });
    const scheduleKeepInputVisible = () => {
      if (resizeDebounce !== null) window.clearTimeout(resizeDebounce);
      resizeDebounce = window.setTimeout(keepInputVisible, 150);
    };
    let onViewportResize: (() => void) | null = null;
    addInput.addEventListener("focus", () => {
      scheduleKeepInputVisible();
      if (window.visualViewport && !onViewportResize) {
        onViewportResize = scheduleKeepInputVisible;
        window.visualViewport.addEventListener("resize", onViewportResize);
      }
    });
    addInput.addEventListener("blur", () => {
      if (resizeDebounce !== null) {
        window.clearTimeout(resizeDebounce);
        resizeDebounce = null;
      }
      if (onViewportResize && window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onViewportResize);
        onViewportResize = null;
      }
    });
  }
}
