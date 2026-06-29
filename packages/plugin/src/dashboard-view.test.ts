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

import { normalizeHabitKey, computeEffectiveValues, daysLabel, buildParentIdSet, selectPriorityQueue, selectApproachingDeadlines, getStatusColor, getPriorityColor, deadlinePoints } from "./dashboard-view";
import type { Task } from "./shared";

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

    it("keeps the child's own deadline when an intermediate parent is done", () => {
      const grandparent = makeTask({ id: "gp", due: "2026-07-01" });
      const parent = makeTask({ id: "p1", parentId: "gp", status: "done" });
      const child = makeTask({ id: "c1", parentId: "p1", due: "2026-08-01" });
      const all = [grandparent, parent, child];
      const result = computeEffectiveValues([child], buildMap(all));
      expect(result.get("c1")?.due).toBe("2026-08-01");
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
// buildParentIdSet
// ---------------------------------------------------------------------------

describe("buildParentIdSet", () => {
  it("returns an empty set when no task has a parentId", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    expect(buildParentIdSet(tasks).size).toBe(0);
  });

  it("includes the parentId of a child task", () => {
    const parent = makeTask({ id: "p1" });
    const child = makeTask({ id: "c1", parentId: "p1" });
    const set = buildParentIdSet([parent, child]);
    expect(set.has("p1")).toBe(true);
    expect(set.has("c1")).toBe(false);
  });

  it("does not include task IDs that are never referenced as parentId", () => {
    const a = makeTask({ id: "a" });
    const b = makeTask({ id: "b", parentId: "a" });
    const set = buildParentIdSet([a, b]);
    expect(set.has("b")).toBe(false);
  });

  it("handles multiple children sharing the same parent", () => {
    const parent = makeTask({ id: "p" });
    const c1 = makeTask({ id: "c1", parentId: "p" });
    const c2 = makeTask({ id: "c2", parentId: "p" });
    const set = buildParentIdSet([parent, c1, c2]);
    expect(set.has("p")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("leaf tasks are excluded — only parents appear in the set", () => {
    const gp = makeTask({ id: "gp" });
    const parent = makeTask({ id: "p", parentId: "gp" });
    const leaf = makeTask({ id: "leaf", parentId: "p" });
    const set = buildParentIdSet([gp, parent, leaf]);
    expect(set.has("gp")).toBe(true);
    expect(set.has("p")).toBe(true);
    expect(set.has("leaf")).toBe(false);
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

// ---------------------------------------------------------------------------
// selectApproachingDeadlines
// ---------------------------------------------------------------------------

describe("selectApproachingDeadlines", () => {
  const TODAY = "2026-06-29";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEffMap(tasks: Task[]): Map<string, { priority: string | undefined; due: string | undefined }> {
    return new Map(tasks.map((t) => [t.id, { priority: t.priority, due: t.due }]));
  }

  it("includes tasks due today (0 days)", () => {
    const t = makeTask({ id: "t1", due: TODAY });
    const result = selectApproachingDeadlines([t], makeEffMap([t]), new Set(), TODAY);
    expect(result.map((x) => x.id)).toEqual(["t1"]);
  });

  it("includes tasks due exactly 7 days from today", () => {
    const t = makeTask({ id: "t1", due: "2026-07-06" });
    const result = selectApproachingDeadlines([t], makeEffMap([t]), new Set(), TODAY);
    expect(result.map((x) => x.id)).toEqual(["t1"]);
  });

  it("excludes tasks due 8 or more days from today", () => {
    const t = makeTask({ id: "t1", due: "2026-07-07" });
    const result = selectApproachingDeadlines([t], makeEffMap([t]), new Set(), TODAY);
    expect(result).toHaveLength(0);
  });

  it("excludes overdue tasks (past due date)", () => {
    const t = makeTask({ id: "t1", due: "2026-06-28" });
    const result = selectApproachingDeadlines([t], makeEffMap([t]), new Set(), TODAY);
    expect(result).toHaveLength(0);
  });

  it("excludes tasks with no due date", () => {
    const t = makeTask({ id: "t1", priority: "critical" });
    const result = selectApproachingDeadlines([t], makeEffMap([t]), new Set(), TODAY);
    expect(result).toHaveLength(0);
  });

  it("excludes parent tasks", () => {
    const parent = makeTask({ id: "parent", due: TODAY });
    const child = makeTask({ id: "child", due: TODAY, parentId: "parent" });
    const tasks = [parent, child];
    const parentIds = buildParentIdSet(tasks);
    const result = selectApproachingDeadlines(tasks, makeEffMap(tasks), parentIds, TODAY);
    expect(result.map((x) => x.id)).toEqual(["child"]);
  });

  it("sorts by due date ascending", () => {
    const t1 = makeTask({ id: "t1", due: "2026-07-06" });
    const t2 = makeTask({ id: "t2", due: TODAY });
    const t3 = makeTask({ id: "t3", due: "2026-07-01" });
    const tasks = [t1, t2, t3];
    const result = selectApproachingDeadlines(tasks, makeEffMap(tasks), new Set(), TODAY);
    expect(result.map((x) => x.id)).toEqual(["t2", "t3", "t1"]);
  });

  it("uses priority as tiebreaker when due dates are equal", () => {
    const low = makeTask({ id: "low", due: TODAY, priority: "low" });
    const critical = makeTask({ id: "critical", due: TODAY, priority: "critical" });
    const high = makeTask({ id: "high", due: TODAY, priority: "high" });
    const tasks = [low, critical, high];
    const result = selectApproachingDeadlines(tasks, makeEffMap(tasks), new Set(), TODAY);
    expect(result.map((x) => x.id)).toEqual(["critical", "high", "low"]);
  });

  it("date ordering takes precedence over priority", () => {
    const lowTomorrow = makeTask({ id: "low", due: "2026-06-30", priority: "low" });
    const criticalIn7 = makeTask({ id: "critical", due: "2026-07-06", priority: "critical" });
    const tasks = [criticalIn7, lowTomorrow];
    const result = selectApproachingDeadlines(tasks, makeEffMap(tasks), new Set(), TODAY);
    expect(result.map((x) => x.id)).toEqual(["low", "critical"]);
  });
});

// ---------------------------------------------------------------------------
// selectPriorityQueue
// ---------------------------------------------------------------------------

describe("selectPriorityQueue", () => {
  const TODAY = "2026-06-29";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEffMap(tasks: Task[]): Map<string, { priority: string | undefined; due: string | undefined }> {
    return new Map(tasks.map((t) => [t.id, { priority: t.priority, due: t.due }]));
  }

  it("returns tasks sorted by descending score (priority + deadline urgency)", () => {
    const low = makeTask({ id: "low", priority: "low" });
    const high = makeTask({ id: "high", priority: "high" });
    const critical = makeTask({ id: "critical", priority: "critical" });
    const tasks = [low, high, critical];
    const result = selectPriorityQueue(tasks, makeEffMap(tasks), new Set(), new Set());
    expect(result.map((t) => t.id)).toEqual(["critical", "high", "low"]);
  });

  it("excludes parent tasks (tasks that have children)", () => {
    const parent = makeTask({ id: "parent", priority: "high" });
    const child = makeTask({ id: "child", priority: "medium", parentId: "parent" });
    const tasks = [parent, child];
    const parentIds = buildParentIdSet(tasks);
    const result = selectPriorityQueue(tasks, makeEffMap(tasks), parentIds, new Set());
    expect(result.map((t) => t.id)).toEqual(["child"]);
  });

  it("excludes tasks already in the approaching-deadlines set", () => {
    const deadline = makeTask({ id: "deadline", due: TODAY, priority: "critical" });
    const other = makeTask({ id: "other", priority: "high" });
    const tasks = [deadline, other];
    const excludeIds = new Set(["deadline"]);
    const result = selectPriorityQueue(tasks, makeEffMap(tasks), new Set(), excludeIds);
    expect(result.map((t) => t.id)).toEqual(["other"]);
    expect(result.find((t) => t.id === "deadline")).toBeUndefined();
  });

  it("omits tasks that have neither priority nor due date", () => {
    const unprioritized = makeTask({ id: "none" });
    const withPriority = makeTask({ id: "prio", priority: "low" });
    const tasks = [unprioritized, withPriority];
    const result = selectPriorityQueue(tasks, makeEffMap(tasks), new Set(), new Set());
    expect(result.map((t) => t.id)).toEqual(["prio"]);
  });

  it("includes a task that has only a due date and no priority", () => {
    const dueSoon = makeTask({ id: "due", due: TODAY });
    const result = selectPriorityQueue([dueSoon], makeEffMap([dueSoon]), new Set(), new Set());
    expect(result.map((t) => t.id)).toEqual(["due"]);
  });

  it("respects the limit parameter", () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `t${i}`, priority: "low" }),
    );
    const result = selectPriorityQueue(tasks, makeEffMap(tasks), new Set(), new Set(), 5);
    expect(result).toHaveLength(5);
  });

  it("defaults to a limit of 15", () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `t${i}`, priority: "low" }),
    );
    const result = selectPriorityQueue(tasks, makeEffMap(tasks), new Set(), new Set());
    expect(result).toHaveLength(15);
  });

  it("returns an empty array when all candidates are excluded", () => {
    const t1 = makeTask({ id: "t1", priority: "high" });
    const excludeIds = new Set(["t1"]);
    const result = selectPriorityQueue([t1], makeEffMap([t1]), new Set(), excludeIds);
    expect(result).toHaveLength(0);
  });

  it("a task excluded from deadlines does not appear even if it has the highest score", () => {
    const topDeadline = makeTask({ id: "top", due: TODAY, priority: "critical" });
    const second = makeTask({ id: "second", priority: "high" });
    const tasks = [topDeadline, second];
    const excludeIds = new Set(["top"]);
    const result = selectPriorityQueue(tasks, makeEffMap(tasks), new Set(), excludeIds);
    expect(result[0].id).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// getStatusColor
// ---------------------------------------------------------------------------

describe("getStatusColor", () => {
  it("returns the correct colour for each known status", () => {
    expect(getStatusColor("todo")).toBe("#6b7280");
    expect(getStatusColor("in-progress")).toBe("#3b82f6");
    expect(getStatusColor("blocked")).toBe("#ef4444");
    expect(getStatusColor("review")).toBe("#8b5cf6");
    expect(getStatusColor("done")).toBe("#22c55e");
    expect(getStatusColor("cancelled")).toBe("#9ca3af");
  });

  it("falls back to the todo grey for an unknown status", () => {
    expect(getStatusColor("unknown-status")).toBe("#6b7280");
    expect(getStatusColor("")).toBe("#6b7280");
  });
});

// ---------------------------------------------------------------------------
// getPriorityColor
// ---------------------------------------------------------------------------

describe("getPriorityColor", () => {
  it("returns the correct colour for each known priority", () => {
    expect(getPriorityColor("critical")).toBe("#ef4444");
    expect(getPriorityColor("high")).toBe("#f97316");
    expect(getPriorityColor("medium")).toBe("#eab308");
    expect(getPriorityColor("low")).toBe("#22c55e");
  });

  it("returns an empty string for undefined priority", () => {
    expect(getPriorityColor(undefined)).toBe("");
  });

  it("returns an empty string for an empty string priority", () => {
    expect(getPriorityColor("")).toBe("");
  });

  it("returns an empty string for an unrecognised priority", () => {
    expect(getPriorityColor("super-critical")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// deadlinePoints
// ---------------------------------------------------------------------------

describe("deadlinePoints", () => {
  const TODAY = "2026-06-29";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 when dueDate is undefined", () => {
    expect(deadlinePoints(undefined)).toBe(0);
  });

  it("returns 1000 for an overdue task", () => {
    expect(deadlinePoints("2026-06-28")).toBe(1000);
  });

  it("returns 500 for a task due today", () => {
    expect(deadlinePoints(TODAY)).toBe(500);
  });

  it("returns 200 for a task due tomorrow", () => {
    expect(deadlinePoints("2026-06-30")).toBe(200);
  });

  it("returns 100 for a task due in 3 days", () => {
    expect(deadlinePoints("2026-07-02")).toBe(100);
  });

  it("returns 50 for a task due in exactly 7 days", () => {
    expect(deadlinePoints("2026-07-06")).toBe(50);
  });

  it("returns 20 for a task due in 14 days", () => {
    expect(deadlinePoints("2026-07-13")).toBe(20);
  });

  it("returns 5 for a task due more than 14 days away", () => {
    expect(deadlinePoints("2026-08-01")).toBe(5);
  });
});
