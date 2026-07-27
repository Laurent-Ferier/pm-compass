import { describe, it, expect } from "vitest";
import {
  addDependencyToTask,
  removeDependencyFromTask,
  isValidDependencyTarget,
  isValidMoveTarget,
  collectDescendants,
  isTask,
  buildChildMap,
  walkTree,
  hasOpenDescendants,
  hasCancelledAncestor,
  effectiveStatus,
  isEffectivelyClosed,
  isCompletedWithOpenSubtasks,
  isOpenUnderCompletedParent,
  Task,
  type TaskFields,
  type Project,
} from "./shared";
import type { MoveTargetCheck } from "./shared";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
  return new Task({
    title: overrides.id,
    projectId: "proj-1",
    parentId: undefined,
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  });
}

// ── isTask ───────────────────────────────────────────────────────────────────

describe("isTask", () => {
  it("returns true for an object that has projectId (Task)", () => {
    const task = makeTask({ id: "t1" });
    expect(isTask(task)).toBe(true);
  });

  it("returns false for an object that has no projectId (Project)", () => {
    const project: Project = {
      id: "p1",
      title: "My project",
      tasks: [],
      filePath: "Projects/p1.md",
    };
    expect(isTask(project)).toBe(false);
  });
});

// ── buildChildMap ─────────────────────────────────────────────────────────────

describe("buildChildMap", () => {
  it("returns an empty map for an empty task list", () => {
    expect(buildChildMap([]).size).toBe(0);
  });

  it("groups top-level tasks (no parentId) under the undefined key", () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" })];
    const map = buildChildMap(tasks);
    expect(map.get(undefined)).toHaveLength(2);
  });

  it("groups children under their parentId", () => {
    const tasks = [
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", parentId: "t1" }),
      makeTask({ id: "t3", parentId: "t1" }),
    ];
    const map = buildChildMap(tasks);
    expect(map.get("t1")).toHaveLength(2);
    expect(map.get(undefined)).toHaveLength(1);
  });

  it("does not create an entry for a task that has no children", () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2", parentId: "t1" })];
    const map = buildChildMap(tasks);
    expect(map.has("t2")).toBe(false);
  });

  it("handles multiple distinct parent keys independently", () => {
    const tasks = [
      makeTask({ id: "c1", parentId: "p1" }),
      makeTask({ id: "c2", parentId: "p2" }),
      makeTask({ id: "c3", parentId: "p2" }),
    ];
    const map = buildChildMap(tasks);
    expect(map.get("p1")).toHaveLength(1);
    expect(map.get("p2")).toHaveLength(2);
    expect(map.has(undefined)).toBe(false);
  });
});

// ── addDependencyToTask ───────────────────────────────────────────────────────

describe("addDependencyToTask", () => {
  it("adds an id to an empty array", () => {
    expect(addDependencyToTask([], "a")).toEqual(["a"]);
  });

  it("appends to a non-empty array", () => {
    expect(addDependencyToTask(["a"], "b")).toEqual(["a", "b"]);
  });

  it("is idempotent: adding the same id twice yields the same result as once", () => {
    const once = addDependencyToTask([], "a");
    const twice = addDependencyToTask(once, "a");
    expect(twice).toEqual(["a"]);
  });

  it("does not mutate the input array", () => {
    const original = ["a"];
    addDependencyToTask(original, "b");
    expect(original).toEqual(["a"]);
  });
});

// ── removeDependencyFromTask ──────────────────────────────────────────────────

describe("removeDependencyFromTask", () => {
  it("removes an existing id", () => {
    expect(removeDependencyFromTask(["a", "b"], "a")).toEqual(["b"]);
  });

  it("returns an empty array when the last id is removed", () => {
    expect(removeDependencyFromTask(["a"], "a")).toEqual([]);
  });

  it("is idempotent: removing an absent id is a no-op", () => {
    const deps = ["a", "b"];
    expect(removeDependencyFromTask(deps, "x")).toEqual(["a", "b"]);
    // calling a second time also changes nothing
    expect(removeDependencyFromTask(removeDependencyFromTask(deps, "x"), "x")).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const original = ["a", "b"];
    removeDependencyFromTask(original, "a");
    expect(original).toEqual(["a", "b"]);
  });
});

// ── isValidDependencyTarget ───────────────────────────────────────────────────

describe("isValidDependencyTarget", () => {
  const tasks = [
    makeTask({ id: "t1", projectId: "proj-1", parentId: undefined, dependencies: [] }),
    makeTask({ id: "t2", projectId: "proj-1", parentId: undefined, dependencies: [] }),
    makeTask({ id: "t3", projectId: "proj-1", parentId: "t1",      dependencies: [] }),
    makeTask({ id: "t4", projectId: "proj-2", parentId: undefined, dependencies: [] }),
    makeTask({ id: "t5", projectId: "proj-1", parentId: undefined, dependencies: ["t2"] }),
  ];

  it("returns valid for a legal dependency", () => {
    expect(isValidDependencyTarget(tasks, "t1", "t2")).toEqual({ valid: true });
  });

  it("rejects a self-dependency", () => {
    const result = isValidDependencyTarget(tasks, "t1", "t1");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/itself/i);
  });

  it("rejects tasks at different hierarchy levels (different parentId)", () => {
    const result = isValidDependencyTarget(tasks, "t1", "t3");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/level/i);
  });

  it("rejects tasks in different projects", () => {
    const result = isValidDependencyTarget(tasks, "t1", "t4");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/project/i);
  });

  it("rejects when the dependency already exists", () => {
    // t5.dependencies already includes t2
    const result = isValidDependencyTarget(tasks, "t2", "t5");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/already/i);
  });

  it("rejects when it would create a direct cycle (source already depends on target)", () => {
    // t5 depends on t2; adding t5 as a dependency of t2 would cycle
    const result = isValidDependencyTarget(tasks, "t5", "t2");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/cycle/i);
  });

  it("rejects transitive cycles (A→B→C, then trying C→A)", () => {
    const chain = [
      makeTask({ id: "a", dependencies: [] }),
      makeTask({ id: "b", dependencies: ["a"] }),
      makeTask({ id: "c", dependencies: ["b"] }),
    ];
    // Adding a→c would close the cycle a→c→b→a... wait: we want sourceId=c, targetId=a
    // meaning target a gains dep on c, and c already transitively depends on a via b
    const result = isValidDependencyTarget(chain, "c", "a");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/cycle/i);
  });

  it("rejects when either task is not found", () => {
    const result = isValidDependencyTarget(tasks, "t1", "nonexistent");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it("handles a diamond-shaped dependency graph (revisited node) and a dangling dependency reference", () => {
    // s -> b, c; b -> d; c -> d; d -> "ghost" (not present in the task list).
    // "d" is reached via both b and c, exercising the visited/continue branch,
    // and "ghost" exercises the taskById lookup miss (?? []) branch.
    const diamond = [
      makeTask({ id: "s", dependencies: ["b", "c"] }),
      makeTask({ id: "b", dependencies: ["d"] }),
      makeTask({ id: "c", dependencies: ["d"] }),
      makeTask({ id: "d", dependencies: ["ghost"] }),
      makeTask({ id: "e", dependencies: [] }),
    ];
    const result = isValidDependencyTarget(diamond, "s", "e");
    expect(result).toEqual({ valid: true });
  });
});

// ── collectDescendants ───────────────────────────────────────────────────────

describe("collectDescendants", () => {
  const tree = [
    makeTask({ id: "root" }),
    makeTask({ id: "a", parentId: "root" }),
    makeTask({ id: "b", parentId: "root" }),
    makeTask({ id: "a1", parentId: "a" }),
    makeTask({ id: "unrelated" }),
  ];

  it("collects the whole subtree, excluding the task itself", () => {
    expect(collectDescendants(tree, "root").sort()).toEqual(["a", "a1", "b"]);
  });

  it("returns an empty array for a leaf", () => {
    expect(collectDescendants(tree, "a1")).toEqual([]);
  });

  it("terminates on a malformed parentId cycle", () => {
    // Nothing in the vault format prevents this, so the walk must not hang.
    const cyclic = [
      makeTask({ id: "x", parentId: "y" }),
      makeTask({ id: "y", parentId: "x" }),
    ];
    expect(collectDescendants(cyclic, "x")).toEqual(["y"]);
  });
});

// ── walkTree ──────────────────────────────────────────────────────────────────

describe("walkTree", () => {
  //     a
  //    / \
  //   b   c
  //   |
  //   d
  const tree = [
    makeTask({ id: "a" }),
    makeTask({ id: "b", parentId: "a" }),
    makeTask({ id: "c", parentId: "a" }),
    makeTask({ id: "d", parentId: "b" }),
  ];
  const childMap = buildChildMap(tree);
  const next = (id: string) => childMap.get(id) ?? [];

  it("visits every neighbour but not the start node", () => {
    const seen: string[] = [];
    walkTree("a", next, (t) => { seen.push(t.id); });
    expect(seen.sort()).toEqual(["b", "c", "d"]);
  });

  it("'stop' halts the entire walk", () => {
    const seen: string[] = [];
    walkTree("a", next, (t) => { seen.push(t.id); return t.id === "b" || t.id === "c" ? "stop" : undefined; });
    // Stops on the first of b/c reached (BFS order), before descending to d.
    expect(seen).not.toContain("d");
  });

  it("'prune' skips a node's neighbours but keeps walking siblings", () => {
    const seen: string[] = [];
    walkTree("a", next, (t) => { seen.push(t.id); return t.id === "b" ? "prune" : undefined; });
    // b is visited but not expanded, so d is never reached; c still is.
    expect(seen.sort()).toEqual(["b", "c"]);
  });

  it("guards against cycles via the visited set", () => {
    const cyclic = buildChildMap([
      makeTask({ id: "x", parentId: "y" }),
      makeTask({ id: "y", parentId: "x" }),
    ]);
    const seen: string[] = [];
    walkTree("x", (id) => cyclic.get(id) ?? [], (t) => { seen.push(t.id); });
    expect(seen).toEqual(["y"]);
  });
});

// ── cancellation down the tree ────────────────────────────────────────────────

describe("effectiveStatus", () => {
  // "deep" sits two levels under a cancelled task; "sibling" is nowhere near one.
  const tasks = [
    makeTask({ id: "called-off", status: "cancelled" }),
    makeTask({ id: "child", parentId: "called-off", status: "in-progress" }),
    makeTask({ id: "deep", parentId: "child", status: "todo" }),
    makeTask({ id: "done-parent", status: "done" }),
    makeTask({ id: "sibling", parentId: "done-parent", status: "todo" }),
  ];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  it("reads a task under a cancelled one as cancelled, at any depth", () => {
    expect(effectiveStatus(byId.get("child")!, byId)).toBe("cancelled");
    expect(effectiveStatus(byId.get("deep")!, byId)).toBe("cancelled");
  });

  it("leaves the task's own status alone everywhere else", () => {
    expect(effectiveStatus(byId.get("called-off")!, byId)).toBe("cancelled");
    expect(effectiveStatus(byId.get("sibling")!, byId)).toBe("todo");
    expect(hasCancelledAncestor(byId.get("sibling")!, byId)).toBe(false);
  });

  it("counts a task under a cancelled one as closed", () => {
    expect(isEffectivelyClosed(byId.get("deep")!, byId)).toBe(true);
    expect(isEffectivelyClosed(byId.get("sibling")!, byId)).toBe(false);
  });

  it("does not rewrite the task's own stored status", () => {
    expect(byId.get("child")!.status).toBe("in-progress");
  });
});

// ── hasOpenDescendants / isCompletedWithOpenSubtasks ──────────────────────────

describe("hasOpenDescendants", () => {
  it("is true when a deep descendant is still open", () => {
    const map = buildChildMap([
      makeTask({ id: "root", status: "done" }),
      makeTask({ id: "mid", parentId: "root", status: "done" }),
      makeTask({ id: "leaf", parentId: "mid", status: "todo" }),
    ]);
    expect(hasOpenDescendants(map, "root")).toBe(true);
  });

  it("is false when the whole subtree is done or cancelled", () => {
    const map = buildChildMap([
      makeTask({ id: "root", status: "done" }),
      makeTask({ id: "a", parentId: "root", status: "done" }),
      makeTask({ id: "b", parentId: "root", status: "cancelled" }),
    ]);
    expect(hasOpenDescendants(map, "root")).toBe(false);
  });

  it("is false when the only open work sits under a cancelled task", () => {
    const map = buildChildMap([
      makeTask({ id: "root", status: "done" }),
      makeTask({ id: "mid", parentId: "root", status: "cancelled" }),
      makeTask({ id: "leaf", parentId: "mid", status: "todo" }),
    ]);
    expect(hasOpenDescendants(map, "root")).toBe(false);
  });

  it("is false for a leaf with no descendants", () => {
    const map = buildChildMap([makeTask({ id: "solo", status: "done" })]);
    expect(hasOpenDescendants(map, "solo")).toBe(false);
  });
});

describe("isCompletedWithOpenSubtasks", () => {
  const tasks = [
    makeTask({ id: "done-open", status: "done" }),
    makeTask({ id: "child", parentId: "done-open", status: "in-progress" }),
    makeTask({ id: "cancelled-open", status: "cancelled" }),
    makeTask({ id: "child2", parentId: "cancelled-open", status: "todo" }),
    makeTask({ id: "done-clean", status: "done" }),
    makeTask({ id: "child3", parentId: "done-clean", status: "cancelled" }),
    makeTask({ id: "active-parent", status: "in-progress" }),
    makeTask({ id: "child4", parentId: "active-parent", status: "todo" }),
    // A done task two levels under a cancelled one, itself hiding open work.
    makeTask({ id: "done-under-cancelled", parentId: "child2", status: "done" }),
    makeTask({ id: "child5", parentId: "done-under-cancelled", status: "todo" }),
  ];
  const map = buildChildMap(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  it("warns when a done task has an unfinished child", () => {
    expect(isCompletedWithOpenSubtasks(byId.get("done-open")!, map, byId)).toBe(true);
  });

  it("does not warn when a cancelled task has an unfinished child (it is cancelled too)", () => {
    expect(isCompletedWithOpenSubtasks(byId.get("cancelled-open")!, map, byId)).toBe(false);
  });

  it("does not warn a done task under a cancelled ancestor, as its child side doesn't either", () => {
    const task = byId.get("done-under-cancelled")!;
    expect(isCompletedWithOpenSubtasks(task, map, byId)).toBe(false);
    expect(isOpenUnderCompletedParent(byId.get("child5")!, byId)).toBe(false);
  });

  it("does not warn when the subtree is fully resolved", () => {
    expect(isCompletedWithOpenSubtasks(byId.get("done-clean")!, map, byId)).toBe(false);
  });

  it("does not warn when the parent itself is still active", () => {
    expect(isCompletedWithOpenSubtasks(byId.get("active-parent")!, map, byId)).toBe(false);
  });
});

describe("isOpenUnderCompletedParent", () => {
  const tasks = [
    makeTask({ id: "done-parent", status: "done" }),
    makeTask({ id: "open-child", parentId: "done-parent", status: "todo" }),
    makeTask({ id: "cancelled-parent", status: "cancelled" }),
    makeTask({ id: "open-child2", parentId: "cancelled-parent", status: "in-progress" }),
    makeTask({ id: "done-child", parentId: "done-parent", status: "done" }),
    makeTask({ id: "active-parent", status: "in-progress" }),
    makeTask({ id: "open-child3", parentId: "active-parent", status: "todo" }),
    makeTask({ id: "root-open", status: "todo" }),
  ];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  it("warns an open child of a done parent", () => {
    expect(isOpenUnderCompletedParent(byId.get("open-child")!, byId)).toBe(true);
  });

  it("does not warn an open child of a cancelled parent — it is cancelled with it", () => {
    expect(isOpenUnderCompletedParent(byId.get("open-child2")!, byId)).toBe(false);
  });

  it("does not warn a child that is itself done", () => {
    expect(isOpenUnderCompletedParent(byId.get("done-child")!, byId)).toBe(false);
  });

  it("does not warn when the parent is still active", () => {
    expect(isOpenUnderCompletedParent(byId.get("open-child3")!, byId)).toBe(false);
  });

  it("does not warn a task with no parent", () => {
    expect(isOpenUnderCompletedParent(byId.get("root-open")!, byId)).toBe(false);
  });
});

// ── isValidMoveTarget ────────────────────────────────────────────────────────

/** Asserts a move check failed and narrows it, so the `reason` on the invalid branch
 *  of `MoveTargetCheck` is reachable — `expect(r.valid).toBe(false)` does not narrow. */
function invalidMove(check: MoveTargetCheck): Extract<MoveTargetCheck, { valid: false }> {
  if (check.valid) throw new Error("expected an invalid move target");
  return check;
}

describe("isValidMoveTarget", () => {
  // parent -> kid -> grand, all in proj-1; "other" is a second root task.
  const tasks = [
    makeTask({ id: "parent" }),
    makeTask({ id: "kid", parentId: "parent" }),
    makeTask({ id: "grand", parentId: "kid" }),
    makeTask({ id: "other" }),
    makeTask({ id: "far", projectId: "proj-2" }),
  ];

  it("allows reparenting under an unrelated task in the same project", () => {
    expect(isValidMoveTarget(tasks, "other", { projectId: "proj-1", parentTaskId: "parent" }))
      .toEqual({ valid: true });
  });

  it("allows moving a nested task to the project root", () => {
    expect(isValidMoveTarget(tasks, "kid", { projectId: "proj-1" })).toEqual({ valid: true });
  });

  it("allows moving to another project's root", () => {
    expect(isValidMoveTarget(tasks, "parent", { projectId: "proj-2" })).toEqual({ valid: true });
  });

  it("rejects moving a task under itself", () => {
    const r = invalidMove(isValidMoveTarget(tasks, "parent", { projectId: "proj-1", parentTaskId: "parent" }));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/under itself/i);
  });

  it("rejects moving a task under its direct child", () => {
    const r = invalidMove(isValidMoveTarget(tasks, "parent", { projectId: "proj-1", parentTaskId: "kid" }));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/own subtask/i);
  });

  it("rejects moving a task under a deeper descendant", () => {
    const r = invalidMove(isValidMoveTarget(tasks, "parent", { projectId: "proj-1", parentTaskId: "grand" }));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/own subtask/i);
  });

  it("rejects a parent that lives in a different project than the destination", () => {
    const r = invalidMove(isValidMoveTarget(tasks, "other", { projectId: "proj-2", parentTaskId: "parent" }));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not in the destination project/i);
  });

  it("rejects an unknown task", () => {
    const r = invalidMove(isValidMoveTarget(tasks, "ghost", { projectId: "proj-1" }));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/task not found/i);
  });

  it("rejects an unknown parent", () => {
    const r = invalidMove(isValidMoveTarget(tasks, "other", { projectId: "proj-1", parentTaskId: "ghost" }));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/parent task not found/i);
  });

  it("rejects the task's current location, so pickers can grey it out", () => {
    const atRoot = isValidMoveTarget(tasks, "other", { projectId: "proj-1" });
    expect(atRoot).toEqual({ valid: false, issue: "already-here", reason: "Task is already here" });

    const nested = isValidMoveTarget(tasks, "kid", { projectId: "proj-1", parentTaskId: "parent" });
    expect(nested).toEqual({ valid: false, issue: "already-here", reason: "Task is already here" });
  });

  it("terminates on a malformed parentId cycle among ancestors", () => {
    const cyclic = [
      makeTask({ id: "m" }),
      makeTask({ id: "x", parentId: "y" }),
      makeTask({ id: "y", parentId: "x" }),
    ];
    expect(isValidMoveTarget(cyclic, "m", { projectId: "proj-1", parentTaskId: "x" }))
      .toEqual({ valid: true });
  });
});

describe("Task as a BaseTask", () => {
  it("is dated by its own deadline", () => {
    expect(makeTask({ id: "a", due: "2026-07-09" }).plannedDate).toBe("2026-07-09");
  });

  it("has no date without one — an inherited deadline is computeEffectiveValues' business", () => {
    expect(makeTask({ id: "a", parentId: "p" }).plannedDate).toBeUndefined();
  });
});
