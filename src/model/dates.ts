/**
 * Dates as the model holds them: a `Date`, never a string. Strings live at the file
 * boundary alone — the day a note's name spells, the frontmatter fields obsidian-pm
 * writes, the markers on a checklist line — and are parsed on the way in and formatted
 * on the way out by the functions here.
 *
 * A day (a deadline, a note's day) is a local midnight; a timestamp (`createdAt`,
 * `completed`) is the instant it names. Compare days with `sameDay`/`diffDays`, which
 * read only the calendar part.
 *
 * The two don't mix: a timestamp's local calendar day isn't the day it records, obsidian-pm
 * writing them in UTC. Put one through `timestampDay` before comparing it against a day or
 * showing it as one.
 */

/** A `YYYY-MM-DD` day as local midnight. Null for anything that isn't one — a day the
 *  calendar doesn't have (`2026-02-31`) included, rather than the month it rolls over to. */
export function parseDate(text: string | undefined | null): Date | null {
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const date = new Date(y, mo - 1, d);
  if (Number.isNaN(date.getTime())) return null;
  // A rolled-over date comes back as a different day than the one asked for.
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

/** An ISO instant, as `createdAt`/`updatedAt`/`completed` hold it. Tolerates a bare
 *  `YYYY-MM-DD`, which a hand-edited file may carry where a timestamp is expected — read as
 *  UTC midnight, so `timestampDay` gives back the day that was written. */
export function parseTimestamp(text: string | undefined | null): Date | null {
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The form obsidian-pm's frontmatter timestamps take, unchanged. */
export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

/** The day a timestamp records, as a day — its UTC calendar day at local midnight, ready to
 *  compare against one. UTC because that is the calendar obsidian-pm writes these in, so it
 *  is the day the field spells and the one the plugin has always shown; reading the local
 *  day instead would move a late-evening `createdAt` onto the next date. A bare
 *  `YYYY-MM-DD` lands on its own day either way, `parseTimestamp` having read it as UTC. */
export function timestampDay(date: Date): Date {
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The local midnight of the day `date` falls in. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole days from `from` to `to`, counting the calendar days alone: negative when `to`
 *  is the earlier. Differences the clock would introduce — a timestamp's time of day, an
 *  hour lost to DST — don't reach the count. */
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

/** `date`'s ISO week number, counted off the Thursday its week holds — which is the year
 *  the week belongs to, whichever year its Monday fell in. */
export function isoWeekNumber(date: Date): number {
  const thursday = addDays(startOfIsoWeek(date), 3);
  const janFirst = new Date(thursday.getFullYear(), 0, 1);
  return Math.floor(diffDays(janFirst, thursday) / 7) + 1;
}
