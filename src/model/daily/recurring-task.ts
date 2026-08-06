import { diffDays, sameDay, startOfIsoWeek, weekdayIndex } from "../dates";
import { Task, taskBlockEnd } from "./task";

export interface RecurringTaskDefinition {
  id: string;
  /** Checklist item text; the habits tag is appended when the line is rendered. */
  title: string;
  /** Bitmask, bit 0 = Monday … bit 6 = Sunday. */
  weekdays: number;
  /** Sort key controlling insertion order / UI ordering. */
  order: number;
  /** Inactive definitions are never reconciled or backfilled. */
  active: boolean;
  /** Display/sort only. Stored as `YYYY-MM-DD` text — see `settings.ts`'s `StoredSettings`. */
  createdAt: Date;
  /** Free-form text, `\n`-separated, inserted as indented sub-lines below the task line. */
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

/** True when `date` is `reference`'s day or later in the same ISO week, so a habit
 *  changed mid-week never touches a day already past. */
export function isTodayOrLaterInWeek(date: Date, reference: Date): boolean {
  return isInSameIsoWeek(date, reference) && diffDays(reference, date) >= 0;
}

/** Renders a definition as checklist line(s): the task line plus any indented detail sub-lines. */
export function renderHabitLines(def: RecurringTaskDefinition, habitsTag: string): string[] {
  const line = Task.checkboxLine(`${def.title} #${habitsTag}`);
  if (!def.detail) return [line];
  return [line, ...def.detail.split("\n").map((l) => `\t${l}`)];
}

export interface MissingHabitsResult {
  missing: RecurringTaskDefinition[];
  /** Where to splice the new content; null when the caller must add the heading too. */
  insertAt: number | null;
}

const HEADING_RE = /^#{1,6}\s/;
const THEMATIC_BREAK_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;

/** `headingText`'s section as [headingIdx, end), ending at the next heading of any level,
 *  the next thematic break, or EOF. Null when the heading isn't present. */
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

/** Which scheduled habits a daily note's lines are missing, and where they go. */
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
    .map((l, i) => Task.parse(l, i))
    .filter((t): t is Task => t !== null);

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
 * Reorders the habit groups in `headingText`'s section to follow the definitions' `order`.
 * Each group's content is preserved and every non-habit line stays put — only positions
 * change. Returns the same `lines` when there is nothing to do.
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

  // The section as ordered segments: a habit group tagged with its rank, or one
  // passthrough line that must stay put.
  const segments: { rank: number | null; lines: string[] }[] = [];
  let i = section.headingIdx + 1;
  while (i < section.end) {
    const task = Task.parse(lines[i], i);
    const key = task && task.hasTag(habitsTag) ? task.habitMatchTitle(habitsTag) : undefined;
    if (key !== undefined && rank.has(key)) {
      const end = taskBlockEnd(lines, i);
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

/** True when `task` carries the habits tag but matches no definition active and scheduled
 *  for `date` — a line left over from a rename, a deactivation or a deletion. */
export function isOrphanedHabitTask(
  task: Task,
  definitions: RecurringTaskDefinition[],
  date: Date,
  habitsTag: string,
): boolean {
  if (!task.hasTag(habitsTag)) return false;
  const scheduledTitles = new Set(scheduledFor(definitions, date).map((d) => d.title.trim()));
  return !scheduledTitles.has(task.habitMatchTitle(habitsTag));
}
