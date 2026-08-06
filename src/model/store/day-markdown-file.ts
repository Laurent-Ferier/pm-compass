import { App, TFile, normalizePath } from "obsidian";
import { formatPattern, parsePattern } from "../date-format";
import { DayTask, taskBlockEnd } from "../daily/day-task";
import type { Priority } from "../base-task";
import type { DailyNotesConfig } from "../daily/week-summary";
import {
  computeMissingHabits,
  findHeadingSection,
  isOrphanedHabitTask,
  renderHabitLines,
  reorderScheduledHabits,
  type RecurringTaskDefinition,
} from "../daily/recurring-task";
import { ensureFolderRecursive, parentDirOf, resolveFile } from "../operations/file-helpers";
import { canCreateDayNotes, dailyNotesConfigPath } from "../daily/daily-notes-plugin";

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
    const raw = await app.vault.adapter.read(dailyNotesConfigPath(app));
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

/** The date `filePath` stands for as a daily note under `config`, or null when it
 *  doesn't match the naming scheme. */
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

function getTaskSlice(lines: string[], idx: number): [number, number] {
  return [idx, taskBlockEnd(lines, idx)];
}

/** A task's actual line index, falling back to an exact rawLine match for a stale one.
 *  -1 rather than a guess when it can't be found; callers treat that as nothing to do. */
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

/** Removes each task and its sub-lines from `lines`, bottom-up so the earlier indices
 *  stay valid. `tasks` is freshly parsed from `lines`, so every entry resolves. */
function removeTaskGroups(lines: string[], tasks: DayTask[]): string[] {
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
export function parseTasksFromLines(lines: string[], filePath: string | null = null): DayTask[] {
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

// Serializes read-modify-write per file path across instances, of which each call site
// makes its own — two racing on one path would clobber each other's write.
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

  /** The file for `date`, creating the daily note if it doesn't exist yet — via
   *  Templater where available. Null when creation fails, and when it is refused because
   *  the vault says nowhere to put one (see `canCreateDayNotes`); a caller moving a line
   *  into that note resolves it before touching the source, or the line is lost. */
  static async ensure(app: App, date: Date, config?: DailyNotesConfig): Promise<DayMarkdownFile | null> {
    const resolvedConfig = config ?? await readDailyNotesConfig(app);
    const dateStr = formatPattern(date, resolvedConfig.format);
    const filePath = dayNotePath(date, resolvedConfig);

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) return new DayMarkdownFile(app, filePath);

    // With the Daily notes plugin off and no config it left behind, `resolvedConfig` is
    // this plugin's own guess — creating a note from it would drop files in the vault
    // root under a date format nobody chose. Reading the existing ones stays fine.
    // Refused in silence: most calls here are a render reading the day, not a request to
    // make one. What is asked for by a click says so — see the dashboard's date label.
    if (!await canCreateDayNotes(app)) return null;

    // The format can embed slashes ("YYYY/MM/DD"), so the parent may be nested even
    // with a blank folder.
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

  /** The file's lines, or none at all when it doesn't exist. Public for the store, which
   *  keeps them: a reader wanting its own reading of the file — the week summary counts
   *  every checkbox, nested ones included — works off these rather than off `parseTasks`. */
  async readLines(): Promise<string[]> {
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

  /** Every top-level task in the file, sub-lines attached. Empty if it doesn't exist. */
  async parseTasks(): Promise<DayTask[]> {
    return parseTasksFromLines(await this.readLines(), this.filePath);
  }

  /** Removes a task and its sub-lines, returning it with `subLines` populated, or null
   *  when it isn't found. */
  async remove(item: DayTask): Promise<DayTask | null> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return null;
      const [start, end] = getTaskSlice(lines, idx);
      // `lines[start]` is the item's rawLine, which is a checkbox line by construction.
      const task = DayTask.parse(lines[start], start)!.withSource(this.filePath);
      await this.writeLines([...lines.slice(0, start), ...lines.slice(end)]);
      return task.withSubLines(lines.slice(start + 1, end));
    });
  }

  /** Removes every checked task and its sub-lines, returning what is left in file order. */
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

  /** Appends a new unchecked task with a ➕ creation date, creating the file if needed.
   *  For sub-lines, build the task with `withSubLines()` and call `addTask`. */
  async createTask(title: string, createdAt: Date): Promise<void> {
    await this.addTask(DayTask.create(title, createdAt));
  }

  /** Inserts a task's rawLine and subLines at `insertAt`, or at the end of the file
   *  without it. Creates the file if needed. */
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

  /** Moves a task and its sub-lines just before `anchor`, or after the last task when
   *  that is null — a neighbour rather than an index, so a stale render still lands right. */
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
      await this.writeLines([...rest.slice(0, insertAt), ...group, ...rest.slice(insertAt)]);
    });
  }

  /**
   * Replaces a task's sub-lines with `detailText`, tab-indenting each. Blank lines are
   * dropped, since `getTaskSlice` reads one as the end of the block and would truncate
   * the note on the next read. An empty string clears the lot.
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

  /** Rewrites one task's own line, and says whether the task was still there to rewrite.
   *  A transform that changes nothing writes nothing, or the views would refresh. */
  private async patchLine(item: DayTask, transform: (line: string) => string): Promise<boolean> {
    return this.withLock(async () => {
      const lines = await this.readLines();
      const idx = resolveIndex(lines, item);
      if (idx === -1) return false;
      const updated = transform(lines[idx]);
      if (updated === lines[idx]) return true;
      lines[idx] = updated;
      await this.writeLines(lines);
      return true;
    });
  }

  /** Replaces a task's title text, leaving its marker and trailing metadata alone. */
  async updateTitle(item: DayTask, newTitle: string): Promise<void> {
    await this.patchLine(item, (line) => DayTask.withUpdatedTitle(line, newTitle));
  }

  /** Replaces a task's priority marker; `Priority.None` clears it. */
  async updatePriority(item: DayTask, priority: Priority): Promise<void> {
    await this.patchLine(item, (line) => DayTask.withUpdatedPriority(line, priority));
  }

  /** Sets a task's ⏳ target date, or clears it with `null`, and says whether the task
   *  was found. */
  async updateScheduledDate(item: DayTask, date: Date | null): Promise<boolean> {
    return this.patchLine(item, (line) => DayTask.withUpdatedScheduledDate(line, date));
  }

  /** Mark a task as done (appends ✅ date). */
  async checkTask(item: DayTask, date: Date): Promise<void> {
    await this.patchLine(item, (line) => DayTask.toCheckedLine(line, date));
  }

  /** Mark a task as undone (removes [x] and ✅ date). */
  async uncheckTask(item: DayTask): Promise<void> {
    await this.patchLine(item, (line) => DayTask.toUncheckedLine(line));
  }

  /**
   * Inserts a line for every habit scheduled for `date` that the file lacks, and prunes
   * habit-tagged lines matching no active, scheduled definition. Pruning covers the whole
   * file, not just `headingText`'s section, so lines outside it are cleaned up too.
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
          // A null insertAt means the heading is absent, so it goes in too.
          const trimmed = trimTrailingBlankLines(lines);
          lines = [...trimmed, "", headingText, ...newLines];
        }
      }

      const removal = this.removeOrphanedHabits(lines, definitions, date, habitsTag);
      lines = removal.lines;

      // Insertion appends to the section, so restore the definitions' own `order`.
      lines = reorderScheduledHabits(lines, definitions, date, headingText, habitsTag);

      if (lines !== original) await this.writeLines(lines);
      return { inserted: missing, removedCount: removal.count };
    });
  }

  /** Inserts `groupLines` at the end of `headingText`'s section, appending that heading
   *  at EOF first when the file has none. */
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

  /** Removes habit-tagged tasks matching no active, scheduled definition, working on the
   *  caller's already-loaded `lines`. */
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
