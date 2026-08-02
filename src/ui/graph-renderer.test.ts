// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { GraphRenderer, type GraphRendererOptions } from "./graph-renderer";
import { ProjectNode, TaskNode, NODE_HEIGHT, NODE_WIDTH, type GraphNode } from "./graph-node";
import { DependencyEdge, VirtualEdge, type GraphEdge } from "./graph-edge";
import { bagOf } from "./__testing__/dom-bag";

beforeAll(() => {
  bagOf(window).activeDocument = document;
  bagOf(HTMLElement.prototype).createDiv = function (this: HTMLElement, opts?: { cls?: string }) {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    this.appendChild(el);
    return el;
  };
});

const SPACING = { rankSep: 60, nodeSep: 20 };

/** A card carrying the controls the renderer refuses to drag from. */
function card(id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pm-node-card";
  el.dataset.taskId = id;
  const btn = document.createElement("button");
  btn.className = "pm-node-connect-btn";
  el.appendChild(btn);
  return el;
}

function build(over: Partial<GraphRendererOptions> = {}) {
  const a = new TaskNode({ id: "a", card: card("a") });
  const b = new TaskNode({ id: "b", card: card("b") });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new GraphRenderer({
    container,
    nodes: [a, b],
    edges: [new DependencyEdge(a, b)],
    spacing: SPACING,
    ...over,
  });
  return { renderer, container, a, b };
}

/** The wrapper a node drew, which is what carries the gesture. */
function wrapperOf(node: GraphNode): HTMLElement {
  return node.element!;
}

interface Init {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  pointerType?: string;
  button?: number;
  at?: number;
}

function evt(type: string, init: Init = {}): PointerEvent {
  const { at, ...rest } = init;
  const e = new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 0, clientY: 0, ...rest,
  });
  if (at !== undefined) Object.defineProperty(e, "timeStamp", { value: at, configurable: true });
  return e;
}

/** What follows a press reaches the renderer through the document, wherever it landed. */
function onDocument(type: string, target: Element, init: Init = {}): void {
  const e = evt(type, init);
  Object.defineProperty(e, "target", { value: target, configurable: true });
  document.dispatchEvent(e);
}

describe("drawing", () => {
  it("puts the edges under the cards, each in its own layer", () => {
    const { container } = build();
    const layers = [...container.children].map((c) => c.getAttribute("class"));
    expect(layers).toEqual(["pm-graph-edges", "pm-graph-nodes"]);
    expect(container.querySelectorAll(".pm-graph-node")).toHaveLength(2);
    expect(container.querySelectorAll(".pm-graph-edge")).toHaveLength(1);
  });

  it("lays the cards out before drawing them", () => {
    const { a, b } = build();
    expect(b.position.x).toBeGreaterThan(a.position.x);
  });

  it("puts a card where it was dragged to, in place of the layout's own slot", () => {
    const { a, b } = build({ storedPositions: { a: { x: 500, y: 400 } } });
    expect(a.position).toEqual({ x: 500, y: 400 });
    expect(b.position).not.toEqual({ x: 500, y: 400 });
  });

  it("ignores a stored position naming a card the graph doesn't draw", () => {
    const { a } = build({ storedPositions: { gone: { x: 500, y: 400 } } });
    expect(a.position).not.toEqual({ x: 500, y: 400 });
  });
});

describe("fit", () => {
  it("offsets the drawing so the graph starts at the padding", () => {
    const { renderer, a, container } = build();
    const size = renderer.fit(30);
    expect(renderer.renderedPosition(a).x).toBe(30 + NODE_WIDTH / 2);
    expect(size.width).toBeGreaterThan(NODE_WIDTH);
    expect(container.querySelector<HTMLElement>(".pm-graph-nodes")!.style.transform).toContain("translate");
  });

  it("reports the room the graph needs, padding on both sides", () => {
    const { renderer } = build();
    const bb = renderer.boundingBox();
    expect(renderer.fit(10)).toEqual({ width: Math.ceil(bb.w) + 20, height: Math.ceil(bb.h) + 20 });
  });
});

describe("what the graph hangs off", () => {
  it("tells the context cards from the ones the graph is about", () => {
    const proj = new ProjectNode({ id: "p", card: card("p") });
    const t = new TaskNode({ id: "t", card: card("t") });
    const { renderer } = build({ nodes: [proj, t], edges: [new VirtualEdge(proj, t)] });
    expect(renderer.contextNodes()).toEqual([proj]);
    expect(renderer.contentNodes()).toEqual([t]);
  });
});

describe("tap", () => {
  it("reports a press and release that never travels", () => {
    const onNodeTap = vi.fn();
    const { a } = build({ onNodeTap });
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointerup", el);
    expect(onNodeTap).toHaveBeenCalledTimes(1);
    expect(onNodeTap.mock.calls[0][0]).toBe(a);
  });

  it("hands back what the press landed on, not what the release did", () => {
    const onNodeTap = vi.fn();
    const { a, b } = build({ onNodeTap });
    const origin = a.card.querySelector(".pm-node-connect-btn")!;
    const pressed = evt("pointerdown");
    Object.defineProperty(pressed, "target", { value: origin, configurable: true });
    wrapperOf(a).dispatchEvent(pressed);
    // A connect drag is released over the other card; the tap still means the button.
    onDocument("pointerup", b.card);
    expect(onNodeTap.mock.calls[0][2]).toBe(origin);
  });

  it("ignores a press from anything but the primary button", () => {
    const onNodeTap = vi.fn();
    const { a } = build({ onNodeTap });
    wrapperOf(a).dispatchEvent(evt("pointerdown", { button: 2 }));
    onDocument("pointerup", a.card);
    expect(onNodeTap).not.toHaveBeenCalled();
  });

  it("reads two taps in quick succession as a double", () => {
    const onNodeDoubleTap = vi.fn();
    const { a } = build({ onNodeDoubleTap });
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown", { at: 0 }));
    onDocument("pointerup", el, { at: 0 });
    el.dispatchEvent(evt("pointerdown", { at: 100 }));
    onDocument("pointerup", el, { at: 100 });
    expect(onNodeDoubleTap).toHaveBeenCalledTimes(1);
  });

  it("leaves two taps far apart as two taps", () => {
    const onNodeDoubleTap = vi.fn();
    const { a } = build({ onNodeDoubleTap });
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown", { at: 0 }));
    onDocument("pointerup", el, { at: 0 });
    el.dispatchEvent(evt("pointerdown", { at: 900 }));
    onDocument("pointerup", el, { at: 900 });
    expect(onNodeDoubleTap).not.toHaveBeenCalled();
  });

  it("doesn't read a tap on one card and a tap on another as a double", () => {
    const onNodeDoubleTap = vi.fn();
    const { a, b } = build({ onNodeDoubleTap });
    wrapperOf(a).dispatchEvent(evt("pointerdown", { at: 0 }));
    onDocument("pointerup", wrapperOf(a), { at: 0 });
    wrapperOf(b).dispatchEvent(evt("pointerdown", { at: 100 }));
    onDocument("pointerup", wrapperOf(b), { at: 100 });
    expect(onNodeDoubleTap).not.toHaveBeenCalled();
  });
});

describe("drag", () => {
  it("moves the card once the press travels far enough", () => {
    const onNodeDragEnd = vi.fn();
    const { a } = build({ onNodeDragEnd });
    const start = { ...a.position };
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, { clientX: 40, clientY: 25 });
    expect(el.classList.contains("pm-graph-node--dragging")).toBe(true);
    expect(a.position).toEqual({ x: start.x + 40, y: start.y + 25 });
    onDocument("pointerup", el, { clientX: 40, clientY: 25 });
    expect(onNodeDragEnd).toHaveBeenCalledWith(a, { x: start.x + 40, y: start.y + 25 });
    expect(el.classList.contains("pm-graph-node--dragging")).toBe(false);
  });

  it("leaves a press that barely travels as a tap", () => {
    const onNodeTap = vi.fn();
    const onNodeDragEnd = vi.fn();
    const { a } = build({ onNodeTap, onNodeDragEnd });
    const start = { ...a.position };
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, { clientX: 2, clientY: 1 });
    onDocument("pointerup", el, { clientX: 2, clientY: 1 });
    expect(a.position).toEqual(start);
    expect(onNodeDragEnd).not.toHaveBeenCalled();
    expect(onNodeTap).toHaveBeenCalledTimes(1);
  });

  it("gives a finger further to travel than a mouse before it drags", () => {
    const { a } = build();
    const start = { ...a.position };
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown", { pointerType: "touch" }));
    onDocument("pointermove", el, { pointerType: "touch", clientX: 10, clientY: 0 });
    expect(a.position).toEqual(start);
    onDocument("pointermove", el, { pointerType: "touch", clientX: 30, clientY: 0 });
    expect(a.position.x).toBe(start.x + 30);
  });

  it("never drags from one of the card's own controls", () => {
    const onNodeTap = vi.fn();
    const { a } = build({ onNodeTap });
    const start = { ...a.position };
    const el = wrapperOf(a);
    const pressed = evt("pointerdown");
    Object.defineProperty(pressed, "target", {
      value: a.card.querySelector(".pm-node-connect-btn"), configurable: true,
    });
    el.dispatchEvent(pressed);
    onDocument("pointermove", el, { clientX: 200, clientY: 200 });
    expect(a.position).toEqual(start);
    expect(el.classList.contains("pm-graph-node--dragging")).toBe(false);
  });

  it("follows only the finger that started it", () => {
    const { a } = build();
    const start = { ...a.position };
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown", { pointerId: 1 }));
    // A second finger scrolling the page must not take the card with it.
    onDocument("pointermove", el, { pointerId: 2, clientX: 200, clientY: 200 });
    expect(a.position).toEqual(start);
    onDocument("pointerup", el, { pointerId: 2, clientX: 200, clientY: 200 });
    onDocument("pointermove", el, { pointerId: 1, clientX: 40, clientY: 0 });
    expect(a.position.x).toBe(start.x + 40);
  });

  it("puts the card back when the gesture is cancelled", () => {
    const onNodeDragEnd = vi.fn();
    const { a } = build({ onNodeDragEnd });
    const start = { ...a.position };
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, { clientX: 40, clientY: 40 });
    onDocument("pointercancel", el);
    expect(a.position).toEqual(start);
    expect(el.classList.contains("pm-graph-node--dragging")).toBe(false);
    expect(onNodeDragEnd).not.toHaveBeenCalled();
  });

  it("drags the edges along with the card", () => {
    const { a, container } = build();
    const line = container.querySelector<SVGLineElement>(".pm-graph-edge")!;
    const before = line.getAttribute("y1");
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, { clientX: 0, clientY: 60 });
    expect(line.getAttribute("y1")).not.toBe(before);
  });
});

describe("dropping a card on another", () => {
  /** The travel that lands `from`'s centre inside `to`'s box. */
  function ontoDelta(from: GraphNode, to: GraphNode) {
    return { clientX: to.position.x - from.position.x, clientY: to.position.y - from.position.y };
  }

  function buildDroppable(answer = () => true) {
    const canDrop = vi.fn(answer);
    const onDrop = vi.fn();
    const onNodeDragEnd = vi.fn();
    const built = build({ nodeDrop: { canDrop, onDrop }, onNodeDragEnd });
    return { ...built, canDrop, onDrop, onNodeDragEnd };
  }

  it("marks the card the drop would land on while the drag is over it", () => {
    const { a, b } = buildDroppable();
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, ontoDelta(a, b));
    expect(b.card.classList.contains("pm-drop-target")).toBe(true);
    // Dragged off again, the mark goes with it.
    onDocument("pointermove", el, { clientX: 0, clientY: 1000 });
    expect(b.card.classList.contains("pm-drop-target")).toBe(false);
  });

  it("asks once about a card the drag keeps crossing", () => {
    const { a, b, canDrop } = buildDroppable();
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    const onto = ontoDelta(a, b);
    // Over it, off it, over it again: the answer can't have changed mid-gesture.
    onDocument("pointermove", el, onto);
    onDocument("pointermove", el, { clientX: onto.clientX + 1, clientY: onto.clientY });
    onDocument("pointermove", el, { clientX: 0, clientY: 1000 });
    onDocument("pointermove", el, onto);
    expect(canDrop).toHaveBeenCalledTimes(1);
    expect(b.card.classList.contains("pm-drop-target")).toBe(true);
  });

  it("leaves the card where it started and reports the drop", () => {
    const { a, b, onDrop, onNodeDragEnd } = buildDroppable();
    const start = { ...a.position };
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    const delta = ontoDelta(a, b);
    onDocument("pointermove", el, delta);
    onDocument("pointerup", el, delta);
    expect(onDrop).toHaveBeenCalledWith(a, b);
    expect(onNodeDragEnd).not.toHaveBeenCalled();
    expect(a.position).toEqual(start);
    expect(b.card.classList.contains("pm-drop-target")).toBe(false);
  });

  it("takes a card the drop is refused for as a plain move", () => {
    const { a, b, onDrop, onNodeDragEnd } = buildDroppable(() => false);
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    const delta = ontoDelta(a, b);
    onDocument("pointermove", el, delta);
    expect(b.card.classList.contains("pm-drop-target")).toBe(false);
    onDocument("pointerup", el, delta);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onNodeDragEnd).toHaveBeenCalledTimes(1);
  });

  it("drops nothing when the gesture is cancelled over a card", () => {
    const { a, b, onDrop } = buildDroppable();
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, ontoDelta(a, b));
    onDocument("pointercancel", el);
    expect(onDrop).not.toHaveBeenCalled();
    expect(b.card.classList.contains("pm-drop-target")).toBe(false);
  });
});

describe("the context column as a drop target", () => {
  /** A project heading and one card hanging off it: a context column, and a divide. */
  function buildWithContext(canDrop = () => true) {
    const proj = new ProjectNode({ id: "p", card: card("p") });
    const t = new TaskNode({ id: "t", card: card("t") });
    const onDrop = vi.fn();
    const onNodeDragEnd = vi.fn();
    const { container } = build({
      nodes: [proj, t],
      edges: [new VirtualEdge(proj, t)],
      nodeDrop: { canDrop, onDrop },
      onNodeDragEnd,
    });
    return { container, proj, t, onDrop, onNodeDragEnd };
  }

  /** Well left of the divide, and clear of the context card's own box. */
  const intoColumn = (from: GraphNode, context: GraphNode) => ({
    clientX: context.position.x - NODE_WIDTH - 100 - from.position.x,
    clientY: 0,
  });

  it("lands a card dragged into the column on the card that heads it", () => {
    const { container, proj, t, onDrop, onNodeDragEnd } = buildWithContext();
    const el = wrapperOf(t);
    el.dispatchEvent(evt("pointerdown"));
    const delta = intoColumn(t, proj);
    onDocument("pointermove", el, delta);
    expect(proj.card.classList.contains("pm-drop-target")).toBe(true);
    const zone = container.querySelector<HTMLElement>(".pm-graph-drop-zone");
    expect(zone).not.toBeNull();
    expect(parseFloat(zone!.style.width)).toBeGreaterThan(0);
    // Drawn over the band and under the cards: it tints the column, it doesn't cover it.
    expect(container.firstElementChild!.className).toBe("pm-graph-band");
    expect(container.firstElementChild!.nextElementSibling).toBe(zone);

    onDocument("pointerup", el, delta);
    expect(onDrop).toHaveBeenCalledWith(t, proj);
    expect(onNodeDragEnd).not.toHaveBeenCalled();
    expect(container.querySelector(".pm-graph-drop-zone")).toBeNull();
  });

  it("paints nothing for a card that stays on its own side of the divide", () => {
    const { container, t, onDrop } = buildWithContext();
    const el = wrapperOf(t);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, { clientX: 0, clientY: 200 });
    expect(container.querySelector(".pm-graph-drop-zone")).toBeNull();
    onDocument("pointerup", el, { clientX: 0, clientY: 200 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("leaves a column the drop is refused for alone, and the card where it was", () => {
    const { container, proj, t, onDrop, onNodeDragEnd } = buildWithContext(() => false);
    const el = wrapperOf(t);
    const before = { ...t.position };
    el.dispatchEvent(evt("pointerdown"));
    const delta = intoColumn(t, proj);
    onDocument("pointermove", el, delta);
    expect(container.querySelector(".pm-graph-drop-zone")).toBeNull();
    onDocument("pointerup", el, delta);
    expect(onDrop).not.toHaveBeenCalled();
    // The column belongs to the band: a card the drop was refused for has no place there.
    expect(onNodeDragEnd).not.toHaveBeenCalled();
    expect(t.position).toEqual(before);
  });

  it("never drags a card of the band out of it", () => {
    const { proj, t, onNodeDragEnd } = buildWithContext();
    const el = wrapperOf(proj);
    const before = { ...proj.position };
    el.dispatchEvent(evt("pointerdown"));
    const delta = { clientX: t.position.x + NODE_WIDTH, clientY: 0 };
    onDocument("pointermove", el, delta);
    onDocument("pointerup", el, delta);
    expect(onNodeDragEnd).not.toHaveBeenCalled();
    expect(proj.position).toEqual(before);
  });

  it("stops a card dragged towards the band at the divide", () => {
    const { container, proj, t } = buildWithContext();
    const el = wrapperOf(t);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, intoColumn(t, proj));
    // The gesture reached over the band — the card only reached its edge.
    expect(container.querySelector(".pm-graph-drop-zone")).not.toBeNull();
    expect(t.left).toBeGreaterThanOrEqual(proj.position.x + NODE_WIDTH / 2);
  });

  it("reads no stored position for a card of the band", () => {
    const proj = new ProjectNode({ id: "p", card: card("p") });
    const t = new TaskNode({ id: "t", card: card("t") });
    build({
      nodes: [proj, t],
      edges: [new VirtualEdge(proj, t)],
      // Far right of anywhere the layout would put the card that heads the column.
      storedPositions: { p: { x: 5000, y: 0 } },
    });
    expect(proj.position.x).toBeLessThan(t.position.x);
  });

  it("holds a card whose stored position falls in the band out of it", () => {
    const proj = new ProjectNode({ id: "p", card: card("p") });
    const t = new TaskNode({ id: "t", card: card("t") });
    const { container } = build({
      nodes: [proj, t],
      edges: [new VirtualEdge(proj, t)],
      storedPositions: { t: { x: -500, y: 0 } },
    });
    expect(t.left).toBeGreaterThanOrEqual(proj.position.x + NODE_WIDTH / 2);
    // And the band is painted, so the two areas read as two.
    expect(container.querySelector(".pm-graph-band")).not.toBeNull();
  });

  it("never drops the context card into its own column", () => {
    const { proj, onDrop } = buildWithContext();
    const el = wrapperOf(proj);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, { clientX: -400, clientY: 0 });
    onDocument("pointerup", el, { clientX: -400, clientY: 0 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("reports the divide in container coordinates, once fit has offset the drawing", () => {
    const proj = new ProjectNode({ id: "p", card: card("p") });
    const t = new TaskNode({ id: "t", card: card("t") });
    const { renderer } = build({ nodes: [proj, t], edges: [new VirtualEdge(proj, t)] });
    renderer.fit(30);
    const divide = renderer.contextDivideX()!;
    expect(divide).toBeGreaterThan(renderer.renderedPosition(proj).x + NODE_WIDTH / 2);
    expect(divide).toBeLessThan(renderer.renderedPosition(t).x - NODE_WIDTH / 2);
  });

  it("has no divide to report where nothing heads the cards", () => {
    const { renderer } = build();
    expect(renderer.contextDivideX()).toBeNull();
  });
});

describe("destroy", () => {
  it("takes both layers and everything drawn in them off the page", () => {
    const { renderer, container } = build();
    renderer.destroy();
    expect(container.children).toHaveLength(0);
  });

  it("stops listening once destroyed", () => {
    const onNodeTap = vi.fn();
    const { renderer, a } = build({ onNodeTap });
    const el = wrapperOf(a);
    renderer.destroy();
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointerup", el);
    expect(onNodeTap).not.toHaveBeenCalled();
  });

  it("drops a finished gesture rather than piling them up", () => {
    const { renderer, a } = build();
    const el = wrapperOf(a);
    for (let i = 0; i < 5; i++) {
      el.dispatchEvent(evt("pointerdown"));
      onDocument("pointerup", el);
    }
    // One press handler per card stays; the five gestures took themselves off again.
    expect(bagOf(renderer).teardown).toHaveLength(2);
  });
});

describe("edges", () => {
  it("reports a right-click on an edge", () => {
    const onEdgeContextMenu = vi.fn();
    const a = new TaskNode({ id: "a", card: card("a") });
    const b = new TaskNode({ id: "b", card: card("b") });
    const edge: GraphEdge = new DependencyEdge(a, b);
    const { container } = build({ nodes: [a, b], edges: [edge], onEdgeContextMenu });
    container.querySelector(".pm-graph-edge-hit")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onEdgeContextMenu.mock.calls[0][0]).toBe(edge);
  });
});

describe("node geometry", () => {
  it("draws each card at the top left of the box its centre gives", () => {
    const { a } = build();
    const el = wrapperOf(a);
    expect(el.style.left).toBe(`${a.position.x - NODE_WIDTH / 2}px`);
    expect(el.style.top).toBe(`${a.position.y - NODE_HEIGHT / 2}px`);
  });
});
