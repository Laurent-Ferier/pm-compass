// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { Box, ContainerNode, ProjectNode, TaskNode, NODE_WIDTH, NODE_HEIGHT, type GraphNode } from "./graph-node";
import { bagOf } from "./__testing__/dom-bag";

beforeAll(() => {
  // `render` builds its wrapper with Obsidian's own DOM helper.
  bagOf(HTMLElement.prototype).createDiv = function (this: HTMLElement, opts?: { cls?: string }) {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    this.appendChild(el);
    return el;
  };
  // A frame writes its own size with it, the CSS fixing every other card's.
  bagOf(HTMLElement.prototype).setCssStyles = function (
    this: HTMLElement,
    styles: Partial<CSSStyleDeclaration>,
  ) {
    Object.assign(this.style, styles);
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
    it("makes a task card one a drag moves", () => {
      const n = task("t1");
      expect(n.isDraggable).toBe(true);
      expect(n.taskId).toBe("t1");
    });

    it("never moves a project card, and has it name its own project", () => {
      // Its cards are placed by the grid, which reflows: where one was dragged to would
      // mean nothing the next time round.
      const n = new ProjectNode({ id: "proj-p1", projectId: "p1", card: card() });
      expect(n.projectId).toBe("p1");
      expect(n.isDraggable).toBe(false);
    });

    it("gives a card standing for a task outside the level an id of its own", () => {
      // The task's own id belongs to its real card, drawn at the level it lives on.
      const n = new TaskNode({ id: "t1-ext", taskId: "t1", isExternal: true, card: card() });
      expect(n.id).toBe("t1-ext");
      expect(n.taskId).toBe("t1");
      expect(n.isExternal).toBe(true);
      // It can still be put somewhere that reads better, which is all a drag does to it.
      expect(n.isDraggable).toBe(true);
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

describe("Box.around", () => {
  it("is empty for no cards at all", () => {
    expect(Box.around([])).toEqual(new Box(0, 0, 0, 0));
  });

  it("is one card's box for a lone card", () => {
    expect(Box.around([task("a", { x: 100, y: 100 })])).toEqual(new Box(
      100 - NODE_WIDTH / 2, 100 - NODE_HEIGHT / 2, 100 + NODE_WIDTH / 2, 100 + NODE_HEIGHT / 2,
    ));
  });

  it("spans from the leftmost card's edge to the rightmost card's", () => {
    const box = Box.around([task("a", { x: 0, y: 0 }), task("b", { x: 300, y: 200 })]);
    expect(box.left).toBe(-NODE_WIDTH / 2);
    expect(box.top).toBe(-NODE_HEIGHT / 2);
    expect(box.width).toBe(300 + NODE_WIDTH);
    expect(box.height).toBe(200 + NODE_HEIGHT);
  });
});

describe("Box", () => {
  it("takes a measured rect as it stands", () => {
    const box = Box.of({ left: 10, top: 20, right: 40, bottom: 60 });
    expect([box.width, box.height]).toEqual([30, 40]);
  });

  it("holds a point on its own edge, so a card's every pixel counts", () => {
    const box = new Box(0, 0, 10, 10);
    expect(box.contains({ x: 0, y: 10 })).toBe(true);
    expect(box.contains({ x: 5, y: 5 })).toBe(true);
    expect(box.contains({ x: 11, y: 5 })).toBe(false);
    expect(box.contains({ x: 5, y: -1 })).toBe(false);
  });

  it("is a card's own four edges, centred on where the layout put it", () => {
    expect(task("a", { x: 100, y: 100 }).box)
      .toEqual(new Box(20, 64, 180, 136));
  });
});

describe("a card of another size", () => {
  /** A card twice the standard height, its middle where the layout left it. */
  function tall(at: { x: number; y: number }): TaskNode {
    const n = task("tall", at);
    n.box = Box.centredOn(at, NODE_WIDTH, NODE_HEIGHT * 2);
    return n;
  }

  it("reads its corner off its own box, not the standard size", () => {
    const n = tall({ x: 100, y: 100 });
    expect(n.left).toBe(100 - NODE_WIDTH / 2);
    expect(n.top).toBe(100 - NODE_HEIGHT);
  });

  it("keeps that size when the layout moves it", () => {
    const n = tall({ x: 100, y: 100 });
    n.position = { x: 0, y: 0 };
    expect([n.box.width, n.box.height]).toEqual([NODE_WIDTH, NODE_HEIGHT * 2]);
    expect(n.position).toEqual({ x: 0, y: 0 });
  });

  it("lets an edge leave by its own boundary, further out than a standard card's", () => {
    const n = tall({ x: 0, y: 0 });
    expect(n.exitTowards({ x: 0, y: 500 })).toEqual({ x: 0, y: NODE_HEIGHT });
  });

  it("counts for its full height in the box around a set of cards", () => {
    const box = Box.around([tall({ x: 0, y: 0 }), task("b", { x: 0, y: 0 })]);
    expect(box.height).toBe(NODE_HEIGHT * 2);
  });

  it("takes a drop anywhere in it, including where a standard card would end", () => {
    const n = tall({ x: 0, y: 0 });
    expect(n.box.contains({ x: 0, y: NODE_HEIGHT * 0.75 })).toBe(true);
    expect(n.box.contains({ x: 0, y: NODE_HEIGHT * 1.25 })).toBe(false);
  });
});

describe("ContainerNode", () => {
  const PADDING = 10;
  const HEADER = 20;

  function frame(taskId?: string): ContainerNode {
    return new ContainerNode({ id: "container:a", taskId, card: card() });
  }

  it("wraps the cards inside it, with room for the header above them", () => {
    const f = frame();
    f.fitAround([task("a", { x: 0, y: 0 }), task("b", { x: 300, y: 100 })], PADDING, HEADER);

    const inner = Box.around([task("a", { x: 0, y: 0 }), task("b", { x: 300, y: 100 })]);
    expect(f.box.left).toBe(inner.left - PADDING);
    expect(f.box.right).toBe(inner.right + PADDING);
    expect(f.box.top).toBe(inner.top - PADDING - HEADER);
    expect(f.box.bottom).toBe(inner.bottom + PADDING);
  });

  it("keeps a card's own size for a level holding nothing", () => {
    // `Box.around([])` is a zero box at the origin, which would draw no frame at all.
    const f = frame();
    f.position = { x: 40, y: 60 };
    f.fitAround([], PADDING, HEADER);

    expect([f.box.width, f.box.height]).toEqual([NODE_WIDTH, NODE_HEIGHT]);
    expect(f.position).toEqual({ x: 40, y: 60 });
  });

  it("never moves, so no place of its own is remembered for it", () => {
    expect(frame().isDraggable).toBe(false);
  });

  it("names the task the level belongs to, and none for a project's", () => {
    expect(frame("a").taskId).toBe("a");
    expect(frame().taskId).toBeUndefined();
  });

  it("lets an edge stop on its own boundary rather than a card's", () => {
    const f = frame();
    f.fitAround([task("a", { x: 0, y: 0 })], PADDING, HEADER);
    const exit = f.exitTowards({ x: 1000, y: f.box.centre.y });
    expect(exit.x).toBe(f.box.right);
  });

  it("carries its size onto what it drew", () => {
    const layer = document.createElement("div");
    const f = frame();
    f.fitAround([task("a", { x: 0, y: 0 }), task("b", { x: 300, y: 0 })], PADDING, HEADER);
    const el = f.render(layer);

    expect(el.style.width).toBe(`${f.box.width}px`);
    expect(f.card.style.height).toBe(`${f.box.height}px`);
  });
});

describe("Box.overlaps and Box.clearOf", () => {
  const box = new Box(0, 0, 100, 100);

  it("counts shared room as overlapping, and a shared edge as not", () => {
    expect(box.overlaps(new Box(50, 50, 150, 150))).toBe(true);
    expect(box.overlaps(new Box(100, 0, 200, 100))).toBe(false);
  });

  it("leaves a box that is already clear where it is", () => {
    const clear = new Box(200, 0, 300, 100);
    expect(clear.clearOf(box)).toEqual(clear.centre);
  });

  it("pushes a box out by whichever side is the shortest way", () => {
    // Deep in from the left edge, shallow from the top: up is the way out.
    const over = Box.centredOn({ x: 50, y: 10 }, 40, 40);
    expect(over.clearOf(box)).toEqual({ x: 50, y: -20 });
  });

  it("pushes one dead centre out too, rather than leaving it inside", () => {
    const over = Box.centredOn(box.centre, 40, 40);
    const out = Box.centredOn(over.clearOf(box), 40, 40);
    expect(out.overlaps(box)).toBe(false);
  });
});
