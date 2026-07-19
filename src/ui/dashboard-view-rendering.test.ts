// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// Hoisted so both the vi.mock factories below and the test bodies can reference them.
const { MockMenu, MockTaskModal, MockConfirmModal, MockTaskGraphView } = vi.hoisted(() => {
  class MockMenuItem {
    _onClick: (() => void) | null = null;
    _title = "";
    setTitle(t: string) { this._title = t; return this; }
    setIcon() { return this; }
    onClick(fn: () => void) { this._onClick = fn; return this; }
  }
  class MockMenu {
    static instances: MockMenu[] = [];
    items: MockMenuItem[] = [];
    constructor() { MockMenu.instances.push(this); }
    addItem(cb: (item: MockMenuItem) => void) {
      const item = new MockMenuItem();
      cb(item);
      this.items.push(item);
      return this;
    }
    showAtMouseEvent() {}
  }
  class MockTaskModal {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static instances: MockTaskModal[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public app: unknown, public opts: any) { MockTaskModal.instances.push(this); }
    open() {}
  }
  class MockConfirmModal {
    static instances: MockConfirmModal[] = [];
    constructor(public app: unknown, public message: string, public onConfirm: () => void) {
      MockConfirmModal.instances.push(this);
    }
    open() {}
  }
  class MockTaskGraphView {
    openTask = vi.fn().mockResolvedValue(undefined);
  }
  return { MockMenu, MockTaskModal, MockConfirmModal, MockTaskGraphView };
});

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

  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeDocument = document;
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
  Menu: MockMenu,
  Modal: class {},
  TFile: class { path = ""; },
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  Notice: vi.fn(),
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
  TaskModal: MockTaskModal,
  ConfirmModal: MockConfirmModal,
  ProjectModal: class {},
  patchTaskField: vi.fn().mockResolvedValue(undefined),
  deleteTaskFile: vi.fn().mockResolvedValue(undefined),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

vi.mock("../model/vault-reader", () => ({ loadVaultData: vi.fn() }));

vi.mock("../model/day-markdown-file", () => ({
  DayMarkdownFile: { ensure: vi.fn() },
}));

vi.mock("../model/day-task-actions", () => ({
  loadDayChecklist: vi.fn().mockResolvedValue({ items: [], filePath: null }),
  rescheduleChecklistItem: vi.fn().mockResolvedValue(undefined),
  moveChecklistItemToInbox: vi.fn().mockResolvedValue(undefined),
  deleteChecklistItem: vi.fn().mockResolvedValue(undefined),
  toggleChecklistItem: vi.fn().mockResolvedValue("- [x] Task"),
  isWithinPlanningWindow: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: MockTaskGraphView,
}));

const { mockOpenDatePicker } = vi.hoisted(() => ({ mockOpenDatePicker: vi.fn() }));
vi.mock("./date-picker", () => ({
  openDatePicker: (...args: unknown[]) => mockOpenDatePicker(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { buildProgressCircle } from "./progress-circle";
import { renderInlineMarkdown } from "./day-task-row";
import { DashboardView } from "./dashboard-view";
import { DayTask } from "../model/day-task";
import type { Task, Project } from "../model/shared";
import { openDropdown, patchTaskField, deleteTaskFile, openNoteFile } from "./task-creator";
import { DayMarkdownFile } from "../model/day-markdown-file";
import { Notice } from "obsidian";
import {
  loadDayChecklist,
  rescheduleChecklistItem,
  moveChecklistItemToInbox,
  deleteChecklistItem,
  toggleChecklistItem,
  isWithinPlanningWindow,
} from "../model/day-task-actions";

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
    isSame(...args: unknown[]) {
      const [other, unit] = args as [MomentObj, string];
      if (unit === "day") {
        const a = self._d, b = other._d;
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
      }
      return false;
    },
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
  // Object.create skips field initializers; render() would otherwise set this.
  view.projects = [];
  view.openNoteKeys = new Set<string>();
  view.scheduleRefresh = vi.fn();
  view.onRefresh = vi.fn();
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
    expect(ribbon?.style.getPropertyValue("--pm-ribbon-color")).toBe("#f97316");
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

// ---------------------------------------------------------------------------
// renderDayTaskRow (private) — checklist row tags/title/daily-icon
// ---------------------------------------------------------------------------

describe("renderDayTaskRow", () => {
  function renderRow(
    item: DayTask,
    opts?: { isDaily?: boolean; dateLabel?: { text: string; onClick: () => void }; rowDate?: unknown },
    filePath: string | null = "2026-06-30.md",
  ) {
    const list = document.createElement("ul");
    const view = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderDayTaskRow(list, item, filePath, "daily", "Inbox.md", opts ?? {});
    return list;
  }

  it("keeps a non-habits tag inline in the title text", () => {
    const item = DayTask.parse("- [ ] Call dentist #urgent", 0)!;
    const list = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-text")?.textContent).toBe("Call dentist #urgent");
  });

  it("keeps several non-habits tags inline in the title text", () => {
    const item = DayTask.parse("- [ ] Plan trip #daily #travel #work", 0)!;
    const list = renderRow(item, { isDaily: true });
    expect(list.querySelector(".pm-dash-checklist-text")?.textContent).toBe("Plan trip #travel #work");
  });

  it("strips the configured habits tag from the title text", () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const list = renderRow(item, { isDaily: true });
    expect(list.querySelector(".pm-dash-checklist-text")?.textContent).toBe("Morning routine");
  });

  it("shows the daily icon for isDaily rows", () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const list = renderRow(item, { isDaily: true });
    expect(list.querySelector(".pm-dash-checklist-daily-icon")).not.toBeNull();
  });

  it("adds the checked modifier class and checkbox state for a checked item", () => {
    const item = DayTask.parse("- [x] Done thing ✅ 2026-06-30", 0)!;
    const list = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-item--checked")).not.toBeNull();
    expect(list.querySelector(".pm-dash-checkbox--checked")).not.toBeNull();
  });

  it("omits the checked modifier class and checkbox state for an unchecked item", () => {
    const item = DayTask.parse("- [ ] Not done", 0)!;
    const list = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-item--checked")).toBeNull();
    expect(list.querySelector(".pm-dash-checkbox--checked")).toBeNull();
  });

  it("renders a clickable date label (linked to the source file) when filePath is set", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const onClick = vi.fn();
    const list = renderRow(item, { dateLabel: { text: "Jun 30", onClick } });
    const label = list.querySelector(".pm-dash-checklist-date-label") as HTMLElement;
    expect(label.textContent).toBe("Jun 30");
    expect(label.classList.contains("pm-dash-checklist-date-label--link")).toBe(true);
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders a non-linked date label when there is no filePath", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const onClick = vi.fn();
    const list = renderRow(item, { dateLabel: { text: "Jun 30", onClick } }, null);
    const label = list.querySelector(".pm-dash-checklist-date-label") as HTMLElement;
    expect(label.textContent).toBe("Jun 30");
    expect(label.classList.contains("pm-dash-checklist-date-label--link")).toBe(false);
  });

  it("omits the date label when none is given", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-date-label")).toBeNull();
  });

  it("renders edit-title, note, reschedule, inbox, and delete actions for a non-daily unchecked item", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    const actions = list.querySelector(".pm-day-task-actions")!;
    expect(actions.querySelectorAll("button").length).toBeGreaterThanOrEqual(4);
  });

  it("omits the edit-title button for a daily (habit) item", () => {
    const item = DayTask.parse("- [ ] Task #daily", 0)!;
    const list = renderRow(item, { isDaily: true });
    // Only the note-action button remains for daily rows.
    const actions = list.querySelector(".pm-day-task-actions")!;
    expect(actions.querySelectorAll(".pm-day-task-action-btn").length).toBe(1);
  });

  it("offers a promote button on an actionable item", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    expect(list.querySelector("[aria-label='Promote to project task']")).not.toBeNull();
  });

  it("omits promote for a daily item", () => {
    // Habits are regenerated from their definition; promoting one would strand it.
    const item = DayTask.parse("- [ ] Task #daily", 0)!;
    const list = renderRow(item, { isDaily: true });
    expect(list.querySelector("[aria-label='Promote to project task']")).toBeNull();
  });

  it("omits promote for a checked item", () => {
    const item = DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!;
    const list = renderRow(item);
    expect(list.querySelector("[aria-label='Promote to project task']")).toBeNull();
  });

  it("opens the destination picker with the day note as the source", () => {
    const spy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(DashboardView.prototype as any, "openPromoteModal")
      .mockImplementation(() => {});
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item, undefined, "2026-06-30.md");
    (list.querySelector("[aria-label='Promote to project task']") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // The line lives in the day note, not the inbox.
    expect(spy).toHaveBeenCalledWith(item, "2026-06-30.md", expect.anything(), "daily");
    spy.mockRestore();
  });

  it("omits reschedule/inbox/delete for a daily item", () => {
    const item = DayTask.parse("- [ ] Task #daily", 0)!;
    const list = renderRow(item, { isDaily: true });
    expect(list.querySelector("[aria-label='Move to inbox']")).toBeNull();
    expect(list.querySelector("[aria-label='Delete']")).toBeNull();
  });

  it("omits reschedule/inbox/delete for a checked item", () => {
    const item = DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!;
    const list = renderRow(item);
    expect(list.querySelector("[aria-label='Move to inbox']")).toBeNull();
    expect(list.querySelector("[aria-label='Delete']")).toBeNull();
  });

  it("omits every action button when there is no filePath", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item, undefined, null);
    expect(list.querySelector(".pm-day-task-actions")).toBeNull();
  });

  it("does not attach a checkbox click handler when there is no filePath", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item, undefined, null);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggleChecklistItem).not.toHaveBeenCalled();
  });

  it("reschedules the item and refreshes on date change", async () => {
    vi.mocked(rescheduleChecklistItem).mockClear();
    mockOpenDatePicker.mockClear();
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    const calBtn = list.querySelector("[aria-label='Reschedule']") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const { onPick } = mockOpenDatePicker.mock.calls[0][1];
    onPick(makeMomentObj(new Date(2026, 6, 10)));
    await Promise.resolve();
    await Promise.resolve();
    expect(rescheduleChecklistItem).toHaveBeenCalledOnce();
  });

  it("opens the reschedule picker seeded with the row's own date", () => {
    mockOpenDatePicker.mockClear();
    const item = DayTask.parse("- [ ] Task", 0)!;
    const rowDate = makeMomentObj(new Date(2026, 6, 18));
    const list = renderRow(item, { rowDate });
    const calBtn = list.querySelector("[aria-label='Reschedule']") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker.mock.calls[0][1].initial).toBe(rowDate);
  });

  it("rejects the reschedule and shows a Notice when outside the planning window", async () => {
    vi.mocked(rescheduleChecklistItem).mockClear();
    vi.mocked(Notice).mockClear();
    mockOpenDatePicker.mockClear();
    vi.mocked(isWithinPlanningWindow).mockReturnValueOnce({ valid: false, reason: "Too far ahead" });
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    const calBtn = list.querySelector("[aria-label='Reschedule']") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const { onPick } = mockOpenDatePicker.mock.calls[0][1];
    onPick(makeMomentObj(new Date(2027, 0, 1)));
    await Promise.resolve();
    await Promise.resolve();
    expect(rescheduleChecklistItem).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("Too far ahead");
  });

  it("moves the item to the inbox on click and refreshes", async () => {
    vi.mocked(moveChecklistItemToInbox).mockClear();
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    const inboxBtn = list.querySelector("[aria-label='Move to inbox']") as HTMLElement;
    inboxBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(moveChecklistItemToInbox).toHaveBeenCalledOnce();
  });

  it("confirms and deletes the item on delete-button click", async () => {
    vi.mocked(deleteChecklistItem).mockClear();
    MockConfirmModal.instances.length = 0;
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    const deleteBtn = list.querySelector("[aria-label='Delete']") as HTMLElement;
    deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(MockConfirmModal.instances).toHaveLength(1);
    expect(MockConfirmModal.instances[0].message).toBe('Delete "Task"?');
    MockConfirmModal.instances[0].onConfirm();
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteChecklistItem).toHaveBeenCalledOnce();
  });

  it("toggles the checkbox optimistically on click", async () => {
    vi.mocked(toggleChecklistItem).mockClear();
    vi.mocked(toggleChecklistItem).mockResolvedValueOnce("- [x] Task ✅ 2026-06-30");
    const item = DayTask.parse("- [ ] Task", 0)!;
    const list = renderRow(item);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(toggleChecklistItem).toHaveBeenCalledOnce();
    expect(list.querySelector(".pm-dash-checklist-item--checked")).not.toBeNull();
    expect(box.classList.contains("pm-dash-checkbox--checked")).toBe(true);
    expect(item.checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderChecklistSection (private)
// ---------------------------------------------------------------------------

describe("renderChecklistSection", () => {
  function renderSection(items: DayTask[], filePath: string | null, date = makeMomentObj(new Date(TODAY))) {
    const view = makeView();
    const container = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderChecklistSection(container, items, filePath, date, "Inbox.md");
    return container;
  }

  it("shows an empty-state message when there are no items", () => {
    const container = renderSection([], "2026-06-29.md");
    expect(container.textContent).toContain("No checklist items in");
  });

  it("labels the section 'Today's Checklist' when the date is today", () => {
    vi.setSystemTime(new Date(TODAY));
    const container = renderSection([], "2026-06-29.md", makeMomentObj(new Date(TODAY)));
    expect(container.textContent).toContain("Today's Checklist");
  });

  it("labels the section with the formatted date when it isn't today", () => {
    vi.setSystemTime(new Date(TODAY));
    const otherDay = makeMomentObj(new Date(2026, 5, 20));
    const container = renderSection([], "2026-06-20.md", otherDay);
    expect(container.textContent).toContain("MMM D's Checklist");
  });

  it("splits items into a daily-tagged group (rendered first) and the rest", () => {
    const daily = DayTask.parse("- [ ] Meditate #daily", 0)!;
    const other = DayTask.parse("- [ ] Buy milk", 1)!;
    const container = renderSection([other, daily], "2026-06-29.md");
    const rows = container.querySelectorAll(".pm-dash-checklist-text");
    expect(rows[0].textContent).toBe("Meditate");
    expect(rows[1].textContent).toBe("Buy milk");
  });
});

// ---------------------------------------------------------------------------
// renderAdjacentUnclosedSection (private)
// ---------------------------------------------------------------------------

describe("renderAdjacentUnclosedSection", () => {
  function renderSection(days: unknown[], key = "tasks.previousUnclosed", title = "Overdue tasks") {
    const view = makeView();
    const container = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderAdjacentUnclosedSection(container, days, key, title, "Inbox.md");
    return container;
  }

  it("renders nothing when there are no days", () => {
    const container = renderSection([]);
    expect(container.children.length).toBe(0);
  });

  it("uses the 'previous' tooltip for a previous-unclosed key", () => {
    const day = { offset: -1, date: makeMomentObj(new Date(TODAY)), filePath: "f.md", unclosedItems: [DayTask.parse("- [ ] Old task", 0)!] };
    const container = renderSection([day], "tasks.previousUnclosed", "Overdue tasks");
    expect(container.querySelector(".pm-dash-section-tooltip")?.textContent).toContain("previous 7 days");
  });

  it("uses the 'next' tooltip for an upcoming-unclosed key", () => {
    const day = { offset: 1, date: makeMomentObj(new Date(TODAY)), filePath: "f.md", unclosedItems: [DayTask.parse("- [ ] Future task", 0)!] };
    const container = renderSection([day], "tasks.upcomingUnclosed", "Upcoming tasks");
    expect(container.querySelector(".pm-dash-section-tooltip")?.textContent).toContain("next 7 days");
  });

  it("renders one row per unclosed item across all days, each with a date label", () => {
    const day1 = { offset: -2, date: makeMomentObj(new Date(2026, 5, 27)), filePath: "d1.md", unclosedItems: [DayTask.parse("- [ ] A", 0)!] };
    const day2 = { offset: -1, date: makeMomentObj(new Date(2026, 5, 28)), filePath: "d2.md", unclosedItems: [DayTask.parse("- [ ] B", 0)!, DayTask.parse("- [ ] C", 1)!] };
    const container = renderSection([day1, day2]);
    expect(container.querySelectorAll(".pm-day-task-row")).toHaveLength(3);
    expect(container.querySelectorAll(".pm-dash-checklist-date-label")).toHaveLength(3);
  });

  it("opens the day's note when its date label is clicked", () => {
    vi.mocked(openNoteFile).mockClear();
    const day = { offset: -1, date: makeMomentObj(new Date(TODAY)), filePath: "d1.md", unclosedItems: [DayTask.parse("- [ ] A", 0)!] };
    const container = renderSection([day]);
    const label = container.querySelector(".pm-dash-checklist-date-label") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(expect.anything(), "d1.md");
  });
});

// ---------------------------------------------------------------------------
// loadAdjacentUnclosed
// ---------------------------------------------------------------------------

describe("loadAdjacentUnclosed", () => {
  it("fetches before/after days using configured window sizes and filters to unclosed items", async () => {
    vi.mocked(loadDayChecklist).mockReset();
    vi.mocked(loadDayChecklist).mockResolvedValue({
      items: [DayTask.parse("- [ ] Open item", 0)!, DayTask.parse("- [x] Closed item ✅ 2026-06-29", 1)!],
      filePath: "f.md",
    });
    const view = makeView();
    view.plugin.settings.unclosedDaysBefore = 2;
    view.plugin.settings.unclosedDaysAfter = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (view as any).loadAdjacentUnclosed(makeMomentObj(new Date(TODAY)), { folder: "", format: "YYYY-MM-DD", template: "" });
    expect(loadDayChecklist).toHaveBeenCalledTimes(3);
    expect(result.length).toBeGreaterThan(0);
    for (const d of result) {
      expect(d.unclosedItems.every((it: DayTask) => !it.checked)).toBe(true);
    }
  });

  it("excludes days whose only items are closed or habit-tagged", async () => {
    vi.mocked(loadDayChecklist).mockReset();
    vi.mocked(loadDayChecklist).mockResolvedValue({
      items: [DayTask.parse("- [ ] Habit #daily", 0)!],
      filePath: "f.md",
    });
    const view = makeView();
    view.plugin.settings.unclosedDaysBefore = 1;
    view.plugin.settings.unclosedDaysAfter = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (view as any).loadAdjacentUnclosed(makeMomentObj(new Date(TODAY)), { folder: "", format: "YYYY-MM-DD", template: "" });
    expect(result).toEqual([]);
  });

  it("defaults the before/after window to 7 days when unset", async () => {
    vi.mocked(loadDayChecklist).mockReset();
    vi.mocked(loadDayChecklist).mockResolvedValue({ items: [], filePath: null });
    const view = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).loadAdjacentUnclosed(makeMomentObj(new Date(TODAY)), { folder: "", format: "YYYY-MM-DD", template: "" });
    expect(loadDayChecklist).toHaveBeenCalledTimes(14);
  });
});

// ---------------------------------------------------------------------------
// render (top-level)
// ---------------------------------------------------------------------------

describe("DashboardView.render", () => {
  function renderDashboard(view: ReturnType<typeof makeView>, overrides: {
    checklistItems?: DayTask[];
    dnPath?: string | null;
    tasks?: Task[];
    projects?: Project[];
    adjacentData?: unknown[];
  } = {}) {
    const content = document.createElement("div");
    view.render(
      content,
      overrides.checklistItems ?? [],
      overrides.dnPath ?? null,
      overrides.tasks ?? [],
      overrides.projects ?? [],
      overrides.adjacentData ?? [],
      "Inbox.md",
    );
    return content;
  }

  it("marks the date text as having a note when dnPath is set", () => {
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view, { dnPath: "2026-06-29.md" });
    expect(content.querySelector(".pm-dash-date-text--has-note")).not.toBeNull();
  });

  it("marks the date text as having no note when dnPath is null", () => {
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view, { dnPath: null });
    expect(content.querySelector(".pm-dash-date-text--no-note")).not.toBeNull();
  });

  it("opens the existing note directly when the date label is clicked and dnPath is set", () => {
    vi.mocked(openNoteFile).mockClear();
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view, { dnPath: "2026-06-29.md" });
    const label = content.querySelector(".pm-dash-date-text") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(view.app, "2026-06-29.md");
  });

  it("creates the note via DayMarkdownFile.ensure when the date label is clicked and there is no note yet", async () => {
    vi.mocked(openNoteFile).mockClear();
    vi.mocked(DayMarkdownFile.ensure).mockResolvedValue({ filePath: "2026-06-29.md" } as never);
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view, { dnPath: null });
    const label = content.querySelector(".pm-dash-date-text") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(openNoteFile).toHaveBeenCalledWith(view.app, "2026-06-29.md");
  });

  it("does not open a note when ensure() fails to produce one", async () => {
    vi.mocked(openNoteFile).mockClear();
    vi.mocked(DayMarkdownFile.ensure).mockResolvedValue(null as never);
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view, { dnPath: null });
    const label = content.querySelector(".pm-dash-date-text") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(openNoteFile).not.toHaveBeenCalled();
  });

  it("shows a 'Today' button when the date isn't today, and it jumps back to today", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(2026, 5, 20));
    const content = renderDashboard(view);
    const todayBtn = content.querySelector(".pm-dash-today-btn") as HTMLElement;
    expect(todayBtn).not.toBeNull();
    todayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("omits the 'Today' button when the date is already today", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view);
    expect(content.querySelector(".pm-dash-today-btn")).toBeNull();
  });

  it("navigates to the previous/next day via the nav buttons", () => {
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view);
    const [prevBtn, , nextBtn] = content.querySelectorAll(".pm-dash-nav-btn");
    prevBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.onRefresh).toHaveBeenCalled();
    (view.onRefresh as ReturnType<typeof vi.fn>).mockClear();
    nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("opens the date picker seeded with the current date and jumps to the picked day", () => {
    mockOpenDatePicker.mockClear();
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const content = renderDashboard(view);
    const calBtn = content.querySelector(".pm-dash-cal-btn") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker).toHaveBeenCalledOnce();
    const [anchor, opts] = mockOpenDatePicker.mock.calls[0];
    expect(anchor).toBe(calBtn);
    expect(opts.initial).toBe(view.dashboardDate);
    const picked = makeMomentObj(new Date(2026, 6, 10));
    opts.onPick(picked);
    expect(view.dashboardDate).toBe(picked);
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("renders the deadlines and priority sections from the given tasks", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = makeMomentObj(new Date(TODAY));
    const tasks: Task[] = [makeTask({ id: "t1", due: TODAY, priority: "high" })];
    const content = renderDashboard(view, { tasks });
    expect(content.textContent).toContain("Approaching Deadlines");
    expect(content.textContent).toContain("Priority Queue");
  });
});

// ---------------------------------------------------------------------------
// BaseTabView (methods inherited by DashboardView)
// ---------------------------------------------------------------------------

describe("BaseTabView", () => {
  beforeEach(() => {
    MockMenu.instances.length = 0;
    MockTaskModal.instances.length = 0;
    MockConfirmModal.instances.length = 0;
    vi.clearAllMocks();
  });

  it("runs the class field initializers when constructed normally", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = new DashboardView({} as any, { settings: { dashboardCollapsed: {} } } as any, () => {});
    expect(view.allTasks).toEqual([]);
  });

  // ── createCollapsibleSection ──────────────────────────────────────────────

  describe("createCollapsibleSection", () => {
    it("adds the sub modifier class when sub is true", () => {
      const view = makeView();
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { section } = (view as any).createCollapsibleSection(container, "Title", "key1", { sub: true });
      expect(section.classList.contains("pm-dash-section--sub")).toBe(true);
    });

    it("omits the sub modifier class by default", () => {
      const view = makeView();
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { section } = (view as any).createCollapsibleSection(container, "Title", "key1");
      expect(section.classList.contains("pm-dash-section--sub")).toBe(false);
    });

    it("starts collapsed (chevron class + hidden body) when the key is marked collapsed", () => {
      const view = makeView();
      view.plugin.settings.dashboardCollapsed["key1"] = true;
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { section, body } = (view as any).createCollapsibleSection(container, "Title", "key1");
      expect(section.querySelector(".pm-dash-section-chevron--collapsed")).not.toBeNull();
      expect(body.style.display).toBe("none");
    });

    it("starts expanded when the key is not marked collapsed", () => {
      const view = makeView();
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { section, body } = (view as any).createCollapsibleSection(container, "Title", "key1");
      expect(section.querySelector(".pm-dash-section-chevron--collapsed")).toBeNull();
      expect(body.style.display).toBe("");
    });

    it("toggles collapsed state and persists it on header click", () => {
      const view = makeView();
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { section, body } = (view as any).createCollapsibleSection(container, "Title", "key1");
      const header = section.querySelector(".pm-dash-section-header") as HTMLElement;

      header.click();
      expect(view.plugin.settings.dashboardCollapsed["key1"]).toBe(true);
      expect(body.style.display).toBe("none");
      expect(view.plugin.saveSettings).toHaveBeenCalled();

      header.click();
      expect(view.plugin.settings.dashboardCollapsed["key1"]).toBe(false);
      expect(body.style.display).toBe("");
    });

    it("renders a tooltip and toggles it open/closed on click, closing on an outside click", () => {
      const view = makeView();
      const container = document.createElement("div");
      document.body.appendChild(container);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).createCollapsibleSection(container, "Title", "key1", { tooltip: "Explains things" });
      const info = container.querySelector(".pm-dash-section-info") as HTMLElement;
      expect(info).not.toBeNull();
      expect(container.querySelector(".pm-dash-section-tooltip")?.textContent).toBe("Explains things");

      info.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(info.classList.contains("pm-dash-section-info--open")).toBe(true);

      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(info.classList.contains("pm-dash-section-info--open")).toBe(false);

      container.remove();
    });

    it("omits the tooltip icon when no tooltip is given", () => {
      const view = makeView();
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).createCollapsibleSection(container, "Title", "key1");
      expect(container.querySelector(".pm-dash-section-info")).toBeNull();
    });
  });

  // ── renderTaskRow ──────────────────────────────────────────────────────────

  describe("renderTaskRow", () => {
    function renderRow(task: Task, opts: {
      projectMap?: Map<string, Project>;
      effectivePriority?: string;
      effectiveDue?: string;
      readonly?: boolean;
    } = {}) {
      const view = makeView();
      const container = document.createElement("div");
      const projectMap = opts.projectMap ?? new Map<string, Project>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderTaskRow(container, task, projectMap, opts.effectivePriority, opts.effectiveDue, opts.readonly ?? false);
      return { view, row: container.querySelector(".pm-dash-task-row") as HTMLElement };
    }

    it("adds the readonly modifier class and skips interactive handlers when readonly", () => {
      const { row } = renderRow(makeTask({ id: "t1" }), { readonly: true });
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(true);
      expect(row.querySelector(".pm-dash-task-edit-btn")).toBeNull();
    });

    it("omits the readonly modifier class by default", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(false);
    });

    it("falls back to 'None' for an own priority label not in PRIORITY_LABELS", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: "made-up" as Task["priority"] }));
      const ribbon = row.querySelector(".pm-dash-task-ribbon") as HTMLElement;
      expect(ribbon.title).toBe("Priority: None");
    });

    it("falls back to the raw value for an effective priority label not in PRIORITY_LABELS", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: "low" }), { effectivePriority: "made-up" });
      const ribbon = row.querySelector(".pm-dash-task-ribbon") as HTMLElement;
      expect(ribbon.title).toContain("Effective priority: made-up");
    });

    it("shows the effective-priority title when it differs from the task's own priority", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: "low" }), { effectivePriority: "high" });
      const ribbon = row.querySelector(".pm-dash-task-ribbon") as HTMLElement;
      expect(ribbon.title).toBe("Effective priority: High (own: Low)");
    });

    it("shows the plain priority title when there is no effective priority", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: "low" }));
      const ribbon = row.querySelector(".pm-dash-task-ribbon") as HTMLElement;
      expect(ribbon.title).toBe("Priority: Low");
    });

    it("falls back to the raw status string for a status not in STATUS_LABELS", () => {
      const { row } = renderRow(makeTask({ id: "t1", status: "made-up-status" }));
      const statusBadge = row.querySelector(".pm-dash-task-status") as HTMLElement;
      expect(statusBadge.textContent).toBe("made-up-status");
    });

    it("sets a due-date title when the effective due date differs from the task's own", () => {
      const { row } = renderRow(makeTask({ id: "t1", due: "2026-07-01" }), { effectiveDue: "2026-07-05" });
      const dueSpan = row.querySelector(".pm-dash-task-due") as HTMLElement;
      expect(dueSpan.title).toBe("Effective deadline: 2026-07-05 (own: 2026-07-01)");
    });

    it("shows 'none' for the own due date when the task has no due date of its own", () => {
      const { row } = renderRow(makeTask({ id: "t1" }), { effectiveDue: "2026-07-05" });
      const dueSpan = row.querySelector(".pm-dash-task-due") as HTMLElement;
      expect(dueSpan.title).toBe("Effective deadline: 2026-07-05 (own: none)");
    });

    it("does not set a due-date title when there is no effective due date", () => {
      const { row } = renderRow(makeTask({ id: "t1", due: "2026-07-01" }));
      const dueSpan = row.querySelector(".pm-dash-task-due") as HTMLElement;
      expect(dueSpan.title).toBe("");
    });

    it("shows the project badge with its color when the task belongs to a known project", () => {
      const projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1", title: "Alpha", color: "#ff0000" })]]);
      const { row } = renderRow(makeTask({ id: "t1", projectId: "proj1" }), { projectMap });
      const badge = row.querySelector(".pm-dash-task-project") as HTMLElement;
      expect(badge.textContent).toBe("Alpha");
      expect(badge.style.getPropertyValue("--pm-project-color")).toBeTruthy();
    });

    it("omits the project badge when the project is unknown", () => {
      const { row } = renderRow(makeTask({ id: "t1", projectId: "missing" }));
      expect(row.querySelector(".pm-dash-task-project")).toBeNull();
    });

    it("opens a priority dropdown on ribbon click and patches the field on select", async () => {
      const { view, row } = renderRow(makeTask({ id: "t1", filePath: "t1.md" }));
      const ribbon = row.querySelector(".pm-dash-task-ribbon") as HTMLElement;
      view.onRefresh = vi.fn();
      ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openDropdown).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (openDropdown as any).mock.calls[0][1];
      await options[0].onSelect();
      expect(patchTaskField).toHaveBeenCalledWith(view.app, "t1.md", "priority", options[0].label === "None" ? "" : expect.anything());
    });

    it("opens a status dropdown on status-badge click and patches the field on select", async () => {
      const { view, row } = renderRow(makeTask({ id: "t1", filePath: "t1.md" }));
      const statusBadge = row.querySelector(".pm-dash-task-status") as HTMLElement;
      statusBadge.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openDropdown).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (openDropdown as any).mock.calls[0][1];
      await options[0].onSelect();
      expect(patchTaskField).toHaveBeenCalledWith(view.app, "t1.md", "status", expect.any(String));
    });

    it("opens the edit modal on edit-button click", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      const editBtn = row.querySelector(".pm-dash-task-edit-btn") as HTMLElement;
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(MockTaskModal.instances).toHaveLength(1);
      expect(MockTaskModal.instances[0].opts.mode).toBe("edit");
    });

    it("opens the note file directly (ctrl/meta-click) instead of the edit modal", () => {
      const { row } = renderRow(makeTask({ id: "t1", filePath: "t1.md" }));
      const editBtn = row.querySelector(".pm-dash-task-edit-btn") as HTMLElement;
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      expect(openNoteFile).toHaveBeenCalledOnce();
      expect(MockTaskModal.instances).toHaveLength(0);
    });

    it("opens the task in the graph view when the row itself is clicked", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(view, "openInGraph").mockResolvedValue(undefined);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(spy).toHaveBeenCalledOnce();
    });

    it("does not open the graph view when clicking the ribbon", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(view, "openInGraph").mockResolvedValue(undefined);
      const ribbon = row.querySelector(".pm-dash-task-ribbon") as HTMLElement;
      ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(spy).not.toHaveBeenCalled();
    });

    it("guards against a bubbled click whose target lands on the ribbon/status/edit-button (belt-and-suspenders alongside their own stopPropagation)", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(view, "openInGraph").mockResolvedValue(undefined);
      const ribbon = row.querySelector(".pm-dash-task-ribbon") as HTMLElement;
      // Bypass the ribbon's own stopPropagation by dispatching directly on the row,
      // with e.target overridden to point at the ribbon, to exercise row's own guard.
      const event = new MouseEvent("click", { bubbles: true });
      Object.defineProperty(event, "target", { value: ribbon, configurable: true });
      row.dispatchEvent(event);
      expect(spy).not.toHaveBeenCalled();
    });

    it("opens the context menu on right-click", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(view, "openTaskContextMenu").mockImplementation(() => {});
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      expect(spy).toHaveBeenCalledOnce();
    });

    it("does not attach a context-menu handler when readonly", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }), { readonly: true });
      const spy = vi.spyOn(view, "openTaskContextMenu").mockImplementation(() => {});
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── renderExpandList ─────────────────────────────────────────────────────

  describe("renderExpandList", () => {
    it("shows an empty-state message when there are no tasks", () => {
      const view = makeView();
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderExpandList(container, [], new Map(), new Map());
      expect(container.querySelector(".pm-dash-expand-empty")?.textContent).toBe("No tasks");
    });

    it("renders a readonly row per task using the effective values map", () => {
      const view = makeView();
      const container = document.createElement("div");
      const task = makeTask({ id: "t1", priority: "low" });
      const effMap = new Map([["t1", { priority: "high", due: undefined }]]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderExpandList(container, [task], new Map(), effMap);
      const row = container.querySelector(".pm-dash-task-row") as HTMLElement;
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(true);
      expect(row.querySelector(".pm-dash-task-ribbon")?.getAttribute("title")).toContain("High");
    });
  });

  // ── countDescendants ─────────────────────────────────────────────────────

  describe("countDescendants", () => {
    it("returns 0 for a task with no children", () => {
      const view = makeView();
      view.allTasks = [makeTask({ id: "t1" })];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((view as any).countDescendants("t1")).toBe(0);
    });

    it("counts direct and nested children", () => {
      const view = makeView();
      view.allTasks = [
        makeTask({ id: "parent" }),
        makeTask({ id: "child1", parentId: "parent" }),
        makeTask({ id: "child2", parentId: "parent" }),
        makeTask({ id: "grandchild", parentId: "child1" }),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((view as any).countDescendants("parent")).toBe(3);
    });
  });

  // ── openTaskContextMenu ──────────────────────────────────────────────────

  describe("openTaskContextMenu", () => {
    function openMenu(task: Task, projectMap: Map<string, Project>, allTasks: Task[] = [task]) {
      const view = makeView();
      view.allTasks = allTasks;
      const e = new MouseEvent("contextmenu");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).openTaskContextMenu(e, task, projectMap);
      const menu = MockMenu.instances[0];
      // Looked up by title, not position, so adding a menu item doesn't silently
      // repoint these at the wrong action.
      const byTitle = (t: string) => {
        const item = menu.items.find((i) => i._title === t);
        if (!item) throw new Error(`no menu item titled "${t}"`);
        return item;
      };
      return {
        view,
        menu,
        addSubtask: byTitle("Add subtask"),
        moveTask: byTitle("Move task…"),
        deleteTask: byTitle("Delete task"),
      };
    }

    it("does nothing on 'Add subtask' when the project is unknown", () => {
      const task = makeTask({ id: "t1", projectId: "missing" });
      const { addSubtask } = openMenu(task, new Map());
      addSubtask._onClick!();
      expect(MockTaskModal.instances).toHaveLength(0);
    });

    it("opens a create-mode TaskModal for a known project on 'Add subtask'", () => {
      const project = makeProject({ id: "proj1", title: "Alpha", filePath: "Alpha.md" });
      const task = makeTask({ id: "t1", projectId: "proj1" });
      const projectMap = new Map([["proj1", project]]);
      const { addSubtask } = openMenu(task, projectMap);
      addSubtask._onClick!();
      expect(MockTaskModal.instances).toHaveLength(1);
      const opts = MockTaskModal.instances[0].opts;
      expect(opts.mode).toBe("create");
      expect(opts.projectId).toBe("proj1");
      expect(opts.parentTask).toBe(task);
    });

    it("prompts to delete a leaf task without a subtask count", () => {
      const task = makeTask({ id: "t1", title: "Leaf task" });
      const { deleteTask } = openMenu(task, new Map());
      deleteTask._onClick!();
      expect(MockConfirmModal.instances[0].message).toBe('Delete "Leaf task"?');
    });

    it("prompts with a singular subtask count for one descendant", () => {
      const task = makeTask({ id: "t1", title: "Parent" });
      const child = makeTask({ id: "c1", parentId: "t1" });
      const { deleteTask } = openMenu(task, new Map(), [task, child]);
      deleteTask._onClick!();
      expect(MockConfirmModal.instances[0].message).toBe('Delete "Parent" and its 1 subtask?');
    });

    it("prompts with a plural subtask count for multiple descendants", () => {
      const task = makeTask({ id: "t1", title: "Parent" });
      const child1 = makeTask({ id: "c1", parentId: "t1" });
      const child2 = makeTask({ id: "c2", parentId: "t1" });
      const { deleteTask } = openMenu(task, new Map(), [task, child1, child2]);
      deleteTask._onClick!();
      expect(MockConfirmModal.instances[0].message).toBe('Delete "Parent" and its 2 subtasks?');
    });

    it("deletes the task file (with no parent) when the confirm modal is accepted", () => {
      const task = makeTask({ id: "t1", title: "Leaf task" });
      const { view, deleteTask } = openMenu(task, new Map());
      deleteTask._onClick!();
      MockConfirmModal.instances[0].onConfirm();
      expect(deleteTaskFile).toHaveBeenCalledWith(view.app, task, undefined, [task]);
    });

    it("resolves and passes the parent task when the task has a findable parentId", () => {
      const parent = makeTask({ id: "p1", title: "Parent" });
      const task = makeTask({ id: "t1", title: "Child", parentId: "p1" });
      const { view, deleteTask } = openMenu(task, new Map(), [parent, task]);
      deleteTask._onClick!();
      MockConfirmModal.instances[0].onConfirm();
      expect(deleteTaskFile).toHaveBeenCalledWith(view.app, task, parent, [parent, task]);
    });
  });

  // ── openInGraph ──────────────────────────────────────────────────────────

  describe("openInGraph", () => {
    function makeGraphApp(leaves: unknown[]) {
      const revealLeaf = vi.fn();
      const getLeaf = vi.fn();
      return {
        workspace: {
          getLeavesOfType: vi.fn().mockReturnValue(leaves),
          getLeaf,
          revealLeaf,
        },
      };
    }

    it("reuses an existing task-graph leaf and reveals it", async () => {
      const view = makeView();
      const graphView = new MockTaskGraphView();
      const leaf = { view: graphView };
      view.app = makeGraphApp([leaf]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (view as any).openInGraph(makeTask({ id: "t1", projectId: "p1" }));
      expect(view.app.workspace.revealLeaf).toHaveBeenCalledWith(leaf);
      expect(graphView.openTask).toHaveBeenCalledWith("p1", "t1");
    });

    it("opens a new tab and activates the task-graph view when no leaf exists yet", async () => {
      const view = makeView();
      const graphView = new MockTaskGraphView();
      const newLeaf = { view: graphView, setViewState: vi.fn().mockResolvedValue(undefined) };
      const app = makeGraphApp([]);
      app.workspace.getLeaf.mockReturnValue(newLeaf);
      view.app = app;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (view as any).openInGraph(makeTask({ id: "t1", projectId: "p1" }));
      expect(newLeaf.setViewState).toHaveBeenCalledWith({ type: "pm-compass-task-graph", active: true });
      expect(app.workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
      expect(graphView.openTask).toHaveBeenCalledWith("p1", "t1");
    });

    it("does not call openTask when the leaf's view never becomes a TaskGraphView", async () => {
      const view = makeView();
      const newLeaf = { view: {}, setViewState: vi.fn().mockResolvedValue(undefined) };
      const app = makeGraphApp([]);
      app.workspace.getLeaf.mockReturnValue(newLeaf);
      view.app = app;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (view as any).openInGraph(makeTask({ id: "t1", projectId: "p1" }));
      expect(app.workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
    });
  });
});
