// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("./ui/task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

vi.mock("./model/project/obsidian-pm-settings", () => ({ readObsidianPmSettings: vi.fn() }));

// The store has its own tests; here it only has to answer what the plugin asks of it.
const mockVaultLoad = vi.fn().mockResolvedValue({ projects: [], tasks: [] });
const mockDayOfNote = vi.fn<(filePath: string) => Date | null>();
const mockReconcileHabits = vi.fn().mockResolvedValue(undefined);

vi.mock("./model/store/vault-data", () => ({
  VaultData: class {
    load = mockVaultLoad;
    // The day half, which the plugin reaches through the vault it holds.
    taskStore = {
      dayOfNote: mockDayOfNote,
      reconcileHabits: mockReconcileHabits,
      inboxPath: "Inbox.md",
      dailyNotesConfig: { folder: "", format: "YYYY-MM-DD", template: "" },
    };
    start() {}
    warm() {}
    dispose() {}
    reconfigure() {}
  },
}));

const mockRepairListings = vi.fn<typeof import("./model/project/listing-repair").repairListings>().mockResolvedValue({ listingsRewritten: 0, prefixesFixed: 0 });
const mockUnlinkDeletedTask = vi.fn<typeof import("./model/project/listing-repair").unlinkDeletedTask>().mockResolvedValue(undefined);
const mockSyncChangedNote = vi.fn<typeof import("./model/project/listing-sync").syncChangedNote>().mockResolvedValue(undefined);

vi.mock("./model/project/listing-repair", () => ({
  repairListings: (...args: Parameters<typeof import("./model/project/listing-repair").repairListings>) => mockRepairListings(...args),
  unlinkDeletedTask: (...args: Parameters<typeof import("./model/project/listing-repair").unlinkDeletedTask>) => mockUnlinkDeletedTask(...args),
}));
vi.mock("./model/project/listing-sync", () => ({
  syncChangedNote: (...args: Parameters<typeof import("./model/project/listing-sync").syncChangedNote>) => mockSyncChangedNote(...args),
}));

vi.mock("./model/daily/recurring-task-backfill", () => ({
  backfillRecurringHabits: vi.fn().mockResolvedValue({ filesChanged: 0, filesCreated: 0 }),
}));

const mockMigrateInboxTargets = vi.fn<typeof import("./model/daily/day-task-actions").migrateInboxTargets>().mockResolvedValue(0);

vi.mock("./model/daily/day-task-actions", () => ({
  migrateInboxTargets: (...args: Parameters<typeof import("./model/daily/day-task-actions").migrateInboxTargets>) => mockMigrateInboxTargets(...args),
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
import { backfillRecurringHabits } from "./model/daily/recurring-task-backfill";
import PMCompassPlugin from "./main";
import { PMCompassView } from "./ui/pm-compass-view";
import { day } from "./model/__testing__/dates";
import { asApp } from "./model/__testing__/as-app";
import { bare } from "./model/__testing__/bare";
import type { PluginManifest } from "obsidian";
import type { Project } from "./model/project/project";
import type { ProjectTask } from "./model/project/project-task";

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
const mockBackfill = vi.mocked(backfillRecurringHabits);

/** The plugin's own members, named rather than reached for through `any`: the private
 *  passes the tests drive directly, and the settings blob Plugin.loadData stands on. */
interface PluginInternals {
  maybeReconcileDailyNote(filePath: string): Promise<void>;
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
    workspace: { detachLeavesOfType: vi.fn(), on: vi.fn() },
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
    // Share the same internal data store by copying the saved state
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

  it("clears any pending reconcile timers", async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockReadSettings.mockResolvedValue(null);
    mockDayOfNote.mockReturnValue(new Date());
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-07-01.md");
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

  it("adds the backfill-recurring-habits command", async () => {
    const plugin = makePlugin();
    const addCommandSpy = vi.spyOn(internals(plugin), "addCommand");

    await plugin.onload();

    const ids = addCommandSpy.mock.calls.map(([command]) => command.id);
    expect(ids).toContain("backfill-recurring-habits");
  });

  it("registers a vault 'create' listener", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    const vaultOn = bagOfApp(plugin).vault.on as ReturnType<typeof vi.fn>;
    expect(vaultOn).toHaveBeenCalledWith("create", expect.any(Function));
  });

  it("registers a workspace 'file-open' listener", async () => {
    const plugin = makePlugin();
    await plugin.onload();

    const workspaceOn = bagOfApp(plugin).workspace.on as ReturnType<typeof vi.fn>;
    expect(workspaceOn).toHaveBeenCalledWith("file-open", expect.any(Function));
  });

  it("the 'Open project manager dashboard' ribbon icon delegates to activateDashboard", async () => {
    const plugin = makePlugin();
    const activateDashboardSpy = vi.spyOn(internals(plugin), "activateDashboard").mockResolvedValue(undefined);
    const addRibbonIconSpy = vi.spyOn(internals(plugin), "addRibbonIcon");

    await plugin.onload();

    const call = addRibbonIconSpy.mock.calls.find(([, title]) => title === "Open project manager dashboard")!;
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

  it("the 'create' listener reconciles when the created file is a TFile", async () => {
    const { TFile } = await import("obsidian");
    const plugin = makePlugin();
    const reconcileSpy = vi.spyOn(internals(plugin), "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    const vaultOn = bagOfApp(plugin).vault.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(vaultOn, "create") as (f: unknown) => void;
    const file = Object.assign(new TFile(), { path: "2026-07-01.md" });

    handler(file);

    expect(reconcileSpy).toHaveBeenCalledWith("2026-07-01.md");
  });

  it("the 'create' listener ignores non-TFile entries", async () => {
    const { TAbstractFile } = await import("obsidian");
    const plugin = makePlugin();
    const reconcileSpy = vi.spyOn(internals(plugin), "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    const vaultOn = bagOfApp(plugin).vault.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(vaultOn, "create") as (f: unknown) => void;
    // `TAbstractFile` is abstract in obsidian's own types even though the mock makes it
    // concrete; build off the prototype so `instanceof TFile` still reads false.
    const folder = Object.assign(bare(TAbstractFile), { path: "SomeFolder" });

    handler(folder);

    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("the 'file-open' listener reconciles when a file is passed", async () => {
    const { TFile } = await import("obsidian");
    const plugin = makePlugin();
    const reconcileSpy = vi.spyOn(internals(plugin), "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    const workspaceOn = bagOfApp(plugin).workspace.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(workspaceOn, "file-open") as (
      f: unknown,
    ) => void;
    const file = Object.assign(new TFile(), { path: "2026-07-01.md" });

    handler(file);

    expect(reconcileSpy).toHaveBeenCalledWith("2026-07-01.md");
  });

  it("the 'file-open' listener does nothing when null is passed (pane closed)", async () => {
    const plugin = makePlugin();
    const reconcileSpy = vi.spyOn(internals(plugin), "maybeReconcileDailyNote").mockResolvedValue(undefined);

    await plugin.onload();

    const workspaceOn = bagOfApp(plugin).workspace.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(workspaceOn, "file-open") as (
      f: unknown,
    ) => void;

    handler(null);

    expect(reconcileSpy).not.toHaveBeenCalled();
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

  it("the repair-project-listings command callback delegates to runListingRepair", async () => {
    const plugin = makePlugin();
    const repairSpy = vi.spyOn(internals(plugin), "runListingRepair").mockResolvedValue(undefined);
    const addCommandSpy = vi.spyOn(internals(plugin), "addCommand");

    await plugin.onload();

    const call = addCommandSpy.mock.calls.find(([command]) => command.id === "repair-project-listings")!;
    (call[0] as { callback: () => void }).callback();

    expect(repairSpy).toHaveBeenCalled();
  });

  it("the backfill-recurring-habits command callback delegates to runBackfill", async () => {
    const plugin = makePlugin();
    const runBackfillSpy = vi.spyOn(internals(plugin), "runBackfill").mockResolvedValue(undefined);
    const addCommandSpy = vi.spyOn(internals(plugin), "addCommand");

    await plugin.onload();

    const call = addCommandSpy.mock.calls.find(([command]) => command.id === "backfill-recurring-habits")!;
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

    await internals(plugin).runBackfill();

    expect(mockBackfill).toHaveBeenCalledWith(plugin.app, plugin.settings);
  });
});

// ---------------------------------------------------------------------------
// The checklist listings: the opening pass, and which notes it vouches for
// ---------------------------------------------------------------------------

describe("ensureListingsVerified", () => {
  const PROJECTS = [{ id: "p1", filePath: "Projects/Alpha.md" } as Project];
  const TASKS = [{ id: "t1", filePath: "Projects/Alpha_tasks/t1.md" } as ProjectTask];

  /** The set of vouched-for paths, as the dispatcher is handed it. */
  const verifiedIn = () => mockSyncChangedNote.mock.calls[0][1];

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSettings.mockResolvedValue(null);
    mockRepairListings.mockResolvedValue({ listingsRewritten: 0, prefixesFixed: 0 });
  });

  const loaded = async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    return plugin;
  };

  it("checks every listing in the vault", async () => {
    const plugin = await loaded();
    await plugin.ensureListingsVerified(PROJECTS, TASKS);
    expect(mockRepairListings).toHaveBeenCalledWith(plugin.vault, PROJECTS, TASKS);
  });

  it("vouches for every note it checked, so their boxes can speak for the user", async () => {
    const plugin = await loaded();
    await plugin.ensureListingsVerified(PROJECTS, TASKS);
    await plugin.syncChangedNote("Projects/Alpha.md", "body");

    expect(verifiedIn().has("Projects/Alpha.md")).toBe(true);
    expect(verifiedIn().has("Projects/Alpha_tasks/t1.md")).toBe(true);
  });

  it("leaves an archived project and its tasks out, unchecked and unvouched-for", async () => {
    const archived = { id: "p2", filePath: "Projects/Old.md", archived: true } as Project;
    const archivedTask = { id: "t2", projectId: "p2", filePath: "Projects/Old_tasks/t2.md" } as ProjectTask;
    const plugin = await loaded();
    await plugin.ensureListingsVerified([...PROJECTS, archived], [...TASKS, archivedTask]);
    expect(mockRepairListings).toHaveBeenCalledWith(plugin.vault, PROJECTS, TASKS);

    await plugin.syncChangedNote("Projects/Old.md", "body");
    expect(verifiedIn().has("Projects/Old.md")).toBe(false);
    expect(verifiedIn().has("Projects/Old_tasks/t2.md")).toBe(false);
  });

  it("runs once a session, however many times the dashboard renders", async () => {
    const plugin = await loaded();
    await plugin.ensureListingsVerified(PROJECTS, TASKS);
    await plugin.ensureListingsVerified(PROJECTS, TASKS);
    expect(mockRepairListings).toHaveBeenCalledTimes(1);
  });

  it("skips the pass when the user has turned it off", async () => {
    const plugin = await loaded();
    plugin.settings.verifyListingsOnLoad = false;
    await plugin.ensureListingsVerified(PROJECTS, TASKS);
    expect(mockRepairListings).not.toHaveBeenCalled();
  });

  it("unlinks a task deleted outside the plugin from whatever listed it", async () => {
    const { TFile } = await import("obsidian");
    const plugin = await loaded();
    await plugin.onload();

    const vaultOn = bagOfApp(plugin).vault.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(vaultOn, "delete") as (f: unknown) => void;
    handler(Object.assign(new TFile(), { path: "Projects/Alpha_tasks/t1.md" }));

    expect(mockUnlinkDeletedTask).toHaveBeenCalledWith(plugin.app, "Projects/Alpha_tasks/t1.md");
  });

  it("takes a deleted note's listing out of good standing", async () => {
    const { TFile } = await import("obsidian");
    const plugin = await loaded();
    await plugin.ensureListingsVerified(PROJECTS, TASKS);
    await plugin.onload();

    const vaultOn = bagOfApp(plugin).vault.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(vaultOn, "delete") as (f: unknown) => void;
    handler(Object.assign(new TFile(), { path: "Projects/Alpha.md" }));

    await plugin.syncChangedNote("Projects/Alpha.md", "body");
    expect(verifiedIn().has("Projects/Alpha.md")).toBe(false);
  });

  it("says so when the unlink fails, rather than letting the rejection escape", async () => {
    const { TFile } = await import("obsidian");
    const plugin = await loaded();
    await plugin.onload();
    mockUnlinkDeletedTask.mockRejectedValueOnce(new Error("vault read failed"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const vaultOn = bagOfApp(plugin).vault.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(vaultOn, "delete") as (f: unknown) => void;
    handler(Object.assign(new TFile(), { path: "Projects/Alpha_tasks/t1.md" }));

    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    err.mockRestore();
  });

  it("takes a renamed note's listing out of good standing under its old path", async () => {
    // Whatever arrives at that path next is a different note, and unchecked.
    const plugin = await loaded();
    await plugin.ensureListingsVerified(PROJECTS, TASKS);
    await plugin.onload();

    const vaultOn = bagOfApp(plugin).vault.on as ReturnType<typeof vi.fn>;
    const handler = lastHandler(vaultOn, "rename") as
      (f: unknown, oldPath: string) => void;
    handler({}, "Projects/Alpha.md");

    await plugin.syncChangedNote("Projects/Alpha.md", "body");
    expect(verifiedIn().has("Projects/Alpha.md")).toBe(false);
  });

  it("vouches for nothing when the pass fails, so the boxes stay conservative", async () => {
    const plugin = await loaded();
    mockRepairListings.mockRejectedValue(new Error("vault read failed"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(plugin.ensureListingsVerified(PROJECTS, TASKS)).resolves.toBeUndefined();
    await plugin.syncChangedNote("Projects/Alpha.md", "body");

    expect(verifiedIn().size).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("hands the dispatcher the path and the content it was given", async () => {
    const plugin = await loaded();
    await plugin.syncChangedNote("Projects/Alpha.md", "the body");
    expect(mockSyncChangedNote).toHaveBeenCalledWith(
      plugin.vault, expect.any(Set), "Projects/Alpha.md", "the body",
    );
  });
});

describe("runListingRepair (private)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSettings.mockResolvedValue(null);
    mockRepairListings.mockResolvedValue({ listingsRewritten: 3, prefixesFixed: 1 });
    mockVaultLoad.mockResolvedValue({ projects: [], tasks: [] });
  });

  it("reports what it changed", async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    await internals(plugin).runListingRepair();

    expect(mockNotice).toHaveBeenCalledWith(
      "Checked project listings: 3 notes updated, 1 links repaired.",
    );
  });

  it("says how many archived projects it left alone", async () => {
    mockVaultLoad.mockResolvedValueOnce({
      projects: [{ id: "p1" }, { id: "p2", archived: true }] as Project[],
      tasks: [],
    });
    const plugin = makePlugin();
    await plugin.loadSettings();

    await internals(plugin).runListingRepair();

    expect(mockNotice).toHaveBeenCalledWith(
      "Checked project listings: 3 notes updated, 1 links repaired. 1 archived project(s) left alone.",
    );
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
    mockDayOfNote.mockReturnValue(null);
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("Not/A/Daily/Note.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileHabits).not.toHaveBeenCalled();
  });

  it("reconciles a daily note that falls within the current ISO week", async () => {
    mockDayOfNote.mockReturnValue(new Date());
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-07-01.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileHabits).toHaveBeenCalledOnce();
  });

  it("skips a daily note that falls outside the current ISO week", async () => {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    mockDayOfNote.mockReturnValue(sixMonthsAgo);
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-01-01.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileHabits).not.toHaveBeenCalled();
  });

  it("skips a daily note from earlier this week, even though it's the same ISO week", async () => {
    vi.setSystemTime(new Date(2026, 6, 1)); // Wednesday, July 1 2026
    mockDayOfNote.mockReturnValue(new Date(2026, 5, 29)); // Monday this same week
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-06-29.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileHabits).not.toHaveBeenCalled();
  });

  it("reconciles a later day in the current week, even though it isn't today", async () => {
    vi.setSystemTime(new Date(2026, 6, 1)); // Wednesday, July 1 2026
    mockDayOfNote.mockReturnValue(new Date(2026, 6, 3)); // Friday this same week
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-07-03.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileHabits).toHaveBeenCalledOnce();
  });

  it("moves inbox items targeted at the day into the note", async () => {
    mockDayOfNote.mockReturnValue(new Date());
    const plugin = makePlugin();
    await plugin.loadSettings();

    await internals(plugin).maybeReconcileDailyNote("2026-07-01.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockMigrateInboxTargets).toHaveBeenCalledOnce();
  });

  it("still migrates inbox targets for a day beyond this week, where habits are skipped", async () => {
    vi.setSystemTime(new Date(2026, 6, 1)); // Wednesday, July 1 2026
    mockDayOfNote.mockReturnValue(new Date(2026, 6, 8)); // Wednesday next week
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-07-08.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileHabits).not.toHaveBeenCalled();
    expect(mockMigrateInboxTargets).toHaveBeenCalledOnce();
  });

  it("leaves the inbox alone for a day that has already passed", async () => {
    vi.setSystemTime(new Date(2026, 6, 1));
    mockDayOfNote.mockReturnValue(new Date(2026, 5, 29));
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-06-29.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockMigrateInboxTargets).not.toHaveBeenCalled();
  });

  it("debounces repeated opens of the same daily note into a single reconcile", async () => {
    mockDayOfNote.mockReturnValue(new Date());
    const plugin = makePlugin();

    await internals(plugin).maybeReconcileDailyNote("2026-07-01.md");
    await internals(plugin).maybeReconcileDailyNote("2026-07-01.md");
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockReconcileHabits).toHaveBeenCalledOnce();
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
