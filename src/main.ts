import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Notice } from "obsidian";
import { PMCompassSettingTab } from "./ui/settings-tab";
import { PMCompassSettings, DEFAULT_SETTINGS, StoredSettings, readSettings, writeSettings } from "./model/settings";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./ui/task-graph-view";
import { PMCompassView, DASHBOARD_VIEW_TYPE } from "./ui/pm-compass-view";
import { loadVaultData, readObsidianPmSettings } from "./model/vault-reader";
import { DayMarkdownFile, readDailyNotesConfig, matchDailyNotePath } from "./model/day-markdown-file";
import { backfillRecurringHabits } from "./model/operations/recurring-task-backfill";
import { isTodayOrLaterInWeek } from "./model/recurring-task";
import { diffDays } from "./model/dates";
import { migrateInboxTargets, resolveInboxPath } from "./model/operations/day-task-actions";
import { repairListings, unlinkDeletedTask, type RepairResult } from "./model/operations/listing-repair";
import { syncChangedNote } from "./model/operations/listing-sync";
import type { Project, Task } from "./model/shared";

const RECONCILE_DEBOUNCE_MS = 800;

export default class PMCompassPlugin extends Plugin {
  settings: PMCompassSettings = DEFAULT_SETTINGS;
  private reconcileTimers = new Map<string, number>();

  /**
   * Listing notes whose checklist is known to agree with the tasks it names — only
   * there can a disagreeing box be read as a fresh edit rather than a note predating
   * the sync. Notes join through the opening pass, or one at a time as they change,
   * which catches one arriving mid-session from a sync or a restored backup.
   */
  private readonly verifiedListings = new Set<string>();

  /** The opening pass, kept so a second render awaits it rather than starting another. */
  private listingsPass: Promise<void> | null = null;

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

    this.addCommand({
      id: "repair-project-listings",
      name: "Check project and subtask listings against the tasks that exist",
      callback: () => {
        void this.runListingRepair();
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

    // A note that leaves a path takes its listing's good standing with it: whatever
    // arrives there next is one nobody has checked.
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        this.verifiedListings.delete(file.path);
        // Deleted through the plugin, this is a no-op — the entry is already gone.
        void unlinkDeletedTask(this.app, file.path).catch((e: unknown) => {
          console.error("pm-compass: couldn't unlink the deleted task", e);
        });
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (_file: TAbstractFile, oldPath: string) => {
        this.verifiedListings.delete(oldPath);
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
    if (diffDays(new Date(), date) < 0) return;
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

  /**
   * Start the opening pass over every listing the vault holds, once per session, and
   * hand back the promise for a caller that wants to wait. Skipped when the user has
   * turned it off — each note then earns its standing the first time it changes.
   *
   * Not something a render should block on: the pass reads every project and task note,
   * and a note changed while it runs is simply one it hasn't reached, which
   * `syncChangedNote` already handles by answering its boxes with the statuses.
   */
  ensureListingsVerified(projects: Project[], tasks: Task[]): Promise<void> {
    if (!this.settings.verifyListingsOnLoad) return Promise.resolve();
    this.listingsPass ??= this.repairAndMark(projects, tasks).then(
      () => undefined,
      (e: unknown) => {
        // Left unmarked, so the notes fall back to being checked one at a time.
        console.error("pm-compass: couldn't check the project listings", e);
      },
    );
    return this.listingsPass;
  }

  /** Repair every listing, and take the notes it covered as checked. */
  private async repairAndMark(projects: Project[], tasks: Task[]): Promise<RepairResult> {
    const result = await repairListings(this.app, projects, tasks);
    for (const p of projects) this.verifiedListings.add(p.filePath);
    for (const t of tasks) this.verifiedListings.add(t.filePath);
    return result;
  }

  /** `syncChangedNote` against this session's record of which listings have been checked. */
  syncChangedNote(filePath: string, data: string): Promise<void> {
    return syncChangedNote(this.app, this.verifiedListings, filePath, data);
  }

  private async runListingRepair(): Promise<void> {
    const { projects, tasks } = await loadVaultData(this.app, this.settings.projectsFolder);
    const { listingsRewritten, prefixesFixed } = await this.repairAndMark(projects, tasks);
    new Notice(
      `Checked project listings: ${listingsRewritten} notes updated, ${prefixesFixed} links repaired.`,
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
    ) as Partial<StoredSettings>;
    // `splitTaskLists` under its old name. Unmigrated, a stored "off" is dropped as an
    // unknown key and silently reads as the default.
    if (!("splitTaskLists" in saved) && typeof saved["splitDailyTasks"] === "boolean") {
      known.splitTaskLists = saved["splitDailyTasks"];
    }
    this.settings = { ...DEFAULT_SETTINGS, ...readSettings(known) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(writeSettings(this.settings));
  }

  /** Re-renders any open dashboard, so a setting that changes what it shows takes
   *  effect while the settings tab is still up rather than on the next refresh. */
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
