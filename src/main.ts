import { Plugin, WorkspaceLeaf, TFile } from "obsidian";
import { Icon } from "./ui/icons";
import { PMCompassSettingTab } from "./ui/settings-tab";
import { PMCompassSettings, DEFAULT_SETTINGS, StoredSettings, readSettings, writeSettings } from "./model/settings";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./ui/task-graph-view";
import { PMCompassView, DASHBOARD_VIEW_TYPE } from "./ui/pm-compass-view";
import { readObsidianPmSettings } from "./model/project/obsidian-pm-settings";
import { VaultData } from "./model/service/vault-data";
import type { TaskService } from "./model/service/task-service";

export default class PMCompassPlugin extends Plugin {
  settings: PMCompassSettings = DEFAULT_SETTINGS;
  /** Everything the plugin reads comes from here. Built with the plugin rather than in
   *  `onload`, so a view constructed from a restored layout always finds it — it reads the
   *  settings through a closure, so it needs none of them yet. */
  readonly vault = new VaultData(this.app, () => this.settings);

  /** The day notes and the inbox, which the vault holds beside the projects folder. */
  get tasks(): TaskService {
    return this.vault.tasks;
  }

  async onload(): Promise<void> {
    // First: `syncFromObsidianPm` reads `settings.syncObsidianPmSettings`.
    await this.loadSettings();
    await this.syncFromObsidianPm();

    this.vault.start();
    // Watching begins at once, so nothing that changes from here is missed; the reading waits
    // for the vault to have been built. A plugin loads before Obsidian has finished listing
    // the files, so a walk taken now finds a folder that is still filling up — and the
    // listing pass that hangs off it would vouch for a handful of notes and never run again.
    // Unawaited either way: the views read through the cache, and this only fills it first.
    this.app.workspace.onLayoutReady(() => { this.vault.warm(); });

    this.registerView(
      TASK_GRAPH_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new TaskGraphView(leaf, this),
    );

    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new PMCompassView(leaf, this),
    );

    this.addRibbonIcon(Icon.OpenDashboard, "Open project manager dashboard", () => {
      void this.activateDashboard();
    });

    this.addRibbonIcon(Icon.OpenTaskGraph, "Open task graph", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-dashboard",
      name: "Open project manager dashboard",
      callback: () => {
        void this.activateDashboard();
      },
    });

    this.addCommand({
      id: "open-task-graph",
      name: "Open task dependency graph",
      callback: () => {
        void this.activateView();
      },
    });

    // A day note that has been opened is one the cache puts back in step: its habits, and
    // the inbox items aimed at it. One that has just appeared it hears about itself; this
    // is a workspace event, which the model layer has no business knowing about.
    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (file) this.tasks.reconcileDay(file.path);
      }),
    );

    this.addSettingTab(new PMCompassSettingTab(this.app, this));
  }

  onunload(): void {
    this.vault.dispose();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData() ?? {}) as Record<string, unknown>;
    // Only keys with a default left are kept; a dropped setting would otherwise ride
    // along in data.json forever.
    const known = Object.fromEntries(
      Object.entries(saved).filter(([key]) => key in DEFAULT_SETTINGS),
    ) as Partial<StoredSettings>;
    // `splitTaskLists` under its old name: unmigrated, a stored "off" is dropped as an
    // unknown key and reads as the default.
    if (!("splitTaskLists" in saved) && typeof saved["splitDailyTasks"] === "boolean") {
      known.splitTaskLists = saved["splitDailyTasks"];
    }
    this.settings = { ...DEFAULT_SETTINGS, ...readSettings(known) };
    // Picked toggle by toggle for the same reason as the keys above: spread whole, one an
    // older install stored and this one has dropped would ride along in data.json forever.
    this.settings.panelConfig = {
      showActiveOnly: known.panelConfig?.showActiveOnly ?? DEFAULT_SETTINGS.panelConfig.showActiveOnly,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(writeSettings(this.settings));
    // A changed projects folder makes what the cache holds another folder's. Not awaited:
    // the reads that follow await it themselves.
    void this.vault.reconfigure();
  }

  /** Re-renders any open dashboard, so a setting takes effect while the settings tab
   *  is still up. */
  refreshDashboard(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      if (leaf.view instanceof PMCompassView) void leaf.view.render();
    }
  }

  private async syncFromObsidianPm(): Promise<void> {
    if (!this.settings.syncObsidianPmSettings) return;
    const pmSettings = await readObsidianPmSettings(this.app);
    if (pmSettings) {
      this.settings.projectsFolder = pmSettings.projectsFolder;
      await this.saveSettings();
    }
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(TASK_GRAPH_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: TASK_GRAPH_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async activateDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
