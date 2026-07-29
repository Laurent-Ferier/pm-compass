import { App, normalizePath, TFile } from "obsidian";
import {
  BaseTask, DEFAULT_SORT_DIR, TaskSortKey, TaskSortDir,
  type Priority, type Rollup, type RollupLookup,
} from "../base-task";
import { formatDate, sameDay, startOfDay } from "../dates";
import { DayTask } from "./day-task";
import { DayMarkdownFile, dayNotePath, readDailyNotesConfig } from "./day-markdown-file";
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

/** App-level operations on checklist items — loading a day's checklist, and the mutations
 *  the views perform on one. `DayMarkdownFile` orchestration with no DOM. */

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

export async function readInboxItems(
  app: App,
  resolvedPath: string,
  sortBy: TaskSortKey = TaskSortKey.Created,
  dir: TaskSortDir = DEFAULT_SORT_DIR[sortBy],
): Promise<DayTask[]> {
  const tasks = await new DayMarkdownFile(app, resolvedPath).removeCheckedTasks();
  return sortInboxItems(tasks, sortBy, dir);
}

/** Sets a checklist line's priority marker, or clears it for `Priority.None`. */
export async function setChecklistItemPriority(
  app: App,
  resolvedPath: string,
  item: DayTask,
  priority: Priority,
): Promise<void> {
  await new DayMarkdownFile(app, resolvedPath).updatePriority(item, priority);
}

export async function appendInboxItem(app: App, resolvedPath: string, title: string): Promise<void> {
  await new DayMarkdownFile(app, resolvedPath).createTask(title, new Date());
}

export async function removeInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
): Promise<void> {
  await new DayMarkdownFile(app, resolvedPath).remove(item);
}

/** Reorders a checklist item within its file, placing it just before `anchor`, or after
 *  the last task when that is null. */
export async function reorderChecklistItem(
  app: App,
  filePath: string,
  item: DayTask,
  anchor: DayTask | null,
): Promise<void> {
  await new DayMarkdownFile(app, filePath).moveTaskBefore(item, anchor);
}

/** Closes an inbox item by moving its line into today's note marked ✅, so the Inbox
 *  leaves a record rather than erasing the task. Any ⏳ target date goes with it. */
export async function closeInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
): Promise<void> {
  const removed = await new DayMarkdownFile(app, resolvedPath).remove(item);
  if (!removed) return;
  const targetDmf = await DayMarkdownFile.ensure(app, new Date());
  if (!targetDmf) return;
  const date = new Date();
  const line = DayTask.withUpdatedScheduledDate(DayTask.toCheckedLine(removed.rawLine, date), null);
  const checkedTask = DayTask.parse(line, 0)!.withSubLines(removed.subLines);
  await targetDmf.addTask(checkedTask);
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

/** Plans an inbox item for `date`: into that day's checklist when it takes tasks, else
 *  left in the inbox under a ⏳ for `migrateInboxTargets` to move once the day exists. */
export async function scheduleInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
  date: Date,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<ScheduleOutcome> {
  if (!await dayTakesTasks(app, date, config)) {
    const targeted = await new DayMarkdownFile(app, resolvedPath).updateScheduledDate(item, date);
    return targeted ? ScheduleOutcome.Targeted : ScheduleOutcome.Failed;
  }
  const removed = await new DayMarkdownFile(app, resolvedPath).remove(item);
  if (!removed) return ScheduleOutcome.Failed;
  const targetDmf = await DayMarkdownFile.ensure(app, date, config);
  if (!targetDmf) return ScheduleOutcome.Failed;
  // The day note is the schedule now, so the ⏳ it was waiting on has been honoured.
  const line = DayTask.withUpdatedScheduledDate(removed.rawLine, null);
  await targetDmf.insertUnderHeading([line, ...removed.subLines], dailyTasksHeading);
  return ScheduleOutcome.Moved;
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
  const task = DayTask.create(title, new Date());
  if (!await dayTakesTasks(app, date, config)) {
    const line = DayTask.withUpdatedScheduledDate(task.rawLine, date);
    await new DayMarkdownFile(app, resolvedInboxPath).addTask(DayTask.parse(line, 0)!);
    return ScheduleOutcome.Targeted;
  }
  const dmf = await DayMarkdownFile.ensure(app, date, config);
  if (!dmf) return ScheduleOutcome.Failed;
  await dmf.insertUnderHeading([task.rawLine], dailyTasksHeading);
  return ScheduleOutcome.Moved;
}

/** Drops an inbox item's ⏳ target date, leaving it unplanned in the inbox. */
export async function unscheduleInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
): Promise<void> {
  await new DayMarkdownFile(app, resolvedPath).updateScheduledDate(item, null);
}

/**
 * Moves every inbox item whose ⏳ target day takes tasks into that day's checklist, which
 * is what makes a target date a plan rather than a label. A day that never gets a note
 * keeps its item: pulling it forward would rewrite the plan the user picked.
 */
export async function migrateInboxTargets(
  app: App,
  resolvedInboxPath: string,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<number> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const items = await new DayMarkdownFile(app, resolvedInboxPath).parseTasks();

  let moved = 0;
  // Sequentially: each move rewrites the inbox, invalidating the line indices a
  // concurrent batch would be resolving against. Completed items travel to today,
  // keeping their ✅, a record of work belonging on the day it was closed.
  for (const item of items) {
    if (!item.scheduledDate) continue;
    const day = item.checked ? new Date() : item.scheduledDate;
    if (!await dayTakesTasks(app, day, resolvedConfig)) continue;
    const outcome = await scheduleInboxItem(app, resolvedInboxPath, item, day, dailyTasksHeading, resolvedConfig);
    if (outcome === ScheduleOutcome.Moved) moved++;
  }
  return moved;
}

// ── Day checklist items ────────────────────────────────────────────────────────

/** Replans a day's checklist item for `date`. A day that doesn't take tasks yet sends the
 *  item back to the inbox with a ⏳ rather than getting a note of its own. */
export async function rescheduleChecklistItem(
  app: App,
  sourceFilePath: string,
  resolvedInboxPath: string,
  item: DayTask,
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
  const targetDmf = await DayMarkdownFile.ensure(app, date, config);
  if (!targetDmf) return ScheduleOutcome.Failed;
  const removed = await new DayMarkdownFile(app, sourceFilePath).remove(item);
  if (!removed) return ScheduleOutcome.Failed;
  const uncheckedTask = DayTask.parse(DayTask.toUncheckedLine(removed.rawLine), 0)!.withSubLines(removed.subLines);
  await targetDmf.insertUnderHeading([uncheckedTask.rawLine, ...uncheckedTask.subLines], dailyTasksHeading);
  return ScheduleOutcome.Moved;
}

export async function deleteChecklistItem(
  app: App,
  sourceFilePath: string,
  item: DayTask,
): Promise<void> {
  await new DayMarkdownFile(app, sourceFilePath).remove(item);
}

/**
 * Sends a day's checklist item back to the inbox, carrying its line over as it stands —
 * the same task, only unscheduled. A line with no ➕ gets today's, which the age badge
 * and the default sort read; indentation is dropped so it lands top-level.
 */
export async function moveChecklistItemToInbox(
  app: App,
  sourceFilePath: string,
  item: DayTask,
  resolvedInboxPath: string,
): Promise<void> {
  await sendToInbox(app, sourceFilePath, item, resolvedInboxPath, null);
}

/** `moveChecklistItemToInbox` plus the ⏳ target date a reschedule leaves on the item
 *  (`null` for a plain unschedule). Returns whether the item was found and moved. */
async function sendToInbox(
  app: App,
  sourceFilePath: string,
  item: DayTask,
  resolvedInboxPath: string,
  targetDate: Date | null,
): Promise<boolean> {
  const removed = await new DayMarkdownFile(app, sourceFilePath).remove(item);
  if (!removed) return false;
  const line = DayTask.toUncheckedLine(removed.rawLine).replace(/^\s+/, "");
  const created = removed.createdAt ? line : `${line} ➕ ${formatDate(new Date())}`;
  // Cleared with no target: a leftover ⏳ would have `migrateInboxTargets` pull the
  // item straight back into a day.
  const inboxLine = DayTask.withUpdatedScheduledDate(created, targetDate);
  const inboxTask = DayTask.parse(inboxLine, 0)!.withSubLines(removed.subLines);
  await new DayMarkdownFile(app, resolvedInboxPath).addTask(inboxTask);
  return true;
}

export async function loadDayChecklist(
  app: App,
  date: Date,
  config?: DailyNotesConfig,
): Promise<{ items: DayTask[]; filePath: string | null }> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const expectedPath = dayNotePath(date, resolvedConfig);

  // Only today's note is created on demand; another day is read only if it has one.
  // Callers wanting the whole week to exist call backfillRecurringHabits() first.
  // `day` is stamped onto every line read: a line falls under its note's day, whatever
  // the line itself says, and that is what orders it in a list.
  const day = startOfDay(date);
  if (sameDay(date, new Date())) {
    const dmf = await DayMarkdownFile.ensure(app, date, resolvedConfig);
    if (!dmf) return { items: [], filePath: null };
    const items = await dmf.parseTasks();
    return { items: items.map((t) => t.withSource(dmf.filePath, day)), filePath: dmf.filePath };
  } else {
    const existing = app.vault.getAbstractFileByPath(expectedPath);
    if (!(existing instanceof TFile)) return { items: [], filePath: null };
    const dmf = new DayMarkdownFile(app, existing.path);
    const items = await dmf.parseTasks();
    return { items: items.map((t) => t.withSource(dmf.filePath, day)), filePath: dmf.filePath };
  }
}

/** Toggles the task on disk and returns the resulting rawLine, so a caller patching the
 *  row locally can keep `item.rawLine` in sync — see day-task-row's `noteKey`. */
export async function toggleChecklistItem(
  app: App,
  filePath: string,
  item: DayTask,
): Promise<string> {
  const dmf = new DayMarkdownFile(app, filePath);
  if (item.checked) {
    await dmf.uncheckTask(item);
    return DayTask.toUncheckedLine(item.rawLine);
  } else {
    const date = new Date();
    await dmf.checkTask(item, date);
    return DayTask.toCheckedLine(item.rawLine, date);
  }
}
