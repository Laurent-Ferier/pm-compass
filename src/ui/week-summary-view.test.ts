// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);
  const svgProto = bagOf(SVGElement.prototype);

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
    return this.createEl("div", opts);
  };
  htmlProto.createSpan = function (this: HTMLElement, opts?: CreateElOpts) {
    return this.createEl("span", opts);
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
  bagOf(window).activeDocument = document;
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockWeekSummaryFrom, mockCacheWeek } = vi.hoisted(() => ({
  mockWeekSummaryFrom: vi.fn(),
  mockCacheWeek: vi.fn().mockResolvedValue([]),
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
  // Either one of our own moment stubs (which carries `_d`) or a date string.
  const arg = args[0] as { _d?: Date } | string;
  if (typeof arg === "object" && arg._d instanceof Date) return makeMomentObj(arg._d);
  if (args.length >= 2 && args[1] === "YYYY-MM-DD") {
    const [y, m, d] = (arg as string).split("-").map(Number);
    return makeMomentObj(new Date(y, m - 1, d));
  }
  return makeMomentObj(new Date(arg as string));
}
// Sunday-first, as moment hands them over; the tab's day labels are the ISO rotation of these.
mockMoment.weekdaysShort = () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  Component: class { load() {} unload() {} },
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
  WeekSummary: { from: mockWeekSummaryFrom },
}));

import { Component } from "obsidian";
import { WeekSummaryView } from "./week-summary-view";
import { openNoteFile } from "./task-creator";
import { type Project, type ProjectFields } from "../model/project/project";
import { ProjectTask, type ProjectTaskFields } from "../model/project/project-task";
import { Priority, PRIORITY_COLORS } from "../model/base-task";
import { day, timestamp } from "../model/__testing__/dates";
import { addDays, startOfIsoWeek } from "../model/dates";
import { asApp } from "../model/__testing__/as-app";
import { bare } from "../model/__testing__/bare";
import { bagOf } from "./__testing__/dom-bag";
import type { App } from "obsidian";
import type PMCompassPlugin from "../main";
import { newProject, newTask } from "../model/__testing__/notes";

function makeTask(overrides: Partial<ProjectTaskFields> & { id: string }): ProjectTask {
  return newTask({
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  });
}

function makeProject(overrides: Partial<ProjectFields> & { id: string }): Project {
  return newProject({ title: "A project", filePath: `projects/${overrides.id}.md`, ...overrides });
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

/** The view's protected members, named rather than reached for through `any`. */
interface ViewInternals {
  app: App;
  plugin: {
    settings: { dashboardCollapsed: Record<string, boolean> };
    saveSettings: Mock<() => Promise<void>>;
  };
  onRefresh: Mock<() => void>;
}
const internals = (view: WeekSummaryView) => view as unknown as ViewInternals;

function makeView(): WeekSummaryView {
  const settings = { dashboardCollapsed: {} as Record<string, boolean> };
  const view = bare(WeekSummaryView);
  Object.assign(view, {
    app: {},
    plugin: { settings, saveSettings: vi.fn().mockResolvedValue(undefined), tasks: { week: mockCacheWeek, habitsTag: "daily" } },
    allTasks: [],
    openNoteKeys: new Set<string>(),
    // The per-pass markdown owner, a field initializer Object.create skips.
    renderHost: new Component(),
    onRefresh: vi.fn(),
    weekStart: startOfIsoWeek(TODAY_DATE),
  });
  return view;
}

async function renderView(view: ReturnType<typeof makeView>, tasks: ProjectTask[] = [], projects: Project[] = []) {
  const content = document.createElement("div");
  await view.render(content, tasks, projects);
  return content;
}

beforeEach(() => {
  // The view reads the real clock for "this week", so pin it to the fixture's day.
  vi.useFakeTimers();
  vi.setSystemTime(TODAY_DATE);
  vi.clearAllMocks();
  mockWeekSummaryFrom.mockReturnValue(makeWeekData());
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Week navigation
// ---------------------------------------------------------------------------

describe("WeekSummaryView construction", () => {
  it("starts on the current week via the class field initializer", () => {
    const view = new WeekSummaryView(
      asApp({}),
      { settings: { dashboardCollapsed: {} } } as unknown as PMCompassPlugin,
      () => {},
    );
    expect(view.weekStart).toEqual(startOfIsoWeek(TODAY_DATE));
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

  it("shows the 'This week' button when on a different week, and it comes back", async () => {
    const view = makeView();
    view.weekStart = addDays(startOfIsoWeek(TODAY_DATE), -14);
    const content = await renderView(view);
    const btn = content.querySelector(".pm-dash-today-btn") as HTMLElement;
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.weekStart).toEqual(startOfIsoWeek(TODAY_DATE));
    expect(internals(view).onRefresh).toHaveBeenCalled();
  });

  it("names its arrows for the period they step", async () => {
    const view = makeView();
    const content = await renderView(view);
    const labels = [...content.querySelectorAll(".pm-dash-nav-btn")]
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Previous week", "Next week"]);
  });

  it("moves to the previous/next week via the nav buttons", async () => {
    const view = makeView();
    const content = await renderView(view);
    const [prevBtn, nextBtn] = content.querySelectorAll(".pm-dash-nav-btn");
    prevBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.weekStart).toEqual(addDays(startOfIsoWeek(TODAY_DATE), -7));
    nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.weekStart).toEqual(startOfIsoWeek(TODAY_DATE));
    expect(internals(view).onRefresh).toHaveBeenCalledTimes(2);
  });

  it("reads the week it is on off the cache", async () => {
    const view = makeView();
    view.weekStart = addDays(startOfIsoWeek(TODAY_DATE), 7);
    await renderView(view);
    expect(mockCacheWeek).toHaveBeenCalledOnce();
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
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      habits: [{ key: "Meditate", completionCount: 3, presenceCount: 5, checkedDays: [0, 2, 4] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    const row = content.querySelector(".pm-dash-item-row")!;
    expect(row.textContent).toContain("Meditate");
    expect(row.textContent).toContain("3/5");
  });

  it("marks a never-completed habit with the '--never' class", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      habits: [{ key: "Journal", completionCount: 0, presenceCount: 4, checkedDays: [] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    expect(content.querySelector(".pm-dash-item-text--never")).not.toBeNull();
  });

  it("does not show the day-chevron toggle when there are no checked days", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      habits: [{ key: "Journal", completionCount: 0, presenceCount: 4, checkedDays: [] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    expect(content.querySelector(".pm-dash-item-chevron")).toBeNull();
  });

  it("shows day chips and toggles the open state on row click when there are checked days", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
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
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, (_, i) => makeDay({ filePath: `day-${i}.md` })),
      habits: [{ key: "Meditate", completionCount: 1, presenceCount: 5, checkedDays: [2] }],
    }));
    const view = makeView();
    const content = await renderView(view);
    const chip = content.querySelector(".pm-dash-item-day-chip") as HTMLElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(internals(view).app, "day-2.md");
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
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: false })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.classList.contains("pm-dash-day-circle--clickable")).toBe(false);
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a dash label for a day with a note but no habits", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: true, habitsTotal: 0 })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a done/total label and a clickable circle for a day with habits", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
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
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, (_, i) => makeDay({ hasNote: true, filePath: `day-${i}.md` })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[0].querySelectorAll(".pm-dash-day-circle")[3] as HTMLElement;
    wrap.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(internals(view).app, "day-3.md");
  });
});

// ---------------------------------------------------------------------------
// Small tasks (tri-color circles)
// ---------------------------------------------------------------------------

describe("small tasks", () => {
  it("shows a dash label for a day with no note", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: false })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a dash label for a day with a note but no tasks", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: true, taskCounts: { closedOnTime: 0, closedLate: 0, open: 0, total: 0 } })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("—");
  });

  it("shows a done/total label for a day with tasks", async () => {
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, () => makeDay({ hasNote: true, taskCounts: { closedOnTime: 2, closedLate: 1, open: 1, total: 4 } })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelector(".pm-dash-day-circle") as HTMLElement;
    expect(wrap.querySelector("text")?.textContent).toBe("3/4");
  });

  it("opens the day's note when a clickable small-tasks circle is clicked", async () => {
    vi.mocked(openNoteFile).mockClear();
    mockWeekSummaryFrom.mockReturnValue(makeWeekData({
      days: Array.from({ length: 7 }, (_, i) => makeDay({ hasNote: true, filePath: `day-${i}.md` })),
    }));
    const view = makeView();
    const content = await renderView(view);
    const wrap = content.querySelectorAll(".pm-dash-circles-row")[1].querySelectorAll(".pm-dash-day-circle")[5] as HTMLElement;
    wrap.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openNoteFile).toHaveBeenCalledWith(internals(view).app, "day-5.md");
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

  it("rolls the ribbon up over a completed row, its parent closed over it or not", async () => {
    const openParent = makeTask({ id: "p1", priority: Priority.High });
    const underOpen = makeTask({ id: "c1", parentId: "p1", status: "done", completed: TODAY_AT });
    const doneParent = makeTask({ id: "p2", status: "done", priority: Priority.Critical });
    const underDone = makeTask({ id: "c2", parentId: "p2", status: "done", completed: TODAY_AT });
    const view = makeView();
    const content = await renderView(view, [openParent, underOpen, doneParent, underDone]);
    const expandList = content.querySelector(".pm-dash-expand-list")!;
    const colors = [...expandList.querySelectorAll<HTMLElement>(".pm-task-ribbon")]
      .map((el) => el.style.getPropertyValue("--pm-ribbon-color"));
    expect(colors).toEqual([PRIORITY_COLORS[Priority.High], PRIORITY_COLORS[Priority.Critical]]);
  });

  it("shows the empty-state message inside the expand list for an empty stat", async () => {
    const view = makeView();
    const content = await renderView(view);
    const expandList = content.querySelector(".pm-dash-expand-list")!;
    expect(expandList.textContent).toContain("No tasks");
  });
});
