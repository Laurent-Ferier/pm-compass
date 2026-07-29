import { describe, it, expect } from "vitest";
import { Task, type TaskFields } from "./task";
import { collectDescendants, buildChildMap, walkTree, hasOpenDescendants, hasCancelledAncestor, effectiveStatus, isEffectivelyClosed, isCompletedWithOpenSubtasks, isOpenUnderCompletedParent, WalkAction } from "./task-tree";

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
    walkTree("a", next, (t) => { seen.push(t.id); return t.id === "b" || t.id === "c" ? WalkAction.Stop : undefined; });
    // Stops on the first of b/c reached (BFS order), before descending to d.
    expect(seen).not.toContain("d");
  });

  it("'prune' skips a node's neighbours but keeps walking siblings", () => {
    const seen: string[] = [];
    walkTree("a", next, (t) => { seen.push(t.id); return t.id === "b" ? WalkAction.Prune : undefined; });
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
