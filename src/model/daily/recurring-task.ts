import { diffDays, sameDay, startOfIsoWeek, weekdayIndex } from "../dates";
import { DayTask } from "./day-task";

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
  /** Display/sort only. Stored as `YYYY-MM-DD` text — see `settings.ts`'s `StoredSettings`. */
  createdAt: Date;
  /** Free-form text (using \n for line breaks) inserted as indented sub-lines below the task line. */
  detail: string;
}

export const ALL_WEEKDAYS = 0b1111111;

export function isScheduledOn(def: RecurringTaskDefinition, dayIndex: number): boolean {
  return (def.weekdays & (1 << dayIndex)) !== 0;
}

/** Active definitions scheduled for `date`'s weekday, sorted by `order`. */
export function scheduledFor(
  definitions: RecurringTaskDefinition[],
  date: Date,
): RecurringTaskDefinition[] {
  const dayIndex = weekdayIndex(date);
  return definitions
    .filter((d) => d.active && isScheduledOn(d, dayIndex))
    .sort((a, b) => a.order - b.order);
}

/** True when `date` falls in the same Monday–Sunday ISO week as `reference`. */
export function isInSameIsoWeek(date: Date, reference: Date): boolean {
  return sameDay(startOfIsoWeek(date), startOfIsoWeek(reference));
}

/**
 * True when `date` is `reference`'s calendar day or later, within the same ISO week.
 * Used to make sure adding/changing/removing a habit mid-week only ever affects today
 * and the remaining days of the week — never days that have already passed this week.
 */
export function isTodayOrLaterInWeek(date: Date, reference: Date): boolean {
  return isInSameIsoWeek(date, reference) && diffDays(reference, date) >= 0;
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
const THEMATIC_BREAK_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;

/**
 * Locates `headingText`'s section: [headingIdx, end) where `end` is the index of the next
 * heading of any level, the next thematic break (`---`, `***`, `___`), or EOF. Returns null
 * if the heading isn't present.
 */
export function findHeadingSection(
  lines: string[],
  headingText: string,
): { headingIdx: number; end: number } | null {
  const headingIdx = lines.findIndex((l) => l.trim() === headingText.trim());
  if (headingIdx === -1) return null;
  let end = headingIdx + 1;
  while (
    end < lines.length &&
    !HEADING_RE.test(lines[end]) &&
    !THEMATIC_BREAK_RE.test(lines[end].trim())
  )
    end++;
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

function indentOf(line: string): number {
  return line.match(/^(\s*)/)![1].length;
}

/** Exclusive end index of the task group at `idx`: the task line plus its indented
 *  continuation lines (detail sub-lines), stopping at a blank line, a shallower/equal
 *  indent, or EOF — mirroring how getTaskSlice groups a task with its sub-lines. */
function habitGroupEnd(lines: string[], idx: number): number {
  const base = indentOf(lines[idx]);
  let end = idx + 1;
  while (end < lines.length && lines[end].trim() !== "" && indentOf(lines[end]) > base) end++;
  return end;
}

/**
 * Reorders the scheduled-habit checklist groups within `headingText`'s section so they
 * follow the definitions' `order` sequence. Each habit's exact on-disk content is preserved
 * (checked state, ✅/➕ dates, user-edited detail sub-lines) — only the groups' positions
 * change, and every non-habit line stays exactly where it is. A no-op (returns the same
 * `lines` reference) when the heading is absent, fewer than two scheduled habits are present,
 * or the habits are already in order.
 */
export function reorderScheduledHabits(
  lines: string[],
  definitions: RecurringTaskDefinition[],
  date: Date,
  headingText: string,
  habitsTag: string,
): string[] {
  const section = findHeadingSection(lines, headingText);
  if (!section) return lines;

  const rank = new Map(scheduledFor(definitions, date).map((d, i) => [d.title.trim(), i]));
  if (rank.size < 2) return lines;

  // Split the section into ordered segments: each is either a scheduled-habit group
  // (tagged with its rank) or a single passthrough line that must stay put.
  const segments: { rank: number | null; lines: string[] }[] = [];
  let i = section.headingIdx + 1;
  while (i < section.end) {
    const task = DayTask.parse(lines[i], i);
    const key = task && task.hasTag(habitsTag) ? task.habitMatchTitle(habitsTag) : undefined;
    if (key !== undefined && rank.has(key)) {
      const end = habitGroupEnd(lines, i);
      segments.push({ rank: rank.get(key)!, lines: lines.slice(i, end) });
      i = end;
    } else {
      segments.push({ rank: null, lines: [lines[i]] });
      i++;
    }
  }

  const habitSegments = segments.filter((s) => s.rank !== null);
  if (habitSegments.length < 2) return lines;

  const sorted = [...habitSegments].sort((a, b) => a.rank! - b.rank!);
  if (habitSegments.every((seg, idx) => seg === sorted[idx])) return lines;

  let s = 0;
  const rebuiltSection = segments.flatMap((seg) =>
    seg.rank === null ? seg.lines : sorted[s++].lines,
  );
  return [
    ...lines.slice(0, section.headingIdx + 1),
    ...rebuiltSection,
    ...lines.slice(section.end),
  ];
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
  if (!task.hasTag(habitsTag)) return false;
  const scheduledTitles = new Set(scheduledFor(definitions, date).map((d) => d.title.trim()));
  return !scheduledTitles.has(task.habitMatchTitle(habitsTag));
}
