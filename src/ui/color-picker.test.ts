// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills — jsdom lacks the createEl/addClass/setCssProps helpers
// Obsidian adds to HTMLElement, which the picker draws itself with.
// ---------------------------------------------------------------------------
function installObsidianDOMPolyfills() {
  const proto = bagOf(HTMLElement.prototype);
  type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
  proto.createEl = function (this: HTMLElement, tag: string, opts?: Opts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: Opts) { return this.createEl("div", opts); };
  proto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  bagOf(window).activeDocument = document;
  bagOf(window).activeWindow = window;
}

import { openColorPicker } from "./color-picker";
import { keymapApp } from "./__testing__/keymap-app";

beforeAll(() => { installObsidianDOMPolyfills(); });

const AREA_W = 200;
const AREA_H = 120;

/** jsdom lays nothing out and reports a zero rect for every element, so the two strips the
 *  drag reads a fraction of are given the size the stylesheet gives them. */
function stubRect(el: HTMLElement, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
}

/** jsdom has no `PointerEvent`; a `MouseEvent` carrying the id the capture calls read does. */
function pointer(type: string, clientX: number, clientY: number): Event {
  return Object.assign(new MouseEvent(type, { bubbles: true, clientX, clientY }), { pointerId: 1 });
}

let anchor: HTMLElement;
let close: (() => void) | undefined;
let changes: string[];

beforeEach(() => {
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
  changes = [];
});

afterEach(() => {
  close?.();
  close = undefined;
  document.querySelectorAll(".pm-colorpicker").forEach((p) => p.remove());
  anchor.remove();
});

const popup = () => document.querySelector(".pm-colorpicker") as HTMLElement;
const area = () => popup().querySelector(".pm-colorpicker-area") as HTMLElement;
const hue = () => popup().querySelector(".pm-colorpicker-hue") as HTMLElement;
const hexField = () => popup().querySelector(".pm-colorpicker-hex") as HTMLInputElement;
const latest = () => changes[changes.length - 1];

function open(current: string): void {
  close = openColorPicker(keymapApp().app, anchor, { current, onChange: (c) => changes.push(c) });
  stubRect(area(), AREA_W, AREA_H);
  stubRect(hue(), AREA_W, 12);
}

/** Press, move, release — a whole drag, in the strip's own coordinates. */
function drag(el: HTMLElement, x: number, y: number): void {
  el.dispatchEvent(pointer("pointerdown", x, y));
  el.dispatchEvent(pointer("pointermove", x, y));
  el.dispatchEvent(pointer("pointerup", x, y));
}

describe("openColorPicker", () => {
  it("opens on the color in force, saying nothing until something is picked", () => {
    open("#00ff00");
    expect(popup()).toBeTruthy();
    expect(hexField().value).toBe("#00ff00");
    expect(changes).toEqual([]);
  });

  it("opens on gray where the note carries no color, or none that is one", () => {
    open("");
    expect(hexField().value).toBe("#888888");
    close?.();
    open("chartreuse");
    expect(hexField().value).toBe("#888888");
  });

  it("reads saturation across the square and brightness down it", () => {
    open("#00ff00");
    drag(area(), AREA_W / 2, 0);
    expect(latest()).toBe("#80ff80");
    drag(area(), AREA_W, AREA_H);
    expect(latest()).toBe("#000000");
  });

  it("clamps a drag that leaves the square to its edges", () => {
    open("#00ff00");
    drag(area(), AREA_W * 3, -50);
    expect(latest()).toBe("#00ff00");
  });

  it("turns the hue without touching saturation or brightness", () => {
    open("#00ff00");
    drag(hue(), AREA_W / 2, 6);
    expect(latest()).toBe("#00ffff");
  });

  it("moves nothing on a pointer that was never pressed", () => {
    open("#00ff00");
    area().dispatchEvent(pointer("pointermove", 0, 0));
    expect(changes).toEqual([]);
  });

  it("moves nothing on a button that is not the primary one", () => {
    open("#00ff00");
    const secondary = Object.assign(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, button: 2 }), { pointerId: 1 });
    area().dispatchEvent(secondary);
    area().dispatchEvent(pointer("pointermove", 0, 0));
    expect(changes).toEqual([]);
  });

  it("takes a hex typed in, and leaves the field it was typed in alone", () => {
    open("#00ff00");
    hexField().value = "3b82f6";
    hexField().dispatchEvent(new Event("input"));
    expect(latest()).toBe("#3b82f6");
    expect(hexField().value).toBe("3b82f6");
  });

  it("ignores a hex still half typed", () => {
    open("#00ff00");
    hexField().value = "#3b8";
    hexField().dispatchEvent(new Event("input"));
    expect(changes).toEqual([]);
  });

  it("keeps the hue a hex for black or white does not carry", () => {
    open("#00ff00");
    hexField().value = "#000000";
    hexField().dispatchEvent(new Event("input"));
    expect(latest()).toBe("#000000");
    // Straight back up the square, on the hue the picker was opened on.
    drag(area(), AREA_W, 0);
    expect(latest()).toBe("#00ff00");
  });

  it("puts the cursors where the color stands", () => {
    open("#00ffff");
    const areaCursor = area().querySelector(".pm-colorpicker-cursor") as HTMLElement;
    expect(areaCursor.style.getPropertyValue("--pm-cursor-x")).toBe("100%");
    expect(areaCursor.style.getPropertyValue("--pm-cursor-y")).toBe("0%");
    const hueCursor = hue().querySelector(".pm-colorpicker-cursor") as HTMLElement;
    expect(hueCursor.style.getPropertyValue("--pm-cursor-x")).toBe("50%");
  });

  it("draws the square over the hue in force", () => {
    open("#803030");
    expect(area().style.getPropertyValue("--pm-hue-color")).toBe("#ff0000");
  });

  it("closes on Escape, and again on the close it returns", () => {
    const km = keymapApp();
    close = openColorPicker(km.app, anchor, { current: "#00ff00", onChange: () => {} });
    expect(km.press("Escape")).toBe(true);
    expect(popup()).toBeNull();
    expect(km.scopes).toHaveLength(0);
  });
});
