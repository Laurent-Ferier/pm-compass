import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Notice } from "obsidian";
import { PMCompassSettingTab } from "./ui/settings-tab";
import { PMCompassSettings, DEFAULT_SETTINGS } from "./model/settings";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./ui/task-graph-view";
import { PMCompassView, DASHBOARD_VIEW_TYPE } from "./ui/pm-compass-view";
import { readObsidianPmSettings } from "./model/vault-reader";
import { DayMarkdownFile, readDailyNotesConfig, matchDailyNotePath } from "./model/day-markdown-file";
import { backfillRecurringHabits } from "./model/recurring-task-backfill";
import { isTodayOrLaterInWeek } from "./model/recurring-task";

const RECONCILE_DEBOUNCE_MS = 800;

export default class PMCompassPlugin extends Plugin {
  settings: PMCompassSettings = DEFAULT_SETTINGS;
  private reconcileTimers = new Map<string, ReturnType<typeof window.setTimeout>>();

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
      (leaf: WorkspaceLeaf) => new PMCompassView(leaf, this),
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

    this.addCommand({
      id: "backfill-recurring-habits",
      name: "Backfill recurring habits for this week",
      callback: () => {
        void this.runBackfill();
      },
    });

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (file instanceof TFile) void this.maybeReconcileDailyNote(file.path);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (file) void this.maybeReconcileDailyNote(file.path);
      }),
    );

    this.addSettingTab(new PMCompassSettingTab(this.app, this));
  }

  onunload(): void {
    for (const timer of this.reconcileTimers.values()) window.clearTimeout(timer);
    this.reconcileTimers.clear();
  }

  private async maybeReconcileDailyNote(filePath: string): Promise<void> {
    const config = await readDailyNotesConfig(this.app);
    const date = matchDailyNotePath(filePath, config);
    if (!date) return;
    // Only today and the remaining days of the current week are ever reconciled automatically —
    // reopening an old note (even one from earlier this week) should never retroactively insert
    // a habit that didn't exist (or was configured differently) at the time.
    if (!isTodayOrLaterInWeek(date, new Date())) return;
    this.scheduleReconcile(filePath, date);
  }

  private scheduleReconcile(filePath: string, date: Date): void {
    const existing = this.reconcileTimers.get(filePath);
    if (existing) window.clearTimeout(existing);
    this.reconcileTimers.set(
      filePath,
      window.setTimeout(() => {
        this.reconcileTimers.delete(filePath);
        void this.runReconcile(filePath, date);
      }, RECONCILE_DEBOUNCE_MS),
    );
  }

  private async runReconcile(filePath: string, date: Date): Promise<void> {
    const dmf = new DayMarkdownFile(this.app, filePath);
    await dmf.reconcileRecurringHabits(
      this.settings.recurringTasks,
      date,
      this.settings.recurringTasksHeading,
      this.settings.dailyHabitsTag,
    );
  }

  private async runBackfill(): Promise<void> {
    const { filesChanged, filesCreated } = await backfillRecurringHabits(this.app, this.settings);
    new Notice(`Backfilled habits: ${filesChanged} notes updated, ${filesCreated} notes created.`);
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
