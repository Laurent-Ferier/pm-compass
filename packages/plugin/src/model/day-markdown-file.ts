import { App, TFile, normalizePath, moment as _moment } from "obsidian";
import { DayTask } from "./day-task";
import type { DailyNotesConfig } from "./week-summary";
import {
  computeMissingHabits,
  findHeadingSection,
  isOrphanedHabitTask,
  renderHabitLines,
  type RecurringTaskDefinition,
} from "./recurring-task";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;

// ── Templater plugin interface ────────────────────────────────────────────────

interface TemplaterPlugin {
  templater: {
    create_new_note_from_template(
      template: TFile,
      folder?: string,
      filename?: string,
      open_new_note?: boolean,
    ): Promise<TFile | undefined>;
    overwrite_file_commands(file: TFile, force_overwrite?: boolean): Promise<void>;
  };
}

function getTemplater(app: App): TemplaterPlugin | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = (app as any).plugins?.plugins?.["templater-obsidian"] as
    | TemplaterPlugin
    | undefined;
  return plugin?.templater ? plugin : undefined;
}

// ── Daily notes config ────────────────────────────────────────────────────────

export async function readDailyNotesConfig(app: App): Promise<DailyNotesConfig> {
  const defaults: DailyNotesConfig = { folder: "", format: "YYYY-MM-DD", template: "" };
  try {
    const path = normalizePath(`${app.vault.configDir}/daily-notes.json`);
    const raw = await app.vault.adapter.read(path);
    const data = JSON.parse(raw) as Partial<DailyNotesConfig>;
    return {
      folder: data.folder ?? defaults.folder,
      format: data.format ?? defaults.format,
      template: data.template ?? defaults.template,
    };
  } catch {
    return defaults;
  }
}

/**
 * Checks whether `filePath` is a daily note under `config`'s folder/format, returning
 * the date it represents, or null if it doesn't match the daily-note naming scheme.
 */
export function matchDailyNotePath(filePath: string, config: DailyNotesConfig): Date | null {
  if (!filePath.endsWith(".md")) return null;
  const folderPrefix = config.folder ? normalizePath(config.folder) + "/" : "";
  if (config.folder && !filePath.startsWith(folderPrefix)) return null;
  const basename = filePath.slice(folderPrefix.length, -3);
  if (basename.includes("/")) return null;
  const parsed = moment(basename, config.format, true);
  if (!parsed.isValid()) return null;
  return parsed.toDate();
}

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

/** Locate a task's actual line index, handling a stale lineIndex via an exact rawLine
 *  fallback. Returns -1 (rather than guessing via a substring match) when the line can't
 *  be found unambiguously — callers treat -1 as "nothing to do" rather than risk mutating
 *  an unrelated line. */
function resolveIndex(lines: string[], item: DayTask): number {
  if (lines[item.lineIndex] === item.rawLine) return item.lineIndex;
  return lines.indexOf(item.rawLine);
}

/** Drops trailing blank lines, mirroring how `content.trimEnd()` behaves when appending. */
function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
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

// Serializes read-modify-write operations per file path across DayMarkdownFile instances:
// a fresh instance is created per call site (main.ts's reconcile handler, the dashboard's
// backfill call, task toggling, etc.), so without this, two instances racing on the same
// path could each read stale content and clobber each other's write.
const fileLocks = new Map<string, Promise<unknown>>();

export class DayMarkdownFile {
  readonly filePath: string;
  private readonly app: App;

  constructor(app: App, filePath: string) {
    this.app = app;
    this.filePath = filePath;
  }

  /** Runs `fn` only after any other operation on this same file path has settled. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = fileLocks.get(this.filePath) ?? Promise.resolve();
    const settled = prior.then(fn, fn);
    fileLocks.set(
      this.filePath,
      settled.then(
        () => undefined,
        () => undefined,
      ),
    );
    return settled;
  }

  /**
   * Returns a DayMarkdownFile for the given date, creating the daily note if it
   * does not yet exist (using Templater when available, otherwise raw content).
   * Returns null only if file creation fails.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async ensure(app: App, date: any, config?: DailyNotesConfig): Promise<DayMarkdownFile | null> {
    const resolvedConfig = config ?? await readDailyNotesConfig(app);
    const dateStr = date.format(resolvedConfig.format);
    const filePath = normalizePath(
      resolvedConfig.folder ? `${resolvedConfig.folder}/${dateStr}.md` : `${dateStr}.md`,
    );

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) return new DayMarkdownFile(app, filePath);

    if (resolvedConfig.folder) {
      const folderPath = normalizePath(resolvedConfig.folder);
      if (!app.vault.getAbstractFileByPath(folderPath)) {
        await app.vault.createFolder(folderPath);
      }
    }

    const templater = getTemplater(app);
    const templatePath = resolvedConfig.template
      ? normalizePath(
          resolvedConfig.template.endsWith(".md")
            ? resolvedConfig.template
            : `${resolvedConfig.template}.md`,
        )
      : null;
    const templateFile = templatePath ? app.vault.getAbstractFileByPath(templatePath) : null;

    if (templater && templateFile instanceof TFile) {
      const created = await templater.templater.create_new_note_from_template(
        templateFile,
        resolvedConfig.folder || undefined,
        dateStr,
        false,
      );
      const createdPath = created?.path ?? (
        app.vault.getAbstractFileByPath(filePath) instanceof TFile ? filePath : null
      );
      return createdPath ? new DayMarkdownFile(app, createdPath) : null;
    }

    let content = "";
    if (templateFile instanceof TFile) {
      content = await app.vault.read(templateFile);
    }
    const file = await app.vault.create(filePath, content);
    return new DayMarkdownFile(app, file.path);
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
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return null;
      const [start, end] = getTaskSlice(lines, idx);
      const task = DayTask.parse(lines[start], start);
      if (!task) return null;
      await this.writeLines([...lines.slice(0, start), ...lines.slice(end)]);
      return task.withSubLines(lines.slice(start + 1, end));
    });
  }

  /**
   * Remove all checked tasks (and their sub-lines) from the file and write back.
   * Returns the remaining unchecked tasks (with subLines) in file order.
   */
  async removeCheckedTasks(): Promise<DayTask[]> {
    return this.withLock(async () => {
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
    });
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
    return this.withLock(async () => {
      const group = [task.rawLine, ...task.subLines];
      if (insertAt === undefined) {
        await this.appendGroup(group);
        return;
      }
      const lines = await this.readLines();
      const clamped = Math.max(0, Math.min(insertAt, lines.length));
      lines.splice(clamped, 0, ...group);
      await this.writeLines(lines);
    });
  }

  /** Move a task (and its sub-lines) to another position within this file. */
  async moveTask(item: DayTask, toIndex: number): Promise<void> {
    return this.withLock(async () => {
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
    });
  }

  /**
   * Replace a task's indented sub-lines with `detailText` (using `\n` for line breaks).
   * Each non-empty line is tab-indented, matching `renderHabitLines`'s convention. Blank
   * lines are dropped rather than written out: `getTaskSlice` treats any blank line as the
   * end of a task's sub-line block, so a written-out blank line would be misread as ending
   * the note on the next read, silently truncating everything after it.
   * An empty string clears all sub-lines. No-ops if the task can't be found.
   */
  async updateSubLines(item: DayTask, detailText: string): Promise<void> {
    return this.withLock(async () => {
      const lines = await this.readLines();
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
      await this.writeLines([...lines.slice(0, idx + 1), ...newSubLines, ...lines.slice(end)]);
    });
  }

  /**
   * Replace a task's title text (see `DayTask.withUpdatedTitle`), leaving its checkbox
   * marker and trailing metadata untouched. No-ops if the task can't be found.
   */
  async updateTitle(item: DayTask, newTitle: string): Promise<void> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return;
      lines[idx] = DayTask.withUpdatedTitle(lines[idx], newTitle);
      await this.writeLines(lines);
    });
  }

  /** Mark a task as done (appends ✅ date). */
  async checkTask(item: DayTask, date: Date): Promise<void> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return;
      lines[idx] = DayTask.toCheckedLine(lines[idx], date);
      await this.writeLines(lines);
    });
  }

  /** Mark a task as undone (removes [x] and ✅ date). */
  async uncheckTask(item: DayTask): Promise<void> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return;
      lines[idx] = DayTask.toUncheckedLine(lines[idx]);
      await this.writeLines(lines);
    });
  }

  /**
   * Inserts checklist lines for any recurring habit scheduled for `date` that isn't
   * already present in the file, and removes any habit-tagged line under `headingText`
   * that no longer matches a currently active+scheduled definition (renamed, deactivated,
   * unscheduled for that weekday, or deleted). Returns what changed.
   */
  async reconcileRecurringHabits(
    definitions: RecurringTaskDefinition[],
    date: Date,
    headingText: string,
    habitsTag: string,
  ): Promise<{ inserted: RecurringTaskDefinition[]; removedCount: number }> {
    return this.withLock(async () => {
      let lines = await this.readLines();
      const { missing, insertAt } = computeMissingHabits(lines, definitions, date, headingText, habitsTag);
      if (missing.length > 0) {
        const newLines = missing.flatMap((def) => renderHabitLines(def, habitsTag));
        if (insertAt !== null) {
          lines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
        } else {
          const hadHeading = lines.some((l) => l.trim() === headingText.trim());
          const trimmed = trimTrailingBlankLines(lines);
          lines = hadHeading
            ? [...trimmed, ...newLines]
            : [...trimmed, "", headingText, ...newLines];
        }
        await this.writeLines(lines);
      }

      const removedCount = this.removeOrphanedHabits(lines, definitions, date, headingText, habitsTag);
      if (removedCount.count > 0) await this.writeLines(removedCount.lines);
      return { inserted: missing, removedCount: removedCount.count };
    });
  }

  /**
   * Removes habit-tagged tasks (and their sub-lines) under `headingText` that no longer
   * match a currently active+scheduled definition. Operates on the in-memory `lines`
   * already loaded by the caller instead of re-reading the file.
   */
  private removeOrphanedHabits(
    lines: string[],
    definitions: RecurringTaskDefinition[],
    date: Date,
    headingText: string,
    habitsTag: string,
  ): { lines: string[]; count: number } {
    const section = findHeadingSection(lines, headingText);
    if (!section) return { lines, count: 0 };

    const sectionTasks = parseTasksFromLines(lines).filter(
      (t) => t.lineIndex > section.headingIdx && t.lineIndex < section.end,
    );
    const orphaned = sectionTasks.filter((t) => isOrphanedHabitTask(t, definitions, date, habitsTag));
    if (orphaned.length === 0) return { lines, count: 0 };

    let remaining = lines;
    for (const t of [...orphaned].reverse()) {
      const idx = resolveIndex(remaining, t);
      if (idx === -1) continue;
      const [start, end] = getTaskSlice(remaining, idx);
      remaining = [...remaining.slice(0, start), ...remaining.slice(end)];
    }
    return { lines: remaining, count: orphaned.length };
  }
}
