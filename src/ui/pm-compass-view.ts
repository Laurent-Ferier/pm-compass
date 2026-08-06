import { App, ItemView, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import { activeProjects, withoutArchivedTasks } from "../model/project/archive";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./dashboard-view";
import { migrateInboxTargets } from "../model/daily/day-task-actions";
import { isStaleInboxItem } from "../model/daily/day-task";
import { InboxView } from "./inbox-view";
import { WeekSummaryView } from "./week-summary-view";
import { backfillRecurringHabits } from "../model/daily/recurring-task-backfill";
import { Icon } from "./icons";
import { OffscreenRefreshGate } from "./offscreen-refresh-gate";
import { StoreEvent } from "../model/store/store-events";

export { DASHBOARD_VIEW_TYPE };

/** The tabs this view switches between. */
export enum CompassTab {
  Inbox = "inbox",
  Dashboard = "tasks",
  WeekSummary = "stats",
}

/** The tab bar, in the order it lists them. */
const TABS = [
  [CompassTab.Inbox, "Inbox"],
  [CompassTab.Dashboard, "Dashboard"],
  [CompassTab.WeekSummary, "Week Summary"],
] as const;

interface AppWithSetting extends App {
  setting?: { open?: () => void; openTabById?: (id: string) => void };
}

export class PMCompassView extends ItemView {
  plugin: PMCompassPlugin;

  private rendering = false;
  private renderLater = false;
  private closed = false;
  private containerSyncTimer: number | null = null;
  private readonly EDIT_DEBOUNCE_MS = 2000;
  private readonly CHANGE_DEBOUNCE_MS = 300;
  private activeTab: CompassTab = CompassTab.Dashboard;

  private readonly dashboardView: DashboardView;
  private readonly inboxView: InboxView;
  private readonly weekSummaryView: WeekSummaryView;
  private readonly refreshGate = new OffscreenRefreshGate(
    this,
    () => { void this.render(); },
    () => { if (Platform.isMobile) this.scheduleContainerSync(); },
  );

  constructor(leaf: WorkspaceLeaf, plugin: PMCompassPlugin) {
    super(leaf);
    this.plugin = plugin;
    const refresh = () => this.scheduleRefresh();
    // Where every date on a row leads: the Dashboard, on that day — a change of tab
    // from anywhere else.
    const showDay = (date: Date) => {
      this.dashboardView.setDate(date);
      this.activeTab = CompassTab.Dashboard;
      void this.render();
    };
    this.dashboardView = new DashboardView(this.app, plugin, refresh, showDay);
    this.inboxView = new InboxView(this.app, plugin, refresh, showDay);
    this.weekSummaryView = new WeekSummaryView(this.app, plugin, refresh, showDay);
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  /** Put a changed note and the checklists it takes part in back in step. */
  private syncListings(file: TFile, data: string): void {
    this.plugin.syncChangedNote(file.path, data).catch((e) => {
      console.error("pm-compass: couldn't sync the checklist", e);
    });
  }

  getDisplayText(): string {
    // "PM Compass" is the plugin's name — hence the exemption in eslint.config.mjs.
    return "PM Compass dashboard";
  }

  getIcon(): string {
    return Icon.DashboardTab;
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.refreshGate.register();
    await this.render();

    // Backfills `completed` for a task marked done outside the plugin, and answers the
    // note's checklist boxes. Neither redraws anything: the store's own event does that.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile, data: string) => {
        if (!this.isInProjectsFolder(file.path)) return;
        const vault = this.plugin.vault;
        const note = vault.taskNotes.note(file.path);
        if (note.needsCompletedStamp()) {
          // Sync behind the stamp: together they would write this file at once.
          void note.stampCompleted()
            .catch((e: unknown) => { console.error("pm-compass: couldn't stamp the completion date", e); })
            .then(() => this.syncListings(file, data));
          return;
        }
        this.syncListings(file, data);
      }),
    );

    // Whatever changed, the store has already re-read it. A day note takes the longer
    // debounce: it is the one a user types into with the dashboard beside it, and a
    // rebuild mid-keystroke moves the rows under them.
    const store = this.plugin.tasks;
    this.register(this.plugin.vault.projectNotes.on(StoreEvent.ProjectsChanged, () => this.scheduleRefresh()));
    this.register(store.on(StoreEvent.DaysChanged, () => this.scheduleRefresh(this.EDIT_DEBOUNCE_MS)));
    this.register(store.on(StoreEvent.InboxChanged, () => this.scheduleRefresh()));

    // On Android the keyboard resizing the WebView leaves `.pm-dash-container`'s `flex: 1`
    // stuck near zero, which reads as the view going black, and no reflow dislodges it. So
    // the flex algorithm is sidestepped: measure `.view-content` and pin the height.
    //
    // Observed on `.view-content` because that is what is measured, and because nothing
    // else reports the change — `visualViewport`'s `resize` never fires on Android.
    if (Platform.isMobile) {
      const observer = new ResizeObserver(() => this.scheduleContainerSync());
      observer.observe(this.contentEl);
      this.register(() => observer.disconnect());
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.refreshGate.cancel();
    // Every tab, not just the one on show: each holds the markdown of its last pass.
    this.dashboardView.dispose();
    this.inboxView.dispose();
    this.weekSummaryView.dispose();
    if (this.containerSyncTimer !== null) window.clearTimeout(this.containerSyncTimer);
  }

  /** Re-measures once the layout has settled: resizes arrive one per frame of the
   *  keyboard's transition, and any but the last reads a height still being recomputed. */
  private scheduleContainerSync(): void {
    // The observer outlives `onClose` by a step, so a resize can still land here.
    if (this.closed) return;
    if (this.containerSyncTimer !== null) window.clearTimeout(this.containerSyncTimer);
    this.containerSyncTimer = window.setTimeout(() => {
      this.containerSyncTimer = null;
      this.syncContainerHeight();
    }, 50);
  }

  /** Pins `.pm-dash-container` to its parent's measured height rather than leaving it to
   *  `flex: 1` — see `onOpen` for why. */
  private syncContainerHeight(): void {
    const container = this.contentEl.querySelector<HTMLElement>(".pm-dash-container");
    const parent = container?.parentElement;
    if (!container || !parent) return;
    // The parent's *content* box: its bottom padding is the safe-area inset, and spending
    // it would push the end of the list off screen. With the keyboard up Obsidian swaps
    // that padding for `--keyboard-height`, so only its excess over the keyboard counts.
    const style = getComputedStyle(parent);
    const keyboard =
      parseFloat(getComputedStyle(document.body).getPropertyValue("--keyboard-height")) || 0;
    const safeArea = Math.max(0, parseFloat(style.paddingBottom) - keyboard);

    // Where the space the keyboard leaves ends. Read off the viewport rather than by
    // subtracting `--keyboard-height` again, so a platform that shrinks the layout and one
    // that only overlays it both take the keyboard out exactly once.
    const viewport = window.visualViewport;
    const visibleBottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;

    const rect = parent.getBoundingClientRect();
    const top = rect.top + parseFloat(style.paddingTop);
    const bottom = Math.min(rect.bottom - safeArea, visibleBottom);
    const contentHeight = bottom - top;

    // Two unusable measurements needing opposite answers, told apart by the parent:
    //  - no height at all is a closed drawer or a background tab, and pinning `0 0 0px`
    //    would blank it for good, so hand the height back to `flex: 1`.
    //  - a height the padding swallows is the keyboard mid-flight, which the pin exists
    //    to ride out — keep it and wait for the settled pass.
    if (contentHeight <= 0 && parent.clientHeight > 0) return;
    const flex = contentHeight > 0 ? `0 0 ${contentHeight}px` : "";
    if (container.style.flex !== flex) container.style.flex = flex;

    // The WebView scrolls `.view-content` to reveal the focused field against the layout
    // mid-transition and leaves it there, out of reach on an `overflow: hidden` box. The
    // pinned container always fits its parent, so any scroll here is that stray one.
    if (parent.scrollTop !== 0) parent.scrollTop = 0;
  }

  private openPluginSettings(): void {
    // `app.setting` isn't in the public API types, but is stable and widely used to
    // deep-link into a plugin's own settings tab.
    const setting = (this.app as unknown as AppWithSetting).setting;
    setting?.open?.();
    setting?.openTabById?.(this.plugin.manifest.id);
  }

  private isInProjectsFolder(filePath: string): boolean {
    return filePath.startsWith(this.plugin.settings.projectsFolder + "/");
  }

  private scheduleRefresh(delayMs = this.CHANGE_DEBOUNCE_MS): void {
    this.refreshGate.schedule(delayMs);
  }

  async render(): Promise<void> {
    // Callers the close can't reach — a queued click handler, the replay at the end — have no
    // way to know the leaf went away, and there is nothing left to draw into.
    if (this.closed) return;
    // A render under way may be past its own vault reads, so it can't be assumed to cover
    // this request; the gate has already cleared its pending flag, so dropping it loses it.
    if (this.rendering) {
      this.renderLater = true;
      return;
    }
    this.rendering = true;
    let renderAgain = false;
    try {
      const { contentEl } = this;
      const scrollTop = contentEl.querySelector(".pm-dash-content")?.scrollTop ?? 0;
      // The add-input is rebuilt every render, which would otherwise steal the focus and
      // dismiss the keyboard.
      const focusedAddInput = activeDocument.activeElement === contentEl.querySelector(".pm-add-input");

      // The new tree is built off-screen and swapped in once populated; emptying contentEl
      // up front would leave the view blank for the length of the awaits below.
      const container = createDiv();
      container.addClass("pm-dash-container");

      const header = container.createDiv({ cls: "pm-dash-header" });
      header.createSpan({ cls: "pm-dash-title", text: "PM Compass" });

      const refreshBtn = header.createEl("button", {
        cls: "pm-dash-refresh-btn",
        attr: { "aria-label": "Refresh" },
      });
      setIcon(refreshBtn, Icon.Refresh);
      refreshBtn.addEventListener("click", () => void this.render());

      const settingsBtn = header.createEl("button", {
        cls: "pm-dash-settings-btn",
        attr: { "aria-label": "Open project manager compass settings" },
      });
      setIcon(settingsBtn, Icon.Settings);
      settingsBtn.addEventListener("click", () => this.openPluginSettings());

      const content = container.createDiv({ cls: "pm-dash-content" });

      // The week's habits are completed before anything is read. Only the Inbox, which
      // doesn't depend on them, skips it.
      if (this.activeTab !== CompassTab.Inbox) {
        await backfillRecurringHabits(this.app, this.plugin.settings);
      }

      const store = this.plugin.tasks;
      const vault = this.plugin.vault;
      const dnConfig = store.dailyNotesConfig;
      const resolvedInboxPath = store.inboxPath;

      // Inbox items planned for a day that now has a note belong in it — moved before the
      // reads below, and on every tab, since an item can come due with any of them open.
      await migrateInboxTargets(
        this.app, resolvedInboxPath, this.plugin.settings.dailyTasksHeading, dnConfig,
      );

      const [dayEntry, vaultData, inboxItems] = await Promise.all([
        store.day(this.dashboardView.dashboardDate),
        vault.load(),
        store.inbox(),
      ]);

      const checklistItems = dayEntry.items;
      const dnPath = dayEntry.exists ? dayEntry.path : null;
      const { tasks, projects } = vaultData;
      // Started, not waited on: it reads every note, and until it reaches one
      // `syncChangedNote` answers that note's boxes with the statuses.
      void this.plugin.ensureListingsVerified(projects, tasks);

      // An archived project is put away, not undone: the Week summary keeps reporting the
      // week it had, while the tabs that show what is live drop it.
      const liveProjects = activeProjects(projects);
      const liveTasks = withoutArchivedTasks(tasks, projects);

      // The sub-views' handlers — task modal, context menu — need the full list.
      this.dashboardView.allTasks = liveTasks;
      this.weekSummaryView.allTasks = tasks;
      this.inboxView.allTasks = liveTasks;

      const staleAfterDays = this.plugin.settings.inboxStaleAfterDays ?? 7;
      const hasStaleInboxItems = inboxItems.some((item) => isStaleInboxItem(item, staleAfterDays));

      // Rendered after the data, so the Inbox tab can carry a stale warning badge.
      const tabBar = container.createDiv({ cls: "pm-dash-tabs" });
      container.insertBefore(tabBar, content);
      for (const [id, label] of TABS) {
        const btn = tabBar.createEl("button", {
          cls: `pm-dash-tab${this.activeTab === id ? " pm-dash-tab--active" : ""}`,
        });
        if (id === CompassTab.Inbox && hasStaleInboxItems) {
          btn.createSpan({ cls: "pm-inbox-warn-badge", text: "⚠️" });
        }
        btn.createSpan({ text: label });
        btn.addEventListener("click", () => {
          if (this.activeTab !== id) {
            this.activeTab = id;
            void this.render();
          }
        });
      }

      // Whichever tab this render draws, the tree the last fill was writing into is going.
      this.dashboardView.stopFill();
      if (this.activeTab === CompassTab.WeekSummary) {
        await this.weekSummaryView.render(content, tasks, projects);
      } else if (this.activeTab === CompassTab.Inbox) {
        await this.inboxView.render(content, resolvedInboxPath, inboxItems, staleAfterDays, liveProjects);
      } else {
        // Every inbox line aimed at a day, for the dashboard to place; `migrateInboxTargets`
        // above filed all but the note-less days'.
        const plannedItems = inboxItems
          .filter((item) => item.scheduledDate)
          .map((item) => item.withSource(resolvedInboxPath));
        this.dashboardView.render(
          content, checklistItems, dnPath, liveTasks, liveProjects, resolvedInboxPath, plannedItems,
        );
      }

      // Checked again: the view can close while the reads run, leaving the tree just built
      // belonging to a leaf that is gone.
      if (this.closed) return;
      contentEl.empty();
      contentEl.appendChild(container);
      content.scrollTop = scrollTop;
      if (focusedAddInput) {
        container.querySelector<HTMLInputElement>(".pm-add-input")?.focus();
      }
      if (Platform.isMobile) this.syncContainerHeight();

      // Started once the tab is on screen: the neighbouring days' rows run to dozens of
      // notes, and they drop into the horizons one day at a time as the store reads them.
      if (this.activeTab === CompassTab.Dashboard) this.dashboardView.fillAdjacentDays();
    } finally {
      this.rendering = false;
      // Cleared here, so a render that threw doesn't leave the flag set and make a later
      // one run twice. Its replay is forfeit — it would only fail the same way.
      renderAgain = this.renderLater;
      this.renderLater = false;
    }
    if (renderAgain) await this.render();
  }

  selectTask(taskId: string): boolean {
    const rows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`));
    const row = rows.find(r => r.offsetParent !== null) ?? rows[0] ?? null;
    if (!row) return false;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.addClass("pm-dash-task-row--selected");
    window.setTimeout(() => row.removeClass("pm-dash-task-row--selected"), 2000);
    return true;
  }
}
