import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

interface MomentObj {
  _d: Date;
  startOf(unit: string): MomentObj;
  diff(other: MomentObj, unit: string): number;
}

function makeMomentObj(d: Date): MomentObj {
  const self: MomentObj = {
    _d: new Date(d),
    startOf(unit: string) {
      if (unit === "day") self._d.setHours(0, 0, 0, 0);
      return self;
    },
    diff(other: MomentObj, unit: string) {
      if (unit === "days") {
        return Math.round((self._d.getTime() - other._d.getTime()) / 86_400_000);
      }
      return 0;
    },
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

vi.mock("obsidian", () => ({ moment: mockMoment }));

import {
  deadlinePoints,
  daysLabel,
  buildParentIdSet,
  computeEffectiveValues,
  selectApproachingDeadlines,
  selectPriorityQueue,
} from "./task-scoring";
import type { Task } from "./shared";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    projectId: "proj-1",
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `${overrides.id}.md`,
    ...overrides,
  };
}

const TODAY = new Date(2026, 6, 1); // Wednesday 2026-07-01

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

function offsetDateStr(days: number): string {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("deadlinePoints", () => {
  it("returns 0 when there is no due date", () => {
    expect(deadlinePoints(undefined)).toBe(0);
  });

  it("returns 1000 when overdue", () => {
    expect(deadlinePoints(offsetDateStr(-1))).toBe(1000);
  });

  it("returns 500 when due today", () => {
    expect(deadlinePoints(offsetDateStr(0))).toBe(500);
  });

  it("returns 200 when due tomorrow", () => {
    expect(deadlinePoints(offsetDateStr(1))).toBe(200);
  });

  it("returns 100 when due within 3 days", () => {
    expect(deadlinePoints(offsetDateStr(3))).toBe(100);
  });

  it("returns 50 when due within 7 days", () => {
    expect(deadlinePoints(offsetDateStr(7))).toBe(50);
  });

  it("returns 20 when due within 14 days", () => {
    expect(deadlinePoints(offsetDateStr(14))).toBe(20);
  });

  it("returns 5 when due more than 14 days out", () => {
    expect(deadlinePoints(offsetDateStr(15))).toBe(5);
  });
});

describe("daysLabel", () => {
  it("labels an overdue date", () => {
    expect(daysLabel(offsetDateStr(-3))).toEqual({ text: "3d overdue", overdue: true });
  });

  it("labels today", () => {
    expect(daysLabel(offsetDateStr(0))).toEqual({ text: "today", overdue: false });
  });

  it("labels tomorrow", () => {
    expect(daysLabel(offsetDateStr(1))).toEqual({ text: "tomorrow", overdue: false });
  });

  it("labels a future date in days", () => {
    expect(daysLabel(offsetDateStr(5))).toEqual({ text: "in 5d", overdue: false });
  });
});

describe("buildParentIdSet", () => {
  it("collects parentIds, skipping tasks without one", () => {
    const tasks = [
      makeTask({ id: "a", parentId: "root" }),
      makeTask({ id: "b" }),
      makeTask({ id: "c", parentId: "root" }),
    ];
    expect(buildParentIdSet(tasks)).toEqual(new Set(["root"]));
  });

  it("returns an empty set when no task has a parent", () => {
    expect(buildParentIdSet([makeTask({ id: "a" })])).toEqual(new Set());
  });
});

describe("computeEffectiveValues", () => {
  it("uses the task's own priority/due when it has no parent", () => {
    const t = makeTask({ id: "a", priority: "low", due: "2026-07-10" });
    const map = computeEffectiveValues([t], new Map([["a", t]]));
    expect(map.get("a")).toEqual({ priority: "low", due: "2026-07-10" });
  });

  it("inherits a higher-urgency priority from an ancestor", () => {
    const parent = makeTask({ id: "p", priority: "critical" });
    const child = makeTask({ id: "c", parentId: "p", priority: "low" });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.priority).toBe("critical");
  });

  it("does not downgrade to a lower-urgency ancestor priority", () => {
    const parent = makeTask({ id: "p", priority: "low" });
    const child = makeTask({ id: "c", parentId: "p", priority: "critical" });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.priority).toBe("critical");
  });

  it("inherits an earlier due date from an ancestor", () => {
    const parent = makeTask({ id: "p", due: "2026-07-05" });
    const child = makeTask({ id: "c", parentId: "p", due: "2026-07-20" });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.due).toBe("2026-07-05");
  });

  it("does not adopt a later due date from an ancestor", () => {
    const parent = makeTask({ id: "p", due: "2026-07-20" });
    const child = makeTask({ id: "c", parentId: "p", due: "2026-07-05" });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.due).toBe("2026-07-05");
  });

  it("stops walking up at a done/cancelled ancestor", () => {
    const grandparent = makeTask({ id: "gp", priority: "critical" });
    const parent = makeTask({ id: "p", parentId: "gp", status: "done" });
    const child = makeTask({ id: "c", parentId: "p" });
    const byId = new Map([["gp", grandparent], ["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.priority).toBeUndefined();
  });

  it("does not infinite-loop on a cyclical parent chain", () => {
    const a = makeTask({ id: "a", parentId: "b" });
    const b = makeTask({ id: "b", parentId: "a" });
    const byId = new Map([["a", a], ["b", b]]);
    const map = computeEffectiveValues([a, b], byId);
    expect(map.get("a")).toBeDefined();
    expect(map.get("b")).toBeDefined();
  });

  it("leaves priority/due undefined when nothing in the chain sets them", () => {
    const parent = makeTask({ id: "p" });
    const child = makeTask({ id: "c", parentId: "p" });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")).toEqual({ priority: undefined, due: undefined });
  });
});

describe("selectApproachingDeadlines", () => {
  it("excludes tasks with no due date", () => {
    const t = makeTask({ id: "a" });
    const evMap = new Map([["a", { priority: undefined, due: undefined }]]);
    expect(selectApproachingDeadlines([t], evMap, new Set(), offsetDateStr(0))).toEqual([]);
  });

  it("excludes tasks due more than 7 days out or already past", () => {
    const soon = makeTask({ id: "soon" });
    const far = makeTask({ id: "far" });
    const past = makeTask({ id: "past" });
    const evMap = new Map([
      ["soon", { priority: undefined, due: offsetDateStr(3) }],
      ["far", { priority: undefined, due: offsetDateStr(8) }],
      ["past", { priority: undefined, due: offsetDateStr(-1) }],
    ]);
    const result = selectApproachingDeadlines([soon, far, past], evMap, new Set(), offsetDateStr(0));
    expect(result.map((t) => t.id)).toEqual(["soon"]);
  });

  it("excludes parent tasks", () => {
    const parent = makeTask({ id: "parent" });
    const evMap = new Map([["parent", { priority: undefined, due: offsetDateStr(1) }]]);
    const result = selectApproachingDeadlines([parent], evMap, new Set(["parent"]), offsetDateStr(0));
    expect(result).toEqual([]);
  });

  it("sorts by due date ascending", () => {
    const a = makeTask({ id: "a" });
    const b = makeTask({ id: "b" });
    const evMap = new Map([
      ["a", { priority: undefined, due: offsetDateStr(5) }],
      ["b", { priority: undefined, due: offsetDateStr(2) }],
    ]);
    const result = selectApproachingDeadlines([a, b], evMap, new Set(), offsetDateStr(0));
    expect(result.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("breaks a same-due-date tie by higher priority first", () => {
    const low = makeTask({ id: "low" });
    const critical = makeTask({ id: "critical" });
    const sameDue = offsetDateStr(3);
    const evMap = new Map([
      ["low", { priority: "low", due: sameDue }],
      ["critical", { priority: "critical", due: sameDue }],
    ]);
    const result = selectApproachingDeadlines([low, critical], evMap, new Set(), offsetDateStr(0));
    expect(result.map((t) => t.id)).toEqual(["critical", "low"]);
  });

  it("breaks a same-due-date tie where priority is missing on either side", () => {
    // Exercises both directions of the `priority ?? ""` / `PRIORITY_SCORE[...] ?? 0`
    // fallbacks in the tie-break comparator (undefined-vs-defined and defined-vs-undefined).
    const none = makeTask({ id: "none" });
    const critical = makeTask({ id: "critical" });
    const alsoNone = makeTask({ id: "also-none" });
    const sameDue = offsetDateStr(3);
    const evMap = new Map([
      ["none", { priority: undefined, due: sameDue }],
      ["critical", { priority: "critical", due: sameDue }],
      ["also-none", { priority: undefined, due: sameDue }],
    ]);
    const result = selectApproachingDeadlines(
      [none, critical, alsoNone],
      evMap,
      new Set(),
      offsetDateStr(0),
    );
    expect(result[0].id).toBe("critical");
    expect(result.map((t) => t.id)).toContain("none");
    expect(result.map((t) => t.id)).toContain("also-none");
  });
});

describe("selectPriorityQueue", () => {
  it("excludes tasks with neither priority nor due date", () => {
    const t = makeTask({ id: "a" });
    const evMap = new Map([["a", { priority: undefined, due: undefined }]]);
    expect(selectPriorityQueue([t], evMap, new Set(), new Set())).toEqual([]);
  });

  it("excludes parent tasks and explicitly excluded ids", () => {
    const parent = makeTask({ id: "parent", priority: "high" });
    const excluded = makeTask({ id: "excluded", priority: "high" });
    const kept = makeTask({ id: "kept", priority: "high" });
    const evMap = new Map([
      ["parent", { priority: "high", due: undefined }],
      ["excluded", { priority: "high", due: undefined }],
      ["kept", { priority: "high", due: undefined }],
    ]);
    const result = selectPriorityQueue(
      [parent, excluded, kept],
      evMap,
      new Set(["parent"]),
      new Set(["excluded"]),
    );
    expect(result.map((t) => t.id)).toEqual(["kept"]);
  });

  it("sorts by combined deadline + priority score descending, treating missing values as zero", () => {
    const highPriorityNoDue = makeTask({ id: "hp" });
    const dueSoonNoPriority = makeTask({ id: "ds" });
    const both = makeTask({ id: "both" });
    const evMap = new Map([
      ["hp", { priority: "critical", due: undefined }],
      ["ds", { priority: undefined, due: offsetDateStr(-1) }], // overdue: 1000 points
      ["both", { priority: "low", due: offsetDateStr(-1) }],
    ]);
    // Three tasks with different priority/due combinations force the sort comparator
    // through every direction of the `priority ?? ""` / `deadlinePoints` fallbacks.
    const result = selectPriorityQueue(
      [highPriorityNoDue, dueSoonNoPriority, both],
      evMap,
      new Set(),
      new Set(),
    );
    expect(result.map((t) => t.id)).toEqual(["both", "ds", "hp"]);
  });

  it("limits the result to the given limit", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask({ id: `t${i}`, priority: "low" }));
    const evMap = new Map(tasks.map((t) => [t.id, { priority: "low", due: undefined }]));
    const result = selectPriorityQueue(tasks, evMap, new Set(), new Set(), 2);
    expect(result).toHaveLength(2);
  });
});
