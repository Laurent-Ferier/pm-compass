// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { GraphRenderer, type GraphRendererOptions } from "./graph-renderer";
import { Box, ContainerNode, ProjectNode, TaskNode, NODE_HEIGHT, NODE_WIDTH, type GraphNode } from "./graph-node";
import { DependencyEdge, EdgeEnd, type GraphEdge } from "./graph-edge";
import { bagOf } from "./__testing__/dom-bag";

beforeAll(() => {
  bagOf(window).activeDocument = document;
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
    // A frame stands behind the lines, the lines behind the cards.
    expect(layers).toEqual(["pm-graph-backdrop", "pm-graph-edges", "pm-graph-nodes"]);
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
    const { renderer, container } = build();
    const box = renderer.boundingBox();
    const size = renderer.fit(30);
    expect(size.width).toBeGreaterThan(NODE_WIDTH);
    expect(container.querySelector<HTMLElement>(".pm-graph-nodes")!.style.transform)
      .toBe(`translate(${30 - box.left}px, ${30 - box.top}px)`);
  });

  it("reports the room the graph needs, padding on both sides", () => {
    const { renderer } = build();
    const box = renderer.boundingBox();
    expect(renderer.fit(10))
      .toEqual({ width: Math.ceil(box.width) + 20, height: Math.ceil(box.height) + 20 });
  });
});

describe("the cards it holds", () => {
  it("never drags a card nothing places by hand", () => {
    const onNodeDragEnd = vi.fn();
    const proj = new ProjectNode({ id: "p", projectId: "p", card: card("p") });
    const frame = new ContainerNode({ id: "container:a", card: card("a") });
    build({ nodes: [proj, frame], edges: [], onNodeDragEnd });
    for (const node of [proj, frame]) {
      const before = { ...node.position };
      const el = wrapperOf(node);
      el.dispatchEvent(evt("pointerdown"));
      onDocument("pointermove", el, { clientX: 300, clientY: 300 });
      onDocument("pointerup", el, { clientX: 300, clientY: 300 });
      expect(node.position).toEqual(before);
    }
    expect(onNodeDragEnd).not.toHaveBeenCalled();
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

describe("dropping onto something outside the drawing", () => {
  /** What the caller asks such an element to be marked with — its own, not the cards'. */
  const MARK = "pm-outside-drop";

  /** A box a rect-based hit test can find. jsdom lays nothing out, so every rect a gesture
   *  is judged against has to be spelled out. */
  function boxed(el: HTMLElement, box: { x: number; y: number; w: number; h: number }): HTMLElement {
    el.getBoundingClientRect = () => ({
      left: box.x, right: box.x + box.w, top: box.y, bottom: box.y + box.h,
      width: box.w, height: box.h, x: box.x, y: box.y, toJSON: () => ({}),
    });
    return el;
  }

  /** Two elements away from the drawing, the second the one a drop is refused for. */
  function buildWithOutside(over: Partial<GraphRendererOptions> = {}) {
    const takes = boxed(document.createElement("span"), { x: 0, y: -100, w: 60, h: 20 });
    const refuses = boxed(document.createElement("span"), { x: 80, y: -100, w: 60, h: 20 });
    const onDrop = vi.fn();
    const built = build({
      outsideDrop: { targets: () => [takes, refuses], markClass: MARK, canDrop: (_n, el) => el === takes, onDrop },
      ...over,
    });
    return { ...built, takes, refuses, onDrop };
  }

  /** A drag ending with the pointer inside the box `at` names. */
  const onto = (at: { x: number; y: number }) => ({ clientX: at.x, clientY: at.y });

  it("marks the element the pointer is over and reports the drop", () => {
    const { a, takes, onDrop } = buildWithOutside();
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 30, y: -90 }));
    expect(takes.classList.contains(MARK)).toBe(true);

    onDocument("pointerup", el, onto({ x: 30, y: -90 }));
    expect(onDrop).toHaveBeenCalledWith(a, takes);
    expect(takes.classList.contains(MARK)).toBe(false);
  });

  it("puts the card back where it started rather than reporting a position", () => {
    const onNodeDragEnd = vi.fn();
    const { a, onDrop } = buildWithOutside({ onNodeDragEnd });
    const el = wrapperOf(a);
    const before = { ...a.position };
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 30, y: -90 }));
    onDocument("pointerup", el, onto({ x: 30, y: -90 }));

    expect(onDrop).toHaveBeenCalled();
    expect(onNodeDragEnd).not.toHaveBeenCalled();
    expect(a.position).toEqual(before);
  });

  it("leaves an element the drop is refused for unmarked", () => {
    const { a, refuses, onDrop } = buildWithOutside();
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 100, y: -90 }));
    expect(refuses.classList.contains(MARK)).toBe(false);
    onDocument("pointerup", el, onto({ x: 100, y: -90 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("takes what lies outside over a card the dragged one happens to cover", () => {
    const onDrop = vi.fn();
    const nodeDrop = { canDrop: () => true, onDrop: vi.fn() };
    // Wide enough to lie above the whole drawing, which is what a breadcrumb bar does.
    const takes = boxed(document.createElement("span"), { x: -1000, y: -100, w: 2000, h: 20 });
    const { a, b } = build({
      nodeDrop,
      outsideDrop: { targets: () => [takes], markClass: MARK, canDrop: () => true, onDrop },
    });
    const el = wrapperOf(a);
    // The card lands square on `b`, while the pointer has gone up onto the element.
    el.dispatchEvent(evt("pointerdown"));
    const over = { clientX: b.position.x - a.position.x, clientY: -90 };
    onDocument("pointermove", el, over);
    onDocument("pointerup", el, over);

    expect(onDrop).toHaveBeenCalledWith(a, takes);
    expect(nodeDrop.onDrop).not.toHaveBeenCalled();
  });

  it("keeps the card inside the container while the gesture goes on past it", () => {
    const { a } = buildWithOutside();
    const el = wrapperOf(a);
    const top = a.top;
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 30, y: -400 }));
    // The gesture reached the element above; the card stopped at the container's edge.
    expect(a.top).toBeGreaterThanOrEqual(top - NODE_HEIGHT);
  });

  it("restores rather than saving when a drag ends up on the bar with nothing to drop on", () => {
    const onNodeDragEnd = vi.fn();
    const { a, container } = buildWithOutside({ onNodeDragEnd });
    boxed(container, { x: 0, y: 0, w: 500, h: 400 });
    const el = wrapperOf(a);
    const before = { ...a.position };
    // Above the container, and clear of both elements a drop could land on.
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 300, y: -90 }));
    onDocument("pointerup", el, onto({ x: 300, y: -90 }));

    expect(onNodeDragEnd).not.toHaveBeenCalled();
    expect(a.position).toEqual(before);
  });

  // The drawing is only as big as the cards in it, so every card put at its edge would
  // otherwise be a gesture ending outside — and silently thrown away.
  it("saves a card carried past the bottom of the drawing, which is a placement", () => {
    const onNodeDragEnd = vi.fn();
    const { a, container } = buildWithOutside({ onNodeDragEnd });
    boxed(container, { x: 0, y: 0, w: 500, h: 400 });
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 300, y: 900 }));
    onDocument("pointerup", el, onto({ x: 300, y: 900 }));

    expect(onNodeDragEnd).toHaveBeenCalledWith(a, a.position);
  });

  it("saves one carried past the right edge just the same", () => {
    const onNodeDragEnd = vi.fn();
    const { a, container } = buildWithOutside({ onNodeDragEnd });
    boxed(container, { x: 0, y: 0, w: 500, h: 400 });
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 900, y: 200 }));
    onDocument("pointerup", el, onto({ x: 900, y: 200 }));

    expect(onNodeDragEnd).toHaveBeenCalledWith(a, a.position);
  });

  it("asks whether an element takes the card once per gesture, not once per frame", () => {
    const canDrop = vi.fn(() => true);
    const takes = boxed(document.createElement("span"), { x: 0, y: -100, w: 60, h: 20 });
    const { a } = build({ outsideDrop: { targets: () => [takes], markClass: MARK, canDrop, onDrop: vi.fn() } });
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    for (let i = 0; i < 5; i++) onDocument("pointermove", el, onto({ x: 30 + i, y: -90 }));

    // Nothing it reads changes while the gesture is on, and what it reads walks the tree.
    expect(canDrop).toHaveBeenCalledTimes(1);
  });

  it("takes its mark off an outside element when the graph is destroyed under the gesture", () => {
    const { renderer, a, takes } = buildWithOutside();
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, onto({ x: 30, y: -90 }));
    expect(takes.classList.contains(MARK)).toBe(true);

    renderer.destroy();
    expect(takes.classList.contains(MARK)).toBe(false);
  });

});

describe("where the cards go", () => {
  it("lays them out with layoutGraph unless told otherwise", () => {
    const { a, b } = build();
    expect(b.position.x).toBeGreaterThan(a.position.x);
  });

  it("uses the placement it was given instead", () => {
    const layout = vi.fn((nodes: GraphNode[]) => {
      for (const n of nodes) n.position = { x: 7, y: 9 };
    });
    const { a, b } = build({ layout });
    expect(layout).toHaveBeenCalled();
    expect([a.position, b.position]).toEqual([{ x: 7, y: 9 }, { x: 7, y: 9 }]);
  });

  it("reads a stored position only for a card a drag can place", () => {
    // A frame is sized round its cards, so a place stored against it says nothing.
    const frame = new ContainerNode({ id: "container:a", card: card("a") });
    const t = new TaskNode({ id: "t", card: card("t") });
    build({
      nodes: [frame, t],
      edges: [],
      storedPositions: { "container:a": { x: 5000, y: 5000 }, t: { x: 400, y: 300 } },
    });
    expect(t.position).toEqual({ x: 400, y: 300 });
    expect(frame.position.x).not.toBe(5000);
  });

  it("keeps a place stored for a card standing for a task beyond the level", () => {
    const ext = new TaskNode({ id: "x-ext", taskId: "x", isExternal: true, card: card("x") });
    build({ nodes: [ext], edges: [], storedPositions: { "x-ext": { x: 500, y: 300 } } });
    expect(ext.position).toEqual({ x: 500, y: 300 });
  });

  it("places the cards again on request, without rebuilding what it drew", () => {
    let column = 0;
    const layout = vi.fn((nodes: GraphNode[]) => {
      for (const n of nodes) n.position = { x: column, y: 0 };
    });
    const { renderer, a, container } = build({ layout });
    const wrapper = wrapperOf(a);
    const edge = container.querySelector(".pm-graph-edge")!;

    column = 250;
    renderer.relayout();

    expect(a.position.x).toBe(250);
    expect(wrapper.style.left).toBe(`${250 - NODE_WIDTH / 2}px`);
    // The same wrapper and the same line — a reflow moves cards, it doesn't redraw them.
    expect(wrapperOf(a)).toBe(wrapper);
    expect(container.querySelector(".pm-graph-edge")).toBe(edge);
  });

  it("puts a dragged-to position back on top when it places them again", () => {
    const { renderer, a } = build({ storedPositions: { a: { x: 700, y: 500 } } });
    renderer.relayout();
    expect(a.position).toEqual({ x: 700, y: 500 });
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

describe("what is sized off where the cards ended up", () => {
  /** A frame is one card holding every other: the shape `settle` exists for. */
  function frameAround(nodes: GraphNode[]): TaskNode {
    const f = new TaskNode({ id: "frame", card: card("frame") });
    f.box = Box.around(nodes);
    return f;
  }

  it("runs once the stored positions are in, not before", () => {
    const seen: number[] = [];
    build({
      storedPositions: { a: { x: 900, y: 0 } },
      settle: (nodes) => { seen.push(nodes.find((n) => n.id === "a")!.position.x); },
    });
    expect(seen).toEqual([900]);
  });

  it("runs again with the layout when the cards are placed afresh", () => {
    const settle = vi.fn();
    const { renderer } = build({ settle });
    renderer.relayout();
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("follows a card being dragged, so what is sized off it keeps up", () => {
    const { a, b } = build({ settle: (nodes) => { nodes[1].box = Box.around([nodes[0]]); } });
    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    onDocument("pointermove", el, { clientX: 300, clientY: 0 });
    expect(b.box.centre.x).toBe(a.position.x);
  });

  it("does not shadow a real drop target with the card holding every other", () => {
    // Whatever is drawn around the rest contains every card's centre; the smallest box
    // containing the drop is the one that means something.
    const a = new TaskNode({ id: "a", card: card("a") });
    const b = new TaskNode({ id: "b", card: card("b") });
    const onDrop = vi.fn();
    const frame = frameAround([a, b]);
    build({
      nodes: [frame, a, b],
      edges: [],
      layout: (nodes) => {
        nodes.find((n) => n.id === "a")!.position = { x: 0, y: 0 };
        nodes.find((n) => n.id === "b")!.position = { x: 400, y: 0 };
      },
      settle: (nodes) => { nodes[0].box = Box.around(nodes.slice(1)); },
      nodeDrop: { canDrop: () => true, onDrop },
    });

    const el = wrapperOf(a);
    el.dispatchEvent(evt("pointerdown"));
    const delta = { clientX: b.position.x - a.position.x, clientY: 0 };
    onDocument("pointermove", el, delta);
    onDocument("pointerup", el, delta);

    expect(onDrop.mock.calls[0][1]).toBe(b);
  });
});

describe("carrying one end of a line to another card", () => {
  function buildRepointable(answer: (t: GraphNode) => boolean = () => true) {
    const canDrop = vi.fn((_e: GraphEdge, _end: EdgeEnd, t: GraphNode) => answer(t));
    const onDrop = vi.fn();
    const a = new TaskNode({ id: "a", card: card("a") });
    const b = new TaskNode({ id: "b", card: card("b") });
    const c = new TaskNode({ id: "c", card: card("c") });
    const edge: GraphEdge = new DependencyEdge(a, b);
    const built = build({
      nodes: [a, b, c],
      edges: [edge],
      layout: (nodes) => {
        const at: Record<string, { x: number; y: number }> = {
          a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 0, y: 300 },
        };
        for (const n of nodes) n.position = at[n.id];
      },
      edgeRepoint: { canDrop, onDrop },
    });
    return { ...built, a, b, c, edge, canDrop, onDrop };
  }

  /** The stroke a pointer actually hits, which is where the gesture starts. */
  function hitOf(container: HTMLElement): Element {
    return container.querySelector(".pm-graph-edge-hit")!;
  }

  /** Presses the line at a point in layout space, the container sitting at the origin. */
  function pressAt(container: HTMLElement, at: { x: number; y: number }): void {
    hitOf(container).dispatchEvent(evt("pointerdown", { clientX: at.x, clientY: at.y }));
  }

  it("takes hold of the end pressed and reports where it was carried", () => {
    const { container, b, c, edge, onDrop } = buildRepointable();
    pressAt(container, b.exitTowards({ x: 0, y: 0 }));
    onDocument("pointermove", container, { clientX: c.position.x, clientY: c.position.y });
    onDocument("pointerup", container, { clientX: c.position.x, clientY: c.position.y });

    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop.mock.calls[0].slice(0, 3)).toEqual([edge, EdgeEnd.Target, c]);
  });

  it("takes the other end for a press at the other end", () => {
    const { container, a, b, c, onDrop } = buildRepointable();
    pressAt(container, a.exitTowards(b.position));
    onDocument("pointermove", container, { clientX: c.position.x, clientY: c.position.y });
    onDocument("pointerup", container, { clientX: c.position.x, clientY: c.position.y });

    expect(onDrop.mock.calls[0][1]).toBe(EdgeEnd.Source);
  });

  it("takes the nearer end for a press anywhere along the line", () => {
    // The whole line is a grab; which half was pressed says which end was meant.
    const { container, c, edge, onDrop } = buildRepointable();
    pressAt(container, { x: 260, y: 0 });
    onDocument("pointermove", container, { clientX: c.position.x, clientY: c.position.y });
    onDocument("pointerup", container, { clientX: c.position.x, clientY: c.position.y });

    expect(onDrop.mock.calls[0].slice(0, 3)).toEqual([edge, EdgeEnd.Target, c]);
  });

  it("draws a line to the pointer while the end is being carried, and takes it away after", () => {
    const { container, b, c } = buildRepointable();
    pressAt(container, b.exitTowards({ x: 0, y: 0 }));
    onDocument("pointermove", container, { clientX: c.position.x, clientY: c.position.y });
    expect(container.querySelectorAll(".pm-graph-edge--dragging")).toHaveLength(1);

    onDocument("pointerup", container, { clientX: c.position.x, clientY: c.position.y });
    expect(container.querySelectorAll(".pm-graph-edge--dragging")).toHaveLength(0);
  });

  it("marks the card the end would land on, and only one it may", () => {
    const { container, b, c, a } = buildRepointable((t) => t !== a);
    pressAt(container, b.exitTowards({ x: 0, y: 0 }));

    onDocument("pointermove", container, { clientX: c.position.x, clientY: c.position.y });
    expect(c.card.classList.contains("pm-connect-target")).toBe(true);

    onDocument("pointermove", container, { clientX: a.position.x, clientY: a.position.y });
    expect(c.card.classList.contains("pm-connect-target")).toBe(false);
    expect(a.card.classList.contains("pm-connect-target")).toBe(false);
  });

  it("reports nothing when the end is let go over open room", () => {
    const { container, b, onDrop } = buildRepointable();
    pressAt(container, b.exitTowards({ x: 0, y: 0 }));
    onDocument("pointermove", container, { clientX: 5000, clientY: 5000 });
    onDocument("pointerup", container, { clientX: 5000, clientY: 5000 });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("asks once about a card the gesture keeps crossing", () => {
    const { container, b, c, canDrop } = buildRepointable();
    pressAt(container, b.exitTowards({ x: 0, y: 0 }));
    for (const at of [c.position, { x: 5000, y: 5000 }, c.position]) {
      onDocument("pointermove", container, { clientX: at.x, clientY: at.y });
    }
    expect(canDrop).toHaveBeenCalledTimes(1);
  });

  it("is driven by the pointer that started it and no other", () => {
    const { container, b, c, onDrop } = buildRepointable();
    pressAt(container, b.exitTowards({ x: 0, y: 0 }));
    // A second finger elsewhere on the page mustn't carry the end with it.
    onDocument("pointermove", container, { clientX: c.position.x, clientY: c.position.y, pointerId: 2 });
    onDocument("pointerup", container, { clientX: c.position.x, clientY: c.position.y, pointerId: 2 });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("leaves nothing behind when the gesture is cancelled", () => {
    const { container, b, c, onDrop } = buildRepointable();
    pressAt(container, b.exitTowards({ x: 0, y: 0 }));
    onDocument("pointermove", container, { clientX: c.position.x, clientY: c.position.y });
    onDocument("pointercancel", container, { clientX: c.position.x, clientY: c.position.y });

    expect(onDrop).not.toHaveBeenCalled();
    expect(c.card.classList.contains("pm-connect-target")).toBe(false);
    expect(container.querySelectorAll(".pm-graph-edge--dragging")).toHaveLength(0);
  });

  it("does nothing at all when the level takes no re-pointing", () => {
    const { container } = build();
    pressAt(container, { x: 0, y: 0 });
    expect(container.querySelectorAll(".pm-graph-edge--dragging")).toHaveLength(0);
  });
});
