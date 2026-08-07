import { App, normalizePath, TFile } from "obsidian";
import {
  BaseTask, DEFAULT_SORT_DIR, TaskSortKey, TaskSortDir,
  type Rollup, type RollupLookup,
} from "../base-task";
import { formatDate } from "../dates";
import { Task } from "./task";
import { readDailyNotesConfig } from "./daily-notes-plugin";
import { dayNotePath, ensureDayNotePath } from "../operations/day-note";
import {
  addTask,
  createTask,
  insertUnderHeading,
  moveTaskBefore,
  removeTask,
  updateScheduledDate,
} from "../operations/day-note-lines";
import type { DailyNotesConfig } from "./week-summary";

/** What planning a task for a day actually did with it — a day only takes the task in
 *  once its note exists, so the other outcome is a ⏳ target date left on the task. */
export enum ScheduleOutcome {
  /** The task now lives in that day's note. */
  Moved = "moved",
  /** The day has no note yet: the task waits in the inbox with a ⏳ target date. */
  Targeted = "targeted",
  /** Nothing happened — the task was gone, or its target note couldn't be created. */
  Failed = "failed",
}

/** App-level operations on checklist items — the mutations the views perform on one.
 *  Line-operation orchestration with no DOM. */

// ── Inbox ────────────────────────────────────────────────────────────────────

export function resolveInboxPath(inboxFilePath: string, dnConfig: DailyNotesConfig): string {
  if (inboxFilePath) return normalizePath(inboxFilePath);
  return normalizePath(dnConfig.folder ? `${dnConfig.folder}/Inbox.md` : "Inbox.md");
}


/** The direction in effect for `sortBy`: the user's pick for that mode, else its default. */
export function resolveTaskSortDir(
  sortBy: TaskSortKey,
  stored: Partial<Record<TaskSortKey, TaskSortDir>> = {},
): TaskSortDir {
  return stored[sortBy] ?? DEFAULT_SORT_DIR[sortBy];
}

/** Where a list looks up what the tree makes of each task. Typed as `Rollup`, which
 *  `EffectiveValues` fits structurally, so nothing here reaches into `project/`. */
const rollupOf = (m?: Map<string, Rollup>): RollupLookup | undefined =>
  m && ((id: string) => m.get(id));

/** Whether `TaskSortKey.Due` has anything to order these rows by, read off the same key
 *  that mode sorts on. */
export function hasSortableDeadline(
  items: BaseTask[],
  effectiveValues?: Map<string, Rollup>,
): boolean {
  const rollup = rollupOf(effectiveValues);
  return items.some((item) => item.dueInForce(rollup) !== null);
}

/** Sorts a copy of `items` for display. Takes any `BaseTask`, so the Inbox's lines and
 *  the project tasks beside them make one list in one order rather than two blocks. */
export function sortInboxItems<T extends BaseTask>(
  items: T[],
  sortBy: TaskSortKey = TaskSortKey.Created,
  dir: TaskSortDir = DEFAULT_SORT_DIR[sortBy],
  /** `computeEffectiveValues`' roll-ups, so a project task sorts by what its row shows
   *  rather than by the raw fields of its own file. */
  effectiveValues?: Map<string, Rollup>,
): T[] {
  return [...items].sort(BaseTask.comparator({ key: sortBy, dir, rollup: rollupOf(effectiveValues) }));
}

export async function appendInboxItem(app: App, resolvedPath: string, title: string): Promise<void> {
  await createTask(app, resolvedPath, title, new Date());
}

/** Reorders a checklist item within its file, placing it just before `anchor`, or after
 *  the last task when that is null. */
export async function reorderChecklistItem(
  app: App,
  filePath: string,
  item: Task,
  anchor: Task | null,
): Promise<void> {
  await moveTaskBefore(app, filePath, item, anchor);
}

/** Closes an inbox item by moving its line into today's note marked ✅, so the Inbox
 *  leaves a record rather than erasing the task. Any ⏳ target date goes with it. */
export async function closeInboxItem(
  app: App,
  resolvedPath: string,
  item: Task,
): Promise<void> {
  // The target is created before the source is touched, so a failure here can't leave
  // the item deleted with nowhere to go.
  const targetPath = await ensureDayNotePath(app, new Date());
  if (!targetPath) return;
  const removed = await removeTask(app, resolvedPath, item);
  if (!removed) return;
  const date = new Date();
  const line = Task.withUpdatedScheduledDate(Task.toCheckedLine(removed.rawLine, date), null);
  const checkedTask = Task.parse(line, 0)!.withSubLines(removed.subLines);
  await addTask(app, targetPath, checkedTask);
}

/** Whether a task planned for `date` belongs in that day's note yet: only today and days
 *  that already have one, so planning ahead conjures no string of empty notes. */
export async function dayTakesTasks(
  app: App,
  date: Date,
  config?: DailyNotesConfig,
): Promise<boolean> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const path = dayNotePath(date, resolvedConfig);
  if (path === dayNotePath(new Date(), resolvedConfig)) return true;
  return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

/** What planning an item did, and the day note it landed in — null when it landed in no
 *  day note. The path is the one `ensureDayNotePath` handed back rather than a recomputed
 *  one, so a caller reporting what it wrote names the file Templater actually made. */
export interface ScheduleResult {
  outcome: ScheduleOutcome;
  path: string | null;
}

/** Plans an inbox item for `date`: into that day's checklist when it takes tasks, else
 *  left in the inbox under a ⏳ for `migrateInboxTargets` to move once the day exists. */
export async function scheduleInboxItem(
  app: App,
  resolvedPath: string,
  item: Task,
  date: Date,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<ScheduleResult> {
  if (!await dayTakesTasks(app, date, config)) {
    const targeted = await updateScheduledDate(app, resolvedPath, item, date);
    return { outcome: targeted ? ScheduleOutcome.Targeted : ScheduleOutcome.Failed, path: null };
  }
  // The target is created before the source is touched, so a failure here can't leave
  // the item deleted with nowhere to go.
  const targetPath = await ensureDayNotePath(app, date, config);
  if (!targetPath) return { outcome: ScheduleOutcome.Failed, path: null };
  const removed = await removeTask(app, resolvedPath, item);
  if (!removed) return { outcome: ScheduleOutcome.Failed, path: null };
  // The day note is the schedule now, so the ⏳ it was waiting on has been honoured.
  const line = Task.withUpdatedScheduledDate(removed.rawLine, null);
  await insertUnderHeading(app, targetPath, [line, ...removed.subLines], dailyTasksHeading);
  return { outcome: ScheduleOutcome.Moved, path: targetPath };
}

/** Writes a new task onto `date`, by the same rule `scheduleInboxItem` follows — so a
 *  task is only ever in a day that exists or in the inbox. */
export async function addTaskToDay(
  app: App,
  date: Date,
  title: string,
  resolvedInboxPath: string,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<ScheduleOutcome> {
  const task = Task.create(title, new Date());
  if (!await dayTakesTasks(app, date, config)) {
    const line = Task.withUpdatedScheduledDate(task.rawLine, date);
    await addTask(app, resolvedInboxPath, Task.parse(line, 0)!);
    return ScheduleOutcome.Targeted;
  }
  const targetPath = await ensureDayNotePath(app, date, config);
  if (!targetPath) return ScheduleOutcome.Failed;
  await insertUnderHeading(app, targetPath, [task.rawLine], dailyTasksHeading);
  return ScheduleOutcome.Moved;
}

// ── Day checklist items ────────────────────────────────────────────────────────

/** Replans a day's checklist item for `date`. A day that doesn't take tasks yet sends the
 *  item back to the inbox with a ⏳ rather than getting a note of its own. */
export async function rescheduleChecklistItem(
  app: App,
  sourceFilePath: string,
  resolvedInboxPath: string,
  item: Task,
  date: Date,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<ScheduleOutcome> {
  if (!await dayTakesTasks(app, date, config)) {
    const sent = await sendToInbox(app, sourceFilePath, item, resolvedInboxPath, date);
    return sent ? ScheduleOutcome.Targeted : ScheduleOutcome.Failed;
  }
  // The target is created before the source is touched, so a failure here can't leave
  // the item deleted with nowhere to go.
  const targetPath = await ensureDayNotePath(app, date, config);
  if (!targetPath) return ScheduleOutcome.Failed;
  const removed = await removeTask(app, sourceFilePath, item);
  if (!removed) return ScheduleOutcome.Failed;
  const uncheckedTask = Task.parse(Task.toUncheckedLine(removed.rawLine), 0)!.withSubLines(removed.subLines);
  await insertUnderHeading(
    app, targetPath, [uncheckedTask.rawLine, ...uncheckedTask.subLines], dailyTasksHeading,
  );
  return ScheduleOutcome.Moved;
}

export async function deleteChecklistItem(
  app: App,
  sourceFilePath: string,
  item: Task,
): Promise<void> {
  await removeTask(app, sourceFilePath, item);
}

/**
 * Sends a day's checklist item back to the inbox, carrying its line over as it stands —
 * the same task, only unscheduled. A line with no ➕ gets today's, which the age badge
 * and the default sort read; indentation is dropped so it lands top-level.
 */
export async function moveChecklistItemToInbox(
  app: App,
  sourceFilePath: string,
  item: Task,
  resolvedInboxPath: string,
): Promise<void> {
  await sendToInbox(app, sourceFilePath, item, resolvedInboxPath, null);
}

/** `moveChecklistItemToInbox` plus the ⏳ target date a reschedule leaves on the item
 *  (`null` for a plain unschedule). Returns whether the item was found and moved. */
async function sendToInbox(
  app: App,
  sourceFilePath: string,
  item: Task,
  resolvedInboxPath: string,
  targetDate: Date | null,
): Promise<boolean> {
  const removed = await removeTask(app, sourceFilePath, item);
  if (!removed) return false;
  const line = Task.toUncheckedLine(removed.rawLine).replace(/^\s+/, "");
  const created = removed.createdAt ? line : `${line} ➕ ${formatDate(new Date())}`;
  // Cleared with no target: a leftover ⏳ would have `migrateInboxTargets` pull the
  // item straight back into a day.
  const inboxLine = Task.withUpdatedScheduledDate(created, targetDate);
  const inboxTask = Task.parse(inboxLine, 0)!.withSubLines(removed.subLines);
  await addTask(app, resolvedInboxPath, inboxTask);
  return true;
}
