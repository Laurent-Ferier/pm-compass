// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";

vi.mock("./ui/task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

vi.mock("./model/project/obsidian-pm-settings", () => ({ readObsidianPmSettings: vi.fn() }));

const mockVaultLoad = vi.fn().mockResolvedValue(undefined);
const mockWarm = vi.fn();
const mockReconcileDay = vi.fn<(filePath: string) => void>();
/** The week's habits, which the dashboard asks the day half for on every render. */
const mockBackfill = vi.fn().mockResolvedValue({ filesChanged: 0, filesCreated: 0 });

vi.mock("./model/service/vault-data", () => ({
  VaultData: class {
    load = mockVaultLoad;
    // The day half, which the plugin reaches through the vault it holds.
    tasks = {
      reconcileDay: mockReconcileDay,
      backfillHabits: mockBackfill,
      inboxPath: "Inbox.md",
      dailyNotesConfig: { folder: "", format: "YYYY-MM-DD", template: "" },
    };
    start() {}
    warm = mockWarm;
    dispose() {}
    reconfigure() {}
  },
}));

const mockRepairListings = vi.fn<typeof import("./model/project/listing-repair").repairListings>().mockResolvedValue(undefined);
const mockUnlinkDeletedTask = vi.fn<typeof import("./model/project/listing-repair").unlinkDeletedTask>().mockResolvedValue(undefined);
const mockSyncChangedNote = vi.fn<typeof import("./model/project/listing-sync").syncChangedNote>().mockResolvedValue(undefined);

vi.mock("./model/project/listing-repair", () => ({
  repairListings: (...args: Parameters<typeof import("./model/project/listing-repair").repairListings>) => mockRepairListings(...args),
  unlinkDeletedTask: (...args: Parameters<typeof import("./model/project/listing-repair").unlinkDeletedTask>) => mockUnlinkDeletedTask(...args),
}));
vi.mock("./model/project/listing-sync", () => ({
  syncChangedNote: (...args: Parameters<typeof import("./model/project/listing-sync").syncChangedNote>) => mockSyncChangedNote(...args),
}));


const mockNotice = vi.fn();

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
    constructor(message: string) { mockNotice(message); }
  }
  const normalizePath = (p: string) => p;
  const setIcon = () => {};
  const moment = () => ({ format: () => "", startOf: () => ({ diff: () => 0 }), diff: () => 0 });
  return { Plugin, WorkspaceLeaf, PluginSettingTab, Setting, Modal, ItemView, TAbstractFile, TFile, Notice, normalizePath, setIcon, moment };
});

import { readObsidianPmSettings } from "./model/project/obsidian-pm-settings";
import PMCompassPlugin from "./main";
import { PMCompassView } from "./ui/pm-compass-view";
import { day } from "./model/__testing__/dates";
import { asApp } from "./model/__testing__/as-app";
import { bare } from "./model/__testing__/bare";
import type { PluginManifest } from "obsidian";

/** The handler the plugin registered for a vault or workspace event. */
function lastHandler(on: Mock<(...args: never[]) => unknown>, event: string): unknown {
  const forEvent = on.mock.calls.filter((c: unknown[]) => c[0] === event);
  return forEvent[forEvent.length - 1][1];
}

/** The app a plugin was built with, as the slice these tests listen on. */
const bagOfApp = (plugin: PMCompassPlugin) => plugin.app as unknown as {
  vault: { on: Mock<(...args: never[]) => unknown> };
  workspace: {
    on: Mock<(...args: never[]) => unknown>;
    detachLeavesOfType: Mock<(type: string) => void>;
  };
};

const mockReadSettings = vi.mocked(readObsidianPmSettings);

/** The plugin's own members, named rather than reached for through `any`: the private
 *  passes the tests drive directly, and the settings blob Plugin.loadData stands on. */
interface PluginInternals {
  syncFromObsidianPm(): Promise<void>;
  activateView(): Promise<void>;
  activateDashboard(): Promise<void>;
  runListingRepair(): Promise<void>;
  runBackfill(): Promise<void>;
  addCommand(command: { id: string; name: string; callback?: () => void }): unknown;
  addRibbonIcon(icon: string, title: string, callback: () => void): HTMLElement;
  registerView(type: string, factory: (leaf: unknown) => unknown): void;
  /** What Plugin.loadData/saveData round-trips: whatever was persisted, which is a
   *  partial settings blob rather than the current shape. */
  _data: Record<string, unknown> & { recurringTasks?: Record<string, unknown>[] };
}
const internals = (plugin: PMCompassPlugin) => plugin as unknown as PluginInternals;

function makePlugin() {
  const mockApp = {
    // Obsidian runs the callback at once for a plugin enabled after startup, and after the
    // vault has been built for one loaded with it.
    workspace: { detachLeavesOfType: vi.fn(), on: vi.fn(), onLayoutReady: vi.fn((cb: () => void) => { cb(); }) },
    metadataCache: { on: vi.fn(), offref: vi.fn() },
    vault: {
      on: vi.fn(),
      offref: vi.fn(),
      adapter: { read: vi.fn().mockRejectedValue(new Error("not found")) },
    },
  };
  return new PMCompassPlugin(asApp(mockApp), {} as PluginManifest);
}

function makePluginWithFullWorkspace(existingLeaves: unknown[] = []) {
  const newLeaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
  const workspace = {
    detachLeavesOfType: vi.fn(),
    getLeavesOfType: vi.fn().mockReturnValue(existingLeaves),
    revealLeaf: vi.fn(),
    getLeaf: vi.fn().mockReturnValue(newLeaf),
  };
  const plugin = new PMCompassPlugin(asApp({ workspace }), {} as PluginManifest);
  return { plugin, workspace, newLeaf };
}

// ---------------------------------------------------------------------------
// refreshDashboard
// ---------------------------------------------------------------------------

describe("refreshDashboard", () => {
  it("re-renders every open dashboard, so a setting takes effect while settings are up", () => {
    // A bare instance rather than a real view: `instanceof` is all the plugin asks, and
    // constructing one would drag in the whole tab tree.
    const render = vi.fn().mockResolvedValue(undefined);
    const view = bare(PMCompassView);
    Object.assign(view, { render });
    const { plugin } = makePluginWithFullWorkspace([{ view }]);

    plugin.refreshDashboard();

    expect(render).toHaveBeenCalled();
  });

  it("leaves a leaf holding something else alone", () => {
    const render = vi.fn();
    const { plugin } = makePluginWithFullWorkspace([{ view: { render } }]);

    plugin.refreshDashboard();

    expect(render).not.toHaveBeenCalled();
  });
});

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
    // Share the same internal data by copying the saved state
    internals(plugin2)._data = internals(plugin)._data;
    await plugin2.loadSettings();

    expect(plugin2.settings.projectsFolder).toBe("Work/Projects");
    expect(plugin2.settings.syncObsidianPmSettings).toBe(false);
  });

  it("drops saved keys the plugin no longer has a setting for", async () => {
    const plugin = makePlugin();
    internals(plugin)._data = { projectsFolder: "Work/Projects", smallTaskMaxWeeksAhead: 3 };
    await plugin.loadSettings();

    expect(plugin.settings.projectsFolder).toBe("Work/Projects");
    expect(plugin.settings).not.toHaveProperty("smallTaskMaxWeeksAhead");
    // The next save is what actually clears it out of data.json.
    await plugin.saveSettings();
    expect(internals(plugin)._data).not.toHaveProperty("smallTaskMaxWeeksAhead");
  });

  it("drops a panel toggle a saved panelConfig outlives", async () => {
    const plugin = makePlugin();
    internals(plugin)._data = { panelConfig: { showActiveOnly: false, showArchived: true } };
    await plugin.loadSettings();
    expect(plugin.settings.panelConfig).toEqual({ showActiveOnly: false });
  });

  it("falls back to the default for a panel toggle a saved panelConfig predates", async () => {
    const plugin = makePlugin();
    internals(plugin)._data = { panelConfig: {} };
    await plugin.loadSettings();
    expect(plugin.settings.panelConfig).toEqual({ showActiveOnly: true });
  });

  it("carries `splitDailyTasks` over to the name it goes by now", async () => {
    const plugin = makePlugin();
    internals(plugin)._data = { splitDailyTasks: false };
    await plugin.loadSettings();
    expect(plugin.settings.splitTaskLists).toBe(false);
  });

  it("keeps the current name when both are saved", async () => {
    const plugin = makePlugin();
    internals(plugin)._data = { splitDailyTasks: false, splitTaskLists: true };
    await plugin.loadSettings();
    expect(plugin.settings.splitTaskLists).toBe(true);
  });

  it("reads a habit's stored `createdAt` as a date", async () => {
    const plugin = makePlugin();
    internals(plugin)._data = {
      recurringTasks: [{
        id: "a", title: "Run", weekdays: 0b1111111, order: 0, active: true,
        createdAt: "2026-01-02", detail: "",
      }],
    };
    await plugin.loadSettings();
    expect(plugin.settings.recurringTasks[0].createdAt).toEqual(day("2026-01-02"));
  });

  it("writes it back as the `YYYY-MM-DD` text data.json has always held", async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.recurringTasks = [{
      id: "a", title: "Run", weekdays: 0b1111111, order: 0, active: true,
      createdAt: day("2026-01-02"), detail: "",
    }];
    await plugin.saveSettings();
    expect(internals(plugin)._data.recurringTasks?.[0].createdAt).toBe("2026-01-02");
  });

  it("falls back to today when the stored date is unreadable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(day("2026-03-04"));
    const plugin = makePlugin();
    internals(plugin)._data = {
      recurringTasks: [{
        id: "a", title: "Run", weekdays: 0b1111111, order: 0, active: true,
        createdAt: "not a date", detail: "",
      }],
    };
    await plugin.loadSettings();
    expect(plugin.settings.recurringTasks[0].createdAt).toEqual(day("2026-03-04"));
    vi.useRealTimers();
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

    await internals(plugin).syncFromObsidianPm();

    expect(plugin.settings.projectsFolder).toBe("Work/Projects");
    expect(mockReadSettings).toHaveBeenCalledOnce();
  });

  it("does not call readObsidianPmSettings when sync is disabled", async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.syncObsidianPmSettings = false;

    await internals(plugin).syncFromObsidianPm();

    expect(mockReadSettings).not.toHaveBeenCalled();
  });

  it("leaves projectsFolder unchanged when obsidian-pm returns null", async () => {
    mockReadSettings.mockResolvedValueOnce(null);
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.syncObsidianPmSettings = true;
    plugin.settings.projectsFolder = "My/Projects";

    await internals(plugin).syncFromObsidianPm();

    expect(plugin.settings.projectsFolder).toBe("My/Projects");
  });

  it("persists the updated projectsFolder after sync", async () => {
    mockReadSettings.mockResolvedValueOnce({ projectsFolder: "Synced/Projects" });
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.syncObsidianPmSettings = true;

    await internals(plugin).syncFromObsidianPm();

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

    const saved = internals(plugin)._data as unknown as typeof plugin.settings;
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

    const detach = bagOfApp(plugin).workspace.detachLeavesOfType;
    expect(detach).not.toHaveBeenCalled();
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

  it("fills the cache once the vault is built, not while Obsidian is still listing it", async () => {
    // A folder walked mid-listing reads as a handful of notes, and the listing pass that
    // hangs off it vouches for those and never runs again.
    const plugin = makePlugin();
    const { workspace } = plugin.app as unknown as { workspace: { onLayoutReady: Mock<(cb: () => void) => void> } };
    workspace.onLayoutReady.mockImplementation(() => {});

    await plugin.onload();
    expect(mockWarm).not.toHaveBeenCalled();

    workspace.onLayoutReady.mock.calls[0][0]();
    expect(mockWarm).toHaveBeenCalled();
  });

  it("registers both view types", async () => {
    const plugin = makePlugin();
    const registerViewSpy = vi.spyOn(internals(plugin), "registerView");

    await plugin.onload();

    expect(registerViewSpy).toHaveBeenCalledWith("pm-compass-task-graph", expect.any(Function));
    expect(registerViewSpy).toHaveBeenCalledWith("pm-compass-dashboard", expect.any(Function));
  });

  it("adds the open-dashboard and open-task-graph commands", async () => {
    const plugin = makePlugin();
    const addCommandSpy = vi.spyOn(internals(plugin), "addCommand");

    await plugin.onload();

    const ids = addCommandSpy.mock.calls.map(([command]) => command.id);
    expect(ids).toContain("open-dashboard");
    expect(ids).toContain("open-task-graph");
  });

  it("adds no command beyond the two that open a view", async () => {
    const plugin = makePlugin();
    const addCommandSpy = vi.spyOn(internals(plugin), "addCommand");

    await plugin.onload();

    const ids = addCommandSpy.mock.calls.map(([command]) => command.id);
    expect(ids).toEqual(["open-dashboard", "open-task-graph"]);
  });

  it("registers a workspace 'file-open' listener", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    const workspaceOn = bagOfApp(plugin).workspace.on as ReturnType<typeof vi.fn>;
    expect(workspaceOn).toHaveBeenCalledWith("file-open", expect.any(Function));
  });

  it("the 'Open PM Compass dashboard' ribbon icon delegates to activateDashboard", async () => {
    const plugin = makePlugin();
    const activateDashboardSpy = vi.spyOn(internals(plugin), "activateDashboard").mockResolvedValue(undefined);
    const addRibbonIconSpy = vi.spyOn(internals(plugin), "addRibbonIcon");

    await plugin.onload();

    const call = addRibbonIconSpy.mock.calls.find(([, title]) => title === "Open PM Compass dashboard")!;
    call[2]();

    expect(activateDashboardSpy).toHaveBeenCalled();
  });

  it("the 'Open task graph' ribbon icon delegates to activateView", async () => {
    const plugin = makePlugin();
    const activateViewSpy = vi.spyOn(internals(plugin), "activateView").mockResolvedValue(undefined);
    const addRibbonIconSpy = vi.spyOn(internals(plugin), "addRibbonIcon");

    await plugin.onload();

    const call = addRibbonIconSpy.mock.calls.find(([, title]) => title === "Open task graph")!;
    call[2]();

    expect(activateViewSpy).toHaveBeenCalled();
  });

  it("the open-dashboard command callback delegates to activateDashboard", async () => {
    const plugin = makePlugin();
    const activateDashboardSpy = vi.spyOn(internals(plugin), "activateDashboard").mockResolvedValue(undefined);
    const addCommandSpy = vi.spyOn(internals(plugin), "addCommand");

    await plugin.onload();

    const call = addCommandSpy.mock.calls.find(([command]) => command.id === "open-dashboard")!;
    (call[0] as { callback: () => void }).callback();

    expect(activateDashboardSpy).toHaveBeenCalled();
  });

  it("the 'file-open' listener reconciles when a file is passed", async () => {
    const { TFile } = await import("obsidian");
    const plugin = makePlugin();
    await plugin.onload();

    const workspaceOn = bagOfApp(plugin).workspace.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(workspaceOn, "file-open") as (
      f: unknown,
    ) => void;
    const file = Object.assign(new TFile(), { path: "2026-07-01.md" });

    handler(file);

    expect(mockReconcileDay).toHaveBeenCalledWith("2026-07-01.md");
  });

  it("the 'file-open' listener does nothing when null is passed (pane closed)", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    const workspaceOn = bagOfApp(plugin).workspace.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(workspaceOn, "file-open") as (
      f: unknown,
    ) => void;

    handler(null);

    expect(mockReconcileDay).not.toHaveBeenCalled();
  });

  it("the open-task-graph command callback delegates to activateView", async () => {
    const plugin = makePlugin();
    const activateViewSpy = vi.spyOn(internals(plugin), "activateView").mockResolvedValue(undefined);
    const addCommandSpy = vi.spyOn(internals(plugin), "addCommand");

    await plugin.onload();

    const call = addCommandSpy.mock.calls.find(([command]) => command.id === "open-task-graph")!;
    (call[0] as { callback: () => void }).callback();

    expect(activateViewSpy).toHaveBeenCalled();
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

    await internals(plugin).activateView();

    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("creates a new tab and reveals it when no task-graph view is open", async () => {
    const { plugin, workspace, newLeaf } = makePluginWithFullWorkspace([]);

    await internals(plugin).activateView();

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

    await internals(plugin).activateDashboard();

    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("creates a new tab and reveals it when no dashboard view is open", async () => {
    const { plugin, workspace, newLeaf } = makePluginWithFullWorkspace([]);

    await internals(plugin).activateDashboard();

    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(newLeaf.setViewState).toHaveBeenCalledWith({ type: "pm-compass-dashboard", active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
  });
});
