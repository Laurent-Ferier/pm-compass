import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  normalizePath: (p: string) => p,
}));

import {
  canCreateDayNotes, dailyNotesConfigPath, hasDailyNotesConfig, isDailyNotesEnabled,
  readDailyNotesConfig,
} from "./daily-notes-plugin";
import { asVault } from "../__testing__/as-vault";
import type { VaultData } from "../service/vault-data";

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

/** A vault whose core plugin is on or off, with or without the configuration it saves. */
function makeVault(
  options: { enabled?: boolean; hasConfig?: boolean; internalPlugins?: unknown } = {},
): VaultData {
  return asVault({
    vault: {
      configDir: CONFIG_DIR,
      adapter: { exists: async (path: string) => !!options.hasConfig && path.endsWith(".json") },
    },
    internalPlugins: "internalPlugins" in options
      ? options.internalPlugins
      : { getEnabledPluginById: (id: string) => (options.enabled && id === "daily-notes" ? {} : null) },
  });
}

describe("isDailyNotesEnabled", () => {
  it("is true when Obsidian reports the plugin enabled", () => {
    expect(isDailyNotesEnabled(makeVault({ enabled: true }))).toBe(true);
  });

  it("is false when it reports nothing for that id", () => {
    expect(isDailyNotesEnabled(makeVault({ enabled: false }))).toBe(false);
  });

  // `internalPlugins` is undocumented API: absent or reshaped, the check reads as "off"
  // rather than throwing on a plugin load.
  it("is false on a build exposing no internal plugins at all", () => {
    expect(isDailyNotesEnabled(makeVault({ internalPlugins: undefined }))).toBe(false);
    expect(isDailyNotesEnabled(makeVault({ internalPlugins: {} }))).toBe(false);
  });
});

describe("dailyNotesConfigPath", () => {
  it("is the plugin's own file under the vault's config directory", () => {
    expect(dailyNotesConfigPath(makeVault())).toBe(`${CONFIG_DIR}/daily-notes.json`);
  });
});

describe("hasDailyNotesConfig", () => {
  it("follows what the vault holds", async () => {
    expect(await hasDailyNotesConfig(makeVault({ hasConfig: true }))).toBe(true);
    expect(await hasDailyNotesConfig(makeVault({ hasConfig: false }))).toBe(false);
  });
});

describe("canCreateDayNotes", () => {
  it("is true with the plugin on, whatever is on disk", async () => {
    expect(await canCreateDayNotes(makeVault({ enabled: true, hasConfig: false }))).toBe(true);
  });

  it("is true with the plugin off but its configuration left behind", async () => {
    expect(await canCreateDayNotes(makeVault({ enabled: false, hasConfig: true }))).toBe(true);
  });

  // Nothing says where a day note goes or what to call it, and a guess would drop files
  // in the vault root under a format nobody chose.
  it("is false with the plugin off and no configuration", async () => {
    expect(await canCreateDayNotes(makeVault({ enabled: false, hasConfig: false }))).toBe(false);
  });

  it("reads the vault only when the plugin is off", async () => {
    const vault = makeVault({ enabled: true });
    const exists = vi.spyOn(vault.app.vault.adapter, "exists");
    await canCreateDayNotes(vault);
    expect(exists).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readDailyNotesConfig
// ---------------------------------------------------------------------------

describe("readDailyNotesConfig", () => {
  function makeConfigVault(configJson: string | null) {
    return asVault({
      vault: {
        configDir: CONFIG_DIR,
        adapter: {
          read: async () => {
            if (configJson === null) throw new Error("not found");
            return configJson;
          },
        },
      },
    });
  }

  it("returns defaults when the config file is missing", async () => {
    const vault = makeConfigVault(null);
    expect(await readDailyNotesConfig(vault)).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
  });

  it("uses vault config values when all fields are present", async () => {
    const vault = makeConfigVault(JSON.stringify({ folder: "Journal", format: "YYYY.MM.DD", template: "tpl" }));
    expect(await readDailyNotesConfig(vault)).toEqual({ folder: "Journal", format: "YYYY.MM.DD", template: "tpl" });
  });

  it("falls back to defaults field-by-field for fields missing from the config file", async () => {
    const vault = makeConfigVault(JSON.stringify({ folder: "Journal" }));
    expect(await readDailyNotesConfig(vault)).toEqual({ folder: "Journal", format: "YYYY-MM-DD", template: "" });
  });

  it("falls back to the default folder when it's missing from the config file", async () => {
    const vault = makeConfigVault(JSON.stringify({ format: "YYYY.MM.DD" }));
    expect(await readDailyNotesConfig(vault)).toEqual({ folder: "", format: "YYYY.MM.DD", template: "" });
  });
});
