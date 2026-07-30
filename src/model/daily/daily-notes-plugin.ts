import { App, normalizePath } from "obsidian";

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
