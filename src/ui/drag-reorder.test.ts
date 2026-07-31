// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { bagOf } from "./__testing__/dom-bag";
import { pointerEvent } from "./__testing__/drag-pointer";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills — jsdom lacks the createEl/addClass/setCssProps helpers
// Obsidian adds to HTMLElement, and the `activeDocument`/`activeWindow` globals.
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  const proto = bagOf(HTMLElement.prototype);
  type Opts = { cls?: string; attr?: Record<string, string> };
  proto.createEl = function (this: HTMLElement, tag: string, opts?: Opts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: Opts) { return this.createEl("div", opts); };
  proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  bagOf(window).activeDocument = document;
  bagOf(window).activeWindow = window;
}

vi.mock("obsidian", () => ({ setIcon: () => {} }));

import { createDragReorder, renderInertDragHandle, type ReorderDrop } from "./drag-reorder";

// ---------------------------------------------------------------------------
// Frame loop and geometry, both under the test's control
//
// jsdom reports a zero rect for everything and never paints, so rows are given
// their rects by hand and `requestAnimationFrame` is a queue the test steps.
// ---------------------------------------------------------------------------

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

/** Run every frame currently due. `tick` re-queues itself, so this is one frame, not a loop. */
function runFrame(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
}

function stampRect(el: HTMLElement, top: number, height: number): void {
  el.getBoundingClientRect = () => ({
    top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  });
}

/** Gives `el` the scroll geometry jsdom won't: a settable `scrollTop` over a fixed size. */
function makeScrollable(el: HTMLElement, overflowY: string, scrollHeight: number, clientHeight: number): void {
  el.style.overflowY = overflowY;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  let scrollTop = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => { scrollTop = v; },
    configurable: true,
  });
}

const ROW_H = 20; // rows at y 0-20, 20-40, 40-60 — midpoints 10, 30, 50

interface Harness {
  host: HTMLElement;
  list: HTMLElement;
  rows: HTMLElement[];
  handles: HTMLElement[];
  drops: ReorderDrop<string>[];
}

/** A `count`-row list of rows named "r0", "r1", … each `ROW_H` tall and stacked from y=0. */
function buildList(opts: { tag?: string; count?: number; inert?: number[] } = {}): Harness {
  const count = opts.count ?? 3;
  const host = document.createElement("div");
  document.body.appendChild(host);

  const list = document.createElement(opts.tag ?? "div");
  host.appendChild(list);
  stampRect(list, 0, count * ROW_H);

  const drops: ReorderDrop<string>[] = [];
  const addHandle = createDragReorder<string>(list, (d) => drops.push(d));

  const rows: HTMLElement[] = [];
  const handles: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const row = document.createElement(opts.tag === "ul" ? "li" : "div");
    list.appendChild(row);
    stampRect(row, i * ROW_H, ROW_H);
    addHandle(row, row, `r${i}`, !opts.inert?.includes(i));
    rows.push(row);
    handles.push(row.firstElementChild as HTMLElement);
  }
  return { host, list, rows, handles, drops };
}

const press = (handle: HTMLElement, y = 0, opts?: Parameters<typeof pointerEvent>[2]) =>
  handle.dispatchEvent(pointerEvent("pointerdown", y, opts));
const move = (y: number, opts?: Parameters<typeof pointerEvent>[2]) =>
  document.dispatchEvent(pointerEvent("pointermove", y, opts));
const release = (y: number, opts?: Parameters<typeof pointerEvent>[2]) =>
  document.dispatchEvent(pointerEvent("pointerup", y, opts));
const cancel = (y: number) => document.dispatchEvent(pointerEvent("pointercancel", y));

const indicator = () => document.querySelector<HTMLElement>(".pm-reorder-indicator");
const indicatorTop = () => indicator()?.style.getPropertyValue("--pm-reorder-top");
const offsetOf = (row: HTMLElement) => row.style.getPropertyValue("--pm-reorder-offset");

beforeAll(() => { installObsidianDOMPolyfills(); });

beforeEach(() => {
  frames.clear();
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id: number) => { frames.delete(id); };
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------

describe("the grip handle", () => {
  it("renders an inert grip that carries no label of its own", () => {
    const parent = document.createElement("div");
    renderInertDragHandle(parent);

    const handle = parent.firstElementChild as HTMLElement;
    expect(handle.className).toContain("pm-reorder-handle--inert");
    expect(handle.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives an unreorderable row the inert grip and no drag", () => {
    const h = buildList({ inert: [0] });
    expect(h.handles[0].className).toContain("pm-reorder-handle--inert");

    press(h.handles[0]);
    move(100);
    release(100);

    expect(h.list.className).not.toContain("pm-reorder-list--dragging");
    expect(h.drops).toEqual([]);
  });

  it("keeps a press that never became a drag from reaching the row", () => {
    const h = buildList();
    const onClick = vi.fn();
    h.list.addEventListener("click", onClick);

    h.handles[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("what does and doesn't start a drag", () => {
  it("ignores a press under the threshold — a tap is not a drag", () => {
    const h = buildList();
    press(h.handles[0]);
    move(2);
    release(2);

    expect(indicator()).toBeNull();
    expect(h.drops).toEqual([]);
  });

  it("ignores a right-click on the grip", () => {
    const h = buildList();
    press(h.handles[0], 0, { button: 2 });
    move(100);
    release(100);

    expect(h.drops).toEqual([]);
  });

  it("drags from a touch, whose button field means nothing", () => {
    const h = buildList();
    press(h.handles[0], 0, { pointerType: "touch", button: 2 });
    move(100);
    release(100);

    expect(h.drops).toHaveLength(1);
  });

  it("ignores a second press while a drag is running", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35);
    press(h.handles[2], 35, { pointerId: 9 });
    release(35);

    expect(h.drops).toEqual([{ item: "r0", prev: "r1", next: "r2" }]);
  });

  it("ignores a pointer that isn't the one being dragged", () => {
    const h = buildList();
    press(h.handles[0]);
    move(100, { pointerId: 7 });
    release(100, { pointerId: 7 });

    // Neither the move nor the release counted: the drag is still waiting on pointer 1.
    expect(indicator()).toBeNull();
    expect(h.drops).toEqual([]);
  });
});

describe("where a drag lands", () => {
  it("reports the neighbours it was dropped between", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35); // past r1's midpoint (30), short of r2's (50)
    release(35);

    expect(h.drops).toEqual([{ item: "r0", prev: "r1", next: "r2" }]);
  });

  it("reports a null next at the end of the list", () => {
    const h = buildList();
    press(h.handles[0]);
    move(100);
    release(100);

    expect(h.drops).toEqual([{ item: "r0", prev: "r2", next: null }]);
  });

  it("reports a null prev at the start of the list", () => {
    const h = buildList();
    press(h.handles[2], 40);
    move(5);
    release(5);

    expect(h.drops).toEqual([{ item: "r2", prev: null, next: "r0" }]);
  });

  it("reports nothing when the row lands back where it started", () => {
    const h = buildList();
    press(h.handles[0]);
    move(8); // still above r1's midpoint
    release(8);

    expect(h.drops).toEqual([]);
  });

  it("reports nothing for a cancelled drag", () => {
    const h = buildList();
    press(h.handles[0]);
    move(100);
    cancel(100);

    expect(h.drops).toEqual([]);
    expect(indicator()).toBeNull();
  });

  it("reports nothing from a list with a single row", () => {
    const h = buildList({ count: 1 });
    press(h.handles[0]);
    move(100);

    // Nothing to measure against, so the indicator sits at the list's top.
    expect(indicatorTop()).toBe("0px");
    release(100);
    expect(h.drops).toEqual([]);
  });
});

describe("what the drag draws", () => {
  it("marks the list and the row while the drag runs, and unmarks them after", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35);

    expect(h.list.className).toContain("pm-reorder-list--dragging");
    expect(h.rows[0].className).toContain("pm-reorder-row--dragging");

    release(35);
    expect(h.list.className).not.toContain("pm-reorder-list--dragging");
    expect(h.rows[0].className).not.toContain("pm-reorder-row--dragging");
  });

  it("translates the row by how far the pointer travelled", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35);

    expect(offsetOf(h.rows[0])).toBe("35px");
  });

  it("puts the indicator at the top of the row being displaced", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35);

    // Slot 1 among the other rows — r2, whose top is 40.
    expect(indicatorTop()).toBe("40px");
  });

  it("puts the indicator at the last row's bottom edge past the end of the list", () => {
    const h = buildList();
    press(h.handles[0]);
    move(100);

    expect(indicatorTop()).toBe("60px");
  });

  it("uses an li for the indicator in a ul, so the markup stays valid", () => {
    const h = buildList({ tag: "ul" });
    press(h.handles[0]);
    move(35);

    expect(indicator()?.tagName).toBe("LI");
  });

  it("uses a div for the indicator in a plain div list", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35);

    expect(indicator()?.tagName).toBe("DIV");
  });
});

describe("auto-scrolling towards the edge the pointer is held at", () => {
  /** A 200px-tall scrolling box holding the list, parked `scrollTop` px down. */
  function scrolledList(scrollTop = 100, overflowY = "auto"): Harness {
    const h = buildList();
    makeScrollable(h.host, overflowY, 1000, 200);
    stampRect(h.host, 0, 200);
    h.host.scrollTop = scrollTop;
    return h;
  }

  it("scrolls up when the pointer is held near the top edge", () => {
    const h = scrolledList();
    press(h.handles[0], 100);
    move(10);
    runFrame();

    expect(h.host.scrollTop).toBeLessThan(100);
  });

  it("scrolls down when the pointer is held near the bottom edge", () => {
    const h = scrolledList();
    press(h.handles[0], 100);
    move(190);
    runFrame();

    expect(h.host.scrollTop).toBeGreaterThan(100);
  });

  it("keeps scrolling while the pointer is held still — a finger emits no moves", () => {
    const h = scrolledList();
    press(h.handles[0], 100);
    move(190);
    runFrame();
    const afterOne = h.host.scrollTop;
    runFrame();

    expect(h.host.scrollTop).toBeGreaterThan(afterOne);
  });

  it("stands still while the pointer is clear of both edges", () => {
    const h = scrolledList();
    press(h.handles[0], 100);
    move(120);
    runFrame();

    expect(h.host.scrollTop).toBe(100);
  });

  it("caps the speed however far past the edge the pointer goes", () => {
    const h = scrolledList();
    press(h.handles[0], 100);
    move(-500);
    runFrame();

    expect(h.host.scrollTop).toBe(100 - 14);
  });

  it("keeps the row under the pointer as the list scrolls beneath it", () => {
    const h = scrolledList();
    press(h.handles[0], 100);
    move(190);
    const beforeScroll = offsetOf(h.rows[0]);
    runFrame();

    // The row travelled further than the pointer did: it made up the scroll as well.
    expect(parseInt(offsetOf(h.rows[0]), 10)).toBeGreaterThan(parseInt(beforeScroll, 10));
  });

  it("takes overflow-y: scroll for a scroller too", () => {
    const h = scrolledList(100, "scroll");
    press(h.handles[0], 100);
    move(190);
    runFrame();

    expect(h.host.scrollTop).toBeGreaterThan(100);
  });

  it("looks past an ancestor that can't actually scroll", () => {
    const h = buildList();
    // Overflow says it scrolls, but there is nothing to scroll — the content fits.
    makeScrollable(h.host, "auto", 100, 200);
    stampRect(h.host, 0, 200);
    h.host.scrollTop = 50;

    press(h.handles[0], 100);
    move(190);
    runFrame();

    expect(h.host.scrollTop).toBe(50);
    // The drag itself is unaffected — it just has no list to pull into view.
    expect(offsetOf(h.rows[0])).toBe("90px");
  });

  it("runs a frame before the drag begins without touching anything", () => {
    const h = scrolledList();
    press(h.handles[0], 100);
    runFrame();

    expect(h.host.scrollTop).toBe(100);
    expect(indicator()).toBeNull();
  });
});

describe("a drag interrupted from outside", () => {
  it("gives up when a refresh detaches the list mid-gesture", () => {
    const h = buildList();
    press(h.handles[0]);
    move(100);
    h.list.remove();
    runFrame();

    expect(h.drops).toEqual([]);
    // The frame loop stopped rather than spinning against dead DOM.
    expect(frames.size).toBe(0);

    // And the gesture's own listeners went with it: the release lands on nothing.
    release(100);
    expect(h.drops).toEqual([]);
  });

  it("re-reads the rows when the window resizes mid-drag", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35);

    // The keyboard opening on mobile: the same pointer position now falls short of r1.
    h.rows[1].getBoundingClientRect = () => ({ top: 20, bottom: 120, height: 100 }) as DOMRect;
    h.rows[2].getBoundingClientRect = () => ({ top: 120, bottom: 220, height: 100 }) as DOMRect;
    window.dispatchEvent(new Event("resize"));

    move(35);
    release(35);

    expect(h.drops).toEqual([]);
  });

  it("has nothing to re-read on a resize before the drag begins", () => {
    const h = buildList();
    press(h.handles[0]);
    window.dispatchEvent(new Event("resize"));

    expect(indicator()).toBeNull();

    // The press still becomes a drag afterwards.
    move(35);
    release(35);
    expect(h.drops).toEqual([{ item: "r0", prev: "r1", next: "r2" }]);
  });

  it("stops listening to the window once the drag is over", () => {
    const h = buildList();
    press(h.handles[0]);
    move(35);
    release(35);

    // A resize now would measure a drag that no longer exists.
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
    expect(h.drops).toHaveLength(1);
  });
});
