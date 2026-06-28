import { App, ItemView, Menu, TAbstractFile, TFile, WorkspaceLeaf, moment as _moment, normalizePath, setIcon } from "obsidian";
// Obsidian declares moment as `typeof namespace` which loses the call signature in TS5 bundler mode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import type PMCompassPlugin from "./main";
import { loadVaultData } from "./vault-reader";
import { TaskModal, ConfirmModal, patchTaskField, deleteTaskFile, openDropdown, openNoteFile } from "./task-creator";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";
import type { Task, Project } from "@pm-compass/shared";

export const DASHBOARD_VIEW_TYPE = "pm-compass-dashboard";

const PRIORITY_SCORE: Record<string, number> = {
  critical: 400,
  high: 300,
  medium: 200,
  low: 100,
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#22c55e",
};

const PRIORITY_LABELS: Record<string, string> = {
  "": "None",
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const STATUS_COLORS: Record<string, string> = {
  "todo": "#6b7280",
  "in-progress": "#3b82f6",
  "blocked": "#ef4444",
  "review": "#8b5cf6",
  "done": "#22c55e",
  "cancelled": "#9ca3af",
};

const STATUS_LABELS: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "blocked": "Blocked",
  "review": "Review",
  "done": "Done",
  "cancelled": "Cancelled",
};

const STATUSES = ["todo", "in-progress", "blocked", "review", "done", "cancelled"] as const;
const PRIORITIES = ["", "critical", "high", "medium", "low"] as const;

const DONE_STATUSES = new Set(["done", "cancelled"]);

const CHEVRON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const INFO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
const NAV_PREV_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const NAV_NEXT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
const CALENDAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

function buildProgressCircle(opts: {
  size: number;
  r: number;
  strokeWidth: number;
  ratio: number;
  svgClass: string;
  trackDim?: boolean;
  emptyFill?: boolean;
  label?: string;
}): SVGSVGElement {
  const { size, r, strokeWidth, ratio, svgClass, trackDim, emptyFill, label } = opts;
  const cx = size / 2;
  const circ = 2 * Math.PI * r;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg") as SVGSVGElement;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.addClass(svgClass);
  const track = document.createElementNS(svgNS, "circle");
  track.setAttribute("cx", String(cx)); track.setAttribute("cy", String(cx)); track.setAttribute("r", String(r));
  track.setAttribute("fill", "none"); track.setAttribute("stroke-width", String(strokeWidth));
  track.addClass("pm-dash-circle-track");
  if (trackDim) track.addClass("pm-dash-circle-track--dim");
  svg.appendChild(track);
  if (ratio > 0) {
    const fillLen = ratio * circ;
    const fill = document.createElementNS(svgNS, "circle");
    fill.setAttribute("cx", String(cx)); fill.setAttribute("cy", String(cx)); fill.setAttribute("r", String(r));
    fill.setAttribute("fill", "none"); fill.setAttribute("stroke-width", String(strokeWidth));
    fill.setAttribute("stroke-dasharray", `${fillLen} ${circ - fillLen}`);
    fill.setAttribute("stroke-dashoffset", String(circ / 4));
    fill.addClass("pm-dash-circle-fill");
    svg.appendChild(fill);
  } else if (emptyFill) {
    const fill = document.createElementNS(svgNS, "circle");
    fill.setAttribute("cx", String(cx)); fill.setAttribute("cy", String(cx)); fill.setAttribute("r", String(r));
    fill.setAttribute("fill", "none"); fill.setAttribute("stroke-width", String(strokeWidth));
    fill.setAttribute("stroke-dasharray", `${circ} 0`);
    fill.setAttribute("stroke-dashoffset", String(circ / 4));
    fill.addClass("pm-dash-circle-fill"); fill.addClass("pm-dash-circle-fill--empty");
    svg.appendChild(fill);
  }
  if (label !== undefined) {
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", String(cx)); text.setAttribute("y", String(cx + 1));
    text.setAttribute("text-anchor", "middle"); text.setAttribute("dominant-baseline", "middle");
    text.addClass("pm-dash-circle-label");
    text.textContent = label;
    svg.appendChild(text);
  }
  return svg;
}

function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

function getPriorityColor(priority: string | undefined): string {
  return PRIORITY_COLORS[priority ?? ""] ?? "";
}

function deadlinePoints(dueDate: string | undefined): number {
  if (!dueDate) return 0;
  const today = moment().startOf("day");
  const due = moment(dueDate, "YYYY-MM-DD").startOf("day");
  const days = due.diff(today, "days");
  if (days < 0) return 1000;
  if (days === 0) return 500;
  if (days === 1) return 200;
  if (days <= 3) return 100;
  if (days <= 7) return 50;
  if (days <= 14) return 20;
  return 5;
}


function daysLabel(dueDate: string): { text: string; overdue: boolean } {
  const today = moment().startOf("day");
  const due = moment(dueDate, "YYYY-MM-DD").startOf("day");
  const days = due.diff(today, "days");
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: "today", overdue: false };
  if (days === 1) return { text: "tomorrow", overdue: false };
  return { text: `in ${days}d`, overdue: false };
}

interface DailyNotesConfig {
  folder: string;
  format: string;
  template: string;
}

// Minimal interface for the Templater plugin internals we rely on.
interface TemplaterPlugin {
  templater: {
    create_new_note_from_template(
      template: TFile,
      folder?: string,
      filename?: string,
      open_new_note?: boolean,
    ): Promise<TFile | undefined>;
    overwrite_file_commands(file: TFile, force_overwrite?: boolean): Promise<void>;
  };
}

function getTemplater(app: App): TemplaterPlugin | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = (app as any).plugins?.plugins?.["templater-obsidian"] as
    | TemplaterPlugin
    | undefined;
  return plugin?.templater ? plugin : undefined;
}

async function readDailyNotesConfig(app: App): Promise<DailyNotesConfig> {
  const defaults: DailyNotesConfig = {
    folder: "",
    format: "YYYY-MM-DD",
    template: "",
  };
  try {
    const path = normalizePath(`${app.vault.configDir}/daily-notes.json`);
    const raw = await app.vault.adapter.read(path);
    const data = JSON.parse(raw) as Partial<DailyNotesConfig>;
    return {
      folder: data.folder ?? defaults.folder,
      format: data.format ?? defaults.format,
      template: data.template ?? defaults.template,
    };
  } catch {
    return defaults;
  }
}

async function ensureTodayNote(app: App): Promise<TFile | null> {
  const config = await readDailyNotesConfig(app);
  const todayStr = moment().format(config.format);
  const filePath = normalizePath(
    config.folder ? `${config.folder}/${todayStr}.md` : `${todayStr}.md`,
  );

  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) return existing;

  // Ensure the daily notes folder exists before creating the file.
  if (config.folder) {
    const folderPath = normalizePath(config.folder);
    if (!app.vault.getAbstractFileByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }
  }

  const templater = getTemplater(app);
  const templatePath = config.template
    ? normalizePath(
        config.template.endsWith(".md")
          ? config.template
          : `${config.template}.md`,
      )
    : null;
  const templateFile = templatePath
    ? app.vault.getAbstractFileByPath(templatePath)
    : null;

  if (templater && templateFile instanceof TFile) {
    // Let Templater create the file and execute embedded scripts in one step.
    const created = await templater.templater.create_new_note_from_template(
      templateFile,
      config.folder || undefined,
      todayStr,
      false, // don't open the note
    );
    return created ?? (app.vault.getAbstractFileByPath(filePath) as TFile | null);
  }

  // Fallback: create the file with raw template content (no script execution).
  let content = "";
  if (templateFile instanceof TFile) {
    content = await app.vault.read(templateFile);
  }
  return app.vault.create(filePath, content);
}

interface ChecklistItem {
  text: string;
  lineIndex: number;
  checked: boolean;
}

// Obsidian tag pattern: # followed by a non-digit, then any non-whitespace non-punctuation chars.
const TAG_PATTERN = /#[^ -⁯⸀-⹿'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/g;

function renderTextWithInlineTags(container: HTMLElement, text: string, app: App): void {
  TAG_PATTERN.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(text)) !== null) {
    if (match.index > last) container.appendText(text.slice(last, match.index));
    const tagName = match[0].slice(1); // strip leading #
    const a = container.createEl("a", { cls: "tag", text: match[0], href: match[0] });
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).internalPlugins?.plugins?.["global-search"]?.instance
        ?.openGlobalSearch(`tag:#${tagName}`);
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) container.appendText(text.slice(last));
}

async function loadDayChecklist(
  app: App,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
  config?: DailyNotesConfig,
): Promise<{ items: ChecklistItem[]; filePath: string | null }> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const dateStr = date.format(resolvedConfig.format);
  const expectedPath = normalizePath(
    resolvedConfig.folder ? `${resolvedConfig.folder}/${dateStr}.md` : `${dateStr}.md`,
  );

  // Only auto-create the note for today; for other dates just read if present.
  let file: TFile | null = null;
  if (date.isSame(moment(), "day")) {
    file = await ensureTodayNote(app);
  } else {
    const existing = app.vault.getAbstractFileByPath(expectedPath);
    file = existing instanceof TFile ? existing : null;
  }

  if (!file) return { items: [], filePath: null };

  const content = await app.vault.read(file);
  const items: ChecklistItem[] = [];
  content.split("\n").forEach((line, lineIndex) => {
    if (/^\s*-\s+\[x\]/i.test(line)) {
      const text = line.replace(/^\s*-\s+\[x\]\s*/i, "").trim();
      if (text) items.push({ text, lineIndex, checked: true });
    } else if (/^\s*-\s+\[ \]/.test(line)) {
      const text = line.replace(/^\s*-\s+\[ \]\s*/, "").trim();
      if (text) items.push({ text, lineIndex, checked: false });
    }
  });
  return { items, filePath: file.path };
}

async function toggleChecklistItem(
  app: App,
  filePath: string,
  lineIndex: number,
  checked: boolean,
  expectedText: string,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return;
  const content = await app.vault.read(file);
  const lines = content.split("\n");

  // Guard against the file being edited between render and click: verify the
  // captured lineIndex still points to the expected item; if not, search by text.
  let target = lineIndex;
  if (!lines[target]?.includes(expectedText)) {
    const found = lines.findIndex((l) => l.includes(expectedText));
    if (found === -1) return;
    target = found;
  }

  const line = lines[target];
  lines[target] = checked
    ? line.replace(/^(\s*-\s+)\[x\]/i, "$1[ ]")
    : line.replace(/^(\s*-\s+)\[ \]/, "$1[x]");
  await app.vault.modify(file, lines.join("\n"));
}

export class DashboardView extends ItemView {
  plugin: PMCompassPlugin;

  private allTasks: Task[] = [];
  private dailyNotePath: string | null = null;
  private refreshTimer: ReturnType<typeof window.setTimeout> | null = null;
  private rendering = false;
  private activeTab: "tasks" | "stats" = "tasks";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dashboardDate: any = moment();
  private weekOffset = 0;

  constructor(leaf: WorkspaceLeaf, plugin: PMCompassPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "PM Dashboard";
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
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (fm?.["pm-task"] && fm["status"] === "done" && !fm["completed"]) {
          void this.app.fileManager.processFrontMatter(file, (m) => {
            if (m["status"] === "done" && !m["completed"]) {
              m["completed"] = moment().format("YYYY-MM-DD");
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

    // Refresh when today's daily note is modified or created.
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (this.dailyNotePath && file.path === this.dailyNotePath) {
          this.scheduleRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (this.dailyNotePath && file.path === this.dailyNotePath) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
  }

  private isInProjectsFolder(filePath: string): boolean {
    return filePath.startsWith(this.plugin.settings.projectsFolder + "/");
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.render();
    }, 300);
  }

  async render(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      const { contentEl } = this;
      contentEl.empty();

      const container = contentEl.createDiv({ cls: "pm-dash-container" });

      const header = container.createDiv({ cls: "pm-dash-header" });
      header.createSpan({ cls: "pm-dash-title", text: "PM Compass" });

      const refreshBtn = header.createEl("button", {
        cls: "pm-dash-refresh-btn",
        attr: { "aria-label": "Refresh" },
      });
      refreshBtn.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
      refreshBtn.addEventListener("click", () => void this.render());

      // Tab bar
      const tabBar = container.createDiv({ cls: "pm-dash-tabs" });
      for (const [id, label] of [["tasks", "Dashboard"], ["stats", "Week Summary"]] as const) {
        const btn = tabBar.createEl("button", {
          cls: `pm-dash-tab${this.activeTab === id ? " pm-dash-tab--active" : ""}`,
          text: label,
        });
        btn.addEventListener("click", () => {
          if (this.activeTab !== id) {
            this.activeTab = id;
            void this.render();
          }
        });
      }

      const content = container.createDiv({ cls: "pm-dash-content" });

      const [{ items: checklistItems, filePath: dnPath }, vaultData, dnConfig] = await Promise.all([
        loadDayChecklist(this.app, this.dashboardDate),
        loadVaultData(this.app, this.plugin.settings.projectsFolder),
        readDailyNotesConfig(this.app),
      ]);

      this.dailyNotePath = dnPath;
      const { tasks, projects } = vaultData;
      this.allTasks = tasks;

      if (this.activeTab === "stats") {
        await this.renderStatsTab(content, tasks, projects, dnConfig);
      } else {
        this.renderTasksTab(content, checklistItems, dnPath, tasks, projects);
      }
    } finally {
      this.rendering = false;
    }
  }

  private renderTasksTab(
    content: HTMLElement,
    checklistItems: ChecklistItem[],
    dnPath: string | null,
    tasks: Task[],
    projects: Project[],
  ): void {
    // ── Date navigator ──────────────────────────────────────────────────────
    const dateNav = content.createDiv({ cls: "pm-dash-date-nav" });

    const isToday = this.dashboardDate.isSame(moment(), "day");

    // Hidden date input — triggered programmatically by the calendar button
    const dateInput = dateNav.createEl("input", { type: "date", cls: "pm-dash-date-picker-input" });
    dateInput.value = this.dashboardDate.format("YYYY-MM-DD");
    dateInput.addEventListener("change", () => {
      if (dateInput.value) {
        this.dashboardDate = moment(dateInput.value, "YYYY-MM-DD");
        void this.render();
      }
    });

    // Calendar icon button opens the date picker
    const calBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Pick date" } });
    calBtn.innerHTML = CALENDAR_SVG;
    calBtn.addEventListener("click", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (dateInput as any).showPicker(); } catch { dateInput.click(); }
    });

    // Date text — click to open the daily note
    const dateLabelText = dateNav.createSpan({
      cls: `pm-dash-date-text${isToday ? " pm-dash-date-text--today" : ""}`,
      text: this.dashboardDate.format("dddd, MMMM D"),
    });
    dateLabelText.addEventListener("click", () => {
      if (dnPath) openNoteFile(this.app, dnPath);
    });

    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));

    this.renderChecklistSection(content, checklistItems, dnPath, this.dashboardDate);

    const today = moment().startOf("day");
    const approachingDeadlines = activeTasks
      .filter((t) => {
        if (!t.due) return false;
        const days = moment(t.due, "YYYY-MM-DD").diff(today, "days");
        return days >= 0 && days <= 7;
      })
      .sort((a, b) =>
        moment(a.due!, "YYYY-MM-DD").diff(moment(b.due!, "YYYY-MM-DD")),
      );

    this.renderDeadlinesSection(content, approachingDeadlines, projectMap);

    const taskById = new Map(tasks.map((t) => [t.id, t]));

    // Precompute effective priority/due once per active task by walking the ancestor chain.
    // Breaks on cycles (visited set) and stops at done/cancelled ancestors (their deadlines are moot).
    const effectiveValuesMap = new Map<string, { priority: string | undefined; due: string | undefined }>();
    for (const task of activeTasks) {
      let priority = task.priority;
      let due = task.due;
      const visited = new Set<string>([task.id]);
      let current = task.parentId ? taskById.get(task.parentId) : undefined;
      while (current) {
        if (visited.has(current.id) || DONE_STATUSES.has(current.status)) break;
        visited.add(current.id);
        if (PRIORITY_SCORE[current.priority ?? ""] > (PRIORITY_SCORE[priority ?? ""] ?? 0)) {
          priority = current.priority;
        }
        if (current.due && (!due || current.due < due)) {
          due = current.due;
        }
        current = current.parentId ? taskById.get(current.parentId) : undefined;
      }
      effectiveValuesMap.set(task.id, { priority, due });
    }

    const priorityCandidates = activeTasks
      .filter((t) => { const e = effectiveValuesMap.get(t.id)!; return e.priority || e.due; })
      .sort((a, b) => {
        const ea = effectiveValuesMap.get(a.id)!;
        const eb = effectiveValuesMap.get(b.id)!;
        return (deadlinePoints(eb.due) + (PRIORITY_SCORE[eb.priority ?? ""] ?? 0))
             - (deadlinePoints(ea.due) + (PRIORITY_SCORE[ea.priority ?? ""] ?? 0));
      });

    // One O(n×depth) pass: collect all ancestor IDs of candidates so they can be suppressed.
    // Uses a visited set per candidate to guard against parentId cycles.
    const suppressedByDescendant = new Set<string>();
    for (const t of priorityCandidates) {
      const visited = new Set<string>();
      let current: string | undefined = t.parentId;
      while (current !== undefined && !visited.has(current)) {
        visited.add(current);
        suppressedByDescendant.add(current);
        current = taskById.get(current)?.parentId;
      }
    }

    const priorityQueue = priorityCandidates
      .filter((t) => !suppressedByDescendant.has(t.id))
      .slice(0, 15);

    this.renderPrioritySection(content, priorityQueue, projectMap);
  }

  private async renderStatsTab(
    content: HTMLElement,
    tasks: Task[],
    projects: Project[],
    config: DailyNotesConfig,
  ): Promise<void> {
    const weekStart = moment().startOf("isoWeek").add(this.weekOffset, "weeks");
    const weekEnd = moment(weekStart).endOf("isoWeek");
    const weekNumber = weekStart.isoWeek();
    const isCurrentWeek = this.weekOffset === 0;

    // ── Week navigator ──────────────────────────────────────────────────────
    const weekNav = content.createDiv({ cls: "pm-dash-date-nav" });

    const prevWeekBtn = weekNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Previous week" } });
    prevWeekBtn.innerHTML = NAV_PREV_SVG;
    prevWeekBtn.addEventListener("click", () => { this.weekOffset--; void this.render(); });

    const weekLabel = weekNav.createDiv({ cls: "pm-dash-week-label" });
    weekLabel.createSpan({ cls: "pm-dash-week-number", text: `Week ${weekNumber}` });
    weekLabel.createSpan({
      cls: "pm-dash-week-range",
      text: `${weekStart.format("MMM D")} – ${weekEnd.format("MMM D")}`,
    });

    const nextWeekBtn = weekNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Next week" } });
    nextWeekBtn.innerHTML = NAV_NEXT_SVG;
    nextWeekBtn.addEventListener("click", () => { this.weekOffset++; void this.render(); });

    if (!isCurrentWeek) {
      const thisWeekBtn = weekNav.createEl("button", { cls: "pm-dash-today-btn", text: "This week" });
      thisWeekBtn.addEventListener("click", () => { this.weekOffset = 0; void this.render(); });
    }

    const isInWeek = (dateStr: string | undefined): boolean => {
      if (!dateStr) return false;
      const d = moment(dateStr.slice(0, 10), "YYYY-MM-DD");
      return d.isSameOrAfter(weekStart, "day") && d.isSameOrBefore(weekEnd, "day");
    };

    const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));
    const completedThisWeek = tasks.filter((t) => isInWeek(t.completed));
    const createdThisWeek = tasks.filter((t) => isInWeek(t.createdAt));
    const inProgressTasks = activeTasks.filter((t) => t.status === "in-progress");
    const blockedTasks = activeTasks.filter((t) => t.status === "blocked");
    const projectMap = new Map(projects.map((p) => [p.id, p]));

    const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    const habitsTag = (this.plugin.settings.dailyHabitsTag || "daily").replace(/^#/, "");
    const habitsTagRe = new RegExp(`#${habitsTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

    // ── Data accumulation pass over 7 days (reads in parallel) ─────────────
    const itemCompletionCount = new Map<string, number>();
    const itemPresenceCount = new Map<string, number>();
    const itemCheckedDays = new Map<string, number[]>();
    const dailyData: Array<{ done: number; total: number; hasNote: boolean; isFuture: boolean; filePath: string }> = [];

    const dayEntries = Array.from({ length: 7 }, (_, i) => {
      const day = moment(weekStart).add(i, "days");
      const isFuture = day.isAfter(moment(), "day");
      const filePath = normalizePath(
        config.folder ? `${config.folder}/${day.format(config.format)}.md` : `${day.format(config.format)}.md`,
      );
      const file = this.app.vault.getAbstractFileByPath(filePath);
      return { isFuture, file: file instanceof TFile ? file : null, filePath };
    });
    const rawContents = await Promise.all(
      dayEntries.map(({ file }) => file ? this.app.vault.read(file) : Promise.resolve(null)),
    );

    for (let i = 0; i < 7; i++) {
      const { isFuture, file } = dayEntries[i];
      const raw = rawContents[i];
      let done = 0;
      let total = 0;
      if (raw !== null) {
        for (const line of raw.split("\n")) {
          if (/^\s*-\s+\[x\]/i.test(line)) {
            const text = line.replace(/^\s*-\s+\[x\]\s*/i, "").trim();
            if (text && habitsTagRe.test(text)) {
              done++;
              total++;
              itemCompletionCount.set(text, (itemCompletionCount.get(text) ?? 0) + 1);
              itemPresenceCount.set(text, (itemPresenceCount.get(text) ?? 0) + 1);
              if (!itemCheckedDays.has(text)) itemCheckedDays.set(text, []);
              itemCheckedDays.get(text)!.push(i);
            }
          } else if (/^\s*-\s+\[ \]/.test(line)) {
            const text = line.replace(/^\s*-\s+\[ \]\s*/, "").trim();
            if (text && habitsTagRe.test(text)) {
              total++;
              itemPresenceCount.set(text, (itemPresenceCount.get(text) ?? 0) + 1);
            }
          }
        }
      }
      dailyData.push({ done, total, hasNote: file !== null, isFuture, filePath: dayEntries[i].filePath });
    }

    // ── Task Habits (outer collapsible: grouped items + daily progress) ──────
    const habitsTooltip = `Only checklist items tagged #${habitsTag} are tracked here. Configure in plugin settings.`;
    const { body: habitsBody } = this.createCollapsibleSection(content, "Task Habits", "stats.habits", { tooltip: habitsTooltip });

    // ── Grouped habits (collapsible sub-section inside Task Habits) ─────────
    const { body: groupedBody } = this.createCollapsibleSection(habitsBody, "Weekly Recap", "stats.habitsGrouped", { sub: true });

    if (itemPresenceCount.size > 0) {
      const sortedItems = [...itemPresenceCount.keys()].sort((a, b) =>
        (itemCompletionCount.get(b) ?? 0) - (itemCompletionCount.get(a) ?? 0)
      );
      const itemsList = groupedBody.createDiv({ cls: "pm-dash-items-list" });
      for (const text of sortedItems) {
        const doneCount = itemCompletionCount.get(text) ?? 0;
        const presCount = itemPresenceCount.get(text)!;
        const checkedDays = itemCheckedDays.get(text) ?? [];
        const itemWrap = itemsList.createDiv({ cls: "pm-dash-item-wrap" });
        const row = itemWrap.createDiv({ cls: "pm-dash-item-row" });
        row.appendChild(buildProgressCircle({
          size: 28, r: 11, strokeWidth: 3, ratio: doneCount / presCount, svgClass: "pm-dash-item-circle",
        }));
        row.createSpan({ cls: `pm-dash-item-text${doneCount === 0 ? " pm-dash-item-text--never" : ""}`, text });
        row.createSpan({ cls: "pm-dash-item-count", text: `${doneCount}/${presCount}` });
        if (checkedDays.length > 0) {
          const chevron = row.createEl("button", { cls: "pm-dash-chevron pm-dash-item-chevron", attr: { "aria-label": "Show days" } });
          chevron.innerHTML = CHEVRON_SVG;
          const daysDiv = itemWrap.createDiv({ cls: "pm-dash-item-days" });
          for (const dayIdx of checkedDays) {
            const chip = daysDiv.createEl("button", { cls: "pm-dash-item-day-chip", text: DAY_ABBR[dayIdx] });
            chip.addEventListener("click", (e) => {
              e.stopPropagation();
              openNoteFile(this.app, dayEntries[dayIdx].filePath);
            });
          }
          row.addEventListener("click", () => {
            itemWrap.toggleClass("pm-dash-item-wrap--open", !itemWrap.hasClass("pm-dash-item-wrap--open"));
          });
        }
      }
    } else {
      groupedBody.createDiv({ cls: "pm-dash-empty", text: `No #${habitsTag} checklist items found this week` });
    }

    // ── Daily Progress (collapsible sub-section inside Task Habits) ──────────
    const { body: dailyBody } = this.createCollapsibleSection(habitsBody, "Daily Progress", "stats.dailyProgress", { sub: true });
    const circlesRow = dailyBody.createDiv({ cls: "pm-dash-circles-row" });
    for (let i = 0; i < 7; i++) {
      const { done, total, hasNote, isFuture, filePath } = dailyData[i];
      const wrap = circlesRow.createDiv({ cls: `pm-dash-day-circle${hasNote ? " pm-dash-day-circle--clickable" : ""}` });
      wrap.appendChild(buildProgressCircle({
        size: 56, r: 20, strokeWidth: 4,
        ratio: hasNote && total > 0 ? done / total : 0,
        svgClass: "pm-dash-circle-svg",
        trackDim: isFuture || !hasNote,
        emptyFill: hasNote && total === 0,
        label: !hasNote ? "—" : total === 0 ? "—" : `${done}/${total}`,
      }));
      wrap.createSpan({ cls: "pm-dash-circle-day", text: DAY_ABBR[i] });
      if (hasNote) {
        wrap.addEventListener("click", () => openNoteFile(this.app, filePath));
      }
    }

    // ── Stat rows (collapsible section, expandable rows) ────────────────────
    const { body: statsBody } = this.createCollapsibleSection(content, "Week Stats", "stats.weekStats");
    const statDefs: [string, Task[], string][] = [
      ["Completed", completedThisWeek, STATUS_COLORS["done"]],
      ["Created", createdThisWeek, "#6366f1"],
      ["In Progress", inProgressTasks, STATUS_COLORS["in-progress"]],
      ["Blocked", blockedTasks, STATUS_COLORS["blocked"]],
    ];
    for (const [label, taskList, color] of statDefs) {
      const wrap = statsBody.createDiv({ cls: "pm-dash-stat-row" });
      const rowHeader = wrap.createDiv({ cls: "pm-dash-stat-row-header" });
      const num = rowHeader.createSpan({ cls: "pm-dash-stat-number", text: String(taskList.length) });
      num.style.color = color;
      rowHeader.createSpan({ cls: "pm-dash-stat-label", text: label });
      const chevron = rowHeader.createEl("button", { cls: "pm-dash-chevron", attr: { "aria-label": "Expand" } });
      chevron.innerHTML = CHEVRON_SVG;
      const expandList = wrap.createDiv({ cls: "pm-dash-expand-list" });
      this.renderExpandTaskList(expandList, taskList, projectMap);
      rowHeader.addEventListener("click", () => {
        wrap.toggleClass("pm-dash-stat-row--open", !wrap.hasClass("pm-dash-stat-row--open"));
      });
    }

    // ── Status breakdown (collapsible section, expandable bars) ─────────────
    const { body: statusBody } = this.createCollapsibleSection(content, "Active Tasks by Status", "stats.activeByStatus");
    const activeStatuses = ["todo", "in-progress", "blocked", "review"] as const;
    const totalActive = activeTasks.length;
    for (const s of activeStatuses) {
      const statusTasks = activeTasks.filter((t) => t.status === s);
      const wrap = statusBody.createDiv({ cls: "pm-dash-bar-wrap" });
      const barRow = wrap.createDiv({ cls: "pm-dash-bar-row" });
      barRow.createSpan({ cls: "pm-dash-bar-label", text: STATUS_LABELS[s] });
      const track = barRow.createDiv({ cls: "pm-dash-bar-track" });
      const fill = track.createDiv({ cls: "pm-dash-bar-fill" });
      fill.style.width = totalActive > 0 ? `${(statusTasks.length / totalActive) * 100}%` : "0%";
      fill.style.backgroundColor = STATUS_COLORS[s];
      barRow.createSpan({ cls: "pm-dash-bar-count", text: String(statusTasks.length) });
      const chevron = barRow.createEl("button", { cls: "pm-dash-chevron", attr: { "aria-label": "Expand" } });
      chevron.innerHTML = CHEVRON_SVG;
      const expandList = wrap.createDiv({ cls: "pm-dash-expand-list" });
      this.renderExpandTaskList(expandList, statusTasks, projectMap);
      barRow.addEventListener("click", () => {
        wrap.toggleClass("pm-dash-bar-wrap--open", !wrap.hasClass("pm-dash-bar-wrap--open"));
      });
    }

    // ── Completed this week by project ──────────────────────────────────────
    if (completedThisWeek.length > 0) {
      const projectSection = this.createSection(content, "Completed by Project");
      const byProject = new Map<string, { title: string; color: string | undefined; count: number }>();
      for (const task of completedThisWeek) {
        const proj = projectMap.get(task.projectId);
        if (!proj) continue;
        const entry = byProject.get(task.projectId);
        if (entry) { entry.count++; }
        else { byProject.set(task.projectId, { title: proj.title, color: proj.color, count: 1 }); }
      }
      const sorted = [...byProject.values()].sort((a, b) => b.count - a.count);
      for (const { title, color, count } of sorted) {
        const row = projectSection.createDiv({ cls: "pm-dash-proj-row" });
        const dot = row.createSpan({ cls: "pm-dash-proj-dot" });
        if (color) dot.style.backgroundColor = color;
        row.createSpan({ cls: "pm-dash-proj-name", text: title });
        const badge = row.createSpan({ cls: "pm-dash-proj-count", text: String(count) });
        if (color) { badge.style.backgroundColor = `${color}22`; badge.style.color = color; }
      }
    }
  }

  private renderExpandTaskList(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
  ): void {
    if (tasks.length === 0) {
      container.createDiv({ cls: "pm-dash-expand-empty", text: "No tasks" });
      return;
    }
    for (const task of tasks) {
      const row = container.createDiv({ cls: "pm-dash-expand-task" });
      row.createSpan({ cls: "pm-dash-expand-task-title", text: task.title });
      const proj = projectMap.get(task.projectId);
      if (proj) {
        const badge = row.createSpan({ cls: "pm-dash-expand-task-project", text: proj.title });
        if (proj.color) badge.style.borderLeftColor = proj.color;
      }
      row.addEventListener("click", () => void this.openInGraph(task));
    }
  }

  private renderChecklistSection(
    container: HTMLElement,
    items: ChecklistItem[],
    filePath: string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    date: any,
  ): void {
    const isToday = date.isSame(moment(), "day");
    const dateLabel = isToday ? "Today" : date.format("MMM D");
    const { body } = this.createCollapsibleSection(container, `${dateLabel}'s Checklist`, "tasks.checklist");

    if (items.length === 0) {
      body.createDiv({
        cls: "pm-dash-empty",
        text: `No checklist items in ${dateLabel.toLowerCase()}'s note`,
      });
      return;
    }

    const list = body.createEl("ul", { cls: "pm-dash-checklist" });
    for (const item of items) {
      const li = list.createEl("li", {
        cls: `pm-dash-checklist-item${item.checked ? " pm-dash-checklist-item--checked" : ""}`,
      });

      const box = li.createSpan({ cls: "pm-dash-checkbox" });
      if (item.checked) box.addClass("pm-dash-checkbox--checked");

      renderTextWithInlineTags(li.createSpan({ cls: "pm-dash-checklist-text" }), item.text, this.app);

      if (filePath) {
        li.addEventListener("click", () => {
          void toggleChecklistItem(this.app, filePath, item.lineIndex, item.checked, item.text).then(() => {
            // Optimistic local toggle — avoids a full re-render on every click.
            item.checked = !item.checked;
            li.toggleClass("pm-dash-checklist-item--checked", item.checked);
            box.toggleClass("pm-dash-checkbox--checked", item.checked);
          });
        });
      }
    }
  }

  private renderDeadlinesSection(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
  ): void {
    const { body } = this.createCollapsibleSection(container, "Approaching Deadlines", "tasks.deadlines");
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No tasks due within 7 days" });
      return;
    }
    for (const task of tasks) this.renderTaskRow(body, task, projectMap);
  }

  private renderPrioritySection(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
  ): void {
    const { body } = this.createCollapsibleSection(container, "Priority Queue", "tasks.priority");
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No prioritized tasks" });
      return;
    }
    for (const task of tasks) this.renderTaskRow(body, task, projectMap);
  }

  private createSection(container: HTMLElement, title: string): HTMLElement {
    const section = container.createDiv({ cls: "pm-dash-section" });
    section.createDiv({ cls: "pm-dash-section-header" }).createSpan({
      cls: "pm-dash-section-title",
      text: title,
    });
    return section;
  }

  private createCollapsibleSection(
    container: HTMLElement,
    title: string,
    key: string,
    options?: { tooltip?: string; sub?: boolean },
  ): { section: HTMLElement; body: HTMLElement } {
    const isCollapsed = this.plugin.settings.dashboardCollapsed[key] ?? false;
    const section = container.createDiv({
      cls: `pm-dash-section${options?.sub ? " pm-dash-section--sub" : ""}`,
    });

    const header = section.createDiv({ cls: "pm-dash-section-header pm-dash-section-header--collapsible" });
    const chevron = header.createSpan({
      cls: `pm-dash-section-chevron${isCollapsed ? " pm-dash-section-chevron--collapsed" : ""}`,
    });
    chevron.innerHTML = CHEVRON_SVG;
    header.createSpan({ cls: "pm-dash-section-title", text: title });

    if (options?.tooltip) {
      const info = header.createSpan({ cls: "pm-dash-section-info", attr: { title: options.tooltip } });
      info.innerHTML = INFO_SVG;
    }

    const body = section.createDiv({ cls: "pm-dash-section-body" });
    if (isCollapsed) body.style.display = "none";

    header.addEventListener("click", () => {
      const nowCollapsed = !(this.plugin.settings.dashboardCollapsed[key] ?? false);
      this.plugin.settings.dashboardCollapsed[key] = nowCollapsed;
      void this.plugin.saveSettings();
      chevron.toggleClass("pm-dash-section-chevron--collapsed", nowCollapsed);
      body.style.display = nowCollapsed ? "none" : "";
    });

    return { section, body };
  }

  private renderTaskRow(
    container: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
  ): void {
    const row = container.createDiv({ cls: "pm-dash-task-row" });
    row.dataset.taskId = task.id;

    // Priority ribbon — click to change priority
    const ribbonColor = getPriorityColor(task.priority);
    const ribbon = row.createDiv({ cls: "pm-dash-task-ribbon" });
    if (ribbonColor) ribbon.style.backgroundColor = ribbonColor;
    ribbon.title = `Priority: ${PRIORITY_LABELS[task.priority ?? ""] ?? "None"}`;
    ribbon.addEventListener("click", (e) => {
      e.stopPropagation();
      openDropdown(
        ribbon,
        PRIORITIES.map((p) => ({
          label: PRIORITY_LABELS[p] ?? p,
          color: PRIORITY_COLORS[p] ?? "#6b7280",
          onSelect: () => {
            void patchTaskField(this.app, task.filePath, "priority", p).then(
              () => this.scheduleRefresh(),
            );
          },
        })),
      );
    });

    // Body
    const body = row.createDiv({ cls: "pm-dash-task-body" });
    body.createDiv({ cls: "pm-dash-task-title", text: task.title });

    const meta = body.createDiv({ cls: "pm-dash-task-meta" });

    // Project badge
    const project = projectMap.get(task.projectId);
    if (project) {
      const badge = meta.createSpan({ cls: "pm-dash-task-project", text: project.title });
      if (project.color) badge.style.borderLeftColor = project.color;
    }

    // Due date badge
    if (task.due) {
      const { text, overdue } = daysLabel(task.due);
      meta.createSpan({
        cls: `pm-dash-task-due${overdue ? " pm-dash-task-due--overdue" : ""}`,
        text,
      });
    }

    // Status badge — click to change status
    const statusColor = getStatusColor(task.status);
    const statusBadge = meta.createSpan({ cls: "pm-dash-task-status" });
    statusBadge.setText(STATUS_LABELS[task.status] ?? task.status);
    statusBadge.style.background = `${statusColor}22`;
    statusBadge.style.color = statusColor;
    statusBadge.style.border = `1px solid ${statusColor}55`;
    statusBadge.addEventListener("click", (e) => {
      e.stopPropagation();
      openDropdown(
        statusBadge,
        STATUSES.map((s) => ({
          label: STATUS_LABELS[s] ?? s,
          color: STATUS_COLORS[s] ?? "#6b7280",
          onSelect: () => {
            void patchTaskField(this.app, task.filePath, "status", s).then(
              () => this.scheduleRefresh(),
            );
          },
        })),
      );
    });

    // Tags — rendered with Obsidian's native `tag` class
    if (task.tags && task.tags.length > 0) {
      const tagsRow = body.createDiv({ cls: "pm-dash-task-tags" });
      for (const tag of task.tags) {
        tagsRow.createEl("a", {
          cls: "tag",
          text: tag.startsWith("#") ? tag : `#${tag}`,
          href: `#${tag.replace(/^#/, "")}`,
        }).addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.app as any).internalPlugins?.plugins?.["global-search"]?.instance
            ?.openGlobalSearch(`tag:#${tag.replace(/^#/, "")}`);
        });
      }
    }

    // Edit button — opens TaskModal; Ctrl+click opens raw file
    const editBtn = row.createEl("button", {
      cls: "pm-dash-task-edit-btn",
      attr: { title: "Edit task" },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        openNoteFile(this.app, task.filePath);
        return;
      }
      new TaskModal(this.app, {
        mode: "edit",
        task,
        existingTasks: this.allTasks.filter((t) => t.projectId === task.projectId),
        onSuccess: () => this.scheduleRefresh(),
      }).open();
    });

    // Click row → open in graph; Ctrl+click → open raw file
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".pm-dash-task-ribbon, .pm-dash-task-status, .pm-dash-task-edit-btn")) return;
      if (e.ctrlKey || e.metaKey) {
        openNoteFile(this.app, task.filePath);
        return;
      }
      void this.openInGraph(task);
    });

    // Right-click row → task context menu
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openTaskContextMenu(e, task, projectMap);
    });
  }

  private openTaskContextMenu(e: MouseEvent, task: Task, projectMap: Map<string, Project>): void {
    const project = projectMap.get(task.projectId);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Add subtask").setIcon("plus").onClick(() => {
        if (!project) return;
        new TaskModal(this.app, {
          mode: "create",
          projectId: project.id,
          projectFilePath: project.filePath,
          projectTitle: project.title,
          parentTask: task,
          existingTasks: this.allTasks.filter((t) => t.projectId === task.projectId),
          onSuccess: () => this.scheduleRefresh(),
        }).open();
      })
    );
    menu.addItem((item) =>
      item.setTitle("Delete task").setIcon("trash").onClick(() => {
        const descendantCount = this.countDescendants(task.id);
        const msg = descendantCount > 0
          ? `Delete "${task.title}" and its ${descendantCount} subtask${descendantCount > 1 ? "s" : ""}?`
          : `Delete "${task.title}"?`;
        new ConfirmModal(this.app, msg, () => {
          const parentTask = task.parentId ? this.allTasks.find((t) => t.id === task.parentId) : undefined;
          void deleteTaskFile(this.app, task, parentTask, this.allTasks).then(() => this.render());
        }).open();
      })
    );
    menu.showAtMouseEvent(e);
  }

  private countDescendants(taskId: string): number {
    let count = 0;
    for (const child of this.allTasks.filter((t) => t.parentId === taskId)) {
      count += 1 + this.countDescendants(child.id);
    }
    return count;
  }

  selectTask(taskId: string): boolean {
    const row = this.contentEl.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    if (!row) return false;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.addClass("pm-dash-task-row--selected");
    window.setTimeout(() => row.removeClass("pm-dash-task-row--selected"), 2000);
    return true;
  }

  private async openInGraph(task: Task): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(TASK_GRAPH_VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TASK_GRAPH_VIEW_TYPE, active: true });
      // Obsidian may defer view construction past setViewState resolution; wait
      // up to 500 ms for the view to be attached before proceeding.
      for (let i = 0; i < 10 && !(leaf.view instanceof TaskGraphView); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    this.app.workspace.revealLeaf(leaf);

    if (leaf.view instanceof TaskGraphView) {
      await leaf.view.openTask(task.projectId, task.id);
    }
  }
}
