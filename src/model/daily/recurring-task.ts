import { diffDays, sameDay, startOfIsoWeek, weekdayIndex } from "../dates";
import { Task } from "./task";

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

/** What a day note's habit lines should read as, against what they do read as. */
export interface HabitChanges {
  /** The habit lines matching no active, scheduled definition, pruned wherever they sit —
   *  what a rename, a deactivation or a deletion leaves behind. */
  orphaned: Task[];
  /** The section's own habit lines, when the section has to be written afresh; empty when it
   *  already reads as the definitions say. */
  rewritten: Task[];
  /** The section as it should read — every scheduled habit in the definitions' order, each
   *  keeping the line the note already had for it. Empty alongside `rewritten`. */
  inserted: string[];
  /** The definitions the note held no line for anywhere, which is what a caller reports. */
  missing: RecurringTaskDefinition[];
}

/**
 * The habit lines a day note should gain and lose. A habit the note holds outside
 * `headingText`'s section is where the person who moved it wanted it, and counts as held: it
 * is neither moved back nor written a second time. Everything else the section owes is
 * decided together — the order is the definitions' — so a section that is wrong in any way
 * is taken out and put back whole rather than nudged line by line.
 *
 * A habit is a top-level checklist line carrying the habits tag, and nothing else counts as
 * one: a line indented under another task, or one whose tag was taken off by hand, is neither
 * held nor pruned, and the definition behind it is written afresh under the heading. Which is
 * what indenting or untagging a habit says — that the line is now the person's own, and the
 * habit itself still owed.
 *
 * `tasks` is `lines` parsed, which the caller has already done.
 */
export function computeHabitChanges(
  lines: string[],
  tasks: Task[],
  definitions: RecurringTaskDefinition[],
  date: Date,
  headingText: string,
  habitsTag: string,
): HabitChanges {
  const scheduled = scheduledFor(definitions, date);
  const habits = tasks.filter((t) => t.hasTag(habitsTag));
  const orphaned = habits.filter((t) => isOrphanedHabitTask(t, definitions, date, habitsTag));

  const section = findHeadingSection(lines, headingText);
  const held = habits.filter((t) => !orphaned.includes(t));
  const inSection = (t: Task) =>
    section !== null && t.lineIndex > section.headingIdx && t.lineIndex < section.end;
  const elsewhere = new Set(held.filter((t) => !inSection(t)).map((t) => t.habitMatchTitle(habitsTag)));

  // What the section is for: the scheduled habits the note doesn't already hold outside it.
  const wanted = scheduled.filter((d) => !elsewhere.has(d.title.trim()));
  const own = held.filter(inSection);
  const ownByTitle = new Map(own.map((t) => [t.habitMatchTitle(habitsTag), t]));
  const missing = wanted.filter((d) => !ownByTitle.has(d.title.trim()));

  const rightAlready = own.length === wanted.length
    && own.every((t, i) => t.habitMatchTitle(habitsTag) === wanted[i].title.trim());
  if (rightAlready) return { orphaned, rewritten: [], inserted: [], missing };

  return {
    orphaned,
    rewritten: own,
    // A habit already written keeps its line as it stands — ticked, stamped, and whatever
    // sub-lines were typed under it; only one the note lacks is rendered afresh.
    inserted: wanted.flatMap((d) => {
      const line = ownByTitle.get(d.title.trim());
      return line ? [line.rawLine, ...line.subLines] : renderHabitLines(d, habitsTag);
    }),
    missing,
  };
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
