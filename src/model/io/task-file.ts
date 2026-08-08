import { Task, taskBlockEnd } from "../daily/task";
import type { Priority } from "../base-task";
import { findHeadingSection } from "../daily/recurring-task";
import {
  readFileLines,
  resolveFile,
  trimTrailingBlankLines,
  withFileLock,
  writeFileLines,
} from "../operations/file-helpers";
import { BaseFile, type FileFields, sameValue } from "./base-file";
import type { VaultData } from "../service/vault-data";
// Mutual: this note is held by the day store, which is what it tells a change to.
import type { DayStore } from "../store/day-store";

/** One checklist line under the key that names it across re-reads. */
export interface KeyedTask {
  key: string;
  task: Task;
}

/** Where the day notes' files come from. `DayStore` is the one that holds them; an
 *  operation writing across two notes takes this rather than the vault and a pair of paths. */
export interface NoteFiles {
  readonly vault: VaultData;
  file(filePath: string): TaskFile;
}

/** A day note, or the inbox, as it was last read. */
export interface TaskFileFields extends FileFields {
  /** Every line of the file, for a reader wanting its own reading of them — the week
   *  summary counts every checkbox, nested ones included. Empty for a note that isn't there. */
  lines: string[];
  exists: boolean;
}

/** What a change to a day note is: what the note's lines should read as, filed under the key
 *  that says which change it is so a second of the same replaces it. */
export interface LineEdit {
  /** The change onto this file's own reading of the line, ahead of the write that lands it —
   *  so what it holds is what the vault is about to say. */
  ahead: (line: Task) => void;
  /** The line's title once written, when the change is a rename — which is what lets the
   *  re-read follow the task rather than report one gone and another arrived. */
  renamedTo?: string;
  /**
   * The lines as this change leaves them, null leaving them alone. Asked of the file rather
   * than worked out here, the line algebra being its own; and answered rather than written,
   * so everything owed at once lands in one pass over the note.
   */
  apply: (file: TaskFile, lines: string[]) => string[] | null;
}

/**
 * Each task under the key that names it: its title, plus which occurrence of that title it
 * is. A checklist line carries no id, and two lines are allowed to read the same, so this is
 * the most a note can say about which line is which from one read to the next.
 */
export function keyTasks(tasks: Task[]): KeyedTask[] {
  const seen = new Map<string, number>();
  return tasks.map((task) => {
    const n = seen.get(task.title) ?? 0;
    seen.set(task.title, n + 1);
    return { key: n === 0 ? task.title : `${task.title}#${n}`, task };
  });
}

/**
 * The file behind one day note, or the inbox: its lines as they were last read, and the
 * checklist lines they parse to, each under a key of its own.
 *
 * The other kind of note the plugin holds. A project note's fields are its frontmatter, one
 * model over the whole of it; here the file is a list, and the models over it hold a line
 * each — so a re-read wakes the ones whose line moved and leaves the rest alone.
 *
 * Made by `DayStore` alone, which is what it tells a change to.
 */
export class TaskFile extends BaseFile<TaskFileFields, LineEdit> {
  /** What the lines last parsed to, in file order. */
  private keyed: KeyedTask[] = [];
  private byKey = new Map<string, Task>();
  /**
   * Where a key has moved to, for the lines this note has itself renamed. A model goes on
   * asking under the key it was made with, and this is what points that at the line as it
   * now reads.
   */
  private readonly renames = new Map<string, string>();
  /** `renames` read backwards, for saying which model a line as it now reads belongs to. */
  private readonly renamedFrom = new Map<string, string>();

  constructor(store: DayStore, vault: VaultData, filePath: string) {
    super(store, vault, filePath);
  }

  /** The note off the file. Always off the file rather than the metadata cache: what this
   *  note reads is the text, which the cache says nothing about. */
  async read(): Promise<TaskFileFields> {
    const exists = resolveFile(this.app, this.filePath) !== null;
    return { lines: await readFileLines(this.app, this.filePath), exists };
  }

  // ── What the lines read as ───────────────────────────────────────────────

  /** Its checklist lines in file order, each under its key. */
  tasks(): readonly KeyedTask[] {
    return this.keyed;
  }

  /** The line filed under that key, following whatever this note has renamed since. Null
   *  once the line is gone. */
  taskFor(key: string): Task | null {
    return this.byKey.get(this.currentKey(key)) ?? null;
  }

  /** The key the model over that line was made with — where this key came from, unless the
   *  line was always called that. What `DayNote` matches its rows on. */
  originalKey(key: string): string {
    const seen = new Set<string>([key]);
    let at = key;
    for (let from = this.renamedFrom.get(at); from && !seen.has(from); from = this.renamedFrom.get(at)) {
      at = from;
      seen.add(at);
    }
    return at;
  }

  /** Where a key has ended up: the key itself, unless this note renamed the line. */
  private currentKey(key: string): string {
    const seen = new Set<string>([key]);
    let at = key;
    for (let moved = this.renames.get(at); moved && !seen.has(moved); moved = this.renames.get(at)) {
      at = moved;
      seen.add(at);
    }
    return at;
  }

  // ── Taking a re-read ─────────────────────────────────────────────────────

  /**
   * Takes a fresh reading and wakes what moved with it. The note as a whole wakes every
   * model that has no line of its own — the day's own note; a line wakes the model
   * holding it, and one whose line has gone is told so.
   */
  override fill(fields: TaskFileFields): void {
    const moved = !this.fields
      || this.fields.exists !== fields.exists
      || !sameValue(this.fields.lines, fields.lines);
    this.fields = fields;
    if (!moved) return;
    this.reconcile(parseTasksFromLines(fields.lines, this.filePath));
  }

  /** The keys the file now holds, against the ones the models are asking under. */
  private reconcile(tasks: Task[]): void {
    const held = new Set(this.keyed.map((k) => k.key));
    this.keyed = keyTasks(tasks);
    this.byKey = new Map(this.keyed.map((k) => [k.key, k.task]));

    // A rename this note wrote has landed once the key it points at is in the file; from
    // then on the line is simply there under its new name.
    for (const [from, to] of this.renames) {
      if (this.byKey.has(to) || held.has(from)) continue;
      this.renames.delete(from);
      this.renamedFrom.delete(to);
    }

    for (const model of this.attached()) {
      // A model over the note itself — the day's note — is named by the path, and hears
      // about every read: which lines the day holds is exactly what it is watching.
      if (model.id === this.filePath || this.byKey.has(this.currentKey(model.id))) model.refresh();
      else model.discard();
    }
  }

  // ── Writing a line ───────────────────────────────────────────────────────

  /** Gathers one change to a line, filed under that line and the kind of change, so a
   *  second tick of the same line replaces the first rather than queueing behind it. */
  owePass(lineKey: string, kind: string, edit: LineEdit): void {
    // Onto this note's own line first: `owe` wakes the models over it, and what they take
    // has to be what the file is about to say rather than what it still says.
    const at = this.currentKey(lineKey);
    const line = this.byKey.get(at);
    if (line) {
      edit.ahead(line);
      // A key is built from a title, so renaming a line moves it to another one.
      if (edit.renamedTo !== undefined) {
        this.rekey();
        const moved = this.keyed.find((k) => k.task === line);
        if (moved && moved.key !== at) {
          this.renames.set(at, moved.key);
          this.renamedFrom.set(moved.key, at);
        }
      }
    }
    this.owe(`${lineKey}:${kind}`, edit);
  }

  /**
   * One change owed to this note and waited for, answering whatever its pass reports.
   *
   * What every write below is made of, so a change no model holds — a line moving between two
   * notes, an item appended to the inbox — is owed like any other, and marks the note's own
   * re-read. Waited for, unlike a model's line edit, because the caller has the answer to use.
   */
  private async owedNow<T>(
    lineKey: string,
    kind: string,
    mutate: (lines: string[]) => LinePass<T>,
  ): Promise<T> {
    let result!: T;
    this.owePass(lineKey, kind, {
      ahead: () => undefined,
      apply: (_file, lines) => {
        const pass = mutate(lines);
        result = pass.result;
        return pass.write;
      },
    });
    await this.flush();
    return result;
  }

  /** The same, for a change with nothing to report. */
  private owedRewrite(
    lineKey: string,
    kind: string,
    mutate: (lines: string[]) => string[] | null,
  ): Promise<void> {
    return this.owedNow(lineKey, kind, (lines) => ({ write: mutate(lines), result: undefined }));
  }

  /** The keys built afresh from the lines as they now read. */
  private rekey(): void {
    this.keyed = keyTasks(this.keyed.map((k) => k.task));
    this.byKey = new Map(this.keyed.map((k) => [k.key, k.task]));
  }

  /**
   * Every owed change over the file at once: one lock, one reading, one write. Each is asked
   * what the lines it is handed should read as, in the order they were owed, and each resolves
   * its own line afresh — so a change to a line an earlier one moved still lands on it.
   *
   * One pass rather than one apiece because everything owed in a turn belongs to one reading
   * of the note: a run of writes would have the file read, in between, as a note half-changed,
   * and would wake the views once per line.
   */
  protected writeOwed(owed: readonly LineEdit[]): Promise<void> {
    return this.rewrite((lines) => {
      let written = lines;
      for (const edit of owed) written = edit.apply(this, written) ?? written;
      return written === lines ? null : written;
    });
  }

  // ── One guarded pass over the lines ──────────────────────────────────────
  //
  // The pass every owed change lands in. It reads the file as it stands inside the lock
  // rather than working from `fields.lines`, which is only what the store last read: a day
  // note is a file a human types into and a sync rewrites, and the reading held here has
  // already been moved ahead by `owePass`. What to make of those lines is the line algebra's,
  // at the foot of this file, which is pure.

  /**
   * Runs `mutate` over the note's lines with no other pass over the path in flight, and
   * writes back what it asks for — null writing nothing, so a change that changes nothing
   * leaves the file, and the views, alone.
   */
  private async pass<T>(mutate: (lines: string[]) => LinePass<T>): Promise<T> {
    return withFileLock(this.filePath, async () => {
      const { write, result } = mutate(await readFileLines(this.app, this.filePath));
      if (write) await writeFileLines(this.app, this.filePath, write);
      return result;
    });
  }

  /** The same pass, for a change with nothing to report. */
  private rewrite(mutate: (lines: string[]) => string[] | null): Promise<void> {
    return this.pass((lines) => ({ write: mutate(lines), result: undefined }));
  }

  /** Its top-level checklist lines off the file, each stamped with this note. For a caller
   *  wanting the lines as they are right now rather than as the store last read them. */
  async parsedTasks(): Promise<Task[]> {
    return parseTasksFromLines(await readFileLines(this.app, this.filePath), this.filePath);
  }

  // ── Writing a line ───────────────────────────────────────────────────────
  //
  // Each owes its change and waits for it, answering what the pass made of the lines.

  /** Takes a line and its sub-lines out, handing it back with `subLines` populated — null
   *  when the note no longer holds it. */
  removeLine(at: Task): Promise<Task | null> {
    return this.owedNow(at.id, "remove", (lines) => withoutTask(lines, at, this.filePath));
  }

  /** Drops every ticked line, leaving what is still to do — which is what an inbox is. */
  pruneChecked(): Promise<Task[]> {
    return this.owedNow(this.filePath, "prune", (lines) => withoutCheckedTasks(lines, this.filePath));
  }

  /** Puts a line and its sub-lines in at `insertAt`, or at the end of the note without it.
   *  Creates the file when it isn't there. */
  addLine(task: Task, insertAt?: number): Promise<void> {
    return this.owedRewrite(task.id, "add", (lines) => withTaskAdded(lines, task, insertAt));
  }

  /** Appends a new unticked line with a ➕ creation date. For sub-lines, build the task
   *  with `withSubLines()` and call `addLine`. */
  createLine(title: string, createdAt: Date): Promise<void> {
    return this.addLine(Task.create(title, createdAt));
  }

  /** Moves a line and its sub-lines just before `anchor`, or after the last one when that
   *  is null. */
  moveLineBefore(at: Task, anchor: Task | null): Promise<void> {
    return this.owedRewrite(at.id, "move", (lines) => withTaskMovedBefore(lines, at, anchor));
  }

  /** Replaces the prose under a line — its sub-lines, as one block of text. */
  setLineSubLines(at: Task, text: string): Promise<void> {
    return this.owedRewrite(at.id, "note", (lines) => withSubLinesSet(lines, at, text));
  }

  /** Rewrites a line's title, its marker and metadata staying put. Says whether the line
   *  was still there to rewrite. */
  setLineTitle(at: Task, title: string): Promise<boolean> {
    return this.owedNow(at.id, "title", (lines) => withTitleSet(lines, at, title));
  }

  /** Its priority marker; `Priority.None` clears it. */
  setLinePriority(at: Task, priority: Priority): Promise<boolean> {
    return this.owedNow(at.id, "priority", (lines) => withPrioritySet(lines, at, priority));
  }

  /** Its ⏳ target day, or none. */
  setLineScheduled(at: Task, date: Date | null): Promise<boolean> {
    return this.owedNow(at.id, "scheduled", (lines) => withScheduledDateSet(lines, at, date));
  }

  /** Ticks the line, stamping it ✅ that day — or unticks it with `null`. */
  setLineChecked(at: Task, date: Date | null): Promise<boolean> {
    return this.owedNow(at.id, "checked", (lines) => withChecked(lines, at, date));
  }

  /** Puts `groupLines` at the end of `headingText`'s section, appending that heading at
   *  EOF first when the note has none. Keyed on the first line it puts in, so two groups
   *  under one heading in a turn don't stand in for each other. */
  insertUnderHeading(groupLines: string[], headingText: string): Promise<void> {
    return this.owedRewrite(groupLines[0] ?? headingText, "insert",
      (lines) => withGroupUnderHeading(lines, groupLines, headingText));
  }

  // ── The same changes, said rather than written ───────────────────────────
  //
  // What an owed `LineEdit` is built from: the lines it is handed as the change leaves them,
  // null leaving them alone. The pass they run inside is `writeOwed`'s, which gathers
  // everything owed into one. Paired one for one with the methods above, so the algebra
  // behind a change has a single reading whichever way it is asked for.

  /** Without the line and its sub-lines. */
  withoutLine(lines: string[], at: Task): string[] | null {
    return withoutTask(lines, at, this.filePath).write;
  }

  /** Without each of those lines and their sub-lines, taken bottom-up. They are `lines`'
   *  own, freshly parsed from it, so every one of them is found. */
  withoutLines(lines: string[], at: Task[]): string[] {
    return removeTaskGroups(lines, at);
  }

  /** With its title rewritten, marker and metadata staying put. */
  withLineTitle(lines: string[], at: Task, title: string): string[] | null {
    return withTitleSet(lines, at, title).write;
  }

  /** With its priority marker set; `Priority.None` clears it. */
  withLinePriority(lines: string[], at: Task, priority: Priority): string[] | null {
    return withPrioritySet(lines, at, priority).write;
  }

  /** With its ⏳ target day set, or cleared. */
  withLineScheduled(lines: string[], at: Task, date: Date | null): string[] | null {
    return withScheduledDateSet(lines, at, date).write;
  }

  /** With it ticked and stamped ✅ that day, or unticked with `null`. */
  withLineChecked(lines: string[], at: Task, date: Date | null): string[] | null {
    return withChecked(lines, at, date).write;
  }

  /** With the prose under it replaced. */
  withLineSubLines(lines: string[], at: Task, text: string): string[] | null {
    return withSubLinesSet(lines, at, text);
  }

  /** With `groupLines` at the end of `headingText`'s section, the heading appended at EOF
   *  first when the note has none. */
  withGroupUnderHeading(lines: string[], groupLines: string[], headingText: string): string[] {
    return withGroupUnderHeading(lines, groupLines, headingText);
  }
}

// ── The line algebra behind the note ─────────────────────────────────────────
//
// Parse, add, remove, check, retitle, reschedule, reorder. Every pass here is a pure function
// of the lines it is handed: nothing opens a file, nothing holds state between calls. The
// guarded read-modify-write they run inside is the class above's, which owns the path and
// the lock.

/** What a pass makes of the lines: the ones to write back — null writing nothing, so a
 *  change that changes nothing doesn't wake the views — and what it has to report. */
interface LinePass<T> {
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

/** Removes each task and its sub-lines from `lines`, bottom-up so the earlier indices
 *  stay valid. `tasks` is freshly parsed from `lines`, so every entry resolves. */
function removeTaskGroups(lines: string[], tasks: Task[]): string[] {
  let remaining = lines;
  for (const t of [...tasks].sort((a, b) => b.lineIndex - a.lineIndex)) {
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
function withoutTask(
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
function withoutCheckedTasks(
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
function withTaskAdded(lines: string[], task: Task, insertAt?: number): string[] {
  const group = [task.rawLine, ...task.subLines];
  if (insertAt === undefined) return [...trimTrailingBlankLines(lines), ...group];
  const at = Math.max(0, Math.min(insertAt, lines.length));
  return [...lines.slice(0, at), ...group, ...lines.slice(at)];
}

/** Moves a task and its sub-lines just before `anchor`, or after the last task when that is
 *  null — a neighbour rather than an index, so a stale render still lands right. */
function withTaskMovedBefore(
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
function withSubLinesSet(lines: string[], item: Task, detailText: string): string[] | null {
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
function withTitleSet(lines: string[], item: Task, newTitle: string): LinePass<boolean> {
  return patchLine(lines, item, (line) => Task.withUpdatedTitle(line, newTitle));
}

/** Replaces a task's priority marker; `Priority.None` clears it. */
function withPrioritySet(lines: string[], item: Task, priority: Priority): LinePass<boolean> {
  return patchLine(lines, item, (line) => Task.withUpdatedPriority(line, priority));
}

/** Sets a task's ⏳ target date, or clears it with `null`. */
function withScheduledDateSet(lines: string[], item: Task, date: Date | null): LinePass<boolean> {
  return patchLine(lines, item, (line) => Task.withUpdatedScheduledDate(line, date));
}

/** Marks a task done, the ✅ stamp following the marker — or undone with `null`, which
 *  takes the stamp back off. */
function withChecked(lines: string[], item: Task, date: Date | null): LinePass<boolean> {
  return patchLine(lines, item, (line) =>
    date ? Task.toCheckedLine(line, date) : Task.toUncheckedLine(line));
}

/** Puts `groupLines` at the end of `headingText`'s section, appending that heading at EOF
 *  first when the file has none. */
function withGroupUnderHeading(
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
