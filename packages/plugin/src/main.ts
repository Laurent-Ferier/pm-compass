import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  PMCompassSettingTab,
  PMCompassSettings,
  DEFAULT_SETTINGS,
} from "./settings";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./dashboard-view";
import { readObsidianPmSettings } from "./vault-reader";

export default class PMCompassPlugin extends Plugin {
  settings: PMCompassSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    // loadSettings must run first: syncFromObsidianPm reads settings.syncObsidianPmSettings.
    await this.loadSettings();
    await this.syncFromObsidianPm();

    this.registerView(
      TASK_GRAPH_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new TaskGraphView(leaf, this),
    );

    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new DashboardView(leaf, this),
    );

    this.addRibbonIcon("gauge", "Open PM Dashboard", () => {
      void this.activateDashboard();
    });

    this.addRibbonIcon("workflow", "Open Task Graph", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-dashboard",
      name: "Open PM dashboard",
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

    this.addSettingTab(new PMCompassSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(TASK_GRAPH_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(DASHBOARD_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData() as Partial<PMCompassSettings>,
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: TASK_GRAPH_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async activateDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
