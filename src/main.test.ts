// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("./ui/task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

vi.mock("./model/vault-reader", () => ({
  readObsidianPmSettings: vi.fn(),
}));

vi.mock("./model/recurring-task-backfill", () => ({
  backfillRecurringHabits: vi.fn().mockResolvedValue({ filesChanged: 0, filesCreated: 0 }),
}));

const mockReconcileRecurringHabits = vi.fn().mockResolvedValue([]);
const mockMatchDailyNotePath = vi.fn();

vi.mock("./model/day-markdown-file", () => ({
  DayMarkdownFile: class {
    reconcileRecurringHabits = mockReconcileRecurringHabits;
  },
  readDailyNotesConfig: vi.fn().mockResolvedValue({ folder: "", format: "YYYY-MM-DD", template: "" }),
  matchDailyNotePath: (...args: unknown[]) => mockMatchDailyNotePath(...args),
}));

vi.mock("obsidian", () => {
  class Plugin {
    app: unknown;
    private _data: unknown = null;
    constructor(app: unknown) {
      this.app = app;
    }
    async loadData() {
      return this._data;
    }
    async saveData(data: unknown) {
      this._data = data;
    }
    registerView() {}
    addRibbonIcon() {
      return {};
    }
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
  }
  class WorkspaceLeaf {}
  class PluginSettingTab {
    constructor(_app: unknown, _plugin: unknown) {}
  }
  class Setting {
    setName() { return this; }
    setHeading() { return this; }
    setDesc() { return this; }
    addToggle() { return this; }
    addText() { return this; }
    addButton() { return this; }
    addExtraButton() { return this; }
    constructor(_container: unknown) {}
  }
  class Modal {
    app: unknown;
    contentEl = { empty() {}, createEl() { return { createEl() { return {}; }, addEventListener() {} }; } };
    constructor(app: unknown) { this.app = app; }
    open() {}
    close() {}
  }
  class ItemView {
    constructor(_leaf: unknown) {}
    registerEvent() {}
    registerDomEvent() {}
  }
  class TAbstractFile {}
  class TFile extends TAbstractFile {}
  class Notice {
    constructor(_message: string) {}
  }
  const normalizePath = (p: string) => p;
  const setIcon = () => {};
  const moment = () => ({ format: () => "", startOf: () => ({ diff: () => 0 }), diff: () => 0 });
  return { Plugin, WorkspaceLeaf, PluginSettingTab, Setting, Modal, ItemView, TAbstractFile, TFile, Notice, normalizePath, setIcon, moment };
});

import { readObsidianPmSettings } from "./model/vault-reader";
import { backfillRecurringHabits } from "./model/recurring-task-backfill";
import PMCompassPlugin from "./main";

const mockReadSettings = vi.mocked(readObsidianPmSettings);
const mockBackfill = vi.mocked(backfillRecurringHabits);

function makePlugin() {
  const mockApp = {
    workspace: { detachLeavesOfType: vi.fn(), on: vi.fn() },
    vault: { on: vi.fn(), adapter: { read: vi.fn().mockRejectedValue(new Error("not found")) } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PMCompassPlugin(mockApp as any, {} as any);
}

function makePluginWithFullWorkspace(existingLeaves: unknown[] = []) {
  const newLeaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
  const workspace = {
    detachLeavesOfType: vi.fn(),
    getLeavesOfType: vi.fn().mockReturnValue(existingLeaves),
    revealLeaf: vi.fn(),
    getLeaf: vi.fn().mockReturnValue(newLeaf),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = new PMCompassPlugin({ workspace } as any, {} as any);
  return { plugin, workspace, newLeaf };
}

// ---------------------------------------------------------------------------
// loadSettings
// ---------------------------------------------------------------------------

describe("loadSettings", () => {
  it("uses DEFAULT_SETTINGS when no data is saved", async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    expect(plugin.settings.projectsFolder).toBe("Projects");
    expect(plugin.settings.syncObsidianPmSettings).toBe(true);
  });

  it("merges saved data over defaults", async () => {
    const plugin = makePlugin();
    // Pre-seed saved data before loading
    await plugin.saveSettings();
    plugin.settings.projectsFolder = "Work/Projects";
    plugin.settings.syncObsidianPmSettings = false;
    await plugin.saveSettings();

    // New plugin instance loading the saved data
    const plugin2 = makePlugin();
    // Share the same internal data store by copying the saved state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin2 as any)._data = (plugin as any)._data;
    await plugin2.loadSettings();

    expect(plugin2.settings.projectsFolder).toBe("Work/Projects");
    expect(plugin2.settings.syncObsidianPmSettings).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncFromObsidianPm (tested via private access)
// ---------------------------------------------------------------------------

describe("syncFromObsidianPm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates projectsFolder when sync is enabled and obsidian-pm returns a value", async () => {
    mockReadSettings.mockResolvedValueOnce({ projectsFolder: "Work/Projects" });
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.syncObsidianPmSettings = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).syncFromObsidianPm();

    expect(plugin.settings.projectsFolder).toBe("Work/Projects");
    expect(mockReadSettings).toHaveBeenCalledOnce();
  });

  it("does not call readObsidianPmSettings when sync is disabled", async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.syncObsidianPmSettings = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).syncFromObsidianPm();

    expect(mockReadSettings).not.toHaveBeenCalled();
  });

  it("leaves projectsFolder unchanged when obsidian-pm returns null", async () => {
    mockReadSettings.mockResolvedValueOnce(null);
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.syncObsidianPmSettings = true;
    plugin.settings.projectsFolder = "My/Projects";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).syncFromObsidianPm();

    expect(plugin.settings.projectsFolder).toBe("My/Projects");
  });

  it("persists the updated projectsFolder after sync", async () => {
    mockReadSettings.mockResolvedValueOnce({ projectsFolder: "Synced/Projects" });
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.syncObsidianPmSettings = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).syncFromObsidianPm();

    // Load settings again to confirm it was saved
    await plugin.loadSettings();
    expect(plugin.settings.projectsFolder).toBe("Synced/Projects");
  });
});

// ---------------------------------------------------------------------------
// saveSettings
// ---------------------------------------------------------------------------

describe("saveSettings", () => {
  it("persists the current settings via saveData", async () => {
    const plugin = makePlugin();
    plugin.settings.projectsFolder = "Custom/Folder";
    plugin.settings.syncObsidianPmSettings = false;

    await plugin.saveSettings();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = (plugin as any)._data as typeof plugin.settings;
    expect(saved.projectsFolder).toBe("Custom/Folder");
    expect(saved.syncObsidianPmSettings).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onunload
// ---------------------------------------------------------------------------

describe("onunload", () => {
  it("does not detach view type leaves from the workspace", () => {
    // Obsidian's plugin guidelines: don't detach leaves in onunload, since open
    // leaves should reinitialize at their original positions after a plugin update.
    const plugin = makePlugin();

    plugin.onunload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detach = (plugin.app as any).workspace.detachLeavesOfType as ReturnType<typeof vi.fn>;
    expect(detach).not.toHaveBeenCalled();
  });

  it("clears any pending reconcile timers", async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockReadSettings.mockResolvedValue(null);
    mockMatchDailyNotePath.mockReturnValue(new Date());
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const plugin = makePlugin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("2026-07-01.md");
    plugin.onunload();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// onload
// ---------------------------------------------------------------------------

describe("onload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSettings.mockResolvedValue(null);
  });

  it("registers both view types", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registerViewSpy = vi.spyOn(plugin as any, "registerView");

    await plugin.onload();

    expect(registerViewSpy).toHaveBeenCalledWith("pm-compass-task-graph", expect.any(Function));
    expect(registerViewSpy).toHaveBeenCalledWith("pm-compass-dashboard", expect.any(Function));
  });

  it("adds the open-dashboard and open-task-graph commands", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addCommandSpy = vi.spyOn(plugin as any, "addCommand");

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = addCommandSpy.mock.calls.map((c: any) => (c[0] as { id: string }).id);
    expect(ids).toContain("open-dashboard");
    expect(ids).toContain("open-task-graph");
  });

  it("adds the backfill-recurring-habits command", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addCommandSpy = vi.spyOn(plugin as any, "addCommand");

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = addCommandSpy.mock.calls.map((c: any) => (c[0] as { id: string }).id);
    expect(ids).toContain("backfill-recurring-habits");
  });

  it("registers a vault 'create' listener", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultOn = (plugin.app as any).vault.on as ReturnType<typeof vi.fn>;
    expect(vaultOn).toHaveBeenCalledWith("create", expect.any(Function));
  });

  it("registers a workspace 'file-open' listener", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspaceOn = (plugin.app as any).workspace.on as ReturnType<typeof vi.fn>;
    expect(workspaceOn).toHaveBeenCalledWith("file-open", expect.any(Function));
  });

  it("the 'Open project manager dashboard' ribbon icon delegates to activateDashboard", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activateDashboardSpy = vi.spyOn(plugin as any, "activateDashboard").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addRibbonIconSpy = vi.spyOn(plugin as any, "addRibbonIcon");

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = addRibbonIconSpy.mock.calls.find((c: any) => c[1] === "Open project manager dashboard")!;
    (call[2] as () => void)();

    expect(activateDashboardSpy).toHaveBeenCalled();
  });

  it("the 'Open task graph' ribbon icon delegates to activateView", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activateViewSpy = vi.spyOn(plugin as any, "activateView").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addRibbonIconSpy = vi.spyOn(plugin as any, "addRibbonIcon");

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = addRibbonIconSpy.mock.calls.find((c: any) => c[1] === "Open task graph")!;
    (call[2] as () => void)();

    expect(activateViewSpy).toHaveBeenCalled();
  });

  it("the open-dashboard command callback delegates to activateDashboard", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activateDashboardSpy = vi.spyOn(plugin as any, "activateDashboard").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addCommandSpy = vi.spyOn(plugin as any, "addCommand");

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = addCommandSpy.mock.calls.find((c: any) => c[0].id === "open-dashboard")!;
    (call[0] as { callback: () => void }).callback();

    expect(activateDashboardSpy).toHaveBeenCalled();
  });

  it("the 'create' listener reconciles when the created file is a TFile", async () => {
    const { TFile } = await import("obsidian");
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reconcileSpy = vi.spyOn(plugin as any, "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultOn = (plugin.app as any).vault.on as ReturnType<typeof vi.fn>;
    const handler = vaultOn.mock.calls.find((c: unknown[]) => c[0] === "create")![1] as (f: unknown) => void;
    const file = Object.assign(new TFile(), { path: "2026-07-01.md" });

    handler(file);

    expect(reconcileSpy).toHaveBeenCalledWith("2026-07-01.md");
  });

  it("the 'create' listener ignores non-TFile entries", async () => {
    const { TAbstractFile } = await import("obsidian");
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reconcileSpy = vi.spyOn(plugin as any, "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultOn = (plugin.app as any).vault.on as ReturnType<typeof vi.fn>;
    const handler = vaultOn.mock.calls.find((c: unknown[]) => c[0] === "create")![1] as (f: unknown) => void;
    const folder = Object.assign(new TAbstractFile(), { path: "SomeFolder" });

    handler(folder);

    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("the 'file-open' listener reconciles when a file is passed", async () => {
    const { TFile } = await import("obsidian");
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reconcileSpy = vi.spyOn(plugin as any, "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspaceOn = (plugin.app as any).workspace.on as ReturnType<typeof vi.fn>;
    const handler = workspaceOn.mock.calls.find((c: unknown[]) => c[0] === "file-open")![1] as (
      f: unknown,
    ) => void;
    const file = Object.assign(new TFile(), { path: "2026-07-01.md" });

    handler(file);

    expect(reconcileSpy).toHaveBeenCalledWith("2026-07-01.md");
  });

  it("the 'file-open' listener does nothing when null is passed (pane closed)", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reconcileSpy = vi.spyOn(plugin as any, "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspaceOn = (plugin.app as any).workspace.on as ReturnType<typeof vi.fn>;
    const handler = workspaceOn.mock.calls.find((c: unknown[]) => c[0] === "file-open")![1] as (
      f: unknown,
    ) => void;

    handler(null);

    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("the open-task-graph command callback delegates to activateView", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activateViewSpy = vi.spyOn(plugin as any, "activateView").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addCommandSpy = vi.spyOn(plugin as any, "addCommand");

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = addCommandSpy.mock.calls.find((c: any) => c[0].id === "open-task-graph")!;
    (call[0] as { callback: () => void }).callback();

    expect(activateViewSpy).toHaveBeenCalled();
  });

  it("the backfill-recurring-habits command callback delegates to runBackfill", async () => {
    const plugin = makePlugin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runBackfillSpy = vi.spyOn(plugin as any, "runBackfill").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addCommandSpy = vi.spyOn(plugin as any, "addCommand");

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = addCommandSpy.mock.calls.find((c: any) => c[0].id === "backfill-recurring-habits")!;
    (call[0] as { callback: () => void }).callback();

    expect(runBackfillSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// backfill-recurring-habits command
// ---------------------------------------------------------------------------

describe("runBackfill (private)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSettings.mockResolvedValue(null);
  });

  it("calls backfillRecurringHabits with the app and current settings", async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).runBackfill();

    expect(mockBackfill).toHaveBeenCalledWith(plugin.app, plugin.settings);
  });
});

// ---------------------------------------------------------------------------
// maybeReconcileDailyNote (private)
// ---------------------------------------------------------------------------

describe("maybeReconcileDailyNote (private)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockReadSettings.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when the path is not a daily note", async () => {
    mockMatchDailyNotePath.mockReturnValue(null);
    const plugin = makePlugin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("Not/A/Daily/Note.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileRecurringHabits).not.toHaveBeenCalled();
  });

  it("reconciles a daily note that falls within the current ISO week", async () => {
    mockMatchDailyNotePath.mockReturnValue(new Date());
    const plugin = makePlugin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("2026-07-01.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileRecurringHabits).toHaveBeenCalledOnce();
  });

  it("skips a daily note that falls outside the current ISO week", async () => {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    mockMatchDailyNotePath.mockReturnValue(sixMonthsAgo);
    const plugin = makePlugin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("2026-01-01.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileRecurringHabits).not.toHaveBeenCalled();
  });

  it("skips a daily note from earlier this week, even though it's the same ISO week", async () => {
    vi.setSystemTime(new Date(2026, 6, 1)); // Wednesday, July 1 2026
    mockMatchDailyNotePath.mockReturnValue(new Date(2026, 5, 29)); // Monday this same week
    const plugin = makePlugin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("2026-06-29.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileRecurringHabits).not.toHaveBeenCalled();
  });

  it("reconciles a later day in the current week, even though it isn't today", async () => {
    vi.setSystemTime(new Date(2026, 6, 1)); // Wednesday, July 1 2026
    mockMatchDailyNotePath.mockReturnValue(new Date(2026, 6, 3)); // Friday this same week
    const plugin = makePlugin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("2026-07-03.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileRecurringHabits).toHaveBeenCalledOnce();
  });

  it("debounces repeated opens of the same daily note into a single reconcile", async () => {
    mockMatchDailyNotePath.mockReturnValue(new Date());
    const plugin = makePlugin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("2026-07-01.md");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).maybeReconcileDailyNote("2026-07-01.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileRecurringHabits).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// activateView (private)
// ---------------------------------------------------------------------------

describe("activateView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSettings.mockResolvedValue(null);
  });

  it("reveals the existing leaf when a task-graph view is already open", async () => {
    const existingLeaf = {};
    const { plugin, workspace } = makePluginWithFullWorkspace([existingLeaf]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).activateView();

    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("creates a new tab and reveals it when no task-graph view is open", async () => {
    const { plugin, workspace, newLeaf } = makePluginWithFullWorkspace([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).activateView();

    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(newLeaf.setViewState).toHaveBeenCalledWith({ type: "pm-compass-task-graph", active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
  });
});

// ---------------------------------------------------------------------------
// activateDashboard (private)
// ---------------------------------------------------------------------------

describe("activateDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSettings.mockResolvedValue(null);
  });

  it("reveals the existing leaf when a dashboard view is already open", async () => {
    const existingLeaf = {};
    const { plugin, workspace } = makePluginWithFullWorkspace([existingLeaf]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).activateDashboard();

    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("creates a new tab and reveals it when no dashboard view is open", async () => {
    const { plugin, workspace, newLeaf } = makePluginWithFullWorkspace([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).activateDashboard();

    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(newLeaf.setViewState).toHaveBeenCalledWith({ type: "pm-compass-dashboard", active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
  });
});
