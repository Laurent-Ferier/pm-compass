// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { TFile as TFileMock } from "obsidian";
import { serviceOver } from "../__testing__/task-service";
import { ALL_WEEKDAYS, type RecurringTaskDefinition } from "../daily/recurring-task";
import { day } from "../__testing__/dates";
import { asApp } from "../__testing__/as-app";
import { bare } from "../__testing__/bare";

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

function makeVaultFile(path: string) {
  const f = bare(TFileMock);
  Object.assign(f, { path });
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();
  // A bag rather than the empty object it starts as: tests put a Templater stub in it.
  const plugins: Record<string, { templater: unknown }> = {};
  const app = asApp({
    vault: {
      configDir: CONFIG_DIR,
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) return makeVaultFile(path);
        if (folders.has(path)) return { path };
        return null;
      },
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        files.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        files.set(path, content);
        return makeVaultFile(path);
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      adapter: {
        read: async (): Promise<string> => {
          throw new Error("no daily-notes.json configured");
        },
        exists: async (): Promise<boolean> => false,
      },
    },
    plugins: { plugins },
    internalPlugins: { getEnabledPluginById: (): unknown => ({}) },
  });
  return { app, files };
}

function habitDef(overrides: Partial<RecurringTaskDefinition> = {}): RecurringTaskDefinition {
  return {
    id: "id-1",
    title: "Morning run",
    weekdays: ALL_WEEKDAYS,
    order: 0,
    active: true,
    createdAt: day("2026-01-01"),
    detail: "",
    ...overrides,
  };
}

describe("TaskService.backfillHabits", () => {
  // 2026-07-01 is a Wednesday ("today"); the containing ISO week is Mon 2026-06-29 .. Sun 2026-07-05.
  // Backfill should only ever touch today (07-01) through Sunday (07-05) — never 06-29/06-30, which
  // have already passed this week.
  const wednesday = new Date(2026, 6, 1);

  it("creates missing daily notes from today through Sunday, but not earlier this week", async () => {
    const { app, files } = makeApp();
    const settings = { recurringTasks: [habitDef()] };
    const result = await serviceOver(app, settings).backfillHabits(wednesday);

    expect(result.filesCreated).toBe(5);
    expect(result.filesChanged).toBe(5);
    for (const d of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]) {
      expect(files.get(`${d}.md`)).toContain("- [ ] Morning run #daily");
    }
    expect(files.has("2026-06-29.md")).toBe(false);
    expect(files.has("2026-06-30.md")).toBe(false);
  });

  it("does not recreate or duplicate habits in notes that already have them", async () => {
    const { app, files } = makeApp({ "2026-07-01.md": "- [ ] Morning run #daily" });
    const settings = { recurringTasks: [habitDef()] };
    const result = await serviceOver(app, settings).backfillHabits(wednesday);

    expect(result.filesCreated).toBe(4);
    expect(files.get("2026-07-01.md")).toBe("- [ ] Morning run #daily");
  });

  it("fills in a missing habit in an existing note without creating a new file", async () => {
    const { app, files } = makeApp({ "2026-07-03.md": "- [ ] Other task" });
    const settings = { recurringTasks: [habitDef()] };
    const result = await serviceOver(app, settings).backfillHabits(wednesday);

    expect(result.filesCreated).toBe(4);
    expect(files.get("2026-07-03.md")).toContain("- [ ] Morning run #daily");
  });

  it("skips a definition not scheduled for a given weekday", async () => {
    const { app, files } = makeApp();
    const weekdaysMonToFri = 0b0011111;
    const settings = { recurringTasks: [habitDef({ weekdays: weekdaysMonToFri })] };
    await serviceOver(app, settings).backfillHabits(wednesday);

    expect(files.get("2026-07-01.md")).toContain("Morning run"); // Wednesday (today)
    expect(files.get("2026-07-04.md") ?? "").not.toContain("Morning run"); // Saturday
  });

  it("does not touch days earlier this week (already passed) or outside the current ISO week", async () => {
    const { app, files } = makeApp();
    const settings = { recurringTasks: [habitDef()] };
    await serviceOver(app, settings).backfillHabits(wednesday);

    expect(files.has("2026-06-29.md")).toBe(false); // Monday this week, already passed
    expect(files.has("2026-06-30.md")).toBe(false); // Tuesday this week, already passed
    expect(files.has("2026-06-28.md")).toBe(false); // previous week
    expect(files.has("2026-07-06.md")).toBe(false); // next week
  });

  it("removes an orphaned habit line from today's note when its definition is deleted, and counts it as changed", async () => {
    const { app, files } = makeApp({ "2026-07-01.md": "# Routine\n- [ ] Morning run #daily" });
    const settings = { recurringTasks: [] }; // definition deleted
    const result = await serviceOver(app, settings).backfillHabits(wednesday);

    expect(files.get("2026-07-01.md")).toBe("# Routine");
    expect(result.filesChanged).toBeGreaterThanOrEqual(1);
  });

  it("does not remove a habit line matching a still-active, still-scheduled definition", async () => {
    const { app, files } = makeApp({ "2026-07-01.md": "# Routine\n- [ ] Morning run #daily" });
    const settings = { recurringTasks: [habitDef()] };
    await serviceOver(app, settings).backfillHabits(wednesday);

    expect(files.get("2026-07-01.md")).toBe("# Routine\n- [ ] Morning run #daily");
  });

  it("creates a not-yet-existing daily notes folder exactly once, even though days are backfilled concurrently", async () => {
    // Regression test: each day's DayNoteService.ensure() independently checks/creates the
    // configured folder. Backfilling days concurrently means multiple ensure() calls could
    // race to create the same folder if it isn't created once up front first.
    const { app } = makeApp();
    const createFolderSpy = vi.spyOn(app.vault, "createFolder");
    const settings = { recurringTasks: [habitDef()] };
    app.vault.adapter.read = async () =>
      JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD", template: "" });
    await serviceOver(app, settings).backfillHabits(wednesday);

    expect(createFolderSpy).toHaveBeenCalledTimes(1);
    expect(createFolderSpy).toHaveBeenCalledWith("Journal");
  });

  describe("with the daily notes core plugin off", () => {
    const turnOff = (app: ReturnType<typeof makeApp>["app"]) => {
      app.internalPlugins.getEnabledPluginById = () => null;
    };

    it("creates no note, and no folder to put one in, when it left no configuration", async () => {
      const { app, files } = makeApp();
      turnOff(app);
      const createFolderSpy = vi.spyOn(app.vault, "createFolder");
      app.vault.adapter.read = async () =>
        JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD", template: "" });
      const settings = { recurringTasks: [habitDef()] };
      const result = await serviceOver(app, settings).backfillHabits(wednesday);

      expect(files.size).toBe(0);
      expect(createFolderSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ filesChanged: 0, filesCreated: 0 });
    });

    it("still fills the habits into a day note that already exists", async () => {
      const { app, files } = makeApp({ "2026-07-01.md": "# Routine\n" });
      turnOff(app);
      const settings = { recurringTasks: [habitDef()] };
      const result = await serviceOver(app, settings).backfillHabits(wednesday);

      expect(files.get("2026-07-01.md")).toContain("Morning run");
      expect(files.size).toBe(1);
      expect(result.filesChanged).toBe(1);
    });

    it("creates notes again when the plugin has left its configuration behind", async () => {
      const { app, files } = makeApp();
      turnOff(app);
      app.vault.adapter.exists = async () => true;
      app.vault.adapter.read = async () =>
        JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD", template: "" });
      const settings = { recurringTasks: [habitDef()] };
      const result = await serviceOver(app, settings).backfillHabits(wednesday);

      expect(files.has("Journal/2026-07-01.md")).toBe(true);
      expect(result.filesCreated).toBe(5);
    });
  });

  it("counts a day as neither created nor changed when DayNoteService.ensure() fails to produce a note", async () => {
    // Templater is configured but fails to create the note (resolves without a path)
    // and no file shows up on disk either, so DayNoteService.ensure() returns null.
    const { app, files } = makeApp({ "templates/daily.md": "" });
    app.vault.adapter.read = async () =>
      JSON.stringify({ folder: "", format: "YYYY-MM-DD", template: "templates/daily.md" });
    app.plugins.plugins["templater-obsidian"] = {
      templater: { create_new_note_from_template: async () => null },
    };
    const settings = { recurringTasks: [habitDef()] };
    const result = await serviceOver(app, settings).backfillHabits(wednesday);

    expect(result.filesCreated).toBe(0);
    expect(result.filesChanged).toBe(0);
    for (const d of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]) {
      expect(files.has(`${d}.md`)).toBe(false);
    }
  });
});
