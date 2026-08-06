import { describe, it, expect } from "vitest";
import { Task, type TaskFields } from "./task";
import { DependencyKind, ExternalEnd, liftDependencies } from "./dependency-graph";
import { newTask, withFields } from "../__testing__/notes";

function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
  return newTask({
    title: overrides.id,
    projectId: "proj-1",
    status: "todo",
    dependencies: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  });
}

/** `a` and `b` at the root, each with one child, plus a grandchild under `a1`. */
function tree(): Task[] {
  return [
    makeTask({ id: "a" }),
    makeTask({ id: "b" }),
    makeTask({ id: "a1", parentId: "a" }),
    makeTask({ id: "a2", parentId: "a" }),
    makeTask({ id: "b1", parentId: "b" }),
    makeTask({ id: "a1x", parentId: "a1" }),
  ];
}

describe("liftDependencies", () => {
  it("returns nothing when no task depends on another", () => {
    expect(liftDependencies(tree(), ["a", "b"])).toEqual([]);
  });

  it("reads a dependency between two visible tasks as direct", () => {
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a"] }) : t));

    expect(liftDependencies(tasks, ["a", "b"])).toEqual([
      {
        sourceId: "a",
        targetId: "b",
        kind: DependencyKind.Direct,
        external: ExternalEnd.None,
        origins: [{ dependentId: "b", prerequisiteId: "a" }],
      },
    ]);
  });

  it("points the edge from the prerequisite to the task waiting on it", () => {
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a"] }) : t));
    const [edge] = liftDependencies(tasks, ["a", "b"]);

    expect([edge.sourceId, edge.targetId]).toEqual(["a", "b"]);
  });

  it("lifts a child's dependency onto its parent's card", () => {
    // a1 waits on b: at the root, that is "a waits on b".
    const tasks = tree().map((t) => (t.id === "a1" ? withFields(t, { dependencies: ["b"] }) : t));

    expect(liftDependencies(tasks, ["a", "b"])).toEqual([
      {
        sourceId: "b",
        targetId: "a",
        kind: DependencyKind.Indirect,
        external: ExternalEnd.None,
        origins: [{ dependentId: "a1", prerequisiteId: "b" }],
      },
    ]);
  });

  it("lifts through several levels, to the nearest visible ancestor", () => {
    const tasks = tree().map((t) => (t.id === "a1x" ? withFields(t, { dependencies: ["b1"] }) : t));

    expect(liftDependencies(tasks, ["a", "b"])).toMatchObject([
      { sourceId: "b", targetId: "a", kind: DependencyKind.Indirect },
    ]);
    // Drilled into `a`, the nearest visible ancestor of a1x is a1 — and b1, having none,
    // stands for itself as a prerequisite from outside.
    expect(liftDependencies(tasks, ["a1", "a2"])).toMatchObject([
      { sourceId: "b1", targetId: "a1", external: ExternalEnd.Prerequisite },
    ]);
  });

  it("drops a dependency whose two ends lift onto the same card", () => {
    const tasks = tree().map((t) => (t.id === "a1x" ? withFields(t, { dependencies: ["a2"] }) : t));

    expect(liftDependencies(tasks, ["a", "b"])).toEqual([]);
    // One level down, the two ends are cards of their own again.
    expect(liftDependencies(tasks, ["a1", "a2"])).toMatchObject([
      { sourceId: "a2", targetId: "a1", kind: DependencyKind.Indirect },
    ]);
  });

  it("keeps a prerequisite from outside the level, named as itself", () => {
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a"] }) : t));

    expect(liftDependencies(tasks, ["b"])).toEqual([
      {
        sourceId: "a",
        targetId: "b",
        kind: DependencyKind.Direct,
        external: ExternalEnd.Prerequisite,
        origins: [{ dependentId: "b", prerequisiteId: "a" }],
      },
    ]);
  });

  it("names the prerequisite itself, however deep outside the level it sits", () => {
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a1x"] }) : t));

    expect(liftDependencies(tasks, ["b"])).toMatchObject([
      { sourceId: "a1x", targetId: "b", external: ExternalEnd.Prerequisite },
    ]);
  });

  it("keeps a task waiting from outside the level, named as itself", () => {
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a"] }) : t));

    expect(liftDependencies(tasks, ["a"])).toEqual([
      {
        sourceId: "a",
        targetId: "b",
        kind: DependencyKind.Direct,
        external: ExternalEnd.Dependent,
        origins: [{ dependentId: "b", prerequisiteId: "a" }],
      },
    ]);
  });

  it("names the waiting task itself, however deep outside the level it sits", () => {
    const tasks = tree().map((t) => (t.id === "a1x" ? withFields(t, { dependencies: ["b"] }) : t));

    expect(liftDependencies(tasks, ["b"])).toMatchObject([
      { sourceId: "b", targetId: "a1x", external: ExternalEnd.Dependent },
    ]);
  });

  it("lifts the prerequisite onto its card while the waiting end stays outside", () => {
    // b1 waits on a1x: drawn at the root level of `a`, that is "a is waited on by b1".
    const tasks = tree().map((t) => (t.id === "b1" ? withFields(t, { dependencies: ["a1x"] }) : t));

    expect(liftDependencies(tasks, ["a"])).toMatchObject([
      { sourceId: "a", targetId: "b1", kind: DependencyKind.Indirect, external: ExternalEnd.Dependent },
    ]);
  });

  it("drops a dependency with neither of its ends on the level", () => {
    const tasks = tree().map((t) => (t.id === "b1" ? withFields(t, { dependencies: ["a1x"] }) : t));

    expect(liftDependencies(tasks, ["a2"])).toEqual([]);
  });

  it("brings one waiting task in once per card it waits on", () => {
    const tasks = tree().map((t) =>
      t.id === "b" ? withFields(t, { dependencies: ["a1", "a2"] }) : t);

    expect(liftDependencies(tasks, ["a1", "a2"])).toMatchObject([
      { sourceId: "a1", targetId: "b", external: ExternalEnd.Dependent },
      { sourceId: "a2", targetId: "b", external: ExternalEnd.Dependent },
    ]);
  });

  it("brings one prerequisite in once per card waiting on it", () => {
    const tasks = tree().map((t) =>
      t.id === "a1" || t.id === "a2" ? withFields(t, { dependencies: ["b"] }) : t);

    expect(liftDependencies(tasks, ["a1", "a2"])).toMatchObject([
      { sourceId: "b", targetId: "a1", external: ExternalEnd.Prerequisite },
      { sourceId: "b", targetId: "a2", external: ExternalEnd.Prerequisite },
    ]);
  });

  it("drops a dependency on a task that isn't there at all", () => {
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["gone"] }) : t));

    expect(liftDependencies(tasks, ["a", "b"])).toEqual([]);
  });

  it("merges the dependencies lifting onto one pair of cards", () => {
    const tasks = tree().map((t) => {
      if (t.id === "a1") return withFields(t, { dependencies: ["b"] });
      if (t.id === "a2") return withFields(t, { dependencies: ["b1"] });
      return t;
    });

    const edges = liftDependencies(tasks, ["a", "b"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe(DependencyKind.Indirect);
    expect(edges[0].origins).toEqual([
      { dependentId: "a1", prerequisiteId: "b" },
      { dependentId: "a2", prerequisiteId: "b1" },
    ]);
  });

  it("draws a pair solid when one of the dependencies behind it is the cards' own", () => {
    const tasks = tree().map((t) => {
      if (t.id === "a") return withFields(t, { dependencies: ["b"] });
      if (t.id === "a1") return withFields(t, { dependencies: ["b1"] });
      return t;
    });

    const edges = liftDependencies(tasks, ["a", "b"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe(DependencyKind.Direct);
    expect(edges[0].origins).toHaveLength(2);
  });

  it("keeps the two directions between one pair of cards apart", () => {
    const tasks = tree().map((t) => {
      if (t.id === "a1") return withFields(t, { dependencies: ["b"] });
      if (t.id === "b1") return withFields(t, { dependencies: ["a"] });
      return t;
    });

    expect(liftDependencies(tasks, ["a", "b"])).toMatchObject([
      { sourceId: "b", targetId: "a" },
      { sourceId: "a", targetId: "b" },
    ]);
  });

  it("drops a dependency on a card the level is holding back", () => {
    // `a` is the level's own card, only filtered out: hiding it hides what waits on it.
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a"] }) : t));

    expect(liftDependencies(tasks, ["b"], ["a"])).toEqual([]);
  });

  it("drops one lifting onto a held-back card from below it", () => {
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a1x"] }) : t));

    expect(liftDependencies(tasks, ["b"], ["a"])).toEqual([]);
  });

  it("drops one whose waiting end is held back", () => {
    // `a` is a card of the level, only filtered out: hidden, not outside.
    const tasks = tree().map((t) => (t.id === "a" ? withFields(t, { dependencies: ["b"] }) : t));

    expect(liftDependencies(tasks, ["b"], ["a"])).toEqual([]);
  });

  it("still names a prerequisite from outside the level as itself", () => {
    // Held-back cards are the level's own; what lies outside it is unaffected.
    const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a"] }) : t));

    expect(liftDependencies(tasks, ["b"], ["b1"])).toMatchObject([
      { sourceId: "a", targetId: "b", external: ExternalEnd.Prerequisite },
    ]);
  });

  describe("the card the level itself is drawn as", () => {
    // Drilled into `a`: its children are the cards, and `a` is the frame around them.
    const level = ["a1", "a2"];

    it("lifts the level's own dependency onto it", () => {
      const tasks = tree().map((t) => (t.id === "a" ? withFields(t, { dependencies: ["b"] }) : t));

      expect(liftDependencies(tasks, level, [], "a")).toEqual([
        {
          sourceId: "b",
          targetId: "a",
          kind: DependencyKind.Direct,
          external: ExternalEnd.Prerequisite,
          origins: [{ dependentId: "a", prerequisiteId: "b" }],
        },
      ]);
    });

    it("lifts what waits on the level onto it too", () => {
      const tasks = tree().map((t) => (t.id === "b" ? withFields(t, { dependencies: ["a"] }) : t));

      expect(liftDependencies(tasks, level, [], "a")).toMatchObject([
        { sourceId: "a", targetId: "b", external: ExternalEnd.Dependent },
      ]);
    });

    it("leaves a card of the level standing for its own subtree", () => {
      // The frame is the last card an end can lift to, so `a1x` still answers with `a1`.
      const tasks = tree().map((t) => (t.id === "a1x" ? withFields(t, { dependencies: ["b"] }) : t));

      expect(liftDependencies(tasks, level, [], "a")).toMatchObject([
        { sourceId: "b", targetId: "a1", kind: DependencyKind.Indirect },
      ]);
    });

    it("drops a link between the frame and a card inside it", () => {
      // An arrow from a box to the box holding it is nothing a reader can follow.
      const tasks = tree().map((t) => (t.id === "a1" ? withFields(t, { dependencies: ["a"] }) : t));

      expect(liftDependencies(tasks, level, [], "a")).toEqual([]);
    });

    it("drops one between the frame and something below a card inside it", () => {
      const tasks = tree().map((t) => (t.id === "a" ? withFields(t, { dependencies: ["a1x"] }) : t));

      expect(liftDependencies(tasks, level, [], "a")).toEqual([]);
    });

    it("drops the level's own dependency onto a card a filter is holding back", () => {
      const tasks = tree().map((t) => (t.id === "b1" ? withFields(t, { dependencies: ["a"] }) : t));

      expect(liftDependencies(tasks, level, ["b1"], "a")).toEqual([]);
    });

    it("reads exactly as before when the level names none", () => {
      const tasks = tree().map((t) => (t.id === "a" ? withFields(t, { dependencies: ["b"] }) : t));

      expect(liftDependencies(tasks, level)).toEqual([]);
    });
  });

  it("survives a parentId cycle rather than looping", () => {
    const tasks = [
      makeTask({ id: "x", parentId: "y", dependencies: ["z"] }),
      makeTask({ id: "y", parentId: "x" }),
      makeTask({ id: "z" }),
    ];

    expect(liftDependencies(tasks, ["z"])).toMatchObject([
      { sourceId: "z", targetId: "x", external: ExternalEnd.Dependent },
    ]);
  });
});
