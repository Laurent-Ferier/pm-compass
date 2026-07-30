import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  normalizePath: (p: string) => p,
}));

import { App } from "obsidian";
import {
  canCreateDayNotes, dailyNotesConfigPath, hasDailyNotesConfig, isDailyNotesEnabled,
} from "./daily-notes-plugin";

/** A vault whose core plugin is on or off, with or without the configuration it saves. */
function makeApp(
  options: { enabled?: boolean; hasConfig?: boolean; internalPlugins?: unknown } = {},
): App {
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter: { exists: async (path: string) => !!options.hasConfig && path.endsWith(".json") },
    },
    internalPlugins: "internalPlugins" in options
      ? options.internalPlugins
      : { getEnabledPluginById: (id: string) => (options.enabled && id === "daily-notes" ? {} : null) },
  };
  return app as unknown as App;
}

describe("isDailyNotesEnabled", () => {
  it("is true when Obsidian reports the plugin enabled", () => {
    expect(isDailyNotesEnabled(makeApp({ enabled: true }))).toBe(true);
  });

  it("is false when it reports nothing for that id", () => {
    expect(isDailyNotesEnabled(makeApp({ enabled: false }))).toBe(false);
  });

  // `internalPlugins` is undocumented API: absent or reshaped, the check reads as "off"
  // rather than throwing on a plugin load.
  it("is false on a build exposing no internal plugins at all", () => {
    expect(isDailyNotesEnabled(makeApp({ internalPlugins: undefined }))).toBe(false);
    expect(isDailyNotesEnabled(makeApp({ internalPlugins: {} }))).toBe(false);
  });
});

describe("dailyNotesConfigPath", () => {
  it("is the plugin's own file under the vault's config directory", () => {
    expect(dailyNotesConfigPath(makeApp())).toBe(".obsidian/daily-notes.json");
  });
});

describe("hasDailyNotesConfig", () => {
  it("follows what the vault holds", async () => {
    expect(await hasDailyNotesConfig(makeApp({ hasConfig: true }))).toBe(true);
    expect(await hasDailyNotesConfig(makeApp({ hasConfig: false }))).toBe(false);
  });
});

describe("canCreateDayNotes", () => {
  it("is true with the plugin on, whatever is on disk", async () => {
    expect(await canCreateDayNotes(makeApp({ enabled: true, hasConfig: false }))).toBe(true);
  });

  it("is true with the plugin off but its configuration left behind", async () => {
    expect(await canCreateDayNotes(makeApp({ enabled: false, hasConfig: true }))).toBe(true);
  });

  // Nothing says where a day note goes or what to call it, and a guess would drop files
  // in the vault root under a format nobody chose.
  it("is false with the plugin off and no configuration", async () => {
    expect(await canCreateDayNotes(makeApp({ enabled: false, hasConfig: false }))).toBe(false);
  });

  it("reads the vault only when the plugin is off", async () => {
    const app = makeApp({ enabled: true });
    const exists = vi.spyOn(app.vault.adapter, "exists");
    await canCreateDayNotes(app);
    expect(exists).not.toHaveBeenCalled();
  });
});
