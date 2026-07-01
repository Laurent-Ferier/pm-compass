import { DayTask, formatDate } from "./day-task";

export interface RecurringTaskDefinition {
  id: string;
  /** Checklist item text, without the tag (the global daily habits tag is appended when rendering). */
  title: string;
  /** Bitmask, bit 0 = Monday … bit 6 = Sunday. */
  weekdays: number;
  /** Sort key controlling insertion order / UI ordering. */
  order: number;
  /** Inactive definitions are never reconciled or backfilled. */
  active: boolean;
  /** "YYYY-MM-DD", display/sort only. */
  createdAt: string;
  /** Free-form text (using \n for line breaks) inserted as indented sub-lines below the task line. */
  detail: string;
}

export const ALL_WEEKDAYS = 0b1111111;

/** 0 = Monday … 6 = Sunday, matching WeekSummary's dayIndex convention. */
export function weekdayIndexFor(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function isScheduledOn(def: RecurringTaskDefinition, dayIndex: number): boolean {
  return (def.weekdays & (1 << dayIndex)) !== 0;
}

/** Active definitions scheduled for `date`'s weekday, sorted by `order`. */
export function scheduledFor(
  definitions: RecurringTaskDefinition[],
  date: Date,
): RecurringTaskDefinition[] {
  const dayIndex = weekdayIndexFor(date);
  return definitions
    .filter((d) => d.active && isScheduledOn(d, dayIndex))
    .sort((a, b) => a.order - b.order);
}

function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - weekdayIndexFor(d));
  return d;
}

/** True when `date` falls in the same Monday–Sunday ISO week as `reference`. */
export function isInSameIsoWeek(date: Date, reference: Date): boolean {
  return formatDate(mondayOf(date)) === formatDate(mondayOf(reference));
}

/**
 * True when `date` is `reference`'s calendar day or later, within the same ISO week.
 * Used to make sure adding/changing/removing a habit mid-week only ever affects today
 * and the remaining days of the week — never days that have already passed this week.
 */
export function isTodayOrLaterInWeek(date: Date, reference: Date): boolean {
  return isInSameIsoWeek(date, reference) && formatDate(date) >= formatDate(reference);
}

/** Renders a definition as checklist line(s): the task line plus any indented detail sub-lines. */
export function renderHabitLines(def: RecurringTaskDefinition, habitsTag: string): string[] {
  const line = DayTask.checkboxLine(`${def.title} #${habitsTag}`);
  if (!def.detail) return [line];
  return [line, ...def.detail.split("\n").map((l) => `\t${l}`)];
}

export interface MissingHabitsResult {
  missing: RecurringTaskDefinition[];
  /** Line index to splice new content at; null = no heading found (caller must append heading + block). */
  insertAt: number | null;
}

const HEADING_RE = /^#{1,6}\s/;

/**
 * Locates `headingText`'s section: [headingIdx, end) where `end` is the index of the next
 * heading of any level, or EOF. Returns null if the heading isn't present.
 */
export function findHeadingSection(
  lines: string[],
  headingText: string,
): { headingIdx: number; end: number } | null {
  const headingIdx = lines.findIndex((l) => l.trim() === headingText.trim());
  if (headingIdx === -1) return null;
  let end = headingIdx + 1;
  while (end < lines.length && !HEADING_RE.test(lines[end])) end++;
  return { headingIdx, end };
}

/** Pure decision function: given a daily note's lines, which scheduled habits are missing and where to insert them. */
export function computeMissingHabits(
  existingLines: string[],
  definitions: RecurringTaskDefinition[],
  date: Date,
  headingText: string,
  habitsTag: string,
): MissingHabitsResult {
  const scheduled = scheduledFor(definitions, date);
  if (scheduled.length === 0) return { missing: [], insertAt: null };

  const existingTasks = existingLines
    .map((l, i) => DayTask.parse(l, i))
    .filter((t): t is DayTask => t !== null);

  const missing = scheduled.filter((def) => {
    const key = def.title.trim();
    return !existingTasks.some((t) => t.habitMatchTitle(habitsTag) === key);
  });
  if (missing.length === 0) return { missing: [], insertAt: null };

  const section = findHeadingSection(existingLines, headingText);
  if (!section) return { missing, insertAt: null };

  let end = section.end;
  while (end > section.headingIdx + 1 && existingLines[end - 1].trim() === "") end--;

  return { missing, insertAt: end };
}

/**
 * True when `task` carries the habits tag but doesn't match any definition currently
 * scheduled (active + on `date`'s weekday) — i.e. it should be pruned as stale. Renaming,
 * deactivating, unscheduling a weekday, or deleting a definition all make its old line(s)
 * orphaned this way.
 */
export function isOrphanedHabitTask(
  task: DayTask,
  definitions: RecurringTaskDefinition[],
  date: Date,
  habitsTag: string,
): boolean {
  if (!task.tags.includes(`#${habitsTag}`)) return false;
  const scheduledTitles = new Set(scheduledFor(definitions, date).map((d) => d.title.trim()));
  return !scheduledTitles.has(task.habitMatchTitle(habitsTag));
}
