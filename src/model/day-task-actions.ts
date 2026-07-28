import { App, normalizePath, TFile } from "obsidian";
import type { BaseTask } from "./base-task";
import type { Task } from "./shared";
import type { EffectiveValues } from "./task-scoring";
import { formatDate, sameDay, startOfDay } from "./dates";
import { DayTask, priorityRank } from "./day-task";
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
function byPriority(a: SortKeys, b: SortKeys, dir: InboxSortDir): number {
  const [ra, rb] = [priorityRank(a.priority), priorityRank(b.priority)];
  if (ra && rb) return sign(dir) * (ra - rb);
  if (ra) return -1;
  if (rb) return 1;
  return 0;
}

/** Case- and accent-insensitive title order, so "Écrire" lands next to "ecrire" rather
 *  than after every ASCII title. */
function byTitle(a: SortKeys, b: SortKeys, dir: InboxSortDir): number {
  return sign(dir) * a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
}

/** What the sort modes read off a row, whichever kind of task it is. */
interface SortKeys {
  title: string;
  priority: Priority | null;
  due: Date | null;
  created: Date | null;
  /** Position in the Inbox file; null for a project task, which has no line there. File
   *  order is the one mode that reads the file rather than the task. */
  line: number | null;
}

function sortKeys(task: BaseTask, effectiveValues?: Map<string, EffectiveValues>): SortKeys {
  if (task instanceof DayTask) {
    return {
      title: task.title,
      priority: task.priority,
      // Its 📅 deadline, else the ⏳ day it is aimed at — whichever the row itself shows,
      // so the order can be read off the list.
      due: task.dueDate ?? task.scheduledDate,
      created: task.createdAt,
      line: task.lineIndex,
    };
  }
  const projectTask = task as Task;
  // The values in force, which are what the row shows: a task under a critical parent
  // reads as critical, and its own empty `priority` would sort it last instead.
  const effective = effectiveValues?.get(projectTask.id);
  return {
    title: projectTask.title,
    priority: effective?.priority ?? projectTask.priority ?? null,
    due: effective?.due ?? projectTask.due ?? null,
    created: projectTask.createdAt ?? null,
    line: null,
  };
}

/** Whether `InboxSortBy.Due` has anything to order these rows by. It reads the same key
 *  the mode sorts on, so the two can't disagree about what counts as a deadline. */
export function hasSortableDeadline(
  items: BaseTask[],
  effectiveValues?: Map<string, EffectiveValues>,
): boolean {
  return items.some((item) => sortKeys(item, effectiveValues).due !== null);
}

/**
 * Sorts a copy of `items` for display. `dir` flips the mode's key only: items missing that
 * key stay last, and the tie-break stays newest-first.
 *
 * Takes any `BaseTask`, so the Inbox's own lines and the project tasks waiting beside them
 * are one list in one order rather than two blocks: every mode bar file order reads
 * something both kinds have.
 */
export function sortInboxItems<T extends BaseTask>(
  items: T[],
  sortBy: InboxSortBy = InboxSortBy.Created,
  dir: InboxSortDir = DEFAULT_SORT_DIR[sortBy],
  /** `computeEffectiveValues`' roll-ups, so a project task sorts by the priority and
   *  deadline its row shows rather than by the raw fields of its own file. */
  effectiveValues?: Map<string, EffectiveValues>,
): T[] {
  const keys = new Map<BaseTask, SortKeys>(items.map((item) => [item, sortKeys(item, effectiveValues)]));
  const sorted = [...items];
  sorted.sort((x, y) => {
    const a = keys.get(x)!;
    const b = keys.get(y)!;
    // `File` is the file's own order: the line each item sits on. A row with no line there
    // is missing this mode's key, so it stays last either way, as in every other mode;
    // what settles those is the other fact a file records, when the task was written.
    if (sortBy === InboxSortBy.File) {
      if (a.line !== null && b.line !== null) {
        const diff = sign(dir) * (a.line - b.line);
        if (diff !== 0) return diff;
      } else if (a.line !== null) return -1;
      else if (b.line !== null) return 1;
      const byCreated = byDate(a.created, b.created, InboxSortDir.Desc);
      return byCreated !== 0 ? byCreated : byPriority(a, b, InboxSortDir.Desc);
    }
    if (sortBy === InboxSortBy.Priority) {
      const diff = byPriority(a, b, dir);
      if (diff !== 0) return diff;
    }
    if (sortBy === InboxSortBy.Due) {
      const diff = byDate(a.due, b.due, dir);
      if (diff !== 0) return diff;
    }
    if (sortBy === InboxSortBy.Title) {
      const diff = byTitle(a, b, dir);
      if (diff !== 0) return diff;
    }
    if (sortBy === InboxSortBy.Created) {
      const diff = byDate(a.created, b.created, dir);
      if (diff !== 0) return diff;
    }
    // Whatever the mode, rows it can't tell apart go by priority, most urgent first
    // whichever way the mode reads. Then the newest, as a last resort.
    if (sortBy !== InboxSortBy.Priority) {
      const diff = byPriority(a, b, InboxSortDir.Desc);
      if (diff !== 0) return diff;
    }
    return byDate(a.created, b.created, InboxSortDir.Desc);
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
  const targetDmf = await DayMarkdownFile.ensure(app, new Date());
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
  date: Date,
  config?: DailyNotesConfig,
): Promise<boolean> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const path = dayNotePath(date, resolvedConfig);
  if (path === dayNotePath(new Date(), resolvedConfig)) return true;
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
  // The day note is the schedule now, so any ⏳ the item was waiting on has been honoured.
  const line = DayTask.withUpdatedScheduledDate(removed.rawLine, null);
  await targetDmf.insertUnderHeading([line, ...removed.subLines], dailyTasksHeading);
  return ScheduleOutcome.Moved;
}

/**
 * Writes a brand-new task onto `date`: into that day's checklist when the day takes tasks
 * (see `dayTakesTasks`), otherwise into the inbox carrying a ⏳ target date — the same rule
 * scheduling an existing item follows, so a task is only ever in a day that exists or in
 * the inbox.
 */
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
 * Moves every inbox item whose ⏳ target day takes tasks into that day's checklist, which is
 * what makes a target date a plan rather than a label: it runs on each refresh, so an item
 * planned for next Thursday lands there as soon as that note exists. Returns how many moved.
 * A day that never gets a note keeps its item, past or not — pulling it forward to today
 * would rewrite the plan the user picked.
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
  // Sequentially: each move rewrites the inbox, and a concurrent batch would be resolving
  // its items against line indices the previous write already invalidated.
  // Completed items travel too, keeping their ✅, but always to today: a task that is
  // already done is a record of work, and the record belongs on the day it was closed.
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
  date: Date,
  dailyTasksHeading: string,
  config?: DailyNotesConfig,
): Promise<ScheduleOutcome> {
  if (!await dayTakesTasks(app, date, config)) {
    const sent = await sendToInbox(app, sourceFilePath, item, resolvedInboxPath, date);
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
  date: Date,
  config?: DailyNotesConfig,
): Promise<{ items: DayTask[]; filePath: string | null }> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const expectedPath = dayNotePath(date, resolvedConfig);

  // Only auto-create the note for literal today; other dates are only read if a note
  // already exists. (Callers that want the whole current week guaranteed to exist —
  // e.g. the Dashboard/Week Summary views — call backfillRecurringHabits() beforehand,
  // which is the single source of truth for that guarantee.)
  // Stamped onto every line read: a checklist line falls under its note's day, whatever
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
