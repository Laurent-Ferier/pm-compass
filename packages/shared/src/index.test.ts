import { describe, it, expect } from "vitest";
import {
  addDependencyToTask,
  removeDependencyFromTask,
  isValidDependencyTarget,
  type Task,
} from "./index";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    projectId: "proj-1",
    parentId: undefined,
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  };
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
});
