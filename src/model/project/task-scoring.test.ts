import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  deadlinePoints,
  buildParentIdSet,
  computeEffectiveValues,
  selectActiveWithStatus,
  selectCompletedInWeek,
  selectCompletedOn,
  selectCreatedInWeek,
  selectPriorityQueue,
  selectUndatedTasks,
  bucketTasksByHorizon,
} from "./task-scoring";
import type { EffectiveValues } from "./task-scoring";
import { day, timestamp } from "../__testing__/dates";
import { ProjectTask, type ProjectTaskFields } from "./project-task";
import { Priority, Status } from "../base-task";
import { newTask } from "../__testing__/notes";

function makeTask(overrides: Partial<ProjectTaskFields> & { id: string }): ProjectTask {
  return newTask({
    title: overrides.id,
    projectId: "proj-1",
    status: "todo",
    dependencies: [],
    filePath: `${overrides.id}.md`,
    ...overrides,
  });
}

/**
 * A fixture for the selectors. `subtree` is the level rolled up from the task and its
 * children — the tiebreak under `priority`. It defaults to the level in force, which is
 * what a task gets when nothing below it is more urgent than what it inherits.
 */
function ev(
  priority: Priority | undefined,
  due: Date | undefined,
  subtree: Priority | undefined = priority,
): EffectiveValues {
  return { priority, ancestorPriority: priority, subtreePriority: subtree, due };
}

const TODAY = new Date(2026, 6, 1); // Wednesday 2026-07-01

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A day `days` from `TODAY`. */
function offsetDay(days: number): Date {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + days);
  return d;
}

describe("deadlinePoints", () => {
  it("returns 0 when there is no due date", () => {
    expect(deadlinePoints(undefined)).toBe(0);
  });

  it("returns 1000 when overdue", () => {
    expect(deadlinePoints(offsetDay(-1))).toBe(1000);
  });

  it("returns 500 when due today", () => {
    expect(deadlinePoints(offsetDay(0))).toBe(500);
  });

  it("returns 200 when due tomorrow", () => {
    expect(deadlinePoints(offsetDay(1))).toBe(200);
  });

  it("returns 100 when due within 3 days", () => {
    expect(deadlinePoints(offsetDay(3))).toBe(100);
  });

  it("returns 50 when due within 7 days", () => {
    expect(deadlinePoints(offsetDay(7))).toBe(50);
  });

  it("returns 20 when due within 14 days", () => {
    expect(deadlinePoints(offsetDay(14))).toBe(20);
  });

  it("returns 5 when due more than 14 days out", () => {
    expect(deadlinePoints(offsetDay(15))).toBe(5);
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
    const t = makeTask({ id: "a", priority: Priority.Low, due: day("2026-07-10") });
    const map = computeEffectiveValues([t], new Map([["a", t]]));
    expect(map.get("a")).toEqual({
      priority: Priority.Low,
      ancestorPriority: Priority.Low,
      subtreePriority: Priority.Low,
      due: day("2026-07-10"),
    });
  });

  it("inherits a higher-urgency priority from an ancestor", () => {
    const parent = makeTask({ id: "p", priority: Priority.Critical });
    const child = makeTask({ id: "c", parentId: "p", priority: Priority.Low });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.priority).toBe("critical");
  });

  it("does not downgrade to a lower-urgency ancestor priority", () => {
    const parent = makeTask({ id: "p", priority: Priority.Low });
    const child = makeTask({ id: "c", parentId: "p", priority: Priority.Critical });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.priority).toBe("critical");
  });

  it("inherits an earlier due date from an ancestor", () => {
    const parent = makeTask({ id: "p", due: day("2026-07-05") });
    const child = makeTask({ id: "c", parentId: "p", due: day("2026-07-20") });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.due).toEqual(day("2026-07-05"));
  });

  it("does not adopt a later due date from an ancestor", () => {
    const parent = makeTask({ id: "p", due: day("2026-07-20") });
    const child = makeTask({ id: "c", parentId: "p", due: day("2026-07-05") });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")!.due).toEqual(day("2026-07-05"));
  });

  it("walks the whole chain up, a closed ancestor included, whatever the task's own status", () => {
    const grandparent = makeTask({ id: "gp", priority: Priority.Critical });
    const parent = makeTask({ id: "p", parentId: "gp", status: "done", priority: Priority.High });
    const open = makeTask({ id: "o", parentId: "p" });
    const closed = makeTask({ id: "c", parentId: "p", status: "done" });
    const byId = new Map([["gp", grandparent], ["p", parent], ["o", open], ["c", closed]]);
    const map = computeEffectiveValues([open, closed], byId);
    // Ticking a task leaves its own roll-up alone, and so does ticking the parent over it.
    expect(map.get("o")!.ancestorPriority).toBe(Priority.Critical);
    expect(map.get("c")!.ancestorPriority).toBe(Priority.Critical);
  });

  it("does not infinite-loop on a cyclical parent chain, each link still rolling the other up", () => {
    const a = makeTask({ id: "a", parentId: "b", priority: Priority.Low });
    const b = makeTask({ id: "b", parentId: "a", priority: Priority.High });
    const byId = new Map([["a", a], ["b", b]]);
    const map = computeEffectiveValues([a, b], byId);
    expect(map.get("a")!.ancestorPriority).toBe(Priority.High);
    expect(map.get("b")!.ancestorPriority).toBe(Priority.High);
  });

  it("rolls the same chain up the same way for every task hanging off it", () => {
    const root = makeTask({ id: "r", priority: Priority.Critical, due: day("2026-07-01") });
    const middle = makeTask({ id: "m", parentId: "r" });
    const tasks = ["x", "y", "z"].map((id) => makeTask({ id, parentId: "m" }));
    const byId = new Map([["r", root], ["m", middle], ...tasks.map((t) => [t.id, t] as const)]);
    const map = computeEffectiveValues([middle, ...tasks], byId);
    for (const id of ["m", "x", "y", "z"]) {
      expect(map.get(id)!.ancestorPriority).toBe(Priority.Critical);
      expect(map.get(id)!.due).toEqual(day("2026-07-01"));
    }
  });

  it("leaves priority/due undefined when nothing in the chain sets them", () => {
    const parent = makeTask({ id: "p" });
    const child = makeTask({ id: "c", parentId: "p" });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([child], byId);
    expect(map.get("c")).toEqual({
      priority: undefined,
      ancestorPriority: undefined,
      subtreePriority: undefined,
      due: undefined,
    });
  });

  it("rolls the highest priority in the subtree up into subtreePriority", () => {
    const parent = makeTask({ id: "p", priority: Priority.Medium });
    const child = makeTask({ id: "c", parentId: "p", priority: Priority.Medium });
    const grandchild = makeTask({ id: "gc", parentId: "c", priority: Priority.High });
    const byId = new Map([["p", parent], ["c", child], ["gc", grandchild]]);
    const map = computeEffectiveValues([parent, child, grandchild], byId);
    expect(map.get("p")!.subtreePriority).toBe(Priority.High);
    // The upward roll-up keeps to itself; `priority` takes the higher of the two.
    expect(map.get("p")!.ancestorPriority).toBe(Priority.Medium);
    expect(map.get("p")!.priority).toBe(Priority.High);
    expect(map.get("gc")!.subtreePriority).toBe(Priority.High);
  });

  it("ranks a task by the more urgent of its two directions", () => {
    const parent = makeTask({ id: "p", priority: Priority.Critical });
    const child = makeTask({ id: "c", parentId: "p", priority: Priority.Low });
    const grandchild = makeTask({ id: "gc", parentId: "c", priority: Priority.High });
    const byId = new Map([["p", parent], ["c", child], ["gc", grandchild]]);
    const map = computeEffectiveValues([parent, child, grandchild], byId);
    // The middle task is outranked from both sides: the roll-ups keep the two apart,
    // `priority` is simply the highest of the three.
    expect(map.get("c")!.ancestorPriority).toBe(Priority.Critical);
    expect(map.get("c")!.subtreePriority).toBe(Priority.High);
    expect(map.get("c")!.priority).toBe(Priority.Critical);
  });

  it("keeps subtreePriority at the task's own level when no subtask outranks it", () => {
    const parent = makeTask({ id: "p", priority: Priority.High });
    const child = makeTask({ id: "c", parentId: "p", priority: Priority.Low });
    const byId = new Map([["p", parent], ["c", child]]);
    const map = computeEffectiveValues([parent, child], byId);
    expect(map.get("p")!.subtreePriority).toBe(Priority.High);
  });

  it("ignores a done subtask and its own subtree, but not its siblings", () => {
    const parent = makeTask({ id: "p", priority: Priority.Low });
    const done = makeTask({ id: "d", parentId: "p", status: "done", priority: Priority.Critical });
    const underDone = makeTask({ id: "ud", parentId: "d", priority: Priority.Critical });
    const sibling = makeTask({ id: "s", parentId: "p", priority: Priority.High });
    const byId = new Map([["p", parent], ["d", done], ["ud", underDone], ["s", sibling]]);
    const map = computeEffectiveValues([parent, done, underDone, sibling], byId);
    expect(map.get("p")!.subtreePriority).toBe(Priority.High);
  });

  it("does not infinite-loop on a cyclical child chain", () => {
    const a = makeTask({ id: "a", parentId: "b" });
    const b = makeTask({ id: "b", parentId: "a" });
    const byId = new Map([["a", a], ["b", b]]);
    const map = computeEffectiveValues([a, b], byId);
    expect(map.get("a")!.subtreePriority).toBeUndefined();
  });
});

describe("bucketTasksByHorizon", () => {
  function bucket(entries: Array<[string, EffectiveValues]>) {
    const tasks = entries.map(([id]) => makeTask({ id }));
    return bucketTasksByHorizon(tasks, new Map(entries), offsetDay(0));
  }

  it("splits tasks into past, today, and later", () => {
    const horizons = bucket([
      ["past", ev(undefined, offsetDay(-2))],
      ["today", ev(undefined, offsetDay(0))],
      ["later", ev(undefined, offsetDay(3))],
    ]);
    expect(horizons.overdue.map((t) => t.id)).toEqual(["past"]);
    expect(horizons.current.map((t) => t.id)).toEqual(["today"]);
    expect(horizons.nextUp.map((t) => t.id)).toEqual(["later"]);
  });

  it("puts an undated task in next up, whatever its priority", () => {
    const horizons = bucket([["a", ev(Priority.Critical, undefined)]]);
    expect(horizons.nextUp.map((t) => t.id)).toEqual(["a"]);
  });

  it("sorts the dated buckets by due date, then by priority", () => {
    const horizons = bucket([
      ["older", ev(Priority.Low, offsetDay(-3))],
      ["recent-low", ev(Priority.Low, offsetDay(-1))],
      ["recent-high", ev(Priority.High, offsetDay(-1))],
    ]);
    expect(horizons.overdue.map((t) => t.id)).toEqual(["older", "recent-high", "recent-low"]);
  });

  it("sorts next up by the same deadline + priority score the priority queue uses", () => {
    const horizons = bucket([
      ["undated-critical", ev(Priority.Critical, undefined)],
      ["tomorrow-high", ev(Priority.High, offsetDay(1))],
      ["far-low", ev(Priority.Low, offsetDay(30))],
    ]);
    expect(horizons.nextUp.map((t) => t.id)).toEqual(["tomorrow-high", "undated-critical", "far-low"]);
  });

  it("treats a task the map has nothing for as undated", () => {
    const horizons = bucketTasksByHorizon([makeTask({ id: "orphan" })], new Map(), offsetDay(0));
    expect(horizons.nextUp.map((t) => t.id)).toEqual(["orphan"]);
  });
});

describe("selectCompletedOn", () => {
  it("keeps only what closed on that day", () => {
    const here = makeTask({ id: "here", status: "done", completed: timestamp("2026-07-01T14:30:00Z") });
    const eve = makeTask({ id: "eve", status: "done", completed: timestamp("2026-06-30T23:00:00Z") });
    const open = makeTask({ id: "open" });
    const result = selectCompletedOn([here, eve, open], day("2026-07-01"));
    expect(result.map((t) => t.id)).toEqual(["here"]);
  });

  it("drops a task still open under a stale timestamp, which its queues already hold", () => {
    const stale = makeTask({ id: "stale", status: "in-progress", completed: timestamp("2026-07-01T09:00:00Z") });
    expect(selectCompletedOn([stale], day("2026-07-01"))).toEqual([]);
  });

  it("drops a cancelled task, which kept the timestamp it had rather than earning one", () => {
    const dropped = makeTask({ id: "dropped", status: "cancelled", completed: timestamp("2026-07-01T09:00:00Z") });
    expect(selectCompletedOn([dropped], day("2026-07-01"))).toEqual([]);
  });

  it("reads the day the timestamp records, not the local one it falls on", () => {
    // A UTC-morning instant, which is the previous day west of Greenwich.
    const task = makeTask({ id: "a", status: "done", completed: timestamp("2026-07-01T00:30:00Z") });
    expect(selectCompletedOn([task], day("2026-07-01")).map((t) => t.id)).toEqual(["a"]);
  });

  it("drops a parent closed alongside a child of its own", () => {
    const parent = makeTask({ id: "parent", status: "done", completed: timestamp("2026-07-01T09:00:00Z") });
    const child = makeTask({
      id: "child", parentId: "parent", status: "done", completed: timestamp("2026-07-01T10:00:00Z"),
    });
    expect(selectCompletedOn([parent, child], day("2026-07-01")).map((t) => t.id)).toEqual(["child"]);
  });

  it("keeps a parent whose children closed on another day", () => {
    const parent = makeTask({ id: "parent", status: "done", completed: timestamp("2026-07-01T09:00:00Z") });
    const child = makeTask({
      id: "child", parentId: "parent", status: "done", completed: timestamp("2026-06-28T10:00:00Z"),
    });
    expect(selectCompletedOn([parent, child], day("2026-07-01")).map((t) => t.id)).toEqual(["parent"]);
  });

  it("orders them by the time they closed", () => {
    const late = makeTask({ id: "late", status: "done", completed: timestamp("2026-07-01T18:00:00Z") });
    const early = makeTask({ id: "early", status: "done", completed: timestamp("2026-07-01T08:00:00Z") });
    expect(selectCompletedOn([late, early], day("2026-07-01")).map((t) => t.id)).toEqual(["early", "late"]);
  });
});

describe("the week's own selections", () => {
  // Monday to Sunday, the week the Week tab shows.
  const WEEK = day("2026-06-29");

  it("keeps what closed inside the week and drops what closed either side of it", () => {
    const monday = makeTask({ id: "monday", status: "done", completed: timestamp("2026-06-29T09:00:00Z") });
    const sunday = makeTask({ id: "sunday", status: "done", completed: timestamp("2026-07-05T23:00:00Z") });
    const before = makeTask({ id: "before", status: "done", completed: timestamp("2026-06-28T12:00:00Z") });
    const after = makeTask({ id: "after", status: "done", completed: timestamp("2026-07-06T00:30:00Z") });

    expect(selectCompletedInWeek([monday, sunday, before, after], WEEK).map((t) => t.id))
      .toEqual(["monday", "sunday"]);
  });

  it("counts a week's closings by the rule a day is counted by: no stale timestamps, no parents closed with a child", () => {
    const stale = makeTask({ id: "stale", status: "in-progress", completed: timestamp("2026-06-30T09:00:00Z") });
    const parent = makeTask({ id: "parent", status: "done", completed: timestamp("2026-06-30T09:00:00Z") });
    const child = makeTask({
      id: "child", parentId: "parent", status: "done", completed: timestamp("2026-07-01T10:00:00Z"),
    });

    expect(selectCompletedInWeek([stale, parent, child], WEEK).map((t) => t.id)).toEqual(["child"]);
  });

  it("keeps what was written down that week, oldest first", () => {
    const later = makeTask({ id: "later", createdAt: timestamp("2026-07-02T08:00:00Z") });
    const first = makeTask({ id: "first", createdAt: timestamp("2026-06-29T08:00:00Z") });
    const old = makeTask({ id: "old", createdAt: timestamp("2026-06-01T08:00:00Z") });
    const undated = makeTask({ id: "undated" });

    expect(selectCreatedInWeek([later, first, old, undated], WEEK).map((t) => t.id)).toEqual(["first", "later"]);
  });

  it("keeps the tasks reading as a status, and drops one closed by the tree above it", () => {
    const going = makeTask({ id: "going", status: "in-progress" });
    const other = makeTask({ id: "other", status: "blocked" });
    const dropped = makeTask({ id: "dropped", status: "cancelled" });
    const underDropped = makeTask({ id: "under-dropped", parentId: "dropped", status: "in-progress" });

    expect(selectActiveWithStatus([going, other, dropped, underDropped], Status.InProgress).map((t) => t.id))
      .toEqual(["going"]);
  });
});

describe("selectUndatedTasks", () => {
  it("splits subtasks of one parent by the priority each carries itself", () => {
    const parent = makeTask({ id: "parent", priority: Priority.High });
    const high = makeTask({ id: "high", parentId: "parent", priority: Priority.High });
    const medium = makeTask({ id: "medium", parentId: "parent", priority: Priority.Medium });
    const unset = makeTask({ id: "unset", parentId: "parent" });
    const { tasks } = selectUndatedTasks([parent, unset, medium, high]);
    expect(tasks.map((t) => t.id)).toEqual(["high", "medium", "unset"]);
  });

  it("never lets an own priority carry a task past an inherited level", () => {
    const criticalParent = makeTask({ id: "critical-parent", priority: Priority.Critical });
    const unset = makeTask({ id: "under-critical", parentId: "critical-parent" });
    const highParent = makeTask({ id: "high-parent", priority: Priority.High });
    const own = makeTask({ id: "under-high", parentId: "high-parent", priority: Priority.High });
    const { tasks } = selectUndatedTasks([highParent, own, criticalParent, unset]);
    expect(tasks.map((t) => t.id)).toEqual(["under-critical", "under-high"]);
  });

  it("takes a task nothing prioritises, below every judged one and in the order read", () => {
    const untriaged = makeTask({ id: "untriaged" });
    const alsoUntriaged = makeTask({ id: "also-untriaged" });
    const low = makeTask({ id: "low", priority: Priority.Low });
    const { tasks } = selectUndatedTasks([untriaged, low, alsoUntriaged]);
    expect(tasks.map((t) => t.id)).toEqual(["low", "untriaged", "also-untriaged"]);
  });

  it("leaves out a task a deadline places, prioritised or not", () => {
    const dated = makeTask({ id: "dated", due: new Date(2026, 7, 20) });
    const untriagedDated = makeTask({ id: "untriaged-dated", due: new Date(2026, 7, 20), priority: Priority.None });
    const { tasks } = selectUndatedTasks([dated, untriagedDated]);
    expect(tasks).toEqual([]);
  });
});

describe("selectPriorityQueue", () => {
  it("excludes a task nothing dates — the Inbox is where that one waits", () => {
    const undated = makeTask({ id: "a" });
    const prioritized = makeTask({ id: "b" });
    const evMap = new Map<string, EffectiveValues>([
      ["a", ev(undefined, undefined)],
      ["b", ev(Priority.Critical, undefined)],
    ]);
    expect(selectPriorityQueue([undated, prioritized], evMap, new Set(), offsetDay(0))).toEqual([]);
  });

  it("excludes parent tasks", () => {
    const parent = makeTask({ id: "parent", priority: Priority.High });
    const kept = makeTask({ id: "kept", priority: Priority.High });
    const due = offsetDay(2);
    const evMap = new Map<string, EffectiveValues>([
      ["parent", ev(Priority.High, due)],
      ["kept", ev(Priority.High, due)],
    ]);
    const result = selectPriorityQueue([parent, kept], evMap, new Set(["parent"]), offsetDay(0));
    expect(result.map((t: ProjectTask) => t.id)).toEqual(["kept"]);
  });

  it("puts the overdue tasks at the head, deepest overdue outranked by nothing else", () => {
    const overdue = makeTask({ id: "overdue" });
    const dueToday = makeTask({ id: "today", priority: Priority.Critical });
    const dueInAWeek = makeTask({ id: "week", priority: Priority.Critical });
    const evMap = new Map<string, EffectiveValues>([
      ["overdue", ev(undefined, offsetDay(-3))],
      ["today", ev(Priority.Critical, offsetDay(0))],
      ["week", ev(Priority.Critical, offsetDay(7))],
    ]);
    const result = selectPriorityQueue([dueInAWeek, dueToday, overdue], evMap, new Set(), offsetDay(0));
    expect(result.map((t: ProjectTask) => t.id)).toEqual(["overdue", "today", "week"]);
  });

  it("ranks against the day on show, not the real today", () => {
    const soon = makeTask({ id: "soon" });
    const laterButUrgent = makeTask({ id: "later", priority: Priority.High });
    const evMap = new Map<string, EffectiveValues>([
      ["soon", ev(undefined, offsetDay(3))],
      ["later", ev(Priority.High, offsetDay(8))],
    ]);
    const tasks = [soon, laterButUrgent];
    // From today, "later" is far enough out that its priority carries it past "soon".
    expect(selectPriorityQueue(tasks, evMap, new Set(), offsetDay(0)).map((t: ProjectTask) => t.id))
      .toEqual(["later", "soon"]);
    // Six days on, "soon" is overdue and heads the queue — the order the day on show gives.
    expect(selectPriorityQueue(tasks, evMap, new Set(), offsetDay(6)).map((t: ProjectTask) => t.id))
      .toEqual(["soon", "later"]);
  });

  it("sorts by combined deadline + priority score descending, treating a missing priority as zero", () => {
    const farHighPriority = makeTask({ id: "far" });
    const overdueNoPriority = makeTask({ id: "ds" });
    const both = makeTask({ id: "both" });
    const evMap = new Map<string, EffectiveValues>([
      ["far", ev(Priority.Critical, offsetDay(30))], // 5 points + 400
      ["ds", ev(undefined, offsetDay(-1))], // overdue: 1000 points
      ["both", ev(Priority.Low, offsetDay(-1))],
    ]);
    // Three different priority/due combinations, to take the comparator through every
    // direction of its `priority ?? ""` / `deadlinePoints` fallbacks.
    const result = selectPriorityQueue(
      [farHighPriority, overdueNoPriority, both],
      evMap,
      new Set(),
      offsetDay(0),
    );
    expect(result.map((t) => t.id)).toEqual(["both", "ds", "far"]);
  });

  it("breaks a tie in inherited priority by the level each task rolls up from below", () => {
    const due = offsetDay(2);
    const unset = makeTask({ id: "unset" });
    const medium = makeTask({ id: "medium", priority: Priority.Medium });
    const high = makeTask({ id: "high", priority: Priority.High });
    // All three read as high — under one high parent, say. None has children, so the
    // level each rolls up from below is the one it carries itself.
    const evMap = new Map<string, EffectiveValues>(
      // `?? None` rather than `?? undefined`: passing undefined would fall back to the
      // parameter default, which is the level in force — the opposite of "carries nothing".
      [unset, medium, high].map((t) => [t.id, ev(Priority.High, due, t.priority ?? Priority.None)]),
    );
    const result = selectPriorityQueue([unset, medium, high], evMap, new Set(), offsetDay(0));
    expect(result.map((t) => t.id)).toEqual(["high", "medium", "unset"]);
  });

  it("lifts a task whose children are urgent above a sibling that carries more itself", () => {
    const due = offsetDay(2);
    // Both sit under one high parent and so both read as high. `busy` carries less than
    // `quiet` does, but holds high work below it — which is what settles the tie.
    const busy = makeTask({ id: "busy", priority: Priority.Low });
    const quiet = makeTask({ id: "quiet", priority: Priority.Medium });
    const evMap = new Map<string, EffectiveValues>([
      ["busy", ev(Priority.High, due, Priority.High)],
      ["quiet", ev(Priority.High, due, Priority.Medium)],
    ]);
    const result = selectPriorityQueue([quiet, busy], evMap, new Set(), offsetDay(0));
    expect(result.map((t) => t.id)).toEqual(["busy", "quiet"]);
  });

  it("keeps every dated task — the merged horizons are cut from this one queue", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => makeTask({ id: `t${i}`, priority: Priority.Low }));
    const evMap = new Map<string, EffectiveValues>(tasks.map((t) => [t.id, ev(Priority.Low, offsetDay(3))]));
    expect(selectPriorityQueue(tasks, evMap, new Set(), offsetDay(0))).toHaveLength(40);
  });
});
