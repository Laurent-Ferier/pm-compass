import { BaseTask } from "../base-task";
import { diffDays, formatDate, parseDate } from "../dates";
import { Priority, Status } from "../base-task";
import type { ModelStore } from "../base-model";
import type { IModel } from "../i-model";
// Mutual: a line is what its file reads there, and the file is what wakes the model over it.
import type { TaskFile } from "../io/task-file";
import type { DayMarkdownFile } from "../store/day-markdown-file";

const CHECKBOX_RE = /^(\s*-\s+)\[([ xX])\]\s*(.+)$/;
const CREATED_DATE_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
const COMPLETED_DATE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const DUE_DATE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const SCHEDULED_DATE_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const START_DATE_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;

/** Normalizes `settings.dailyHabitsTag` to the bare tag name `Task` expects — no
 *  leading `#`, "daily" when unset. */
export function resolveHabitsTag(dailyHabitsTag: string | undefined): string {
  return (dailyHabitsTag || "daily").replace(/^#/, "");
}
/** A checklist line is ticked or not; two rungs is what makes a row draw a checkbox
 *  rather than a status picker — see `BaseTask.statusScale`. */
const DAY_TASK_STATUSES = [Status.Todo, Status.Done] as const;

const PRIORITY_RE = /[🔺⏫🔼🔽⏬]/u;
const PRIORITY_MAP: Record<string, Priority> = {
  "🔺": Priority.Critical,
  "⏫": Priority.High,
  "🔼": Priority.Medium,
  "🔽": Priority.Low,
  "⏬": Priority.Lowest,
};

/** `PRIORITY_MAP` reversed — the marker to write when a priority is set on a line. */
export const PRIORITY_EMOJI: Partial<Record<Priority, string>> = Object.fromEntries(
  Object.entries(PRIORITY_MAP).map(([emoji, level]) => [level, emoji]),
);

/** Whether an inbox item has waited long enough to be flagged as stale. An item aimed
 *  at a day (⏳) is exempt: it is planned, not untriaged. */
export function isStaleInboxItem(
  item: Pick<Task, "createdAt" | "scheduledDate">,
  staleAfterDays: number,
): boolean {
  if (staleAfterDays <= 0 || item.scheduledDate || !item.createdAt) return false;
  return diffDays(item.createdAt, new Date()) >= staleAfterDays;
}


// Every Obsidian Tasks emoji marker and dataview inline field. `🔁` is spelled out
// separately because its payload is a rule in words, not a date; it runs to the next
// marker, tag or field, none of which can appear inside a recurrence rule.
const TASK_METADATA_RE = /🔁(?:\s+[^\s#🔺⏫🔼🔽⏬✅❌📅⏳🛫➕🔁[(]+)*|(?:🔺|⏫|🔼|🔽|⏬|✅|❌|📅|⏳|🛫|➕)(?:\s+\d{4}-\d{2}-\d{2})?|\[[\w-]+::[^\]]*\]|\([\w-]+::[^)]*\)/gu;

// A ✅ completion timestamp, with its leading whitespace so unchecking leaves no
// trailing space.
const CLOSED_TS_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;

// Obsidian tag syntax: # then anything but whitespace, ASCII punctuation and the
// Unicode direction/format blocks. Letters and digits are allowed.
const TAG_RE = /#[^\u2000-\u206f\u2e00-\u2e7f'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/g;

// Strips one `#tag` from `text`. The word-boundary lookahead keeps tag `daily` from
// stripping `#dailyish`.
function stripTag(text: string, tag: string): string {
  const escaped = tag.replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\s*#${escaped}(?![\\w-])`, "g"), "");
}

/** How far a checklist line is indented. */
export function lineIndent(line: string): number {
  // /^(\s*)/ always matches (even against ""), so the capture group is always present.
  return line.match(/^(\s*)/)![1].length;
}

/** Exclusive end of the task block at `idx` — the task's own line plus the sub-lines under
 *  it, stopping at a blank line, a shallower indent, or EOF. The one rule for where a
 *  task's block ends, which the writers and the habit reconciler both order lines by. */
export function taskBlockEnd(lines: string[], idx: number): number {
  const base = lineIndent(lines[idx]);
  let end = idx + 1;
  while (end < lines.length && lines[end].trim() !== "" && lineIndent(lines[end]) > base) end++;
  return end;
}

/** Where a live task reads from: the file holding its line, and the key that line is filed
 *  under there. */
interface LineSource {
  file: TaskFile;
  key: string;
  store: ModelStore;
}

/**
 * One `- [ ] ` line, parsed.
 *
 * Two things wear this class, as `ProjectTaskFields` and `ProjectTask` are two things on the
 * project side: what a note's line reads as, which `TaskFile` parses and replaces on every
 * read, and — bound to a file and a key — the live model over that line, which its file wakes
 * and which goes on saying what the file says. `parse` makes the first; `boundTo` the second.
 *
 * Its fields are plain rather than behind getters because a re-read replaces them wholesale;
 * `take` is the only thing that writes them.
 */
export class Task extends BaseTask implements IModel {
  title: string;
  checked: boolean;
  tags: string[];
  createdAt: Date | null;
  completedAt: Date | null;
  dueDate: Date | null;
  scheduledDate: Date | null;
  startDate: Date | null;
  priority: Priority | null;
  rawLine: string;
  lineIndex: number;
  /** Indented lines that immediately follow this task in the file (notes, sub-bullets). */
  subLines: string[];
  /** The note it was read from, and the day that note is for — see `withSource`. */
  filePath: string | null;
  noteDate: Date | null;

  /** Null for a line parsed out of no note, which nothing wakes and nothing can act on. */
  private source: LineSource | null = null;
  private gone = false;

  private constructor(fields: {
    title: string;
    checked: boolean;
    tags: string[];
    createdAt: Date | null;
    completedAt: Date | null;
    dueDate: Date | null;
    scheduledDate: Date | null;
    startDate: Date | null;
    priority: Priority | null;
    rawLine: string;
    lineIndex: number;
    subLines: string[];
    filePath?: string | null;
    noteDate?: Date | null;
  }) {
    super();
    this.title = fields.title;
    this.checked = fields.checked;
    this.tags = fields.tags;
    this.createdAt = fields.createdAt;
    this.completedAt = fields.completedAt;
    this.dueDate = fields.dueDate;
    this.scheduledDate = fields.scheduledDate;
    this.startDate = fields.startDate;
    this.priority = fields.priority;
    this.rawLine = fields.rawLine;
    this.lineIndex = fields.lineIndex;
    this.subLines = fields.subLines;
    this.filePath = fields.filePath ?? null;
    this.noteDate = fields.noteDate ?? null;
  }

  // ── The live model over one line ─────────────────────────────────────────

  /** This line as its file now holds it, bound so the file can wake it. Made by
   *  `DaySummary`, which is what keeps one per line. */
  static boundTo(file: TaskFile, key: string, store: ModelStore, noteDate: Date | null): Task {
    const line = file.taskFor(key);
    if (!line) throw new Error(`No such line in ${file.filePath}: ${key}`);
    const task = new Task({ ...line.fields(), noteDate });
    task.source = { file, key, store };
    file.attach(task);
    return task;
  }

  /** What names it: the key its file files the line under. Its title for an unbound one,
   *  which is what that key is built from anyway. */
  get id(): string {
    return this.source?.key ?? this.title;
  }

  /** The line has moved. Takes what the file now reads there and tells the store; a line
   *  the file no longer holds leaves this one as it last was. */
  refresh(): void {
    const line = this.source && this.source.file.taskFor(this.source.key);
    if (!this.source || !line) return;
    this.take(line);
    this.source.store.changed(this);
  }

  /** The line has gone. What this task holds is the last thing it said. */
  discard(): void {
    if (this.gone || !this.source) return;
    this.gone = true;
    this.source.file.detach(this);
    this.source.store.changed(this);
  }

  get isGone(): boolean {
    return this.gone;
  }

  // ── Changing the line ────────────────────────────────────────────────────
  //
  // Each of these puts the change on the file at once — so the row a view is drawing moves
  // with the click — and owes the file the pass that lands it. A task the store didn't read
  // has no file to owe, and simply says the new value.

  /** Ticks or unticks the line, the ✅ stamp following the marker. */
  setChecked(value: boolean): void {
    if (value === this.checked) return;
    const closed = new Date();
    this.edit("checked",
      (line) => {
        line.checked = value;
        line.completedAt = value ? closed : null;
        line.rawLine = value ? Task.toCheckedLine(line.rawLine, closed) : Task.toUncheckedLine(line.rawLine);
      },
      (file, at) => value ? file.checkTask(at, closed) : file.uncheckTask(at));
  }

  /** Rewrites the title, the marker and the metadata staying where they are. */
  setTitle(value: string): void {
    if (value === this.title) return;
    this.edit("title",
      (line) => {
        line.rawLine = Task.withUpdatedTitle(line.rawLine, value);
        line.title = value;
      },
      (file, at) => file.updateTitle(at, value),
      value);
  }

  /** Its priority marker; `Priority.None` clears it. */
  setPriority(value: Priority): void {
    this.edit("priority",
      (line) => {
        line.rawLine = Task.withUpdatedPriority(line.rawLine, value);
        line.priority = value || null;
      },
      (file, at) => file.updatePriority(at, value));
  }

  /** Its ⏳ target day, or none. */
  setScheduledDate(value: Date | null): void {
    this.edit("scheduled",
      (line) => {
        line.rawLine = Task.withUpdatedScheduledDate(line.rawLine, value);
        line.scheduledDate = value;
      },
      (file, at) => file.updateScheduledDate(at, value));
  }

  /** The prose under the line — its sub-lines, as one block of text. */
  setNote(text: string): void {
    this.edit("note",
      (line) => {
        line.subLines = text === ""
          ? []
          : text.split("\n").filter((l) => l.trim() !== "").map((l) => `\t${l}`);
      },
      (file, at) => file.updateSubLines(at, text));
  }

  /** Takes the line out of its file. */
  remove(): void {
    this.edit("remove", () => {}, (file, at) => file.remove(at));
  }

  /** Everything set on this line, on the file. Rejects with whatever the write threw. */
  flush(): Promise<void> {
    return this.source?.file.flush() ?? Promise.resolve();
  }

  /**
   * One change: onto the file's own reading at once, and owed to the vault. `at` is the line
   * as the file still has it, which is what the pass resolves against — the file's copy has
   * moved on by then.
   */
  private edit(
    kind: string,
    ahead: (line: Task) => void,
    run: (file: DayMarkdownFile, at: Task) => Promise<unknown>,
    renamedTo?: string,
  ): void {
    const source = this.source;
    if (!source) return ahead(this);
    const at = this.withSource(this.filePath, this.noteDate);
    source.file.owePass(source.key, kind, { ahead, renamedTo, run: (md) => run(md, at) });
  }

  /** Takes another reading of the same line, the file it belongs to left alone. */
  private take(line: Task): void {
    this.title = line.title;
    this.checked = line.checked;
    this.tags = line.tags;
    this.createdAt = line.createdAt;
    this.completedAt = line.completedAt;
    this.dueDate = line.dueDate;
    this.scheduledDate = line.scheduledDate;
    this.startDate = line.startDate;
    this.priority = line.priority;
    this.rawLine = line.rawLine;
    this.lineIndex = line.lineIndex;
    this.subLines = line.subLines;
  }

  /** Everything but the identity of the line, for the copies below. */
  private fields() {
    return {
      title: this.title, checked: this.checked, tags: this.tags,
      createdAt: this.createdAt, completedAt: this.completedAt, dueDate: this.dueDate,
      scheduledDate: this.scheduledDate, startDate: this.startDate, priority: this.priority,
      rawLine: this.rawLine, lineIndex: this.lineIndex, subLines: this.subLines,
      filePath: this.filePath, noteDate: this.noteDate,
    };
  }

  /** A copy that knows where it came from: the note holding the line and the day that
   *  note is for — which file an action writes to, and where it sorts. */
  withSource(filePath: string | null, noteDate?: Date | null): Task {
    return new Task({ ...this.fields(), filePath, noteDate: noteDate ?? null });
  }

  /** The day it falls under: the note's, or for an Inbox line its ⏳ target, else its
   *  📅 deadline. */
  get plannedDate(): Date | undefined {
    return this.noteDate ?? this.scheduledDate ?? this.dueDate ?? undefined;
  }

  static parse(line: string, lineIndex: number): Task | null {
    const m = CHECKBOX_RE.exec(line);
    if (!m) return null;
    const checkChar = m[2];
    const fullText = m[3];
    const checked = checkChar !== " ";
    const createdAt = parseDate(CREATED_DATE_RE.exec(fullText)?.[1]);
    const completedAt = parseDate(COMPLETED_DATE_RE.exec(fullText)?.[1]);
    const dueDate = parseDate(DUE_DATE_RE.exec(fullText)?.[1]);
    const scheduledDate = parseDate(SCHEDULED_DATE_RE.exec(fullText)?.[1]);
    const startDate = parseDate(START_DATE_RE.exec(fullText)?.[1]);
    const priorityChar = PRIORITY_RE.exec(fullText)?.[0] ?? null;
    const priority = priorityChar ? PRIORITY_MAP[priorityChar] : null;
    const title = fullText.replace(TASK_METADATA_RE, "").replace(/\s+/g, " ").trim();
    const tags = [...title.matchAll(TAG_RE)].map((t) => t[0]);
    return new Task({ title, checked, tags, createdAt, completedAt, dueDate, scheduledDate, startDate, priority, rawLine: line, lineIndex, subLines: [] });
  }

  /** Creates a brand-new unchecked task with the given title and creation date. */
  static create(title: string, createdAt: Date): Task {
    return new Task({
      title,
      checked: false,
      tags: [...title.matchAll(TAG_RE)].map((m) => m[0]),
      createdAt,
      completedAt: null,
      dueDate: null,
      scheduledDate: null,
      startDate: null,
      priority: null,
      rawLine: `${Task.checkboxLine(title)} ➕ ${formatDate(createdAt)}`,
      lineIndex: 0,
      subLines: [],
    });
  }

  /** An unchecked checkbox line for `title`, shared by every path that builds one. */
  static checkboxLine(title: string): string {
    return `- [ ] ${title}`;
  }

  /** Returns a copy of this task with the given sub-lines attached. */
  withSubLines(subLines: string[]): Task {
    return new Task({ ...this.fields(), subLines });
  }

  /** rawLine with [x] → [ ] and any ✅ date stripped. */
  static toUncheckedLine(rawLine: string): string {
    return rawLine
      .replace(/^(\s*-\s+)\[x\]/i, "$1[ ]")
      .replace(CLOSED_TS_RE, "");
  }

  /** rawLine with [ ] → [x] and a ✅ date appended. */
  static toCheckedLine(rawLine: string, date: Date): string {
    return rawLine.replace(/^(\s*-\s+)\[ \]/, "$1[x]") + ` ✅ ${formatDate(date)}`;
  }

  /**
   * Rewrites a checkbox line from its parts, keeping the marker as it is. Metadata is
   * collected from anywhere in the line, as `parse` reads it, and re-emitted after the
   * title: `drop` leaves out the tokens being replaced, `afterTitle` and `last` put the
   * replacement where that marker is expected. A line that isn't a checkbox is untouched.
   */
  private static rebuildLine(
    rawLine: string,
    parts: {
      title?: string;
      drop?: (token: string) => boolean;
      afterTitle?: string;
      last?: string;
    },
  ): string {
    const m = CHECKBOX_RE.exec(rawLine);
    if (!m) return rawLine;
    const [, prefix, checkChar, fullText] = m;
    const metadata = (fullText.match(TASK_METADATA_RE) ?? []).filter((t) => !parts.drop?.(t));
    const title = parts.title
      ?? fullText.replace(TASK_METADATA_RE, "").replace(/\s+/g, " ").trim();
    const rebuilt = [title, parts.afterTitle ?? "", ...metadata, parts.last ?? ""]
      .filter((p) => p !== "");
    return `${prefix}[${checkChar}] ${rebuilt.join(" ")}`;
  }

  /** `rawLine` with its title replaced by `newTitle`, the marker and metadata kept. */
  static withUpdatedTitle(rawLine: string, newTitle: string): string {
    return Task.rebuildLine(rawLine, { title: newTitle });
  }

  /** `rawLine` with its priority marker replaced, or removed for `Priority.None`. The
   *  rebuild lands the marker where the Obsidian Tasks plugin expects it. */
  static withUpdatedPriority(rawLine: string, priority: Priority): string {
    return Task.rebuildLine(rawLine, {
      drop: (token) => PRIORITY_RE.test(token),
      afterTitle: PRIORITY_EMOJI[priority] ?? "",
    });
  }

  /** `rawLine` with its ⏳ target set to `date`, or removed for null. The ⏳ lands last,
   *  after the markers expected first; a clear with nothing to clear rebuilds nothing. */
  static withUpdatedScheduledDate(rawLine: string, date: Date | null): string {
    if (!date && !SCHEDULED_DATE_RE.test(rawLine)) return rawLine;
    return Task.rebuildLine(rawLine, {
      drop: (token) => token.startsWith("⏳"),
      last: date ? `⏳ ${formatDate(date)}` : "",
    });
  }

  /** Checklist tags are stored with their `#`; a row wants them bare. */
  get tagNames(): readonly string[] {
    return this.tags.map((t) => t.replace(/^#/, ""));
  }

  /** A line inherits nothing, so the level it carries is the only one it has. */
  get ownPriority(): Priority | null {
    return this.priority;
  }

  /** A line is ticked or it is not — there is no scale on a `- [ ]`. */
  get statusValue(): string {
    return this.checked ? Status.Done : Status.Todo;
  }

  get closedOn(): Date | null {
    return this.completedAt;
  }

  /** Its 📅 deadline, else the ⏳ day it is aimed at — whichever the row shows. */
  get ownDue(): Date | null {
    return this.dueDate ?? this.scheduledDate;
  }

  get createdOn(): Date | null {
    return this.createdAt;
  }

  get fileLine(): number | null {
    return this.lineIndex;
  }

  /** A line inherits nothing: there is no tree above a checklist item. */
  get rollupId(): string | null {
    return null;
  }

  /** Two rungs, which is what makes a row draw a checkbox rather than a picker. */
  get statusScale(): readonly Status[] {
    return DAY_TASK_STATUSES;
  }

  /** A habit line drops the tag that marks it one, so the row reads as the work. */
  rowTitle(habitsTag: string): string {
    return this.habitMatchTitle(habitsTag);
  }

  displayTitle(habitsTag: string): string {
    return stripTag(this.title, habitsTag).replace(TAG_RE, "").replace(/\s+/g, " ").trim();
  }

  /** `title` with only `habitsTag` stripped, for matching a habit line back to its
   *  definition — whose own title may legitimately hold a `#tag`. */
  habitMatchTitle(habitsTag: string): string {
    return stripTag(this.title, habitsTag).replace(/\s+/g, " ").trim();
  }

  /** Every Obsidian tag match in `text`, with positions. A static method so `TAG_RE`
   *  stays internal to this module. */
  static matchAllTags(text: string): RegExpMatchArray[] {
    return [...text.matchAll(TAG_RE)];
  }
}
