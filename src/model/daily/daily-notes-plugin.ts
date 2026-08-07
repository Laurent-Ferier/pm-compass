import { App, normalizePath } from "obsidian";
import type { DailyNotesConfig } from "./week-summary";

interface AppWithInternalPlugins extends App {
  internalPlugins?: { getEnabledPluginById?(id: string): unknown };
}

/** Whether Obsidian's Daily notes core plugin is on. Off, the configuration it saved is
 *  still read if it left one behind — and without one, day notes would land in the vault
 *  root under a format nobody chose. */
export function isDailyNotesEnabled(app: App): boolean {
  const internal = (app as unknown as AppWithInternalPlugins).internalPlugins;
  return !!internal?.getEnabledPluginById?.("daily-notes");
}

export function dailyNotesConfigPath(app: App): string {
  return normalizePath(`${app.vault.configDir}/daily-notes.json`);
}

/** Whether the Daily notes plugin has left a configuration behind. */
export async function hasDailyNotesConfig(app: App): Promise<boolean> {
  return app.vault.adapter.exists(dailyNotesConfigPath(app));
}

/** Whether a day note can be written at all: with the core plugin off and no configuration
 *  of its own left behind, the folder and format are this plugin's guess, and a note
 *  created from a guess lands where nobody asked for it. */
export async function canCreateDayNotes(app: App): Promise<boolean> {
  return isDailyNotesEnabled(app) || await hasDailyNotesConfig(app);
}

/** The folder, filename format and template the Daily notes plugin was last configured
 *  with. This plugin's own guess when there is no configuration to read — see
 *  `canCreateDayNotes` for what that guess is not allowed to do. */
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
