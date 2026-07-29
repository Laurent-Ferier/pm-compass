// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svgProto = SVGElement.prototype as any;

  type CreateElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    this.appendChild(el);
    return el;
  }

  htmlProto.createEl = createElOn;
  htmlProto.createDiv = function (this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("div", opts);
  };
  htmlProto.createSpan = function (this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("span", opts);
  };
  htmlProto.addClass = function (this: HTMLElement, cls: string) {
    this.classList.add(cls);
  };
  htmlProto.toggleClass = function (this: HTMLElement, cls: string, force?: boolean) {
    this.classList.toggle(cls, force);
  };
  htmlProto.hasClass = function (this: HTMLElement, cls: string): boolean {
    return this.classList.contains(cls);
  };
  htmlProto.setText = function (this: HTMLElement, text: string) {
    this.textContent = text;
  };
  htmlProto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  svgProto.addClass = function (this: SVGElement, cls: string) {
    this.classList.add(cls);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeDocument = document;
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockWeekSummaryLoad } = vi.hoisted(() => ({
  mockWeekSummaryLoad: vi.fn(),
}));

interface MomentObj {
  _d: Date;
  startOf(unit: string): MomentObj;
  endOf(unit: string): MomentObj;
  diff(other: MomentObj, unit: string): number;
  add(n: number, unit: string): MomentObj;
  isoWeek(): number;
  format(fmt?: string): string;
  isSameOrAfter(other: MomentObj, unit: string): boolean;
  isSameOrBefore(other: MomentObj, unit: string): boolean;
  isAfter(other: MomentObj, unit: string): boolean;
}

function makeMomentObj(d: Date): MomentObj {
  const self: MomentObj = {
    _d: new Date(d),
    startOf(unit) {
      if (unit === "isoWeek") {
        const day = self._d.getDay();
        const diffToMonday = (day + 6) % 7;
        self._d = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate() - diffToMonday);
      }
      if (unit === "day") {
        self._d = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate());
      }
      return self;
    },
    /** `daysLabel`, behind the rows' date badges, counts days between two of these. */
    diff(other, unit) {
      if (unit === "days") return Math.round((self._d.getTime() - other._d.getTime()) / 86_400_000);
      return 0;
    },
    endOf(unit) {
      if (unit === "isoWeek") {
        self.startOf("isoWeek");
        self._d = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate() + 6);
      }
      return self;
    },
    add(n, unit) {
      if (unit === "weeks") self._d = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate() + n * 7);
      if (unit === "days") self._d = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate() + n);
      return self;
    },
    isoWeek: () => 27,
    format: (fmt) => fmt ?? self._d.toISOString().slice(0, 10),
    isSameOrAfter(other, unit) {
      if (unit === "day") return self._d.getTime() >= other._d.getTime();
      return false;
    },
    isSameOrBefore(other, unit) {
      if (unit === "day") return self._d.getTime() <= other._d.getTime();
      return false;
    },
    isAfter(other, unit) {
      if (unit === "day") return self._d.getTime() > other._d.getTime();
      return false;
    },
  };
  return self;
}

function mockMoment(...args: unknown[]) {
  if (args.length === 0) return makeMomentObj(new Date(TODAY));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arg = args[0] as any;
  if (arg?._d instanceof Date) return makeMomentObj(arg._d);
  if (args.length >= 2 && args[1] === "YYYY-MM-DD") {
    const [y, m, d] = (arg as string).split("-").map(Number);
    return makeMomentObj(new Date(y, m - 1, d));
  }
  return makeMomentObj(new Date(arg as string));
}

const TODAY = "2026-07-01"; // Wednesday
const TODAY_DATE = day(TODAY);
/** The same day as an instant, for the timestamp fields — see `timestampDay`. */
const TODAY_AT = timestamp(`${TODAY}T10:00:00.000Z`);

vi.mock("obsidian", () => ({
  setIcon: () => {},
  moment: mockMoment,
  // MoveTargetModal, reached transitively via BaseTabView's context menu.
  Modal: class { open() {} close() {} },
  Notice: class {},
  Component: class {},
  MarkdownRenderer: {
    render: vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
      const p = document.createElement("p");
      p.textContent = markdown;
      el.appendChild(p);
    }),
  },
}));

vi.mock("./task-creator", async (importOriginal) => ({
  // Spread the original so value exports (enums the callers branch on)
  // survive the mock; only the behaviours below are replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  openNoteFile: vi.fn(),
  TaskModal: class {},
  ConfirmModal: class {},
  patchTaskField: vi.fn(),
  deleteTaskFile: vi.fn(),
  openDropdown: vi.fn(),
}));

// base-tab-view.ts imports task-graph-view.ts, which imports dashboard-view.ts (for
// DASHBOARD_VIEW_TYPE) — breaking that chain avoids a require cycle with BaseTabView.
vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

vi.mock("../model/daily/week-summary", () => ({
  WeekSummary: { load: mockWeekSummaryLoad },
}));

import { WeekSummaryView } from "./week-summary-view";
import { openNoteFile } from "./task-creator";
import { type Project } from "../model/project/project";
import { Task, type TaskFields } from "../model/project/task";
import { day, timestamp } from "../model/__testing__/dates";

function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
  return new Task({
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  });
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return { title: "A project", filePath: `projects/${overrides.id}.md`, tasks: [], ...overrides };
}

function makeDay(overrides: Partial<{
  hasNote: boolean;
  isFuture: boolean;
  filePath: string;
  habitsDone: number;
  habitsTotal: number;
  taskCounts: { closedOnTime: number; closedLate: number; open: number; total: number };
}> = {}) {
  return {
    dateStr: "2026-06-29",
    dayIndex: 0,
    filePath: "2026-06-29.md",
    hasNote: true,
    isFuture: false,
    tasks: [],
    taskCounts: { closedOnTime: 0, closedLate: 0, open: 0, total: 0 },
    habitsDone: 0,
    habitsTotal: 0,
    ...overrides,
  };
}

function makeWeekData(overrides: Partial<{ days: ReturnType<typeof makeDay>[]; habits: unknown[] }> = {}) {
  return {
    days: overrides.days ?? Array.from({ length: 7 }, () => makeDay()),
    habits: overrides.habits ?? [],
  };
}

function makeView() {
  const plugin = {
    settings: {
      dashboardCollapsed: {} as Record<string, boolean>,
      dailyHabitsTag: "daily",
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = Object.create(WeekSummaryView.prototype) as any;
  view.app = {};
  view.plugin = plugin;
  view.allTasks = [];
  view.openNoteKeys = new Set<string>();
  view.onRefresh = vi.fn();
  view.weekOffset = 0;
  return view;
}

const CONFIG = { folder: "", format: "YYYY-MM-DD", template: "" };

async function renderView(view: ReturnType<typeof makeView>, tasks: Task[] = [], projects: Project[] = []) {
  const content = document.createElement("div");
  await view.render(content, tasks, projects, CONFIG);
  return content;
}

beforeEach(() => {
  // The view reads the real clock for "this week", so pin it to the fixture's day.
  vi.useFakeTimers();
  vi.setSystemTime(TODAY_DATE);
  vi.clearAllMocks();
  mockWeekSummaryLoad.mockResolvedValue(makeWeekData());
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Week navigation
// ---------------------------------------------------------------------------

describe("WeekSummaryView construction", () => {
  it("initializes weekOffset to 0 via the class field initializer", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = new WeekSummaryView({} as any, { settings: { dashboardCollapsed: {} } } as any, () => {});
    expect(view.weekOffset).toBe(0);
  });
});

describe("week navigation", () => {
  it("shows the current ISO week number and date range", async () => {
    const view = makeView();
    const content = await renderView(view);
    expect(content.querySelector(".pm-dash-week-number")?.textContent).toBe("Week 27");
    expect(content.querySelector(".pm-dash-week-range")).not.toBeNull();
  });

  it("omits the 'This week' button when already on the current week", async () => {
    const view = makeView();
    const content = await renderView(view);
    expect(content.querySelector(".pm-dash-today-btn")).toBeNull();
  });

  it("shows the 'This week' button when on a different week, and it resets weekOffset", async () => {
    const view = makeView();
    view.weekOffset = -2;
    const content = await renderView(view);
    const btn = content.querySelector(".pm-dash-today-btn") as HTMLElement;
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.weekOffset).toBe(0);
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("moves to the previous/next week via the nav buttons", async () => {
    const view = makeView();
    const content = await renderView(view);
    const [prevBtn, nextBtn] = content.querySelectorAll(".pm-dash-nav-btn");
    prevBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.weekOffset).toBe(-1);
    nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.weekOffset).toBe(0);
    expect(view.onRefresh).toHaveBeenCalledTimes(2);
  });

  it("passes the current weekOffset-adjusted week start to WeekSummary.load", async () => {
    const view = makeView();
    view.weekOffset = 1;
    await renderView(view);
    expect(mockWeekSummaryLoad).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Habits by task
// ---------------------------------------------------------------------------

describe("habits by task", () => {
  it("shows an empty-state message when there are no habits", async () => {
    const view = makeView();
    const content = await renderView(view);
    expect(content.textContent).toContain("No #daily checklist items found this week");
  });

  it("renders a row per habit with its completion count", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      habits: [{ key: "Meditate", completionCount: 3, presenceCount: 5, checkedDays: [0, 2, 4] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    const row = content.querySelector(".pm-dash-item-row")!;
    expect(row.textContent).toContain("Meditate");
    expect(row.textContent).toContain("3/5");
  });

  it("marks a never-completed habit with the '--never' class", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      habits: [{ key: "Journal", completionCount: 0, presenceCount: 4, checkedDays: [] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    expect(content.querySelector(".pm-dash-item-text--never")).not.toBeNull();
  });

  it("does not show the day-chevron toggle when there are no checked days", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      habits: [{ key: "Journal", completionCount: 0, presenceCount: 4, checkedDays: [] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    expect(content.querySelector(".pm-dash-item-chevron")).toBeNull();
  });

  it("shows day chips and toggles the open state on row click when there are checked days", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      habits: [{ key: "Meditate", completionCount: 2, presenceCount: 5, checkedDays: [0, 3] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    const chips = content.querySelectorAll(".pm-dash-item-day-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe("Mon");
    expect(chips[1].textContent).toBe("Thu");

    const wrap = content.querySelector(".pm-dash-item-wrap") as HTMLElement;
    const row = wrap.querySelector(".pm-dash-item-row") as HTMLElement;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(wrap.classList.contains("pm-dash-item-wrap--open")).toBe(true);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(wrap.classList.contains("pm-dash-item-wrap--open")).toBe(false);
  });

  it("opens the day's note when a day chip is clicked, without toggling the row", async () => {
    vi.mocked(openNoteFile).mockClear();
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, (_, i) => makeDay({ filePath: `day-${i}.md` })),
      habits: [{ key: "Meditate", completionCount: 1, presenceCount: 5, checkedDays: [2] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    const chip = content.querySelector(".pm-dash-item-day-chip") as HTMLElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(view.app, "day-2.md");
    const wrap = content.querySelector(".pm-dash-item-wrap") as HTMLElement;
    expect(wrap.classList.contains("pm-dash-item-wrap--open")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Habits by day (daily progress circles)
// ---------------------------------------------------------------------------

describe("habits by day", () => {
  it("renders 7 day circles labeled Mon..Sun", async () => {
    const view = makeView();
    const content = await renderView(view);
    const labels = content.querySelectorAll(".pm-dash-circles-row")[0].querySelectorAll(".pm-dash-circle-day");
    expect(Array.from(labels).map((l) => l.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("shows a dash label and dims the circle for a day with no note", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: false })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.classList.contains("pm-dash-day-circle--clickable")).toBe(false);
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a dash label for a day with a note but no habits", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: true, habitsTotal: 0 })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a done/total label and a clickable circle for a day with habits", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: true, habitsDone: 2, habitsTotal: 3 })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.classList.contains("pm-dash-day-circle--clickable")).toBe(true);
    expect(wrap.querySelector("text")?.textContent).toBe("2/3");
  });

  it("opens the day's note when a clickable circle is clicked", async () => {
    vi.mocked(openNoteFile).mockClear();
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, (_, i) => makeDay({ hasNote: true, filePath: `day-${i}.md` })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[0].querySelectorAll(".pm-dash-day-circle")[3] as HTMLElement;
    wrap.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(view.app, "day-3.md");
  });
});

// ---------------------------------------------------------------------------
// Small tasks (tri-color circles)
// ---------------------------------------------------------------------------

describe("small tasks", () => {
  it("shows a dash label for a day with no note", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: false })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a dash label for a day with a note but no tasks", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: true, taskCounts: { closedOnTime: 0, closedLate: 0, open: 0, total: 0 } })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a done/total label for a day with tasks", async () => {
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: true, taskCounts: { closedOnTime: 2, closedLate: 1, open: 1, total: 4 } })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("3/4");
  });

  it("opens the day's note when a clickable small-tasks circle is clicked", async () => {
    vi.mocked(openNoteFile).mockClear();
    mockWeekSummaryLoad.mockResolvedValue(makeWeekData({
      days: Array.from({ length: 7 }, (_, i) => makeDay({ hasNote: true, filePath: `day-${i}.md` })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelectorAll(".pm-dash-day-circle")[5] as HTMLElement;
    wrap.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(view.app, "day-5.md");
  });

  it("renders the closed/late/open legend", async () => {
    const view = makeView();
    const content = await renderView(view);
    const legendLabels = content.querySelectorAll(".pm-dash-daily-legend-label");
    expect(Array.from(legendLabels).map((l) => l.textContent)).toEqual(["Closed", "Late", "Open"]);
  });
});

// ---------------------------------------------------------------------------
// Week Stats (expandable stat rows)
// ---------------------------------------------------------------------------

describe("week stats", () => {
  it("renders the four stat rows with counts", async () => {
    const completed = makeTask({ id: "c1", status: "done", completed: TODAY_AT });
    const created = makeTask({ id: "n1", createdAt: TODAY_AT });
    const inProgress = makeTask({ id: "p1", status: "in-progress" });
    const blocked = makeTask({ id: "b1", status: "blocked" });
    const view = makeView();
    const content = await renderView(view, [completed, created, inProgress, blocked]);
    const numbers = content.querySelectorAll(".pm-dash-stat-number");
    expect(numbers).toHaveLength(4);
  });

  it("excludes done/cancelled tasks from in-progress/blocked stat rows", async () => {
    const doneTask = makeTask({ id: "d1", status: "done" });
    const view = makeView();
    const content = await renderView(view, [doneTask]);
    const labels = content.querySelectorAll(".pm-dash-stat-label");
    const numbers = content.querySelectorAll(".pm-dash-stat-number");
    const blockedIdx = Array.from(labels).findIndex((l) => l.textContent === "Blocked");
    expect(numbers[blockedIdx].textContent).toBe("0");
  });

  it("toggles the expand-list open state on row-header click", async () => {
    const view = makeView();
    const content = await renderView(view);
    const statRow = content.querySelector(".pm-dash-stat-row") as HTMLElement;
    const header = statRow.querySelector(".pm-dash-stat-row-header") as HTMLElement;
    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(statRow.classList.contains("pm-dash-stat-row--open")).toBe(true);
    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(statRow.classList.contains("pm-dash-stat-row--open")).toBe(false);
  });

  it("renders the task list inside the expand list for a non-empty stat", async () => {
    const completed = makeTask({ id: "c1", status: "done", completed: TODAY_AT, title: "Ship the feature" });
    const project = makeProject({ id: "proj-1", title: "Alpha" });
    const view = makeView();
    const content = await renderView(view, [completed], [project]);
    const expandList = content.querySelector(".pm-dash-expand-list")!;
    expect(expandList.textContent).toContain("Ship the feature");
  });

  it("shows the empty-state message inside the expand list for an empty stat", async () => {
    const view = makeView();
    const content = await renderView(view);
    const expandList = content.querySelector(".pm-dash-expand-list")!;
    expect(expandList.textContent).toContain("No tasks");
  });
});
