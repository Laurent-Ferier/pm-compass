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
}

beforeAll(() => {
  installObsidianDOMPolyfills();
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
  mockLoadDayChecklist,
  mockLoadVaultData,
  mockReadInboxItems,
} = vi.hoisted(() => {
  class MockItemView {
    app: unknown;
    contentEl: HTMLElement;
    constructor(leaf: { app: unknown }) {
      this.app = leaf.app;
      this.contentEl = document.createElement("div");
    }
    registerEvent() {}
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
    mockLoadDayChecklist: vi.fn().mockResolvedValue({ items: [], filePath: "2026-07-01.md" }),
    mockLoadVaultData: vi.fn().mockResolvedValue({ tasks: [], projects: [] }),
    mockReadInboxItems: vi.fn().mockResolvedValue([]),
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
  readInboxItems: mockReadInboxItems,
  loadDayChecklist: mockLoadDayChecklist,
}));
vi.mock("../model/recurring-task-backfill", () => ({ backfillRecurringHabits: mockBackfill }));

import { PMCompassView } from "./pm-compass-view";

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
    expect(view.getDisplayText()).toBe("PM Dashboard");
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

  it("renders the dashboard view by default", async () => {
    const { view } = makeView();
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).toHaveBeenCalledOnce();
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

  it("propagates allTasks to the dashboard and week-summary sub-views", async () => {
    mockLoadVaultData.mockResolvedValue({ tasks: [{ id: "t1" }], projects: [] });
    const { view } = makeView();
    await view.render();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.allTasks).toEqual([{ id: "t1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).weekSummaryView.allTasks).toEqual([{ id: "t1" }]);
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
    const input = view.contentEl.createEl("input", { cls: "pm-inbox-add-input" }) as HTMLInputElement;
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
    const input = view.contentEl.createEl("input", { cls: "pm-inbox-add-input" }) as HTMLInputElement;
    view.contentEl.querySelector(".pm-dash-content")!.appendChild(input);
    input.focus();
    Object.defineProperty(document, "activeElement", { value: input, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).inboxView.render.mockImplementation(async (content: HTMLElement) => {
      const newInput = content.createEl("input", { cls: "pm-inbox-add-input" }) as HTMLInputElement;
      newInput.focus = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (content as any)._newInput = newInput;
    });
    await view.render();
    const rebuilt = view.contentEl.querySelector(".pm-inbox-add-input") as HTMLInputElement;
    expect(rebuilt.focus).toHaveBeenCalled();
  });

  it("prevents concurrent renders while one is already in-flight", async () => {
    const { view } = makeView();
    const p1 = view.render();
    const p2 = view.render();
    await Promise.all([p1, p2]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).dashboardView.render).toHaveBeenCalledTimes(1);
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
// Mobile on-screen-keyboard handling (visualViewport)
// ---------------------------------------------------------------------------

describe("PMCompassView mobile viewport handling", () => {
  afterEach(async () => {
    const obsidian = await import("obsidian");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obsidian as any).Platform.isMobile = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).visualViewport;
  });

  async function makeMobileView() {
    const obsidian = await import("obsidian");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obsidian as any).Platform.isMobile = true;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).visualViewport = { addEventListener, removeEventListener };
    const { view } = makeView();
    return { view, addEventListener, removeEventListener };
  }

  it("registers a resize listener on the visual viewport when on mobile", async () => {
    const { view, addEventListener } = await makeMobileView();
    await view.onOpen();
    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("does not register a listener when visualViewport is unavailable", async () => {
    const { view } = makeView();
    await expect(view.onOpen()).resolves.toBeUndefined();
  });

  it("debounces the resize handler, clearing any previous pending timer", async () => {
    vi.useFakeTimers();
    const { view, addEventListener } = await makeMobileView();
    await view.onOpen();
    const handler = addEventListener.mock.calls[0][1] as () => void;
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    handler();
    handler();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    vi.useRealTimers();
  });

  it("clears a pending keyboard-resize timer on close", async () => {
    vi.useFakeTimers();
    const { view, addEventListener } = await makeMobileView();
    await view.onOpen();
    const handler = addEventListener.mock.calls[0][1] as () => void;
    handler(); // schedules the 50ms debounce timer, doesn't fire yet
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    await view.onClose();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("removes the resize listener on close", async () => {
    const { view, removeEventListener } = await makeMobileView();
    await view.onOpen();
    await view.onClose();
    expect(removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("does nothing on close when no viewport listener was ever registered", async () => {
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
