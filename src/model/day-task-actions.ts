import { App, normalizePath, TFile } from "obsidian";
import { moment, type Moment } from "./moment";
import { DayTask, formatDate, priorityRank } from "./day-task";
import { InboxSortBy, InboxSortDir, ScheduleOutcome, type Priority } from "./task-vocabulary";
import { DayMarkdownFile, dayNotePath, readDailyNotesConfig } from "./day-markdown-file";
import type { DailyNotesConfig } from "./week-summary";

/**
 * App-level operations on day-task checklist items — reading/loading a day's checklist,
 * and the inbox/reschedule/delete/toggle mutations views perform on individual items.
 * Pure `DayMarkdownFile` orchestration with no DOM; shared by the Dashboard, Inbox, and
 * Week Summary views.
 */

// ── Inbox ────────────────────────────────────────────────────────────────────

export function resolveInboxPath(inboxFilePath: string, dnConfig: DailyNotesConfig): string {
  if (inboxFilePath) return normalizePath(inboxFilePath);
  return normalizePath(dnConfig.folder ? `${dnConfig.folder}/Inbox.md` : "Inbox.md");
}

/** The direction each mode starts in — the natural reading of its key. */
const DEFAULT_SORT_DIR: Record<InboxSortBy, InboxSortDir> = {
  [InboxSortBy.Created]: InboxSortDir.Desc,
  [InboxSortBy.Priority]: InboxSortDir.Desc,
  [InboxSortBy.Due]: InboxSortDir.Asc,
  [InboxSortBy.Title]: InboxSortDir.Asc,
  [InboxSortBy.File]: InboxSortDir.Asc,
};

/** The direction in effect for `sortBy`: the user's pick for that mode, else its default.
 *  Stored per mode — one shared value can't mean "newest first" and "A → Z" at once. */
export function resolveInboxSortDir(
  sortBy: InboxSortBy,
  stored: Partial<Record<InboxSortBy, InboxSortDir>> = {},
): InboxSortDir {
  return stored[sortBy] ?? DEFAULT_SORT_DIR[sortBy];
}

const sign = (dir: InboxSortDir): number => (dir === InboxSortDir.Asc ? 1 : -1);

/** Oldest first in `Asc`; items missing the date last in both directions — no marker
 *  means unranked, not earliest or latest. */
function byDate(a: Date | null, b: Date | null, dir: InboxSortDir): number {
  if (a && b) return sign(dir) * (a.getTime() - b.getTime());
  if (a) return -1;
  if (b) return 1;
  return 0;
}

/** Most urgent first in `Desc`; unset priorities last either way, as in `byDate`. */
function byPriority(a: DayTask, b: DayTask, dir: InboxSortDir): number {
  const [ra, rb] = [priorityRank(a.priority), priorityRank(b.priority)];
  if (ra && rb) return sign(dir) * (ra - rb);
  if (ra) return -1;
  if (rb) return 1;
  return 0;
}

/** Case- and accent-insensitive title order, so "Écrire" lands next to "ecrire" rather
 *  than after every ASCII title. */
function byTitle(a: DayTask, b: DayTask, dir: InboxSortDir): number {
  return sign(dir) * a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
}

/** Sorts a copy of `items` for display. `dir` flips the mode's key only: items missing
 *  that key stay last, and the tie-break stays newest-first. */
export function sortInboxItems(
  items: DayTask[],
  sortBy: InboxSortBy = InboxSortBy.Created,
  dir: InboxSortDir = DEFAULT_SORT_DIR[sortBy],
): DayTask[] {
  const sorted = [...items];
  // `File` is "don't sort": the items arrive in the order they appear in the Inbox
  // file, and `lineIndex` restores that order regardless of how the caller got them.
  if (sortBy === InboxSortBy.File) return sorted.sort((a, b) => sign(dir) * (a.lineIndex - b.lineIndex));
  sorted.sort((a, b) => {
    if (sortBy === InboxSortBy.Priority) {
      const diff = byPriority(a, b, dir);
      if (diff !== 0) return diff;
    }
    if (sortBy === InboxSortBy.Due) {
      const diff = byDate(a.dueDate, b.dueDate, dir);
      if (diff !== 0) return diff;
    }
    if (sortBy === InboxSortBy.Title) {
      const diff = byTitle(a, b, dir);
      if (diff !== 0) return diff;
    }
    return byDate(a.createdAt, b.createdAt, sortBy === InboxSortBy.Created ? dir : InboxSortDir.Desc);
  });
  return sorted;
}

export async function readInboxItems(
  app: App,
  resolvedPath: string,
  sortBy: InboxSortBy = InboxSortBy.Created,
  dir: InboxSortDir = DEFAULT_SORT_DIR[sortBy],
): Promise<DayTask[]> {
  const tasks = await new DayMarkdownFile(app, resolvedPath).removeCheckedTasks();
  return sortInboxItems(tasks, sortBy, dir);
}

/** Sets (or, for `Priority.None`, clears) a checklist line's priority marker. Used by both
 *  the Inbox and the dashboard's day checklist, which are the same kind of line. */
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

/**
 * Reorders a checklist item within its own file, placing it immediately before `anchor`
 * (or after the file's last task when `anchor` is null). Shared by the Inbox and the
 * dashboard's daily checklist — both express a drop as "in front of this other item".
 */
export async function reorderChecklistItem(
  app: App,
  filePath: string,
  item: DayTask,
  anchor: DayTask | null,
): Promise<void> {
  await new DayMarkdownFile(app, filePath).moveTaskBefore(item, anchor);
}

/**
 * Closes an inbox item: rather than deleting the line, moves it into today's day file
 * marked as completed (✅), so closing from the Inbox leaves a record on the day it was
 * closed instead of erasing the task entirely. Any ⏳ target date goes with it: the task
 * is done, so the day it was planned for no longer has anything to receive.
 */
export async function closeInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
): Promise<void> {
  const removed = await new DayMarkdownFile(app, resolvedPath).remove(item);
  if (!removed) return;
  const targetDmf = await DayMarkdownFile.ensure(app, moment());
  if (!targetDmf) return;
  const date = new Date();
  const line = DayTask.withUpdatedScheduledDate(DayTask.toCheckedLine(removed.rawLine, date), null);
  const checkedTask = DayTask.parse(line, 0)!.withSubLines(removed.subLines);
  await targetDmf.addTask(checkedTask);
}

/**
 * Whether a task planned for `date` belongs in that day's note yet. Only today (whose
 * note is created on demand) and days that already have a note take tasks in: planning
 * further out must not conjure a string of empty daily notes, so those tasks keep a ⏳
 * target date in the inbox until their day comes into being.
 */
export async function dayTakesTasks(
  app: App,
  date: Moment,
  config?: DailyNotesConfig,
): Promise<boolean> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const path = dayNotePath(date, resolvedConfig);
  if (path === dayNotePath(moment(), resolvedConfig)) return true;
  return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

/**
 * Plans an inbox item for `date`: moves it into that day's checklist when the day takes
 * tasks (see `dayTakesTasks`), otherwise leaves it in the inbox carrying a ⏳ target date
 * — `migrateInboxTargets` moves it across once the day exists.
 */
export async function scheduleInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
  date: Moment,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<ScheduleOutcome> {
  if (!await dayTakesTasks(app, date, config)) {
    const targeted = await new DayMarkdownFile(app, resolvedPath).updateScheduledDate(item, date.toDate());
    return targeted ? ScheduleOutcome.Targeted : ScheduleOutcome.Failed;
  }
  const removed = await new DayMarkdownFile(app, resolvedPath).remove(item);
  if (!removed) return ScheduleOutcome.Failed;
  const targetDmf = await DayMarkdownFile.ensure(app, date, config);
  if (!targetDmf) return ScheduleOutcome.Failed;
  // The day note is the schedule now, so any ⏳ the item was waiting on has been honoured.
  const line = DayTask.withUpdatedScheduledDate(removed.rawLine, null);
  await targetDmf.insertUnderHeading([line, ...removed.subLines], dailyTasksHeading);
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
 * Moves every inbox item whose ⏳ target date has come due into the day it was aimed at —
 * or into today, when that day is past or never got a note. This is what makes a target
 * date a plan rather than a label: it runs on each refresh, so an item planned for next
 * Thursday lands in Thursday's checklist as soon as that note exists. Returns how many
 * items moved.
 */
export async function migrateInboxTargets(
  app: App,
  resolvedInboxPath: string,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<number> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const items = await new DayMarkdownFile(app, resolvedInboxPath).parseTasks();
  // Compared as plain dates: `scheduledDate` is parsed to local midnight, so this is a
  // day-granular "is it still in the future" test.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  let moved = 0;
  // Sequentially: each move rewrites the inbox, and a concurrent batch would be resolving
  // its items against line indices the previous write already invalidated.
  // Completed items travel too, keeping their ✅, but always to today: a task that is
  // already done is a record of work, and the record belongs on the day it was closed.
  for (const item of items) {
    if (!item.scheduledDate) continue;
    const due = item.checked || item.scheduledDate < startOfToday;
    const day = due ? moment() : moment(item.scheduledDate);
    if (!await dayTakesTasks(app, day, resolvedConfig)) continue;
    const outcome = await scheduleInboxItem(app, resolvedInboxPath, item, day, dailyTasksHeading, resolvedConfig);
    if (outcome === ScheduleOutcome.Moved) moved++;
  }
  return moved;
}

// ── Day checklist items ────────────────────────────────────────────────────────

/**
 * Replans a day's checklist item for `date`. A day that doesn't take tasks yet (see
 * `dayTakesTasks`) sends the item back to the inbox with a ⏳ target date instead of
 * getting a note of its own — the same rule the inbox schedules by, so an item is only
 * ever in a day that exists or in the inbox.
 */
export async function rescheduleChecklistItem(
  app: App,
  sourceFilePath: string,
  resolvedInboxPath: string,
  item: DayTask,
  date: Moment,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<ScheduleOutcome> {
  if (!await dayTakesTasks(app, date, config)) {
    const sent = await sendToInbox(app, sourceFilePath, item, resolvedInboxPath, date.toDate());
    return sent ? ScheduleOutcome.Targeted : ScheduleOutcome.Failed;
  }
  // Confirm the target can be created BEFORE touching the source, so a failure
  // here doesn't leave the item deleted with nowhere to go.
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
 * Sends a day's checklist item back to the inbox, carrying its line over as-is (priority,
 * dates, tags) rather than rebuilding it from the title — the item is the same task, just
 * unscheduled. A line with no ➕ marker gets today's, since the inbox's age badge and its
 * default sort both read that date. Any indentation is dropped so the item lands as a
 * top-level inbox line rather than nested under whatever precedes it.
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
  // Cleared when there's no target: a leftover ⏳ would have `migrateInboxTargets` pull
  // the item straight back into a day.
  const inboxLine = DayTask.withUpdatedScheduledDate(created, targetDate);
  const inboxTask = DayTask.parse(inboxLine, 0)!.withSubLines(removed.subLines);
  await new DayMarkdownFile(app, resolvedInboxPath).addTask(inboxTask);
  return true;
}

export async function loadDayChecklist(
  app: App,
  date: Moment,
  config?: DailyNotesConfig,
): Promise<{ items: DayTask[]; filePath: string | null }> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const expectedPath = dayNotePath(date, resolvedConfig);

  // Only auto-create the note for literal today; other dates are only read if a note
  // already exists. (Callers that want the whole current week guaranteed to exist —
  // e.g. the Dashboard/Week Summary views — call backfillRecurringHabits() beforehand,
  // which is the single source of truth for that guarantee.)
  if (date.isSame(moment(), "day")) {
    const dmf = await DayMarkdownFile.ensure(app, date, resolvedConfig);
    if (!dmf) return { items: [], filePath: null };
    return { items: await dmf.parseTasks(), filePath: dmf.filePath };
  } else {
    const existing = app.vault.getAbstractFileByPath(expectedPath);
    if (!(existing instanceof TFile)) return { items: [], filePath: null };
    const dmf = new DayMarkdownFile(app, existing.path);
    return { items: await dmf.parseTasks(), filePath: dmf.filePath };
  }
}

/** Toggles the task on disk and returns the resulting rawLine, so callers doing an
 *  optimistic local update (skipping a full re-render) can keep `item.rawLine` in sync
 *  instead of leaving it stale — see day-task-row's `noteKey` caveat about in-place edits. */
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
