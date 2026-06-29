import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

interface MomentObj {
  _d: Date;
  startOf(unit: string): MomentObj;
  diff(other: MomentObj, unit: string): number;
  format(): string;
  isSame(): boolean;
  isSameOrAfter(): boolean;
  isSameOrBefore(): boolean;
  isAfter(): boolean;
  add(): MomentObj;
  endOf(): MomentObj;
  isoWeek(): number;
}

function makeMomentObj(d: Date): MomentObj {
  const self: MomentObj = {
    _d: d,
    startOf(unit: string) {
      if (unit === "day") self._d.setHours(0, 0, 0, 0);
      return self;
    },
    diff(other: ReturnType<typeof makeMomentObj>, unit: string) {
      if (unit === "days") {
        return Math.round((self._d.getTime() - other._d.getTime()) / 86_400_000);
      }
      return 0;
    },
    format: () => "",
    isSame: () => false,
    isSameOrAfter: () => false,
    isSameOrBefore: () => false,
    isAfter: () => false,
    add: () => self,
    endOf: () => self,
    isoWeek: () => 1,
  };
  return self;
}

function mockMoment(...args: unknown[]) {
  if (args.length === 0) return makeMomentObj(new Date());
  if (args.length >= 2 && args[1] === "YYYY-MM-DD") {
    const [y, m, day] = (args[0] as string).split("-").map(Number);
    return makeMomentObj(new Date(y, m - 1, day));
  }
  return makeMomentObj(new Date(args[0] as string));
}

vi.mock("obsidian", () => ({
  App: class {},
  ItemView: class {
    contentEl = { empty: () => {}, createDiv: () => ({}) };
  },
  Menu: class {},
  TFile: class {},
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  normalizePath: (p: string) => p,
  setIcon: () => {},
  moment: Object.assign(mockMoment, { isMoment: () => false }),
}));

vi.mock("./task-creator", () => ({
  TaskModal: class {},
  ConfirmModal: class {},
  patchTaskField: vi.fn(),
  deleteTaskFile: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

vi.mock("./vault-reader", () => ({ loadVaultData: vi.fn() }));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

import { normalizeHabitKey, computeEffectiveValues, daysLabel } from "./dashboard-view";
import type { Task } from "@pm-compass/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHabitsTagRe(tag = "daily"): RegExp {
  return new RegExp(`\\s*#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
}

// ---------------------------------------------------------------------------
// normalizeHabitKey
// ---------------------------------------------------------------------------

describe("normalizeHabitKey", () => {
  const re = makeHabitsTagRe("daily");

  describe("habits tag stripping", () => {
    it("strips the habits tag at the end", () => {
      expect(normalizeHabitKey("Morning run #daily", re)).toBe("Morning run");
    });

    it("strips the habits tag in the middle", () => {
      expect(normalizeHabitKey("Morning #daily run", re)).toBe("Morning run");
    });

    it("strips leading whitespace left by the habits tag", () => {
      expect(normalizeHabitKey("#daily Morning run", re)).toBe("Morning run");
    });

    it("does not strip a tag that only starts with the habit tag name", () => {
      const result = normalizeHabitKey("Read 30 min #dailyreading", re);
      expect(result).toBe("Read 30 min #dailyreading");
    });
  });

  describe("Tasks plugin emoji metadata stripping", () => {
    it("strips a completion date (✅ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ✅ 2024-01-15", re)).toBe("Morning run");
    });

    it("strips a due date (📅 YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily 📅 2024-06-01", re)).toBe("Morning run");
    });

    it("strips a scheduled date (⏳ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ⏳ 2024-06-01", re)).toBe("Morning run");
    });

    it("strips a start date (🛫 YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily 🛫 2024-06-01", re)).toBe("Morning run");
    });

    it("strips a created date (➕ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ➕ 2024-01-01", re)).toBe("Morning run");
    });

    it("strips a recurrence marker (🔁)", () => {
      expect(normalizeHabitKey("Morning run #daily 🔁 every day", re)).toBe("Morning run every day");
    });

    it("strips a critical priority emoji (🔺)", () => {
      expect(normalizeHabitKey("Morning run 🔺 #daily", re)).toBe("Morning run");
    });

    it("strips a high priority emoji (⏫)", () => {
      expect(normalizeHabitKey("Morning run ⏫ #daily", re)).toBe("Morning run");
    });

    it("strips a medium priority emoji (🔼)", () => {
      expect(normalizeHabitKey("Morning run 🔼 #daily", re)).toBe("Morning run");
    });

    it("strips a low priority emoji (🔽)", () => {
      expect(normalizeHabitKey("Morning run 🔽 #daily", re)).toBe("Morning run");
    });

    it("strips a lowest priority emoji (⏬)", () => {
      expect(normalizeHabitKey("Morning run ⏬ #daily", re)).toBe("Morning run");
    });

    it("strips a cancelled date (❌ YYYY-MM-DD)", () => {
      expect(normalizeHabitKey("Morning run #daily ❌ 2024-01-15", re)).toBe("Morning run");
    });

    it("strips multiple metadata fields in one pass", () => {
      expect(
        normalizeHabitKey("Morning run 🔺 #daily ➕ 2024-01-01 ✅ 2024-01-15", re),
      ).toBe("Morning run");
    });
  });

  describe("dataview inline field stripping", () => {
    it("strips bracket-style inline fields ([key:: value])", () => {
      expect(normalizeHabitKey("Morning run #daily [completion:: 2024-01-15]", re)).toBe("Morning run");
    });

    it("strips parenthesis-style inline fields ((key:: value))", () => {
      expect(normalizeHabitKey("Morning run #daily (due:: 2024-06-01)", re)).toBe("Morning run");
    });

    it("strips hyphenated key inline fields", () => {
      expect(normalizeHabitKey("Morning run #daily [due-date:: 2024-06-01]", re)).toBe("Morning run");
    });
  });

  describe("aggregation key stability", () => {
    it("produces the same key for identical text with different completion dates", () => {
      const a = normalizeHabitKey("Morning run #daily ✅ 2024-01-10", re);
      const b = normalizeHabitKey("Morning run #daily ✅ 2024-01-15", re);
      expect(a).toBe(b);
    });

    it("produces the same key for identical text with different priorities", () => {
      const a = normalizeHabitKey("Morning run 🔺 #daily", re);
      const b = normalizeHabitKey("Morning run 🔽 #daily", re);
      expect(a).toBe(b);
    });

    it("produces the same key regardless of whether metadata is present", () => {
      const withMeta = normalizeHabitKey("Morning run #daily ✅ 2024-01-15", re);
      const withoutMeta = normalizeHabitKey("Morning run #daily", re);
      expect(withMeta).toBe(withoutMeta);
    });

    it("produces the same key for text with combined emoji + dataview metadata", () => {
      const a = normalizeHabitKey("Read book #daily 🔺 [completion:: 2024-01-01]", re);
      const b = normalizeHabitKey("Read book #daily ⏬ (due:: 2024-06-01)", re);
      expect(a).toBe(b);
    });
  });

  describe("whitespace handling", () => {
    it("collapses multiple internal spaces left after metadata removal", () => {
      expect(normalizeHabitKey("Morning   run #daily", re)).toBe("Morning run");
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalizeHabitKey("  Morning run #daily  ", re)).toBe("Morning run");
    });

    it("produces the same key when metadata removal leaves extra spaces", () => {
      const withGap = normalizeHabitKey("Morning run ✅ 2024-01-15 #daily", re);
      const clean = normalizeHabitKey("Morning run #daily", re);
      expect(withGap).toBe(clean);
    });

    it("produces the same key regardless of whitespace around the habits tag", () => {
      const a = normalizeHabitKey("Morning run #daily", re);
      const b = normalizeHabitKey("Morning run  #daily", re);
      expect(a).toBe(b);
    });
  });

  describe("custom habits tag", () => {
    it("respects a non-default habits tag", () => {
      const customRe = makeHabitsTagRe("habit");
      expect(normalizeHabitKey("Meditate #habit ✅ 2024-01-01", customRe)).toBe("Meditate");
    });

    it("leaves unrelated tags untouched", () => {
      const customRe = makeHabitsTagRe("habit");
      expect(normalizeHabitKey("Meditate #habit #wellness ✅ 2024-01-01", customRe)).toBe("Meditate #wellness");
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers for task tests
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    projectId: "proj",
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  };
}

function buildMap(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id, t]));
}

// ---------------------------------------------------------------------------
// computeEffectiveValues
// ---------------------------------------------------------------------------

describe("computeEffectiveValues", () => {
  describe("deadline inheritance", () => {
    it("uses the task's own deadline when it has no parent", () => {
      const task = makeTask({ id: "t1", due: "2026-07-10" });
      const result = computeEffectiveValues([task], buildMap([task]));
      expect(result.get("t1")?.due).toBe("2026-07-10");
    });

    it("inherits the parent's deadline when the task has none", () => {
      const parent = makeTask({ id: "p1", due: "2026-07-05" });
      const child = makeTask({ id: "c1", parentId: "p1" });
      const all = [parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.due).toBe("2026-07-05");
    });

    it("keeps the task's own deadline when it is earlier than the parent's", () => {
      const parent = makeTask({ id: "p1", due: "2026-07-20" });
      const child = makeTask({ id: "c1", parentId: "p1", due: "2026-07-05" });
      const all = [parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.due).toBe("2026-07-05");
    });

    it("uses the parent's deadline when it is earlier than the task's own", () => {
      const parent = makeTask({ id: "p1", due: "2026-07-01" });
      const child = makeTask({ id: "c1", parentId: "p1", due: "2026-07-20" });
      const all = [parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.due).toBe("2026-07-01");
    });

    it("traverses multiple levels and picks the closest deadline", () => {
      const grandparent = makeTask({ id: "gp", due: "2026-07-01" });
      const parent = makeTask({ id: "p1", parentId: "gp", due: "2026-07-10" });
      const child = makeTask({ id: "c1", parentId: "p1" });
      const all = [grandparent, parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.due).toBe("2026-07-01");
    });

    it("stops traversal at a done ancestor", () => {
      const grandparent = makeTask({ id: "gp", due: "2026-07-01" });
      const parent = makeTask({ id: "p1", parentId: "gp", due: "2026-07-10", status: "done" });
      const child = makeTask({ id: "c1", parentId: "p1" });
      const all = [grandparent, parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      // parent is done — traversal stops before reaching grandparent
      expect(result.get("c1")?.due).toBeUndefined();
    });

    it("stops traversal at a cancelled ancestor", () => {
      const parent = makeTask({ id: "p1", due: "2026-07-01", status: "cancelled" });
      const child = makeTask({ id: "c1", parentId: "p1" });
      const all = [parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.due).toBeUndefined();
    });

    it("handles a parentId that does not exist in the task map", () => {
      const child = makeTask({ id: "c1", parentId: "ghost", due: "2026-07-10" });
      const result = computeEffectiveValues([child], buildMap([child]));
      expect(result.get("c1")?.due).toBe("2026-07-10");
    });

    it("is cycle-safe when parentId forms a loop", () => {
      const a = makeTask({ id: "a", parentId: "b" });
      const b = makeTask({ id: "b", parentId: "a" });
      const all = [a, b];
      expect(() => computeEffectiveValues([a], buildMap(all))).not.toThrow();
    });
  });

  describe("priority inheritance", () => {
    it("uses the task's own priority when it has no parent", () => {
      const task = makeTask({ id: "t1", priority: "high" });
      const result = computeEffectiveValues([task], buildMap([task]));
      expect(result.get("t1")?.priority).toBe("high");
    });

    it("inherits the parent's higher priority", () => {
      const parent = makeTask({ id: "p1", priority: "critical" });
      const child = makeTask({ id: "c1", parentId: "p1", priority: "low" });
      const all = [parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.priority).toBe("critical");
    });

    it("keeps the task's own priority when it is higher than the parent's", () => {
      const parent = makeTask({ id: "p1", priority: "low" });
      const child = makeTask({ id: "c1", parentId: "p1", priority: "high" });
      const all = [parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.priority).toBe("high");
    });
  });

  describe("combined inheritance", () => {
    it("inherits both deadline and priority from parent independently", () => {
      const parent = makeTask({ id: "p1", due: "2026-07-01", priority: "critical" });
      const child = makeTask({ id: "c1", parentId: "p1" });
      const all = [parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.due).toBe("2026-07-01");
      expect(result.get("c1")?.priority).toBe("critical");
    });
  });
});

// ---------------------------------------------------------------------------
// daysLabel
// ---------------------------------------------------------------------------

describe("daysLabel", () => {
  const TODAY = "2026-06-29";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'today' when the due date is today", () => {
    expect(daysLabel(TODAY)).toEqual({ text: "today", overdue: false });
  });

  it("returns 'tomorrow' when the due date is tomorrow", () => {
    expect(daysLabel("2026-06-30")).toEqual({ text: "tomorrow", overdue: false });
  });

  it("returns 'in Nd' for a future date more than 1 day away", () => {
    expect(daysLabel("2026-07-06")).toEqual({ text: "in 7d", overdue: false });
  });

  it("returns 'Nd overdue' and overdue:true for a past date", () => {
    expect(daysLabel("2026-06-22")).toEqual({ text: "7d overdue", overdue: true });
  });

  it("returns overdue:false for any non-overdue date", () => {
    expect(daysLabel("2026-07-01").overdue).toBe(false);
  });
});
