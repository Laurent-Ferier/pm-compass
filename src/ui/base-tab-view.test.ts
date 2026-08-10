// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

const { MockComponent, noticed } = vi.hoisted(() => {
  const noticed: string[] = [];
  class MockComponent {
    static live = 0;
    loaded = false;
    load() { if (!this.loaded) { this.loaded = true; MockComponent.live += 1; } }
    unload() { if (this.loaded) { this.loaded = false; MockComponent.live -= 1; } }
  }
  return { MockComponent, noticed };
});

vi.mock("obsidian", () => ({
  App: class {},
  Component: MockComponent,
  ItemView: class {},
  Menu: class { addItem() { return this; } showAtMouseEvent() {} },
  Modal: class { contentEl = document.createElement("div"); open() {} close() {} },
  TFile: class { path = ""; },
  WorkspaceLeaf: class {},
  MarkdownRenderer: { render: vi.fn() },
  Notice: class { constructor(message: string) { noticed.push(message); } },
  normalizePath: (p: string) => p,
  setIcon: (el: HTMLElement, name: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-icon", name);
    el.replaceChildren(svg);
  },
  moment: (input?: Date) => ({ format: () => (input ?? new Date()).toISOString().slice(0, 10) }),
}));

// The graph view pulls in the dashboard, which extends the class under test — mocked so the
// cycle doesn't leave `BaseTabView` undefined at the point the dashboard extends it.
vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class { openTask = vi.fn().mockResolvedValue(undefined); },
}));

import { BaseTabView } from "./base-tab-view";
import { asApp } from "../model/__testing__/as-app";
import { newTask } from "../model/__testing__/notes";
import { day } from "../model/__testing__/dates";
import { Priority } from "../model/base-task";
import type PMCompassPlugin from "../main";
import type { ProjectTask, ProjectTaskFields } from "../model/project/project-task";

/** Obsidian's own additions to `HTMLElement`, which jsdom has none of. */
beforeAll(() => {
  const proto = bagOf(HTMLElement.prototype);
  proto.createEl = function (this: HTMLElement, tag: string, opts?: {
    cls?: string; text?: string; type?: string; attr?: Record<string, string>;
  }) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
    for (const [k, v] of Object.entries(opts?.attr ?? {})) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: object) { return this.createEl("div", opts); };
  proto.createSpan = function (this: HTMLElement, opts?: object) { return this.createEl("span", opts); };
  proto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.toggleClass = function (this: HTMLElement, cls: string, on?: boolean) { this.classList.toggle(cls, on); };
  proto.hasClass = function (this: HTMLElement, cls: string) { return this.classList.contains(cls); };
  proto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
  proto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
});

/** The base with nothing of a tab's own: what every tab inherits, and no more. */
class Tab extends BaseTabView {
  reference = new Date();

  protected override referenceDate(): Date {
    return this.reference;
  }

  // What the tests drive the base's own members through.
  pass(): void { this.startRenderPass(); }
  mutate(action: () => Promise<unknown>, message: string): void { this.runMutation(action, message); }
  addBar(container: HTMLElement, add: (title: string) => Promise<unknown>) {
    return this.renderAddBar(container, "Add a task…", add);
  }
  badge(container: HTMLElement, date: Date, opts: Parameters<BaseTabView["renderDateBadge"]>[2]): void {
    this.renderDateBadge(container, date, opts);
  }
}

function tab(onRefresh = vi.fn()) {
  const plugin = { settings: { dashboardCollapsed: {} }, saveSettings: vi.fn() } as unknown as PMCompassPlugin;
  return { onRefresh, view: new Tab(asApp({}), plugin, onRefresh) };
}

function task(overrides: Partial<ProjectTaskFields> & { id: string }): ProjectTask {
  return newTask({
    title: overrides.id,
    projectId: "p1",
    status: "todo",
    priority: Priority.Medium,
    dependencies: [],
    filePath: `Projects/${overrides.id}.md`,
    ...overrides,
  });
}

beforeEach(() => {
  noticed.length = 0;
  MockComponent.live = 0;
  vi.restoreAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("BaseTabView", () => {
  describe("the markdown one pass rendered", () => {
    it("retires the pass before it and stands a new owner up", () => {
      const { view } = tab();

      view.pass();
      view.pass();

      expect(MockComponent.live).toBe(1);
    });

    it("releases the last pass when the tab goes, no render following to do it", () => {
      const { view } = tab();
      view.pass();

      view.dispose();

      expect(MockComponent.live).toBe(0);
    });
  });

  describe("a mutating action", () => {
    it("refreshes the tab once the write lands", async () => {
      const { view, onRefresh } = tab();

      view.mutate(() => Promise.resolve(), "Couldn't do it");
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    });

    it("says what failed rather than leaving the row silently stale", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { view, onRefresh } = tab();

      view.mutate(() => Promise.reject(new Error("no")), "Couldn't do it");

      await vi.waitFor(() => expect(noticed).toEqual(["Couldn't do it"]));
      expect(onRefresh).not.toHaveBeenCalled();
    });
  });

  describe("the add bar", () => {
    function bar(add: (title: string) => Promise<unknown>) {
      const { view, onRefresh } = tab();
      const container = document.body.appendChild(document.createElement("div"));
      return { ...view.addBar(container, add), onRefresh };
    }

    function enter(input: HTMLInputElement, title: string): void {
      input.value = title;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    }

    it("hands the typed title over, and clears the field as it goes", async () => {
      const add = vi.fn().mockResolvedValue(undefined);
      const { input, onRefresh } = bar(add);

      enter(input, "  Draft the note  ");

      expect(add).toHaveBeenCalledWith("Draft the note");
      expect(input.value).toBe("");
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
      expect(input.disabled).toBe(false);
    });

    it("adds nothing on a key that isn't Enter, or on an empty field", () => {
      const add = vi.fn().mockResolvedValue(undefined);
      const { input } = bar(add);

      input.value = "Draft the note";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      enter(input, "   ");

      expect(add).not.toHaveBeenCalled();
    });

    it("says the add failed, and gives the field back", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { input, onRefresh } = bar(() => Promise.reject(new Error("no")));

      enter(input, "Draft the note");

      await vi.waitFor(() => expect(noticed).toEqual(["Couldn't add the task"]));
      expect(input.disabled).toBe(false);
      expect(onRefresh).not.toHaveBeenCalled();
    });
  });

  describe("a date on a row", () => {
    it("reads a day still ahead as its label", () => {
      const { view } = tab();
      view.reference = day("2026-08-09");
      const host = document.createElement("div");

      view.badge(host, day("2026-08-12"), { title: "Due" });

      expect(host.textContent).toContain("in 3d");
    });

    it("reads a day gone by as the count past it", () => {
      const { view } = tab();
      view.reference = day("2026-08-09");
      const host = document.createElement("div");

      view.badge(host, day("2026-08-07"), { title: "Due" });

      expect(host.textContent).toContain("2 d");
    });

    it("counts an age from the real today rather than the day being looked at", () => {
      const { view } = tab();
      view.reference = day("2020-01-01");
      const host = document.createElement("div");

      view.badge(host, new Date(), { title: "Created", fromToday: true });

      expect(host.textContent).toContain("today");
    });
  });

  it("starts with no tasks, whatever tab it is", () => {
    expect(tab().view.allTasks).toEqual([]);
  });

  it("reads the tasks it is given, and reads them again once the list is replaced", () => {
    const { view } = tab();
    const first = [task({ id: "one" })];
    view.allTasks = first;

    expect(view.allTasks).toBe(first);

    view.allTasks = [task({ id: "two" })];
    expect(view.allTasks.map((t) => t.id)).toEqual(["two"]);
  });
});
