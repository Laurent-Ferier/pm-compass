// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { DependencyEdge, EdgeEnd, GraphEdge, IndirectDependencyEdge, resolveEdges } from "./graph-edge";
import { TaskNode, NODE_WIDTH } from "./graph-node";
import { bagOf } from "./__testing__/dom-bag";

beforeAll(() => {
  bagOf(window).activeDocument = document;
});

function node(id: string, at = { x: 0, y: 0 }): TaskNode {
  const n = new TaskNode({ id, card: document.createElement("div") });
  n.position = at;
  return n;
}

function layer(): SVGSVGElement {
  return document.createElementNS("http://www.w3.org/2000/svg", "svg");
}

/** Draws an edge and hands back what it put on the page. */
function draw(edge: GraphEdge, onContextMenu = vi.fn(), onPointerDown = vi.fn()) {
  const svg = layer();
  edge.render(svg, { onContextMenu, onPointerDown });
  return {
    svg,
    onContextMenu,
    onPointerDown,
    line: svg.querySelector<SVGLineElement>(".pm-graph-edge"),
    head: svg.querySelector<SVGPolygonElement>(".pm-graph-edge-head"),
    hit: svg.querySelector<SVGLineElement>(".pm-graph-edge-hit"),
  };
}

function pointsOf(head: SVGPolygonElement): { x: number; y: number }[] {
  return head.getAttribute("points")!.split(" ").map((p) => {
    const [x, y] = p.split(",").map(Number);
    return { x, y };
  });
}

describe("GraphEdge", () => {
  it("names itself after the cards it joins", () => {
    expect(new DependencyEdge(node("a"), node("b")).id).toBe("a->b");
  });
});

describe("DependencyEdge", () => {
  /** Two cards side by side, 400px apart — the shape a dependency edge takes. */
  function sideBySide() {
    return draw(new DependencyEdge(node("a", { x: 0, y: 0 }), node("b", { x: 400, y: 0 })));
  }

  it("draws a line, an arrowhead, and a stroke wide enough to hit", () => {
    const { line, head, hit } = sideBySide();
    expect(line).not.toBeNull();
    expect(head).not.toBeNull();
    expect(Number(hit!.getAttribute("stroke-width"))).toBeGreaterThan(10);
  });

  it("runs from one card's boundary to the other's, not centre to centre", () => {
    const { line } = sideBySide();
    expect(Number(line!.getAttribute("x1"))).toBe(NODE_WIDTH / 2);
    expect(Number(line!.getAttribute("y1"))).toBe(0);
  });

  it("stops the line short of the target, leaving room for the arrowhead", () => {
    const { line, head } = sideBySide();
    const tip = pointsOf(head!)[0];
    expect(tip.x).toBe(400 - NODE_WIDTH / 2);
    expect(Number(line!.getAttribute("x2"))).toBeLessThan(tip.x);
  });

  it("points the arrowhead at the target, its two wings either side of the line", () => {
    const { line, head } = sideBySide();
    const [tip, left, right] = pointsOf(head!);
    const baseX = Number(line!.getAttribute("x2"));
    const baseY = Number(line!.getAttribute("y2"));
    expect(tip.x).toBeGreaterThan(baseX);
    expect(left.x).toBe(baseX);
    expect(right.x).toBe(baseX);
    // Straddling the line means one wing above and one below.
    expect(Math.sign(left.y - baseY)).toBe(-Math.sign(right.y - baseY));
  });

  it("turns the arrowhead with the edge", () => {
    const { line, head } = draw(new DependencyEdge(node("a", { x: 0, y: 0 }), node("b", { x: 0, y: 400 })));
    const [tip, left, right] = pointsOf(head!);
    const baseX = Number(line!.getAttribute("x2"));
    expect(tip.y).toBeGreaterThan(Number(line!.getAttribute("y2")));
    // Vertical edge, so the wings straddle it horizontally instead.
    expect(Math.sign(left.x - baseX)).toBe(-Math.sign(right.x - baseX));
  });

  it("survives two cards dragged onto each other", () => {
    const { line, head } = draw(new DependencyEdge(node("a", { x: 5, y: 5 }), node("b", { x: 5, y: 5 })));
    for (const attr of ["x1", "y1", "x2", "y2"]) {
      expect(Number.isFinite(Number(line!.getAttribute(attr)))).toBe(true);
    }
    for (const p of pointsOf(head!)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it("follows a card that moves", () => {
    const [a, b] = [node("a", { x: 0, y: 0 }), node("b", { x: 400, y: 0 })];
    const edge = new DependencyEdge(a, b);
    const { line } = draw(edge);
    const before = line!.getAttribute("y1");

    b.position = { x: 400, y: 500 };
    edge.reposition();

    expect(line!.getAttribute("y1")).not.toBe(before);
  });

  it("reports a right-click on the wide stroke, and stops it going further", () => {
    const { hit, onContextMenu, svg } = sideBySide();
    const bubbled = vi.fn();
    svg.addEventListener("contextmenu", bubbled);

    hit!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(onContextMenu).toHaveBeenCalledOnce();
    // Otherwise the container's own handler would follow with its add-task menu.
    expect(bubbled).not.toHaveBeenCalled();
  });

  it("takes its elements and its listener with it when destroyed", () => {
    const { svg, hit, onContextMenu } = sideBySide();

    svg.querySelector(".pm-graph-edge-hit");
    const edge = new DependencyEdge(node("a", { x: 0, y: 0 }), node("b", { x: 400, y: 0 }));
    edge.render(svg, { onContextMenu });
    edge.destroy();

    // Only the first edge's stroke is still listening.
    hit!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(svg.querySelectorAll(".pm-graph-edge-hit")).toHaveLength(1);
  });

  it("empties the layer it drew into once destroyed", () => {
    const svg = layer();
    const edge = new DependencyEdge(node("a", { x: 0, y: 0 }), node("b", { x: 400, y: 0 }));
    edge.render(svg, { onContextMenu: vi.fn() });
    expect(svg.children).toHaveLength(3);

    edge.destroy();
    expect(svg.children).toHaveLength(0);
  });
});

describe("IndirectDependencyEdge", () => {
  function sideBySide(onContextMenu = vi.fn()) {
    return draw(new IndirectDependencyEdge(node("a", { x: 0, y: 0 }), node("b", { x: 400, y: 0 })), onContextMenu);
  }

  it("draws the same three elements a plain dependency does", () => {
    const { svg, line, head, hit } = sideBySide();
    expect(svg.children).toHaveLength(3);
    expect([line, head, hit].every(Boolean)).toBe(true);
  });

  it("marks its line and arrowhead as lifted", () => {
    const { line, head } = sideBySide();
    expect(line!.classList.contains("pm-graph-edge--lifted")).toBe(true);
    expect(head!.classList.contains("pm-graph-edge-head--lifted")).toBe(true);
  });

  it("leaves a plain dependency unmarked", () => {
    const { line, head } = draw(new DependencyEdge(node("a"), node("b", { x: 400, y: 0 })));
    expect(line!.classList.contains("pm-graph-edge--lifted")).toBe(false);
    expect(head!.classList.contains("pm-graph-edge-head--indirect")).toBe(false);
  });

  it("still reports a right-click, which is what removes what it stands for", () => {
    const { hit, onContextMenu } = sideBySide();
    hit!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onContextMenu).toHaveBeenCalledOnce();
  });
});

describe("an edge reaching outside the level", () => {
  function external(id: string, at: { x: number; y: number }): TaskNode {
    const n = new TaskNode({ id, isExternal: true, card: document.createElement("div") });
    n.position = at;
    return n;
  }

  it("marks its line and arrowhead as lifted, whichever end lies outside", () => {
    for (
      const edge of [
        new DependencyEdge(external("x", { x: 0, y: 0 }), node("b", { x: 400, y: 0 })),
        new DependencyEdge(node("a", { x: 0, y: 0 }), external("y", { x: 400, y: 0 })),
      ]
    ) {
      const { line, head } = draw(edge);
      expect(line!.classList.contains("pm-graph-edge--lifted")).toBe(true);
      expect(head!.classList.contains("pm-graph-edge-head--lifted")).toBe(true);
    }
  });

  it("marks one that is both held below and reaching outside just the once", () => {
    // The two reasons a line isn't its cards' own read the same, so they can't stack into
    // a third appearance.
    const { line } = draw(new IndirectDependencyEdge(node("a"), external("y", { x: 400, y: 0 })));
    expect([...line!.classList].filter((c) => c.startsWith("pm-graph-edge--")))
      .toEqual(["pm-graph-edge--lifted"]);
  });

  it("leaves an edge between two of the level's own cards unmarked", () => {
    const { line, head } = draw(new DependencyEdge(node("a"), node("b", { x: 400, y: 0 })));
    expect(line!.classList.contains("pm-graph-edge--lifted")).toBe(false);
    expect(head!.classList.contains("pm-graph-edge-head--lifted")).toBe(false);
  });
});

describe("resolveEdges", () => {
  const nodes = [node("a"), node("b")];

  it("ties a spec to the cards at its ends", () => {
    const [edge] = resolveEdges(nodes, [{ source: "a", target: "b", kind: DependencyEdge }]);
    expect(edge.source).toBe(nodes[0]);
    expect(edge.target).toBe(nodes[1]);
    expect(edge.id).toBe("a->b");
  });

  it("builds the kind the spec asks for", () => {
    const [dep, indirect] = resolveEdges(nodes, [
      { source: "a", target: "b", kind: DependencyEdge },
      { source: "b", target: "a", kind: IndirectDependencyEdge },
    ]);
    expect(dep).toBeInstanceOf(DependencyEdge);
    expect(indirect).toBeInstanceOf(IndirectDependencyEdge);
  });

  it("drops a spec naming a card the graph doesn't draw", () => {
    expect(resolveEdges(nodes, [
      { source: "a", target: "gone", kind: DependencyEdge },
      { source: "gone", target: "b", kind: DependencyEdge },
    ])).toEqual([]);
  });

  it("drops a card's edge to itself", () => {
    expect(resolveEdges(nodes, [{ source: "a", target: "a", kind: DependencyEdge }])).toEqual([]);
  });
});

describe("nearestEnd", () => {
  /** A line running left to right, from `a`'s right edge to `b`'s left. */
  const edge = new DependencyEdge(node("a", { x: 0, y: 0 }), node("b", { x: 400, y: 0 }));

  it("takes the prerequisite's end for a press in the first half", () => {
    expect(edge.nearestEnd({ x: NODE_WIDTH / 2 + 10, y: 0 })).toBe(EdgeEnd.Source);
  });

  it("takes the waiting task's end for a press in the second half", () => {
    expect(edge.nearestEnd({ x: 400 - NODE_WIDTH / 2 - 10, y: 0 })).toBe(EdgeEnd.Target);
  });

  it("answers for a press well off the line, the gesture having to mean something", () => {
    expect(edge.nearestEnd({ x: 0, y: 900 })).toBe(EdgeEnd.Source);
  });
});
