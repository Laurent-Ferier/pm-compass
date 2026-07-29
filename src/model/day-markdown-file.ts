import { App, TFile, normalizePath } from "obsidian";
import { formatPattern, parsePattern } from "./date-format";
import { DayTask } from "./day-task";
import type { Priority } from "./task-vocabulary";
import type { DailyNotesConfig } from "./week-summary";
import {
  computeMissingHabits,
  findHeadingSection,
  isOrphanedHabitTask,
  renderHabitLines,
  reorderScheduledHabits,
  type RecurringTaskDefinition,
} from "./recurring-task";
import { ensureFolderRecursive, parentDirOf, resolveFile } from "./operations/file-helpers";

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

interface AppWithPlugins extends App {
  plugins?: { plugins?: Record<string, unknown> };
}

function getTemplater(app: App): TemplaterPlugin | undefined {
  const withPlugins = app as unknown as AppWithPlugins;
  const plugin = withPlugins.plugins?.plugins?.["templater-obsidian"] as
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

/** The path a day's note has under `config` — whether or not that file exists yet. */
export function dayNotePath(date: Date, config: DailyNotesConfig): string {
  const dateStr = formatPattern(date, config.format);
  return normalizePath(config.folder ? `${config.folder}/${dateStr}.md` : `${dateStr}.md`);
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
  return parsePattern(basename, config.format);
}

// ---------------------------------------------------------------------------
// Module-private pure helpers
// ---------------------------------------------------------------------------

function getIndent(line: string): number {
  // /^(\s*)/ always matches (even against ""), so the capture group is always present.
  return line.match(/^(\s*)/)![1].length;
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

/**
 * Removes each task (and its indented sub-lines) from `lines`, working from the
 * bottom of `tasks` upward so earlier line indices stay valid as later ones are removed.
 * `tasks` is always freshly parsed from `lines` by the caller, so every entry is
 * guaranteed to still resolve to a real index.
 */
function removeTaskGroups(lines: string[], tasks: DayTask[]): string[] {
  let remaining = lines;
  for (const t of [...tasks].reverse()) {
    const idx = resolveIndex(remaining, t);
    const [start, end] = getTaskSlice(remaining, idx);
    remaining = [...remaining.slice(0, start), ...remaining.slice(end)];
  }
  return remaining;
}

/** Parse tasks from a lines array, populating subLines for each task from the surrounding
 *  context. `filePath` is stamped onto every task read: a line says nothing about the note
 *  holding it, and a row shown from one has to know which file to write back to. */
function parseTasksFromLines(lines: string[], filePath: string | null = null): DayTask[] {
  const tasks: DayTask[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = DayTask.parse(lines[i], i)?.withSource(filePath);
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
  static async ensure(app: App, date: Date, config?: DailyNotesConfig): Promise<DayMarkdownFile | null> {
    const resolvedConfig = config ?? await readDailyNotesConfig(app);
    const dateStr = formatPattern(date, resolvedConfig.format);
    const filePath = dayNotePath(date, resolvedConfig);

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) return new DayMarkdownFile(app, filePath);

    // The date format itself can embed slashes (e.g. "YYYY/MM/DD"), so the file's
    // parent directory may be nested even when resolvedConfig.folder is blank.
    const parentDir = parentDirOf(filePath);
    if (parentDir) {
      await ensureFolderRecursive(app, parentDir);
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
    return resolveFile(this.app, this.filePath);
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
    return parseTasksFromLines(await this.readLines(), this.filePath);
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
      // lines[start] === item.rawLine (that's how idx was resolved), and every DayTask's
      // rawLine is by construction a checkbox line, so this always parses.
      const task = DayTask.parse(lines[start], start)!.withSource(this.filePath);
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
      const allTasks = parseTasksFromLines(lines, this.filePath);
      const checkedTasks = allTasks.filter((t) => t.checked);
      if (checkedTasks.length === 0) return allTasks.filter((t) => !t.checked);
      const remaining = removeTaskGroups(lines, checkedTasks);
      await this.writeLines(remaining);
      return parseTasksFromLines(remaining, this.filePath).filter((t) => !t.checked);
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

  /**
   * Move a task (and its sub-lines) so it sits immediately before `anchor`, or after the
   * file's last task when `anchor` is null. The destination is a neighbouring task rather
   * than a line index, so a reorder decided from a rendered list stays correct even if the
   * file shifted underneath it since that render.
   * No-ops if either task can't be found.
   */
  async moveTaskBefore(item: DayTask, anchor: DayTask | null): Promise<void> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return;
      const [start, end] = getTaskSlice(lines, idx);
      const group = lines.slice(start, end);
      const rest = [...lines.slice(0, start), ...lines.slice(end)];

      let insertAt: number;
      if (anchor) {
        // Resolved against the untouched lines, then shifted: every line below the moved
        // group has a stale index in `rest`, which would send `resolveIndex` to its
        // rawLine fallback and, where two tasks share a line, pick the wrong one.
        const at = resolveIndex(lines, anchor);
        if (at === -1 || (at >= start && at < end)) return;
        insertAt = at > start ? at - group.length : at;
      } else {
        // The end of the last task's own group, not the end of the file: dropping at the
        // bottom of a list must not push the task past trailing content (a following
        // heading, a footer) that isn't a task at all.
        const tasks = parseTasksFromLines(rest);
        insertAt = tasks.length === 0
          ? rest.length
          : getTaskSlice(rest, tasks[tasks.length - 1].lineIndex)[1];
      }
      await this.writeLines([...rest.slice(0, insertAt), ...group, ...rest.slice(insertAt)]);
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

  /**
   * Replace a task's priority marker (see `DayTask.withUpdatedPriority`);
   * `Priority.None` clears it. No-ops if the task can't be found.
   */
  async updatePriority(item: DayTask, priority: Priority): Promise<void> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return;
      lines[idx] = DayTask.withUpdatedPriority(lines[idx], priority);
      await this.writeLines(lines);
    });
  }

  /**
   * Set a task's ⏳ target date, or clear it with `null` (see
   * `DayTask.withUpdatedScheduledDate`). Returns whether the task was found — a line that
   * already carries the date asked for counts as found, but is left as it is: an identical
   * rewrite would still fire a `modify` event and send the views into another refresh.
   */
  async updateScheduledDate(item: DayTask, date: Date | null): Promise<boolean> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return false;
      const updated = DayTask.withUpdatedScheduledDate(lines[idx], date);
      if (updated === lines[idx]) return true;
      lines[idx] = updated;
      await this.writeLines(lines);
      return true;
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
   * already present in the file, and removes any habit-tagged line anywhere in the file
   * that no longer matches a currently active+scheduled definition (renamed, deactivated,
   * unscheduled for that weekday, or deleted). Pruning isn't limited to `headingText`'s
   * section so that habit lines left over in notes from before the heading existed, or
   * from a since-renamed heading, still get cleaned up. Returns what changed.
   */
  async reconcileRecurringHabits(
    definitions: RecurringTaskDefinition[],
    date: Date,
    headingText: string,
    habitsTag: string,
  ): Promise<{ inserted: RecurringTaskDefinition[]; removedCount: number }> {
    return this.withLock(async () => {
      const original = await this.readLines();
      let lines = original;
      const { missing, insertAt } = computeMissingHabits(lines, definitions, date, headingText, habitsTag);
      if (missing.length > 0) {
        const newLines = missing.flatMap((def) => renderHabitLines(def, habitsTag));
        if (insertAt !== null) {
          lines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
        } else {
          // insertAt is only null when computeMissingHabits couldn't find the heading
          // in `lines`, so the heading is always absent here and must be added.
          const trimmed = trimTrailingBlankLines(lines);
          lines = [...trimmed, "", headingText, ...newLines];
        }
      }

      const removal = this.removeOrphanedHabits(lines, definitions, date, habitsTag);
      lines = removal.lines;

      // Missing habits are inserted at the end of the section, so on-disk order can drift
      // from the definitions' `order`; this restores it (also fixing notes reordered by hand).
      lines = reorderScheduledHabits(lines, definitions, date, headingText, habitsTag);

      if (lines !== original) await this.writeLines(lines);
      return { inserted: missing, removedCount: removal.count };
    });
  }

  /**
   * Inserts `groupLines` (a task's rawLine plus any indented subLines) at the end of
   * `headingText`'s section, appending the heading at EOF first if it isn't present yet.
   */
  async insertUnderHeading(groupLines: string[], headingText: string): Promise<void> {
    return this.withLock(async () => {
      let lines = await this.readLines();
      const section = findHeadingSection(lines, headingText);
      if (section) {
        let end = section.end;
        while (end > section.headingIdx + 1 && lines[end - 1].trim() === "") end--;
        lines = [...lines.slice(0, end), ...groupLines, ...lines.slice(end)];
      } else {
        const trimmed = trimTrailingBlankLines(lines);
        lines = [...trimmed, "", headingText, ...groupLines];
      }
      await this.writeLines(lines);
    });
  }

  /**
   * Removes habit-tagged tasks (and their sub-lines) anywhere in the file that no longer
   * match a currently active+scheduled definition. Operates on the in-memory `lines`
   * already loaded by the caller instead of re-reading the file.
   */
  private removeOrphanedHabits(
    lines: string[],
    definitions: RecurringTaskDefinition[],
    date: Date,
    habitsTag: string,
  ): { lines: string[]; count: number } {
    const tasks = parseTasksFromLines(lines);
    const orphaned = tasks.filter((t) => isOrphanedHabitTask(t, definitions, date, habitsTag));
    if (orphaned.length === 0) return { lines, count: 0 };

    return { lines: removeTaskGroups(lines, orphaned), count: orphaned.length };
  }
}
