// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// Obsidian extends HTMLElement (and Element) with helper methods that jsdom
// does not provide. We install them once on the prototypes so that production
// code that calls container.createEl(), addClass(), etc. works in tests.
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svgProto = SVGElement.prototype as any;

  type CreateElOpts = {
    cls?: string;
    text?: string;
    type?: string;
    attr?: Record<string, string>;
    href?: string;
  };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
    if (opts?.href) (el as HTMLAnchorElement).href = opts.href;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    this.appendChild(el);
    return el;
  }

  htmlProto.createEl = createElOn;
  htmlProto.createDiv = function(this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("div", opts);
  };
  htmlProto.createSpan = function(this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("span", opts);
  };
  htmlProto.appendText = function(this: HTMLElement, text: string) {
    this.appendChild(document.createTextNode(text));
  };
  htmlProto.addClass = function(this: HTMLElement, cls: string) {
    this.classList.add(cls);
  };
  htmlProto.toggleClass = function(this: HTMLElement, cls: string, force?: boolean) {
    this.classList.toggle(cls, force);
  };
  htmlProto.hasClass = function(this: HTMLElement, cls: string): boolean {
    return this.classList.contains(cls);
  };
  htmlProto.setText = function(this: HTMLElement, text: string) {
    this.textContent = text;
  };
  htmlProto.empty = function(this: HTMLElement) {
    this.innerHTML = "";
  };

  // SVG elements also use addClass (e.g. in buildProgressCircle)
  svgProto.addClass = function(this: SVGElement, cls: string) {
    this.classList.add(cls);
  };
  svgProto.toggleClass = function(this: SVGElement, cls: string, force?: boolean) {
    this.classList.toggle(cls, force);
  };
  svgProto.hasClass = function(this: SVGElement, cls: string): boolean {
    return this.classList.contains(cls);
  };
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Module mocks (must be before the imports that trigger them)
// ---------------------------------------------------------------------------

vi.mock("obsidian", () => ({
  App: class {},
  Component: class {},
  MarkdownRenderer: {
    render: vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
      const p = document.createElement("p");
      p.textContent = markdown;
      el.appendChild(p);
    }),
  },
  ItemView: class {
    contentEl = document.createElement("div");
    registerEvent() {}
    registerDomEvent() {}
  },
  Menu: class { addItem() { return this; } showAtMouseEvent() {} },
  TFile: class { path = ""; },
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  normalizePath: (p: string) => p,
  setIcon: () => {},
  moment: Object.assign(
    (...args: unknown[]) => {
      if (args.length === 0) return makeMomentObj(new Date());
      if (args.length >= 2 && args[1] === "YYYY-MM-DD") {
        const [y, m, d] = (args[0] as string).split("-").map(Number);
        return makeMomentObj(new Date(y, m - 1, d));
      }
      return makeMomentObj(new Date(args[0] as string));
    },
    { isMoment: () => false },
  ),
}));

vi.mock("./task-creator", () => ({
  TaskModal: class {},
  ConfirmModal: class {},
  ProjectModal: class {},
  patchTaskField: vi.fn(),
  deleteTaskFile: vi.fn(),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

vi.mock("../model/vault-reader", () => ({ loadVaultData: vi.fn() }));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  buildProgressCircle,
  renderInlineMarkdown,
  DashboardView,
} from "./dashboard-view";
import type { Task, Project } from "../model/shared";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

interface MomentObj {
  _d: Date;
  startOf(unit: string): MomentObj;
  diff(other: MomentObj, unit: string): number;
  format(fmt?: string): string;
  isSame(...args: unknown[]): boolean;
  isSameOrAfter(...args: unknown[]): boolean;
  isSameOrBefore(...args: unknown[]): boolean;
  isAfter(...args: unknown[]): boolean;
  add(n: number, unit: string): MomentObj;
  subtract(n: number, unit: string): MomentObj;
  endOf(unit: string): MomentObj;
  isoWeek(): number;
}

function makeMomentObj(d: Date): MomentObj {
  const self: MomentObj = {
    _d: d,
    startOf(unit) {
      if (unit === "day") self._d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      return self;
    },
    diff(other, unit) {
      if (unit === "days") return Math.round((self._d.getTime() - other._d.getTime()) / 86_400_000);
      return 0;
    },
    format: (fmt) => fmt ?? "",
    isSame: () => false,
    isSameOrAfter: () => false,
    isSameOrBefore: () => false,
    isAfter: () => false,
    add: () => self,
    subtract: () => self,
    endOf: () => self,
    isoWeek: () => 1,
  };
  return self;
}

const TODAY = "2026-06-29";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Test task",
    status: "todo",
    filePath: `tasks/${overrides.id}.md`,
    projectId: "proj1",
    tags: [],
    ...overrides,
  } as Task;
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    title: "Test project",
    filePath: `projects/${overrides.id}.md`,
    color: "#3b82f6",
    ...overrides,
  } as Project;
}

/** Build a minimal DashboardView-like object for calling private render methods. */
function makeView() {
  const plugin = {
    settings: {
      dashboardCollapsed: {} as Record<string, boolean>,
      dailyHabitsTag: "daily",
      projectsFolder: "projects",
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = Object.create(DashboardView.prototype) as any;
  view.app = { internalPlugins: { plugins: {} } };
  view.plugin = plugin;
  view.allTasks = [];
  view.scheduleRefresh = vi.fn();
  return view;
}

// ---------------------------------------------------------------------------
// buildProgressCircle
// ---------------------------------------------------------------------------

describe("buildProgressCircle", () => {
  it("creates an SVG element with the requested dimensions", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "pm-dash-circle-svg" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("width")).toBe("56");
    expect(svg.getAttribute("height")).toBe("56");
    expect(svg.getAttribute("viewBox")).toBe("0 0 56 56");
  });

  it("adds the requested CSS class to the svg element", () => {
    const svg = buildProgressCircle({ size: 28, r: 11, strokeWidth: 3, ratio: 0.8, svgClass: "pm-dash-item-circle" });
    expect(svg.classList.contains("pm-dash-item-circle")).toBe(true);
  });

  it("always renders a track circle", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg" });
    const circles = svg.querySelectorAll("circle");
    expect(circles.length).toBeGreaterThanOrEqual(1);
    expect(circles[0].classList.contains("pm-dash-circle-track")).toBe(true);
  });

  it("renders a fill circle when ratio > 0", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "my-svg" });
    const fill = svg.querySelector(".pm-dash-circle-fill");
    expect(fill).not.toBeNull();
    expect(fill?.classList.contains("pm-dash-circle-fill--empty")).toBe(false);
  });

  it("does not render a fill circle when ratio is 0 and emptyFill is false", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", emptyFill: false });
    expect(svg.querySelector(".pm-dash-circle-fill")).toBeNull();
  });

  it("renders an empty-fill circle when ratio is 0 and emptyFill is true", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", emptyFill: true });
    const fill = svg.querySelector(".pm-dash-circle-fill");
    expect(fill).not.toBeNull();
    expect(fill?.classList.contains("pm-dash-circle-fill--empty")).toBe(true);
  });

  it("renders a label text element when label is provided", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "my-svg", label: "3/5" });
    const text = svg.querySelector("text");
    expect(text).not.toBeNull();
    expect(text?.textContent).toBe("3/5");
    expect(text?.classList.contains("pm-dash-circle-label")).toBe(true);
  });

  it("does not render a label when label is not provided", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "my-svg" });
    expect(svg.querySelector("text")).toBeNull();
  });

  it("adds the dim class to the track when trackDim is true", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", trackDim: true });
    expect(svg.querySelector(".pm-dash-circle-track--dim")).not.toBeNull();
  });

  it("does not add the dim class when trackDim is false", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", trackDim: false });
    expect(svg.querySelector(".pm-dash-circle-track--dim")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderInlineMarkdown
// ---------------------------------------------------------------------------

describe("renderInlineMarkdown", () => {
  async function render(text: string): Promise<HTMLElement> {
    const container = document.createElement("span");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await renderInlineMarkdown(container, text, {} as any, {} as any);
    return container;
  }

  it("passes the text to MarkdownRenderer.render", async () => {
    const { MarkdownRenderer } = await import("obsidian");
    await render("hello world");
    expect(MarkdownRenderer.render).toHaveBeenCalledWith(expect.anything(), "hello world", expect.any(HTMLElement), "", expect.anything());
  });

  it("unwraps the <p> wrapper added by MarkdownRenderer", async () => {
    const el = await render("hello world");
    expect(el.querySelector("p")).toBeNull();
    expect(el.textContent).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// renderDeadlinesSection
// ---------------------------------------------------------------------------

describe("renderDeadlinesSection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderDeadlines(tasks: Task[], effectiveValuesMap?: Map<string, { priority: string | undefined; due: string | undefined }>) {
    const container = document.createElement("div");
    const view = makeView();
    const projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1" })]]);
    const effMap = effectiveValuesMap ?? new Map(tasks.map((t) => [t.id, { priority: t.priority, due: t.due }]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderDeadlinesSection(container, tasks, projectMap, effMap);
    return container;
  }

  it("shows an empty-state message when no tasks are passed", () => {
    const container = renderDeadlines([]);
    expect(container.textContent).toContain("No tasks due within 7 days");
  });

  it("renders one row per task", () => {
    const tasks = [
      makeTask({ id: "t1", title: "First", due: "2026-07-01" }),
      makeTask({ id: "t2", title: "Second", due: "2026-07-02" }),
    ];
    const container = renderDeadlines(tasks);
    const rows = container.querySelectorAll(".pm-dash-task-row");
    expect(rows.length).toBe(2);
  });

  it("displays the task title in each row", () => {
    const tasks = [makeTask({ id: "t1", title: "Fix the login bug", due: "2026-07-01" })];
    const container = renderDeadlines(tasks);
    expect(container.textContent).toContain("Fix the login bug");
  });

  it("attaches data-task-id to each row", () => {
    const tasks = [makeTask({ id: "abc123", title: "Task A", due: "2026-07-01" })];
    const container = renderDeadlines(tasks);
    const row = container.querySelector("[data-task-id='abc123']");
    expect(row).not.toBeNull();
  });

  it("shows the section inside a collapsible section wrapper", () => {
    const container = renderDeadlines([]);
    expect(container.querySelector(".pm-dash-section")).not.toBeNull();
    expect(container.querySelector(".pm-dash-section-header")).not.toBeNull();
  });

  it("shows the due-date label for a task", () => {
    const tasks = [makeTask({ id: "t1", title: "Task A", due: TODAY })];
    const container = renderDeadlines(tasks);
    expect(container.textContent).toContain("today");
  });

  it("shows an overdue label with the overdue CSS class", () => {
    const tasks = [makeTask({ id: "t1", title: "Overdue task", due: "2026-06-22" })];
    const container = renderDeadlines(tasks);
    expect(container.querySelector(".pm-dash-task-due--overdue")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderPrioritySection
// ---------------------------------------------------------------------------

describe("renderPrioritySection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderPriority(tasks: Task[], effectiveValuesMap?: Map<string, { priority: string | undefined; due: string | undefined }>) {
    const container = document.createElement("div");
    const view = makeView();
    const projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1" })]]);
    const effMap = effectiveValuesMap ?? new Map(tasks.map((t) => [t.id, { priority: t.priority, due: t.due }]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderPrioritySection(container, tasks, projectMap, effMap);
    return container;
  }

  it("shows an empty-state message when no tasks are passed", () => {
    const container = renderPriority([]);
    expect(container.textContent).toContain("No prioritized tasks");
  });

  it("renders one row per task", () => {
    const tasks = [
      makeTask({ id: "t1", title: "High task", priority: "high" }),
      makeTask({ id: "t2", title: "Critical task", priority: "critical" }),
    ];
    const container = renderPriority(tasks);
    expect(container.querySelectorAll(".pm-dash-task-row").length).toBe(2);
  });

  it("applies the priority ribbon colour for a high-priority task", () => {
    const tasks = [makeTask({ id: "t1", title: "Urgent", priority: "high" })];
    const container = renderPriority(tasks);
    const ribbon = container.querySelector<HTMLElement>(".pm-dash-task-ribbon");
    expect(ribbon?.style.backgroundColor).toBe("rgb(249, 115, 22)"); // #f97316
  });

  it("applies no ribbon colour when priority is absent", () => {
    const tasks = [makeTask({ id: "t1", title: "No priority" })];
    const container = renderPriority(tasks);
    const ribbon = container.querySelector<HTMLElement>(".pm-dash-task-ribbon");
    expect(ribbon?.style.backgroundColor).toBe("");
  });

  it("shows the project badge when the task has a known project", () => {
    const tasks = [makeTask({ id: "t1", title: "Task", priority: "medium", projectId: "proj1" })];
    const container = renderPriority(tasks);
    expect(container.querySelector(".pm-dash-expand-task-project, .pm-dash-task-project")).not.toBeNull();
  });

  it("renders a status badge for each task", () => {
    const tasks = [makeTask({ id: "t1", title: "Task", status: "in-progress" })];
    const container = renderPriority(tasks);
    const badge = container.querySelector(".pm-dash-task-status");
    expect(badge?.textContent).toBe("In Progress");
  });
});
