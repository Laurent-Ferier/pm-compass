import { vi, describe, it, expect } from "vitest";

function makeMoment(d: Date) {
  const self = {
    _d: new Date(d),
    add(n: number, unit: string) {
      const next = new Date(self._d);
      if (unit === "days") next.setDate(next.getDate() + n);
      return makeMoment(next);
    },
    startOf(unit: string) {
      if (unit !== "isoWeek") return makeMoment(self._d);
      // Monday-start week.
      const day = self._d.getDay(); // 0=Sun..6=Sat
      const diffToMonday = (day + 6) % 7;
      const monday = new Date(self._d);
      monday.setDate(monday.getDate() - diffToMonday);
      return makeMoment(monday);
    },
    format(fmt?: string) {
      const y = self._d.getFullYear();
      const m = String(self._d.getMonth() + 1).padStart(2, "0");
      const day = String(self._d.getDate()).padStart(2, "0");
      if (!fmt || fmt === "YYYY-MM-DD") return `${y}-${m}-${day}`;
      return fmt.replace("YYYY", String(y)).replace("MM", m).replace("DD", day);
    },
    toDate() {
      return new Date(self._d);
    },
  };
  return self;
}

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  moment: (input?: unknown) => {
    if (input === undefined) return makeMoment(new Date());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arg = input as any;
    const d = arg?._d instanceof Date ? new Date(arg._d) : new Date(arg as string);
    return makeMoment(d);
  },
}));

import { TFile as TFileMock } from "obsidian";
import { backfillRecurringHabits } from "./recurring-task-backfill";
import { DEFAULT_SETTINGS } from "../settings";
import { ALL_WEEKDAYS, type RecurringTaskDefinition } from "./recurring-task";
import { day } from "../__testing__/dates";

function makeVaultFile(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = Object.create((TFileMock as any).prototype);
  f.path = path;
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: (path: string) => {
        if (store.has(path)) return makeVaultFile(path);
        if (folders.has(path)) return { path };
        return null;
      },
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        store.set(path, content);
        return makeVaultFile(path);
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      adapter: {
        read: async () => {
          throw new Error("no daily-notes.json configured");
        },
      },
    },
    plugins: { plugins: {} },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any;
  return { app, store };
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

describe("backfillRecurringHabits", () => {
  // 2026-07-01 is a Wednesday ("today"); the containing ISO week is Mon 2026-06-29 .. Sun 2026-07-05.
  // Backfill should only ever touch today (07-01) through Sunday (07-05) — never 06-29/06-30, which
  // have already passed this week.
  const wednesday = new Date(2026, 6, 1);

  it("creates missing daily notes from today through Sunday, but not earlier this week", async () => {
    const { app, store } = makeApp();
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [habitDef()] };
    const result = await backfillRecurringHabits(app, settings, wednesday);

    expect(result.filesCreated).toBe(5);
    expect(result.filesChanged).toBe(5);
    for (const d of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]) {
      expect(store.get(`${d}.md`)).toContain("- [ ] Morning run #daily");
    }
    expect(store.has("2026-06-29.md")).toBe(false);
    expect(store.has("2026-06-30.md")).toBe(false);
  });

  it("does not recreate or duplicate habits in notes that already have them", async () => {
    const { app, store } = makeApp({ "2026-07-01.md": "- [ ] Morning run #daily" });
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [habitDef()] };
    const result = await backfillRecurringHabits(app, settings, wednesday);

    expect(result.filesCreated).toBe(4);
    expect(store.get("2026-07-01.md")).toBe("- [ ] Morning run #daily");
  });

  it("fills in a missing habit in an existing note without creating a new file", async () => {
    const { app, store } = makeApp({ "2026-07-03.md": "- [ ] Other task" });
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [habitDef()] };
    const result = await backfillRecurringHabits(app, settings, wednesday);

    expect(result.filesCreated).toBe(4);
    expect(store.get("2026-07-03.md")).toContain("- [ ] Morning run #daily");
  });

  it("skips a definition not scheduled for a given weekday", async () => {
    const { app, store } = makeApp();
    const weekdaysMonToFri = 0b0011111;
    const settings = {
      ...DEFAULT_SETTINGS,
      recurringTasks: [habitDef({ weekdays: weekdaysMonToFri })],
    };
    await backfillRecurringHabits(app, settings, wednesday);

    expect(store.get("2026-07-01.md")).toContain("Morning run"); // Wednesday (today)
    expect(store.get("2026-07-04.md") ?? "").not.toContain("Morning run"); // Saturday
  });

  it("does not touch days earlier this week (already passed) or outside the current ISO week", async () => {
    const { app, store } = makeApp();
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [habitDef()] };
    await backfillRecurringHabits(app, settings, wednesday);

    expect(store.has("2026-06-29.md")).toBe(false); // Monday this week, already passed
    expect(store.has("2026-06-30.md")).toBe(false); // Tuesday this week, already passed
    expect(store.has("2026-06-28.md")).toBe(false); // previous week
    expect(store.has("2026-07-06.md")).toBe(false); // next week
  });

  it("removes an orphaned habit line from today's note when its definition is deleted, and counts it as changed", async () => {
    const { app, store } = makeApp({ "2026-07-01.md": "# Routine\n- [ ] Morning run #daily" });
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [] }; // definition deleted
    const result = await backfillRecurringHabits(app, settings, wednesday);

    expect(store.get("2026-07-01.md")).toBe("# Routine");
    expect(result.filesChanged).toBeGreaterThanOrEqual(1);
  });

  it("does not remove a habit line matching a still-active, still-scheduled definition", async () => {
    const { app, store } = makeApp({ "2026-07-01.md": "# Routine\n- [ ] Morning run #daily" });
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [habitDef()] };
    await backfillRecurringHabits(app, settings, wednesday);

    expect(store.get("2026-07-01.md")).toBe("# Routine\n- [ ] Morning run #daily");
  });

  it("creates a not-yet-existing daily notes folder exactly once, even though days are backfilled concurrently", async () => {
    // Regression test: each day's DayMarkdownFile.ensure() independently checks/creates the
    // configured folder. Backfilling days concurrently means multiple ensure() calls could
    // race to create the same folder if it isn't created once up front first.
    const { app } = makeApp();
    const createFolderSpy = vi.spyOn(app.vault, "createFolder");
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [habitDef()] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app.vault as any).adapter.read = async () =>
      JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD", template: "" });
    await backfillRecurringHabits(app, settings, wednesday);

    expect(createFolderSpy).toHaveBeenCalledTimes(1);
    expect(createFolderSpy).toHaveBeenCalledWith("Journal");
  });

  it("counts a day as neither created nor changed when DayMarkdownFile.ensure() fails to produce a note", async () => {
    // Templater is configured but fails to create the note (resolves without a path)
    // and no file shows up on disk either, so DayMarkdownFile.ensure() returns null.
    const { app, store } = makeApp({ "templates/daily.md": "" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app.vault as any).adapter.read = async () =>
      JSON.stringify({ folder: "", format: "YYYY-MM-DD", template: "templates/daily.md" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).plugins.plugins["templater-obsidian"] = {
      templater: { create_new_note_from_template: async () => null },
    };
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [habitDef()] };
    const result = await backfillRecurringHabits(app, settings, wednesday);

    expect(result.filesCreated).toBe(0);
    expect(result.filesChanged).toBe(0);
    for (const d of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]) {
      expect(store.has(`${d}.md`)).toBe(false);
    }
  });
});
