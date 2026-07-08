import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  moment: Object.assign(
    (...args: unknown[]) => {
      if (args.length === 0) return makeMoment(new Date("2026-06-29")); // fixed "today"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arg = args[0] as any;
      const d = arg?._d instanceof Date ? new Date(arg._d) : new Date(arg as string);
      return makeMoment(d);
    },
    { isMoment: () => false },
  ),
}));

import { TFile as TFileMock } from "obsidian";
import { WeekSummary, computeDailyTaskCounts, DailyNotesConfig } from "./week-summary";
import { DayTask } from "./day-task";

// ---------------------------------------------------------------------------
// Moment stub
// ---------------------------------------------------------------------------

function makeMoment(d: Date) {
  const self = {
    _d: new Date(d),
    add(n: number, unit: string) {
      const next = new Date(self._d);
      if (unit === "days") next.setDate(next.getDate() + n);
      return makeMoment(next);
    },
    format(fmt?: string) {
      const y = self._d.getFullYear();
      const m = String(self._d.getMonth() + 1).padStart(2, "0");
      const day = String(self._d.getDate()).padStart(2, "0");
      if (!fmt || fmt === "YYYY-MM-DD") return `${y}-${m}-${day}`;
      // handle simple tokens only
      return fmt
        .replace("YYYY", String(y))
        .replace("MM", m)
        .replace("DD", day);
    },
    isAfter(other: ReturnType<typeof makeMoment>, _unit?: string) {
      return self._d > other._d;
    },
  };
  return self;
}

// ---------------------------------------------------------------------------
// Vault mock helpers
// ---------------------------------------------------------------------------

function makeVaultFile(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = Object.create((TFileMock as any).prototype);
  f.path = path;
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) =>
        store.has(path) ? makeVaultFile(path) : null,
      read: async (file: { path: string }) => store.get(file.path) ?? "",
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any;
  return { app, store };
}

const WEEK_START = "2026-06-29"; // Monday
const CONFIG: DailyNotesConfig = { folder: "Daily", format: "YYYY-MM-DD", template: "" };

// ---------------------------------------------------------------------------
// computeDailyTaskCounts
// ---------------------------------------------------------------------------

describe("computeDailyTaskCounts", () => {
  function parseTasks(raw: string): DayTask[] {
    return raw.split("\n").map((l, i) => DayTask.parse(l, i)).filter((t): t is DayTask => t !== null);
  }

  it("returns zeros for empty input", () => {
    expect(computeDailyTaskCounts([], "2026-06-29", "daily")).toEqual({
      closedOnTime: 0, closedLate: 0, open: 0, total: 0,
    });
  });

  it("excludes habit-tagged items", () => {
    const tasks = parseTasks("- [x] Run #daily ✅ 2026-06-29\n- [ ] Write docs");
    expect(computeDailyTaskCounts(tasks, "2026-06-29", "daily")).toEqual({
      closedOnTime: 0, closedLate: 0, open: 1, total: 1,
    });
  });

  it("counts open tasks", () => {
    const tasks = parseTasks("- [ ] Task A\n- [ ] Task B");
    expect(computeDailyTaskCounts(tasks, "2026-06-29", "daily")).toEqual({
      closedOnTime: 0, closedLate: 0, open: 2, total: 2,
    });
  });

  it("marks closed-on-time when completedAt matches note date", () => {
    const tasks = parseTasks("- [x] Task A ✅ 2026-06-29");
    expect(computeDailyTaskCounts(tasks, "2026-06-29", "daily")).toEqual({
      closedOnTime: 1, closedLate: 0, open: 0, total: 1,
    });
  });

  it("marks closed-late when completedAt is after note date", () => {
    const tasks = parseTasks("- [x] Task A ✅ 2026-06-30");
    expect(computeDailyTaskCounts(tasks, "2026-06-29", "daily")).toEqual({
      closedOnTime: 0, closedLate: 1, open: 0, total: 1,
    });
  });

  it("treats checked items without a ✅ date as closed on time", () => {
    const tasks = parseTasks("- [x] Task A");
    expect(computeDailyTaskCounts(tasks, "2026-06-29", "daily")).toEqual({
      closedOnTime: 1, closedLate: 0, open: 0, total: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// WeekSummary.load
// ---------------------------------------------------------------------------

describe("WeekSummary.load", () => {
  it("produces 7 day entries", async () => {
    const { app } = makeApp();
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.days).toHaveLength(7);
  });

  it("assigns dateStr and dayIndex correctly", async () => {
    const { app } = makeApp();
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.days[0].dateStr).toBe("2026-06-29");
    expect(ws.days[0].dayIndex).toBe(0);
    expect(ws.days[6].dateStr).toBe("2026-07-05");
    expect(ws.days[6].dayIndex).toBe(6);
  });

  it("sets hasNote=false when day file is missing", async () => {
    const { app } = makeApp();
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.days.every((d) => !d.hasNote)).toBe(true);
  });

  it("sets hasNote=true for existing files and parses tasks", async () => {
    const { app } = makeApp({
      "Daily/2026-06-29.md": "- [ ] Write tests\n- [x] Review PR ✅ 2026-06-29",
    });
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.days[0].hasNote).toBe(true);
    expect(ws.days[0].tasks).toHaveLength(2);
  });

  it("accumulates habit summaries across the week", async () => {
    const { app } = makeApp({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29\n- [ ] Meditate #daily",
      "Daily/2026-06-30.md": "- [x] Run #daily ✅ 2026-06-30\n- [x] Meditate #daily ✅ 2026-06-30",
    });
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    const run = ws.habits.find((h) => h.key === "Run");
    const meditate = ws.habits.find((h) => h.key === "Meditate");
    expect(run?.completionCount).toBe(2);
    expect(run?.presenceCount).toBe(2);
    expect(meditate?.completionCount).toBe(1);
    expect(meditate?.presenceCount).toBe(2);
  });

  it("sorts habits by completion count descending", async () => {
    const { app } = makeApp({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29\n- [ ] Meditate #daily",
      "Daily/2026-06-30.md": "- [x] Run #daily ✅ 2026-06-30\n- [x] Meditate #daily ✅ 2026-06-30",
      "Daily/2026-07-01.md": "- [x] Run #daily ✅ 2026-07-01\n- [ ] Meditate #daily",
    });
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.habits[0].key).toBe("Run");
    expect(ws.habits[1].key).toBe("Meditate");
  });

  it("sorts two never-completed habits without error (both completion counts fall back to 0)", async () => {
    const { app } = makeApp({
      "Daily/2026-06-29.md": "- [ ] Run #daily\n- [ ] Meditate #daily",
    });
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.habits.map((h) => h.key).sort()).toEqual(["Meditate", "Run"]);
    expect(ws.habits.every((h) => h.completionCount === 0)).toBe(true);
  });

  it("records checkedDays indices for habits", async () => {
    const { app } = makeApp({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29", // dayIndex 0
      "Daily/2026-07-01.md": "- [x] Run #daily ✅ 2026-07-01", // dayIndex 2
    });
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    const run = ws.habits.find((h) => h.key === "Run");
    expect(run?.checkedDays).toEqual([0, 2]);
  });

  it("computes habitsDone and habitsTotal per day", async () => {
    const { app } = makeApp({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29\n- [ ] Meditate #daily",
    });
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.days[0].habitsDone).toBe(1);
    expect(ws.days[0].habitsTotal).toBe(2);
  });

  it("does not count non-habit tasks in habitsDone/habitsTotal", async () => {
    const { app } = makeApp({
      "Daily/2026-06-29.md": "- [x] Write docs ✅ 2026-06-29\n- [ ] Review PR",
    });
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.days[0].habitsDone).toBe(0);
    expect(ws.days[0].habitsTotal).toBe(0);
  });

  it("builds filePath from config folder and format", async () => {
    const { app } = makeApp();
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), CONFIG, "daily");
    expect(ws.days[0].filePath).toBe("Daily/2026-06-29.md");
  });

  it("builds filePath without folder prefix when folder is empty", async () => {
    const { app } = makeApp();
    const noFolder: DailyNotesConfig = { folder: "", format: "YYYY-MM-DD", template: "" };
    const ws = await WeekSummary.load(app, makeMoment(new Date(WEEK_START)), noFolder, "daily");
    expect(ws.days[0].filePath).toBe("2026-06-29.md");
  });
});
