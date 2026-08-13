import { sameDay, startOfDay } from "../model/dates";
import { firstDayOfWeek, formatPattern, weekdayInitials } from "../model/date-format";
import { setIcon } from "obsidian";
import { Icon } from "./icons";
import { openAnchoredPopup } from "./anchored-popup";

/**
 * A self-contained calendar popup, for rescheduling tasks and driving the dashboard's
 * date navigator. Where it is drawn and what dismisses it are `openAnchoredPopup`'s.
 */

export interface DatePickerOptions {
  /** Date shown/selected when the picker opens. Defaults to today. */
  initial?: Date;
  /** Called with the chosen day when the user picks one; the popup then closes. */
  onPick: (date: Date) => void;
  /** When given, the footer offers a "Clear" button that calls this and closes.
   *  Omitted where there is no date to clear (the dashboard's date navigator). */
  onClear?: () => void;
}

/** The same day-of-month `months` on, clamped to that month's length — so paging from the
 *  31st lands on the 30th rather than skipping a month, as `setMonth` alone would. */
function shiftMonth(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
}

/** Opens a calendar popup anchored to `anchor`. Returns a `close()` function. */
export function openDatePicker(anchor: HTMLElement, opts: DatePickerOptions): () => void {
  const { el: popup, close, position } = openAnchoredPopup(anchor, "pm-datepicker");

  const selected = startOfDay(opts.initial ?? new Date());
  // The first of the displayed month, which is what the grid is laid out from.
  let view = new Date(selected.getFullYear(), selected.getMonth(), 1);

  const pick = (day: Date): void => {
    opts.onPick(day);
    close();
  };

  const render = (): void => {
    popup.empty();

    // ── Header: month label + prev/next month ──
    const header = popup.createDiv({ cls: "pm-datepicker-header" });
    const prev = header.createEl("button", { cls: "pm-datepicker-nav", attr: { "aria-label": "Previous month" } });
    setIcon(prev, Icon.PreviousMonth);
    prev.addEventListener("click", () => { view = shiftMonth(view, -1); render(); });

    header.createSpan({ cls: "pm-datepicker-title", text: formatPattern(view, "MMMM YYYY") });

    const next = header.createEl("button", { cls: "pm-datepicker-nav", attr: { "aria-label": "Next month" } });
    setIcon(next, Icon.NextMonth);
    next.addEventListener("click", () => { view = shiftMonth(view, 1); render(); });

    const grid = popup.createDiv({ cls: "pm-datepicker-grid" });

    // ── Weekday headings, honouring the locale's first day of week ──
    const firstDow = firstDayOfWeek();
    for (const wd of weekdayInitials()) grid.createSpan({ cls: "pm-datepicker-weekday", text: wd });

    // ── Leading blanks so day 1 lands under the right weekday ──
    const startOffset = (view.getDay() - firstDow + 7) % 7;
    for (let i = 0; i < startOffset; i++) grid.createSpan({ cls: "pm-datepicker-day pm-datepicker-day--blank" });

    const today = new Date();
    // Day 0 of the next month is the last of this one.
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const day = new Date(view.getFullYear(), view.getMonth(), d);
      const cell = grid.createEl("button", { cls: "pm-datepicker-day", text: String(d) });
      if (sameDay(day, today)) cell.addClass("pm-datepicker-day--today");
      if (sameDay(day, selected)) cell.addClass("pm-datepicker-day--selected");
      cell.addEventListener("click", () => pick(day));
    }

    // ── Footer shortcuts ──
    const footer = popup.createDiv({ cls: "pm-datepicker-footer" });
    // Clear on the left, away from the day grid's bottom-right corner, so a mis-click
    // while aiming at a date can't silently unplan the task.
    if (opts.onClear) {
      const clearBtn = footer.createEl("button", { cls: "pm-datepicker-clear", text: "Clear" });
      clearBtn.addEventListener("click", () => { opts.onClear!(); close(); });
    }

    const todayBtn = footer.createEl("button", { cls: "pm-datepicker-today", text: "Today" });
    todayBtn.addEventListener("click", () => pick(startOfDay(new Date())));
  };

  render();
  position();
  return close;
}
