import { App, ItemView, Platform, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import { loadVaultData } from "../model/vault-reader";
import { readDailyNotesConfig } from "../model/day-markdown-file";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./dashboard-view";
import {
  resolveInboxPath, readInboxItems, loadDayChecklist, resolveInboxSortDir, migrateInboxTargets,
} from "../model/day-task-actions";
import { InboxSortBy } from "../model/task-vocabulary";
import { InboxView } from "./inbox-view";
import { WeekSummaryView } from "./week-summary-view";
import { backfillRecurringHabits } from "../model/recurring-task-backfill";
import { asFrontmatterRecord } from "../model/file-helpers";
import { REFRESH_SVG, setSvgIcon } from "./icons";
import { OffscreenRefreshGate } from "./offscreen-refresh-gate";

export { DASHBOARD_VIEW_TYPE };

interface AppWithSetting extends App {
  setting?: { open?: () => void; openTabById?: (id: string) => void };
}

export class PMCompassView extends ItemView {
  plugin: PMCompassPlugin;

  private watchedDailyPaths = new Set<string>();
  private rendering = false;
  private renderLater = false;
  private closed = false;
  private containerSyncTimer: number | null = null;
  private readonly EDIT_DEBOUNCE_MS = 2000;
  private readonly CHANGE_DEBOUNCE_MS = 300;
  private activeTab: "tasks" | "stats" | "inbox" = "tasks";

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
    this.dashboardView = new DashboardView(this.app, plugin, refresh);
    this.inboxView = new InboxView(this.app, plugin, refresh);
    this.weekSummaryView = new WeekSummaryView(this.app, plugin, refresh);
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    // "PM Compass" is the plugin's name — see the sentence-case exemption in
    // eslint.config.mjs for why the rule can't be satisfied here.
    return "PM Compass dashboard";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.refreshGate.register();
    await this.render();

    // Refresh when a task file changes or is deleted.
    // Also backfill the `completed` date if a task was marked done externally.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        if (!this.isInProjectsFolder(file.path)) return;
        const fm = asFrontmatterRecord(this.app.metadataCache.getFileCache(file)?.frontmatter);
        if (fm?.["pm-task"] && fm["status"] === "done" && !fm["completed"]) {
          void this.app.fileManager.processFrontMatter(file, (m: Record<string, unknown>) => {
            if (m["status"] === "done" && !m["completed"]) {
              m["completed"] = new Date().toISOString();
            }
          });
          // The write fires another changed event which will scheduleRefresh.
          return;
        }
        this.scheduleRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (this.isInProjectsFolder(file.path)) this.scheduleRefresh();
      }),
    );

    // Refresh when any watched daily note is modified or created.
    // Use a longer debounce for modify events to avoid rebuilding while the user is actively editing.
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (this.watchedDailyPaths.has(file.path)) this.scheduleRefresh(this.EDIT_DEBOUNCE_MS);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (this.watchedDailyPaths.has(file.path)) this.scheduleRefresh();
      }),
    );

    // On Android the keyboard resizing the WebView leaves `.pm-dash-container`'s `flex: 1`
    // stuck mid-recompute at a near-zero height, which reads as the view going black; forcing
    // a reflow doesn't dislodge it. Sidestep the flex algorithm instead: measure
    // `.view-content` and pin the container's height explicitly. Scoped to the whole view,
    // since every field in it hits this, including ones with no keyboard-handling code of
    // their own (the day-task note textarea).
    //
    // Observed on `.view-content` because that is the element being measured. Nothing else
    // reports the change — `visualViewport`'s `resize` never fires on Android, and the refresh
    // gate watches `containerEl`, whose header makes it the wrong size — and an observer on it
    // is guaranteed to fire again on the frame the layout settles on.
    if (Platform.isMobile) {
      const observer = new ResizeObserver(() => this.scheduleContainerSync());
      observer.observe(this.contentEl);
      this.register(() => observer.disconnect());
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.refreshGate.cancel();
    if (this.containerSyncTimer !== null) window.clearTimeout(this.containerSyncTimer);
  }

  /** Re-measures once the layout has settled: resizes arrive one per frame of the keyboard's
   *  transition, and any frame but the last reads a height still being recomputed. */
  private scheduleContainerSync(): void {
    // The observer is disconnected on unload, a step after `onClose`, so a resize can still
    // land here with nothing left to clear the timer.
    if (this.closed) return;
    if (this.containerSyncTimer !== null) window.clearTimeout(this.containerSyncTimer);
    this.containerSyncTimer = window.setTimeout(() => {
      this.containerSyncTimer = null;
      this.syncContainerHeight();
    }, 50);
  }

  /** Explicitly pins `.pm-dash-container` to its parent's current measured height, instead of
   *  leaving it to `flex: 1` — see the comment in `onOpen` for why. */
  private syncContainerHeight(): void {
    const container = this.contentEl.querySelector<HTMLElement>(".pm-dash-container");
    const parent = container?.parentElement;
    if (!container || !parent) return;
    // Measure the parent's *content* box: `.view-content`'s bottom padding is the safe-area
    // inset, and spending it would push the last of the list off the screen. With the keyboard
    // up Obsidian swaps that padding for `--keyboard-height` and, on Android, shrinks the
    // element by the same amount (738px/48px becomes 379px/359px), so subtracting the padding
    // whole counts the keyboard twice and leaves 8px. Keep only its excess over the keyboard.
    const style = getComputedStyle(parent);
    const keyboard =
      parseFloat(getComputedStyle(document.body).getPropertyValue("--keyboard-height")) || 0;
    const safeArea = Math.max(0, parseFloat(style.paddingBottom) - keyboard);

    // Where the space the keyboard leaves uncovered ends. Taken off the viewport rather than by
    // subtracting `--keyboard-height` again, so that a platform which shrinks the layout
    // (Android, where this term never binds) and one which only overlays it both have the
    // keyboard taken out exactly once.
    const viewport = window.visualViewport;
    const visibleBottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;

    const rect = parent.getBoundingClientRect();
    const top = rect.top + parseFloat(style.paddingTop);
    const bottom = Math.min(rect.bottom - safeArea, visibleBottom);
    const contentHeight = bottom - top;

    // Two unusable measurements needing opposite answers, told apart by the parent's height:
    //  - no height at all is a view built inside a closed drawer or a background tab. Pinning
    //    `0 0 0px` would blank it and stick, since a swipe-open fires nothing to correct it —
    //    hand the height back to the stylesheet's `flex: 1`.
    //  - a height the padding swallows is the keyboard mid-flight, the transition the pin
    //    exists to ride out. Releasing here drops the view back onto the flex recompute that
    //    leaves it near zero, so keep the current pin and wait for the settled pass.
    if (contentHeight <= 0 && parent.clientHeight > 0) return;
    const flex = contentHeight > 0 ? `0 0 ${contentHeight}px` : "";
    if (container.style.flex !== flex) container.style.flex = flex;

    // The WebView scrolls `.view-content` to reveal the focused field, against the layout as it
    // stood mid-transition, and leaves it there — on an `overflow: hidden` box the user cannot
    // scroll back (measured: 149px of the view out of reach). The pinned container always fits
    // its parent, so any scroll here is that stray one.
    if (parent.scrollTop !== 0) parent.scrollTop = 0;
  }

  private openPluginSettings(): void {
    // Obsidian's `app.setting` controller isn't part of the public API types, but is
    // stable and commonly used by plugins to deep-link into their own settings tab.
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
    // A render already under way may be past its own vault reads, so it can't be assumed to
    // cover this request: queue one more pass instead of dropping it. Dropping it would also
    // lose the refresh outright, since the gate clears its pending flag before calling in.
    if (this.rendering) {
      this.renderLater = true;
      return;
    }
    this.rendering = true;
    let renderAgain = false;
    try {
      const { contentEl } = this;
      const scrollTop = contentEl.querySelector(".pm-dash-content")?.scrollTop ?? 0;
      // The inbox add-input is recreated on every render, so re-render (e.g. right after
      // adding a task) would otherwise silently steal focus away and dismiss the keyboard.
      const focusedInboxInput = activeDocument.activeElement === contentEl.querySelector(".pm-inbox-add-input");

      // Build the new tree off-screen and swap it in once fully populated, instead of
      // emptying contentEl up front — otherwise the view sits blank (visible as a
      // black flash behind the on-screen keyboard) for the duration of the awaits below.
      const container = createDiv();
      container.addClass("pm-dash-container");

      const header = container.createDiv({ cls: "pm-dash-header" });
      header.createSpan({ cls: "pm-dash-title", text: "PM Compass" });

      const refreshBtn = header.createEl("button", {
        cls: "pm-dash-refresh-btn",
        attr: { "aria-label": "Refresh" },
      });
      setSvgIcon(refreshBtn, REFRESH_SVG);
      refreshBtn.addEventListener("click", () => void this.render());

      const settingsBtn = header.createEl("button", {
        cls: "pm-dash-settings-btn",
        attr: { "aria-label": "Open project manager compass settings" },
      });
      setIcon(settingsBtn, "settings");
      settingsBtn.addEventListener("click", () => this.openPluginSettings());

      const content = container.createDiv({ cls: "pm-dash-content" });

      // Keep the current week's recurring habits complete before reading anything —
      // Dashboard and Week Summary both depend on this; Inbox doesn't, so skip it there.
      if (this.activeTab !== "inbox") {
        await backfillRecurringHabits(this.app, this.plugin.settings);
      }

      const dnConfig = await readDailyNotesConfig(this.app);
      const resolvedInboxPath = resolveInboxPath(this.plugin.settings.inboxFilePath, dnConfig);

      // Inbox items planned for a day that now has a note belong in that note — done
      // before the reads below so both lists show the item where it ended up. Runs on
      // every tab: the item can be due today whether or not the dashboard is open.
      await migrateInboxTargets(
        this.app, resolvedInboxPath, this.plugin.settings.dailyTasksHeading, dnConfig,
      );

      const inboxSortBy = this.plugin.settings.inboxSortBy ?? InboxSortBy.Created;
      const [{ items: checklistItems, filePath: dnPath }, vaultData, adjacentData, inboxItems] = await Promise.all([
        loadDayChecklist(this.app, this.dashboardView.dashboardDate, dnConfig),
        loadVaultData(this.app, this.plugin.settings.projectsFolder),
        this.dashboardView.loadAdjacentUnclosed(this.dashboardView.dashboardDate, dnConfig),
        readInboxItems(
          this.app, resolvedInboxPath, inboxSortBy,
          resolveInboxSortDir(inboxSortBy, this.plugin.settings.inboxSortDir),
        ),
      ]);

      this.watchedDailyPaths = new Set([
        ...(dnPath ? [dnPath] : []),
        ...adjacentData.map((d) => d.filePath).filter((p): p is string => p !== null),
        resolvedInboxPath,
      ]);
      const { tasks, projects } = vaultData;

      // Propagate allTasks to sub-views so event handlers (task modal, context menu) have the full list.
      this.dashboardView.allTasks = tasks;
      this.weekSummaryView.allTasks = tasks;
      this.inboxView.allTasks = tasks;

      const staleAfterDays = this.plugin.settings.inboxStaleAfterDays ?? 7;
      const hasStaleInboxItems = staleAfterDays > 0 && inboxItems.some((item) => {
        if (!item.createdAt) return false;
        return Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000) >= staleAfterDays;
      });

      // Tab bar — rendered after data so the Inbox tab can show a stale warning badge
      const tabBar = container.createDiv({ cls: "pm-dash-tabs" });
      container.insertBefore(tabBar, content);
      for (const [id, label] of [["inbox", "Inbox"], ["tasks", "Dashboard"], ["stats", "Week Summary"]] as const) {
        const btn = tabBar.createEl("button", {
          cls: `pm-dash-tab${this.activeTab === id ? " pm-dash-tab--active" : ""}`,
        });
        if (id === "inbox" && hasStaleInboxItems) {
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

      if (this.activeTab === "stats") {
        await this.weekSummaryView.render(content, tasks, projects, dnConfig);
      } else if (this.activeTab === "inbox") {
        await this.inboxView.render(content, resolvedInboxPath, inboxItems, staleAfterDays, projects);
      } else {
        this.dashboardView.render(content, checklistItems, dnPath, tasks, projects, adjacentData, resolvedInboxPath);
      }

      contentEl.empty();
      contentEl.appendChild(container);
      content.scrollTop = scrollTop;
      if (focusedInboxInput) {
        container.querySelector<HTMLInputElement>(".pm-inbox-add-input")?.focus();
      }
      if (Platform.isMobile) this.syncContainerHeight();
    } finally {
      this.rendering = false;
      // Cleared here, not at the replay below, so a render that threw doesn't leave the flag
      // set and make some later render run twice. A failed render forfeits its replay — it
      // would only fail the same way; the next change re-arms the gate.
      renderAgain = this.renderLater;
      this.renderLater = false;
    }
    // Not once the view is gone: the replay would rebuild a detached tree and re-run the
    // vault writes at the top of this method.
    if (renderAgain && !this.closed) await this.render();
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
