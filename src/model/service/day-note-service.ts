import { normalizePath } from "obsidian";
import { formatPattern, parsePattern } from "../date-format";
import { ensureFolderRecursive, parentDirOf, resolveFile } from "../file-helpers";
import type { DayNote } from "../daily/day-note";
import { BaseService } from "./base-service";

/** The folder, filename format and template the Daily notes core plugin was last configured
 *  with — the naming scheme every day note is read and written under. */
export interface DailyNotesConfig {
  folder: string;
  format: string;
  template: string;
}

/** The scheme assumed until the Daily notes plugin's own configuration has been read. */
export const DEFAULT_DAILY_NOTES_CONFIG: DailyNotesConfig = {
  folder: "", format: "YYYY-MM-DD", template: "",
};

/**
 * The naming scheme the day notes live under, and the making of the file for one that isn't
 * there yet. Nothing of what a day note holds is here, read or written — that is the day
 * cache's, and the models over it — only where its file is and how it comes into being.
 *
 * The scheme is handed in on each call rather than held: it is read off the Daily notes
 * plugin's own config, and who has it already differs by caller.
 */
export class DayNoteService extends BaseService {
  /** The path a day's note has under `config` — whether or not that file exists yet. */
  pathOf(date: Date, config: DailyNotesConfig): string {
    const dateStr = formatPattern(date, config.format);
    return normalizePath(config.folder ? `${config.folder}/${dateStr}.md` : `${dateStr}.md`);
  }

  /** The date `filePath` stands for as a daily note under `config`, or null when it
   *  doesn't match the naming scheme. */
  dayOf(filePath: string, config: DailyNotesConfig): Date | null {
    if (!filePath.endsWith(".md")) return null;
    const folderPrefix = config.folder ? normalizePath(config.folder) + "/" : "";
    if (config.folder && !filePath.startsWith(folderPrefix)) return null;
    const basename = filePath.slice(folderPrefix.length, -3);
    if (basename.includes("/")) return null;
    return parsePattern(basename, config.format);
  }

  // ── What the Daily notes core plugin says ────────────────────────────────

  /** Whether a day note can be written at all: with the core plugin off and no configuration
   *  of its own left behind, the folder and format are this plugin's guess, and a note
   *  created from a guess lands where nobody asked for it. */
  async canCreate(): Promise<boolean> {
    return this.pluginEnabled() || await this.hasConfig();
  }

  /** The folder, filename format and template the Daily notes plugin was last configured
   *  with. This plugin's own guess when there is no configuration to read — see `canCreate`
   *  for what that guess is not allowed to do. */
  async readConfig(): Promise<DailyNotesConfig> {
    const defaults = DEFAULT_DAILY_NOTES_CONFIG;
    try {
      const raw = await this.app.vault.adapter.read(this.configPath());
      const data = JSON.parse(raw) as Partial<DailyNotesConfig>;
      return {
        folder: data.folder ?? defaults.folder,
        format: data.format ?? defaults.format,
        template: data.template ?? defaults.template,
      };
    } catch {
      return { ...defaults };
    }
  }

  /** Whether Obsidian's Daily notes core plugin is on. Off, the configuration it saved is
   *  still read if it left one behind — and without one, day notes would land in the vault
   *  root under a format nobody chose. */
  private pluginEnabled(): boolean {
    return this.vault.corePluginEnabled("daily-notes");
  }

  /** Whether the Daily notes plugin has left a configuration behind. */
  private hasConfig(): Promise<boolean> {
    return this.app.vault.adapter.exists(this.configPath());
  }

  private configPath(): string {
    return normalizePath(`${this.app.vault.configDir}/daily-notes.json`);
  }

  /**
   * The note for `date`, its file made when it isn't there yet — via Templater where the
   * vault has it. Null when the making fails, and when it is refused because the vault says
   * nowhere to put one (see `canCreate`). A null is a silent refusal, so a caller
   * moving a line into the day note asks for it *before* touching the source, or the line
   * is lost.
   *
   * The note is read off the path the making came back with rather than the one `pathOf`
   * says: Templater runs the user's own scripts and can land the file elsewhere. And a file
   * that has just appeared is marked first — nothing was holding it to say that it did.
   *
   * Only one that has just appeared. Marking a note that was already there says the plugin
   * wrote it, which the views hear as a change and redraw for — and a redraw asks for the
   * day again. On a tab that ensures the week on every render, that is a loop.
   *
   * The reading is `TaskFileCache`'s, which alone may make a `DayNote`; what is here is the file
   * it reads. A caller wanting only the path takes it off the note.
   */
  async ensure(date: Date, config?: DailyNotesConfig): Promise<DayNote | null> {
    const made = await this.makeFile(date, config);
    if (!made) return null;
    const days = this.vault.tasks.cache;
    if (made.appeared) days.invalidate(made.path);
    return days.day(date, made.path);
  }

  /**
   * The file for `date`, created when it isn't there — its folders, its template, and
   * Templater where the vault has it. Null when that fails or is refused.
   *
   * The path is where the note actually landed, which is not always what `pathOf` says, and
   * `appeared` says whether this call is what put it there — which is what decides whether
   * anything has to be told.
   */
  private async makeFile(
    date: Date, config?: DailyNotesConfig,
  ): Promise<{ path: string; appeared: boolean } | null> {
    const app = this.app;
    const resolvedConfig = config ?? await this.readConfig();
    const dateStr = formatPattern(date, resolvedConfig.format);
    const filePath = this.pathOf(date, resolvedConfig);

    if (resolveFile(app, filePath)) return { path: filePath, appeared: false };

    // With the Daily notes plugin off and no config it left behind, `resolvedConfig` is
    // this plugin's own guess — creating a note from it would drop files in the vault
    // root under a date format nobody chose. Reading the existing ones stays fine.
    // Refused in silence: most calls here are a render reading the day, not a request to
    // make one. What is asked for by a click says so — see the dashboard's date label.
    if (!await this.canCreate()) return null;

    // The format can embed slashes ("YYYY/MM/DD"), so the parent may be nested even
    // with a blank folder.
    const parentDir = parentDirOf(filePath);
    if (parentDir) {
      await ensureFolderRecursive(app, parentDir);
    }

    const templater = this.vault.templater;
    const templatePath = resolvedConfig.template
      ? normalizePath(
          resolvedConfig.template.endsWith(".md")
            ? resolvedConfig.template
            : `${resolvedConfig.template}.md`,
        )
      : null;
    const templateFile = templatePath ? resolveFile(app, templatePath) : null;

    if (templater && templateFile) {
      const created = await templater.templater.create_new_note_from_template(
        templateFile,
        resolvedConfig.folder || undefined,
        dateStr,
        false,
      );
      const landed = created?.path ?? (resolveFile(app, filePath) ? filePath : null);
      return landed ? { path: landed, appeared: true } : null;
    }

    let content = "";
    if (templateFile) {
      content = await app.vault.read(templateFile);
    }
    const file = await app.vault.create(filePath, content);
    return { path: file.path, appeared: true };
  }
}
