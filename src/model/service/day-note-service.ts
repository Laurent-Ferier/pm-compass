import { TFile, normalizePath } from "obsidian";
import { formatPattern, parsePattern } from "../date-format";
import type { DailyNotesConfig } from "../daily/week-summary";
import { canCreateDayNotes, readDailyNotesConfig } from "../daily/daily-notes-plugin";
import { ensureFolderRecursive, parentDirOf } from "../operations/file-helpers";
import { BaseService } from "./base-service";

/**
 * The naming scheme the day notes live under, and the making of one that isn't there yet.
 * Nothing of what a day note *says* is here — that is the day store's, and the models over
 * it — only where its file is and how it comes into being.
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

  /**
   * The path of the note for `date`, creating it when it doesn't exist yet — via Templater
   * where the vault has it. Null when creation fails, and when it is refused because the
   * vault says nowhere to put one (see `canCreateDayNotes`).
   *
   * Two things a caller has to honour. The path handed back is authoritative and must not be
   * recomputed from `pathOf`: Templater runs the user's own scripts and can land the note
   * elsewhere. And a null is a silent refusal, so a caller moving a line into the day note
   * resolves it *before* touching the source, or the line is lost.
   *
   * `ensure` rather than `get`: it creates folders, runs those scripts and writes a file, and
   * most calls into it are renders.
   */
  async ensure(date: Date, config?: DailyNotesConfig): Promise<string | null> {
    const app = this.app;
    const resolvedConfig = config ?? await readDailyNotesConfig(this.vault);
    const dateStr = formatPattern(date, resolvedConfig.format);
    const filePath = this.pathOf(date, resolvedConfig);

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) return filePath;

    // With the Daily notes plugin off and no config it left behind, `resolvedConfig` is
    // this plugin's own guess — creating a note from it would drop files in the vault
    // root under a date format nobody chose. Reading the existing ones stays fine.
    // Refused in silence: most calls here are a render reading the day, not a request to
    // make one. What is asked for by a click says so — see the dashboard's date label.
    if (!await canCreateDayNotes(this.vault)) return null;

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
    const templateFile = templatePath ? app.vault.getAbstractFileByPath(templatePath) : null;

    if (templater && templateFile instanceof TFile) {
      const created = await templater.templater.create_new_note_from_template(
        templateFile,
        resolvedConfig.folder || undefined,
        dateStr,
        false,
      );
      return created?.path ?? (
        app.vault.getAbstractFileByPath(filePath) instanceof TFile ? filePath : null
      );
    }

    let content = "";
    if (templateFile instanceof TFile) {
      content = await app.vault.read(templateFile);
    }
    const file = await app.vault.create(filePath, content);
    return file.path;
  }
}
