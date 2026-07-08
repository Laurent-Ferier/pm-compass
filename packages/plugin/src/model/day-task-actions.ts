import { App, normalizePath, TFile, moment as _moment } from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import { DayTask } from "./day-task";
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

export async function readInboxItems(app: App, resolvedPath: string): Promise<DayTask[]> {
  const tasks = await new DayMarkdownFile(app, resolvedPath).removeCheckedTasks();
  tasks.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.getTime() - a.createdAt.getTime();
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return 0;
  });
  return tasks;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
): Promise<void> {
  const removed = await new DayMarkdownFile(app, resolvedPath).remove(item);
  if (!removed) return;
  const targetDmf = await DayMarkdownFile.ensure(app, date);
  if (!targetDmf) return;
  await targetDmf.addTask(removed);
}

/**
 * Checks whether `date` falls within the allowed planning window for a non-habit
 * ("small") task: the current isoWeek plus `maxWeeksAhead` further weeks. A
 * `maxWeeksAhead` of 0 disables the restriction, matching the "0 to disable"
 * convention used by the other numeric settings in `PMCompassSettings`.
 */
export function isWithinPlanningWindow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
): Promise<void> {
  // Confirm the target can be created BEFORE touching the source, so a failure
  // here doesn't leave the item deleted with nowhere to go.
  const targetDmf = await DayMarkdownFile.ensure(app, date);
  if (!targetDmf) return;
  const removed = await new DayMarkdownFile(app, sourceFilePath).remove(item);
  if (!removed) return;
  const uncheckedTask = DayTask.parse(DayTask.toUncheckedLine(removed.rawLine), 0)!.withSubLines(removed.subLines);
  await targetDmf.addTask(uncheckedTask);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
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
