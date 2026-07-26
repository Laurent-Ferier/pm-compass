// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import {
  renderPriorityRibbon,
  renderStatusPill,
  renderSubtaskWarning,
  renderParentDoneWarning,
  createBadgeBand,
  renderMetaBadge,
  BadgeTone,
} from "./task-badges";
import { ALERT_SVG } from "./icons";
import { Priority } from "../model/task-vocabulary";

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
    const ribbon = renderPriorityRibbon(host(), Priority.High);
    expect(ribbon.className).toBe("pm-task-ribbon");
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#f97316");
    expect(ribbon.title).toBe("Priority: High");
  });

  it("titles with both when a rolled-up priority outranks the task's own", () => {
    const ribbon = renderPriorityRibbon(host(), Priority.Low, Priority.High);
    // The bar fades from the rolled-up level to the task's own, so the picker visibly
    // does something even while the roll-up outranks the choice.
    expect(ribbon.classList.contains("pm-task-ribbon--inherited")).toBe(true);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#f97316");
    expect(ribbon.style.getPropertyValue("--pm-ribbon-own-color")).toBe("#22c55e");
    expect(ribbon.title).toBe("Effective priority: High (own: Low)");
  });

  it("keeps a solid inherited bar when the task has no priority of its own to fade to", () => {
    const ribbon = renderPriorityRibbon(host(), undefined, Priority.Critical);
    expect(ribbon.classList.contains("pm-task-ribbon--inherited")).toBe(false);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#ef4444");
    expect(ribbon.style.getPropertyValue("--pm-ribbon-own-color")).toBe("");
    // The roll-up is still named on hover, even without a second colour to show it.
    expect(ribbon.title).toBe("Effective priority: Critical (own: None)");
  });

  it("keeps the single-priority title when the effective priority equals its own", () => {
    const ribbon = renderPriorityRibbon(host(), Priority.Medium, Priority.Medium);
    expect(ribbon.classList.contains("pm-task-ribbon--inherited")).toBe(false);
    expect(ribbon.title).toBe("Priority: Medium");
  });

  it("leaves the ribbon uncoloured and titled None when there is no priority", () => {
    const ribbon = renderPriorityRibbon(host(), undefined);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("");
    expect(ribbon.title).toBe("Priority: None");
  });

  it("colours and labels the checklist-only Lowest level distinctly from an unset one", () => {
    const ribbon = renderPriorityRibbon(host(), Priority.Lowest);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#38bdf8");
    expect(ribbon.title).toBe("Priority: Lowest");
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

describe("renderMetaBadge", () => {
  it("renders a plain neutral chip with no tone or link class", () => {
    const badge = renderMetaBadge(host(), { text: "in 3 d" });
    expect(badge.className).toBe("pm-task-badge");
    expect(badge.textContent).toBe("in 3 d");
    expect(badge.title).toBe("");
    expect(badge.querySelector("svg")).toBeNull();
  });

  it("tints by tone and carries the tooltip", () => {
    const badge = renderMetaBadge(host(), { text: "2 d ago", tone: BadgeTone.Danger, title: "Overdue" });
    expect(badge.className).toBe("pm-task-badge pm-task-badge--danger");
    expect(badge.title).toBe("Overdue");
  });

  it("draws an icon before the text when one is given", () => {
    const badge = renderMetaBadge(host(), { text: "20 d", icon: ALERT_SVG, tone: BadgeTone.Warning });
    expect(badge.querySelector(".pm-task-badge-icon svg")).not.toBeNull();
    expect(badge.textContent).toBe("20 d");
  });

  it("swallows the click of a link badge, so the row underneath doesn't also react", () => {
    const band = createBadgeBand(host());
    let opened = 0;
    const badge = renderMetaBadge(band, { text: "Mon, Jul 20", onClick: () => { opened++; } });
    expect(band.className).toBe("pm-task-badges");
    expect(badge.className).toBe("pm-task-badge pm-task-badge--link");

    let reachedRow = 0;
    band.addEventListener("click", () => { reachedRow++; });
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toBe(1);
    expect(reachedRow).toBe(0);
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
