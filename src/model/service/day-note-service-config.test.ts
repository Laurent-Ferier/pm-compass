import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", () => ({
  // Unused here, but the vault helper reaches the date parsing that reads it.
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
  App: class {},
  normalizePath: (p: string) => p,
}));

import { asVault } from "../__testing__/as-vault";
import type { VaultData } from "./vault-data";

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

describe("DayNoteService.canCreate", () => {
  it("is true with the plugin on, whatever is on disk", async () => {
    expect(await makeVault({ enabled: true, hasConfig: false }).dayNotes.canCreate()).toBe(true);
  });

  it("is true with the plugin off but its configuration left behind", async () => {
    expect(await makeVault({ enabled: false, hasConfig: true }).dayNotes.canCreate()).toBe(true);
  });

  // Nothing says where a day note goes or what to call it, and a guess would drop files
  // in the vault root under a format nobody chose.
  it("is false with the plugin off and no configuration", async () => {
    expect(await makeVault({ enabled: false, hasConfig: false }).dayNotes.canCreate()).toBe(false);
  });

  // `internalPlugins` is undocumented API: absent or reshaped, the check reads as "off"
  // rather than throwing on a plugin load.
  it("falls back to the vault on a build exposing no internal plugins at all", async () => {
    expect(await makeVault({ internalPlugins: undefined }).dayNotes.canCreate()).toBe(false);
    expect(await makeVault({ internalPlugins: {}, hasConfig: true }).dayNotes.canCreate()).toBe(true);
  });

  it("looks for the plugin's own file under the vault's config directory", async () => {
    const vault = makeVault({ enabled: false, hasConfig: true });
    const exists = vi.spyOn(vault.app.vault.adapter, "exists");
    await vault.dayNotes.canCreate();
    expect(exists).toHaveBeenCalledWith(`${CONFIG_DIR}/daily-notes.json`);
  });

  it("reads the vault only when the plugin is off", async () => {
    const vault = makeVault({ enabled: true });
    const exists = vi.spyOn(vault.app.vault.adapter, "exists");
    await vault.dayNotes.canCreate();
    expect(exists).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DayNoteService.readConfig
// ---------------------------------------------------------------------------

describe("DayNoteService.readConfig", () => {
  function makeConfigVault(configJson: string | null) {
    return asVault({
      vault: {
        configDir: CONFIG_DIR,
        adapter: {
          read: async (path: string) => {
            if (path !== `${CONFIG_DIR}/daily-notes.json`) throw new Error(`unexpected read: ${path}`);
            if (configJson === null) throw new Error("not found");
            return configJson;
          },
        },
      },
    });
  }

  it("returns defaults when the config file is missing", async () => {
    const vault = makeConfigVault(null);
    expect(await vault.dayNotes.readConfig()).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
  });

  it("uses vault config values when all fields are present", async () => {
    const vault = makeConfigVault(JSON.stringify({ folder: "Journal", format: "YYYY.MM.DD", template: "tpl" }));
    expect(await vault.dayNotes.readConfig()).toEqual({ folder: "Journal", format: "YYYY.MM.DD", template: "tpl" });
  });

  it("falls back to defaults field-by-field for fields missing from the config file", async () => {
    const vault = makeConfigVault(JSON.stringify({ folder: "Journal" }));
    expect(await vault.dayNotes.readConfig()).toEqual({ folder: "Journal", format: "YYYY-MM-DD", template: "" });
  });

  it("falls back to the default folder when it's missing from the config file", async () => {
    const vault = makeConfigVault(JSON.stringify({ format: "YYYY.MM.DD" }));
    expect(await vault.dayNotes.readConfig()).toEqual({ folder: "", format: "YYYY.MM.DD", template: "" });
  });
});
