import { vi, describe, it, expect } from "vitest";
import { asMoment } from "../__testing__/as-moment";
import type { Moment } from "../moment";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  moment: Object.assign(
    (...args: unknown[]) => {
      if (args.length === 0) return makeMoment(new Date("2026-06-29")); // fixed "today"
      // Either one of our own moment stubs (which carries `_d`) or a date string.
      const arg = args[0] as { _d?: Date } | string;
      const d = typeof arg === "object" && arg._d instanceof Date
        ? new Date(arg._d)
        : new Date(arg as string);
      return makeMoment(d);
    },
    { isMoment: () => false },
  ),
}));

import { WeekSummary, computeDailyTaskCounts } from "./week-summary";
import type { DayNoteEntry } from "../cache/task-file-cache";
import { Task } from "./task";
import { addDays } from "../dates";
import { day } from "../__testing__/dates";

// ---------------------------------------------------------------------------
// Moment stub
// ---------------------------------------------------------------------------

interface MomentFake {
  _d: Date;
  add(n: number, unit: string): MomentFake & Moment;
  format(fmt?: string): string;
  isAfter(other: MomentFake, _unit?: string): boolean;
  toDate(): Date;
}

function makeMoment(d: Date): MomentFake & Moment {
  const self: MomentFake = {
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
    isAfter(other: MomentFake, _unit?: string) {
      return self._d > other._d;
    },
    toDate() {
      return new Date(self._d);
    },
  };
  return asMoment(self);
}

// ---------------------------------------------------------------------------
// The week as the cache hands it over
// ---------------------------------------------------------------------------

/** The week as the cache hands it over: one entry per day from `WEEK_START`, each
 *  carrying the note's lines when `files` names it. */
function weekEntries(files: Record<string, string> = {}): DayNoteEntry[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(day(WEEK_START), i);
    const path = `Daily/${formatIso(date)}.md`;
    const text = files[path];
    return {
      path,
      date,
      exists: text !== undefined,
      items: [],
      lines: text !== undefined ? text.split("\n") : [],
    };
  });
}

const formatIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const WEEK_START = "2026-06-29"; // Monday

// ---------------------------------------------------------------------------
// computeDailyTaskCounts
// ---------------------------------------------------------------------------

describe("computeDailyTaskCounts", () => {
  function parseTasks(raw: string): Task[] {
    return raw.split("\n").map((l, i) => Task.parse(l, i)).filter((t): t is Task => t !== null);
  }

  it("returns zeros for empty input", () => {
    expect(computeDailyTaskCounts([], day("2026-06-29"), "daily")).toEqual({
      closedOnTime: 0, closedLate: 0, open: 0, total: 0,
    });
  });

  it("excludes habit-tagged items", () => {
    const tasks = parseTasks("- [x] Run #daily ✅ 2026-06-29\n- [ ] Write docs");
    expect(computeDailyTaskCounts(tasks, day("2026-06-29"), "daily")).toEqual({
      closedOnTime: 0, closedLate: 0, open: 1, total: 1,
    });
  });

  it("counts open tasks", () => {
    const tasks = parseTasks("- [ ] Task A\n- [ ] Task B");
    expect(computeDailyTaskCounts(tasks, day("2026-06-29"), "daily")).toEqual({
      closedOnTime: 0, closedLate: 0, open: 2, total: 2,
    });
  });

  it("marks closed-on-time when completedAt matches note date", () => {
    const tasks = parseTasks("- [x] Task A ✅ 2026-06-29");
    expect(computeDailyTaskCounts(tasks, day("2026-06-29"), "daily")).toEqual({
      closedOnTime: 1, closedLate: 0, open: 0, total: 1,
    });
  });

  it("marks closed-late when completedAt is after note date", () => {
    const tasks = parseTasks("- [x] Task A ✅ 2026-06-30");
    expect(computeDailyTaskCounts(tasks, day("2026-06-29"), "daily")).toEqual({
      closedOnTime: 0, closedLate: 1, open: 0, total: 1,
    });
  });

  it("treats checked items without a ✅ date as closed on time", () => {
    const tasks = parseTasks("- [x] Task A");
    expect(computeDailyTaskCounts(tasks, day("2026-06-29"), "daily")).toEqual({
      closedOnTime: 1, closedLate: 0, open: 0, total: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// WeekSummary.from
// ---------------------------------------------------------------------------

describe("WeekSummary.from", () => {
  it("produces 7 day entries", async () => {
    const ws = WeekSummary.from(weekEntries(), "daily");
    expect(ws.days).toHaveLength(7);
  });

  it("assigns the day and its index correctly", async () => {
    const ws = WeekSummary.from(weekEntries(), "daily");
    expect(ws.days[0].date).toEqual(day("2026-06-29"));
    expect(ws.days[0].dayIndex).toBe(0);
    expect(ws.days[6].date).toEqual(day("2026-07-05"));
    expect(ws.days[6].dayIndex).toBe(6);
  });

  it("sets hasNote=false when day file is missing", async () => {
    const ws = WeekSummary.from(weekEntries(), "daily");
    expect(ws.days.every((d) => !d.hasNote)).toBe(true);
  });

  it("sets hasNote=true for existing files and parses tasks", async () => {
    const ws = WeekSummary.from(weekEntries({
      "Daily/2026-06-29.md": "- [ ] Write tests\n- [x] Review PR ✅ 2026-06-29",
    }), "daily");
    expect(ws.days[0].hasNote).toBe(true);
    expect(ws.days[0].tasks).toHaveLength(2);
  });

  it("accumulates habit summaries across the week", async () => {
    const ws = WeekSummary.from(weekEntries({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29\n- [ ] Meditate #daily",
      "Daily/2026-06-30.md": "- [x] Run #daily ✅ 2026-06-30\n- [x] Meditate #daily ✅ 2026-06-30",
    }), "daily");
    const run = ws.habits.find((h) => h.key === "Run");
    const meditate = ws.habits.find((h) => h.key === "Meditate");
    expect(run?.completionCount).toBe(2);
    expect(run?.presenceCount).toBe(2);
    expect(meditate?.completionCount).toBe(1);
    expect(meditate?.presenceCount).toBe(2);
  });

  it("sorts habits by completion count descending", async () => {
    const ws = WeekSummary.from(weekEntries({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29\n- [ ] Meditate #daily",
      "Daily/2026-06-30.md": "- [x] Run #daily ✅ 2026-06-30\n- [x] Meditate #daily ✅ 2026-06-30",
      "Daily/2026-07-01.md": "- [x] Run #daily ✅ 2026-07-01\n- [ ] Meditate #daily",
    }), "daily");
    expect(ws.habits[0].key).toBe("Run");
    expect(ws.habits[1].key).toBe("Meditate");
  });

  it("sorts two never-completed habits without error (both completion counts fall back to 0)", async () => {
    const ws = WeekSummary.from(weekEntries({
      "Daily/2026-06-29.md": "- [ ] Run #daily\n- [ ] Meditate #daily",
    }), "daily");
    expect(ws.habits.map((h) => h.key).sort()).toEqual(["Meditate", "Run"]);
    expect(ws.habits.every((h) => h.completionCount === 0)).toBe(true);
  });

  it("records checkedDays indices for habits", async () => {
    const ws = WeekSummary.from(weekEntries({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29", // dayIndex 0
      "Daily/2026-07-01.md": "- [x] Run #daily ✅ 2026-07-01", // dayIndex 2
    }), "daily");
    const run = ws.habits.find((h) => h.key === "Run");
    expect(run?.checkedDays).toEqual([0, 2]);
  });

  it("computes habitsDone and habitsTotal per day", async () => {
    const ws = WeekSummary.from(weekEntries({
      "Daily/2026-06-29.md": "- [x] Run #daily ✅ 2026-06-29\n- [ ] Meditate #daily",
    }), "daily");
    expect(ws.days[0].habitsDone).toBe(1);
    expect(ws.days[0].habitsTotal).toBe(2);
  });

  it("does not count non-habit tasks in habitsDone/habitsTotal", async () => {
    const ws = WeekSummary.from(weekEntries({
      "Daily/2026-06-29.md": "- [x] Write docs ✅ 2026-06-29\n- [ ] Review PR",
    }), "daily");
    expect(ws.days[0].habitsDone).toBe(0);
    expect(ws.days[0].habitsTotal).toBe(0);
  });

  it("builds filePath from config folder and format", async () => {
    const ws = WeekSummary.from(weekEntries(), "daily");
    expect(ws.days[0].filePath).toBe("Daily/2026-06-29.md");
  });

  it("carries whatever path the cache read the day from", () => {
    const ws = WeekSummary.from(
      weekEntries().map((e) => ({ ...e, path: e.path.replace("Daily/", "") })),
      "daily",
    );
    expect(ws.days[0].filePath).toBe("2026-06-29.md");
  });
});
