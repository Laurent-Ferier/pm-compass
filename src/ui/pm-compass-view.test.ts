// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;

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
  htmlProto.removeClass = function (this: HTMLElement, cls: string) {
    this.classList.remove(cls);
  };
  htmlProto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
  // Obsidian's own `isShown` is `!!offsetParent`, which jsdom can't answer — it has no
  // layout. Standing in with a walk for a `display: none` self or ancestor keeps the
  // distinction the gate depends on: a view hidden by something above it reads as hidden.
  htmlProto.isShown = function (this: HTMLElement) {
    for (let el: HTMLElement | null = this; el; el = el.parentElement) {
      if (el.style.display === "none") return false;
    }
    return true;
  };
  htmlProto.scrollIntoView = vi.fn();
  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CSS = { escape: (s: string) => s };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeDocument = document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).createDiv = (opts?: CreateElOpts) => {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
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
  mockReadDailyNotesConfig,
  mockResolveInboxPath,
  mockResolveInboxSortDir,
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
    allTasks: unknown[] = [];
    dashboardDate = { format: () => "2026-07-01" };
    render = vi.fn();
    loadAdjacentUnclosed = vi.fn().mockResolvedValue([]);
    constructor(app: unknown, plugin: unknown, onRefresh: () => void) {
      this.app = app; this.plugin = plugin; this.onRefresh = onRefresh;
    }
  }
  class MockInboxView {
    app: unknown;
    plugin: unknown;
    onRefresh: () => void;
    allTasks: unknown[] = [];
    render = vi.fn().mockResolvedValue(undefined);
    constructor(app: unknown, plugin: unknown, onRefresh: () => void) {
      this.app = app; this.plugin = plugin; this.onRefresh = onRefresh;
    }
  }
  class MockWeekSummaryView {
    app: unknown;
    plugin: unknown;
    onRefresh: () => void;
    allTasks: unknown[] = [];
    render = vi.fn().mockResolvedValue(undefined);
    constructor(app: unknown, plugin: unknown, onRefresh: () => void) {
      this.app = app; this.plugin = plugin; this.onRefresh = onRefresh;
    }
  }
  return {
    MockItemView,
    MockDashboardView,
    MockInboxView,
    MockWeekSummaryView,
    mockBackfill: vi.fn().mockResolvedValue({ filesChanged: 0, filesCreated: 0 }),
    mockReadDailyNotesConfig: vi.fn().mockResolvedValue({ folder: "", format: "YYYY-MM-DD", template: "" }),
    mockResolveInboxPath: vi.fn().mockReturnValue("Inbox.md"),
    mockResolveInboxSortDir: vi.fn().mockReturnValue("desc"),
    mockLoadDayChecklist: vi.fn().mockResolvedValue({ items: [], filePath: "2026-07-01.md" }),
    mockLoadVaultData: vi.fn().mockResolvedValue({ tasks: [], projects: [] }),
    mockReadInboxItems: vi.fn().mockResolvedValue([]),
    mockMigrateInboxTargets: vi.fn().mockResolvedValue(0),
  };
});

const { MockTFile, MockTAbstractFile } = vi.hoisted(() => ({
  MockTFile: class { path = ""; },
  MockTAbstractFile: class { path = ""; },
}));

vi.mock("obsidian", () => ({
  ItemView: MockItemView,
  TFile: MockTFile,
  TAbstractFile: MockTAbstractFile,
  WorkspaceLeaf: class {},
  Platform: { isMobile: false },
  setIcon: () => {},
}));

vi.mock("./dashboard-view", () => ({
  DASHBOARD_VIEW_TYPE: "pm-compass-dashboard",
  DashboardView: MockDashboardView,
}));
vi.mock("./inbox-view", () => ({ InboxView: MockInboxView }));
vi.mock("./week-summary-view", () => ({ WeekSummaryView: MockWeekSummaryView }));

vi.mock("../model/vault-reader", () => ({ loadVaultData: mockLoadVaultData }));
vi.mock("../model/day-markdown-file", () => ({ readDailyNotesConfig: mockReadDailyNotesConfig }));
vi.mock("../model/day-task-actions", () => ({
  resolveInboxPath: mockResolveInboxPath,
  migrateInboxTargets: mockMigrateInboxTargets,
  readInboxItems: mockReadInboxItems,
  loadDayChecklist: mockLoadDayChecklist,
  resolveInboxSortDir: mockResolveInboxSortDir,
}));
vi.mock("../model/recurring-task-backfill", () => ({ backfillRecurringHabits: mockBackfill }));

import { PMCompassView } from "./pm-compass-view";
import { DayTask } from "../model/day-task";

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

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    manifest: { id: "pm-compass" },
    settings: {
      projectsFolder: "Projects",
      inboxFilePath: "",
      inboxStaleAfterDays: 7,
      ...overrides,
    },
  };
}

function makeView(app = makeApp(), plugin = makePlugin()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leaf = { app } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = new PMCompassView(leaf, plugin as any);
  return { view, app, plugin };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBackfill.mockResolvedValue({ filesChanged: 0, filesCreated: 0 });
  mockReadDailyNotesConfig.mockResolvedValue({ folder: "", format: "YYYY-MM-DD", template: "" });
  mockResolveInboxPath.mockReturnValue("Inbox.md");
  mockLoadDayChecklist.mockResolvedValue({ items: [], filePath: "2026-07-01.md" });
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
    expect(view.getIcon()).toBe("layout-dashboard");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).activeTab = "inbox";
    await view.render();
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it("migrates due inbox target dates before reading the lists", async () => {
    const { view } = makeView();
    await view.render();
    expect(mockMigrateInboxTargets.mock.calls[0].slice(0, 2)).toEqual([view.app, "Inbox.md"]);
    expect(mockMigrateInboxTargets.mock.invocationCallOrder[0])
      .toBeLessThan(mockReadInboxItems.mock.invocationCallOrder[0]);
  });

  it("migrates target dates on the inbox tab too, where the backfill is skipped", async () => {
    const { view } = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).activeTab = "inbox";
    await view.render();
    expect(mockMigrateInboxTargets).toHaveBeenCalledOnce();
  });

  it("renders the dashboard view by default", async () => {
    const { view } = makeView();
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).toHaveBeenCalledOnce();
  });

  // Which day each falls under is `placePlanned`'s call; this only has to hand them over.
  it("hands the dashboard the inbox items aimed at a day", async () => {
    const planned = DayTask.parse("- [ ] Buy milk ⏳ 2026-07-01", 0)!;
    const elsewhere = DayTask.parse("- [ ] Call bank ⏳ 2026-07-09", 0)!;
    const unplanned = DayTask.parse("- [ ] Tidy up", 0)!;
    mockReadInboxItems.mockResolvedValue([planned, elsewhere, unplanned]);
    const { view } = makeView();
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plannedArg = (view as any).dashboardView.render.mock.calls[0][7] as DayTask[];
    expect(plannedArg.map((t) => t.title)).toEqual(["Buy milk", "Call bank"]);
    // Stamped with the file it is still written in, which is what the row's actions target.
    expect(plannedArg[0].filePath).toBe("Inbox.md");
  });

  it("renders the week summary view on the stats tab", async () => {
    const { view } = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).activeTab = "stats";
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).weekSummaryView.render).toHaveBeenCalledOnce();
  });

  it("renders the inbox view on the inbox tab", async () => {
    const { view } = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).activeTab = "inbox";
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).inboxView.render).toHaveBeenCalledOnce();
  });

  it("propagates allTasks to every sub-view", async () => {
    mockLoadVaultData.mockResolvedValue({ tasks: [{ id: "t1" }], projects: [] });
    const { view } = makeView();
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.allTasks).toEqual([{ id: "t1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).weekSummaryView.allTasks).toEqual([{ id: "t1" }]);
    // The inbox needs it too: promoting an item offers its tasks as parents.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).inboxView.allTasks).toEqual([{ id: "t1" }]);
  });

  it("passes the project list to the inbox, so promote can offer destinations", async () => {
    const projects = [{ id: "p1", title: "Alpha" }];
    mockLoadVaultData.mockResolvedValue({ tasks: [], projects });
    const { view } = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).activeTab = "inbox";
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (view as any).inboxView.render.mock.calls[0];
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).activeTab).toBe("inbox");
  });

  it("does not re-render when clicking the already-active tab", async () => {
    const { view } = makeView();
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).dashboardView.render.mockClear();
    const dashBtn = Array.from(view.contentEl.querySelectorAll(".pm-dash-tab")).find((b) => b.textContent?.includes("Dashboard")) as HTMLElement;
    dashBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).not.toHaveBeenCalled();
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
      DayTask.parse(`- [ ] Buy milk ➕ ${created} ⏳ 2026-07-01`, 0)!,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (app as any).setting;
    const { view } = makeView(app);
    await view.render();
    const settingsBtn = view.contentEl.querySelector(".pm-dash-settings-btn") as HTMLElement;
    expect(() => settingsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
  });

  it("does nothing when the inbox input was focused but the re-render doesn't recreate one", async () => {
    const { view } = makeView(makeApp(), makePlugin());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).activeTab = "inbox";
    await view.render();
    const input = view.contentEl.createEl("input", { cls: "pm-add-input" }) as HTMLInputElement;
    view.contentEl.querySelector(".pm-dash-content")!.appendChild(input);
    input.focus();
    Object.defineProperty(document, "activeElement", { value: input, configurable: true });
    await expect(view.render()).resolves.toBeUndefined();
  });

  it("refocuses the inbox input after re-render when it was focused before", async () => {
    const { view } = makeView(makeApp(), makePlugin());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).activeTab = "inbox";
    await view.render();
    const input = view.contentEl.createEl("input", { cls: "pm-add-input" }) as HTMLInputElement;
    view.contentEl.querySelector(".pm-dash-content")!.appendChild(input);
    input.focus();
    Object.defineProperty(document, "activeElement", { value: input, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).inboxView.render.mockImplementation(async (content: HTMLElement) => {
      const newInput = content.createEl("input", { cls: "pm-add-input" }) as HTMLInputElement;
      newInput.focus = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (content as any)._newInput = newInput;
    });
    await view.render();
    const rebuilt = view.contentEl.querySelector(".pm-add-input") as HTMLInputElement;
    expect(rebuilt.focus).toHaveBeenCalled();
  });

  it("replays a render requested while one was in flight, rather than dropping it", async () => {
    const { view } = makeView();
    const p1 = view.render();
    const p2 = view.render();
    await Promise.all([p1, p2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).toHaveBeenCalledTimes(2);
  });

  it("collapses several requests made during one in-flight render into a single replay", async () => {
    const { view } = makeView();
    await Promise.all([view.render(), view.render(), view.render(), view.render()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).toHaveBeenCalledTimes(2);
  });

  it("drops the replay when the view is closed mid-render", async () => {
    const { view } = makeView();
    const p1 = view.render();
    const p2 = view.render();
    await view.onClose();
    await Promise.all([p1, p2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).toHaveBeenCalledOnce();
  });

  it("leaves no replay behind when a render fails", async () => {
    const { view } = makeView();
    mockLoadVaultData.mockRejectedValueOnce(new Error("vault read failed"));
    const failing = view.render();
    void view.render();
    await expect(failing).rejects.toThrow("vault read failed");

    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).toHaveBeenCalledOnce();
  });

  it("syncs container height on mobile", async () => {
    const obsidian = await import("obsidian");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obsidian as any).Platform.isMobile = true;
    const { view } = makeView();
    await view.render();
    const container = view.contentEl.querySelector(".pm-dash-container") as HTMLElement;
    expect(container).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obsidian as any).Platform.isMobile = false;
  });
});

// ---------------------------------------------------------------------------
// onOpen() — event registration
// ---------------------------------------------------------------------------

describe("PMCompassView.onOpen", () => {
  it("schedules a refresh when a watched daily note is modified", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).watchedDailyPaths = new Set(["2026-07-01.md"]);
    app.vault._emit("modify", { path: "2026-07-01.md" });
    vi.advanceTimersByTime(2000);
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not schedule a refresh for an unwatched file modification", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.vault._emit("modify", { path: "unwatched.md" });
    vi.advanceTimersByTime(2000);
    expect(renderSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("schedules a refresh when a watched daily note is created", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).watchedDailyPaths = new Set(["2026-07-01.md"]);
    app.vault._emit("create", { path: "2026-07-01.md" });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("refreshes on delete within the projects folder", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.vault._emit("delete", { path: "Projects/x.md" });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not refresh on delete outside the projects folder", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.vault._emit("delete", { path: "Elsewhere/x.md" });
    vi.advanceTimersByTime(500);
    expect(renderSpy).not.toHaveBeenCalled();
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

  it("refreshes on a metadata change for a non-task file inside the projects folder", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    app.metadataCache.getFileCache.mockReturnValue({ frontmatter: { "pm-task": false } });
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("refreshes for a task already marked completed, without touching frontmatter", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    app.metadataCache.getFileCache.mockReturnValue({ frontmatter: { "pm-task": true, status: "done", completed: "2026-01-01T00:00:00.000Z" } });
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    vi.advanceTimersByTime(500);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalled();
    vi.useRealTimers();
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

  it("does not rebuild the contents while the view is hidden", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    view.containerEl.style.display = "none";
    app.vault._emit("delete", { path: "Projects/x.md" });
    vi.advanceTimersByTime(2000);
    expect(renderSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rebuilds once when the view is shown again after changes it missed", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    view.containerEl.style.display = "none";
    app.vault._emit("delete", { path: "Projects/x.md" });
    app.vault._emit("delete", { path: "Projects/y.md" });
    vi.advanceTimersByTime(2000);

    view.containerEl.style.display = "";
    app.workspace._emit("active-leaf-change");
    expect(renderSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("treats a collapsed sidebar hiding an ancestor as hidden, and rebuilds when it expands", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    const sidedock = document.createElement("div");
    sidedock.appendChild(view.containerEl);
    sidedock.style.display = "none";
    app.vault._emit("delete", { path: "Projects/x.md" });
    vi.advanceTimersByTime(2000);
    expect(renderSpy).not.toHaveBeenCalled();

    sidedock.style.display = "";
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
    const { view, app } = makeView();
    await view.onOpen();
    const renderSpy = vi.spyOn(view, "render").mockResolvedValue(undefined);
    app.vault._emit("delete", { path: "Projects/x.md" });
    view.containerEl.style.display = "none";
    vi.advanceTimersByTime(2000);
    expect(renderSpy).not.toHaveBeenCalled();

    view.containerEl.style.display = "";
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obsidian as any).Platform.isMobile = false;
  });

  async function makeMobileView() {
    const obsidian = await import("obsidian");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obsidian as any).Platform.isMobile = true;
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
    const { view, app } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).watchedDailyPaths = new Set(["2026-07-01.md"]);
    app.vault._emit("modify", { path: "2026-07-01.md" }); // schedules a refresh timer, doesn't fire yet
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (view as any).syncContainerHeight()).not.toThrow();
  });

  describe("syncContainerHeight() pinning", () => {
    /** `.view-content`'s whole bottom padding with the keyboard down. Raising the keyboard
     *  swaps the padding for `--keyboard-height` rather than adding to it. */
    const SAFE_AREA = 48;
    const KEYBOARD = 359;

    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).visualViewport;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).visualViewport = hasVisualViewport
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sync = () => (view as any).syncContainerHeight();
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).scheduleRefresh();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).scheduleRefresh();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("watches only the resolved inbox path when the daily note doesn't exist yet", async () => {
    mockLoadDayChecklist.mockResolvedValue({ items: [], filePath: null });
    const { view } = makeView();
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).watchedDailyPaths.has(null)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).watchedDailyPaths.has("Inbox.md")).toBe(true);
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
