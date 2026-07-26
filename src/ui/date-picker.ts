import { moment, type Moment } from "../model/moment";
import { NAV_PREV_SVG, NAV_NEXT_SVG, setSvgIcon } from "./icons";

/**
 * A small, self-contained calendar popup used to reschedule tasks and drive the
 * dashboard date navigator. It replaces the native `<input type="date">` +
 * `showPicker()` approach, which we could neither position reliably (the native
 * popup could open outside the window) nor style, and which left the host button
 * stuck in its `:hover` state after the picker closed.
 *
 * The popup is appended to `document.body` so overflow-clipping ancestors can't
 * hide it, positioned against the anchor's bounding rect and clamped to the
 * viewport, and closed on outside pointerdown / Escape / scroll / resize.
 */

export interface DatePickerOptions {
  /** Date shown/selected when the picker opens. Defaults to today. */
  initial?: Moment;
  /** Called with the chosen day when the user picks one; the popup then closes. */
  onPick: (date: Moment) => void;
  /** When given, the footer offers a "Clear" button that calls this and closes.
   *  Omitted where there is no date to clear (the dashboard's date navigator). */
  onClear?: () => void;
}

const DP_GAP = 4; // px between the anchor and the popup

// Only one picker may be open at a time. Clicking the anchor again (or opening
// any other picker) closes the previous one instead of stacking a second popup.
let openPicker: (() => void) | null = null;

/** Opens a calendar popup anchored to `anchor`. Returns a `close()` function. */
export function openDatePicker(anchor: HTMLElement, opts: DatePickerOptions): () => void {
  openPicker?.();

  const selected = (opts.initial ? opts.initial.clone() : moment()).startOf("day");
  let view = selected.clone().startOf("month"); // first day of the displayed month

  const popup = document.body.createDiv({ cls: "pm-datepicker" });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (openPicker === close) openPicker = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", close, true);
    popup.remove();
  };

  const onOutside = (e: PointerEvent): void => {
    if (!popup.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  const pick = (day: Moment): void => {
    opts.onPick(day);
    close();
  };

  const render = (): void => {
    popup.empty();

    // ── Header: month label + prev/next month ──
    const header = popup.createDiv({ cls: "pm-datepicker-header" });
    const prev = header.createEl("button", { cls: "pm-datepicker-nav", attr: { "aria-label": "Previous month" } });
    setSvgIcon(prev, NAV_PREV_SVG);
    prev.addEventListener("click", () => { view = view.clone().subtract(1, "month"); render(); });

    header.createSpan({ cls: "pm-datepicker-title", text: view.format("MMMM YYYY") });

    const next = header.createEl("button", { cls: "pm-datepicker-nav", attr: { "aria-label": "Next month" } });
    setSvgIcon(next, NAV_NEXT_SVG);
    next.addEventListener("click", () => { view = view.clone().add(1, "month"); render(); });

    const grid = popup.createDiv({ cls: "pm-datepicker-grid" });

    // ── Weekday headings, honouring the locale's first day of week ──
    const firstDow = moment.localeData().firstDayOfWeek();
    const weekdays = moment.weekdaysMin(true); // already rotated to locale order
    for (const wd of weekdays) grid.createSpan({ cls: "pm-datepicker-weekday", text: wd });

    // ── Leading blanks so day 1 lands under the right weekday ──
    const startOffset = (view.day() - firstDow + 7) % 7;
    for (let i = 0; i < startOffset; i++) grid.createSpan({ cls: "pm-datepicker-day pm-datepicker-day--blank" });

    // Compare by formatted day-key rather than moment.isSame(): the latter has
    // proven unreliable across cloned moment instances in Obsidian's bundle.
    const DAY_KEY = "YYYY-MM-DD";
    const todayKey = moment().format(DAY_KEY);
    const selectedKey = selected.format(DAY_KEY);
    const daysInMonth = view.daysInMonth();
    for (let d = 1; d <= daysInMonth; d++) {
      const day = view.clone().date(d);
      const dayKey = day.format(DAY_KEY);
      const cell = grid.createEl("button", { cls: "pm-datepicker-day", text: String(d) });
      if (dayKey === todayKey) cell.addClass("pm-datepicker-day--today");
      if (dayKey === selectedKey) cell.addClass("pm-datepicker-day--selected");
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
    todayBtn.addEventListener("click", () => pick(moment().startOf("day")));
  };

  // Places the popup below the anchor by default, flipping above and shifting
  // left as needed so it stays inside the viewport. Called once on open (not on
  // month navigation) so paging through months doesn't make the popup jump —
  // and so we only ever measure the anchor while it's still laid out.
  const position = (): void => {
    const a = anchor.getBoundingClientRect();
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let top = a.bottom + DP_GAP;
    if (top + h > vh && a.top - DP_GAP - h >= 0) top = a.top - DP_GAP - h;
    top = Math.max(DP_GAP, Math.min(top, vh - h - DP_GAP));

    let left = a.left;
    if (left + w > vw - DP_GAP) left = vw - w - DP_GAP;
    left = Math.max(DP_GAP, left);

    popup.style.top = `${Math.round(top)}px`;
    popup.style.left = `${Math.round(left)}px`;
  };

  render();
  position();
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close);
  window.addEventListener("scroll", close, true);

  openPicker = close;
  return close;
}
