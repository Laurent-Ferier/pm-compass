// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, type Mock } from "vitest";
import { Icon } from "./icons";
import { bagOf } from "./__testing__/dom-bag";
import type { WorkspaceLeaf } from "obsidian";
import type PMCompassPlugin from "../main";

/** Stands in for `display: none`: jsdom has no layout, so what hides an element in these
 *  tests is a class the `isShown` stub below reads. */
const HIDDEN = "pm-test-hidden";
const hide = (el: HTMLElement) => el.classList.add(HIDDEN);
const show = (el: HTMLElement) => el.classList.remove(HIDDEN);

function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);

  type CreateElOpts = { cls?: string; text?: string; attr?: Record<string, string> };

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
  htmlProto.removeClass = function (this: HTMLElement, cls: string) {
    this.classList.remove(cls);
  };
  htmlProto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
  // Obsidian's own `isShown` is `!!offsetParent`, which jsdom can't answer — it has no
  // layout. Standing in with a walk for a `display: none` self or ancestor keeps the
  // distinction the gate depends on: a view hidden by something above it reads as hidden.
  const shown = (el: HTMLElement | null): boolean =>
    !el || (!el.classList.contains(HIDDEN) && shown(el.parentElement));
  htmlProto.isShown = function (this: HTMLElement) {
    return shown(this);
  };
  htmlProto.scrollIntoView = vi.fn();
  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };

  bagOf(window).CSS = { escape: (s: string) => s };
  bagOf(window).activeDocument = document;
  bagOf(window).createDiv = (opts?: CreateElOpts) => {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    return el;
  };
}

// jsdom has no ResizeObserver. Recording the instances lets a test fire one, which is how a
// view regaining a size — a sidebar being expanded — reaches its refresh gate.
const resizeObservers: { fire: () => void; observed: unknown[] }[] = [];
function installResizeObserverStub() {
  bagOf(window).ResizeObserver = class {
    private readonly entry: { fire: () => void; observed: unknown[] };
    constructor(cb: () => void) {
      this.entry = { fire: cb, observed: [] };
      resizeObservers.push(this.entry);
    }
    observe(el: unknown) {
      this.entry.observed.push(el);
    }
    disconnect() {}
  };
}
/** Fires the most recently created observer, i.e. the one belonging to the view under test. */
function fireResize() {
  resizeObservers.at(-1)?.fire();
}

beforeAll(() => {
  installObsidianDOMPolyfills();
  installResizeObserverStub();
});

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  MockItemView,
  MockDashboardView,
  MockInboxView,
  MockWeekSummaryView,
  mockBackfill,
  mockDailyNotesConfig,
  mockResolveInboxPath,
  mockLoadDayChecklist,
  mockLoadVaultData,
  mockReadInboxItems,
  mockMigrateInboxTargets,
} = vi.hoisted(() => {
  class MockItemView {
    app: unknown;
    contentEl: HTMLElement;
    containerEl: HTMLElement;
    constructor(leaf: { app: unknown }) {
      this.app = leaf.app;
      this.contentEl = document.createElement("div");
      this.containerEl = document.createElement("div");
    }
    registerEvent() {}
    register() {}
    registerDomEvent() {}
  }
  class MockDashboardView {
    app: unknown;
    plugin: unknown;
    onRefresh: () => void;
    showDay: (date: Date) => void;
    allTasks: unknown[] = [];
    dashboardDate = { format: () => "2026-07-01" };
    render = vi.fn();
    dispose = vi.fn();
    setDate = vi.fn();
    loadAdjacentUnclosed = vi.fn().mockResolvedValue([]);
    fillAdjacentDays = vi.fn().mockResolvedValue(undefined);
    stopFill = vi.fn();
    constructor(app: unknown, plugin: unknown, onRefresh: () => void, showDay: (d: Date) => void) {
      this.app = app; this.plugin = plugin; this.onRefresh = onRefresh; this.showDay = showDay;
    }
  }
  class MockInboxView {
    app: unknown;
    plugin: unknown;
    onRefresh: () => void;
    showDay: (date: Date) => void;
    allTasks: unknown[] = [];
    render = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    constructor(app: unknown, plugin: unknown, onRefresh: () => void, showDay: (d: Date) => void) {
      this.app = app; this.plugin = plugin; this.onRefresh = onRefresh; this.showDay = showDay;
    }
  }
  class MockWeekSummaryView {
    app: unknown;
    plugin: unknown;
    onRefresh: () => void;
    showDay: (date: Date) => void;
    allTasks: unknown[] = [];
    render = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    constructor(app: unknown, plugin: unknown, onRefresh: () => void, showDay: (d: Date) => void) {
      this.app = app; this.plugin = plugin; this.onRefresh = onRefresh; this.showDay = showDay;
    }
  }
  return {
    MockItemView,
    MockDashboardView,
    MockInboxView,
    MockWeekSummaryView,
    mockBackfill: vi.fn().mockResolvedValue({ filesChanged: 0, filesCreated: 0 }),
    mockDailyNotesConfig: vi.fn().mockReturnValue({ folder: "", format: "YYYY-MM-DD", template: "" }),
    mockResolveInboxPath: vi.fn().mockReturnValue("Inbox.md"),
    mockLoadDayChecklist: vi.fn().mockResolvedValue({ items: [], path: "2026-07-01.md", exists: true, date: null, lines: [] }),
    mockLoadVaultData: vi.fn().mockResolvedValue({ tasks: [], projects: [] }),
    mockReadInboxItems: vi.fn().mockResolvedValue([]),
    mockMigrateInboxTargets: vi.fn().mockResolvedValue(0),
  };
});

const { MockTFile, MockTAbstractFile } = vi.hoisted(() => ({
  MockTFile: class { path = ""; },
  MockTAbstractFile: class { path = ""; },
}));

vi.mock("obsidian", async () => ({
  ItemView: MockItemView,
  TFile: MockTFile,
  TAbstractFile: MockTAbstractFile,
  WorkspaceLeaf: class {},
  Platform: { isMobile: false },
  normalizePath: (p: string) => p,
  setIcon: () => {},
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../model/__testing__/day-moment")).dayMoment,
}));

vi.mock("./dashboard-view", () => ({
  DASHBOARD_VIEW_TYPE: "pm-compass-dashboard",
  DashboardView: MockDashboardView,
}));
vi.mock("./inbox-view", () => ({ InboxView: MockInboxView }));
vi.mock("./week-summary-view", () => ({ WeekSummaryView: MockWeekSummaryView }));

vi.mock("../model/daily/day-task-actions", async (importOriginal) => ({
  // Spread the original so value exports (enums the callers branch on)
  // survive the mock; only the behaviour below is replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  migrateInboxTargets: mockMigrateInboxTargets,
}));
vi.mock("../model/daily/recurring-task-backfill", () => ({ backfillRecurringHabits: mockBackfill }));

import { CompassTab, PMCompassView } from "./pm-compass-view";
import { StoreEvent, type StoreEvents } from "../model/store/store-events";
import { TypedEmitter } from "../model/store/store-events";
import type { DailyNotesConfig } from "../model/daily/week-summary";
import { asApp } from "../model/__testing__/as-app";
import { notesOf } from "../model/__testing__/notes";
import { day } from "../model/__testing__/dates";
import { Task } from "../model/daily/task";

function makeApp() {
  const eventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    metadataCache: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (eventHandlers[`metadataCache.${event}`] ??= []).push(cb);
        return { event };
      }),
      getFileCache: vi.fn().mockReturnValue(null),
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of eventHandlers[`metadataCache.${event}`] ?? []) cb(...args);
      },
    },
    vault: {
      // Resolves every `.md` path to a file, as a vault the change events came from would.
      // The frontmatter behind it is `metadataCache.getFileCache`'s to say.
      getAbstractFileByPath: vi.fn((path: string) => {
        if (!path.endsWith(".md")) return null;
        const file = new MockTFile();
        file.path = path;
        return file;
      }),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (eventHandlers[`vault.${event}`] ??= []).push(cb);
        return { event };
      }),
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of eventHandlers[`vault.${event}`] ?? []) cb(...args);
      },
    },
    fileManager: {
      processFrontMatter: vi.fn(async (_file: unknown, cb: (fm: Record<string, unknown>) => void) => {
        cb({ status: "done" });
      }),
    },
    workspace: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (eventHandlers[`workspace.${event}`] ??= []).push(cb);
        return { event };
      }),
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of eventHandlers[`workspace.${event}`] ?? []) cb(...args);
      },
    },
    setting: { open: vi.fn(), openTabById: vi.fn() },
  };
}

/** Stands in for both halves the view reads — `VaultData` and its `TaskStore` — so a test
 *  needn't know which owns a call. Reads come from `mockLoadVaultData`, and `_changed`
 *  fires the event the real one emits once it has re-read a note. */
function makeStore() {
  const emitter = new TypedEmitter<StoreEvents>();
  const on = <K extends StoreEvent>(event: K, handler: (p: StoreEvents[K]) => void) =>
    emitter.on(event, handler);
  return {
    load: mockLoadVaultData,
    // The project store is what the view hears the folder's changes from.
    projectNotes: { on },
    day: mockLoadDayChecklist,
    inbox: mockReadInboxItems,
    migrateInboxTargets: mockMigrateInboxTargets,
    // The inbox whole — its own lines and the project tasks nothing dates. The lines are
    // what these tests are about, so the second half is empty.
    inboxModel: () => Promise.resolve({ undated: { tasks: [], effectiveValues: new Map() } }),
    get dailyNotesConfig(): DailyNotesConfig { return mockDailyNotesConfig() as DailyNotesConfig; },
    get inboxPath(): string { return mockResolveInboxPath() as string; },
    on,
    _changed: (...paths: string[]) => emitter.emit(StoreEvent.ProjectsChanged, { paths }),
    _daysChanged: (...paths: string[]) => emitter.emit(StoreEvent.DaysChanged, { paths }),
    _inboxChanged: () => emitter.emit(StoreEvent.InboxChanged, { path: mockResolveInboxPath() as string }),
  };
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  const store = makeStore();
  return {
    manifest: { id: "pm-compass" },
    tasks: store,
    vault: store,
    // The checklist sync itself is the plugin's, and tested there and in the model;
    // what the view owes it is a call per render and a call per change event.
    ensureListingsVerified: vi.fn().mockResolvedValue(undefined),
    syncChangedNote: vi.fn().mockResolvedValue(undefined),
    settings: {
      projectsFolder: "Projects",
      inboxFilePath: "",
      inboxStaleAfterDays: 7,
      ...overrides,
    },
  };
}

interface TabViewStub {
  render: Mock<(...args: never[]) => Promise<void>>;
  allTasks: unknown[];
  /** The two callbacks the view hands every tab, captured so a test can fire them. */
  onRefresh: () => void;
  showDay: (date: Date) => void;
}

/** The mocked Platform, whose `isMobile` these tests flip. */
const platformOf = (obsidian: unknown) => (obsidian as { Platform: { isMobile: boolean } }).Platform;

/** The view's own members, named rather than reached for through `any`: the tab it is on,
 *  the three tab views it owns, the day notes it watches, and the two passes the tests
 *  drive by hand. */
interface ViewInternals {
  activeTab: string;
  watchedDailyPaths: Set<string>;
  dashboardView: TabViewStub & {
    setDate: Mock<(d: Date) => void>;
    loadAdjacentUnclosed: Mock<(...args: never[]) => Promise<unknown[]>>;
    fillAdjacentDays: Mock<(...args: never[]) => Promise<void>>;
    stopFill: Mock<() => void>;
  };
  inboxView: TabViewStub;
  weekSummaryView: TabViewStub;
  syncContainerHeight(): void;
  scheduleRefresh(): void;
}
const internals = (view: PMCompassView) => view as unknown as ViewInternals;

function makeView(app = makeApp(), plugin = makePlugin()) {
  const leaf = { app } as unknown as WorkspaceLeaf;
  // The stamping really reads and writes a note, so its store is bound to this app.
  Object.assign(plugin.tasks, { taskNotes: notesOf(asApp(app)).taskNotes });
  const view = new PMCompassView(leaf, plugin as unknown as PMCompassPlugin);
  return { view, app, plugin };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBackfill.mockResolvedValue({ filesChanged: 0, filesCreated: 0 });
  mockDailyNotesConfig.mockReturnValue({ folder: "", format: "YYYY-MM-DD", template: "" });
  mockResolveInboxPath.mockReturnValue("Inbox.md");
  mockLoadDayChecklist.mockResolvedValue({ items: [], path: "2026-07-01.md", exists: true, date: null, lines: [] });
  mockLoadVaultData.mockResolvedValue({ tasks: [], projects: [] });
  mockReadInboxItems.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Basic view metadata
// ---------------------------------------------------------------------------

describe("PMCompassView metadata", () => {
  it("reports the dashboard view type/display text/icon", () => {
    const { view } = makeView();
    expect(view.getViewType()).toBe("pm-compass-dashboard");
    expect(view.getDisplayText()).toBe("PM Compass dashboard");
    expect(view.getIcon()).toBe(Icon.DashboardTab);
  });
});

// ---------------------------------------------------------------------------
// render()
// ---------------------------------------------------------------------------

describe("PMCompassView.render", () => {
  it("backfills recurring habits before loading data on the tasks tab", async () => {
    const { view } = makeView();
    await view.render();
    expect(mockBackfill).toHaveBeenCalledOnce();
  });

  it("skips the backfill on the inbox tab", async () => {
    const { view } = makeView();
    internals(view).activeTab = "inbox";
    await view.render();
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it("migrates due inbox target dates before reading the lists", async () => {
    const { view } = makeView();
    await view.render();
    expect(mockMigrateInboxTargets).toHaveBeenCalled();
    expect(mockMigrateInboxTargets.mock.invocationCallOrder[0])
      .toBeLessThan(mockReadInboxItems.mock.invocationCallOrder[0]);
  });

  it("migrates target dates on the inbox tab too, where the backfill is skipped", async () => {
    const { view } = makeView();
    internals(view).activeTab = "inbox";
    await view.render();
    expect(mockMigrateInboxTargets).toHaveBeenCalledOnce();
  });

  it("renders the dashboard view by default", async () => {
    const { view } = makeView();
    await view.render();
    expect(internals(view).dashboardView.render).toHaveBeenCalledOnce();
  });

  // Which day each falls under is `placePlanned`'s call; this only has to hand them over.
  it("hands the dashboard the inbox items aimed at a day", async () => {
    const planned = Task.parse("- [ ] Buy milk ⏳ 2026-07-01", 0)!;
    const elsewhere = Task.parse("- [ ] Call bank ⏳ 2026-07-09", 0)!;
    const unplanned = Task.parse("- [ ] Tidy up", 0)!;
    mockReadInboxItems.mockResolvedValue([planned, elsewhere, unplanned]);
    const { view } = makeView();
    await view.render();
    const plannedArg = internals(view).dashboardView.render.mock.calls[0][6] as Task[];
    expect(plannedArg.map((t) => t.title)).toEqual(["Buy milk", "Call bank"]);
    // Stamped with the file it is still written in, which is what the row's actions target.
    expect(plannedArg[0].filePath).toBe("Inbox.md");
  });

  it("renders the week summary view on the stats tab", async () => {
    const { view } = makeView();
    internals(view).activeTab = "stats";
    await view.render();
    expect(internals(view).weekSummaryView.render).toHaveBeenCalledOnce();
  });

  it("renders the inbox view on the inbox tab", async () => {
    const { view } = makeView();
    internals(view).activeTab = "inbox";
    await view.render();
    expect(internals(view).inboxView.render).toHaveBeenCalledOnce();
  });

  it("propagates allTasks to every sub-view", async () => {
    mockLoadVaultData.mockResolvedValue({ tasks: [{ id: "t1" }], projects: [] });
    const { view } = makeView();
    await view.render();
    expect(internals(view).dashboardView.allTasks).toEqual([{ id: "t1" }]);
    expect(internals(view).weekSummaryView.allTasks).toEqual([{ id: "t1" }]);
    // The inbox needs it too: promoting an item offers its tasks as parents.
    expect(internals(view).inboxView.allTasks).toEqual([{ id: "t1" }]);
  });

  it("keeps an archived project's tasks out of the dashboard and the inbox", async () => {
    const projects = [{ id: "p1", title: "Alpha" }, { id: "p2", title: "Old", archived: true }];
    const tasks = [{ id: "t1", projectId: "p1" }, { id: "t2", projectId: "p2" }];
    mockLoadVaultData.mockResolvedValue({ tasks, projects });
    const { view } = makeView();
    await view.render();
    expect(internals(view).dashboardView.allTasks).toEqual([tasks[0]]);
    expect(internals(view).inboxView.allTasks).toEqual([tasks[0]]);
    const args = internals(view).dashboardView.render.mock.calls[0];
    expect(args[3]).toEqual([tasks[0]]);
    expect(args[4]).toEqual([projects[0]]);
  });

  it("still reports an archived project's tasks in the week summary", async () => {
    const projects = [{ id: "p2", title: "Old", archived: true }];
    const tasks = [{ id: "t2", projectId: "p2" }];
    mockLoadVaultData.mockResolvedValue({ tasks, projects });
    const { view } = makeView();
    internals(view).activeTab = "stats";
    await view.render();
    expect(internals(view).weekSummaryView.allTasks).toEqual(tasks);
    const args = internals(view).weekSummaryView.render.mock.calls[0];
    expect(args[1]).toEqual(tasks);
    expect(args[2]).toEqual(projects);
  });

  // The one list behind both the promote destinations and the project filter.
  it("leaves an archived project out of the inbox's project list", async () => {
    const projects = [{ id: "p1", title: "Alpha" }, { id: "p2", title: "Old", archived: true }];
    mockLoadVaultData.mockResolvedValue({ tasks: [], projects });
    const { view } = makeView();
    internals(view).activeTab = "inbox";
    await view.render();
    expect(internals(view).inboxView.render.mock.calls[0][4]).toEqual([projects[0]]);
  });

  it("passes the project list to the inbox, so promote can offer destinations", async () => {
    const projects = [{ id: "p1", title: "Alpha" }];
    mockLoadVaultData.mockResolvedValue({ tasks: [], projects });
    const { view } = makeView();
    internals(view).activeTab = "inbox";
    await view.render();
    const args = internals(view).inboxView.render.mock.calls[0];
    expect(args[4]).toEqual(projects);
  });

  it("marks the active tab button", async () => {
    const { view } = makeView();
    await view.render();
    const activeBtn = view.contentEl.querySelector(".pm-dash-tab--active");
    expect(activeBtn?.textContent).toBe("Dashboard");
  });

  it("switches tabs and re-renders on tab click", async () => {
    const { view } = makeView();
    await view.render();
    const inboxBtn = Array.from(view.contentEl.querySelectorAll(".pm-dash-tab")).find((b) => b.textContent?.includes("Inbox")) as HTMLElement;
    inboxBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(internals(view).activeTab).toBe("inbox");
  });

  it("does not re-render when clicking the already-active tab", async () => {
    const { view } = makeView();
    await view.render();
    internals(view).dashboardView.render.mockClear();
    const dashBtn = Array.from(view.contentEl.querySelectorAll(".pm-dash-tab")).find((b) => b.textContent?.includes("Dashboard")) as HTMLElement;
    dashBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(internals(view).dashboardView.render).not.toHaveBeenCalled();
  });

  it("shows a stale-inbox warning badge when items are older than the configured threshold", async () => {
    const oldDate = new Date(Date.now() - 10 * 86_400_000);
    mockReadInboxItems.mockResolvedValue([{ createdAt: oldDate }]);
    const { view } = makeView();
    await view.render();
    expect(view.contentEl.querySelector(".pm-inbox-warn-badge")).not.toBeNull();
  });

  it("does not warn about an old item that is planned for a day", async () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    const y = old.getFullYear(), m = String(old.getMonth() + 1).padStart(2, "0");
    const created = `${y}-${m}-${String(old.getDate()).padStart(2, "0")}`;
    mockReadInboxItems.mockResolvedValue([
      Task.parse(`- [ ] Buy milk ➕ ${created} ⏳ 2026-07-01`, 0)!,
    ]);
    const { view } = makeView();
    await view.render();
    expect(view.contentEl.querySelector(".pm-inbox-warn-badge")).toBeNull();
  });

  it("does not warn when inbox items are within the threshold", async () => {
    const recentDate = new Date();
    mockReadInboxItems.mockResolvedValue([{ createdAt: recentDate }]);
    const { view } = makeView();
    await view.render();
    expect(view.contentEl.querySelector(".pm-inbox-warn-badge")).toBeNull();
  });

  it("ignores inbox items with no createdAt when checking staleness", async () => {
    mockReadInboxItems.mockResolvedValue([{ createdAt: null }]);
    const { view } = makeView();
    await view.render();
    expect(view.contentEl.querySelector(".pm-inbox-warn-badge")).toBeNull();
  });

  it("does not warn when the stale-after-days setting is 0 (disabled)", async () => {
    const oldDate = new Date(Date.now() - 30 * 86_400_000);
    mockReadInboxItems.mockResolvedValue([{ createdAt: oldDate }]);
    const { view } = makeView(makeApp(), makePlugin({ inboxStaleAfterDays: 0 }));
    await view.render();
    expect(view.contentEl.querySelector(".pm-inbox-warn-badge")).toBeNull();
  });

  it("defaults the stale-after-days threshold to 7 when unset", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    mockReadInboxItems.mockResolvedValue([{ createdAt: eightDaysAgo }]);
    const { view } = makeView(makeApp(), makePlugin({ inboxStaleAfterDays: undefined }));
    await view.render();
    expect(view.contentEl.querySelector(".pm-inbox-warn-badge")).not.toBeNull();
  });

  it("refreshes on refresh-button click", async () => {
    const { view } = makeView();
    await view.render();
    const renderSpy = vi.spyOn(view, "render");
    const refreshBtn = view.contentEl.querySelector(".pm-dash-refresh-btn") as HTMLElement;
    refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(renderSpy).toHaveBeenCalledOnce();
  });

  it("opens plugin settings on settings-button click", async () => {
    const { view, app } = makeView();
    await view.render();
    const settingsBtn = view.contentEl.querySelector(".pm-dash-settings-btn") as HTMLElement;
    settingsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(app.setting.open).toHaveBeenCalled();
    expect(app.setting.openTabById).toHaveBeenCalledWith("pm-compass");
  });

  it("does not throw when app.setting is unavailable", async () => {
    const app = makeApp();
    delete bagOf(app).setting;
    const { view } = makeView(app);
    await view.render();
    const settingsBtn = view.contentEl.querySelector(".pm-dash-settings-btn") as HTMLElement;
    expect(() => settingsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
  });

  it("does nothing when the inbox input was focused but the re-render doesn't recreate one", async () => {
    const { view } = makeView(makeApp(), makePlugin());
    internals(view).activeTab = "inbox";
    await view.render();
    const input = view.contentEl.createEl("input", { cls: "pm-add-input" });
    view.contentEl.querySelector(".pm-dash-content")!.appendChild(input);
    input.focus();
    Object.defineProperty(document, "activeElement", { value: input, configurable: true });
    await expect(view.render()).resolves.toBeUndefined();
  });

  it("refocuses the inbox input after re-render when it was focused before", async () => {
    const { view } = makeView(makeApp(), makePlugin());
    internals(view).activeTab = "inbox";
    await view.render();
    const input = view.contentEl.createEl("input", { cls: "pm-add-input" });
    view.contentEl.querySelector(".pm-dash-content")!.appendChild(input);
    input.focus();
    Object.defineProperty(document, "activeElement", { value: input, configurable: true });
    const focus = vi.fn();
    internals(view).inboxView.render.mockImplementation(async (content: HTMLElement) => {
      const newInput = content.createEl("input", { cls: "pm-add-input" });
      newInput.focus = focus;
      bagOf(content)._newInput = newInput;
    });
    await view.render();
    expect(view.contentEl.querySelector(".pm-add-input")).not.toBeNull();
    expect(focus).toHaveBeenCalled();
  });

  it("replays a render requested while one was in flight, rather than dropping it", async () => {
    const { view } = makeView();
    const p1 = view.render();
    const p2 = view.render();
    await Promise.all([p1, p2]);
    expect(internals(view).dashboardView.render).toHaveBeenCalledTimes(2);
  });

  it("collapses several requests made during one in-flight render into a single replay", async () => {
    const { view } = makeView();
    await Promise.all([view.render(), view.render(), view.render(), view.render()]);
    expect(internals(view).dashboardView.render).toHaveBeenCalledTimes(2);
  });

  it("drops the replay when the view is closed mid-render", async () => {
    const { view } = makeView();
    const p1 = view.render();
    const p2 = view.render();
    await view.onClose();
    await Promise.all([p1, p2]);
    expect(internals(view).dashboardView.render).toHaveBeenCalledOnce();
  });

  it("draws nothing at all once the view is closed", async () => {
    const { view } = makeView();
    await view.onOpen();
    await view.onClose();
    view.contentEl.empty();
    const dashboard = internals(view).dashboardView.render;
    dashboard.mockClear();

    await view.render();

    // A caller the close couldn't reach has nothing to draw into.
    expect(view.contentEl.children.length).toBe(0);
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("discards the tree it built when the view closes during its vault reads", async () => {
    const { view } = makeView();
    await view.onOpen();
    view.contentEl.empty();
    // Closes while the reads are in flight, so the guard at the top let this render in.
    mockLoadVaultData.mockImplementationOnce(async () => {
      await view.onClose();
      return { projects: [], tasks: [] };
    });

    await view.render();

    expect(view.contentEl.children.length).toBe(0);
  });

  it("leaves no replay behind when a render fails", async () => {
    const { view } = makeView();
    mockLoadVaultData.mockRejectedValueOnce(new Error("vault read failed"));
    const failing = view.render();
    void view.render();
    await expect(failing).rejects.toThrow("vault read failed");

    await view.render();
    expect(internals(view).dashboardView.render).toHaveBeenCalledOnce();
  });

  it("syncs container height on mobile", async () => {
    const obsidian = await import("obsidian");
    platformOf(obsidian).isMobile = true;
    const { view } = makeView();
    await view.render();
    const container = view.contentEl.querySelector(".pm-dash-container") as HTMLElement;
    expect(container).not.toBeNull();
    platformOf(obsidian).isMobile = false;
  });
});

// ---------------------------------------------------------------------------
// Loading the dashboard's tasks in the background
// ---------------------------------------------------------------------------

describe("PMCompassView — filling the dashboard's horizons", () => {
  const merged = (overrides: Record<string, unknown> = {}) =>
    makePlugin({ mergeDailyAndProjectTasks: true, ...overrides });

  it("paints first, then asks the dashboard to fill", async () => {
    const { view } = makeView(makeApp(), merged());
    await view.render();
    const dash = internals(view).dashboardView;
    expect(dash.fillAdjacentDays).toHaveBeenCalledOnce();
    expect(dash.render.mock.invocationCallOrder[0])
      .toBeLessThan(dash.fillAdjacentDays.mock.invocationCallOrder[0]);
  });

  it("fills whether or not the horizons are merged — the dashboard decides", async () => {
    const { view } = makeView(makeApp(), merged({ mergeDailyAndProjectTasks: false }));
    await view.render();
    expect(internals(view).dashboardView.fillAdjacentDays).toHaveBeenCalledOnce();
  });

  it("asks for no fill from a tab that has no horizons", async () => {
    const { view } = makeView(makeApp(), merged());
    internals(view).activeTab = CompassTab.WeekSummary;
    await view.render();
    expect(internals(view).dashboardView.fillAdjacentDays).not.toHaveBeenCalled();
  });

  it("stops a fill still running whichever tab the next render draws", async () => {
    const { view } = makeView(makeApp(), merged());
    internals(view).activeTab = CompassTab.WeekSummary;
    await view.render();
    expect(internals(view).dashboardView.stopFill).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onOpen() — event registration
// ---------------------------------------------------------------------------

describe("PMCompassView.onOpen", () => {
  it("redraws on a longer debounce when the store says a day note changed", async () => {
    // Longer, because that is the note a user types into with the dashboard beside it,
    // and rebuilding mid-keystroke moves the rows under them.
    vi.useFakeTimers();
    const { view, plugin } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    plugin.tasks._daysChanged("2026-07-01.md");
    vi.advanceTimersByTime(500);
    expect(renderSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("redraws when the store says the inbox changed", async () => {
    vi.useFakeTimers();
    const { view, plugin } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    plugin.tasks._inboxChanged();
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("redraws once the store says a project note changed", async () => {
    vi.useFakeTimers();
    const { view, plugin } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    plugin.tasks._changed("Projects/x.md");
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores a metadata change outside the projects folder, without inspecting frontmatter", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.metadataCache._emit("changed", { path: "Elsewhere/x.md" });
    vi.advanceTimersByTime(500);
    expect(app.metadataCache.getFileCache).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("leaves a task already marked completed's frontmatter alone", async () => {
    const { view, app } = makeView();
    app.metadataCache.getFileCache.mockReturnValue({ frontmatter: { "pm-task": true, status: "done", completed: "2026-01-01T00:00:00.000Z" } });
    await view.onOpen();
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it("backfills a missing completed timestamp for a task externally marked done, without an immediate refresh", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    app.metadataCache.getFileCache.mockReturnValue({ frontmatter: { "pm-task": true, status: "done" } });
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    expect(app.fileManager.processFrontMatter).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    // The direct handler doesn't call scheduleRefresh itself (the processFrontMatter write
    // fires its own subsequent "changed" event in real Obsidian) — our stub doesn't emit that,
    // so render() should not have been scheduled from this path alone.
    expect(renderSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("has the listings checked before it subscribes to the changes it reads as edits", async () => {
    const projects = [{ id: "p1", filePath: "Projects/Alpha.md" }];
    const tasks = [{ id: "t1", filePath: "Projects/Alpha_tasks/t1.md" }];
    mockLoadVaultData.mockResolvedValue({ projects, tasks });
    const { view, app, plugin } = makeView();

    await view.onOpen();

    expect(plugin.ensureListingsVerified).toHaveBeenCalledWith(projects, tasks);
    // The pass has to predate the handler, or the first tick lands on a listing
    // nobody has checked and answers itself.
    const passOrder = plugin.ensureListingsVerified.mock.invocationCallOrder[0];
    const subscribeOrder = vi.mocked(app.metadataCache.on).mock.invocationCallOrder[0];
    expect(passOrder).toBeLessThan(subscribeOrder);
  });

  it("hands the sync the content the change event carried, rather than re-reading it", async () => {
    const { view, app, plugin } = makeView();
    app.metadataCache.getFileCache.mockReturnValue({ frontmatter: { "pm-project": true } });
    await view.onOpen();

    app.metadataCache._emit("changed", { path: "Projects/Alpha.md" }, "---\nid: x\n---\n## Tasks\n");

    await vi.waitFor(() => expect(plugin.syncChangedNote).toHaveBeenCalledWith(
      "Projects/Alpha.md", "---\nid: x\n---\n## Tasks\n",
    ));
    // The change also asked the gate for a refresh, on a real timer this test doesn't wait
    // out. Cancelled here rather than left to fire into a torn-down environment: the view
    // is never closed otherwise, so nothing in the source can guard against it.
    await view.onClose();
  });

  it("syncs the checklists after the backfill write, not instead of it", async () => {
    const { view, app, plugin } = makeView();
    app.metadataCache.getFileCache.mockReturnValue({ frontmatter: { "pm-task": true, status: "done" } });
    await view.onOpen();
    plugin.syncChangedNote.mockClear();

    app.metadataCache._emit("changed", { path: "Projects/x.md" }, "body");

    // The backfill's early return used to skip the sync entirely.
    await vi.waitFor(() =>
      expect(plugin.syncChangedNote).toHaveBeenCalledWith("Projects/x.md", "body"));
    await view.onClose();
  });

  it("leaves a note outside the projects folder unsynced", async () => {
    const { view, app, plugin } = makeView();
    await view.onOpen();
    plugin.syncChangedNote.mockClear();

    app.metadataCache._emit("changed", { path: "Elsewhere/x.md" }, "body");

    expect(plugin.syncChangedNote).not.toHaveBeenCalled();
  });

  it("does not rebuild the contents while the view is hidden", async () => {
    vi.useFakeTimers();
    const { view, plugin } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    hide(view.containerEl);
    plugin.tasks._changed("Projects/x.md");
    vi.advanceTimersByTime(2000);
    expect(renderSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rebuilds once when the view is shown again after changes it missed", async () => {
    vi.useFakeTimers();
    const { view, app, plugin } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    hide(view.containerEl);
    plugin.tasks._changed("Projects/x.md");
    plugin.tasks._changed("Projects/y.md");
    vi.advanceTimersByTime(2000);

    show(view.containerEl);
    app.workspace._emit("active-leaf-change");
    expect(renderSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("treats a collapsed sidebar hiding an ancestor as hidden, and rebuilds when it expands", async () => {
    vi.useFakeTimers();
    const { view, plugin } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    const sidedock = document.createElement("div");
    sidedock.appendChild(view.containerEl);
    hide(sidedock);
    plugin.tasks._changed("Projects/x.md");
    vi.advanceTimersByTime(2000);
    expect(renderSpy).not.toHaveBeenCalled();

    show(sidedock);
    fireResize();
    expect(renderSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not rebuild on a resize when nothing changed while hidden", async () => {
    const { view } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    fireResize();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("skips a refresh whose debounce is still running when the view gets hidden", async () => {
    vi.useFakeTimers();
    const { view, app, plugin } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    plugin.tasks._changed("Projects/x.md");
    hide(view.containerEl);
    vi.advanceTimersByTime(2000);
    expect(renderSpy).not.toHaveBeenCalled();

    show(view.containerEl);
    app.workspace._emit("active-leaf-change");
    expect(renderSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not backfill when the completed field is already set inside processFrontMatter's callback", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    app.metadataCache.getFileCache.mockReturnValue({ frontmatter: { "pm-task": true, status: "done" } });
    app.fileManager.processFrontMatter.mockImplementation(async (_file: unknown, cb: (fm: Record<string, unknown>) => void) => {
      cb({ status: "done", completed: "2026-01-01T00:00:00.000Z" });
    });
    await view.onOpen();
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Mobile on-screen-keyboard handling
// ---------------------------------------------------------------------------

describe("PMCompassView mobile viewport handling", () => {
  afterEach(async () => {
    const obsidian = await import("obsidian");
    platformOf(obsidian).isMobile = false;
  });

  async function makeMobileView() {
    const obsidian = await import("obsidian");
    platformOf(obsidian).isMobile = true;
    return makeView();
  }

  it("watches the element it measures, which is the only thing the keyboard resizes", async () => {
    const { view } = await makeMobileView();
    await view.onOpen();
    // Not `containerEl`: its header makes it the wrong size, and `visualViewport` never fires.
    expect(resizeObservers.at(-1)?.observed).toEqual([view.contentEl]);
  });

  it("does not watch for resizes on desktop", async () => {
    const { view } = makeView();
    const before = resizeObservers.length;
    await view.onOpen();
    // Only the refresh gate's own observer, no keyboard one on top of it.
    expect(resizeObservers.length).toBe(before + 1);
  });

  it("debounces the resizes, clearing any previous pending timer", async () => {
    vi.useFakeTimers();
    const { view } = await makeMobileView();
    await view.onOpen();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    fireResize();
    fireResize();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    vi.useRealTimers();
  });

  it("clears a pending keyboard-resize timer on close", async () => {
    vi.useFakeTimers();
    const { view } = await makeMobileView();
    await view.onOpen();
    fireResize(); // schedules the 50ms debounce timer, doesn't fire yet
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    await view.onClose();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores a resize that lands after close, when the observer is still connected", async () => {
    vi.useFakeTimers();
    const { view } = await makeMobileView();
    await view.onOpen();
    await view.onClose();
    // Disconnecting happens on unload, a step after `onClose`, so this can still arrive — and
    // the timer it would schedule has nothing left to clear it.
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    fireResize();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("leaves the container alone on a desktop resize — the height is CSS's business", async () => {
    vi.useFakeTimers();
    const { view } = makeView(); // desktop: Platform.isMobile is false
    await view.onOpen();
    const syncSpy = vi.spyOn(internals(view), "syncContainerHeight");

    resizeObservers.find((o) => o.observed.includes(view.containerEl))!.fire();
    vi.advanceTimersByTime(50);

    expect(syncSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("syncs the container when the view comes back on screen on mobile", async () => {
    // The gate's own observer, not the keyboard one: a drawer swiped open fires no
    // workspace event, so this is the only signal that the view has a size again.
    vi.useFakeTimers();
    const { view } = await makeMobileView();
    await view.onOpen();
    const syncSpy = vi.spyOn(internals(view), "syncContainerHeight");

    resizeObservers.find((o) => o.observed.includes(view.containerEl))!.fire();
    vi.advanceTimersByTime(50);

    expect(syncSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does nothing on close when no resize was ever seen", async () => {
    const { view } = makeView();
    await view.onOpen();
    await expect(view.onClose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onClose()
// ---------------------------------------------------------------------------

describe("PMCompassView.onClose", () => {
  it("clears a pending refresh timer", async () => {
    vi.useFakeTimers();
    const { view, plugin } = makeView();
    await view.onOpen();
    plugin.tasks._daysChanged("2026-07-01.md"); // schedules a refresh timer, doesn't fire yet
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    await view.onClose();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does nothing extra when no timers are pending", async () => {
    const { view } = makeView();
    await expect(view.onClose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncContainerHeight() / scheduleRefresh() internals
// ---------------------------------------------------------------------------

describe("PMCompassView internals", () => {
  it("syncContainerHeight() does nothing before the container has been rendered", () => {
    const { view } = makeView();
    expect(() => internals(view).syncContainerHeight()).not.toThrow();
  });

  describe("syncContainerHeight() pinning", () => {
    /** `.view-content`'s whole bottom padding with the keyboard down. Raising the keyboard
     *  swaps the padding for `--keyboard-height` rather than adding to it. */
    const SAFE_AREA = 48;
    const KEYBOARD = 359;

    afterEach(() => {
      delete bagOf(window).visualViewport;
    });

    /** jsdom lays nothing out, so the whole geometry the pin is derived from is stubbed. The
     *  defaults are a phone with the keyboard down, measured over the WebView debugger. */
    function setup({
      top = 85, height = 738, padTop = 12, padBottom = SAFE_AREA, keyboard = 0,
      visibleBottom = 823, hasVisualViewport = true,
    }: {
      top?: number; height?: number; padTop?: number; padBottom?: number; keyboard?: number;
      /** What the visual viewport reports as the bottom of the uncovered space. */
      visibleBottom?: number;
      hasVisualViewport?: boolean;
    } = {}) {
      const { view } = makeView();
      const parent = view.contentEl;
      const container = parent.createDiv({ cls: "pm-dash-container" });
      const layout = { top, height };
      vi.spyOn(parent, "clientHeight", "get").mockImplementation(() => layout.height);
      parent.getBoundingClientRect = () =>
        ({ top: layout.top, bottom: layout.top + layout.height, height: layout.height }) as DOMRect;
      bagOf(window).visualViewport = hasVisualViewport
        ? { height: visibleBottom, offsetTop: 0 }
        : undefined;
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(visibleBottom);
      // Only the keyboard variable is read off `document.body`, so one stub serves for it and
      // the parent both.
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        paddingTop: `${padTop}px`,
        paddingBottom: `${padBottom}px`,
        getPropertyValue: () => `${keyboard}px`,
      } as unknown as CSSStyleDeclaration);
      const sync = () => internals(view).syncContainerHeight();
      /** Relays out the parent the way the platform would, without re-stubbing. */
      const relayout = (next: Partial<typeof layout>) => Object.assign(layout, next);
      return { container, parent, sync, relayout };
    }

    it("pins the parent's content height once there is one to pin", () => {
      const { container, sync } = setup();
      sync();
      expect(container.style.flex).toBe("0 0 678px");
    });

    it("takes the keyboard out once when the platform shrinks the parent to make room", () => {
      // Android as measured: `.view-content` cut to 379px *and* padded by the keyboard, with
      // the viewport reporting the keyboard-down height. Subtracting the padding as it stands
      // would count the keyboard twice and pin 8px.
      const { container, sync } = setup({
        height: 738 - KEYBOARD, padBottom: KEYBOARD, keyboard: KEYBOARD,
      });
      sync();
      expect(container.style.flex).toBe("0 0 367px");
    });

    it("takes the keyboard out once when it only overlays the parent", () => {
      // The same keyboard reported the other way — full-height parent, shrinking viewport —
      // has to land on the same content height.
      const { container, sync } = setup({
        padBottom: KEYBOARD, keyboard: KEYBOARD, visibleBottom: 823 - KEYBOARD,
      });
      sync();
      expect(container.style.flex).toBe("0 0 367px");
    });

    it("takes the keyboard out once when the parent and the viewport both shrink for it", () => {
      // Not what the phone does — its viewport stays put — but reporting the keyboard through
      // every channel at once must still take it out only once.
      const { container, sync } = setup({
        height: 738 - KEYBOARD, padBottom: KEYBOARD, keyboard: KEYBOARD,
        visibleBottom: 823 - KEYBOARD,
      });
      sync();
      expect(container.style.flex).toBe("0 0 367px");
    });

    it("drops a scroll the WebView left on the parent to reveal the focused field", () => {
      // `.view-content` is `overflow: hidden`, so a scroll landing on it is one the user can
      // never undo — measured as 149px of the view out of reach.
      const { container, sync, parent } = setup();
      parent.scrollTop = 149;
      sync();
      expect(container.style.flex).toBe("0 0 678px");
      expect(parent.scrollTop).toBe(0);
    });

    it("falls back to the window when there is no visual viewport to measure", () => {
      const { container, sync } = setup({ hasVisualViewport: false });
      sync();
      expect(container.style.flex).toBe("0 0 678px");
    });

    it("hands the height back to the stylesheet rather than pinning a zero, which would blank the view", () => {
      const { container, sync } = setup({ top: 0, height: 0 });
      sync();
      expect(container.style.flex).toBe("");
    });

    it("releases a stale pin taken while the view had no size, instead of leaving it stuck", () => {
      const { container, sync, relayout } = setup();
      sync();
      expect(container.style.flex).toBe("0 0 678px");

      // The drawer closes: the parent measures nothing, and the old pin must not survive it.
      relayout({ top: 0, height: 0 });
      sync();
      expect(container.style.flex).toBe("");
    });

    it("keeps the pin when the keyboard leaves the parent shorter than its own padding", () => {
      const { container, sync, relayout } = setup();
      sync();
      expect(container.style.flex).toBe("0 0 678px");

      // Mid-transition the parent still measures something, but its padding swallows it.
      // Releasing the pin here is what leaves Android's flex recompute stuck at near-zero.
      relayout({ height: 15 });
      sync();
      expect(container.style.flex).toBe("0 0 678px");
    });
  });

  it("scheduleRefresh() clears its own previously-pending timer when called again", () => {
    vi.useFakeTimers();
    const { view } = makeView();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    internals(view).scheduleRefresh();
    internals(view).scheduleRefresh();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("hands the dashboard no note path for a day that has none", async () => {
    mockLoadDayChecklist.mockResolvedValue({ items: [], path: "2026-07-01.md", exists: false, date: null, lines: [] });
    const { view } = makeView();
    await view.render();
    expect(internals(view).dashboardView.render.mock.calls[0][2]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectTask()
// ---------------------------------------------------------------------------

describe("PMCompassView.selectTask", () => {
  it("returns false when no row matches the task id", () => {
    const { view } = makeView();
    expect(view.selectTask("missing")).toBe(false);
  });

  it("scrolls to, selects, and returns true for a matching row", () => {
    vi.useFakeTimers();
    const { view } = makeView();
    const row = document.createElement("div");
    row.dataset.taskId = "t1";
    Object.defineProperty(row, "offsetParent", { value: document.body, configurable: true });
    view.contentEl.appendChild(row);
    expect(view.selectTask("t1")).toBe(true);
    expect(row.classList.contains("pm-dash-task-row--selected")).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(row.classList.contains("pm-dash-task-row--selected")).toBe(false);
    vi.useRealTimers();
  });

  it("falls back to the first match when none are visible (offsetParent null)", () => {
    const { view } = makeView();
    const row = document.createElement("div");
    row.dataset.taskId = "t1";
    view.contentEl.appendChild(row);
    expect(view.selectTask("t1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Where a date on a row leads
// ---------------------------------------------------------------------------

describe("PMCompassView — showing a day", () => {
  it("puts the dashboard on the day and switches to it", async () => {
    const { view } = makeView();
    await view.render();
    internals(view).dashboardView.render.mockClear();

    internals(view).inboxView.showDay(day("2026-07-20"));
    await vi.waitFor(() => expect(internals(view).dashboardView.render).toHaveBeenCalled());

    expect(internals(view).dashboardView.setDate).toHaveBeenCalledWith(day("2026-07-20"));
    expect(internals(view).activeTab).toBe(CompassTab.Dashboard);
  });

  it("hands every tab the same route, so a date leads there from anywhere", () => {
    const { view } = makeView();
    const { dashboardView, inboxView, weekSummaryView } = internals(view);

    for (const tab of [dashboardView, inboxView, weekSummaryView]) {
      tab.showDay(day("2026-07-20"));
    }

    expect(dashboardView.setDate).toHaveBeenCalledTimes(3);
  });

  it("refreshes when a tab asks it to", () => {
    vi.useFakeTimers();
    const { view } = makeView();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);

    internals(view).weekSummaryView.onRefresh();
    vi.advanceTimersByTime(2000);

    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Keeping a changed note and its checklists in step
// ---------------------------------------------------------------------------

describe("PMCompassView — syncing a changed note's listings", () => {
  it("says so when the sync fails, rather than letting the rejection escape", async () => {
    const { view, app, plugin } = makeView();
    plugin.syncChangedNote.mockRejectedValueOnce(new Error("vault read failed"));
    await view.onOpen();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    app.metadataCache._emit("changed", { path: "Projects/x.md" }, "body");

    await vi.waitFor(() => expect(err).toHaveBeenCalledWith(
      "pm-compass: couldn't sync the checklist", expect.any(Error)));
    err.mockRestore();
    await view.onClose();
  });
});
