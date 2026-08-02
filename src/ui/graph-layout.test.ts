// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { layoutGraph } from "./graph-layout";
import { TaskNode, NODE_WIDTH, NODE_HEIGHT, type Point } from "./graph-node";
import { DependencyEdge, VirtualEdge, resolveEdges, type EdgeSpec } from "./graph-edge";

// ── helpers ──────────────────────────────────────────────────────────────────

const SPACING = { rankSep: 70, nodeSep: 50 };
const X_STEP = NODE_WIDTH + SPACING.rankSep;
const Y_GAP = NODE_HEIGHT + SPACING.nodeSep;

/** A card with nothing on it — this suite only cares where the layout puts it. */
function node(id: string): TaskNode {
  return new TaskNode({ id, card: document.createElement("div") });
}

/** Lays out a graph named by ids, and hands back the nodes to read positions off. */
function layout(ids: string[], specs: EdgeSpec[] = [], spacing = SPACING) {
  const nodes = ids.map(node);
  layoutGraph(nodes, resolveEdges(nodes, specs), spacing);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes,
    at: (id: string) => byId.get(id)!.position,
    rankOf: (id: string) => (byId.get(id)!.position.x - NODE_WIDTH / 2) / X_STEP,
  };
}

function edge(source: string, target: string, kind: EdgeSpec["kind"] = DependencyEdge): EdgeSpec {
  return { source, target, kind };
}

/** The pairs of cards whose boxes touch, named for the failure message. */
function overlaps(nodes: TaskNode[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [a, b] = [nodes[i], nodes[j]];
      if (Math.abs(a.position.x - b.position.x) < NODE_WIDTH && Math.abs(a.position.y - b.position.y) < NODE_HEIGHT) {
        bad.push(`${a.id} and ${b.id}`);
      }
    }
  }
  return bad;
}

/** How many pairs of drawn edges cross, counted off the placement itself. */
function crossings(nodes: TaskNode[], specs: EdgeSpec[]): number {
  const drawn = resolveEdges(nodes, specs).filter((e) => e instanceof DependencyEdge);
  const side = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  let count = 0;
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const [e, f] = [drawn[i], drawn[j]];
      if (e.source === f.source || e.source === f.target || e.target === f.source || e.target === f.target) continue;
      const [a, b, c, d] = [e.source.position, e.target.position, f.source.position, f.target.position];
      const [d1, d2, d3, d4] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
      if (d1 && d2 && d3 && d4 && d1 !== d2 && d3 !== d4) count++;
    }
  }
  return count;
}

/** The graph every view here builds: one context card joined to each task by a virtual
 *  edge, plus the dependencies among those tasks. */
function contextGraph(taskIds: string[], deps: EdgeSpec[] = []) {
  return layout(["ctx", ...taskIds], [...taskIds.map((id) => edge("ctx", id, VirtualEdge)), ...deps]);
}

// ── columns ───────────────────────────────────────────────────────────────────

describe("layoutGraph columns", () => {
  it("does nothing to an empty graph", () => {
    expect(() => layoutGraph([], [], SPACING)).not.toThrow();
  });

  it("puts a lone card in the first column", () => {
    expect(layout(["a"]).at("a")).toEqual({ x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 });
  });

  it("stacks unconnected cards in one column, in the order given", () => {
    const g = layout(["a", "b", "c"]);
    expect([g.rankOf("a"), g.rankOf("b"), g.rankOf("c")]).toEqual([0, 0, 0]);
    expect(g.at("b").y - g.at("a").y).toBe(Y_GAP);
    expect(g.at("c").y - g.at("b").y).toBe(Y_GAP);
  });

  it("places the context card left of every task it joins", () => {
    const g = contextGraph(["t1", "t2", "t3"]);
    expect(g.rankOf("ctx")).toBe(0);
    for (const id of ["t1", "t2", "t3"]) expect(g.rankOf(id)).toBe(1);
  });

  it("ranks a dependency chain one column per link", () => {
    const g = contextGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]);
    expect([g.rankOf("ctx"), g.rankOf("a"), g.rankOf("b"), g.rankOf("c")]).toEqual([0, 1, 2, 3]);
  });

  it("ranks by the longest path, not the shortest", () => {
    // d depends on both a (one hop) and c (three hops): the long way wins.
    const g = contextGraph(["a", "b", "c", "d"], [
      edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("a", "d"),
    ]);
    expect(g.rankOf("d")).toBe(4);
  });

  it("spaces adjacent ranks by rankSep", () => {
    const g = contextGraph(["a", "b"], [edge("a", "b")]);
    expect(g.at("b").x - g.at("a").x).toBe(X_STEP);
  });

  it("ignores edges pointing outside the graph", () => {
    const g = layout(["a", "b"], [edge("gone", "b"), edge("a", "away")]);
    expect([g.rankOf("a"), g.rankOf("b")]).toEqual([0, 0]);
  });

  it("ignores an edge from a card to itself", () => {
    expect(layout(["a"], [edge("a", "a")]).rankOf("a")).toBe(0);
  });

  it("keeps the first column for the band, whatever the level's cards depend on", () => {
    // No virtual edge to push them right: what reserves the column is the band itself.
    const nodes = [
      new TaskNode({ id: "ext", card: document.createElement("div"), isExternal: true }),
      node("a"),
      node("b"),
    ];
    layoutGraph(nodes, resolveEdges(nodes, [edge("ext", "a")]), SPACING);
    const rank = (n: TaskNode) => (n.position.x - NODE_WIDTH / 2) / X_STEP;
    expect(nodes.map(rank)).toEqual([0, 1, 1]);
  });

  it("stacks the band down that column, the card the graph hangs off on top", () => {
    const ctx = new TaskNode({ id: "ctx", card: document.createElement("div"), isContext: true });
    const ext = new TaskNode({ id: "ext", card: document.createElement("div"), isExternal: true });
    const nodes = [ctx, ext, node("a")];
    layoutGraph(nodes, resolveEdges(nodes, [edge("ctx", "a", VirtualEdge), edge("ext", "a")]), SPACING);

    expect(ctx.position.x).toBe(ext.position.x);
    expect(ext.position.y - ctx.position.y).toBe(Y_GAP);
    expect(nodes[2].position.x).toBeGreaterThan(ctx.position.x);
  });

  it("places every card of a cyclic graph rather than hanging", () => {
    // The UI forbids these, but a hand-edited vault can still spell one out.
    const g = layout(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    for (const id of ["a", "b", "c"]) expect(Number.isFinite(g.at(id).x)).toBe(true);
  });
});

// ── ordinates ─────────────────────────────────────────────────────────────────

describe("layoutGraph ordinates", () => {
  it("never overlaps two cards of the same rank", () => {
    const g = contextGraph(["t1", "t2", "t3", "t4"]);
    const ys = ["t1", "t2", "t3", "t4"].map((id) => g.at(id).y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(Y_GAP);
  });

  it("honours nodeSep for the gap within a rank", () => {
    const nodes = ["ctx", "t1", "t2"].map(node);
    layoutGraph(nodes, resolveEdges(nodes, [edge("ctx", "t1", VirtualEdge), edge("ctx", "t2", VirtualEdge)]), { rankSep: 60, nodeSep: 20 });
    expect(Math.abs(nodes[2].position.y - nodes[1].position.y)).toBe(NODE_HEIGHT + 20);
  });

  it("centres the context card against the tasks hanging off it", () => {
    const g = contextGraph(["t1", "t2", "t3"]);
    const taskMean = ["t1", "t2", "t3"].reduce((sum, id) => sum + g.at(id).y, 0) / 3;
    expect(g.at("ctx").y).toBeCloseTo(taskMean, 5);
  });

  it("draws a chain straight rather than stepping it down", () => {
    const g = contextGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]);
    expect(g.at("b").y).toBeCloseTo(g.at("a").y, 5);
    expect(g.at("c").y).toBeCloseTo(g.at("a").y, 5);
  });

  it("keeps two parallel chains apart and each of them straight", () => {
    const g = contextGraph(["a1", "a2", "b1", "b2"], [edge("a1", "a2"), edge("b1", "b2")]);
    expect(g.at("a2").y).toBeCloseTo(g.at("a1").y, 5);
    expect(g.at("b2").y).toBeCloseTo(g.at("b1").y, 5);
    expect(Math.abs(g.at("b1").y - g.at("a1").y)).toBeGreaterThanOrEqual(Y_GAP);
  });

  it("sets a card with two dependencies within their span", () => {
    // Rows are slots, so it takes the free one nearest the middle of the two rather than
    // an ordinate exactly between them.
    const g = contextGraph(["a", "b", "c"], [edge("a", "c"), edge("b", "c")]);
    const [top, bottom] = [g.at("a").y, g.at("b").y].sort((x, y) => x - y);
    expect(g.at("c").y).toBeGreaterThanOrEqual(top);
    expect(g.at("c").y).toBeLessThanOrEqual(bottom);
  });

  it("starts the graph at the top, whatever the passes did in between", () => {
    const g = contextGraph(["t1", "t2", "t3"]);
    expect(Math.min(...g.nodes.map((n) => n.position.y))).toBe(NODE_HEIGHT / 2);
  });
});

// ── crossing reduction ────────────────────────────────────────────────────────

describe("layoutGraph ordering", () => {
  it("reorders a rank so its edges stop crossing", () => {
    // Listed so that keeping the given order would cross a1→b2 over a2→b1.
    const g = contextGraph(["a1", "a2", "b1", "b2"], [edge("a1", "b2"), edge("a2", "b1")]);
    expect(g.at("a1").y < g.at("a2").y).toBe(g.at("b2").y < g.at("b1").y);
  });
});

// ── the queue ─────────────────────────────────────────────────────────────────

describe("layoutGraph placement order", () => {
  it("only ever places a card once everything it waits on is placed", () => {
    // Listed back to front, so a walk taking them as given would place c before a.
    const g = layout(["c", "b", "a"], [edge("a", "b"), edge("b", "c")]);
    expect([g.rankOf("a"), g.rankOf("b"), g.rankOf("c")]).toEqual([0, 1, 2]);
  });

  it("puts a card one column past the furthest thing it waits on, not the nearest", () => {
    // d waits on a in column 0 and on c in column 2, so its first free column is 3.
    const g = layout(["a", "b", "c", "d"], [edge("a", "b"), edge("b", "c"), edge("a", "d"), edge("c", "d")]);
    expect(g.rankOf("d")).toBe(3);
  });

  it("places a card whose dependencies form a cycle rather than dropping it", () => {
    const g = layout(["root", "a", "b"], [edge("root", "a", VirtualEdge), edge("a", "b"), edge("b", "a")]);
    for (const id of ["root", "a", "b"]) expect(Number.isFinite(g.at(id).x)).toBe(true);
  });
});

// ── crossings ─────────────────────────────────────────────────────────────────

describe("layoutGraph crossings", () => {
  it("draws two interleaved chains without crossing them", () => {
    const specs = [edge("a1", "b2"), edge("a2", "b1")];
    const g = contextGraph(["a1", "a2", "b1", "b2"], specs);
    expect(crossings(g.nodes, [...["a1", "a2", "b1", "b2"].map((id) => edge("ctx", id, VirtualEdge)), ...specs])).toBe(0);
  });

  it("keeps a long edge from cutting across the chain it skips", () => {
    // a → d spans three columns, so it can only avoid b → c by sitting off to one side.
    const specs = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("a", "e"), edge("e", "d")];
    const g = contextGraph(["a", "b", "c", "d", "e"], specs);
    expect(crossings(g.nodes, specs)).toBe(0);
  });

  it("leaves no card sharing a slot with another", () => {
    const g = contextGraph(["a", "b", "c", "d", "e"], [edge("a", "c"), edge("b", "c"), edge("c", "d"), edge("a", "e")]);
    const slots = g.nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(slots).size).toBe(slots.length);
  });
});

// ── overlaps ──────────────────────────────────────────────────────────────────

describe("layoutGraph never overlaps two cards", () => {
  it("when two cards wait on the very same two cards", () => {
    // Both want the row nearest the middle of a and b; the second finds it taken.
    const g = layout(["a", "b", "c", "d"], [
      edge("a", "c"), edge("b", "c"), edge("a", "d"), edge("b", "d"),
    ]);
    expect(overlaps(g.nodes)).toEqual([]);
  });

  it("when a whole generation waits on one card", () => {
    const tasks = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];
    const g = layout(["a", ...tasks], tasks.map((t) => edge("a", t)));
    expect(overlaps(g.nodes)).toEqual([]);
  });

  it("when nothing depends on anything and every card shares a column", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
    expect(overlaps(layout(ids).nodes)).toEqual([]);
  });

  it("when the cards the context card holds are a cycle among themselves", () => {
    const g = contextGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    expect(overlaps(g.nodes)).toEqual([]);
  });

  it("when two cards wait on the same two, under a context card", () => {
    // The graph a drilled-in task draws: the virtual edges joining the context card to
    // each task are never drawn, so they must not push a card past a free row either.
    const g = contextGraph(["a", "b", "c", "d"], [
      edge("a", "c"), edge("b", "c"), edge("a", "d"), edge("b", "d"),
    ]);
    expect(overlaps(g.nodes)).toEqual([]);
    // c and d share a column and sit one row apart — nothing empty between them.
    expect(Math.abs(g.at("c").y - g.at("d").y)).toBe(Y_GAP);
  });

  it("across a dense mesh of dependencies", () => {
    // Every card waiting on every earlier one, which is the most crowded a column gets.
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`);
    const specs = ids.flatMap((target, j) => ids.slice(0, j).map((source) => edge(source, target)));
    expect(overlaps(layout(ids, specs).nodes)).toEqual([]);
  });
});
