// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills — jsdom lacks the createEl/empty/addClass helpers that
// Obsidian adds to HTMLElement, which the picker relies on.
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
  proto.createSpan = function (this: HTMLElement, opts?: Opts) { return this.createEl("span", opts); };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
  proto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  bagOf(window).activeDocument = document;
  bagOf(window).activeWindow = window;
}

// The picker uses the real moment API, so back the "obsidian" moment with it.
// The real moment, imported here rather than at the top of the file: Obsidian ships it,
// so a plugin may not depend on the package — but the mock standing in for Obsidian has
// to get it from somewhere.
vi.mock("obsidian", async () => ({
  moment: (await import("moment")).default,
  setIcon: () => {},
}));

import { openDatePicker } from "./date-picker";
import { day } from "../model/__testing__/dates";

beforeAll(() => { installObsidianDOMPolyfills(); });

let anchor: HTMLElement;
let close: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 15)); // 15 Jul 2026
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
});

afterEach(() => {
  close?.();
  close = undefined;
  document.querySelectorAll(".pm-datepicker").forEach((p) => p.remove());
  anchor.remove();
  vi.useRealTimers();
});

const popup = () => document.querySelector(".pm-datepicker") as HTMLElement;
const days = () => Array.from(popup().querySelectorAll(".pm-datepicker-day:not(.pm-datepicker-day--blank)"));
const dayCell = (n: number) => days().find((d) => d.textContent === String(n)) as HTMLElement;

describe("openDatePicker", () => {
  it("appends a popup to the body and shows the initial month", () => {
    close = openDatePicker(anchor, { initial: day("2026-07-15"), onPick: () => {} });
    expect(popup()).toBeTruthy();
    expect(popup().querySelector(".pm-datepicker-title")!.textContent).toBe("July 2026");
    // 31 day cells for July.
    expect(days()).toHaveLength(31);
  });

  it("defaults to the current month when no initial date is given", () => {
    close = openDatePicker(anchor, { onPick: () => {} });
    expect(popup().querySelector(".pm-datepicker-title")!.textContent).toBe("July 2026");
  });

  it("marks today and the selected day", () => {
    close = openDatePicker(anchor, { initial: day("2026-07-20"), onPick: () => {} });
    expect(dayCell(15).classList.contains("pm-datepicker-day--today")).toBe(true);
    expect(dayCell(20).classList.contains("pm-datepicker-day--selected")).toBe(true);
  });

  it("calls onPick with the chosen day and closes", () => {
    const onPick = vi.fn();
    close = openDatePicker(anchor, { initial: day("2026-07-15"), onPick });
    dayCell(22).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0]).toEqual(day("2026-07-22"));
    expect(popup()).toBeNull(); // closed
  });

  it("navigates to the previous and next month", () => {
    close = openDatePicker(anchor, { initial: day("2026-07-15"), onPick: () => {} });
    (popup().querySelector("[aria-label='Next month']") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popup().querySelector(".pm-datepicker-title")!.textContent).toBe("August 2026");
    (popup().querySelector("[aria-label='Previous month']") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (popup().querySelector("[aria-label='Previous month']") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(popup().querySelector(".pm-datepicker-title")!.textContent).toBe("June 2026");
  });

  it("picks today via the Today shortcut", () => {
    const onPick = vi.fn();
    close = openDatePicker(anchor, { initial: day("2026-01-01"), onPick });
    (popup().querySelector(".pm-datepicker-today") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPick.mock.calls[0][0]).toEqual(day("2026-07-15"));
  });

  it("offers no Clear button when there is no date to clear", () => {
    close = openDatePicker(anchor, { onPick: () => {} });
    expect(popup().querySelector(".pm-datepicker-clear")).toBeNull();
  });

  it("calls onClear and closes when Clear is pressed", () => {
    const onClear = vi.fn();
    const onPick = vi.fn();
    close = openDatePicker(anchor, { initial: day("2026-07-20"), onPick, onClear });
    (popup().querySelector(".pm-datepicker-clear") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
  });

  it("closes on an outside pointerdown but not on a click inside", () => {
    close = openDatePicker(anchor, { onPick: () => {} });
    popup().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popup()).toBeTruthy(); // inside — stays open
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popup()).toBeNull(); // outside — closed
  });

  it("closes on Escape", () => {
    close = openDatePicker(anchor, { onPick: () => {} });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popup()).toBeNull();
  });

  it("closes any already-open picker instead of stacking a second popup", () => {
    openDatePicker(anchor, { onPick: () => {} });
    close = openDatePicker(anchor, { onPick: () => {} });
    expect(document.querySelectorAll(".pm-datepicker")).toHaveLength(1);
  });

  // A leaf popped out into a second window has a document of its own, which Obsidian points
  // `activeDocument` at. Hung on the app's instead, the popup is drawn in the window nobody
  // is looking at and never hears the click that should dismiss it.
  it("opens in the document the leaf is in, and is dismissed from there", () => {
    const popped = document.implementation.createHTMLDocument("popped out");
    bagOf(window).activeDocument = popped;
    try {
      const poppedAnchor = popped.createElement("button");
      popped.body.appendChild(poppedAnchor);
      close = openDatePicker(poppedAnchor, { onPick: () => {} });

      expect(popped.querySelectorAll(".pm-datepicker")).toHaveLength(1);
      expect(document.querySelectorAll(".pm-datepicker")).toHaveLength(0);

      popped.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(popped.querySelectorAll(".pm-datepicker")).toHaveLength(0);
    } finally {
      bagOf(window).activeDocument = document;
    }
  });

  it("removes its global listeners when closed so a later outside click is inert", () => {
    const onPick = vi.fn();
    close = openDatePicker(anchor, { onPick });
    close();
    expect(popup()).toBeNull();
    // No throw / no residual handler firing.
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("where the popup is placed", () => {
  const POPUP_H = 200;
  const POPUP_W = 260;
  const VIEWPORT_H = 500;
  const VIEWPORT_W = 1000;

  /** jsdom lays nothing out, so the popup's own size and the viewport's are given here. */
  function stubLayout(): () => void {
    const proto = bagOf(HTMLElement.prototype);
    const root = bagOf(document.documentElement);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { value: POPUP_H, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { value: POPUP_W, configurable: true });
    Object.defineProperty(document.documentElement, "clientHeight", { value: VIEWPORT_H, configurable: true });
    Object.defineProperty(document.documentElement, "clientWidth", { value: VIEWPORT_W, configurable: true });
    return () => {
      delete proto.offsetHeight;
      delete proto.offsetWidth;
      delete root.clientHeight;
      delete root.clientWidth;
    };
  }

  /** Puts the anchor at a fixed spot in the viewport. */
  function anchorAt(top: number, height = 24): void {
    anchor.getBoundingClientRect = () => ({
      top, bottom: top + height, height, left: 20, right: 20 + 80, width: 80, x: 20, y: top,
      toJSON: () => ({}),
    });
  }

  let restore: () => void;
  beforeEach(() => { restore = stubLayout(); });
  afterEach(() => { restore(); });

  it("sits below the anchor when there is room for it there", () => {
    anchorAt(100);
    close = openDatePicker(anchor, { onPick: () => {} });

    expect(popup().style.top).toBe("128px"); // 124 bottom + 4 gap
  });

  it("flips above the anchor when the popup would fall off the bottom", () => {
    anchorAt(380);
    close = openDatePicker(anchor, { onPick: () => {} });

    // 380 - 4 gap - 200 tall: the whole popup fits between the anchor and the top.
    expect(popup().style.top).toBe("176px");
  });

  it("stays in the viewport when it fits neither above nor below", () => {
    // Too near the top to flip above, too near the bottom to sit below.
    anchorAt(150, 300);
    close = openDatePicker(anchor, { onPick: () => {} });

    expect(popup().style.top).toBe(`${VIEWPORT_H - POPUP_H - 4}px`);
  });
});
