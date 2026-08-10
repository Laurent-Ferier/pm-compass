import { diffDays } from "./dates";
import { moment } from "./moment";

/**
 * The one place moment is used: rendering a `Date` as text and reading a filename back.
 * A formatting library here, not a date type — nothing outside this module holds a
 * `Moment`. Kept out of `dates.ts` so that module stays free of Obsidian imports.
 */

/** A day as text in one of moment's patterns: a row's label, or a daily note's filename
 *  under the vault's own format. */
export function formatPattern(date: Date, pattern: string): string {
  return moment(date).format(pattern);
}

/** Past this many days out, a date reads better than a count. */
const RELATIVE_DAYS = 7;

/** A date as a badge label: "today", "in 3d" within the week, the date itself beyond it,
 *  and for a reached one the days past, which `renderDaysBadge` takes as `daysOverdue`. */
export function daysLabel(
  dueDate: Date,
  reference: Date = new Date(),
): { text: string; overdue: boolean; daysOverdue: number } {
  const days = diffDays(reference, dueDate);
  if (days < 0) return { text: `${-days} d`, overdue: true, daysOverdue: -days };
  if (days === 0) return { text: "today", overdue: false, daysOverdue: 0 };
  if (days <= RELATIVE_DAYS) return { text: `in ${days}d`, overdue: false, daysOverdue: 0 };
  // "Jan 5" alone would read as this year's.
  const sameYear = dueDate.getFullYear() === reference.getFullYear();
  return {
    text: formatPattern(dueDate, sameYear ? "MMM D" : "MMM D, YYYY"),
    overdue: false,
    daysOverdue: 0,
  };
}

/** Text read back as the day it names, `pattern` matched strictly. Null when it doesn't. */
export function parsePattern(text: string, pattern: string): Date | null {
  const parsed = moment(text, pattern, true);
  return parsed.isValid() ? parsed.toDate() : null;
}

/** The locale's weekday initials, already rotated so the first is `firstDayOfWeek`'s. */
export function weekdayInitials(): string[] {
  return moment.weekdaysMin(true);
}

/** Which weekday the locale starts its week on, 0 = Sunday — the DOM/`Date.getDay()`
 *  convention, not the ISO one `weekdayIndex` counts in. */
export function firstDayOfWeek(): number {
  return moment.localeData().firstDayOfWeek();
}

/** Moves a Sunday-first weekday list onto the ISO index `weekdayIndex` counts in. */
function mondayFirst(names: string[]): string[] {
  return [...names.slice(1), names[0]];
}

/** The locale's short weekday names — "Mon", "lun." — Monday first, so a list indexed by
 *  `weekdayIndex` reads straight off it. Not the locale's own first day: an ISO week starts
 *  on Monday wherever it is read, which is what these label. */
export function isoWeekdaysShort(): string[] {
  return mondayFirst(moment.weekdaysShort());
}

/** The same weekdays in the locale's shortest form — "Mo", "lu". */
export function isoWeekdaysMin(): string[] {
  return mondayFirst(moment.weekdaysMin());
}
