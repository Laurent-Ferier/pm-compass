import type { App } from "obsidian";
import { Task, taskBlockEnd } from "../daily/task";
import type { Priority } from "../base-task";
import { findHeadingSection } from "../daily/recurring-task";
import {
  appendFileLines,
  readFileLines,
  withFileLock,
  writeFileLines,
} from "./file-helpers";

/**
 * The read-modify-write passes over one note's checklist lines — parse, add, remove, check,
 * retitle, reschedule, reorder. Each one takes the file as it stands inside the lock, so an
 * edit made in Obsidian's editor or landed by a sync since the last reading is never written
 * over. Nothing is held between calls.
 */

// ── Reading lines ────────────────────────────────────────────────────────────

function getTaskSlice(lines: string[], idx: number): [number, number] {
  return [idx, taskBlockEnd(lines, idx)];
}

/** A task's actual line index, falling back to an exact rawLine match for a stale one.
 *  -1 rather than a guess when it can't be found; callers treat that as nothing to do. */
function resolveIndex(lines: string[], item: Task): number {
  if (lines[item.lineIndex] === item.rawLine) return item.lineIndex;
  return lines.indexOf(item.rawLine);
}

/** Drops trailing blank lines, mirroring how `content.trimEnd()` behaves when appending. */
export function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

/** Removes each task and its sub-lines from `lines`, bottom-up so the earlier indices
 *  stay valid. `tasks` is freshly parsed from `lines`, so every entry resolves. */
export function removeTaskGroups(lines: string[], tasks: Task[]): string[] {
  let remaining = lines;
  for (const t of [...tasks].reverse()) {
    const idx = resolveIndex(remaining, t);
    const [start, end] = getTaskSlice(remaining, idx);
    remaining = [...remaining.slice(0, start), ...remaining.slice(end)];
  }
  return remaining;
}

/** Parses tasks out of `lines`, each with its subLines. `filePath` is stamped on every
 *  one, since a row shown from a line has to know which file to write back to. */
export function parseTasksFromLines(lines: string[], filePath: string | null = null): Task[] {
  const tasks: Task[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = Task.parse(lines[i], i)?.withSource(filePath);
    if (t) {
      const [, end] = getTaskSlice(lines, i);
      tasks.push(t.withSubLines(lines.slice(i + 1, end)));
      i = end;
    } else {
      i++;
    }
  }
  return tasks;
}

/** Every top-level task in the file, sub-lines attached. Empty if it doesn't exist. */
export async function parseTasks(app: App, filePath: string): Promise<Task[]> {
  return parseTasksFromLines(await readFileLines(app, filePath), filePath);
}

// ── Writing lines ────────────────────────────────────────────────────────────

/** Removes a task and its sub-lines, returning it with `subLines` populated, or null
 *  when it isn't found. */
export async function removeTask(app: App, filePath: string, item: Task): Promise<Task | null> {
  return withFileLock(filePath, async () => {
    const lines = await readFileLines(app, filePath);
    const idx = resolveIndex(lines, item);
    if (idx === -1) return null;
    const [start, end] = getTaskSlice(lines, idx);
    // `lines[start]` is the item's rawLine, which is a checkbox line by construction.
    const task = Task.parse(lines[start], start)!.withSource(filePath);
    await writeFileLines(app, filePath, [...lines.slice(0, start), ...lines.slice(end)]);
    return task.withSubLines(lines.slice(start + 1, end));
  });
}

/** Removes every checked task and its sub-lines, returning what is left in file order. */
export async function removeCheckedTasks(app: App, filePath: string): Promise<Task[]> {
  return withFileLock(filePath, async () => {
    const lines = await readFileLines(app, filePath);
    const allTasks = parseTasksFromLines(lines, filePath);
    const checkedTasks = allTasks.filter((t) => t.checked);
    if (checkedTasks.length === 0) return allTasks.filter((t) => !t.checked);
    const remaining = removeTaskGroups(lines, checkedTasks);
    await writeFileLines(app, filePath, remaining);
    return parseTasksFromLines(remaining, filePath).filter((t) => !t.checked);
  });
}

/** Appends a new unchecked task with a ➕ creation date, creating the file if needed.
 *  For sub-lines, build the task with `withSubLines()` and call `addTask`. */
export async function createTask(
  app: App,
  filePath: string,
  title: string,
  createdAt: Date,
): Promise<void> {
  await addTask(app, filePath, Task.create(title, createdAt));
}

/** Inserts a task's rawLine and subLines at `insertAt`, or at the end of the file
 *  without it. Creates the file if needed. */
export async function addTask(
  app: App,
  filePath: string,
  task: Task,
  insertAt?: number,
): Promise<void> {
  return withFileLock(filePath, async () => {
    const group = [task.rawLine, ...task.subLines];
    if (insertAt === undefined) {
      await appendFileLines(app, filePath, group);
      return;
    }
    const lines = await readFileLines(app, filePath);
    const clamped = Math.max(0, Math.min(insertAt, lines.length));
    lines.splice(clamped, 0, ...group);
    await writeFileLines(app, filePath, lines);
  });
}

/** Moves a task and its sub-lines just before `anchor`, or after the last task when
 *  that is null — a neighbour rather than an index, so a stale render still lands right. */
export async function moveTaskBefore(
  app: App,
  filePath: string,
  item: Task,
  anchor: Task | null,
): Promise<void> {
  return withFileLock(filePath, async () => {
    const lines = await readFileLines(app, filePath);
    const idx = resolveIndex(lines, item);
    if (idx === -1) return;
    const [start, end] = getTaskSlice(lines, idx);
    const group = lines.slice(start, end);
    const rest = [...lines.slice(0, start), ...lines.slice(end)];

    let insertAt: number;
    if (anchor) {
      // Resolved against the untouched lines, then shifted: in `rest` the indices below
      // the group are stale, and the rawLine fallback could pick a twin line.
      const at = resolveIndex(lines, anchor);
      if (at === -1 || (at >= start && at < end)) return;
      insertAt = at > start ? at - group.length : at;
    } else {
      // The end of the last task's group, not of the file: a drop at the bottom of the
      // list must not push the task past a following heading or footer.
      const tasks = parseTasksFromLines(rest);
      insertAt = tasks.length === 0
        ? rest.length
        : getTaskSlice(rest, tasks[tasks.length - 1].lineIndex)[1];
    }
    await writeFileLines(app, filePath, [...rest.slice(0, insertAt), ...group, ...rest.slice(insertAt)]);
  });
}

/**
 * Replaces a task's sub-lines with `detailText`, tab-indenting each. Blank lines are
 * dropped, since `getTaskSlice` reads one as the end of the block and would truncate
 * the note on the next read. An empty string clears the lot.
 */
export async function updateSubLines(
  app: App,
  filePath: string,
  item: Task,
  detailText: string,
): Promise<void> {
  return withFileLock(filePath, async () => {
    const lines = await readFileLines(app, filePath);
    const idx = resolveIndex(lines, item);
    if (idx === -1) return;
    const [, end] = getTaskSlice(lines, idx);
    const newSubLines =
      detailText === ""
        ? []
        : detailText
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => `\t${l}`);
    await writeFileLines(app, filePath, [...lines.slice(0, idx + 1), ...newSubLines, ...lines.slice(end)]);
  });
}

/** Rewrites one task's own line, and says whether the task was still there to rewrite.
 *  A transform that changes nothing writes nothing, or the views would refresh. */
async function patchLine(
  app: App,
  filePath: string,
  item: Task,
  transform: (line: string) => string,
): Promise<boolean> {
  return withFileLock(filePath, async () => {
    const lines = await readFileLines(app, filePath);
    const idx = resolveIndex(lines, item);
    if (idx === -1) return false;
    const updated = transform(lines[idx]);
    if (updated === lines[idx]) return true;
    lines[idx] = updated;
    await writeFileLines(app, filePath, lines);
    return true;
  });
}

/** Replaces a task's title text, leaving its marker and trailing metadata alone. */
export async function updateTitle(
  app: App,
  filePath: string,
  item: Task,
  newTitle: string,
): Promise<void> {
  await patchLine(app, filePath, item, (line) => Task.withUpdatedTitle(line, newTitle));
}

/** Replaces a task's priority marker; `Priority.None` clears it. */
export async function updatePriority(
  app: App,
  filePath: string,
  item: Task,
  priority: Priority,
): Promise<void> {
  await patchLine(app, filePath, item, (line) => Task.withUpdatedPriority(line, priority));
}

/** Sets a task's ⏳ target date, or clears it with `null`, and says whether the task
 *  was found. */
export async function updateScheduledDate(
  app: App,
  filePath: string,
  item: Task,
  date: Date | null,
): Promise<boolean> {
  return patchLine(app, filePath, item, (line) => Task.withUpdatedScheduledDate(line, date));
}

/** Mark a task as done (appends ✅ date). */
export async function checkTask(
  app: App,
  filePath: string,
  item: Task,
  date: Date,
): Promise<void> {
  await patchLine(app, filePath, item, (line) => Task.toCheckedLine(line, date));
}

/** Mark a task as undone (removes [x] and ✅ date). */
export async function uncheckTask(app: App, filePath: string, item: Task): Promise<void> {
  await patchLine(app, filePath, item, (line) => Task.toUncheckedLine(line));
}

/** Inserts `groupLines` at the end of `headingText`'s section, appending that heading
 *  at EOF first when the file has none. */
export async function insertUnderHeading(
  app: App,
  filePath: string,
  groupLines: string[],
  headingText: string,
): Promise<void> {
  return withFileLock(filePath, async () => {
    let lines = await readFileLines(app, filePath);
    const section = findHeadingSection(lines, headingText);
    if (section) {
      let end = section.end;
      while (end > section.headingIdx + 1 && lines[end - 1].trim() === "") end--;
      lines = [...lines.slice(0, end), ...groupLines, ...lines.slice(end)];
    } else {
      const trimmed = trimTrailingBlankLines(lines);
      lines = [...trimmed, "", headingText, ...groupLines];
    }
    await writeFileLines(app, filePath, lines);
  });
}
