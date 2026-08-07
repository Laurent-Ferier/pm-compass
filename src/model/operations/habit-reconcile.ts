import type { App } from "obsidian";
import {
  computeMissingHabits,
  isOrphanedHabitTask,
  renderHabitLines,
  reorderScheduledHabits,
  type RecurringTaskDefinition,
} from "../daily/recurring-task";
import {
  parseTasksFromLines,
  removeTaskGroups,
  trimTrailingBlankLines,
} from "./day-note-lines";
import { readFileLines, withFileLock, writeFileLines } from "./file-helpers";

/**
 * Inserts a line for every habit scheduled for `date` that the file lacks, and prunes
 * habit-tagged lines matching no active, scheduled definition. Pruning covers the whole
 * file, not just `headingText`'s section, so lines outside it are cleaned up too.
 */
export async function reconcileRecurringHabits(
  app: App,
  filePath: string,
  definitions: RecurringTaskDefinition[],
  date: Date,
  headingText: string,
  habitsTag: string,
): Promise<{ inserted: RecurringTaskDefinition[]; removedCount: number }> {
  return withFileLock(filePath, async () => {
    const original = await readFileLines(app, filePath);
    let lines = original;
    const { missing, insertAt } = computeMissingHabits(lines, definitions, date, headingText, habitsTag);
    if (missing.length > 0) {
      const newLines = missing.flatMap((def) => renderHabitLines(def, habitsTag));
      if (insertAt !== null) {
        lines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
      } else {
        // A null insertAt means the heading is absent, so it goes in too.
        const trimmed = trimTrailingBlankLines(lines);
        lines = [...trimmed, "", headingText, ...newLines];
      }
    }

    const removal = removeOrphanedHabits(lines, definitions, date, habitsTag);
    lines = removal.lines;

    // Insertion appends to the section, so restore the definitions' own `order`.
    lines = reorderScheduledHabits(lines, definitions, date, headingText, habitsTag);

    if (lines !== original) await writeFileLines(app, filePath, lines);
    return { inserted: missing, removedCount: removal.count };
  });
}

/** Removes habit-tagged tasks matching no active, scheduled definition, working on the
 *  caller's already-loaded `lines`. */
function removeOrphanedHabits(
  lines: string[],
  definitions: RecurringTaskDefinition[],
  date: Date,
  habitsTag: string,
): { lines: string[]; count: number } {
  const tasks = parseTasksFromLines(lines);
  const orphaned = tasks.filter((t) => isOrphanedHabitTask(t, definitions, date, habitsTag));
  if (orphaned.length === 0) return { lines, count: 0 };

  return { lines: removeTaskGroups(lines, orphaned), count: orphaned.length };
}
