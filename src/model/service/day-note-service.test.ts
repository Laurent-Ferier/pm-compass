import { vi, describe, it, expect } from "vitest";

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { TFile as TFileMock } from "obsidian";
import { noteFilesOf } from "../__testing__/day-vault";
import { day } from "../__testing__/dates";
import { asApp } from "../__testing__/as-app";
import { asVault } from "../__testing__/as-vault";
import { bare } from "../__testing__/bare";
import type { DailyNotesConfig } from "../daily/week-summary";

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

// ---------------------------------------------------------------------------
// DayNoteService.ensure
// ---------------------------------------------------------------------------

function makeEnsureApp(
  initialFiles: Record<string, string> = {},
  options: {
    dailyNotesConfig?: Partial<DailyNotesConfig>;
    existingFolders?: string[];
    templaterPlugin?: { create_new_note_from_template: (...args: unknown[]) => Promise<unknown> };
    /** The Daily notes core plugin, on in a normal vault. */
    dailyNotesEnabled?: boolean;
  } = {},
) {
  const dailyNotesEnabled = options.dailyNotesEnabled ?? true;
  const store = new Map(Object.entries(initialFiles));
  const folders = new Set(options.existingFolders ?? []);
  const configJson = options.dailyNotesConfig
    ? JSON.stringify(options.dailyNotesConfig)
    : null;

  const app = asApp({
    vault: {
      configDir: CONFIG_DIR,
      getAbstractFileByPath: (path: string) => {
        if (store.has(path)) {
          const f = bare(TFileMock);
          Object.assign(f, { path });
          return f;
        }
        if (folders.has(path)) return { path }; // simulate existing folder
        return null;
      },
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        store.set(path, content);
        const f = bare(TFileMock);
        Object.assign(f, { path });
        return f;
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      adapter: {
        read: async (path: string) => {
          if (path === `${CONFIG_DIR}/daily-notes.json` && configJson) return configJson;
          throw new Error(`adapter.read: not found: ${path}`);
        },
        exists: async () => configJson !== null,
      },
    },
    internalPlugins: { getEnabledPluginById: () => (dailyNotesEnabled ? {} : null) },
    plugins: {
      plugins: options.templaterPlugin
        ? { "templater-obsidian": { templater: options.templaterPlugin } }
        : {},
    },
  });

  return { app, vault: asVault(app), store, folders };
}

describe("DayNoteService.ensure", () => {
  const cfg = (overrides: Partial<DailyNotesConfig> = {}): DailyNotesConfig => ({
    folder: "",
    format: "YYYY-MM-DD",
    template: "",
    ...overrides,
  });

  it("returns the path of an existing note", async () => {
    const { vault } = makeEnsureApp({ "2026-07-01.md": "- [ ] Task" });
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg());
    expect(notePath).not.toBeNull();
    expect(notePath).toBe("2026-07-01.md");
  });

  // In silence: a dashboard render calls this for every day of the week, so a notice here
  // would be a stack of them on every refresh. The caller that asks outright reports it.
  it("refuses to create a note, saying nothing, when the plugin is off and left no config", async () => {
    notices.length = 0;
    const { vault, store } = makeEnsureApp({}, { dailyNotesEnabled: false });
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg());
    expect(notePath).toBeNull();
    expect(store.size).toBe(0);
    expect(notices).toEqual([]);
  });

  it("reads an existing note even with the Daily notes plugin off", async () => {
    const { vault } = makeEnsureApp({ "2026-07-01.md": "- [ ] Task" }, { dailyNotesEnabled: false });
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg());
    expect(notePath).toBe("2026-07-01.md");
  });

  it("still creates a note when the plugin is off but its config remains", async () => {
    const { vault, store } = makeEnsureApp(
      {},
      { dailyNotesEnabled: false, dailyNotesConfig: { folder: "Daily" } },
    );
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ folder: "Daily" }));
    expect(notePath).not.toBeNull();
    expect(store.get("Daily/2026-07-01.md")).toBe("");
  });

  it("creates the file with empty content when it does not exist", async () => {
    const { vault, store } = makeEnsureApp();
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg());
    expect(notePath).not.toBeNull();
    expect(store.get("2026-07-01.md")).toBe("");
  });

  it("places the file in the configured folder", async () => {
    const { vault, store } = makeEnsureApp({}, { existingFolders: ["Daily Notes"] });
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ folder: "Daily Notes" }));
    expect(notePath).toBe("Daily Notes/2026-07-01.md");
    expect(store.has("Daily Notes/2026-07-01.md")).toBe(true);
  });

  it("creates the folder when it does not exist", async () => {
    const { vault, folders } = makeEnsureApp();
    await vault.dayNotes.ensure(day("2026-07-01"), cfg({ folder: "Daily Notes" }));
    expect(folders.has("Daily Notes")).toBe(true);
  });

  it("does not try to create an already-existing folder", async () => {
    const { app, vault } = makeEnsureApp({}, { existingFolders: ["Notes"] });
    // createFolder would throw if called — we verify no error is thrown
    app.vault.createFolder = () => { throw new Error("should not be called"); };
    await expect(
      vault.dayNotes.ensure(day("2026-07-01"), cfg({ folder: "Notes" })),
    ).resolves.not.toBeNull();
  });

  it("seeds the file with raw template content when no Templater plugin is present", async () => {
    const { vault, store } = makeEnsureApp({
      "templates/daily.md": "# Daily Note\n- [ ] Morning check-in",
    });
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ template: "templates/daily.md" }));
    expect(store.get(notePath!)).toBe("# Daily Note\n- [ ] Morning check-in");
  });

  it("appends .md to template path when extension is missing", async () => {
    const { vault, store } = makeEnsureApp({ "templates/daily.md": "template content" });
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ template: "templates/daily" }));
    expect(store.get(notePath!)).toBe("template content");
  });

  it("creates an empty file when the template path does not exist", async () => {
    const { vault, store } = makeEnsureApp();
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ template: "missing-template.md" }));
    expect(store.get(notePath!)).toBe("");
  });

  it("delegates to Templater when the plugin is available", async () => {
    const createdFile = bare(TFileMock);
    Object.assign(createdFile, { path: "2026-07-01.md" });
    const createMock = vi.fn().mockResolvedValue(createdFile);
    const { vault } = makeEnsureApp(
      { "templates/daily.md": "" },
      { templaterPlugin: { create_new_note_from_template: createMock } },
    );
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ template: "templates/daily.md" }));
    expect(createMock).toHaveBeenCalledOnce();
    expect(notePath).toBe("2026-07-01.md");
  });

  it("falls back to the expected path when Templater resolves without a created file, but the note now exists", async () => {
    // The note must not exist yet when ensure() starts (or its top-of-function existence
    // check would short-circuit before ever reaching Templater) — it has to appear as a
    // side effect of the (failing) Templater call, the way a real Templater run would
    // still write the file even if its return value doesn't carry a usable path.
    const { vault, store } = makeEnsureApp(
      { "templates/daily.md": "" },
      {
        templaterPlugin: {
          create_new_note_from_template: async () => {
            store.set("2026-07-01.md", "created by templater");
            return null;
          },
        },
      },
    );
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ template: "templates/daily.md" }));
    expect(notePath).toBe("2026-07-01.md");
  });

  it("returns null when Templater resolves without a created file and the note doesn't exist", async () => {
    const createMock = vi.fn().mockResolvedValue(null);
    const { vault } = makeEnsureApp(
      { "templates/daily.md": "" },
      { templaterPlugin: { create_new_note_from_template: createMock } },
    );
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ template: "templates/daily.md" }));
    expect(notePath).toBeNull();
  });

  it("reads DailyNotesConfig from vault when not provided", async () => {
    const { vault, store } = makeEnsureApp(
      {},
      { dailyNotesConfig: { folder: "Journal", format: "YYYY-MM-DD", template: "" } },
    );
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"));
    expect(notePath).toBe("Journal/2026-07-01.md");
    expect(store.has("Journal/2026-07-01.md")).toBe(true);
  });

  it("returns a path the note behind it can read its lines off", async () => {
    const { app, vault } = makeEnsureApp({ "templates/daily.md": "- [ ] Morning run" });
    const notePath = await vault.dayNotes.ensure(day("2026-07-01"), cfg({ template: "templates/daily.md" }));
    const tasks = await noteFilesOf(app).file(notePath!).parsedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Morning run");
  });
});

// ---------------------------------------------------------------------------
// DayNoteService.dayOf
// ---------------------------------------------------------------------------

describe("DayNoteService.dayOf", () => {
  const { vault } = makeEnsureApp();
  const cfg = (overrides: Partial<DailyNotesConfig> = {}): DailyNotesConfig => ({
    folder: "",
    format: "YYYY-MM-DD",
    template: "",
    ...overrides,
  });

  it("matches a daily note at the vault root", () => {
    const result = vault.dayNotes.dayOf("2026-07-03.md", cfg());
    expect(result).toEqual(new Date(2026, 6, 3));
  });

  it("matches a daily note inside the configured folder", () => {
    const result = vault.dayNotes.dayOf("Notes/Jour/2026-07-03.md", cfg({ folder: "Notes/Jour" }));
    expect(result).toEqual(new Date(2026, 6, 3));
  });

  it("returns null when the file is outside the configured folder", () => {
    expect(vault.dayNotes.dayOf("Other/2026-07-03.md", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });

  it("returns null when the basename doesn't parse as a date", () => {
    expect(vault.dayNotes.dayOf("Notes/Jour/not-a-date.md", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });

  it("returns null for non-markdown files", () => {
    expect(vault.dayNotes.dayOf("Notes/Jour/2026-07-03.png", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });

  it("returns null for a file nested deeper than the configured folder", () => {
    expect(vault.dayNotes.dayOf("Notes/Jour/Sub/2026-07-03.md", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });
});
