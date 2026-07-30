// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll } from "vitest";
import {
  renderPriorityRibbon,
  renderStatusPill,
  renderStatusIcon,
  renderSubtaskWarning,
  renderParentDoneWarning,
  createBadgeBand,
  renderMetaBadge,
  renderDaysBadge,
  OLD_AGE_DAYS,
  BadgeTone,
} from "./task-badges";
import { Icon } from "./icons";
import { Priority } from "../model/base-task";

// Obsidian's `setIcon` draws the real Lucide glyph; here it only has to leave an
// <svg> behind, which is all these tests look for.
vi.mock("obsidian", () => ({
  setIcon: (el: HTMLElement, name: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-icon", name);
    el.replaceChildren(svg);
  },
  getIcon: () => null,
}));

// task-badges also needs a few of Obsidian's HTMLElement helpers, and it imports
// nothing else that touches the DOM, so a minimal polyfill is enough.
beforeAll(() => {
  const proto = HTMLElement.prototype as any;
  proto.createEl = function (this: HTMLElement, tag: string, opts?: { cls?: string; text?: string }) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: { cls?: string; text?: string }) {
    return (this as any).createEl("div", opts);
  };
  proto.createSpan = function (this: HTMLElement, opts?: { cls?: string; text?: string }) {
    return (this as any).createEl("span", opts);
  };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
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

  it("fades from a parent's higher priority at the top to the task's own at the bottom", () => {
    const ribbon = renderPriorityRibbon(host(), Priority.Low, Priority.High, Priority.Low);
    // Nothing under it outranks it, so the subtask roll-up is its own level — the bottom
    // of the fade is what the picker moves.
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color"))
      .toBe("linear-gradient(to bottom, #f97316, #22c55e)");
    expect(ribbon.title).toBe("Priority: Low (from parent tasks: High)");
  });

  it("fades to a subtask's higher priority at the bottom, from the task's own", () => {
    const ribbon = renderPriorityRibbon(host(), Priority.Medium, Priority.Medium, Priority.High);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color"))
      .toBe("linear-gradient(to bottom, #eab308, #f97316)");
    expect(ribbon.title).toBe("Priority: Medium (from subtasks: High)");
  });

  it("still fades between two levels when the task is outranked from both sides", () => {
    // Neither end is the task's own level; only the title names it.
    const ribbon = renderPriorityRibbon(host(), Priority.Low, Priority.Critical, Priority.High);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color"))
      .toBe("linear-gradient(to bottom, #ef4444, #f97316)");
    expect(ribbon.title).toBe("Priority: Low (from parent tasks: Critical, from subtasks: High)");
  });

  it("keeps a solid inherited bar when the task has nothing coloured below it", () => {
    const ribbon = renderPriorityRibbon(host(), undefined, Priority.Critical);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#ef4444");
    // The roll-up is still named on hover, even without a second level to fade to.
    expect(ribbon.title).toBe("Priority: None (from parent tasks: Critical)");
  });

  it("gives the whole bar to a subtask's priority when the task and its parents have none", () => {
    const ribbon = renderPriorityRibbon(host(), undefined, undefined, Priority.High);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#f97316");
    expect(ribbon.title).toBe("Priority: None (from subtasks: High)");
  });

  it("keeps the single-priority title when neither roll-up outranks its own", () => {
    const ribbon = renderPriorityRibbon(host(), Priority.Medium, Priority.Medium, Priority.Medium);
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#eab308");
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

describe("renderStatusIcon", () => {
  it("draws the glyph of a known status, tinted by it", () => {
    const icon = renderStatusIcon(host(), "cls", "done");
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(icon.style.getPropertyValue("--pm-status-color")).toBe("#22c55e");
    expect(icon.getAttribute("aria-label")).toBe("Done");
  });

  it("falls back to the todo glyph and the neutral colour for an unknown status", () => {
    const icon = renderStatusIcon(host(), "cls", "archived");
    expect(icon.querySelector("svg")?.getAttribute("data-icon")).toBe(Icon.StatusTodo);
    expect(icon.style.getPropertyValue("--pm-status-color")).toBe("#6b7280");
  });

  it("carries the caller's wording as tooltip and label", () => {
    const icon = renderStatusIcon(host(), "cls", "cancelled", { title: "Status: In Progress / Cancelled" });
    expect(icon.title).toBe("Status: In Progress / Cancelled");
    expect(icon.getAttribute("aria-label")).toBe("Status: In Progress / Cancelled");
  });

  it("is not a focus stop unless it is interactive", () => {
    const icon = renderStatusIcon(host(), "cls", "todo");
    expect(icon.getAttribute("role")).toBeNull();
    expect(icon.tabIndex).toBe(-1);
  });

  it("is a keyboard button when interactive, Enter and Space clicking it", () => {
    const icon = renderStatusIcon(host(), "cls", "todo", { interactive: true });
    expect(icon.getAttribute("role")).toBe("button");
    expect(icon.tabIndex).toBe(0);

    const onClick = vi.fn();
    icon.addEventListener("click", onClick);
    for (const key of ["Enter", " "]) {
      icon.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    expect(onClick).toHaveBeenCalledTimes(2);

    icon.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("renderDaysBadge", () => {
  it("is a plain day count below the warn threshold", () => {
    const badge = renderDaysBadge(host(), 3, { warnAfterDays: 7, title: "t" });
    expect(badge.textContent).toBe("3 d");
    expect(badge.className).toBe("pm-task-badge");
    expect(badge.title).toBe("t");
  });

  it("adds the glyph and the warn wording past the threshold", () => {
    const badge = renderDaysBadge(host(), 7, { warnAfterDays: 7, title: "t", warnTitle: "stale" });
    expect(badge.className).toContain("pm-task-badge--warning");
    expect(badge.querySelector(".pm-task-badge-icon")).not.toBeNull();
    expect(badge.title).toBe("stale");
  });

  it("turns red past OLD_AGE_DAYS", () => {
    const badge = renderDaysBadge(host(), OLD_AGE_DAYS + 1, { warnAfterDays: 7, title: "t" });
    expect(badge.className).toContain("pm-task-badge--danger");
  });

  it("holds the red back past a warn threshold beyond OLD_AGE_DAYS, so it warns first", () => {
    const warnAfterDays = OLD_AGE_DAYS + 16;
    expect(renderDaysBadge(host(), OLD_AGE_DAYS + 1, { warnAfterDays, title: "t" }).className)
      .toBe("pm-task-badge");
    expect(renderDaysBadge(host(), warnAfterDays, { warnAfterDays, title: "t" }).className)
      .toContain("pm-task-badge--warning");
    expect(renderDaysBadge(host(), warnAfterDays + 1, { warnAfterDays, title: "t" }).className)
      .toContain("pm-task-badge--danger");
  });

  it("never warns when the threshold is 0", () => {
    const badge = renderDaysBadge(host(), 99, { warnAfterDays: 0, title: "t" });
    expect(badge.querySelector(".pm-task-badge-icon")).toBeNull();
    expect(badge.className).toContain("pm-task-badge--danger");
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
    const badge = renderMetaBadge(host(), { text: "20 d", icon: Icon.SubtaskWarning, tone: BadgeTone.Warning });
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
