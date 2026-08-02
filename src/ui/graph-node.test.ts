// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { ProjectNode, TaskNode, NODE_WIDTH, NODE_HEIGHT, nodesBoundingBox, type GraphNode } from "./graph-node";
import { bagOf } from "./__testing__/dom-bag";

beforeAll(() => {
  // `render` builds its wrapper with Obsidian's own DOM helper.
  bagOf(HTMLElement.prototype).createDiv = function (this: HTMLElement, opts?: { cls?: string }) {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    this.appendChild(el);
    return el;
  };
});

function card(text = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = "pm-node-card";
  el.textContent = text;
  return el;
}

function task(id: string, at = { x: 0, y: 0 }): TaskNode {
  return placed(new TaskNode({ id, card: card() }), at);
}

function placed<T extends GraphNode>(n: T, at: { x: number; y: number }): T {
  n.position = at;
  return n;
}

describe("GraphNode", () => {
  it("starts at the origin until a layout places it", () => {
    expect(new TaskNode({ id: "a", card: card() }).position).toEqual({ x: 0, y: 0 });
  });

  it("reports its top-left from the centre it holds", () => {
    const n = task("a", { x: 100, y: 50 });
    expect(n.left).toBe(100 - NODE_WIDTH / 2);
    expect(n.top).toBe(50 - NODE_HEIGHT / 2);
  });

  it("holds the card it was given", () => {
    const el = card("Title");
    expect(new TaskNode({ id: "a", card: el }).card).toBe(el);
  });

  describe("render", () => {
    it("puts its card in a positioned wrapper inside the layer", () => {
      const layer = document.createElement("div");
      const node = task("t1", { x: 300, y: 200 });

      const el = node.render(layer);

      expect(el.className).toBe("pm-graph-node");
      expect(el.parentElement).toBe(layer);
      expect(el.firstElementChild).toBe(node.card);
      expect(el.style.left).toBe(`${300 - NODE_WIDTH / 2}px`);
      expect(el.style.top).toBe(`${200 - NODE_HEIGHT / 2}px`);
      expect(node.element).toBe(el);
    });

    it("has no element before it draws one", () => {
      expect(task("t1").element).toBeNull();
    });

    it("moves its wrapper to wherever it now sits", () => {
      const node = task("t1", { x: 0, y: 0 });
      const el = node.render(document.createElement("div"));

      node.position = { x: 500, y: 400 };
      node.reposition();

      expect(el.style.left).toBe(`${500 - NODE_WIDTH / 2}px`);
    });

    it("shrugs off being repositioned before it has drawn", () => {
      expect(() => task("t1").reposition()).not.toThrow();
    });

    it("takes its wrapper off the page when destroyed", () => {
      const layer = document.createElement("div");
      const node = task("t1");
      node.render(layer);

      node.destroy();

      expect(layer.children).toHaveLength(0);
      expect(node.element).toBeNull();
    });
  });

  describe("the kinds of card", () => {
    it("makes a task card the graph's subject, and one a double tap opens", () => {
      const n = task("t1");
      expect(n.isContext).toBe(false);
      expect(n.canDrillIn).toBe(true);
      expect(n.taskId).toBe("t1");
    });

    it("makes a project card context, and not one a double tap opens", () => {
      const n = new ProjectNode({ id: "proj-p1", card: card() });
      expect(n.isContext).toBe(true);
      expect(n.canDrillIn).toBe(false);
    });

    it("lets a task card stand as context under an id of its own", () => {
      // Its own id is taken by the task's card, so it carries the task's separately.
      const n = new TaskNode({ id: "t1-ctx", taskId: "t1", isContext: true, card: card() });
      expect(n.id).toBe("t1-ctx");
      expect(n.taskId).toBe("t1");
      expect(n.isContext).toBe(true);
      // Drilling in would go nowhere — it stands for where the graph already is.
      expect(n.canDrillIn).toBe(false);
    });
  });

  describe("exitTowards", () => {
    it("leaves through the right edge for a card straight to the right", () => {
      const n = task("a", { x: 0, y: 0 });
      expect(n.exitTowards({ x: 500, y: 0 })).toEqual({ x: NODE_WIDTH / 2, y: 0 });
    });

    it("leaves through the left edge for a card straight to the left", () => {
      const n = task("a", { x: 0, y: 0 });
      expect(n.exitTowards({ x: -500, y: 0 })).toEqual({ x: -NODE_WIDTH / 2, y: 0 });
    });

    it("leaves through the top or bottom edge when the other card is above or below", () => {
      const n = task("a", { x: 0, y: 0 });
      expect(n.exitTowards({ x: 0, y: 500 })).toEqual({ x: 0, y: NODE_HEIGHT / 2 });
      expect(n.exitTowards({ x: 0, y: -500 })).toEqual({ x: 0, y: -NODE_HEIGHT / 2 });
    });

    it("leaves through whichever edge the line reaches first on a diagonal", () => {
      const n = task("a", { x: 0, y: 0 });
      // A steep line clears the short side first, so it exits through the bottom.
      const exit = n.exitTowards({ x: 10, y: 1000 });
      expect(exit.y).toBe(NODE_HEIGHT / 2);
      expect(Math.abs(exit.x)).toBeLessThan(NODE_WIDTH / 2);
    });

    it("stays put for a card sitting exactly on top of it", () => {
      const n = task("a", { x: 7, y: 9 });
      expect(n.exitTowards({ x: 7, y: 9 })).toEqual({ x: 7, y: 9 });
    });
  });
});

describe("nodesBoundingBox", () => {
  it("is empty for no cards at all", () => {
    expect(nodesBoundingBox([])).toEqual({ x1: 0, y1: 0, w: 0, h: 0 });
  });

  it("is one card's box for a lone card", () => {
    expect(nodesBoundingBox([task("a", { x: 100, y: 100 })])).toEqual({
      x1: 100 - NODE_WIDTH / 2, y1: 100 - NODE_HEIGHT / 2, w: NODE_WIDTH, h: NODE_HEIGHT,
    });
  });

  it("spans from the leftmost card's edge to the rightmost card's", () => {
    const bb = nodesBoundingBox([task("a", { x: 0, y: 0 }), task("b", { x: 300, y: 200 })]);
    expect(bb.x1).toBe(-NODE_WIDTH / 2);
    expect(bb.y1).toBe(-NODE_HEIGHT / 2);
    expect(bb.w).toBe(300 + NODE_WIDTH);
    expect(bb.h).toBe(200 + NODE_HEIGHT);
  });
});
