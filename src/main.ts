import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Notice } from "obsidian";
import { PMCompassSettingTab } from "./ui/settings-tab";
import { PMCompassSettings, DEFAULT_SETTINGS } from "./model/settings";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./ui/task-graph-view";
import { PMCompassView, DASHBOARD_VIEW_TYPE } from "./ui/pm-compass-view";
import { readObsidianPmSettings } from "./model/vault-reader";
import { DayMarkdownFile, readDailyNotesConfig, matchDailyNotePath } from "./model/day-markdown-file";
import { backfillRecurringHabits } from "./model/recurring-task-backfill";
import { isTodayOrLaterInWeek } from "./model/recurring-task";
import { formatDate } from "./model/day-task";
import { migrateInboxTargets, resolveInboxPath } from "./model/day-task-actions";

const RECONCILE_DEBOUNCE_MS = 800;

export default class PMCompassPlugin extends Plugin {
  settings: PMCompassSettings = DEFAULT_SETTINGS;
  private reconcileTimers = new Map<string, number>();

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

    this.addRibbonIcon("gauge", "Open project manager dashboard", () => {
      void this.activateDashboard();
    });

    this.addRibbonIcon("workflow", "Open task graph", () => {
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
    // Past notes are left alone entirely: neither a habit nor an inbox item belongs in a
    // day that is already over.
    if (formatDate(date) < formatDate(new Date())) return;
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
    // Only today and the remaining days of the current week get habits — reopening an old
    // note (even one from earlier this week) should never retroactively insert a habit that
    // didn't exist (or was configured differently) at the time.
    if (isTodayOrLaterInWeek(date, new Date())) {
      const dmf = new DayMarkdownFile(this.app, filePath);
      await dmf.reconcileRecurringHabits(
        this.settings.recurringTasks,
        date,
        this.settings.recurringTasksHeading,
        this.settings.dailyHabitsTag,
      );
    }
    // The day now has a note, so inbox items that were only waiting on it can land in its
    // checklist — without this they'd sit in the inbox until the dashboard is next opened.
    const config = await readDailyNotesConfig(this.app);
    await migrateInboxTargets(
      this.app,
      resolveInboxPath(this.settings.inboxFilePath, config),
      this.settings.dailyTasksHeading,
      config,
    );
  }

  private async runBackfill(): Promise<void> {
    const { filesChanged, filesCreated } = await backfillRecurringHabits(this.app, this.settings);
    new Notice(`Backfilled habits: ${filesChanged} notes updated, ${filesCreated} notes created.`);
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData() ?? {}) as Record<string, unknown>;
    // Only keys the plugin still has a default for are kept: a setting that has since been
    // dropped would otherwise ride along in data.json forever, resaved on every write.
    const known = Object.fromEntries(
      Object.entries(saved).filter(([key]) => key in DEFAULT_SETTINGS),
    ) as Partial<PMCompassSettings>;
    this.settings = { ...DEFAULT_SETTINGS, ...known };
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
