import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

vi.mock("./vault-reader", () => ({
  readObsidianPmSettings: vi.fn(),
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
  const normalizePath = (p: string) => p;
  const setIcon = () => {};
  const moment = () => ({ format: () => "", startOf: () => ({ diff: () => 0 }), diff: () => 0 });
  return { Plugin, WorkspaceLeaf, PluginSettingTab, Setting, Modal, ItemView, TAbstractFile, TFile, normalizePath, setIcon, moment };
});

import { readObsidianPmSettings } from "./vault-reader";
import PMCompassPlugin from "./main";

const mockReadSettings = vi.mocked(readObsidianPmSettings);

function makePlugin() {
  const mockApp = { workspace: { detachLeavesOfType: vi.fn() } };
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
  it("detaches both view type leaves from the workspace", () => {
    const plugin = makePlugin();

    plugin.onunload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detach = (plugin.app as any).workspace.detachLeavesOfType as ReturnType<typeof vi.fn>;
    expect(detach).toHaveBeenCalledWith("pm-compass-task-graph");
    expect(detach).toHaveBeenCalledWith("pm-compass-dashboard");
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
