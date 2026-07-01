import { App, TFile } from "obsidian";
import { DayTask } from "./day-task";

// ---------------------------------------------------------------------------
// Module-private pure helpers
// ---------------------------------------------------------------------------

function getIndent(line: string): number {
  return line.match(/^(\s*)/)?.[1].length ?? 0;
}

function getTaskSlice(lines: string[], idx: number): [number, number] {
  const taskIndent = getIndent(lines[idx]);
  let end = idx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "" || getIndent(line) <= taskIndent) break;
    end++;
  }
  return [idx, end];
}

/** Locate a task's actual line index, handling stale lineIndex via rawLine → title fallback. */
function resolveIndex(lines: string[], item: DayTask): number {
  if (lines[item.lineIndex] === item.rawLine) return item.lineIndex;
  const byRaw = lines.indexOf(item.rawLine);
  if (byRaw !== -1) return byRaw;
  return lines.findIndex((l) => l.includes(item.title));
}

/** Parse tasks from a lines array, populating subLines for each task from the surrounding context. */
function parseTasksFromLines(lines: string[]): DayTask[] {
  const tasks: DayTask[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = DayTask.parse(lines[i], i);
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

// ---------------------------------------------------------------------------
// DayMarkdownFile — one instance per file
// ---------------------------------------------------------------------------

export class DayMarkdownFile {
  readonly filePath: string;
  private readonly app: App;

  constructor(app: App, filePath: string) {
    this.app = app;
    this.filePath = filePath;
  }

  private get tfile(): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(this.filePath);
    return f instanceof TFile ? f : null;
  }

  private async readLines(): Promise<string[]> {
    const file = this.tfile;
    if (!file) return [];
    const content = await this.app.vault.read(file);
    return content.replace(/\r\n/g, "\n").split("\n");
  }

  private async writeLines(lines: string[]): Promise<void> {
    const file = this.tfile;
    const text = lines.join("\n");
    if (file) {
      await this.app.vault.modify(file, text);
    } else {
      await this.app.vault.create(this.filePath, text);
    }
  }

  private async appendGroup(group: string[]): Promise<void> {
    const file = this.tfile;
    const text = group.join("\n");
    if (file) {
      const existing = await this.app.vault.read(file);
      await this.app.vault.modify(file, existing ? `${existing.trimEnd()}\n${text}` : text);
    } else {
      await this.app.vault.create(this.filePath, text);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Parse all top-level DayTask entries in the file, each with their
   * indented sub-lines attached. Returns [] if the file does not exist.
   */
  async parseTasks(): Promise<DayTask[]> {
    return parseTasksFromLines(await this.readLines());
  }

  /**
   * Locate a task (tolerating a stale `lineIndex`), remove it together with its
   * indented sub-lines, and return it as a `DayTask` with `subLines` populated.
   * Returns null if not found.
   */
  async remove(item: DayTask): Promise<DayTask | null> {
    const lines = await this.readLines();
    const idx = resolveIndex(lines, item);
    if (idx === -1) return null;
    const [start, end] = getTaskSlice(lines, idx);
    const task = DayTask.parse(lines[start], start);
    if (!task) return null;
    await this.writeLines([...lines.slice(0, start), ...lines.slice(end)]);
    return task.withSubLines(lines.slice(start + 1, end));
  }

  /**
   * Remove all checked tasks (and their sub-lines) from the file and write back.
   * Returns the remaining unchecked tasks (with subLines) in file order.
   */
  async removeCheckedTasks(): Promise<DayTask[]> {
    const lines = await this.readLines();
    const allTasks = parseTasksFromLines(lines);
    const checkedTasks = allTasks.filter((t) => t.checked);
    if (checkedTasks.length === 0) return allTasks.filter((t) => !t.checked);
    // Remove from bottom to top so earlier lineIndices stay valid.
    let remaining = lines;
    for (const t of [...checkedTasks].reverse()) {
      const idx = resolveIndex(remaining, t);
      if (idx === -1) continue;
      const [start, end] = getTaskSlice(remaining, idx);
      remaining = [...remaining.slice(0, start), ...remaining.slice(end)];
    }
    await this.writeLines(remaining);
    return parseTasksFromLines(remaining).filter((t) => !t.checked);
  }

  /**
   * Create a brand-new unchecked task from a title and an explicit creation date (➕).
   * The task is appended at the end of the file. Creates the file if it does not exist.
   * To include sub-lines, build the DayTask with `withSubLines()` and call `addTask` directly.
   */
  async createTask(title: string, createdAt: Date): Promise<void> {
    await this.addTask(DayTask.create(title, createdAt));
  }

  /**
   * Insert a task (using its rawLine and subLines) at the given position.
   * When `insertAt` is omitted the group is appended at the end of the file.
   * Creates the file if it does not exist.
   */
  async addTask(task: DayTask, insertAt?: number): Promise<void> {
    const group = [task.rawLine, ...task.subLines];
    if (insertAt === undefined) {
      await this.appendGroup(group);
      return;
    }
    const lines = await this.readLines();
    const clamped = Math.max(0, Math.min(insertAt, lines.length));
    lines.splice(clamped, 0, ...group);
    await this.writeLines(lines);
  }

  /** Move a task (and its sub-lines) to another position within this file. */
  async moveTask(item: DayTask, toIndex: number): Promise<void> {
    const lines = await this.readLines();
    const idx = resolveIndex(lines, item);
    if (idx === -1) return;
    const [start, end] = getTaskSlice(lines, idx);
    const group = lines.slice(start, end);
    const withoutGroup = [...lines.slice(0, start), ...lines.slice(end)];
    const adjusted = toIndex > start ? toIndex - group.length : toIndex;
    const clamped = Math.max(0, Math.min(adjusted, withoutGroup.length));
    await this.writeLines([
      ...withoutGroup.slice(0, clamped),
      ...group,
      ...withoutGroup.slice(clamped),
    ]);
  }

  /** Mark a task as done (appends ✅ date). */
  async checkTask(item: DayTask, date: Date): Promise<void> {
    const lines = await this.readLines();
    const idx = resolveIndex(lines, item);
    if (idx === -1) return;
    lines[idx] = DayTask.toCheckedLine(lines[idx], date);
    await this.writeLines(lines);
  }

  /** Mark a task as undone (removes [x] and ✅ date). */
  async uncheckTask(item: DayTask): Promise<void> {
    const lines = await this.readLines();
    const idx = resolveIndex(lines, item);
    if (idx === -1) return;
    lines[idx] = DayTask.toUncheckedLine(lines[idx]);
    await this.writeLines(lines);
  }
}
