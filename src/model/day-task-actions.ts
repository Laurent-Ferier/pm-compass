import { App, normalizePath, TFile } from "obsidian";
import { moment, type Moment } from "./moment";
import { DayTask, priorityRank } from "./day-task";
import { InboxSortBy, InboxSortDir, type Priority } from "./task-vocabulary";
import { DayMarkdownFile, readDailyNotesConfig } from "./day-markdown-file";
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

/** Sets (or, for `Priority.None`, clears) an inbox line's priority marker. */
export async function setInboxItemPriority(
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
 * closed instead of erasing the task entirely.
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
  const checkedTask = DayTask.parse(DayTask.toCheckedLine(removed.rawLine, date), 0)!.withSubLines(
    removed.subLines,
  );
  await targetDmf.addTask(checkedTask);
}

export async function scheduleInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
  date: Moment,
  dailyTasksHeading: string,
): Promise<void> {
  const removed = await new DayMarkdownFile(app, resolvedPath).remove(item);
  if (!removed) return;
  const targetDmf = await DayMarkdownFile.ensure(app, date);
  if (!targetDmf) return;
  await targetDmf.insertUnderHeading([removed.rawLine, ...removed.subLines], dailyTasksHeading);
}

/**
 * Checks whether `date` falls within the allowed planning window for a non-habit
 * ("small") task: the current isoWeek plus `maxWeeksAhead` further weeks. A
 * `maxWeeksAhead` of 0 disables the restriction, matching the "0 to disable"
 * convention used by the other numeric settings in `PMCompassSettings`.
 */
export function isWithinPlanningWindow(
  date: Moment,
  maxWeeksAhead: number,
): { valid: boolean; reason?: string } {
  if (maxWeeksAhead <= 0) return { valid: true };
  const lastAllowedDay = moment().startOf("isoWeek").add(maxWeeksAhead, "weeks").endOf("isoWeek");
  if (date.isAfter(lastAllowedDay, "day")) {
    return {
      valid: false,
      reason: `Small tasks can only be planned up to ${lastAllowedDay.format("MMM D")} (${maxWeeksAhead} week${maxWeeksAhead === 1 ? "" : "s"} ahead).`,
    };
  }
  return { valid: true };
}

// ── Day checklist items ────────────────────────────────────────────────────────

export async function rescheduleChecklistItem(
  app: App,
  sourceFilePath: string,
  item: DayTask,
  date: Moment,
  dailyTasksHeading: string,
): Promise<void> {
  // Confirm the target can be created BEFORE touching the source, so a failure
  // here doesn't leave the item deleted with nowhere to go.
  const targetDmf = await DayMarkdownFile.ensure(app, date);
  if (!targetDmf) return;
  const removed = await new DayMarkdownFile(app, sourceFilePath).remove(item);
  if (!removed) return;
  const uncheckedTask = DayTask.parse(DayTask.toUncheckedLine(removed.rawLine), 0)!.withSubLines(removed.subLines);
  await targetDmf.insertUnderHeading([uncheckedTask.rawLine, ...uncheckedTask.subLines], dailyTasksHeading);
}

export async function deleteChecklistItem(
  app: App,
  sourceFilePath: string,
  item: DayTask,
): Promise<void> {
  await new DayMarkdownFile(app, sourceFilePath).remove(item);
}

export async function moveChecklistItemToInbox(
  app: App,
  sourceFilePath: string,
  item: DayTask,
  resolvedInboxPath: string,
): Promise<void> {
  const removed = await new DayMarkdownFile(app, sourceFilePath).remove(item);
  if (!removed) return;
  const inboxTask = DayTask.create(item.title, new Date()).withSubLines(removed.subLines);
  await new DayMarkdownFile(app, resolvedInboxPath).addTask(inboxTask);
}

export async function loadDayChecklist(
  app: App,
  date: Moment,
  config?: DailyNotesConfig,
): Promise<{ items: DayTask[]; filePath: string | null }> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const dateStr = date.format(resolvedConfig.format);
  const expectedPath = normalizePath(
    resolvedConfig.folder ? `${resolvedConfig.folder}/${dateStr}.md` : `${dateStr}.md`,
  );

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
