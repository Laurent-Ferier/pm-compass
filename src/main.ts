import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Notice } from "obsidian";
import { Icon } from "./ui/icons";
import { PMCompassSettingTab } from "./ui/settings-tab";
import { PMCompassSettings, DEFAULT_SETTINGS, StoredSettings, readSettings, writeSettings } from "./model/settings";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./ui/task-graph-view";
import { PMCompassView, DASHBOARD_VIEW_TYPE } from "./ui/pm-compass-view";
import { readObsidianPmSettings } from "./model/project/obsidian-pm-settings";
import { activeProjects, withoutArchivedTasks } from "./model/project/archive";
import { backfillRecurringHabits } from "./model/daily/recurring-task-backfill";
import { isTodayOrLaterInWeek } from "./model/daily/recurring-task";
import { diffDays } from "./model/dates";
import { migrateInboxTargets } from "./model/daily/day-task-actions";
import { repairListings, unlinkDeletedTask, type RepairResult } from "./model/project/listing-repair";
import { syncChangedNote } from "./model/project/listing-sync";
import { VaultData } from "./model/store/vault-data";
import type { TaskStore } from "./model/store/task-store";
import type { Project } from "./model/project/project";
import type { Task } from "./model/project/task";

const RECONCILE_DEBOUNCE_MS = 800;

export default class PMCompassPlugin extends Plugin {
  settings: PMCompassSettings = DEFAULT_SETTINGS;
  /** Everything the plugin reads comes from here. Built with the plugin rather than in
   *  `onload`, so a view constructed from a restored layout always finds it — it reads the
   *  settings through a closure, so it needs none of them yet. */
  readonly vault = new VaultData(this.app, () => this.settings);
  private reconcileTimers = new Map<string, number>();

  /** The day notes and the inbox, which the vault holds beside the projects folder. */
  get tasks(): TaskStore {
    return this.vault.taskStore;
  }

  /** Notes whose checklist is known to agree with the tasks it names — only there can a
   *  disagreeing box be read as a fresh edit rather than a note predating the sync. */
  private readonly verifiedListings = new Set<string>();

  /** The opening pass, kept so a second render awaits it rather than starting another. */
  private listingsPass: Promise<void> | null = null;

  async onload(): Promise<void> {
    // First: `syncFromObsidianPm` reads `settings.syncObsidianPmSettings`.
    await this.loadSettings();
    await this.syncFromObsidianPm();

    this.vault.start();
    // Unawaited: the views read through the store either way, and this only means they
    // find it already filled.
    this.vault.warm();

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
        if (file instanceof TFile) this.maybeReconcileDailyNote(file.path);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (file) this.maybeReconcileDailyNote(file.path);
      }),
    );

    // A note leaving a path takes its listing's good standing with it; whatever arrives
    // there next is unchecked.
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        this.verifiedListings.delete(file.path);
        // A no-op for a deletion through the plugin, which dropped the entry already.
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
    this.vault.dispose();
  }

  private maybeReconcileDailyNote(filePath: string): void {
    const date = this.tasks.dayOfNote(filePath);
    if (!date) return;
    // A past note is left alone: neither a habit nor an inbox item belongs in a day over.
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
    // Only today and the rest of the week get habits: reopening an older note must not
    // insert one that didn't exist, or was configured differently, at the time.
    if (isTodayOrLaterInWeek(date, new Date())) {
      await this.tasks.reconcileHabits(filePath, date);
    }
    // The day has a note now, so the inbox items waiting on it can land in its checklist
    // rather than sit there until the dashboard is next opened.
    await migrateInboxTargets(
      this.app,
      this.tasks.inboxPath,
      this.settings.dailyTasksHeading,
      this.tasks.dailyNotesConfig,
    );
  }

  /**
   * Starts the opening pass over every listing in the vault, once per session, handing
   * back its promise. Nothing should block a render on it: it reads every note, and one
   * changed while it runs is simply one it hasn't reached — which `syncChangedNote`
   * handles by answering that note's boxes with the statuses.
   */
  ensureListingsVerified(projects: Project[], tasks: Task[]): Promise<void> {
    if (!this.settings.verifyListingsOnLoad) return Promise.resolve();
    this.listingsPass ??= this.repairAndMark(projects, tasks).then(
      () => undefined,
      (e: unknown) => {
        // Left unmarked, so the notes fall back to being checked one by one.
        console.error("pm-compass: couldn't check the project listings", e);
      },
    );
    return this.listingsPass;
  }

  /**
   * Repair every live listing, and take the notes it covered as checked. Archived projects
   * are left out and left unmarked, so the pass doesn't rewrite notes that have been put
   * away — one edited by hand is still repaired on its own by `syncChangedNote`.
   */
  private async repairAndMark(allProjects: Project[], allTasks: Task[]): Promise<RepairResult> {
    const projects = activeProjects(allProjects);
    const tasks = withoutArchivedTasks(allTasks, allProjects);
    const result = await repairListings(this.vault, projects, tasks);
    for (const p of projects) this.verifiedListings.add(p.filePath);
    for (const t of tasks) this.verifiedListings.add(t.filePath);
    return result;
  }

  /** `syncChangedNote` against this session's record of which listings have been checked. */
  syncChangedNote(filePath: string, data: string): Promise<void> {
    return syncChangedNote(this.vault, this.verifiedListings, filePath, data);
  }

  private async runListingRepair(): Promise<void> {
    const { projects, tasks } = await this.vault.load();
    const { listingsRewritten, prefixesFixed } = await this.repairAndMark(projects, tasks);
    // Said out loud: the command skips what it skips, rather than reporting a clean pass
    // over notes it never opened.
    const archived = projects.length - activeProjects(projects).length;
    const skipped = archived ? ` ${archived} archived project(s) left alone.` : "";
    new Notice(
      `Checked project listings: ${listingsRewritten} notes updated, ${prefixesFixed} links repaired.${skipped}`,
    );
  }

  private async runBackfill(): Promise<void> {
    const { filesChanged, filesCreated } = await backfillRecurringHabits(this.app, this.settings);
    new Notice(`Backfilled habits: ${filesChanged} notes updated, ${filesCreated} notes created.`);
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
    // A changed projects folder makes what the store holds another folder's. Not awaited:
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
