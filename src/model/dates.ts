/**
 * Dates as the model holds them: a `Date`, never a string. Strings live at the file
 * boundary alone, parsed and formatted by the functions here.
 *
 * A day is a local midnight, a timestamp the instant it names; compare days with
 * `sameDay`/`diffDays`. The two don't mix — obsidian-pm writes timestamps in UTC, so put
 * one through `timestampDay` before reading it as a day.
 */

/** A `YYYY-MM-DD` day as local midnight. Null for anything else, a day the calendar
 *  doesn't have included, rather than the month it rolls over to. */
export function parseDate(text: string | undefined | null): Date | null {
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const date = new Date(y, mo - 1, d);
  // A rolled-over date comes back as a different day than the one asked for. This
  // catches an unrepresentable one too, whose fields all read NaN.
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** A day as `YYYY-MM-DD` — what a checklist marker and a `start`/`due` field hold. */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A day in the ISO-instant form `completed` holds: its UTC midnight, which
 *  `timestampDay` reads back as that same day. */
export function dayAsTimestamp(day: Date): string {
  return `${formatDate(day)}T00:00:00.000Z`;
}

/** An ISO instant, as `createdAt`/`completed` hold it. A bare `YYYY-MM-DD` is read as UTC
 *  midnight, so `timestampDay` gives back the day that was written. */
export function parseTimestamp(text: string | undefined | null): Date | null {
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The form obsidian-pm's frontmatter timestamps take, unchanged. */
export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

/** The day a timestamp records: its UTC calendar day at local midnight, ready to compare
 *  against a day. UTC because that is the calendar obsidian-pm writes these in — the local
 *  day would move a late-evening `createdAt` onto the next date. */
export function timestampDay(date: Date): Date {
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The local midnight of the day `date` falls in. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole days from `from` to `to`, negative when `to` is the earlier. The calendar days
 *  alone: a time of day, or an hour lost to DST, doesn't reach the count. */
export function diffDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** The same calendar day, whatever time either carries. */
export function sameDay(a: Date, b: Date): boolean {
  return diffDays(a, b) === 0;
}

/** Day order, for a sort: negative when `a`'s day comes first. */
export function compareDays(a: Date, b: Date): number {
  return diffDays(b, a);
}

/** `days` on from `date`, at midnight — a copy, never a shift of the one given. */
export function addDays(date: Date, days: number): Date {
  const shifted = startOfDay(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

/** 0 = Monday … 6 = Sunday, the week order the whole plugin counts in. */
export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** The Monday of `date`'s ISO week, at midnight. */
export function startOfIsoWeek(date: Date): Date {
  return addDays(date, -weekdayIndex(date));
}

/** `date`'s ISO week number, counted off the Thursday its week holds — which settles
 *  the year the week belongs to. */
export function isoWeekNumber(date: Date): number {
  const thursday = addDays(startOfIsoWeek(date), 3);
  const janFirst = new Date(thursday.getFullYear(), 0, 1);
  return Math.floor(diffDays(janFirst, thursday) / 7) + 1;
}
