import { BaseModel, type ModelStore } from "../base-model";
import { Task } from "./task";
import type { TaskFile } from "../io/task-file";

/**
 * One day's checklist, or the inbox's: the tasks a note holds, kept live.
 *
 * The file underneath reads the note and keys each line; this is what turns those keys into
 * tasks and keeps one per line, so a row a view is holding is the row the file says. A line
 * gained or lost between two reads is gained or lost here.
 *
 * Made by `DayStore` alone, which is what it tells a change to.
 */
export class DayNote extends BaseModel<TaskFile> {
  /** One task per line, by the key its file files that line under. */
  private readonly held = new Map<string, Task>();
  private ordered: Task[] = [];

  constructor(file: TaskFile, store: ModelStore, readonly date: Date | null) {
    super(file, store);
    this.reload();
  }

  /** A day note is named by where it is: the lines under it carry no id of their own, and
   *  this is what tells the file's own model from the ones over a line. */
  get id(): string {
    return this.persistence.filePath;
  }

  get path(): string {
    return this.persistence.filePath;
  }

  get exists(): boolean {
    return this.persistence.snapshot().exists;
  }

  /** The file's lines, for a reader wanting its own reading of them — the week summary
   *  counts every checkbox, nested ones included. */
  get lines(): string[] {
    return this.persistence.snapshot().lines;
  }

  /** Its top-level checklist lines, in file order. */
  get items(): Task[] {
    return this.ordered;
  }

  /**
   * The tasks the file now holds. A line that was there before keeps the task standing for
   * it — its file has already woken it — and one that has gone takes its task with it.
   */
  protected reload(): boolean {
    // By the key each row was made with: a line this file renamed keeps the row it had.
    const keys = this.persistence.tasks().map((k) => this.persistence.originalKey(k.key));
    const now = new Set(keys);
    for (const key of [...this.held.keys()]) if (!now.has(key)) this.held.delete(key);

    this.ordered = keys.map((key) => {
      const kept = this.held.get(key);
      if (kept) return kept;
      const made = Task.boundTo(this.persistence, key, this.store, this.date);
      this.held.set(key, made);
      return made;
    });
    return true;
  }
}
