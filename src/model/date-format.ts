import { moment } from "./moment";

/**
 * The one place moment is still used: rendering a `Date` as text and reading a filename
 * back. It is a formatting library here, not a date type — nothing outside this module
 * holds a `Moment`, so a date is a `Date` everywhere else (see `dates.ts`).
 *
 * Kept out of `dates.ts` so that module stays free of Obsidian imports.
 */

/** A day as text, in one of moment's patterns: a row's label, or a daily note's filename
 *  under whichever format the vault's daily-notes settings give. */
export function formatPattern(date: Date, pattern: string): string {
  return moment(date).format(pattern);
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
