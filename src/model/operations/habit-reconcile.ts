import { computeHabitChanges, type RecurringTaskDefinition } from "../daily/recurring-task";
import { parseTasksFromLines, type TaskIO } from "../io/task-io";

/** What one pass put right: the definitions it wrote a line for, the orphaned lines it
 *  pruned, and whether the note was written at all — a reordered section changes the note
 *  without adding or dropping a habit. */
export interface HabitReconcileResult {
  inserted: RecurringTaskDefinition[];
  removedCount: number;
  changed: boolean;
}

/**
 * Inserts a line for every habit scheduled for `date` that the note lacks, and prunes
 * habit-tagged lines matching no active, scheduled definition. Pruning covers the whole
 * note, not just `headingText`'s section, so lines outside it are cleaned up too.
 *
 * What to change is `computeHabitChanges`'; what is here is owing that change to the note as
 * one — the habit lines taken out and the section put back, which only make sense together:
 * a note caught between the two reads as a note missing its habits, which whatever reads it
 * next would set about putting right. Owed rather than written, so however many lines moved,
 * the note is flushed once and the views hear one change.
 *
 * The lines it is decided from are the ones the write itself is handed, read inside the lock
 * that write takes. A tick landing on a habit while this ran would otherwise leave every
 * removal resolving against a line that no longer reads that way, and the section put back
 * from the stale text — the habit written twice, the tick lost with the duplicate. The read
 * above the lock only asks whether there is anything to do at all, so a note already right
 * owes nothing and wakes nobody.
 */
export async function reconcileRecurringHabits(
  note: TaskIO,
  definitions: RecurringTaskDefinition[],
  date: Date,
  headingText: string,
  habitsTag: string,
): Promise<HabitReconcileResult> {
  const changesTo = (lines: string[]) => computeHabitChanges(
    lines, parseTasksFromLines(lines), definitions, date, headingText, habitsTag,
  );

  const { lines } = await note.read();
  const ahead = changesTo(lines);
  if (ahead.orphaned.length === 0 && ahead.rewritten.length === 0 && ahead.inserted.length === 0) {
    return { inserted: [], removedCount: 0, changed: false };
  }

  let result: HabitReconcileResult = { inserted: [], removedCount: 0, changed: false };
  // Keyed by the heading: there is no one line this is a change to — the section is. Nothing
  // to read ahead either: what moves is the note's lines, and the models over them hear that
  // on the re-read the flush owes.
  note.owePass(headingText, "habits", {
    ahead: () => undefined,
    apply: (file, lines) => {
      const { orphaned, rewritten, inserted, missing } = changesTo(lines);
      const removed = [...orphaned, ...rewritten];
      if (removed.length === 0 && inserted.length === 0) return null;
      result = { inserted: missing, removedCount: orphaned.length, changed: true };
      const kept = file.withoutLines(lines, removed);
      return inserted.length > 0 ? file.withGroupUnderHeading(kept, inserted, headingText) : kept;
    },
  });
  await note.flush();

  return result;
}
