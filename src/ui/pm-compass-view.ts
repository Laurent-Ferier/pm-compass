import { App, ItemView, Platform, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import { loadVaultData } from "../model/vault-reader";
import { readDailyNotesConfig } from "../model/day-markdown-file";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./dashboard-view";
import { resolveInboxPath, readInboxItems, loadDayChecklist } from "../model/day-task-actions";
import { InboxView } from "./inbox-view";
import { WeekSummaryView } from "./week-summary-view";
import { backfillRecurringHabits } from "../model/recurring-task-backfill";
import { asFrontmatterRecord } from "../model/file-helpers";
import { REFRESH_SVG, setSvgIcon } from "./icons";

export { DASHBOARD_VIEW_TYPE };

interface AppWithSetting extends App {
  setting?: { open?: () => void; openTabById?: (id: string) => void };
}

export class PMCompassView extends ItemView {
  plugin: PMCompassPlugin;

  private watchedDailyPaths = new Set<string>();
  private refreshTimer: number | null = null;
  private rendering = false;
  private keyboardResizeTimer: number | null = null;
  private onVisualViewportResize: (() => void) | null = null;
  private readonly EDIT_DEBOUNCE_MS = 2000;
  private readonly CHANGE_DEBOUNCE_MS = 300;
  private activeTab: "tasks" | "stats" | "inbox" = "tasks";

  private readonly dashboardView: DashboardView;
  private readonly inboxView: InboxView;
  private readonly weekSummaryView: WeekSummaryView;

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

    // On Android, the on-screen keyboard resizing the WebView leaves `.pm-dash-container`'s flex
    // layout (`flex: 1` against `.view-content`) stuck mid-recompute — it settles at a near-zero
    // height instead of filling the resized `.view-content`, which reads as the whole view going
    // black. Rather than trust the browser to redo that flex computation correctly (toggling
    // `display` to force a reflow was tried and didn't help — the stale size survives it),
    // sidestep the flex algorithm during the transition by measuring `.view-content` directly and
    // setting `.pm-dash-container`'s height explicitly. Scoped to the whole view (not e.g.
    // inbox-view's own input) since this hits every field in `.pm-dash-container`, including ones
    // with no keyboard-handling code of their own (the day-task note textarea).
    if (Platform.isMobile && window.visualViewport) {
      this.onVisualViewportResize = () => {
        if (this.keyboardResizeTimer !== null) window.clearTimeout(this.keyboardResizeTimer);
        this.keyboardResizeTimer = window.setTimeout(() => {
          this.keyboardResizeTimer = null;
          this.syncContainerHeight();
        }, 50);
      };
      window.visualViewport.addEventListener("resize", this.onVisualViewportResize);
    }
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.keyboardResizeTimer !== null) window.clearTimeout(this.keyboardResizeTimer);
    if (this.onVisualViewportResize && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this.onVisualViewportResize);
      this.onVisualViewportResize = null;
    }
  }

  /** Explicitly pins `.pm-dash-container` to its parent's current measured height, instead of
   *  leaving it to `flex: 1` — see the comment in `onOpen` for why. */
  private syncContainerHeight(): void {
    const container = this.contentEl.querySelector<HTMLElement>(".pm-dash-container");
    const parent = container?.parentElement;
    if (!container || !parent) return;
    // Measure the parent's *content* box, not its border box: on mobile `.view-content`
    // carries a bottom padding equal to the safe-area inset, and pinning the container to
    // the border-box height would spend that reserved space and push the last of the list
    // off the bottom of the screen.
    // Clamped at 0: subtracting the padding can go negative if the keyboard leaves the
    // parent shorter than its own padding, and a negative flex-basis is an invalid
    // declaration that the CSSOM drops — silently leaving the *previous* pinned height.
    const style = getComputedStyle(parent);
    const contentHeight = Math.max(
      0,
      parent.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    );
    container.style.flex = `0 0 ${contentHeight}px`;
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
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.render();
    }, delayMs);
  }

  async render(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
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
      const [{ items: checklistItems, filePath: dnPath }, vaultData, adjacentData, inboxItems] = await Promise.all([
        loadDayChecklist(this.app, this.dashboardView.dashboardDate, dnConfig),
        loadVaultData(this.app, this.plugin.settings.projectsFolder),
        this.dashboardView.loadAdjacentUnclosed(this.dashboardView.dashboardDate, dnConfig),
        readInboxItems(this.app, resolvedInboxPath, this.plugin.settings.inboxSortBy),
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
    }
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
