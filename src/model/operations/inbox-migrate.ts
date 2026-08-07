import {
  dayTakesTasks,
  scheduleInboxItem,
  ScheduleOutcome,
} from "../daily/day-task-actions";
import { readDailyNotesConfig } from "../daily/daily-notes-plugin";
import type { DailyNotesConfig } from "../daily/week-summary";
import type { NoteFiles } from "../io/task-file";

/** How many items moved, and every note the pass wrote — the inbox, and each day note an
 *  item landed in. The count and the paths answer different questions: one is what the pass
 *  did, the other what the caller has to re-read. */
export interface InboxMigration {
  moved: number;
  touched: string[];
}

/**
 * Moves every inbox item whose ⏳ target day takes tasks into that day's checklist, which
 * is what makes a target date a plan rather than a label. A day that never gets a note
 * keeps its item: pulling it forward would rewrite the plan the user picked.
 *
 * Names the notes it wrote rather than invalidating them itself — the caller holds the cache.
 * `touched` is filled as each move lands, so a pass that throws halfway still names what it
 * got through; the day-note paths are the ones `scheduleInboxItem` handed back, since
 * Templater can put a note somewhere other than the naming scheme said.
 */
export async function migrateInboxTargets(
  files: NoteFiles,
  resolvedInboxPath: string,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
  touched: string[] = [],
): Promise<InboxMigration> {
  const resolvedConfig = config ?? await readDailyNotesConfig(files.app);
  const items = await files.file(resolvedInboxPath).parsedTasks();

  let moved = 0;
  // Sequentially: each move rewrites the inbox, invalidating the line indices a
  // concurrent batch would be resolving against. Completed items travel to today,
  // keeping their ✅, a record of work belonging on the day it was closed.
  for (const item of items) {
    if (!item.scheduledDate) continue;
    const day = item.checked ? new Date() : item.scheduledDate;
    if (!await dayTakesTasks(files.app, day, resolvedConfig)) continue;
    // Before the move rather than after it: the item leaves the inbox first, so a throw
    // part-way through still leaves the inbox rewritten.
    if (!touched.includes(resolvedInboxPath)) touched.push(resolvedInboxPath);
    const result = await scheduleInboxItem(
      files, resolvedInboxPath, item, day, dailyTasksHeading, resolvedConfig,
    );
    if (result.outcome !== ScheduleOutcome.Moved) continue;
    moved++;
    if (result.path && !touched.includes(result.path)) touched.push(result.path);
  }
  return { moved, touched };
}
