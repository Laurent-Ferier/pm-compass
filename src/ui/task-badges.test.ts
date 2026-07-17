// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import {
  renderPriorityRibbon,
  renderStatusPill,
  renderSubtaskWarning,
  renderParentDoneWarning,
} from "./task-badges";

// task-badges only needs a few of Obsidian's HTMLElement helpers plus the
// `activeDocument` global that `setSvgIcon` reads. It imports neither the
// obsidian module nor anything that does, so a minimal polyfill is enough.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = HTMLElement.prototype as any;
  proto.createEl = function (this: HTMLElement, tag: string, opts?: { cls?: string; text?: string }) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: { cls?: string; text?: string }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("div", opts);
  };
  proto.createSpan = function (this: HTMLElement, opts?: { cls?: string; text?: string }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("span", opts);
  };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeDocument = document;
});

function host(): HTMLElement {
  return document.createElement("div");
}

describe("renderPriorityRibbon", () => {
  it("colours the ribbon and titles it with the priority alone when there is no roll-up", () => {
    const ribbon = renderPriorityRibbon(host(), "cls", "high");
    expect(ribbon.className).toBe("cls");
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#f97316");
    expect(ribbon.title).toBe("Priority: High");
  });

  it("titles with both when a rolled-up priority outranks the task's own", () => {
    const ribbon = renderPriorityRibbon(host(), "cls", "low", "high");
    // Colour follows the effective (rolled-up) priority.
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#f97316");
    expect(ribbon.title).toBe("Effective priority: High (own: Low)");
  });

  it("keeps the single-priority title when the effective priority equals its own", () => {
    const ribbon = renderPriorityRibbon(host(), "cls", "medium", "medium");
    expect(ribbon.title).toBe("Priority: Medium");
  });

  it("leaves the ribbon uncoloured and titled None when there is no priority", () => {
    const ribbon = renderPriorityRibbon(host(), "cls", undefined);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("");
    expect(ribbon.title).toBe("Priority: None");
  });

  it("falls back to the raw effective value when it has no known label", () => {
    const ribbon = renderPriorityRibbon(host(), "cls", "low", "urgent");
    expect(ribbon.title).toBe("Effective priority: urgent (own: Low)");
  });
});

describe("renderStatusPill", () => {
  it("labels and tints a known status", () => {
    const pill = renderStatusPill(host(), "cls", "in-progress");
    expect(pill.textContent).toBe("In Progress");
    expect(pill.style.getPropertyValue("--pm-status-color")).toBe("#3b82f6");
    expect(pill.style.getPropertyValue("--pm-status-bg")).toBe("#3b82f622");
    expect(pill.style.getPropertyValue("--pm-status-border-color")).toBe("#3b82f655");
  });

  it("falls back to the raw status string when it has no label", () => {
    const pill = renderStatusPill(host(), "cls", "archived");
    expect(pill.textContent).toBe("archived");
    // Unknown statuses take the neutral fallback colour.
    expect(pill.style.getPropertyValue("--pm-status-color")).toBe("#6b7280");
  });
});

describe("warning glyphs", () => {
  it("renders the completed-with-open-subtasks alert", () => {
    const warn = renderSubtaskWarning(host(), "warn-cls");
    expect(warn.className).toBe("warn-cls");
    expect(warn.getAttribute("aria-label")).toBe("Completed, but has unfinished subtasks");
    expect(warn.title).toBe("Completed, but has unfinished subtasks");
    expect(warn.querySelector("svg")).not.toBeNull();
  });

  it("renders the open-under-completed-parent unlink glyph", () => {
    const warn = renderParentDoneWarning(host(), "warn-cls");
    expect(warn.className).toBe("warn-cls");
    expect(warn.getAttribute("aria-label")).toBe("Still open, but its parent task is completed");
    expect(warn.title).toBe("Still open, but its parent task is completed");
    expect(warn.querySelector("svg")).not.toBeNull();
  });
});
