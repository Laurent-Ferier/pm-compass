// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, type Mock } from "vitest";

// Hoisted so both the vi.mock factories below and the test bodies can reference them.
const { MockMenu, MockTaskModal, mockConfirmAction, MockTaskGraphView } = vi.hoisted(() => {
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
    static instances: MockTaskModal[] = [];
    constructor(public app: unknown, public opts: Record<string, unknown>) {
      MockTaskModal.instances.push(this);
    }
    open() {}
  }
  // Records what was asked instead of opening a dialog; a test that wants the action to
  // go through runs the recorded `onConfirm` itself.
  const mockConfirmAction = Object.assign(
    (_app: unknown, required: boolean, message: string, onConfirm: () => void) => {
      mockConfirmAction.calls.push({ required, message, onConfirm });
    },
    { calls: [] as Array<{ required: boolean; message: string; onConfirm: () => void }> },
  );
  class MockTaskGraphView {
    openTask = vi.fn().mockResolvedValue(undefined);
  }
  return { MockMenu, MockTaskModal, mockConfirmAction, MockTaskGraphView };
});

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// Obsidian extends HTMLElement (and Element) with helper methods that jsdom
// does not provide. We install them once on the prototypes so that production
// code that calls container.createEl(), addClass(), etc. works in tests.
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);
  const svgProto = bagOf(SVGElement.prototype);

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
    return this.createEl("div", opts);
  };
  htmlProto.createSpan = function(this: HTMLElement, opts?: CreateElOpts) {
    return this.createEl("span", opts);
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
  bagOf(window).activeDocument = document;
  bagOf(window).activeWindow = window;
  // jsdom ships no CSS namespace; the ids under test need no escaping.
  bagOf(window).CSS = { escape: (s: string) => s };
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Module mocks (must be before the imports that trigger them)
// ---------------------------------------------------------------------------

// Held by name so an assertion has the mock itself rather than a method read off the
// class it is mocked onto.
const { renderMarkdownMock, ensureDayNoteMock } = vi.hoisted(() => ({
  renderMarkdownMock: vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
    const p = document.createElement("p");
    p.textContent = markdown;
    el.appendChild(p);
  }),
  ensureDayNoteMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
  App: class {},
  Component: class { load() {} unload() {} },
  MarkdownRenderer: { render: renderMarkdownMock },
  ItemView: class {
    contentEl = document.createElement("div");
    registerEvent() {}
    registerDomEvent() {}
  },
  Menu: MockMenu,
  // Enough of a Modal for the pickers reached from a row: `open` is what puts their
  // content in the document, which Obsidian does by calling `onOpen`.
  Modal: class {
    contentEl: HTMLElement = document.createElement("div");
    declare onOpen?: () => void;
    declare onClose?: () => void;
    constructor(public app: unknown) {}
    open() { document.body.appendChild(this.contentEl); this.onOpen?.(); }
    close() { this.onClose?.(); this.contentEl.remove(); }
  },
  TFile: class { path = ""; },
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  Notice: vi.fn(),
  normalizePath: (p: string) => p,
  // `setIcon` draws the real Lucide glyph in Obsidian; here it only has to leave an
  // <svg> behind, which is all the assertions look for.
  setIcon: (el: HTMLElement, name: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-icon", name);
    el.replaceChildren(svg);
  },
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

vi.mock("./task-creator", async (importOriginal) => ({
  // Spread the original so value exports (enums the callers branch on)
  // survive the mock; only the behaviours below are replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  TaskModal: MockTaskModal,
  confirmAction: mockConfirmAction,
  ProjectModal: class {},
  patchTaskField: vi.fn().mockResolvedValue(undefined),
  patchTaskDue: vi.fn().mockResolvedValue(undefined),
  deleteTaskFile: vi.fn().mockResolvedValue(undefined),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

vi.mock("../model/project/vault-reader", () => ({ loadVaultData: vi.fn() }));

vi.mock("../model/daily/day-markdown-file", () => ({
  DayMarkdownFile: { ensure: ensureDayNoteMock },
}));

// A vault where day notes can be created, unless a test says otherwise: the date label
// tells a refusal apart from a failure by asking.
vi.mock("../model/daily/daily-notes-plugin", () => ({
  canCreateDayNotes: vi.fn().mockResolvedValue(true),
}));

vi.mock("../model/daily/day-task-actions", async (importOriginal) => ({
  // Spread the original so value exports (enums the callers branch on)
  // survive the mock; only the behaviours below are replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  loadDayChecklist: vi.fn().mockResolvedValue({ items: [], filePath: null }),
  rescheduleChecklistItem: vi.fn().mockResolvedValue(undefined),
  moveChecklistItemToInbox: vi.fn().mockResolvedValue(undefined),
  deleteChecklistItem: vi.fn().mockResolvedValue(undefined),
  toggleChecklistItem: vi.fn().mockResolvedValue("- [x] Task"),
  reorderChecklistItem: vi.fn().mockResolvedValue(undefined),
  setChecklistItemPriority: vi.fn().mockResolvedValue(undefined),
  closeInboxItem: vi.fn().mockResolvedValue(undefined),
  unscheduleInboxItem: vi.fn().mockResolvedValue(undefined),
  addTaskToDay: vi.fn().mockResolvedValue("moved"),
}));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: MockTaskGraphView,
}));

const { mockOpenDatePicker } = vi.hoisted(() => ({
  mockOpenDatePicker: vi.fn<typeof import("./date-picker").openDatePicker>(),
}));
vi.mock("./date-picker", () => ({
  openDatePicker: (...args: Parameters<typeof import("./date-picker").openDatePicker>) =>
    mockOpenDatePicker(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Component } from "obsidian";
import { buildProgressCircle } from "./progress-circle";
import { renderInlineMarkdown } from "./day-task-row";
import { DashboardView } from "./dashboard-view";
import { DayTask } from "../model/daily/day-task";
import { type Project } from "../model/project/project";
import { Task, type TaskFields } from "../model/project/task";
import { openDropdown, patchTaskField, patchTaskDue, deleteTaskFile, openNoteFile } from "./task-creator";
import { canCreateDayNotes } from "../model/daily/daily-notes-plugin";
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
  addTaskToDay,
} from "../model/daily/day-task-actions";
import { PRIORITY_COLORS, STATUS_COLORS, Priority } from "../model/base-task";
import { ScheduleOutcome } from "../model/daily/day-task-actions";
import type { EffectiveValues } from "../model/project/task-scoring";
import { dragHandle, pointerEvent } from "./__testing__/drag-pointer";
import { day, timestamp } from "../model/__testing__/dates";
import { bare } from "../model/__testing__/bare";
import { bagOf } from "./__testing__/dom-bag";
import { asApp } from "../model/__testing__/as-app";
import type PMCompassPlugin from "../main";
import type { App } from "obsidian";
import type { AdjacentDayData } from "./dashboard-view";

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

/** The creation-date badges on a row, told from the other date badges by their tooltip. */
function createdBadges(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".pm-task-badge")]
    .filter((b) => b.title.startsWith("Created on"));
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
      dailyTasksHeading: "## Tasks",
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  const view = bare(DashboardView);
  Object.assign(view, {
    app: { internalPlugins: { plugins: {} } },
    plugin,
    allTasks: [],
    // Object.create skips field initializers; render() would otherwise set this.
    projects: [],
    // The day every date on the tab reads against; individual tests move it.
    dashboardDate: TODAY_DAY,
    // Set by render() in production; the section renderers below are called directly.
    context: {
      projectMap: new Map(), effectiveValues: new Map(), habitsTag: "daily", inboxPath: "Inbox.md",
    },
    openNoteKeys: new Set<string>(),
    // The per-pass markdown owner, another field initializer Object.create skips.
    renderHost: new Component(),
    scheduleRefresh: vi.fn(),
    onRefresh: vi.fn(),
    showDay: vi.fn(),
  });
  return view;
}

/** The view's protected members, named rather than reached for through `any`: the
 *  section renderers the tests drive one at a time, and the state a render pass sets up
 *  for them. */
interface ViewInternals {
  app: App & { internalPlugins: { plugins: Record<string, unknown> } };
  plugin: {
    settings: Record<string, unknown> & { dashboardCollapsed: Record<string, boolean> };
    saveSettings: Mock<() => Promise<void>>;
  };
  context: {
    projectMap: Map<string, Project>;
    effectiveValues: Map<string, EffectiveValues>;
    habitsTag: string;
    inboxPath: string;
  };
  allTasks: Task[];
  onRefresh: Mock<() => void>;
  showDay: Mock<(date: Date) => void>;
  scheduleRefresh: Mock<() => void>;
  createCollapsibleSection(
    container: HTMLElement, title: string, key: string,
    options?: { tooltip?: string; sub?: boolean },
  ): { section: HTMLElement; body: HTMLElement };
  renderTaskRow(
    list: HTMLElement, task: Task, projectMap: Map<string, Project>,
    eff?: EffectiveValues, readonly?: boolean, showCreated?: boolean,
  ): void;
  renderExpandList(
    container: HTMLElement, tasks: Task[], projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, EffectiveValues>,
  ): void;
  renderChecklistSection(
    container: HTMLElement, items: DayTask[], filePath: string | null, date: Date,
    adjacent?: { pastDays: AdjacentDayData[]; futureDays: AdjacentDayData[] },
  ): void;
  renderChecklistRow(
    list: HTMLElement, item: DayTask, habitsTag: string, resolvedInboxPath: string,
    lead: { addDragHandle: unknown; movable: boolean },
  ): void;
  renderAdjacentUnclosedSection(
    container: HTMLElement, days: AdjacentDayData[], key: string, title: string,
  ): void;
  renderPrioritySection(container: HTMLElement, tasks: Task[]): void;
  openInGraph(task: Task): Promise<void>;
  openTaskContextMenu(e: MouseEvent, task: Task, projectMap: Map<string, Project>): void;
  openPromoteModal(item: DayTask, sourcePath: string, projects: Project[], habitsTag: string): void;
}
const internals = (view: DashboardView) => view as unknown as ViewInternals;

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
    await renderInlineMarkdown(container, text, asApp({}), new Component());
    return container;
  }

  it("passes the text to MarkdownRenderer.render", async () => {
    await render("hello world");
    expect(renderMarkdownMock).toHaveBeenCalledWith(expect.anything(), "hello world", expect.any(HTMLElement), "", expect.anything());
  });

  it("unwraps the <p> wrapper added by MarkdownRenderer", async () => {
    const el = await render("hello world");
    expect(el.querySelector("p")).toBeNull();
    expect(el.textContent).toBe("hello world");
  });

  it("marks the container before rendering, so the wrapper never adds a paragraph's height", async () => {
    const container = document.createElement("span");
    const pending = renderInlineMarkdown(container, "hello world", asApp({}), new Component());
    expect(container.classList.contains("pm-inline-md")).toBe(true);
    await pending;
    expect(container.classList.contains("pm-inline-md")).toBe(true);
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
    internals(view).context.projectMap = new Map<string, Project>([["proj1", makeProject({ id: "proj1" })]]);
    // The renderers read only `priority` and `due` off these, so the fixtures carry
    // those two rather than a whole roll-up.
    internals(view).context.effectiveValues = (effectiveValuesMap
      ?? new Map(tasks.map((t) => [t.id, { priority: t.priority, due: t.due }]))
    ) as Map<string, EffectiveValues>;
    internals(view).renderPrioritySection(container, tasks);
    return container;
  }

  it("shows an empty-state message when no tasks are passed", () => {
    const container = renderPriority([]);
    expect(container.textContent).toContain("No tasks due or prioritized");
  });

  it("shows the section inside a collapsible section wrapper", () => {
    const container = renderPriority([]);
    expect(container.querySelector(".pm-dash-section")).not.toBeNull();
    expect(container.querySelector(".pm-dash-section-header")).not.toBeNull();
  });

  it("attaches data-task-id to each row", () => {
    const container = renderPriority([makeTask({ id: "abc123", title: "Task A", due: day("2026-07-01") })]);
    expect(container.querySelector("[data-task-id='abc123']")).not.toBeNull();
  });

  it("shows the due-date label for a task", () => {
    const container = renderPriority([makeTask({ id: "t1", title: "Task A", due: TODAY_DAY })]);
    expect(container.textContent).toContain("today");
  });

  it("badges an overdue deadline with its day count, warning tone and glyph", () => {
    const container = renderPriority([makeTask({ id: "t1", title: "Overdue task", due: day("2026-06-22") })]);
    const badge = container.querySelector(".pm-task-badge--warning") as HTMLElement;
    expect(badge.textContent).toBe("7 d");
    expect(badge.querySelector(".pm-task-badge-icon")).not.toBeNull();
  });

  it("turns a long-overdue deadline red", () => {
    const container = renderPriority([makeTask({ id: "t1", title: "Overdue task", due: day("2026-06-01") })]);
    expect(container.querySelector(".pm-task-badge--danger")).not.toBeNull();
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
    internals(view).allTasks = [makeTask({ id: "parent", status: "cancelled" }), child];
    internals(view).context.effectiveValues = new Map([
      [child.id, { priority: child.priority, due: child.due }],
    ]) as Map<string, EffectiveValues>;
    internals(view).renderPrioritySection(container, [child]);

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
    internals(view).renderChecklistRow(list, sourced, "daily", "Inbox.md", inertLead);
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
    expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-06-22"));
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

  it("offers promote on a checked item too", () => {
    const item = DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Promote to project task']")).not.toBeNull();
  });

  it("opens the destination picker with the day note as the source", () => {
    const spy = vi
      .spyOn(internals(DashboardView.prototype), "openPromoteModal")
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

  it("keeps delete on a checked item", () => {
    const item = DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Delete']")).not.toBeNull();
  });

  it("omits reschedule and move-to-inbox on a checked item — both would untick it", () => {
    const item = DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!;
    const { list } = renderRow(item);
    expect(list.querySelector("[aria-label='Reschedule']")).toBeNull();
    expect(list.querySelector("[aria-label='Move to inbox']")).toBeNull();
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

  it("keeps unplan on a ticked planned row — clearing the ⏳ doesn't untick it", () => {
    const item = DayTask.parse(`- [x] Buy milk ⏳ ${TODAY} ✅ ${TODAY}`, 0)!;
    const { list } = renderRow(item, {}, "Inbox.md");
    expect(list.querySelector("[aria-label='Unplan']")).not.toBeNull();
  });

  it("confirms and deletes the item on delete-button click", async () => {
    vi.mocked(deleteChecklistItem).mockClear();
    mockConfirmAction.calls.length = 0;
    const item = DayTask.parse("- [ ] Task", 0)!;
    const { list } = renderRow(item);
    const deleteBtn = list.querySelector("[aria-label='Delete']") as HTMLElement;
    deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockConfirmAction.calls).toHaveLength(1);
    expect(mockConfirmAction.calls[0].message).toBe('Delete "Task"?');
    mockConfirmAction.calls[0].onConfirm();
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

  it("relabels the box for closing again once the task is reopened", async () => {
    vi.mocked(toggleChecklistItem).mockClear();
    vi.mocked(toggleChecklistItem).mockResolvedValueOnce("- [ ] Task");
    const { list } = renderRow(DayTask.parse("- [x] Task ✅ 2026-06-30", 0)!);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;
    expect(box.getAttribute("aria-label")).toBe("Reopen task");

    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(box.getAttribute("aria-label")).toBe("Close task"));
  });

  it("draws no toolbar on a row with no file behind it", () => {
    // The day has no note yet, so there is nothing any of the actions could write to.
    const { list } = renderRow(DayTask.parse("- [ ] Task", 0)!, {}, null);
    expect(list.querySelector(".pm-task-actions")).toBeNull();
  });

  it("ticks from Enter as well as Space, as a real checkbox does", async () => {
    vi.mocked(toggleChecklistItem).mockClear();
    vi.mocked(toggleChecklistItem).mockResolvedValueOnce("- [x] Task ✅ 2026-06-30");
    const { list } = renderRow(DayTask.parse("- [ ] Task", 0)!);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();

    expect(toggleChecklistItem).toHaveBeenCalledOnce();
  });

  it("ignores any other key, so typing past a focused box doesn't close the task", async () => {
    vi.mocked(toggleChecklistItem).mockClear();
    const { list } = renderRow(DayTask.parse("- [ ] Task", 0)!);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await Promise.resolve();

    expect(toggleChecklistItem).not.toHaveBeenCalled();
  });

  it("relabels the box for reopening once the task is closed", async () => {
    vi.mocked(toggleChecklistItem).mockClear();
    vi.mocked(toggleChecklistItem).mockResolvedValueOnce("- [x] Task ✅ 2026-06-30");
    const { list } = renderRow(DayTask.parse("- [ ] Task", 0)!);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;
    expect(box.getAttribute("aria-label")).toBe("Close task");

    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(box.getAttribute("aria-label")).toBe("Reopen task"));
  });

  it("says so and refreshes when the tick can't be written", async () => {
    vi.mocked(Notice).mockClear();
    vi.mocked(toggleChecklistItem).mockClear();
    vi.mocked(toggleChecklistItem).mockRejectedValueOnce(new Error("disk full"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { list, view } = renderRow(DayTask.parse("- [ ] Task", 0)!);
    const box = list.querySelector(".pm-dash-checkbox") as HTMLElement;

    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());

    // The box stays as it was: a refresh re-reads the file and resyncs it.
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(Notice).toHaveBeenCalledWith("Couldn't update the task");
    expect(internals(view).onRefresh).toHaveBeenCalled();
    consoleSpy.mockRestore();
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
    internals(view).renderChecklistSection(container, sourced, filePath, date);
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

    function renderGrouped(
      items: DayTask[],
      pastDays: AdjacentDayData[] = [pastDay],
      futureDays: AdjacentDayData[] = [futureDay],
    ) {
      const view = makeView();
      view.dashboardDate = TODAY_DAY;
      const container = document.createElement("div");
      const sourced = items.map((it) => it.withSource("2026-06-29.md", TODAY_DAY));
      internals(view).renderChecklistSection(container, sourced, "2026-06-29.md", TODAY_DAY, { pastDays, futureDays });
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
      internals(view).renderChecklistSection(container, [], "2026-06-29.md", TODAY_DAY, { pastDays: [pastDay], futureDays: [] });
      (container.querySelector(".pm-day-task-note-icon") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-06-28"));
    });
  });
});

// ---------------------------------------------------------------------------
// renderAdjacentUnclosedSection (private)
// ---------------------------------------------------------------------------

describe("renderAdjacentUnclosedSection", () => {
  function renderSection(days: AdjacentDayData[], key = "tasks.previousUnclosed", title = "Overdue tasks") {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const container = document.createElement("div");
    internals(view).renderAdjacentUnclosedSection(container, days, key, title);
    return container;
  }

  it("renders nothing when there are no days", () => {
    const container = renderSection([]);
    expect(container.children.length).toBe(0);
  });

  it("uses the 'previous' tooltip for a previous-unclosed key", () => {
    const day = { offset: -1, date: new Date(TODAY), filePath: "f.md", unclosedItems: [DayTask.parse("- [ ] Old task", 0)!] };
    const container = renderSection([day], "tasks.previousUnclosed", "Overdue tasks");
    expect(container.querySelector(".pm-dash-section-tooltip")?.textContent).toContain("previous 7 days");
  });

  it("uses the 'next' tooltip for an upcoming-unclosed key", () => {
    const day = { offset: 1, date: new Date(TODAY), filePath: "f.md", unclosedItems: [DayTask.parse("- [ ] Future task", 0)!] };
    const container = renderSection([day], "tasks.upcomingUnclosed", "Upcoming tasks");
    expect(container.querySelector(".pm-dash-section-tooltip")?.textContent).toContain("next 7 days");
  });

  it("renders one row per unclosed item across all days, each with a date label", () => {
    const day1 = { offset: -2, date: new Date(2026, 5, 27), filePath: "d1.md", unclosedItems: [DayTask.parse("- [ ] A", 0)!.withSource("d1.md", day("2026-06-27"))] };
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
    internals(view).renderAdjacentUnclosedSection(container, [pastDay], "tasks.previousUnclosed", "Overdue tasks");
    (container.querySelector(".pm-task-badge") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-06-28"));
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
    internals(view).plugin.settings.unclosedDaysBefore = 2;
    internals(view).plugin.settings.unclosedDaysAfter = 1;
    const result = await view.loadAdjacentUnclosed(TODAY_DAY, { folder: "", format: "YYYY-MM-DD", template: "" });
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
    internals(view).plugin.settings.unclosedDaysBefore = 1;
    internals(view).plugin.settings.unclosedDaysAfter = 0;
    const result = await view.loadAdjacentUnclosed(TODAY_DAY, { folder: "", format: "YYYY-MM-DD", template: "" });
    expect(result).toEqual([]);
  });

  it("defaults the before/after window to 7 days when unset", async () => {
    vi.mocked(loadDayChecklist).mockReset();
    vi.mocked(loadDayChecklist).mockResolvedValue({ items: [], filePath: null });
    const view = makeView();
    await view.loadAdjacentUnclosed(TODAY_DAY, { folder: "", format: "YYYY-MM-DD", template: "" });
    expect(loadDayChecklist).toHaveBeenCalledTimes(14);
  });
});

// ---------------------------------------------------------------------------
// render (top-level)
// ---------------------------------------------------------------------------

describe("DashboardView.render", () => {
  // Back to a vault that takes day notes, even if the test saying otherwise failed early.
  afterEach(() => {
    vi.mocked(canCreateDayNotes).mockResolvedValue(true);
  });

  function renderDashboard(view: ReturnType<typeof makeView>, overrides: {
    checklistItems?: DayTask[];
    dnPath?: string | null;
    tasks?: Task[];
    projects?: Project[];
    adjacentData?: AdjacentDayData[];
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

  it("drops a planned item that names no day at all", () => {
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    // No ⏳ and no note behind it, so there is no day to file it under.
    const undated = DayTask.parse("- [ ] No day named", 0)!.withSource("Inbox.md");
    const dated = DayTask.parse("- [ ] Coming plan ⏳ 2026-07-02", 0)!.withSource("Inbox.md");

    const content = renderDashboard(view, { dnPath: null, plannedItems: [undated, dated] });

    const titles = [...content.querySelectorAll(".pm-dash-checklist-text")].map((e) => e.textContent);
    expect(titles).toEqual(["Coming plan"]);
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
    expect(openNoteFile).toHaveBeenCalledWith(internals(view).app, "2026-06-29.md");
  });

  it("creates the note via DayMarkdownFile.ensure when the date label is clicked and there is no note yet", async () => {
    vi.mocked(openNoteFile).mockClear();
    ensureDayNoteMock.mockResolvedValue({ filePath: "2026-06-29.md" });
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view, { dnPath: null });
    const label = content.querySelector(".pm-dash-date-text") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(openNoteFile).toHaveBeenCalledWith(internals(view).app, "2026-06-29.md");
  });

  it("does not open a note when ensure() fails to produce one", async () => {
    vi.mocked(openNoteFile).mockClear();
    vi.mocked(Notice).mockClear();
    vi.mocked(canCreateDayNotes).mockResolvedValue(true);
    ensureDayNoteMock.mockResolvedValue(null);
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view, { dnPath: null });
    const label = content.querySelector(".pm-dash-date-text") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(Notice).toHaveBeenCalled());
    expect(openNoteFile).not.toHaveBeenCalled();
    expect(vi.mocked(Notice).mock.calls[0][0]).toBe("Couldn't create the day note");
  });

  it("names the daily notes core plugin when that is what stops the note being created", async () => {
    vi.mocked(openNoteFile).mockClear();
    vi.mocked(Notice).mockClear();
    vi.mocked(canCreateDayNotes).mockResolvedValue(false);
    ensureDayNoteMock.mockResolvedValue(null);
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view, { dnPath: null });
    const label = content.querySelector(".pm-dash-date-text") as HTMLElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(Notice).toHaveBeenCalled());
    expect(openNoteFile).not.toHaveBeenCalled();
    expect(vi.mocked(Notice).mock.calls[0][0]).toContain("daily notes core plugin");
  });

  it("shows a 'Today' button when the date isn't today, and it jumps back to today", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = new Date(2026, 5, 20);
    const content = renderDashboard(view);
    const todayBtn = content.querySelector(".pm-dash-today-btn") as HTMLElement;
    expect(todayBtn).not.toBeNull();
    todayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(internals(view).onRefresh).toHaveBeenCalled();
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
    const navBtns = [...content.querySelectorAll(".pm-dash-nav-btn")]
      .filter((b) => !b.classList.contains("pm-dash-add-btn") && !b.classList.contains("pm-dash-cal-btn"));
    const [prevBtn, nextBtn] = navBtns;
    prevBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(internals(view).onRefresh).toHaveBeenCalled();
    (internals(view).onRefresh as ReturnType<typeof vi.fn>).mockClear();
    nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(internals(view).onRefresh).toHaveBeenCalled();
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
    const picked = new Date(2026, 6, 10);
    opts.onPick(picked);
    expect(view.dashboardDate).toBe(picked);
    expect(internals(view).onRefresh).toHaveBeenCalled();
  });

  it("renders one priority queue from the given tasks, overdue first", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const tasks: Task[] = [
      makeTask({ id: "t1", title: "Due today", due: TODAY_DAY, priority: Priority.High }),
      makeTask({ id: "t2", title: "Overdue", due: day("2026-06-20") }),
      makeTask({ id: "t3", title: "Due later", due: day("2026-08-20"), priority: Priority.High }),
    ];
    const content = renderDashboard(view, { tasks, projects: [makeProject({ id: "proj1" })] });
    expect(content.textContent).toContain("Priority Queue");
    expect([...content.querySelectorAll(".pm-dash-task-title")].map((el) => el.textContent))
      .toEqual(["Overdue", "Due today", "Due later"]);
  });

  it("runs the project tasks into one list when the lists aren't split", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    internals(view).plugin.settings.splitTaskLists = false;
    view.dashboardDate = TODAY_DAY;
    const tasks: Task[] = [
      makeTask({ id: "t1", title: "Due soon", due: TODAY_DAY }),
      makeTask({ id: "t2", title: "Due later", due: day("2026-08-20"), priority: Priority.High }),
    ];
    const content = renderDashboard(view, { tasks, projects: [makeProject({ id: "proj1" })] });
    expect(content.textContent).toContain("Project Tasks");
    expect(content.textContent).not.toContain("Priority Queue");
    // The ranked queue, unheaded — the most urgent first, as the section shows it.
    expect([...content.querySelectorAll(".pm-dash-task-title")].map((el) => el.textContent))
      .toEqual(["Due soon", "Due later"]);
  });

  it("leaves the creation date off its rows — the deadline is what they are there for", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.dashboardDate = TODAY_DAY;
    const tasks: Task[] = [
      makeTask({ id: "t1", due: TODAY_DAY, priority: Priority.High, createdAt: timestamp("2026-06-22T09:15:00.000Z") }),
    ];
    const content = renderDashboard(view, { tasks, projects: [makeProject({ id: "proj1" })] });
    expect(createdBadges(content)).toEqual([]);
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
    internals(view).plugin.settings.splitTaskLists = false;
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
    internals(view).plugin.settings.splitTaskLists = false;
    view.dashboardDate = TODAY_DAY;
    const content = renderDashboard(view);
    expect(content.textContent).toContain("No tasks due or prioritized");
  });

  describe("with the daily and project tasks merged", () => {
    function makeMergedView(split = true) {
      const view = makeView();
      internals(view).plugin.settings.mergeDailyAndProjectTasks = true;
      internals(view).plugin.settings.splitTaskLists = split;
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

    it("names the day on show in the Current empty state, not 'today'", () => {
      vi.setSystemTime(new Date(TODAY));
      const view = makeMergedView();
      view.dashboardDate = day("2026-07-05");
      const content = renderDashboard(view);
      const empties = [...content.querySelectorAll(".pm-dash-empty")].map((el) => el.textContent);
      // The moment stub echoes back any format but YYYY-MM-DD, so the day reads as its pattern.
      expect(empties).toContain("Nothing on MMM D");
      expect(empties).not.toContain("Nothing on today");
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

      it("still ends with the add-task bar", () => {
        vi.setSystemTime(new Date(TODAY));
        const content = renderDashboard(makeMergedView());
        expect(content.querySelector(".pm-add-input")).not.toBeNull();
      });
    });
  });

  describe("the add-task bar", () => {
    const addInput = (content: HTMLElement) => content.querySelector<HTMLInputElement>(".pm-add-input")!;

    beforeEach(() => {
      vi.mocked(addTaskToDay).mockClear();
      vi.mocked(Notice).mockClear();
      vi.setSystemTime(new Date(TODAY));
    });

    it("names the day it writes to", () => {
      const view = makeView();
      view.dashboardDate = new Date(2026, 6, 3);
      // The moment mock leaves an unknown pattern as-is, so the day reads as "MMM D".
      expect(addInput(renderDashboard(view)).placeholder).toBe("➕ Add a task to MMM D…");
    });

    it("says \"today\" on the day itself", () => {
      const view = makeView();
      view.dashboardDate = TODAY_DAY;
      expect(addInput(renderDashboard(view)).placeholder).toBe("➕ Add a task to today…");
    });

    it("writes the trimmed title onto the day on show", () => {
      const view = makeView();
      view.dashboardDate = new Date(2026, 6, 3);
      const input = addInput(renderDashboard(view));
      input.value = "  Buy milk  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(addTaskToDay).toHaveBeenCalledWith(
        internals(view).app, new Date(2026, 6, 3), "Buy milk", "Inbox.md", "## Tasks",
      );
    });

    it("does nothing on Enter with a blank input", () => {
      const input = addInput(renderDashboard(makeView()));
      input.value = "   ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(addTaskToDay).not.toHaveBeenCalled();
    });

    it("promises the move when the day to come has no note to take the task yet", async () => {
      vi.mocked(addTaskToDay).mockResolvedValueOnce(ScheduleOutcome.Targeted);
      const view = makeView();
      view.dashboardDate = new Date(2026, 6, 3);
      const input = addInput(renderDashboard(view));
      input.value = "Buy milk";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await vi.waitFor(() => expect(Notice).toHaveBeenCalled());
      expect(vi.mocked(Notice).mock.calls[0][0]).toContain("it moves there once that daily note exists");
    });

    it("promises nothing on a past day, which is unlikely ever to get a note", async () => {
      vi.mocked(addTaskToDay).mockResolvedValueOnce(ScheduleOutcome.Targeted);
      const view = makeView();
      view.dashboardDate = new Date(2026, 5, 20);
      const input = addInput(renderDashboard(view));
      input.value = "Buy milk";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await vi.waitFor(() => expect(Notice).toHaveBeenCalled());
      expect(vi.mocked(Notice).mock.calls[0][0]).toContain("has no daily note — added to the inbox");
    });

    const plusBtn = (content: HTMLElement) => content.querySelector<HTMLElement>(".pm-dash-add-btn")!;
    const barOf = (content: HTMLElement) => content.querySelector<HTMLElement>(".pm-add-bar")!;

    it("stays hidden until the date navigator's + asks for it", () => {
      const content = renderDashboard(makeView());
      expect(barOf(content).classList.contains("pm-add-bar--collapsed")).toBe(true);

      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(barOf(content).classList.contains("pm-add-bar--collapsed")).toBe(false);
      expect(plusBtn(content).classList.contains("is-active")).toBe(true);
    });

    it("closes again on a second tap of the +, and on Escape", () => {
      const content = renderDashboard(makeView());
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(barOf(content).classList.contains("pm-add-bar--collapsed")).toBe(true);
      expect(plusBtn(content).classList.contains("is-active")).toBe(false);

      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      addInput(content).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(barOf(content).classList.contains("pm-add-bar--collapsed")).toBe(true);
    });

    it("closes on a tap outside it, the false start put away", () => {
      const content = renderDashboard(makeView());
      document.body.appendChild(content);
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      content.querySelector(".pm-dash-date-text")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(barOf(content).classList.contains("pm-add-bar--collapsed")).toBe(true);
      expect(plusBtn(content).classList.contains("is-active")).toBe(false);
      content.remove();
    });

    it("stays open for a tap on the bar itself or on the +", () => {
      const content = renderDashboard(makeView());
      document.body.appendChild(content);
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      addInput(content).dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(barOf(content).classList.contains("pm-add-bar--collapsed")).toBe(false);

      plusBtn(content).dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(barOf(content).classList.contains("pm-add-bar--collapsed")).toBe(false);
      content.remove();
    });

    it("stops watching for taps once closed", () => {
      const content = renderDashboard(makeView());
      document.body.appendChild(content);
      const removeSpy = vi.spyOn(document, "removeEventListener");
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(removeSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
      removeSpy.mockRestore();
      content.remove();
    });

    it("stops watching for taps when the view goes away with the bar still open", () => {
      const view = makeView();
      const content = renderDashboard(view);
      document.body.appendChild(content);
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const removeSpy = vi.spyOn(document, "removeEventListener");
      view.dispose();
      expect(removeSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
      removeSpy.mockRestore();
      content.remove();
    });

    it("comes back open on the re-render that follows adding a task", () => {
      const view = makeView();
      const content = renderDashboard(view);
      plusBtn(content).dispatchEvent(new MouseEvent("click", { bubbles: true }));

      const again = renderDashboard(view);
      expect(barOf(again).classList.contains("pm-add-bar--collapsed")).toBe(false);
      expect(plusBtn(again).classList.contains("is-active")).toBe(true);
    });

    it("says so when the task couldn't be written at all", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(addTaskToDay).mockResolvedValueOnce(ScheduleOutcome.Failed);
      const input = addInput(renderDashboard(makeView()));
      input.value = "Buy milk";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await vi.waitFor(() => expect(Notice).toHaveBeenCalledWith("Couldn't add the task"));
      errorSpy.mockRestore();
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
    mockConfirmAction.calls.length = 0;
    vi.clearAllMocks();
  });

  it("runs the class field initializers when constructed normally", () => {
    const view = new DashboardView(asApp({}), { settings: { dashboardCollapsed: {} } } as unknown as PMCompassPlugin, () => {});
    expect(internals(view).allTasks).toEqual([]);
  });

  // ── createCollapsibleSection ──────────────────────────────────────────────

  describe("createCollapsibleSection", () => {
    it("adds the sub modifier class when sub is true", () => {
      const view = makeView();
      const container = document.createElement("div");
      const { section } = internals(view).createCollapsibleSection(container, "Title", "key1", { sub: true });
      expect(section.classList.contains("pm-dash-section--sub")).toBe(true);
    });

    it("omits the sub modifier class by default", () => {
      const view = makeView();
      const container = document.createElement("div");
      const { section } = internals(view).createCollapsibleSection(container, "Title", "key1");
      expect(section.classList.contains("pm-dash-section--sub")).toBe(false);
    });

    it("starts collapsed (chevron class + hidden body) when the key is marked collapsed", () => {
      const view = makeView();
      internals(view).plugin.settings.dashboardCollapsed["key1"] = true;
      const container = document.createElement("div");
      const { section, body } = internals(view).createCollapsibleSection(container, "Title", "key1");
      expect(section.querySelector(".pm-dash-section-chevron--collapsed")).not.toBeNull();
      expect(body.style.display).toBe("none");
    });

    it("starts expanded when the key is not marked collapsed", () => {
      const view = makeView();
      const container = document.createElement("div");
      const { section, body } = internals(view).createCollapsibleSection(container, "Title", "key1");
      expect(section.querySelector(".pm-dash-section-chevron--collapsed")).toBeNull();
      expect(body.style.display).toBe("");
    });

    it("toggles collapsed state and persists it on header click", () => {
      const view = makeView();
      const container = document.createElement("div");
      const { section, body } = internals(view).createCollapsibleSection(container, "Title", "key1");
      const header = section.querySelector(".pm-dash-section-header") as HTMLElement;

      header.click();
      expect(internals(view).plugin.settings.dashboardCollapsed["key1"]).toBe(true);
      expect(body.style.display).toBe("none");
      expect(internals(view).plugin.saveSettings).toHaveBeenCalled();

      header.click();
      expect(internals(view).plugin.settings.dashboardCollapsed["key1"]).toBe(false);
      expect(body.style.display).toBe("");
    });

    it("renders a tooltip and toggles it open/closed on click, closing on an outside click", () => {
      const view = makeView();
      const container = document.createElement("div");
      document.body.appendChild(container);
      internals(view).createCollapsibleSection(container, "Title", "key1", { tooltip: "Explains things" });
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
      internals(view).createCollapsibleSection(container, "Title", "key1");
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
      /** The tree the row reads its warnings against; the task alone by default. */
      allTasks?: Task[];
    } = {}) {
      const view = makeView();
      internals(view).allTasks = opts.allTasks ?? [task];
      const container = document.createElement("div");
      const projectMap = opts.projectMap ?? new Map<string, Project>();
      const eff: EffectiveValues = {
        // What the row draws is the two directions; `priority` is the rank, unused here.
        priority: opts.effectivePriority ?? opts.subtreePriority,
        ancestorPriority: opts.effectivePriority,
        subtreePriority: opts.subtreePriority,
        due: opts.effectiveDue,
      };
      internals(view).renderTaskRow(container, task, projectMap, eff, opts.readonly ?? false);
      return { view, row: container.querySelector(".pm-dash-task-row") as HTMLElement };
    }

    it("warns on a completed task that still has open subtasks", () => {
      const parent = makeTask({ id: "t1", status: "done", completed: new Date() });
      const child = makeTask({ id: "c1", parentId: "t1" });
      const { row } = renderRow(parent, { allTasks: [parent, child] });
      expect(row.querySelector(".pm-dash-task-warn")).not.toBeNull();
    });

    it("warns on an open task whose parent is already completed", () => {
      const parent = makeTask({ id: "t1", status: "done", completed: new Date() });
      const child = makeTask({ id: "c1", parentId: "t1" });
      const { row } = renderRow(child, { allTasks: [parent, child] });
      expect(row.querySelector(".pm-dash-task-warn")).not.toBeNull();
    });

    it("leaves both warnings off a task in step with its tree", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      expect(row.querySelector(".pm-dash-task-warn")).toBeNull();
    });

    it("opens the graph from the project name beside the title", () => {
      const project = makeProject({ id: "proj1", title: "Alpha" });
      const { view, row } = renderRow(makeTask({ id: "t1", projectId: "proj1" }), {
        projectMap: new Map([["proj1", project]]),
      });
      const openSpy = vi.spyOn(internals(view), "openInGraph").mockResolvedValue(undefined);

      (row.querySelector(".pm-dash-task-project") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openSpy).toHaveBeenCalled();
    });

    it("opens the graph from the leading project icon too", () => {
      const project = makeProject({ id: "proj1", title: "Alpha" });
      const { view, row } = renderRow(makeTask({ id: "t1", projectId: "proj1" }), {
        projectMap: new Map([["proj1", project]]),
      });
      const openSpy = vi.spyOn(internals(view), "openInGraph").mockResolvedValue(undefined);

      (row.querySelector(".pm-dash-task-project-icon") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openSpy).toHaveBeenCalled();
    });

    it("says so when a row's edit fails, rather than leaving the row looking changed", async () => {
      vi.mocked(Notice).mockClear();
      vi.mocked(patchTaskField).mockRejectedValueOnce(new Error("disk full"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { view, row } = renderRow(makeTask({ id: "t1" }));

      (row.querySelector(".pm-dash-task-status-icon") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      vi.mocked(openDropdown).mock.calls.at(-1)![1][0].onSelect();
      await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());

      expect(Notice).toHaveBeenCalledWith("Couldn't update the status");
      expect(internals(view).onRefresh).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("draws the status picker, not a checkbox — a project task has six rungs, not two", () => {
      // Both kinds go through one row shell; what control it draws is the task's own
      // answer (`statusScale`), not a branch on which view called it.
      const { row } = renderRow(makeTask({ id: "t1" }));
      expect(row.querySelector(".pm-dash-task-status-icon")).not.toBeNull();
      expect(row.querySelector(".pm-dash-checkbox")).toBeNull();
    });

    it("keeps the list slot free of the closed modifier — the closed date says it instead", () => {
      const { row } = renderRow(makeTask({ id: "t1", status: "done", completed: new Date() }));
      expect(row.closest("li")!.className).toBe("pm-dash-task-item");
    });

    it("adds the readonly modifier class and skips interactive handlers when readonly", () => {
      const { row } = renderRow(makeTask({ id: "t1" }), { readonly: true });
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(true);
      expect(row.querySelector(".pm-task-actions")).toBeNull();
    });

    it("omits the readonly modifier class by default", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(false);
    });

    it("sends a dated task to the inbox by clearing its own deadline", async () => {
      vi.mocked(patchTaskDue).mockClear();
      const { row } = renderRow(makeTask({ id: "t1", due: new Date(2026, 0, 5) }));
      const inboxBtn = row.querySelector("[aria-label='Move to inbox']") as HTMLElement;
      inboxBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      expect(patchTaskDue).toHaveBeenCalledWith(expect.anything(), "tasks/t1.md", null);
    });

    it("writes the deadline the picker comes back with", async () => {
      vi.mocked(patchTaskDue).mockClear();
      mockOpenDatePicker.mockClear();
      const { row } = renderRow(makeTask({ id: "t1" }));
      (row.querySelector("[aria-label='Set deadline']") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      mockOpenDatePicker.mock.calls[0][1].onPick(day("2026-08-04"));
      await Promise.resolve();

      expect(patchTaskDue).toHaveBeenCalledWith(expect.anything(), "tasks/t1.md", day("2026-08-04"));
    });

    it("clears the deadline from the picker for a task that has one", async () => {
      vi.mocked(patchTaskDue).mockClear();
      mockOpenDatePicker.mockClear();
      const { row } = renderRow(makeTask({ id: "t1", due: day("2026-08-04") }));
      (row.querySelector("[aria-label='Set deadline']") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      mockOpenDatePicker.mock.calls[0][1].onClear!();
      await Promise.resolve();

      expect(patchTaskDue).toHaveBeenCalledWith(expect.anything(), "tasks/t1.md", null);
    });

    it("offers no clear in the picker for a task with no deadline of its own", () => {
      mockOpenDatePicker.mockClear();
      const { row } = renderRow(makeTask({ id: "t1" }));
      (row.querySelector("[aria-label='Set deadline']") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(mockOpenDatePicker.mock.calls[0][1].onClear).toBeUndefined();
    });

    it("refreshes the tab once the details editor saves", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      (row.querySelector("[aria-label='Edit task details']") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      (MockTaskModal.instances.at(-1)!.opts.onSuccess as () => void)();

      expect(internals(view).onRefresh).toHaveBeenCalled();
    });

    it("omits the inbox action with no deadline of the task's own to clear", () => {
      const undated = renderRow(makeTask({ id: "t1" }));
      expect(undated.row.querySelector("[aria-label='Move to inbox']")).toBeNull();
      // An inherited deadline is the parent's, and isn't dropped from the child's row.
      const inherited = renderRow(makeTask({ id: "t2" }), { effectiveDue: new Date(2026, 0, 5) });
      expect(inherited.row.querySelector("[aria-label='Move to inbox']")).toBeNull();
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

    it("takes the day to the one a closed task closed on", () => {
      const { view, row } = renderRow(makeTask({
        id: "t1", status: "done", due: day("2026-06-01"), completed: timestamp("2026-07-01T09:00:00Z"),
      }));
      const badge = row.querySelector(".pm-task-badge") as HTMLElement;

      badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-07-01"));
    });

    it("takes the day to a task's deadline", () => {
      const { view, row } = renderRow(makeTask({ id: "t1", due: day("2026-07-05") }));
      const badge = row.querySelector(".pm-task-badge") as HTMLElement;

      badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-07-05"));
    });

    it("leaves a read-only echo's deadline badge inert", () => {
      // The expand list draws rows to be read, not used: a click there would swap the
      // tab out from under the list the user just opened.
      const { view, row } = renderRow(makeTask({ id: "t1", due: day("2026-07-05") }), { readonly: true });
      const badge = row.querySelector(".pm-task-badge") as HTMLElement;

      // Aimed at the badge alone: on a read-only row a bubbling click reaches the row,
      // whose own handler opens the graph.
      badge.dispatchEvent(new MouseEvent("click"));

      expect(internals(view).showDay).not.toHaveBeenCalled();
      expect(badge.title).toBe("Deadline: 2026-07-05 — show that day");
    });

    it("leaves a read-only echo's closed-date badge inert", () => {
      const { view, row } = renderRow(
        makeTask({ id: "t1", status: "done", completed: timestamp("2026-07-01T09:00:00Z") }),
        { readonly: true },
      );
      const badge = row.querySelector(".pm-task-badge") as HTMLElement;

      // Aimed at the badge alone: on a read-only row a bubbling click reaches the row,
      // whose own handler opens the graph.
      badge.dispatchEvent(new MouseEvent("click"));

      expect(internals(view).showDay).not.toHaveBeenCalled();
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
      internals(view).onRefresh = vi.fn();
      ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openDropdown).toHaveBeenCalledOnce();
      const options = vi.mocked(openDropdown).mock.calls[0][1];
      options[0].onSelect();
      await Promise.resolve();
      expect(patchTaskField).toHaveBeenCalledWith(internals(view).app, "t1.md", "priority", options[0].label === "None" ? "" : expect.anything());
    });

    it("opens a status dropdown on status-icon click and patches the field on select", async () => {
      const { view, row } = renderRow(makeTask({ id: "t1", filePath: "t1.md" }));
      const statusIcon = row.querySelector(".pm-dash-task-status-icon") as HTMLElement;
      statusIcon.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(openDropdown).toHaveBeenCalledOnce();
      const options = vi.mocked(openDropdown).mock.calls[0][1];
      options[0].onSelect();
      await Promise.resolve();
      expect(patchTaskField).toHaveBeenCalledWith(internals(view).app, "t1.md", "status", expect.any(String));
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
      const spy = vi.spyOn(internals(view), "openInGraph").mockResolvedValue(undefined);
      action(row, "Open in graph").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(spy).toHaveBeenCalledOnce();
    });

    it("reveals the toolbar on a row click, the same gesture a checklist row answers to", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(internals(view), "openInGraph").mockResolvedValue(undefined);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(row.classList.contains("pm-task-row--open")).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });

    it("keeps the graph on the row's own click when readonly, since those rows get no toolbar", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }), { readonly: true });
      const spy = vi.spyOn(internals(view), "openInGraph").mockResolvedValue(undefined);
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
      expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-07-01"));
      // The deadline itself is changed from the toolbar's button, not from the badge.
      expect(mockOpenDatePicker).not.toHaveBeenCalled();
    });

    it("shows the day of an inherited deadline too — the day is a day either way", () => {
      const { row, view } = renderRow(makeTask({ id: "t1", due: day("2026-07-01") }), { effectiveDue: day("2026-07-05") });
      (row.querySelector(".pm-task-badge") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-07-05"));
    });

    it("does not reveal the toolbar when clicking the ribbon", () => {
      const { row } = renderRow(makeTask({ id: "t1" }));
      const ribbon = row.querySelector(".pm-task-ribbon") as HTMLElement;
      ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(row.classList.contains("pm-task-row--open")).toBe(false);
    });

    it("opens the context menu on right-click", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }));
      const spy = vi.spyOn(internals(view), "openTaskContextMenu").mockImplementation(() => {});
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      expect(spy).toHaveBeenCalledOnce();
    });

    it("does not attach a context-menu handler when readonly", () => {
      const { view, row } = renderRow(makeTask({ id: "t1" }), { readonly: true });
      const spy = vi.spyOn(internals(view), "openTaskContextMenu").mockImplementation(() => {});
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── renderExpandList ─────────────────────────────────────────────────────

  describe("renderExpandList", () => {
    it("shows an empty-state message when there are no tasks", () => {
      const view = makeView();
      const container = document.createElement("div");
      internals(view).renderExpandList(container, [], new Map(), new Map());
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
      internals(view).renderExpandList(container, [task], new Map(), effMap);
      const row = container.querySelector(".pm-dash-task-row") as HTMLElement;
      expect(row.classList.contains("pm-dash-task-row--readonly")).toBe(true);
      expect(row.querySelector(".pm-task-ribbon")?.getAttribute("title")).toContain("High");
    });
  });

  // ── openTaskContextMenu ──────────────────────────────────────────────────

  describe("openTaskContextMenu", () => {
    function openMenu(task: Task, projectMap: Map<string, Project>, allTasks: Task[] = [task]) {
      const view = makeView();
      internals(view).allTasks = allTasks;
      const e = new MouseEvent("contextmenu");
      internals(view).openTaskContextMenu(e, task, projectMap);
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

    it("refreshes the tab once a subtask added from the menu is saved", () => {
      const project = makeProject({ id: "proj1", title: "Alpha", filePath: "Alpha.md" });
      const task = makeTask({ id: "t1", projectId: "proj1" });
      const { view, addSubtask } = openMenu(task, new Map([["proj1", project]]));
      addSubtask._onClick!();

      (MockTaskModal.instances[0].opts.onSuccess as () => void)();

      expect(internals(view).onRefresh).toHaveBeenCalled();
    });

    it("opens the destination picker on 'Move task…'", () => {
      const task = makeTask({ id: "t1", title: "Leaf task" });
      const { moveTask } = openMenu(task, new Map());

      moveTask._onClick!();

      expect(document.querySelector(".pm-move-target-modal")).not.toBeNull();
    });

    it("prompts to delete a leaf task without a subtask count", () => {
      const task = makeTask({ id: "t1", title: "Leaf task" });
      const { deleteTask } = openMenu(task, new Map());
      deleteTask._onClick!();
      expect(mockConfirmAction.calls[0].message).toBe('Delete "Leaf task"?');
    });

    it("prompts with a singular subtask count for one descendant", () => {
      const task = makeTask({ id: "t1", title: "Parent" });
      const child = makeTask({ id: "c1", parentId: "t1" });
      const { deleteTask } = openMenu(task, new Map(), [task, child]);
      deleteTask._onClick!();
      expect(mockConfirmAction.calls[0].message).toBe('Delete "Parent" and its 1 subtask?');
    });

    it("prompts with a plural subtask count for multiple descendants", () => {
      const task = makeTask({ id: "t1", title: "Parent" });
      const child1 = makeTask({ id: "c1", parentId: "t1" });
      const child2 = makeTask({ id: "c2", parentId: "t1" });
      const { deleteTask } = openMenu(task, new Map(), [task, child1, child2]);
      deleteTask._onClick!();
      expect(mockConfirmAction.calls[0].message).toBe('Delete "Parent" and its 2 subtasks?');
    });

    it("deletes the task file (with no parent) when the confirm modal is accepted", () => {
      const task = makeTask({ id: "t1", title: "Leaf task" });
      const { view, deleteTask } = openMenu(task, new Map());
      deleteTask._onClick!();
      mockConfirmAction.calls[0].onConfirm();
      expect(deleteTaskFile).toHaveBeenCalledWith(internals(view).app, task, undefined, [task]);
    });

    it("resolves and passes the parent task when the task has a findable parentId", () => {
      const parent = makeTask({ id: "p1", title: "Parent" });
      const task = makeTask({ id: "t1", title: "Child", parentId: "p1" });
      const { view, deleteTask } = openMenu(task, new Map(), [parent, task]);
      deleteTask._onClick!();
      mockConfirmAction.calls[0].onConfirm();
      expect(deleteTaskFile).toHaveBeenCalledWith(internals(view).app, task, parent, [parent, task]);
    });
  });

  // ── openInGraph ──────────────────────────────────────────────────────────

  describe("openInGraph", () => {
    function makeGraphApp(leaves: unknown[]) {
      const revealLeaf = vi.fn();
      const getLeaf = vi.fn();
      const app = asApp({
        workspace: {
          getLeavesOfType: vi.fn().mockReturnValue(leaves),
          getLeaf,
          revealLeaf,
        },
        internalPlugins: { plugins: {} },
      });
      return { app, getLeaf, revealLeaf };
    }

    it("reuses an existing task-graph leaf and reveals it", async () => {
      const view = makeView();
      const graphView = new MockTaskGraphView();
      const leaf = { view: graphView };
      const { app, revealLeaf } = makeGraphApp([leaf]);
      internals(view).app = app;
      await internals(view).openInGraph(makeTask({ id: "t1", projectId: "p1" }));
      expect(revealLeaf).toHaveBeenCalledWith(leaf);
      expect(graphView.openTask).toHaveBeenCalledWith("p1", "t1");
    });

    it("opens a new tab and activates the task-graph view when no leaf exists yet", async () => {
      const view = makeView();
      const graphView = new MockTaskGraphView();
      const newLeaf = { view: graphView, setViewState: vi.fn().mockResolvedValue(undefined) };
      const { app, getLeaf, revealLeaf } = makeGraphApp([]);
      getLeaf.mockReturnValue(newLeaf);
      internals(view).app = app;
      await internals(view).openInGraph(makeTask({ id: "t1", projectId: "p1" }));
      expect(newLeaf.setViewState).toHaveBeenCalledWith({ type: "pm-compass-task-graph", active: true });
      expect(revealLeaf).toHaveBeenCalledWith(newLeaf);
      expect(graphView.openTask).toHaveBeenCalledWith("p1", "t1");
    });

    it("does not call openTask when the leaf's view never becomes a TaskGraphView", async () => {
      const view = makeView();
      const newLeaf = { view: {}, setViewState: vi.fn().mockResolvedValue(undefined) };
      const { app, getLeaf, revealLeaf } = makeGraphApp([]);
      getLeaf.mockReturnValue(newLeaf);
      internals(view).app = app;
      await internals(view).openInGraph(makeTask({ id: "t1", projectId: "p1" }));
      expect(revealLeaf).toHaveBeenCalledWith(newLeaf);
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
    internals(view).renderTaskRow(container, makeTask({ id: "t1", projectId: "proj1" }), projectMap);
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
    internals(view).renderTaskRow(container, makeTask({ id: "t1", projectId: "gone" }), new Map());
    expect(container.querySelector(".pm-dash-task-project-icon")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A project task's creation date
// ---------------------------------------------------------------------------

describe("a project task's creation date", () => {
  // Only a tab that asks for it gets the badge — the Inbox does, the dashboard doesn't.
  function renderCreated(createdAt?: Date, showCreated = true) {
    const view = makeView();
    const container = document.createElement("div");
    internals(view).renderTaskRow(container, makeTask({ id: "t1", createdAt }), new Map(), undefined, false, showCreated);
    return { container, view };
  }

  it("shows how long the task has been on the books, and takes the day to it", () => {
    vi.setSystemTime(new Date(TODAY));
    const { container, view } = renderCreated(timestamp("2026-06-22T09:15:00.000Z"));
    const badge = createdBadges(container)[0];
    expect(badge.textContent).toBe("7 d");
    // Quietly: an old task is not a stale one, so no warning glyph and no red.
    expect(badge.querySelector(".pm-task-badge-icon")).toBeNull();
    expect(badge.classList.contains("pm-task-badge--danger")).toBe(false);
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(internals(view).showDay).toHaveBeenCalledWith(day("2026-06-22"));
  });

  it("stays quiet for a task created long ago", () => {
    vi.setSystemTime(new Date(TODAY));
    const { container } = renderCreated(timestamp("2025-01-05T09:15:00.000Z"));
    const badge = container.querySelector(".pm-task-badge") as HTMLElement;
    expect(badge.classList.contains("pm-task-badge--danger")).toBe(false);
  });

  it("leaves the creation badge inert on a read-only echo", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    const container = document.createElement("div");
    internals(view).renderTaskRow(
      container, makeTask({ id: "t1", createdAt: timestamp("2026-06-22T09:15:00.000Z") }),
      new Map(), undefined, true, true,
    );
    const badge = createdBadges(container)[0];

    // Aimed at the badge alone: on a read-only row a bubbling click reaches the row,
    // whose own handler opens the graph.
    badge.dispatchEvent(new MouseEvent("click"));

    expect(internals(view).showDay).not.toHaveBeenCalled();
  });

  it("shows nothing for a task whose file records no creation date", () => {
    const { container } = renderCreated(undefined);
    expect(container.querySelector(".pm-task-badge")).toBeNull();
  });

  it("stays off the row on a tab that doesn't ask for it", () => {
    vi.setSystemTime(new Date(TODAY));
    const { container } = renderCreated(timestamp("2026-06-22T09:15:00.000Z"), false);
    expect(container.querySelector(".pm-task-badge")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The day the dashboard is on
// ---------------------------------------------------------------------------

describe("the day the dashboard is showing", () => {
  it("moves to the day it is sent to, at that day's midnight", () => {
    const view = makeView();
    view.setDate(new Date(2026, 7, 4, 17, 30));
    expect(view.dashboardDate).toEqual(day("2026-08-04"));
  });

  it("reads every date on the tab against that day, not the real today", () => {
    vi.setSystemTime(new Date(TODAY));
    const view = makeView();
    view.setDate(day("2026-07-05"));
    const container = document.createElement("div");
    internals(view).renderTaskRow(container, makeTask({ id: "t1", due: day("2026-07-08") }), new Map());

    // Three days out from the day on show, not the eight it is from the real today.
    expect((container.querySelector(".pm-task-badge") as HTMLElement).textContent).toBe("in 3d");
  });

  it("draws its date badges without a route to a day when built without one", () => {
    // The route is optional on the base view, so a tab built with three arguments still
    // renders — the badge is simply inert.
    const view = new DashboardView(
      { internalPlugins: { plugins: {} } } as unknown as App,
      internals(makeView()).plugin as unknown as PMCompassPlugin,
      vi.fn(),
    );
    Object.assign(view, { allTasks: [], projects: [], renderHost: new Component() });
    const container = document.createElement("div");

    (view as unknown as ViewInternals).renderTaskRow(
      container, makeTask({ id: "t1", due: day("2026-07-08") }), new Map(),
    );
    const badge = container.querySelector(".pm-task-badge") as HTMLElement;

    expect(() => badge.dispatchEvent(new MouseEvent("click"))).not.toThrow();
  });
});
