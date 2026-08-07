import type { App } from "obsidian";
import { Task } from "../daily/task";
import { readFileLines, resolveFile } from "../operations/file-helpers";
import { BaseFile, type FileFields, sameValue } from "./base-file";
import { parseTasksFromLines } from "../operations/day-note-lines";
import type { VaultData } from "../service/vault-data";
// Mutual: this note is held by the day store, which is what it tells a change to.
import type { DayStore } from "../store/day-store";

/** One checklist line under the key that names it across re-reads. */
export interface KeyedTask {
  key: string;
  task: Task;
}

/** A day note, or the inbox, as it was last read. */
export interface TaskFileFields extends FileFields {
  /** Every line of the file, for a reader wanting its own reading of them — the week
   *  summary counts every checkbox, nested ones included. Empty for a note that isn't there. */
  lines: string[];
  exists: boolean;
}

/** What a change to a day note is: one pass over the file, filed under the key that says
 *  which change it is so a second of the same replaces it. */
export interface LineEdit {
  /** The change onto this file's own reading of the line, ahead of the write that lands it —
   *  so what it holds is what the vault is about to say. */
  ahead: (line: Task) => void;
  /** The line's title once written, when the change is a rename — which is what lets the
   *  re-read follow the task rather than report one gone and another arrived. */
  renamedTo?: string;
  run: (app: App, filePath: string) => Promise<unknown>;
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

  constructor(private readonly store: DayStore, vault: VaultData, filePath: string) {
    super(vault, filePath);
  }

  /** The note off the file. Always off the file rather than the metadata cache: what this
   *  note reads is the text, which the cache says nothing about. */
  async read(): Promise<TaskFileFields> {
    const exists = resolveFile(this.app, this.filePath) !== null;
    return { lines: await readFileLines(this.app, this.filePath), exists };
  }

  /** The day store holds these, so that is what a write of this note's owes a re-read. */
  protected override markStale(): void {
    this.store.invalidate([this.filePath]);
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
   *  line was always called that. What `DaySummary` matches its rows on. */
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
   * model that has no line of its own — the day's own summary; a line wakes the model
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
      // A model over the note itself — the day's summary — is named by the path, and hears
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

  /** The keys built afresh from the lines as they now read. */
  private rekey(): void {
    this.keyed = keyTasks(this.keyed.map((k) => k.task));
    this.byKey = new Map(this.keyed.map((k) => [k.key, k.task]));
  }

  /** Each owed change over the file, in the order they were owed. One pass each: they are
   *  read-modify-write over the same lines, and the file lock is what orders them. */
  protected async writeOwed(owed: readonly LineEdit[]): Promise<void> {
    for (const edit of owed) await edit.run(this.app, this.filePath);
  }
}
