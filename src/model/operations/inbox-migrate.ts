import {
  dayTakesTasks,
  scheduleInboxItem,
  ScheduleOutcome,
} from "../daily/day-task-actions";
import { readDailyNotesConfig } from "../daily/daily-notes-plugin";
import type { DailyNotesConfig } from "../daily/week-summary";
import type { NoteFiles } from "../io/task-file";

/**
 * Moves every inbox item whose ⏳ target day takes tasks into that day's checklist, which
 * is what makes a target date a plan rather than a label. A day that never gets a note
 * keeps its item: pulling it forward would rewrite the plan the user picked.
 *
 * Each note it writes marks its own re-read, a throw halfway through included. How many
 * items moved is what it hands back.
 */
export async function migrateInboxTargets(
  files: NoteFiles,
  resolvedInboxPath: string,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<number> {
  const resolvedConfig = config ?? await readDailyNotesConfig(files.vault);
  const items = await files.file(resolvedInboxPath).parsedTasks();

  let moved = 0;
  // Sequentially: each move rewrites the inbox, invalidating the line indices a
  // concurrent batch would be resolving against. Completed items travel to today,
  // keeping their ✅, a record of work belonging on the day it was closed.
  for (const item of items) {
    if (!item.scheduledDate) continue;
    const day = item.checked ? new Date() : item.scheduledDate;
    if (!await dayTakesTasks(files.vault, day, resolvedConfig)) continue;
    const outcome = await scheduleInboxItem(
      files, resolvedInboxPath, item, day, dailyTasksHeading, resolvedConfig,
    );
    if (outcome === ScheduleOutcome.Moved) moved++;
  }
  return moved;
}
