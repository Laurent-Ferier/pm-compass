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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeWindow = window;
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
      // `moment(aMoment)` copies it — how the code walks off a day without moving it.
      const arg = args[0] as { _d?: Date };
      if (arg && arg._d instanceof Date) return makeMomentObj(new Date(arg._d));
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
  reorderChecklistItem: vi.fn().mockResolvedValue(undefined),
  setChecklistItemPriority: vi.fn().mockResolvedValue(undefined),
  closeInboxItem: vi.fn().mockResolvedValue(undefined),
  unscheduleInboxItem: vi.fn().mockResolvedValue(undefined),
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
import { Task, type TaskFields, type Project } from "../model/shared";
import { openDropdown, patchTaskField, deleteTaskFile, openNoteFile } from "./task-creator";
import { DayMarkdownFile } from "../model/day-markdown-file";
import { Notice } from "obsidian";
import {
  loadDayChecklist,
  rescheduleChecklistItem,
  moveChecklistItemToInbox,
  deleteChecklistItem,
  toggleChecklistItem,
  reorderChecklistItem,
  setChecklistItemPriority,
  closeInboxItem,
  unscheduleInboxItem,
} from "../model/day-task-actions";
import { PRIORITY_COLORS, STATUS_COLORS, Priority, ScheduleOutcome } from "../model/task-vocabulary";
import type { EffectiveValues } from "../model/task-scoring";
import { dragHandle, pointerEvent } from "./__testing__/drag-pointer";
import { day, timestamp } from "../model/__testing__/dates";

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
  isBefore(...args: unknown[]): boolean;
  add(n: number, unit: string): MomentObj;
  subtract(n: number, unit: string): MomentObj;
  endOf(unit: string): MomentObj;
  isoWeek(): number;
  toDate(): Date;
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
    // Only the one format the code reads back as a value; the rest are labels.
    format: (fmt) => {
      if (fmt !== "YYYY-MM-DD") return fmt ?? "";
      const d = self._d;
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
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
    /** Real day comparison — the reschedule notice's wording turns on it. */
    isBefore(...args: unknown[]) {
      const [other] = args as [MomentObj];
      const a = self._d, b = other._d;
      return new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
        < new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    },
    // A real shift, on a copy: the dashboard walks the days around the one on show.
    add: (...args: unknown[]) => {
      const [amount, unit] = args as [number, string];
      if (unit !== "days" && unit !== "day") return self;
      const shifted = new Date(self._d);
      shifted.setDate(shifted.getDate() + amount);
      return makeMomentObj(shifted);
    },
    subtract: () => self,
    endOf: () => self,
    isoWeek: () => 1,
    toDate: () => new Date(self._d),
  };
  return self;
}

const TODAY = "2026-06-29";
/** `TODAY` as the model holds a day. */
const TODAY_DAY = day(TODAY);

/** The leading slot a list hands each row; unmovable here, as a list with no drag would. */
const inertLead = { addDragHandle: () => {}, movable: false };

function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
  return new Task({
    title: "Test task",
    status: "todo",
    filePath: `tasks/${overrides.id}.md`,
    projectId: "proj1",
    tags: [],
    dependencies: [],
    subtasks: [],
    ...overrides,
  });
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
      // The merged layout has its own describe below; everything else covers the split one.
      mergeDailyAndProjectTasks: false,
      splitTaskLists: true,
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
  // The day every date on the tab reads against; individual tests move it.
  view.dashboardDate = TODAY_DAY;
  // Set by render() in production; the section renderers below are called directly.
  view.context = {
    projectMap: new Map(), effectiveValues: new Map(), habitsTag: "daily", inboxPath: "Inbox.md",
  };
  view.openNoteKeys = new Set<string>();
  view.scheduleRefresh = vi.fn();
  view.onRefresh = vi.fn();
  view.showDay = vi.fn();
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

  it("marks the container before rendering, so the wrapper never adds a paragraph's height", async () => {
    const container = document.createElement("span");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = renderInlineMarkdown(container, "hello world", {} as any, {} as any);
    expect(container.classList.contains("pm-inline-md")).toBe(true);
    await pending;
    expect(container.classList.contains("pm-inline-md")).toBe(true);
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
    view.context.projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1" })]]);
    view.context.effectiveValues = effectiveValuesMap
      ?? new Map(tasks.map((t) => [t.id, { priority: t.priority, due: t.due }]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderDeadlinesSection(container, tasks);
    return container;
  }

  it("shows an empty-state message when no tasks are passed", () => {
    const container = renderDeadlines([]);
    expect(container.textContent).toContain("No tasks due within 7 days");
  });

  it("renders one row per task", () => {
    const tasks = [
      makeTask({ id: "t1", title: "First", due: day("2026-07-01") }),
      makeTask({ id: "t2", title: "Second", due: day("2026-07-02") }),
    ];
    const container = renderDeadlines(tasks);
    const rows = container.querySelectorAll(".pm-dash-task-row");
    expect(rows.length).toBe(2);
  });

  it("displays the task title in each row", () => {
    const tasks = [makeTask({ id: "t1", title: "Fix the login bug", due: day("2026-07-01") })];
    const container = renderDeadlines(tasks);
    expect(container.textContent).toContain("Fix the login bug");
  });

  it("attaches data-task-id to each row", () => {
    const tasks = [makeTask({ id: "abc123", title: "Task A", due: day("2026-07-01") })];
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
    const tasks = [makeTask({ id: "t1", title: "Task A", due: TODAY_DAY })];
    const container = renderDeadlines(tasks);
    expect(container.textContent).toContain("today");
  });

  it("badges an overdue deadline with its day count, warning tone and glyph", () => {
    const tasks = [makeTask({ id: "t1", title: "Overdue task", due: day("2026-06-22") })];
    const container = renderDeadlines(tasks);
    const badge = container.querySelector(".pm-task-badge--warning") as HTMLElement;
    expect(badge.textContent).toBe("7 d");
    expect(badge.querySelector(".pm-task-badge-icon")).not.toBeNull();
  });

  it("turns a long-overdue deadline red", () => {
    const tasks = [makeTask({ id: "t1", title: "Overdue task", due: day("2026-06-01") })];
    const container = renderDeadlines(tasks);
    expect(container.querySelector(".pm-task-badge--danger")).not.toBeNull();
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
    view.context.projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1" })]]);
    view.context.effectiveValues = effectiveValuesMap
      ?? new Map(tasks.map((t) => [t.id, { priority: t.priority, due: t.due }]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderPrioritySection(container, tasks);
    return container;
  }

  it("shows an empty-state message when no tasks are passed", () => {
    const container = renderPriority([]);
    expect(container.textContent).toContain("No prioritized tasks");
  });

  it("renders one row per task", () => {
    const tasks = [
      makeTask({ id: "t1", title: "High task", priority: Priority.High }),
      makeTask({ id: "t2", title: "Critical task", priority: Priority.Critical }),
    ];
    const container = renderPriority(tasks);
    expect(container.querySelectorAll(".pm-dash-task-row").length).toBe(2);
  });

  it("applies the priority ribbon colour for a high-priority task", () => {
    const tasks = [makeTask({ id: "t1", title: "Urgent", priority: Priority.High })];
    const container = renderPriority(tasks);
    const ribbon = container.querySelector<HTMLElement>(".pm-task-ribbon");
    expect(ribbon?.style.getPropertyValue("--pm-ribbon-color")).toBe("#f97316");
  });

  it("applies no ribbon colour when priority is absent", () => {
    const tasks = [makeTask({ id: "t1", title: "No priority" })];
    const container = renderPriority(tasks);
    const ribbon = container.querySelector<HTMLElement>(".pm-task-ribbon");
    expect(ribbon?.style.backgroundColor).toBe("");
  });

  it("shows the project badge when the task has a known project", () => {
    const tasks = [makeTask({ id: "t1", title: "Task", priority: Priority.Medium, projectId: "proj1" })];
    const container = renderPriority(tasks);
    expect(container.querySelector(".pm-dash-expand-task-project, .pm-dash-task-project")).not.toBeNull();
  });

  it("renders a status icon for each task", () => {
    const tasks = [makeTask({ id: "t1", title: "Task", status: "in-progress" })];
    const container = renderPriority(tasks);
    const icon = container.querySelector<HTMLElement>(".pm-dash-task-status-icon")!;
    expect(icon.title).toBe("Status: In Progress");
    expect(icon.style.getPropertyValue("--pm-status-color")).toBe(STATUS_COLORS["in-progress"]);
  });

  it("spells out both statuses for a task under a cancelled parent", () => {
    const child = makeTask({ id: "t1", title: "Task", status: "in-progress", parentId: "parent" });
    const container = document.createElement("div");
    const view = makeView();
    view.allTasks = [makeTask({ id: "parent", status: "cancelled" }), child];
    const effMap = new Map([[child.id, { priority: child.priority, due: child.due }]]);
    view.renderPrioritySection(container, [child], new Map<string, Project>(), effMap);

    const icon = container.querySelector<HTMLElement>(".pm-dash-task-status-icon")!;
    expect(icon.title).toBe("Status: In Progress / Cancelled");
    // The colour is the one in force, not the task's own.
    expect(icon.style.getPropertyValue("--pm-status-color")).toBe(STATUS_COLORS["cancelled"]);
  });
});

// ---------------------------------------------------------------------------
// renderChecklistRow (private) — checklist row tags/title/daily-icon
// ---------------------------------------------------------------------------

describe("renderChecklistRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A row as a list would draw it: the task carries the note it came from, so `noteDate`
   *  is what makes it another day's row (or the day on show, `TODAY`). */
  function renderRow(
    item: DayTask,
    opts: { noteDate?: Date | null; shownDate?: string } = {},
    filePath: string | null = "2026-06-30.md",
  ) {
    const list = document.createElement("ul");
    const view = makeView();
    view.dashboardDate = day(opts.shownDate ?? TODAY);
    const sourced = item.withSource(filePath, opts.noteDate ?? null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderChecklistRow(list, sourced, "daily", "Inbox.md", inertLead);
    return { list, item: sourced, view };
  }

  it("colours the ribbon by the line's priority marker, so a scheduled task keeps it visible", () => {
    const item = DayTask.parse("- [ ] Buy milk ⏫ ➕ 2026-06-01", 0)!;
    const { list } = renderRow(item);
    const ribbon = list.querySelector<HTMLElement>(".pm-task-ribbon")!;
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe(PRIORITY_COLORS[Priority.High]);
    expect(ribbon.title).toBe("Priority: High");
  });

  it("opens the priority dropdown on click, writing the pick back to the day's line", async () => {
    const { list, item } = renderRow(DayTask.parse("- [ ] Buy milk", 0)!);
    list.querySelector<HTMLElement>(".pm-task-ribbon")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(openDropdown).toHaveBeenCalled();
    const options = vi.mocked(openDropdown).mock.calls[0][1];
    options.find((o) => o.label === "High")!.onSelect();
    await Promise.resolve();
    expect(setChecklistItemPriority).toHaveBeenCalledWith(
      expect.anything(), "2026-06-30.md", item, Priority.High,
    );
  });

  it("shows an inert ribbon for a habit row, whose priority would be regenerated away", () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { list } = renderRow(item);
    const ribbon = list.querySelector<HTMLElement>(".pm-task-ribbon")!;
    expect(ribbon.classList.contains("pm-task-ribbon--editable")).toBe(false);
    ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openDropdown).not.toHaveBeenCalled();
  });

  it("shows an inert ribbon when there is no file to write the priority back to", () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { list } = renderRow(item, {}, null);
    expect(list.querySelector(".pm-task-ribbon--editable")).toBeNull();
  });

  it("keeps a non-habits tag inline in the title text", () => {
    const item = DayTask.parse("- [ ] Call dentist #urgent", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-text")?.textContent).toBe("Call dentist #urgent");
  });

  it("keeps several non-habits tags inline in the title text", () => {
    const item = DayTask.parse("- [ ] Plan trip #daily #travel #work", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-text")?.textContent).toBe("Plan trip #travel #work");
  });

  it("strips the configured habits tag from the title text", () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-text")?.textContent).toBe("Morning routine");
  });

  it("shows the daily icon for a habit row", () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-daily-icon")).not.toBeNull();
  });

  it("adds the checked modifier class and checkbox state for a checked item", () => {
    const item = DayTask.parse("- [x] Done thing ✅ 2026-06-30", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-item--checked")).not.toBeNull();
    expect(list.querySelector(".pm-dash-checkbox--checked")).not.toBeNull();
  });

  it("omits the checked modifier class and checkbox state for an unchecked item", () => {
    const item = DayTask.parse("- [ ] Not done", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector(".pm-dash-checklist-item--checked")).toBeNull();
    expect(list.querySelector(".pm-dash-checkbox--checked")).toBeNull();
  });

  it("badges a row of another day with that day, showing that day when clicked", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list, view } = renderRow(item, { noteDate: day("2026-06-22") });
    const label = list.querySelector(".pm-task-badge") as HTMLElement;
    // A past day reads as the shared overdue chip, exactly as a project task's deadline does.
    expect(label.textContent).toBe("7 d");
    expect(label.classList.contains("pm-task-badge--link")).toBe(true);
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.showDay).toHaveBeenCalledWith(day("2026-06-22"));
  });

  it("badges an upcoming day with a relative label", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item, { noteDate: day("2026-07-01") });
    expect((list.querySelector(".pm-task-badge") as HTMLElement).textContent).toBe("in 2d");
  });

  it("keeps the badge clickable for a line with no file of its own: the day is what it opens", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item, { noteDate: day("2026-06-22") }, null);
    const label = list.querySelector(".pm-task-badge") as HTMLElement;
    expect(label.classList.contains("pm-task-badge--link")).toBe(true);
  });

  it("badges a row of the day on show with 'today' — read against that day, not the real one", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item, { noteDate: TODAY_DAY });
    expect((list.querySelector(".pm-task-badge") as HTMLElement).textContent).toBe("today");
  });

  it("reads a row's day against the day on show, not against the real today", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item, { noteDate: TODAY_DAY, shownDate: "2026-07-02" });
    // TODAY's row, seen three days later: overdue by those three days.
    expect((list.querySelector(".pm-task-badge") as HTMLElement).textContent).toBe("3 d");
  });

  it("omits the date label when none is given", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector(".pm-task-badge")).toBeNull();
  });

  it("renders edit-title, note, reschedule, inbox, and delete actions for a non-daily unchecked item", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    const actions = list.querySelector(".pm-task-actions")!;
    expect(actions.querySelectorAll("button").length).toBeGreaterThanOrEqual(4);
  });

  it("omits the edit-title button for a daily (habit) item", () => {
    const item = DayTask.parse("- [ ] Task #daily", 0)!;
    const { list } = renderRow(item);
    // Only the note-action button remains for daily rows.
    const actions = list.querySelector(".pm-task-actions")!;
    expect(actions.querySelectorAll(".pm-task-action-btn").length).toBe(1);
  });

  it("offers a promote button on an actionable item", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Promote to project task']")).not.toBeNull();
  });

  it("omits promote for a daily item", () => {
    // Habits are regenerated from their definition; promoting one would strand it.
    const item = DayTask.parse("- [ ] Task #daily", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Promote to project task']")).toBeNull();
  });

  it("omits promote for a checked item", () => {
    const item = DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Promote to project task']")).toBeNull();
  });

  it("opens the destination picker with the day note as the source", () => {
    const spy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(DashboardView.prototype as any, "openPromoteModal")
      .mockImplementation(() => {});
    const { list, item } = renderRow(DayTask.parse("- [ ] Task", 0)!, {}, "2026-06-30.md");
    (list.querySelector("[aria-label='Promote to project task']") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // The line lives in the day note, not the inbox.
    expect(spy).toHaveBeenCalledWith(item, "2026-06-30.md", expect.anything(), "daily");
    spy.mockRestore();
  });

  it("omits reschedule/inbox/delete for a daily item", () => {
    const item = DayTask.parse("- [ ] Task #daily", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Move to inbox']")).toBeNull();
    expect(list.querySelector("[aria-label='Delete']")).toBeNull();
  });

  it("omits reschedule/inbox/delete for a checked item", () => {
    const item = DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Move to inbox']")).toBeNull();
    expect(list.querySelector("[aria-label='Delete']")).toBeNull();
  });

  it("omits every action button when there is no filePath", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item, undefined, null);
    expect(list.querySelector(".pm-task-actions")).toBeNull();
  });

  it("does not attach a checkbox click handler when there is no filePath", () => {
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item, undefined, null);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggleChecklistItem).not.toHaveBeenCalled();
  });

  it("reschedules the item and refreshes on date change", async () => {
    vi.mocked(rescheduleChecklistItem).mockClear();
    mockOpenDatePicker.mockClear();
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    const calBtn = list.querySelector("[aria-label='Reschedule']") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const { onPick } = mockOpenDatePicker.mock.calls[0][1];
    onPick(new Date(2026, 6, 10));
    await Promise.resolve();
    await Promise.resolve();
    expect(rescheduleChecklistItem).toHaveBeenCalledOnce();
  });

  it("opens the reschedule picker seeded with the day the row's own note is for", () => {
    mockOpenDatePicker.mockClear();
    const { list } = renderRow(DayTask.parse("- [ ] Task", 0)!, { noteDate: day("2026-07-18") });
    const calBtn = list.querySelector("[aria-label='Reschedule']") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker.mock.calls[0][1].initial).toEqual(day("2026-07-18"));
  });

  it("says the item went to the inbox when the target day took no task", async () => {
    vi.mocked(rescheduleChecklistItem).mockClear();
    vi.mocked(Notice).mockClear();
    mockOpenDatePicker.mockClear();
    vi.mocked(rescheduleChecklistItem).mockResolvedValueOnce(ScheduleOutcome.Targeted);
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    const calBtn = list.querySelector("[aria-label='Reschedule']") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const { onPick } = mockOpenDatePicker.mock.calls[0][1];
    const future = new Date();
    future.setDate(future.getDate() + 10);
    onPick(future);
    await Promise.resolve();
    await Promise.resolve();
    expect(rescheduleChecklistItem).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("Moved to the inbox"));
  });

  it("says a past target day leaves the item in the inbox, carrying that day", async () => {
    vi.mocked(rescheduleChecklistItem).mockClear();
    vi.mocked(Notice).mockClear();
    mockOpenDatePicker.mockClear();
    vi.mocked(rescheduleChecklistItem).mockResolvedValueOnce(ScheduleOutcome.Targeted);
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    const calBtn = list.querySelector("[aria-label='Reschedule']") as HTMLElement;
    calBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const { onPick } = mockOpenDatePicker.mock.calls[0][1];
    const past = new Date();
    past.setDate(past.getDate() - 3);
    onPick(past);
    await Promise.resolve();
    await Promise.resolve();
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("Moved to the inbox, targeted for"));
  });

  it("moves the item to the inbox on click and refreshes", async () => {
    vi.mocked(moveChecklistItemToInbox).mockClear();
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    const inboxBtn = list.querySelector("[aria-label='Move to inbox']") as HTMLElement;
    inboxBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(moveChecklistItemToInbox).toHaveBeenCalledOnce();
  });

  // A row still in the inbox: the two actions that would write to a day note are rerouted.
  it("closes a planned inbox row through the inbox, not by ticking its line", async () => {
    vi.mocked(closeInboxItem).mockClear();
    vi.mocked(toggleChecklistItem).mockClear();
    const item = DayTask.parse(`- [ ] Buy milk ⏳ ${TODAY}`, 0)!;
    const { list } = renderRow(item, {}, "Inbox.md");
    (list.querySelector(".pm-dash-checkbox") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(closeInboxItem).toHaveBeenCalledOnce();
    expect(toggleChecklistItem).not.toHaveBeenCalled();
  });

  it("turns the inbox action into an unplan on a planned inbox row", async () => {
    vi.mocked(unscheduleInboxItem).mockClear();
    vi.mocked(moveChecklistItemToInbox).mockClear();
    const item = DayTask.parse(`- [ ] Buy milk ⏳ ${TODAY}`, 0)!;
    const { list } = renderRow(item, {}, "Inbox.md");
    expect(list.querySelector("[aria-label='Move to inbox']")).toBeNull();
    (list.querySelector("[aria-label='Unplan']") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(unscheduleInboxItem).toHaveBeenCalledOnce();
    expect(moveChecklistItemToInbox).not.toHaveBeenCalled();
  });

  it("confirms and deletes the item on delete-button click", async () => {
    vi.mocked(deleteChecklistItem).mockClear();
    MockConfirmModal.instances.length = 0;
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
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
    const { list, item } = renderRow(DayTask.parse("- [ ] Task", 0)!);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(toggleChecklistItem).toHaveBeenCalledOnce();
    expect(list.querySelector(".pm-dash-checklist-item--checked")).not.toBeNull();
    expect(box.classList.contains("pm-dash-checkbox--checked")).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(item.checked).toBe(true);
  });

  it("is a focusable checkbox that the keyboard can tick", async () => {
    vi.mocked(toggleChecklistItem).mockClear();
    vi.mocked(toggleChecklistItem).mockResolvedValueOnce("- [x] Task ✅ 2026-06-30");
    const { list } = renderRow(DayTask.parse("- [ ] Task", 0)!);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;
    expect(box.getAttribute("role")).toBe("checkbox");
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("aria-checked")).toBe("false");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await Promise.resolve();
    expect(toggleChecklistItem).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// renderChecklistSection (private)
// ---------------------------------------------------------------------------

describe("renderChecklistSection", () => {
  function renderSection(items: DayTask[], filePath: string | null, date: Date = TODAY_DAY) {
    const view = makeView();
    view.dashboardDate = date;
    const container = document.createElement("div");
    const sourced = items.map((it) => it.withSource(filePath, TODAY_DAY));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderChecklistSection(container, sourced, filePath, date);
    // The rows are drawn from the sourced copies, which is what a drop reports.
    return Object.assign(container, { sourced });
  }

  it("shows an empty-state message when there are no items", () => {
    const container = renderSection([], "2026-06-29.md");
    expect(container.textContent).toContain("No checklist items in");
  });

  it("labels the section 'Today's Checklist' when the date is today", () => {
    vi.setSystemTime(new Date(TODAY));
    const container = renderSection([], "2026-06-29.md", TODAY_DAY);
    expect(container.textContent).toContain("Today's Checklist");
  });

  it("labels the section with the formatted date when it isn't today", () => {
    vi.setSystemTime(new Date(TODAY));
    const otherDay = new Date(2026, 5, 20);
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

  it("leaves every grip inert when the day has no note, or has only one task to move", () => {
    // The grips are still rendered: their width is what lines this list up with the others.
    const items = [DayTask.parse("- [ ] A", 0)!, DayTask.parse("- [ ] B", 1)!];
    const allInert = (c: HTMLElement) => [...c.querySelectorAll(".pm-reorder-handle")]
      .every((h) => h.classList.contains("pm-reorder-handle--inert"));
    expect(allInert(renderSection(items, null))).toBe(true);
    expect(allInert(renderSection([items[0]], "2026-06-29.md"))).toBe(true);
  });

  it("marks a habit row where the others carry their grip, so the list stays aligned", () => {
    const container = renderSection([
      DayTask.parse("- [ ] Meditate #daily", 0)!,
      DayTask.parse("- [ ] A", 1)!,
      DayTask.parse("- [ ] B", 2)!,
    ], "2026-06-29.md");
    // The habit row's leading slot holds the recurring mark instead of a grip: it is
    // reordered from its definition, not here.
    const leads = [...container.querySelectorAll(".pm-day-task-row-main")]
      .map((main) => main.firstElementChild!.className);
    expect(leads[0]).toContain("pm-day-task-lead");
    expect(leads[1]).toBe("pm-reorder-handle");
    expect(leads[2]).toBe("pm-reorder-handle");
  });

  it("reorders a dragged task in front of the one it was dropped above", () => {
    const items = [DayTask.parse("- [ ] A", 0)!, DayTask.parse("- [ ] B", 1)!, DayTask.parse("- [ ] C", 2)!];
    const container = renderSection(items, "2026-06-29.md");
    const handles = container.querySelectorAll<HTMLElement>(".pm-reorder-handle");
    dragHandle(handles[2], -100);
    expect(reorderChecklistItem).toHaveBeenCalledWith(
      expect.anything(), "2026-06-29.md", container.sourced[2], container.sourced[0],
    );
  });

  it("marks the drop position with an `li`, the only child a `ul` may hold", () => {
    const items = [DayTask.parse("- [ ] A", 0)!, DayTask.parse("- [ ] B", 1)!];
    const container = renderSection(items, "2026-06-29.md");
    container.querySelector<HTMLElement>(".pm-reorder-handle")!
      .dispatchEvent(pointerEvent("pointerdown", 0));
    document.dispatchEvent(pointerEvent("pointermove", 100));
    expect(container.querySelector(".pm-reorder-indicator")?.tagName).toBe("LI");
    document.dispatchEvent(pointerEvent("pointerup", 100));
  });

  it("reorders a task dropped past the last row to the end of the file", () => {
    const items = [DayTask.parse("- [ ] A", 0)!, DayTask.parse("- [ ] B", 1)!, DayTask.parse("- [ ] C", 2)!];
    const container = renderSection(items, "2026-06-29.md");
    const handles = container.querySelectorAll<HTMLElement>(".pm-reorder-handle");
    dragHandle(handles[0], 100);
    expect(reorderChecklistItem).toHaveBeenCalledWith(
      expect.anything(), "2026-06-29.md", container.sourced[0], null,
    );
  });

  describe("with the adjacent days grouped in (splitTaskLists off)", () => {
    const pastDay = { offset: -1, date: new Date(2026, 5, 28), filePath: "past.md", unclosedItems: [DayTask.parse("- [ ] Overdue", 0)!.withSource("past.md", day("2026-06-28"))] };
    const futureDay = { offset: 1, date: new Date(2026, 6, 1), filePath: "next.md", unclosedItems: [DayTask.parse("- [ ] Upcoming", 0)!.withSource("next.md", day("2026-07-01"))] };

    function renderGrouped(items: DayTask[], pastDays: unknown[] = [pastDay], futureDays: unknown[] = [futureDay]) {
      const view = makeView();
      view.dashboardDate = TODAY_DAY;
      const container = document.createElement("div");
      const sourced = items.map((it) => it.withSource("2026-06-29.md", TODAY_DAY));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderChecklistSection(container, sourced, "2026-06-29.md", TODAY_DAY, { pastDays, futureDays });
      return container;
    }

    it("lists the past days' items, then the day's own, then the upcoming days'", () => {
      const container = renderGrouped([DayTask.parse("- [ ] Meditate #daily", 0)!, DayTask.parse("- [ ] Buy milk", 1)!]);
      expect([...container.querySelectorAll(".pm-dash-checklist-text")].map((el) => el.textContent))
        .toEqual(["Overdue", "Meditate", "Buy milk", "Upcoming"]);
      expect(container.querySelectorAll(".pm-dash-checklist")).toHaveLength(1);
    });

    it("badges every row with its own day, the day on show included", () => {
      const container = renderGrouped([DayTask.parse("- [ ] Buy milk", 0)!]);
      expect(container.querySelectorAll(".pm-task-badge")).toHaveLength(3);
    });

    it("keeps the adjacent items when the day's own note is empty", () => {
      const container = renderGrouped([]);
      expect(container.textContent).not.toContain("No checklist items in");
      expect(container.querySelectorAll(".pm-day-task-row")).toHaveLength(2);
    });

    it("still shows the empty state when no day has an item", () => {
      const container = renderGrouped([], [], []);
      expect(container.textContent).toContain("No checklist items in");
    });

    it("drops the checklist heading, which the enclosing section already carries", () => {
      expect(renderGrouped([DayTask.parse("- [ ] Buy milk", 0)!]).querySelector(".pm-dash-section-title")).toBeNull();
    });

    it("marks the adjacent rows with their day where the day's own carry their grip", () => {
      const container = renderGrouped([DayTask.parse("- [ ] Buy milk", 0)!, DayTask.parse("- [ ] Call bank", 1)!]);
      // One leading element per row, all the same width: the past day's, the two the list
      // can reorder, then the coming day's.
      const leads = [...container.querySelectorAll(".pm-day-task-row-main")]
        .map((main) => main.firstElementChild!.className);
      expect(leads).toEqual([
        "pm-day-task-lead pm-day-task-note-icon",
        "pm-reorder-handle",
        "pm-reorder-handle",
        "pm-day-task-lead pm-day-task-note-icon",
      ]);
    });

    it("shows that day from an adjacent row's leading mark", () => {
      const view = makeView();
      view.dashboardDate = TODAY_DAY;
      const container = document.createElement("div");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderChecklistSection(container, [], "2026-06-29.md", TODAY_DAY, { pastDays: [pastDay], futureDays: [] });
      (container.querySelector(".pm-day-task-note-icon") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(view.showDay).toHaveBeenCalledWith(day("2026-06-28"));
    });
  });
});

// ---------------------------------------------------------------------------
// renderAdjacentUnclosedSection (private)
// ---------------------------------------------------------------------------

describe("renderAdjacentUnclosedSection", () => {
  function renderSection(days: unknown[], key = "tasks.previousUnclosed", title = "Overdue tasks") {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const container = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderAdjacentUnclosedSection(container, days, key, title);
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
    const day1 = { offset: -2, date: makeMomentObj(new Date(2026, 5, 27)), filePath: "d1.md", unclosedItems: [DayTask.parse("- [ ] A", 0)!.withSource("d1.md", day("2026-06-27"))] };
    const day2 = { offset: -1, date: new Date(2026, 5, 28), filePath: "d2.md", unclosedItems: [DayTask.parse("- [ ] B", 0)!.withSource("d2.md", day("2026-06-28")), DayTask.parse("- [ ] C", 1)!.withSource("d2.md", day("2026-06-28"))] };
    const container = renderSection([day1, day2]);
    expect(container.querySelectorAll(".pm-day-task-row")).toHaveLength(3);
    expect(container.querySelectorAll(".pm-task-badge")).toHaveLength(3);
  });

  it("shows that day when a row's date label is clicked", () => {
    const pastDay = { offset: -1, date: new Date(2026, 5, 28), filePath: "d1.md", unclosedItems: [DayTask.parse("- [ ] A", 0)!.withSource("d1.md", day("2026-06-28"))] };
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const container = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderAdjacentUnclosedSection(container, [pastDay], "tasks.previousUnclosed", "Overdue tasks");
    (container.querySelector(".pm-task-badge") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.showDay).toHaveBeenCalledWith(day("2026-06-28"));
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
    const result = await (view as any).loadAdjacentUnclosed(TODAY_DAY, { folder: "", format: "YYYY-MM-DD", template: "" });
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
    const result = await (view as any).loadAdjacentUnclosed(TODAY_DAY, { folder: "", format: "YYYY-MM-DD", template: "" });
    expect(result).toEqual([]);
  });

  it("defaults the before/after window to 7 days when unset", async () => {
    vi.mocked(loadDayChecklist).mockReset();
    vi.mocked(loadDayChecklist).mockResolvedValue({ items: [], filePath: null });
    const view = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).loadAdjacentUnclosed(TODAY_DAY, { folder: "", format: "YYYY-MM-DD", template: "" });
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
    plannedItems?: DayTask[];
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
      overrides.plannedItems ?? [],
    );
    return content;
  }

  it("lists an inbox item planned for the day beside the day's own checklist", () => {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const planned = DayTask.parse(`- [ ] Buy milk ⏳ ${TODAY}`, 0)!.withSource("Inbox.md");
    const content = renderDashboard(view, { dnPath: null, plannedItems: [planned] });
    const titles = [...content.querySelectorAll(".pm-dash-checklist-text")].map((e) => e.textContent);
    expect(titles).toContain("Buy milk");
  });

  it("puts an item planned for a nearby day in that day's place, and drops one outside the window", () => {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    // TODAY is 2026-06-29, and the window is 7 days either side.
    const items = [
      DayTask.parse("- [ ] Overdue plan ⏳ 2026-06-26", 0)!,
      DayTask.parse("- [ ] Coming plan ⏳ 2026-07-02", 0)!,
      DayTask.parse("- [ ] Far off ⏳ 2026-08-20", 0)!,
    ].map((t) => t.withSource("Inbox.md"));
    const content = renderDashboard(view, { dnPath: null, plannedItems: items });
    const titles = [...content.querySelectorAll(".pm-dash-checklist-text")].map((e) => e.textContent);
    expect(titles).toEqual(["Overdue plan", "Coming plan"]);
  });

  // Only a failed migration puts both in play; when it happens the day is still one day,
  // holding each row once.
  it("joins a planned item to the notes' rows for the same day", () => {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const noteDay = {
      offset: -1, date: new Date(2026, 5, 28), filePath: "2026-06-28.md",
      unclosedItems: [DayTask.parse("- [ ] From the note", 0)!.withSource("2026-06-28.md", day("2026-06-28"))],
    };
    const planned = DayTask.parse("- [ ] From the inbox ⏳ 2026-06-28", 0)!.withSource("Inbox.md");
    const content = renderDashboard(view, {
      dnPath: null, adjacentData: [noteDay], plannedItems: [planned],
    });
    const titles = [...content.querySelectorAll(".pm-dash-checklist-text")].map((e) => e.textContent);
    expect(titles).toEqual(["From the note", "From the inbox"]);
  });

  it("marks the date text as having a note when dnPath is set", () => {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view, { dnPath: "2026-06-29.md" });
    expect(content.querySelector(".pm-dash-date-text--has-note")).not.toBeNull();
  });

  it("marks the date text as having no note when dnPath is null", () => {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view, { dnPath: null });
    expect(content.querySelector(".pm-dash-date-text--no-note")).not.toBeNull();
  });

  it("opens the existing note directly when the date label is clicked and dnPath is set", () => {
    vi.mocked(openNoteFile).mockClear();
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view, { dnPath: "2026-06-29.md" });
    const label = content.querySelector(".pm-dash-date-text") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(view.app, "2026-06-29.md");
  });

  it("creates the note via DayMarkdownFile.ensure when the date label is clicked and there is no note yet", async () => {
    vi.mocked(openNoteFile).mockClear();
    vi.mocked(DayMarkdownFile.ensure).mockResolvedValue({ filePath: "2026-06-29.md" } as never);
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
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
    view.dashboardDate = TODAY_DAY;
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
    view.dashboardDate = new Date(2026, 5, 20);
    const content = renderDashboard(view);
    const todayBtn = content.querySelector(".pm-dash-today-btn") as HTMLElement;
    expect(todayBtn).not.toBeNull();
    todayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("omits the 'Today' button when the date is already today", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view);
    expect(content.querySelector(".pm-dash-today-btn")).toBeNull();
  });

  it("navigates to the previous/next day via the nav buttons", () => {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
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
    view.dashboardDate = TODAY_DAY;
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
    view.dashboardDate = TODAY_DAY;
    const tasks: Task[] = [makeTask({ id: "t1", due: TODAY_DAY, priority: Priority.High })];
    const content = renderDashboard(view, { tasks });
    expect(content.textContent).toContain("Approaching Deadlines");
    expect(content.textContent).toContain("Priority Queue");
  });

  it("runs the project tasks into one list when the lists aren't split", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.plugin.settings.splitTaskLists = false;
    view.dashboardDate = TODAY_DAY;
    const tasks: Task[] = [
      makeTask({ id: "t1", title: "Due soon", due: TODAY_DAY }),
      makeTask({ id: "t2", title: "Due later", due: day("2026-08-20"), priority: Priority.High }),
    ];
    const content = renderDashboard(view, { tasks, projects: [makeProject({ id: "proj1" })] });
    expect(content.textContent).toContain("Project Tasks");
    expect(content.textContent).not.toContain("Approaching Deadlines");
    expect(content.textContent).not.toContain("Priority Queue");
    // What is due within the week, then what is waiting behind it — their sections' order.
    expect([...content.querySelectorAll(".pm-dash-task-title")].map((el) => el.textContent))
      .toEqual(["Due soon", "Due later"]);
  });

  it("shows the tasks the day closed, in their own section", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const tasks: Task[] = [
      makeTask({ id: "t1", title: "Shipped it", status: "done", completed: timestamp(`${TODAY}T10:00:00Z`) }),
      makeTask({ id: "t2", title: "Shipped yesterday", status: "done", completed: timestamp("2026-06-28T10:00:00Z") }),
    ];
    const content = renderDashboard(view, { tasks, projects: [makeProject({ id: "proj1" })] });
    expect(content.textContent).toContain("Completed");
    expect([...content.querySelectorAll(".pm-dash-task-title")].map((el) => el.textContent))
      .toEqual(["Shipped it"]);
  });

  it("leaves the Completed section out on a day that closed nothing", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view);
    expect(content.textContent).not.toContain("Completed");
  });

  it("puts what the day closed after the queues in the unsplit project list", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.plugin.settings.splitTaskLists = false;
    view.dashboardDate = TODAY_DAY;
    const tasks: Task[] = [
      makeTask({ id: "t1", title: "Done today", status: "done", completed: timestamp(`${TODAY}T10:00:00Z`) }),
      makeTask({ id: "t2", title: "Due soon", due: TODAY_DAY }),
    ];
    const content = renderDashboard(view, { tasks, projects: [makeProject({ id: "proj1" })] });
    expect([...content.querySelectorAll(".pm-dash-task-title")].map((el) => el.textContent))
      .toEqual(["Due soon", "Done today"]);
  });

  it("shows one empty state for the unsplit project list", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.plugin.settings.splitTaskLists = false;
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view);
    expect(content.textContent).toContain("No tasks due or prioritized");
  });

  describe("with the daily and project tasks merged", () => {
    function makeMergedView(split = true) {
      const view = makeView();
      view.plugin.settings.mergeDailyAndProjectTasks = true;
      view.plugin.settings.splitTaskLists = split;
      view.dashboardDate = TODAY_DAY;
      return view;
    }

    const sectionTitles = (content: HTMLElement) =>
      [...content.querySelectorAll(".pm-dash-section-title")].map((el) => el.textContent);

    it("shows the three horizons instead of the daily/project grouping", () => {
      vi.setSystemTime(new Date(TODAY));
      const content = renderDashboard(makeMergedView());
      expect(sectionTitles(content)).toEqual(["Overdue", "Current", "Next up"]);
      expect(content.textContent).not.toContain("Daily Tasks");
      expect(content.textContent).not.toContain("Project Tasks");
    });

    it("gives each empty horizon its own empty state", () => {
      vi.setSystemTime(new Date(TODAY));
      const content = renderDashboard(makeMergedView());
      expect([...content.querySelectorAll(".pm-dash-empty")].map((el) => el.textContent))
        .toEqual(["Nothing overdue", "Nothing on today", "Nothing coming up"]);
    });

    it("puts the past days' rows in Overdue and the coming days' in Next up", () => {
      vi.setSystemTime(new Date(TODAY));
      const adjacentData = [
        { offset: -1, date: new Date(2026, 5, 28), filePath: "past.md", unclosedItems: [DayTask.parse("- [ ] Was due", 0)!] },
        { offset: 1, date: new Date(2026, 6, 1), filePath: "next.md", unclosedItems: [DayTask.parse("- [ ] Coming", 0)!] },
      ];
      const content = renderDashboard(makeMergedView(), { adjacentData });
      const bodies = content.querySelectorAll(".pm-dash-section");
      expect(bodies[0].textContent).toContain("Was due");
      expect(bodies[2].textContent).toContain("Coming");
    });

    it("puts the day's own checklist in Current, keeping it draggable", () => {
      vi.setSystemTime(new Date(TODAY));
      // Sourced as the loader hands them over: the day's own note, so the list can reorder them.
      const checklistItems = [
        DayTask.parse("- [ ] A", 0)!.withSource("2026-06-29.md", TODAY_DAY),
        DayTask.parse("- [ ] B", 1)!.withSource("2026-06-29.md", TODAY_DAY),
      ];
      const content = renderDashboard(makeMergedView(), { checklistItems, dnPath: "2026-06-29.md" });
      const current = content.querySelectorAll(".pm-dash-section")[1];
      expect(current.textContent).toContain("A");
      expect(current.querySelectorAll(".pm-reorder-handle")).toHaveLength(2);
    });

    it("badges the day's own rows with their date, telling them from the other horizons'", () => {
      vi.setSystemTime(new Date(TODAY));
      const checklistItems = [DayTask.parse("- [ ] A", 0)!.withSource("2026-06-29.md", TODAY_DAY)];
      const content = renderDashboard(makeMergedView(), { checklistItems, dnPath: "2026-06-29.md" });
      expect(content.querySelectorAll(".pm-task-badge")).toHaveLength(1);
    });

    it("leaves a row unbadged when nothing says which day it is for", () => {
      vi.setSystemTime(new Date(TODAY));
      const checklistItems = [DayTask.parse("- [ ] A", 0)!];
      const content = renderDashboard(makeMergedView(), { checklistItems, dnPath: null });
      expect(content.querySelectorAll(".pm-task-badge")).toHaveLength(0);
    });

    it("renders the project tasks as rows of the same list as the day rows", () => {
      vi.setSystemTime(new Date(TODAY));
      const tasks: Task[] = [makeTask({ id: "t1", title: "Ship it", due: TODAY_DAY, priority: Priority.High })];
      const content = renderDashboard(makeMergedView(), { tasks, projects: [makeProject({ id: "proj1" })] });
      expect(content.querySelectorAll(".pm-dash-checklist .pm-dash-task-item .pm-dash-task-row")).toHaveLength(1);
      expect(content.textContent).toContain("Ship it");
    });

    it("puts what the day closed in Current, after what it still has to do", () => {
      vi.setSystemTime(new Date(TODAY));
      const tasks: Task[] = [
        makeTask({ id: "t1", title: "Closed it", status: "done", completed: timestamp(`${TODAY}T10:00:00Z`) }),
        makeTask({ id: "t2", title: "Due today", due: TODAY_DAY }),
      ];
      const content = renderDashboard(makeMergedView(), { tasks, projects: [makeProject({ id: "proj1" })] });
      const current = content.querySelectorAll(".pm-dash-section")[1];
      expect([...current.querySelectorAll(".pm-dash-task-title")].map((el) => el.textContent))
        .toEqual(["Due today", "Closed it"]);
    });

    describe("with the daily tasks unsplit", () => {
      it("runs the three horizons into one untitled list", () => {
        vi.setSystemTime(new Date(TODAY));
        const adjacentData = [
          { offset: -1, date: new Date(2026, 5, 28), filePath: "past.md", unclosedItems: [DayTask.parse("- [ ] Was due", 0)!] },
          { offset: 1, date: new Date(2026, 6, 1), filePath: "next.md", unclosedItems: [DayTask.parse("- [ ] Coming", 0)!] },
        ];
        const checklistItems = [DayTask.parse("- [ ] Now", 0)!];
        const content = renderDashboard(makeMergedView(false), { adjacentData, checklistItems, dnPath: "2026-06-29.md" });
        expect(sectionTitles(content)).toEqual([]);
        expect([...content.querySelectorAll(".pm-dash-checklist-text")].map((el) => el.textContent))
          .toEqual(["Was due", "Now", "Coming"]);
      });

      it("shows one empty state for the whole list, not one per horizon", () => {
        vi.setSystemTime(new Date(TODAY));
        const content = renderDashboard(makeMergedView(false));
        expect([...content.querySelectorAll(".pm-dash-empty")].map((el) => el.textContent))
          .toEqual(["Nothing to do"]);
      });
    });
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
      effectivePriority?: Priority;
      effectiveDue?: Date;
      readonly?: boolean;
      subtreePriority?: Priority;
    } = {}) {
      const view = makeView();
      const container = document.createElement("div");
      const projectMap = opts.projectMap ?? new Map<string, Project>();
      const eff: EffectiveValues = {
        // What the row draws is the two directions; `priority` is the rank, unused here.
        priority: opts.effectivePriority ?? opts.subtreePriority,
        ancestorPriority: opts.effectivePriority,
        subtreePriority: opts.subtreePriority,
        due: opts.effectiveDue,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderTaskRow(container, task, projectMap, eff, opts.readonly ?? false);
      return { view, row: container.querySelector(".pm-dash-task-row") as HTMLElement };
    }

    it("adds the readonly modifier class and skips interactive handlers when readonly", () => {
      const { row } = renderRow(makeTask({ id: "t1" }), { readonly: true });
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(true);
      expect(row.querySelector(".pm-task-actions")).toBeNull();
    });

    it("omits the readonly modifier class by default", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(false);
    });

    it("names the checklist-only 'lowest' level a task file may still hold", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: "lowest" as Task["priority"] }));
      const ribbon = row.querySelector(".pm-task-ribbon") as HTMLElement;
      expect(ribbon.title).toBe("Priority: Lowest");
    });

    it("names a parent's higher priority in the title alongside the task's own", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: Priority.Low }), { effectivePriority: Priority.High });
      const ribbon = row.querySelector(".pm-task-ribbon") as HTMLElement;
      expect(ribbon.title).toBe("Priority: Low (from parent tasks: High)");
    });

    it("fades the ribbon to a subtask's higher priority at the bottom", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: Priority.Medium }), { subtreePriority: Priority.High });
      const ribbon = row.querySelector(".pm-task-ribbon") as HTMLElement;
      expect(ribbon.style.getPropertyValue("--pm-ribbon-color"))
        .toBe(`linear-gradient(to bottom, ${PRIORITY_COLORS[Priority.Medium]}, ${PRIORITY_COLORS[Priority.High]})`);
      expect(ribbon.title).toBe("Priority: Medium (from subtasks: High)");
    });

    it("shows the plain priority title when there is no effective priority", () => {
      const { row } = renderRow(makeTask({ id: "t1", priority: Priority.Low }));
      const ribbon = row.querySelector(".pm-task-ribbon") as HTMLElement;
      expect(ribbon.title).toBe("Priority: Low");
    });

    it("falls back to the raw status string for a status not in STATUS_LABELS", () => {
      const { row } = renderRow(makeTask({ id: "t1", status: "made-up-status" }));
      const statusIcon = row.querySelector(".pm-dash-task-status-icon") as HTMLElement;
      expect(statusIcon.title).toBe("Status: made-up-status");
      // and it still draws something: the "todo" glyph.
      expect(statusIcon.querySelector("svg")).not.toBeNull();
    });

    it("sets a due-date title when the effective due date differs from the task's own", () => {
      const { row } = renderRow(makeTask({ id: "t1", due: day("2026-07-01") }), { effectiveDue: day("2026-07-05") });
      const dueSpan = row.querySelector(".pm-task-badge") as HTMLElement;
      expect(dueSpan.title).toBe("Effective deadline: 2026-07-05 (own: 2026-07-01) — show that day");
    });

    it("shows 'none' for the own due date when the task has no due date of its own", () => {
      const { row } = renderRow(makeTask({ id: "t1" }), { effectiveDue: day("2026-07-05") });
      const dueSpan = row.querySelector(".pm-task-badge") as HTMLElement;
      expect(dueSpan.title).toBe("Effective deadline: 2026-07-05 (own: none) — show that day");
    });

    it("names the task's own deadline when there is no effective due date", () => {
      const { row } = renderRow(makeTask({ id: "t1", due: day("2026-07-01") }));
      const dueSpan = row.querySelector(".pm-task-badge") as HTMLElement;
      expect(dueSpan.title).toBe("Deadline: 2026-07-01 — show that day");
    });

    it("dates a closed task by the day it closed, in place of the deadline it ran past", () => {
      const { row } = renderRow(makeTask({
        id: "t1", status: "done", due: day("2026-06-01"), completed: timestamp("2026-07-01T09:00:00Z"),
      }));
      const badges = [...row.querySelectorAll(".pm-task-badge")] as HTMLElement[];
      expect(badges.map((b) => b.title)).toEqual(["Completed on 2026-07-01 — show that day"]);
    });

    it("says a cancelled task closed rather than completed on the day its timestamp names", () => {
      const { row } = renderRow(makeTask({
        id: "t1", status: "cancelled", completed: timestamp("2026-07-01T09:00:00Z"),
      }));
      const badge = row.querySelector(".pm-task-badge") as HTMLElement;
      expect(badge.title).toBe("Closed on 2026-07-01 — show that day");
    });

    it("keeps the deadline badge on a closed task that never recorded when it closed", () => {
      const { row } = renderRow(makeTask({ id: "t1", status: "done", due: day("2026-07-01") }));
      const badge = row.querySelector(".pm-task-badge") as HTMLElement;
      expect(badge.title).toBe("Deadline: 2026-07-01 — show that day");
    });

    it("puts the project name before the deadline badge, which ends the row", () => {
      const projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1", title: "Alpha" })]]);
      const { row } = renderRow(makeTask({ id: "t1", due: day("2026-07-01"), projectId: "proj1" }), { projectMap });
      const line1 = row.querySelector(".pm-dash-task-line") as HTMLElement;
      const classes = [...line1.children].map((c) => c.className);
      expect(classes.indexOf("pm-dash-task-project")).toBeLessThan(classes.indexOf("pm-task-badges"));
    });

    it("shows the project badge with its color when the task belongs to a known project", () => {
      const projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1", title: "Alpha", color: "#ff0000" })]]);
      const { row } = renderRow(makeTask({ id: "t1", projectId: "proj1" }), { projectMap });
      const badge = row.querySelector(".pm-dash-task-project") as HTMLElement;
      expect(badge.textContent).toBe("Alpha");
      expect(badge.title).toBe("Alpha — open in the task graph");
      // The name is drawn in the project's own colour, as its leading icon is.
      expect(badge.style.getPropertyValue("--pm-project-color")).toBe("#ff0000");
    });

    it("omits the project badge when the project is unknown", () => {
      const { row } = renderRow(makeTask({ id: "t1", projectId: "missing" }));
      expect(row.querySelector(".pm-dash-task-project")).toBeNull();
    });

    it("opens a priority dropdown on ribbon click and patches the field on select", async () => {
      const { view, row } = renderRow(makeTask({ id: "t1", filePath: "t1.md" }));
      const ribbon = row.querySelector(".pm-task-ribbon") as HTMLElement;
      view.onRefresh = vi.fn();
      ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openDropdown).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (openDropdown as any).mock.calls[0][1];
      await options[0].onSelect();
      expect(patchTaskField).toHaveBeenCalledWith(view.app, "t1.md", "priority", options[0].label === "None" ? "" : expect.anything());
    });

    it("opens a status dropdown on status-icon click and patches the field on select", async () => {
      const { view, row } = renderRow(makeTask({ id: "t1", filePath: "t1.md" }));
      const statusIcon = row.querySelector(".pm-dash-task-status-icon") as HTMLElement;
      statusIcon.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openDropdown).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (openDropdown as any).mock.calls[0][1];
      await options[0].onSelect();
      expect(patchTaskField).toHaveBeenCalledWith(view.app, "t1.md", "status", expect.any(String));
    });

    /** A toolbar button by its aria-label — the toolbar is the shared `.pm-task-actions`
     *  a checklist row also carries, so the labels are what tell its buttons apart. */
    function action(row: HTMLElement, label: string): HTMLElement {
      return row.querySelector(`.pm-task-actions [aria-label="${label}"]`) as HTMLElement;
    }

    it("opens the edit modal from the details button", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      action(row, "Edit task details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(MockTaskModal.instances).toHaveLength(1);
      expect(MockTaskModal.instances[0].opts.mode).toBe("edit");
    });

    it("opens the note file directly (ctrl/meta-click) instead of the edit modal", () => {
      const { row } = renderRow(makeTask({ id: "t1", filePath: "t1.md" }));
      action(row, "Edit task details").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      expect(openNoteFile).toHaveBeenCalledOnce();
      expect(MockTaskModal.instances).toHaveLength(0);
    });

    it("opens the task in the graph from the toolbar, the row's click being the toolbar's own", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(view, "openInGraph").mockResolvedValue(undefined);
      action(row, "Open in graph").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(spy).toHaveBeenCalledOnce();
    });

    it("reveals the toolbar on a row click, the same gesture a checklist row answers to", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(view, "openInGraph").mockResolvedValue(undefined);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(row.classList.contains("pm-task-row--open")).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });

    it("keeps the graph on the row's own click when readonly, since those rows get no toolbar", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }), { readonly: true });
      const spy = vi.spyOn(view, "openInGraph").mockResolvedValue(undefined);
      expect(row.querySelector(".pm-task-actions")).toBeNull();
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(spy).toHaveBeenCalledOnce();
    });

    it("opens the more-actions menu from the toolbar, the same menu right-click opens", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      action(row, "More actions").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(MockMenu.instances).toHaveLength(1);
    });

    it("has no edit-title button — the details modal is where a task is renamed", () => {
      const { row } = renderRow(makeTask({ id: "t1", filePath: "t1.md", title: "Old" }));
      expect(action(row, "Edit title")).toBeNull();
    });

    it("shows the deadline's day from the badge, as a day task's row does", () => {
      const { row, view } = renderRow(makeTask({ id: "t1", filePath: "t1.md", due: day("2026-07-01") }));
      (row.querySelector(".pm-task-badge") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(view.showDay).toHaveBeenCalledWith(day("2026-07-01"));
      // The deadline itself is changed from the toolbar's button, not from the badge.
      expect(mockOpenDatePicker).not.toHaveBeenCalled();
    });

    it("shows the day of an inherited deadline too — the day is a day either way", () => {
      const { row, view } = renderRow(makeTask({ id: "t1", due: day("2026-07-01") }), { effectiveDue: day("2026-07-05") });
      (row.querySelector(".pm-task-badge") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(view.showDay).toHaveBeenCalledWith(day("2026-07-05"));
    });

    it("does not reveal the toolbar when clicking the ribbon", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      const ribbon = row.querySelector(".pm-task-ribbon") as HTMLElement;
      ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(row.classList.contains("pm-task-row--open")).toBe(false);
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
      const task = makeTask({ id: "t1", priority: Priority.Low });
      const effMap = new Map<string, EffectiveValues>([
        ["t1", {
          priority: Priority.High,
          ancestorPriority: Priority.High,
          subtreePriority: Priority.Low,
          due: undefined,
        }],
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderExpandList(container, [task], new Map(), effMap);
      const row = container.querySelector(".pm-dash-task-row") as HTMLElement;
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(true);
      expect(row.querySelector(".pm-task-ribbon")?.getAttribute("title")).toContain("High");
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

// ---------------------------------------------------------------------------
// The row's leading slot
// ---------------------------------------------------------------------------

describe("a project task's leading slot", () => {
  it("carries the project as an icon in its own colour, named on hover", () => {
    const view = makeView();
    const container = document.createElement("div");
    const projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1", title: "Alpha", color: "#ff0000" })]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderTaskRow(container, makeTask({ id: "t1", projectId: "proj1" }), projectMap);
    const lead = container.querySelector<HTMLElement>(".pm-dash-task-project-icon")!;
    // The same slot a day task's grip or recurring mark takes.
    expect(lead.classList.contains("pm-day-task-lead")).toBe(true);
    expect(lead).toBe(container.querySelector(".pm-dash-task-row")!.firstElementChild);
    expect(lead.style.getPropertyValue("--pm-project-color")).toBe("#ff0000");
    expect(lead.title).toBe("Alpha — open in the task graph");
  });

  it("stays empty for a task whose project is unknown", () => {
    const view = makeView();
    const container = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderTaskRow(container, makeTask({ id: "t1", projectId: "gone" }), new Map());
    expect(container.querySelector(".pm-dash-task-project-icon")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A project task's creation date
// ---------------------------------------------------------------------------

describe("a project task's creation date", () => {
  function renderCreated(createdAt?: Date) {
    const view = makeView();
    const container = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderTaskRow(container, makeTask({ id: "t1", createdAt }), new Map());
    return { container, view };
  }

  it("shows how long the task has been on the books, and takes the day to it", () => {
    vi.setSystemTime(new Date(TODAY));
    const { container, view } = renderCreated(timestamp("2026-06-22T09:15:00.000Z"));
    const badge = [...container.querySelectorAll(".pm-task-badge")]
      .find((b) => (b as HTMLElement).title.startsWith("Created on")) as HTMLElement;
    expect(badge.textContent).toBe("7 d");
    // Quietly: an old task is not a stale one, so no warning glyph and no red.
    expect(badge.querySelector(".pm-task-badge-icon")).toBeNull();
    expect(badge.classList.contains("pm-task-badge--danger")).toBe(false);
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.showDay).toHaveBeenCalledWith(day("2026-06-22"));
  });

  it("stays quiet for a task created long ago", () => {
    vi.setSystemTime(new Date(TODAY));
    const { container } = renderCreated(timestamp("2025-01-05T09:15:00.000Z"));
    const badge = container.querySelector(".pm-task-badge") as HTMLElement;
    expect(badge.classList.contains("pm-task-badge--danger")).toBe(false);
  });

  it("shows nothing for a task whose file records no creation date", () => {
    const { container } = renderCreated(undefined);
    expect(container.querySelector(".pm-task-badge")).toBeNull();
  });
});
