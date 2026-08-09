// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  CONTAINER_HEADER, CONTAINER_PADDING, OUTSIDE_GAP,
  layoutContainerLevel, settleContainerLevel,
} from "./graph-container-layout";
import { Box, ContainerNode, GraphNode, NODE_HEIGHT, NODE_WIDTH, TaskNode } from "./graph-node";
import { DependencyEdge, GraphEdge } from "./graph-edge";
import type { LayoutSpacing } from "./graph-layout";

const SPACING: LayoutSpacing = { rankSep: 70, nodeSep: 50 };

function card(): HTMLElement {
  return document.createElement("div");
}

function frame(): ContainerNode {
  return new ContainerNode({ id: "container:a", taskId: "a", card: card() });
}

function inner(id: string): TaskNode {
  return new TaskNode({ id, card: card() });
}

function outside(id: string): TaskNode {
  return new TaskNode({ id: `${id}-ext`, taskId: id, isExternal: true, card: card() });
}

function edge(source: GraphNode, target: GraphNode): GraphEdge {
  return new DependencyEdge(source, target);
}

/** Places a level and settles it, as the renderer does either side of stored positions. */
function draw(nodes: GraphNode[], edges: GraphEdge[]): void {
  layoutContainerLevel(nodes, edges, SPACING);
  settleContainerLevel(nodes, edges, SPACING);
}

describe("layoutContainerLevel", () => {
  it("places the level's own cards in dependency order", () => {
    const [a, b] = [inner("a1"), inner("a2")];
    layoutContainerLevel([frame(), a, b], [edge(a, b)], SPACING);

    expect(b.position.x).toBeGreaterThan(a.position.x);
  });

  it("leaves a card reaching outside the level out of the columns inside it", () => {
    // Two cards waiting on nothing of this level's belong side by side, whatever they wait
    // on beyond it.
    const [a, b, out] = [inner("a1"), inner("a2"), outside("x")];
    layoutContainerLevel([frame(), a, b, out], [edge(out, a), edge(a, b)], SPACING);

    expect(a.position.x).toBe(NODE_WIDTH / 2);
  });
});

describe("settleContainerLevel", () => {
  it("wraps the cards inside it, header and all", () => {
    const f = frame();
    const cards = [inner("a1"), inner("a2")];
    draw([f, ...cards], []);

    const held = Box.around(cards);
    expect(f.box.left).toBe(held.left - CONTAINER_PADDING);
    expect(f.box.top).toBe(held.top - CONTAINER_PADDING - CONTAINER_HEADER);
  });

  it("hangs a prerequisite off the left of the frame", () => {
    const f = frame();
    const a = inner("a1");
    const out = outside("x");
    draw([f, a, out], [edge(out, a)]);

    expect(out.position.x).toBe(f.box.left - OUTSIDE_GAP - NODE_WIDTH / 2);
  });

  it("hangs what waits on the level off the right", () => {
    const f = frame();
    const a = inner("a1");
    const out = outside("x");
    draw([f, a, out], [edge(a, out)]);

    expect(out.position.x).toBe(f.box.right + OUTSIDE_GAP + NODE_WIDTH / 2);
  });

  it("draws a task at both ends once, on the left, where its chain starts", () => {
    // One card per task whichever way its arrows run: `x → a1` and `a2 → x`.
    const f = frame();
    const [a, b, out] = [inner("a1"), inner("a2"), outside("x")];
    draw([f, a, b, out], [edge(out, a), edge(b, out)]);

    expect(out.position.x).toBeLessThan(f.box.left);
  });

  it("hangs a card no edge reaches level with the middle of the frame", () => {
    const f = frame();
    const a = inner("a1");
    const out = outside("x");
    draw([f, a, out], []);

    expect(out.position.y).toBe(f.box.centre.y);
    // Nothing runs out of it, so it goes on the right.
    expect(out.position.x).toBeGreaterThan(f.box.right);
  });

  it("stacks a side rather than piling its cards on one another", () => {
    const f = frame();
    const a = inner("a1");
    const [x, y] = [outside("x"), outside("y")];
    draw([f, a, x, y], [edge(x, a), edge(y, a)]);

    expect(x.position.x).toBe(y.position.x);
    expect(Math.abs(x.position.y - y.position.y)).toBe(NODE_HEIGHT + SPACING.nodeSep);
  });

  it("grows the frame round a card put somewhere of its own, and moves what is outside with it", () => {
    const f = frame();
    const a = inner("a1");
    const out = outside("x");
    draw([f, a, out], [edge(a, out)]);
    const before = f.box.right;

    // What a stored position does, which the layout never sees.
    a.position = { x: a.position.x + 400, y: a.position.y };
    settleContainerLevel([f, a, out], [edge(a, out)], SPACING);

    expect(f.box.right).toBe(before + 400);
    expect(out.position.x).toBe(f.box.right + OUTSIDE_GAP + NODE_WIDTH / 2);
  });

  it("moves no card inside it", () => {
    // It must not normalise: a translation after a stored position was read would rewrite
    // what that position means, drifting the card a little further every render.
    const f = frame();
    const cards = [inner("a1"), inner("a2")];
    const links = [edge(cards[0], cards[1])];
    draw([f, ...cards], links);
    const held = cards.map((c) => ({ ...c.position }));

    settleContainerLevel([f, ...cards], links, SPACING);

    expect(cards.map((c) => c.position)).toEqual(held);
  });

  it("draws a frame for a level holding nothing at all", () => {
    const f = frame();
    settleContainerLevel([f], [], SPACING);

    expect([f.box.width, f.box.height]).toEqual([NODE_WIDTH, NODE_HEIGHT]);
  });

  it("does nothing for a level drawn without one", () => {
    // The project grid, which has no frame and places its cards itself.
    const a = inner("a1");
    a.position = { x: 5, y: 7 };
    settleContainerLevel([a], [], SPACING);

    expect(a.position).toEqual({ x: 5, y: 7 });
  });
});

describe("a card beyond the level put somewhere by hand", () => {
  /** The level, settled with `out` counted as placed rather than arranged. */
  function settleWith(f: ContainerNode, cards: GraphNode[], edges: GraphEdge[], placed: GraphNode[]): void {
    settleContainerLevel([f, ...cards], edges, SPACING, new Set(placed));
  }

  it("is left where it was put", () => {
    const f = frame();
    const a = inner("a1");
    const out = outside("x");
    draw([f, a, out], [edge(out, a)]);

    out.position = { x: -900, y: -400 };
    settleWith(f, [a, out], [edge(out, a)], [out]);

    expect(out.position).toEqual({ x: -900, y: -400 });
  });

  it("is held clear of the frame, which is the one place it may not go", () => {
    // The box stands for the level itself; a card from beyond it sitting inside would say
    // it belongs there.
    const f = frame();
    const a = inner("a1");
    const out = outside("x");
    draw([f, a, out], [edge(out, a)]);

    out.position = { ...f.box.centre };
    settleWith(f, [a, out], [edge(out, a)], [out]);

    expect(out.box.overlaps(f.box)).toBe(false);
  });

  it("is pushed out the shortest way, not always the same way", () => {
    const f = frame();
    const a = inner("a1");
    const out = outside("x");
    draw([f, a, out], [edge(out, a)]);

    // Just inside the top edge: up is the way out.
    out.position = { x: f.box.centre.x, y: f.box.top + 4 };
    settleWith(f, [a, out], [edge(out, a)], [out]);
    expect(out.box.bottom).toBe(f.box.top);

    // Just inside the right edge: right is.
    out.position = { x: f.box.right - 4, y: f.box.centre.y };
    settleWith(f, [a, out], [edge(out, a)], [out]);
    expect(out.box.left).toBe(f.box.right);
  });

  it("leaves the ones it still arranges to the sides as before", () => {
    const f = frame();
    const a = inner("a1");
    const [held, loose] = [outside("x"), outside("y")];
    draw([f, a, held, loose], [edge(held, a), edge(loose, a)]);

    held.position = { x: -900, y: -400 };
    settleWith(f, [a, held, loose], [edge(held, a), edge(loose, a)], [held]);

    expect(held.position).toEqual({ x: -900, y: -400 });
    expect(loose.position.x).toBe(f.box.left - OUTSIDE_GAP - NODE_WIDTH / 2);
    // Alone on its side now, so it sits level with the frame rather than stacked.
    expect(loose.position.y).toBe(f.box.centre.y);
  });
});
