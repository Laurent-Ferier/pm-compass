import { describe, it, expect, vi } from "vitest";
import { corePluginEnabled, templaterOf } from "./app-plugins";
import { asApp } from "../__testing__/as-app";

describe("templaterOf", () => {
  it("hands back Templater when the vault has it loaded", () => {
    const templater = { templater: { create_new_note_from_template: vi.fn(), overwrite_file_commands: vi.fn() } };
    const app = asApp({ plugins: { plugins: { "templater-obsidian": templater } } });

    expect(templaterOf(app)).toBe(templater);
  });

  it("hands back none when the vault doesn't have it", () => {
    expect(templaterOf(asApp({ plugins: { plugins: {} } }))).toBeUndefined();
  });

  it("hands back none for a plugin registered under the name without the calls behind it", () => {
    const app = asApp({ plugins: { plugins: { "templater-obsidian": { somethingElse: true } } } });

    expect(templaterOf(app)).toBeUndefined();
  });

  it("reads a registry that isn't there as no Templater rather than throwing", () => {
    expect(templaterOf(asApp({}))).toBeUndefined();
    expect(templaterOf(asApp({ plugins: {} }))).toBeUndefined();
  });
});

describe("corePluginEnabled", () => {
  it("says a core plugin the app names is on", () => {
    const app = asApp({ internalPlugins: { getEnabledPluginById: (id: string) => (id === "daily-notes" ? {} : null) } });

    expect(corePluginEnabled(app, "daily-notes")).toBe(true);
  });

  it("says one the app doesn't name is off", () => {
    const app = asApp({ internalPlugins: { getEnabledPluginById: () => null } });

    expect(corePluginEnabled(app, "daily-notes")).toBe(false);
  });

  it("reads a registry that isn't there, or has been reshaped, as off", () => {
    expect(corePluginEnabled(asApp({}), "daily-notes")).toBe(false);
    expect(corePluginEnabled(asApp({ internalPlugins: {} }), "daily-notes")).toBe(false);
  });
});
