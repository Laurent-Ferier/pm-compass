import { Task, taskBlockEnd } from "../daily/task";
import type { Priority } from "../base-task";
import { findHeadingSection } from "../daily/recurring-task";

/**
 * The line algebra behind one note's checklist — parse, add, remove, check, retitle,
 * reschedule, reorder. Every pass here is a pure function of the lines it is handed: nothing
 * opens a file, nothing holds state between calls. The guarded read-modify-write these run
 * inside belongs to `TaskFile`, which is what owns the path and the lock.
 */

/** What a pass makes of the lines: the ones to write back — null writing nothing, so a
 *  change that changes nothing doesn't wake the views — and what it has to report. */
export interface LinePass<T> {
  write: string[] | null;
  result: T;
}

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

/** Drops trailing blank lines, so an append lands right after the last line with anything
 *  on it. */
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

// ── Rewriting lines ──────────────────────────────────────────────────────────

/** Drops a task and its sub-lines, reporting it with `subLines` populated — or null when
 *  it isn't there, which is nothing to write. */
export function withoutTask(
  lines: string[],
  item: Task,
  filePath: string | null = null,
): LinePass<Task | null> {
  const idx = resolveIndex(lines, item);
  if (idx === -1) return { write: null, result: null };
  const [start, end] = getTaskSlice(lines, idx);
  // `lines[start]` is the item's rawLine, which is a checkbox line by construction.
  const task = Task.parse(lines[start], start)!.withSource(filePath);
  return {
    write: [...lines.slice(0, start), ...lines.slice(end)],
    result: task.withSubLines(lines.slice(start + 1, end)),
  };
}

/** Drops every checked task and its sub-lines, reporting what is left in file order. */
export function withoutCheckedTasks(
  lines: string[],
  filePath: string | null = null,
): LinePass<Task[]> {
  const all = parseTasksFromLines(lines, filePath);
  const checked = all.filter((t) => t.checked);
  if (checked.length === 0) return { write: null, result: all };
  const remaining = removeTaskGroups(lines, checked);
  return { write: remaining, result: parseTasksFromLines(remaining, filePath) };
}

/** Puts a task's rawLine and subLines at `insertAt`, or after the file's last non-blank
 *  line without it. */
export function withTaskAdded(lines: string[], task: Task, insertAt?: number): string[] {
  const group = [task.rawLine, ...task.subLines];
  if (insertAt === undefined) return [...trimTrailingBlankLines(lines), ...group];
  const at = Math.max(0, Math.min(insertAt, lines.length));
  return [...lines.slice(0, at), ...group, ...lines.slice(at)];
}

/** Moves a task and its sub-lines just before `anchor`, or after the last task when that is
 *  null — a neighbour rather than an index, so a stale render still lands right. */
export function withTaskMovedBefore(
  lines: string[],
  item: Task,
  anchor: Task | null,
): string[] | null {
  const idx = resolveIndex(lines, item);
  if (idx === -1) return null;
  const [start, end] = getTaskSlice(lines, idx);
  const group = lines.slice(start, end);
  const rest = [...lines.slice(0, start), ...lines.slice(end)];

  let insertAt: number;
  if (anchor) {
    // Resolved against the untouched lines, then shifted: in `rest` the indices below
    // the group are stale, and the rawLine fallback could pick a twin line.
    const at = resolveIndex(lines, anchor);
    if (at === -1 || (at >= start && at < end)) return null;
    insertAt = at > start ? at - group.length : at;
  } else {
    // The end of the last task's group, not of the file: a drop at the bottom of the
    // list must not push the task past a following heading or footer.
    const tasks = parseTasksFromLines(rest);
    insertAt = tasks.length === 0
      ? rest.length
      : getTaskSlice(rest, tasks[tasks.length - 1].lineIndex)[1];
  }
  return [...rest.slice(0, insertAt), ...group, ...rest.slice(insertAt)];
}

/**
 * Replaces a task's sub-lines with `detailText`, tab-indenting each. Blank lines are
 * dropped, since `getTaskSlice` reads one as the end of the block and would truncate
 * the note on the next read. An empty string clears the lot.
 */
export function withSubLinesSet(lines: string[], item: Task, detailText: string): string[] | null {
  const idx = resolveIndex(lines, item);
  if (idx === -1) return null;
  const [, end] = getTaskSlice(lines, idx);
  const newSubLines = detailText === ""
    ? []
    : detailText.split("\n").filter((l) => l.trim() !== "").map((l) => `\t${l}`);
  return [...lines.slice(0, idx + 1), ...newSubLines, ...lines.slice(end)];
}

/** Rewrites one task's own line, and says whether the task was still there to rewrite.
 *  A transform that changes nothing writes nothing, or the views would refresh. */
function patchLine(
  lines: string[],
  item: Task,
  transform: (line: string) => string,
): LinePass<boolean> {
  const idx = resolveIndex(lines, item);
  if (idx === -1) return { write: null, result: false };
  const updated = transform(lines[idx]);
  if (updated === lines[idx]) return { write: null, result: true };
  return { write: [...lines.slice(0, idx), updated, ...lines.slice(idx + 1)], result: true };
}

/** Replaces a task's title text, leaving its marker and trailing metadata alone. */
export function withTitleSet(lines: string[], item: Task, newTitle: string): LinePass<boolean> {
  return patchLine(lines, item, (line) => Task.withUpdatedTitle(line, newTitle));
}

/** Replaces a task's priority marker; `Priority.None` clears it. */
export function withPrioritySet(lines: string[], item: Task, priority: Priority): LinePass<boolean> {
  return patchLine(lines, item, (line) => Task.withUpdatedPriority(line, priority));
}

/** Sets a task's ⏳ target date, or clears it with `null`. */
export function withScheduledDateSet(lines: string[], item: Task, date: Date | null): LinePass<boolean> {
  return patchLine(lines, item, (line) => Task.withUpdatedScheduledDate(line, date));
}

/** Marks a task done, the ✅ stamp following the marker — or undone with `null`, which
 *  takes the stamp back off. */
export function withChecked(lines: string[], item: Task, date: Date | null): LinePass<boolean> {
  return patchLine(lines, item, (line) =>
    date ? Task.toCheckedLine(line, date) : Task.toUncheckedLine(line));
}

/** Puts `groupLines` at the end of `headingText`'s section, appending that heading at EOF
 *  first when the file has none. */
export function withGroupUnderHeading(
  lines: string[],
  groupLines: string[],
  headingText: string,
): string[] {
  const section = findHeadingSection(lines, headingText);
  if (!section) {
    return [...trimTrailingBlankLines(lines), "", headingText, ...groupLines];
  }
  let end = section.end;
  while (end > section.headingIdx + 1 && lines[end - 1].trim() === "") end--;
  return [...lines.slice(0, end), ...groupLines, ...lines.slice(end)];
}
