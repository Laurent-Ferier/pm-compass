// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills — jsdom lacks the createEl/empty/addClass helpers that
// Obsidian adds to HTMLElement, which the picker relies on.
// ---------------------------------------------------------------------------
function installObsidianDOMPolyfills() {
  const proto = HTMLElement.prototype as any;
  type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
  proto.createEl = function (this: Element, tag: string, opts?: Opts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: Opts) { return (this as any).createEl("div", opts); };
  proto.createSpan = function (this: HTMLElement, opts?: Opts) { return (this as any).createEl("span", opts); };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
  proto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  (window as any).activeDocument = document;
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
