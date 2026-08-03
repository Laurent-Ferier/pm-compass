import { describe, it, expect } from "vitest";
import { addDependencyToTask, removeDependencyFromTask, isValidDependencyTarget, isValidMoveTarget, Task, type TaskFields, type MoveTargetCheck } from "./task";
import { day } from "../__testing__/dates";

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

function invalidMove(check: MoveTargetCheck): Extract<MoveTargetCheck, { valid: false }> {
  if (check.valid) throw new Error("expected an invalid move target");
  return check;
}

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

  it("accepts tasks at different levels of one project", () => {
    // A graph lifts each end to the card standing for it, so depth is no bar: "t3" sits
    // under "t2" here, which is nothing to do with "t2"'s own sibling.
    expect(isValidDependencyTarget(tasks, "t2", "t3")).toEqual({ valid: true });
  });

  it("rejects a task and its own subtask, either way round", () => {
    // Both ends would lift onto one card at every level, so the link is undrawable.
    for (const pair of [["t1", "t3"], ["t3", "t1"]]) {
      const result = isValidDependencyTarget(tasks, pair[0], pair[1]);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/subtask/i);
    }
  });

  it("rejects a task and a grandchild of it", () => {
    const deep = [...tasks, makeTask({ id: "t6", projectId: "proj-1", parentId: "t3", dependencies: [] })];
    expect(isValidDependencyTarget(deep, "t1", "t6").valid).toBe(false);
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
    expect(makeTask({ id: "a", due: day("2026-07-09") }).plannedDate).toEqual(day("2026-07-09"));
  });

  it("has no date without one — an inherited deadline is computeEffectiveValues' business", () => {
    expect(makeTask({ id: "a", parentId: "p" }).plannedDate).toBeUndefined();
  });
});
