import type { App, TFile } from "obsidian";

/** What this plugin asks of Templater — the calls that make a note from a template and run
 *  the commands in one. Declared here because Templater publishes no types of its own. */
export interface TemplaterPlugin {
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

/** The two plugin registries Obsidian holds and its published types leave out. */
interface AppWithPlugins extends App {
  plugins?: { plugins?: Record<string, unknown> };
  internalPlugins?: { getEnabledPluginById?(id: string): unknown };
}

/**
 * What the app says about the plugins around this one — `VaultData`'s answers, worked out
 * here so a test standing one up over a mock app gets the same ones. Nothing else calls
 * these: reaching for a plugin goes through the vault.
 */

/** Templater, when the vault has it loaded. */
export function templaterOf(app: App): TemplaterPlugin | undefined {
  const plugin = (app as AppWithPlugins).plugins?.plugins?.["templater-obsidian"] as
    | TemplaterPlugin
    | undefined;
  return plugin?.templater ? plugin : undefined;
}

/** Whether one of Obsidian's own core plugins is on. Absent or reshaped registries read as
 *  "off" rather than throwing: this is undocumented API. */
export function corePluginEnabled(app: App, id: string): boolean {
  return !!(app as AppWithPlugins).internalPlugins?.getEnabledPluginById?.(id);
}
