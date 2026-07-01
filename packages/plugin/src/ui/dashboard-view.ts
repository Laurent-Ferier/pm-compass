import { App, Component, MarkdownRenderer, Menu, WorkspaceLeaf, moment as _moment, normalizePath, setIcon } from "obsidian";
// Obsidian declares moment as `typeof namespace` which loses the call signature in TS5 bundler mode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import type PMCompassPlugin from "../main";
import { TaskModal, ConfirmModal, patchTaskField, deleteTaskFile, openDropdown, openNoteFile } from "./task-creator";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";
import type { Task, Project } from "../model/shared";
import { DayTask } from "../model/day-task";
import { DayMarkdownFile, readDailyNotesConfig } from "../model/day-markdown-file";
import { DailyNotesConfig } from "../model/week-summary";

export const DASHBOARD_VIEW_TYPE = "pm-compass-dashboard";

export const PRIORITY_SCORE: Record<string, number> = {
  critical: 400,
  high: 300,
  medium: 200,
  low: 100,
};

export const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#22c55e",
};

export const PRIORITY_LABELS: Record<string, string> = {
  "": "None",
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const STATUS_COLORS: Record<string, string> = {
  "todo": "#6b7280",
  "in-progress": "#3b82f6",
  "blocked": "#ef4444",
  "review": "#8b5cf6",
  "done": "#22c55e",
  "cancelled": "#9ca3af",
};

export const STATUS_LABELS: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "blocked": "Blocked",
  "review": "Review",
  "done": "Done",
  "cancelled": "Cancelled",
};

export const STATUSES = ["todo", "in-progress", "blocked", "review", "done", "cancelled"] as const;
export const PRIORITIES = ["", "critical", "high", "medium", "low"] as const;

export const DONE_STATUSES = new Set(["done", "cancelled"]);

export const CHEVRON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
export const DAILY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
export const INFO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
export const NAV_PREV_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
export const NAV_NEXT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
export const CALENDAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
export const TRASH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
export const INBOX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;

export function buildProgressCircle(opts: {
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

/** Circular progress with up to two colored arcs layered on a track.
 *  Arc 1 starts at the top; Arc 2 continues where Arc 1 ends.
 *  The remaining track represents the third (unlabelled) segment. */
export function buildTriColorCircle(opts: {
  size: number;
  r: number;
  strokeWidth: number;
  /** Fraction [0,1] for the first (green) arc. */
  ratio1: number;
  /** Fraction [0,1] for the second (orange) arc. */
  ratio2: number;
  trackDim?: boolean;
  label?: string;
}): SVGSVGElement {
  const { size, r, strokeWidth, ratio1, ratio2, trackDim, label } = opts;
  const cx = size / 2;
  const circ = 2 * Math.PI * r;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg") as SVGSVGElement;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.addClass("pm-dash-circle-svg");

  const track = document.createElementNS(svgNS, "circle");
  track.setAttribute("cx", String(cx)); track.setAttribute("cy", String(cx)); track.setAttribute("r", String(r));
  track.setAttribute("fill", "none"); track.setAttribute("stroke-width", String(strokeWidth));
  track.addClass("pm-dash-circle-track");
  if (trackDim) track.addClass("pm-dash-circle-track--dim");
  svg.appendChild(track);

  const addArc = (ratio: number, offsetFraction: number, color: string) => {
    if (ratio <= 0) return;
    const len = ratio * circ;
    const arc = document.createElementNS(svgNS, "circle");
    arc.setAttribute("cx", String(cx)); arc.setAttribute("cy", String(cx)); arc.setAttribute("r", String(r));
    arc.setAttribute("fill", "none"); arc.setAttribute("stroke-width", String(strokeWidth));
    arc.setAttribute("stroke-dasharray", `${len} ${circ - len}`);
    arc.setAttribute("stroke-dashoffset", String(circ / 4));
    if (offsetFraction > 0) {
      arc.setAttribute("transform", `rotate(${offsetFraction * 360}, ${cx}, ${cx})`);
    }
    arc.setAttribute("stroke", color);
    svg.appendChild(arc);
  };

  addArc(ratio1, 0, "#22c55e");        // closed same day — green
  addArc(ratio2, ratio1, "#f97316");   // closed late — orange

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

export function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

export function getPriorityColor(priority: string | undefined): string {
  return PRIORITY_COLORS[priority ?? ""] ?? "";
}

export function deadlinePoints(dueDate: string | undefined): number {
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

export function daysLabel(dueDate: string): { text: string; overdue: boolean } {
  const today = moment().startOf("day");
  const due = moment(dueDate, "YYYY-MM-DD").startOf("day");
  const days = due.diff(today, "days");
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: "today", overdue: false };
  if (days === 1) return { text: "tomorrow", overdue: false };
  return { text: `in ${days}d`, overdue: false };
}

export function buildParentIdSet(tasks: Task[]): Set<string> {
  return new Set(tasks.flatMap((t) => (t.parentId ? [t.parentId] : [])));
}

export function computeEffectiveValues(
  tasks: Task[],
  taskById: Map<string, Task>,
): Map<string, { priority: string | undefined; due: string | undefined }> {
  const map = new Map<string, { priority: string | undefined; due: string | undefined }>();
  for (const task of tasks) {
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
    map.set(task.id, { priority, due });
  }
  return map;
}

export function selectApproachingDeadlines(
  activeTasks: Task[],
  effectiveValuesMap: Map<string, { priority: string | undefined; due: string | undefined }>,
  parentIds: Set<string>,
  todayStr: string,
): Task[] {
  const today = moment(todayStr, "YYYY-MM-DD").startOf("day");
  return activeTasks
    .filter((t) => {
      const due = effectiveValuesMap.get(t.id)?.due;
      if (!due) return false;
      const days = moment(due, "YYYY-MM-DD").diff(today, "days");
      return days >= 0 && days <= 7;
    })
    .filter((t) => !parentIds.has(t.id))
    .sort((a, b) => {
      const ea = effectiveValuesMap.get(a.id)!;
      const eb = effectiveValuesMap.get(b.id)!;
      const dateDiff = moment(ea.due, "YYYY-MM-DD").diff(moment(eb.due, "YYYY-MM-DD"), "days");
      if (dateDiff !== 0) return dateDiff;
      return (PRIORITY_SCORE[eb.priority ?? ""] ?? 0) - (PRIORITY_SCORE[ea.priority ?? ""] ?? 0);
    });
}

export function selectPriorityQueue(
  activeTasks: Task[],
  effectiveValuesMap: Map<string, { priority: string | undefined; due: string | undefined }>,
  parentIds: Set<string>,
  excludeIds: Set<string>,
  limit = 15,
): Task[] {
  return activeTasks
    .filter((t) => { const e = effectiveValuesMap.get(t.id); return e?.priority || e?.due; })
    .sort((a, b) => {
      const ea = effectiveValuesMap.get(a.id)!;
      const eb = effectiveValuesMap.get(b.id)!;
      return (deadlinePoints(eb.due) + (PRIORITY_SCORE[eb.priority ?? ""] ?? 0))
           - (deadlinePoints(ea.due) + (PRIORITY_SCORE[ea.priority ?? ""] ?? 0));
    })
    .filter((t) => !parentIds.has(t.id) && !excludeIds.has(t.id))
    .slice(0, limit);
}

// ── Inbox helpers ────────────────────────────────────────────────────────────

export function resolveInboxPath(inboxFilePath: string, dnConfig: DailyNotesConfig): string {
  if (inboxFilePath) return normalizePath(inboxFilePath);
  return normalizePath(dnConfig.folder ? `${dnConfig.folder}/Inbox.md` : "Inbox.md");
}

export async function readInboxItems(app: App, resolvedPath: string): Promise<DayTask[]> {
  const tasks = await new DayMarkdownFile(app, resolvedPath).removeCheckedTasks();
  tasks.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.getTime() - a.createdAt.getTime();
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return 0;
  });
  return tasks;
}

export async function appendInboxItem(app: App, resolvedPath: string, title: string): Promise<void> {
  await new DayMarkdownFile(app, resolvedPath).createTask(title, new Date());
}

export async function removeInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
): Promise<void> {
  await new DayMarkdownFile(app, resolvedPath).remove(item);
}

export async function scheduleInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
): Promise<void> {
  const removed = await new DayMarkdownFile(app, resolvedPath).remove(item);
  if (!removed) return;
  const targetDmf = await DayMarkdownFile.ensure(app, date);
  if (!targetDmf) return;
  await targetDmf.addTask(removed);
}

export async function rescheduleChecklistItem(
  app: App,
  sourceFilePath: string,
  item: DayTask,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
): Promise<void> {
  // Confirm the target can be created BEFORE touching the source, so a failure
  // here doesn't leave the item deleted with nowhere to go.
  const targetDmf = await DayMarkdownFile.ensure(app, date);
  if (!targetDmf) return;
  const removed = await new DayMarkdownFile(app, sourceFilePath).remove(item);
  if (!removed) return;
  const uncheckedTask = DayTask.parse(DayTask.toUncheckedLine(removed.rawLine), 0)!.withSubLines(removed.subLines);
  await targetDmf.addTask(uncheckedTask);
}

export async function deleteChecklistItem(
  app: App,
  sourceFilePath: string,
  item: DayTask,
): Promise<void> {
  await new DayMarkdownFile(app, sourceFilePath).remove(item);
}

export async function moveChecklistItemToInbox(
  app: App,
  sourceFilePath: string,
  item: DayTask,
  resolvedInboxPath: string,
): Promise<void> {
  const removed = await new DayMarkdownFile(app, sourceFilePath).remove(item);
  if (!removed) return;
  const inboxTask = DayTask.create(item.title, new Date()).withSubLines(removed.subLines);
  await new DayMarkdownFile(app, resolvedInboxPath).addTask(inboxTask);
}

// ── End Inbox helpers ─────────────────────────────────────────────────────────

function dedentLines(lines: string[]): string {
  const minIndent = lines.reduce((min, l) => {
    const match = l.match(/^(\s*)\S/);
    return match ? Math.min(min, match[1].length) : min;
  }, Infinity);
  const strip = isFinite(minIndent) ? minIndent : 0;
  return lines.map((l) => l.slice(strip)).join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appendRescheduleButton(parent: HTMLElement, onDate: (date: any) => void): void {
  const btn = parent.createEl("button", {
    cls: "pm-dash-checklist-reschedule-btn",
    attr: { "aria-label": "Reschedule", title: "Reschedule to another day" },
  });
  btn.innerHTML = CALENDAR_SVG;
  const dateInput = parent.createEl("input", { type: "date", cls: "pm-dash-date-picker-input" });
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    onDate(moment(dateInput.value, "YYYY-MM-DD"));
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dateInput as any).showPicker();
    } catch {
      dateInput.click();
    }
  });
}

export async function renderInlineMarkdown(container: HTMLElement, text: string, app: App, component: Component): Promise<void> {
  await MarkdownRenderer.render(app, text, container, "", component);
  const p = container.querySelector(":scope > p");
  if (p) {
    while (p.firstChild) container.insertBefore(p.firstChild, p);
    p.remove();
  }
}

export async function loadDayChecklist(
  app: App,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
  config?: DailyNotesConfig,
): Promise<{ items: DayTask[]; filePath: string | null }> {
  const resolvedConfig = config ?? await readDailyNotesConfig(app);
  const dateStr = date.format(resolvedConfig.format);
  const expectedPath = normalizePath(
    resolvedConfig.folder ? `${resolvedConfig.folder}/${dateStr}.md` : `${dateStr}.md`,
  );

  // Only auto-create the note for literal today; other dates are only read if a note
  // already exists. (Callers that want the whole current week guaranteed to exist —
  // e.g. the Dashboard/Week Summary views — call backfillRecurringHabits() beforehand,
  // which is the single source of truth for that guarantee.)
  if (date.isSame(moment(), "day")) {
    const dmf = await DayMarkdownFile.ensure(app, date, resolvedConfig);
    if (!dmf) return { items: [], filePath: null };
    return { items: await dmf.parseTasks(), filePath: dmf.filePath };
  } else {
    const existing = app.vault.getAbstractFileByPath(expectedPath);
    if (!(existing instanceof TFile)) return { items: [], filePath: null };
    const dmf = new DayMarkdownFile(app, existing.path);
    return { items: await dmf.parseTasks(), filePath: dmf.filePath };
  }
}

import { TFile } from "obsidian";

async function toggleChecklistItem(
  app: App,
  filePath: string,
  item: DayTask,
): Promise<void> {
  const dmf = new DayMarkdownFile(app, filePath);
  if (item.checked) {
    await dmf.uncheckTask(item);
  } else {
    await dmf.checkTask(item, new Date());
  }
}

// ── Base class for all tab views ──────────────────────────────────────────────

export abstract class BaseTabView {
  allTasks: Task[] = [];

  constructor(
    protected readonly app: App,
    protected readonly plugin: PMCompassPlugin,
    protected readonly onRefresh: () => void,
  ) {}

  protected createCollapsibleSection(
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
      const info = header.createSpan({ cls: "pm-dash-section-info" });
      info.innerHTML = INFO_SVG;
      info.createDiv({ cls: "pm-dash-section-tooltip", text: options.tooltip });
      info.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = info.classList.toggle("pm-dash-section-info--open");
        if (isOpen) {
          const close = (ev: MouseEvent) => {
            if (!info.contains(ev.target as Node)) {
              info.classList.remove("pm-dash-section-info--open");
              document.removeEventListener("click", close, true);
            }
          };
          document.addEventListener("click", close, true);
        }
      });
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

  protected renderTaskRow(
    container: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    effectivePriority?: string,
    effectiveDue?: string,
    readonly = false,
  ): void {
    const row = container.createDiv({ cls: `pm-dash-task-row${readonly ? " pm-dash-task-row--readonly" : ""}` });
    row.dataset.taskId = task.id;

    const ribbonColor = getPriorityColor(effectivePriority ?? task.priority);
    const ribbon = row.createDiv({ cls: "pm-dash-task-ribbon" });
    if (ribbonColor) ribbon.style.backgroundColor = ribbonColor;
    const ownLabel = PRIORITY_LABELS[task.priority ?? ""] ?? "None";
    const effLabel = effectivePriority ? PRIORITY_LABELS[effectivePriority] ?? effectivePriority : ownLabel;
    ribbon.title = effectivePriority && effectivePriority !== task.priority
      ? `Effective priority: ${effLabel} (own: ${ownLabel})`
      : `Priority: ${ownLabel}`;
    if (!readonly) {
      ribbon.addEventListener("click", (e) => {
        e.stopPropagation();
        openDropdown(
          ribbon,
          PRIORITIES.map((p) => ({
            label: PRIORITY_LABELS[p] ?? p,
            color: PRIORITY_COLORS[p] ?? "#6b7280",
            onSelect: () => {
              void patchTaskField(this.app, task.filePath, "priority", p).then(
                () => this.onRefresh(),
              );
            },
          })),
        );
      });
    }

    const project = projectMap.get(task.projectId);
    const displayDue = effectiveDue ?? task.due;
    const statusColor = getStatusColor(task.status);

    const body = row.createDiv({ cls: "pm-dash-task-body" });

    const line1 = body.createDiv({ cls: "pm-dash-task-line" });
    void renderInlineMarkdown(line1.createSpan({ cls: "pm-dash-task-title" }), task.title, this.app, this.plugin);
    if (project) {
      const badge = line1.createSpan({ cls: "pm-dash-task-project", text: project.title });
      if (project.color) badge.style.borderLeftColor = project.color;
    }

    const line2 = body.createDiv({ cls: "pm-dash-task-line" });
    const statusBadge = line2.createSpan({ cls: "pm-dash-task-status" });
    statusBadge.setText(STATUS_LABELS[task.status] ?? task.status);
    statusBadge.style.background = `${statusColor}22`;
    statusBadge.style.color = statusColor;
    statusBadge.style.border = `1px solid ${statusColor}55`;
    if (!readonly) {
      statusBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        openDropdown(
          statusBadge,
          STATUSES.map((s) => ({
            label: STATUS_LABELS[s] ?? s,
            color: STATUS_COLORS[s] ?? "#6b7280",
            onSelect: () => {
              void patchTaskField(this.app, task.filePath, "status", s).then(
                () => this.onRefresh(),
              );
            },
          })),
        );
      });
    }
    if (displayDue) {
      const { text, overdue } = daysLabel(displayDue);
      const dueSpan = line2.createSpan({
        cls: `pm-dash-task-due${overdue ? " pm-dash-task-due--overdue" : ""}`,
        text,
      });
      if (effectiveDue && effectiveDue !== task.due) {
        dueSpan.title = `Effective deadline: ${effectiveDue} (own: ${task.due ?? "none"})`;
      }
    }

    if (!readonly) {
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
          onSuccess: () => this.onRefresh(),
        }).open();
      });
    }

    row.addEventListener("click", (e) => {
      if (!readonly && (e.target as HTMLElement).closest(".pm-dash-task-ribbon, .pm-dash-task-status, .pm-dash-task-edit-btn")) return;
      void this.openInGraph(task);
    });

    if (!readonly) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openTaskContextMenu(e, task, projectMap);
      });
    }
  }

  protected renderExpandList(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, { priority: string | undefined; due: string | undefined }>,
  ): void {
    for (const task of tasks) {
      const eff = effectiveValuesMap.get(task.id);
      this.renderTaskRow(container, task, projectMap, eff?.priority, eff?.due, true);
    }
    if (tasks.length === 0) container.createDiv({ cls: "pm-dash-expand-empty", text: "No tasks" });
  }

  protected openTaskContextMenu(e: MouseEvent, task: Task, projectMap: Map<string, Project>): void {
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
          onSuccess: () => this.onRefresh(),
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
          void deleteTaskFile(this.app, task, parentTask, this.allTasks).then(() => this.onRefresh());
        }).open();
      })
    );
    menu.showAtMouseEvent(e);
  }

  protected countDescendants(taskId: string): number {
    let count = 0;
    for (const child of this.allTasks.filter((t) => t.parentId === taskId)) {
      count += 1 + this.countDescendants(child.id);
    }
    return count;
  }

  protected async openInGraph(task: Task): Promise<void> {
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

// ── Dashboard (tasks tab) ─────────────────────────────────────────────────────

export interface AdjacentDayData {
  offset: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any;
  unclosedItems: DayTask[];
  filePath: string | null;
}

export class DashboardView extends BaseTabView {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dashboardDate: any = moment();

  render(
    content: HTMLElement,
    checklistItems: DayTask[],
    dnPath: string | null,
    tasks: Task[],
    projects: Project[],
    adjacentData: AdjacentDayData[],
    resolvedInboxPath: string,
  ): void {
    // ── Date navigator ──────────────────────────────────────────────────────
    const dateNav = content.createDiv({ cls: "pm-dash-date-nav" });

    const isToday = this.dashboardDate.isSame(moment(), "day");

    const dateInput = dateNav.createEl("input", { type: "date", cls: "pm-dash-date-picker-input" });
    dateInput.value = this.dashboardDate.format("YYYY-MM-DD");
    dateInput.addEventListener("change", () => {
      if (dateInput.value) {
        this.dashboardDate = moment(dateInput.value, "YYYY-MM-DD");
        this.onRefresh();
      }
    });

    const prevDayBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Previous day" } });
    prevDayBtn.innerHTML = NAV_PREV_SVG;
    prevDayBtn.addEventListener("click", () => { this.dashboardDate = moment(this.dashboardDate).subtract(1, "day"); this.onRefresh(); });

    const dateLabelText = dateNav.createSpan({
      cls: `pm-dash-date-text${dnPath ? " pm-dash-date-text--has-note" : " pm-dash-date-text--no-note"}`,
      text: this.dashboardDate.format("dddd, MMMM D"),
    });
    dateLabelText.addEventListener("click", () => {
      if (dnPath) {
        openNoteFile(this.app, dnPath);
      } else {
        void DayMarkdownFile.ensure(this.app, this.dashboardDate).then((dmf) => {
          if (dmf) openNoteFile(this.app, dmf.filePath);
        });
      }
    });

    if (!isToday) {
      const todayBtn = dateNav.createEl("button", { cls: "pm-dash-today-btn", text: "Today" });
      todayBtn.addEventListener("click", () => { this.dashboardDate = moment(); this.onRefresh(); });
    }

    const calBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn pm-dash-cal-btn", attr: { "aria-label": "Pick date" } });
    calBtn.innerHTML = CALENDAR_SVG;
    calBtn.addEventListener("click", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (dateInput as any).showPicker(); } catch { dateInput.click(); }
    });

    const nextDayBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Next day" } });
    nextDayBtn.innerHTML = NAV_NEXT_SVG;
    nextDayBtn.addEventListener("click", () => { this.dashboardDate = moment(this.dashboardDate).add(1, "day"); this.onRefresh(); });

    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));

    const pastDays = adjacentData.filter((d) => d.offset < 0).sort((a, b) => b.offset - a.offset);
    const futureDays = adjacentData.filter((d) => d.offset > 0).sort((a, b) => a.offset - b.offset);

    const { body: dailyTasksBody } = this.createCollapsibleSection(content, "Daily Tasks", "tasks.dailyGroup");
    this.renderAdjacentUnclosedSection(dailyTasksBody, pastDays, "tasks.previousUnclosed", "Overdue tasks", resolvedInboxPath);
    this.renderChecklistSection(dailyTasksBody, checklistItems, dnPath, this.dashboardDate, resolvedInboxPath);
    this.renderAdjacentUnclosedSection(dailyTasksBody, futureDays, "tasks.upcomingUnclosed", "Upcoming tasks", resolvedInboxPath);

    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const effectiveValuesMap = computeEffectiveValues(activeTasks, taskById);
    const parentIds = buildParentIdSet(activeTasks);

    const approachingDeadlines = selectApproachingDeadlines(
      activeTasks, effectiveValuesMap, parentIds, moment().format("YYYY-MM-DD"),
    );

    const { body: projectTasksBody } = this.createCollapsibleSection(content, "Project Tasks", "tasks.projectGroup");
    this.renderDeadlinesSection(projectTasksBody, approachingDeadlines, projectMap, effectiveValuesMap);

    const deadlineIds = new Set(approachingDeadlines.map((t) => t.id));
    const priorityQueue = selectPriorityQueue(activeTasks, effectiveValuesMap, parentIds, deadlineIds);
    this.renderPrioritySection(projectTasksBody, priorityQueue, projectMap, effectiveValuesMap);
  }

  async loadAdjacentUnclosed(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    date: any,
    config: DailyNotesConfig,
  ): Promise<AdjacentDayData[]> {
    const before = this.plugin.settings.unclosedDaysBefore ?? 7;
    const after = this.plugin.settings.unclosedDaysAfter ?? 7;
    const offsets = [
      ...Array.from({ length: before }, (_, i) => -(i + 1)),
      ...Array.from({ length: after }, (_, i) => i + 1),
    ];
    const habitsTag = (this.plugin.settings.dailyHabitsTag || "daily").replace(/^#/, "");
    const results = await Promise.all(offsets.map(async (offset) => {
      const day = moment(date).add(offset, "days");
      const { items, filePath } = await loadDayChecklist(this.app, day, config);
      const unclosedItems = items.filter((it) => !it.checked && !it.tags.includes(`#${habitsTag}`));
      return { offset, date: day, unclosedItems, filePath };
    }));
    return results.filter((d) => d.unclosedItems.length > 0);
  }

  private renderChecklistSection(
    container: HTMLElement,
    items: DayTask[],
    filePath: string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    date: any,
    resolvedInboxPath: string,
  ): void {
    const isToday = date.isSame(moment(), "day");
    const dateLabel = isToday ? "Today" : date.format("MMM D");
    const { body } = this.createCollapsibleSection(container, `${dateLabel}'s Checklist`, "tasks.checklist", {
      sub: true,
      tooltip: "Checklist items from the daily note. Click an item to toggle it.",
    });

    const habitsTag = (this.plugin.settings.dailyHabitsTag || "daily").replace(/^#/, "");

    if (items.length === 0) {
      body.createDiv({
        cls: "pm-dash-empty",
        text: `No checklist items in ${dateLabel.toLowerCase()}'s note`,
      });
      return;
    }

    const dailyItems = items.filter((it) => it.tags.includes(`#${habitsTag}`));
    const otherItems = items.filter((it) => !it.tags.includes(`#${habitsTag}`));

    const list = body.createEl("ul", { cls: "pm-dash-checklist" });

    const renderItem = (item: DayTask, isDaily: boolean) => {
      const li = list.createEl("li", {
        cls: `pm-day-task-row pm-dash-checklist-item${item.checked ? " pm-dash-checklist-item--checked" : ""}`,
      });

      const box = li.createSpan({ cls: "pm-dash-checkbox" });
      if (item.checked) box.addClass("pm-dash-checkbox--checked");

      const displayText = item.displayTitle(habitsTag);
      void renderInlineMarkdown(li.createSpan({ cls: "pm-dash-checklist-text" }), displayText, this.app, this.plugin);

      if (item.subLines.length > 0) {
        const tooltip = li.createDiv({ cls: "pm-day-task-sublines-tooltip" });
        for (const line of dedentLines(item.subLines).split("\n")) {
          void renderInlineMarkdown(tooltip.createDiv({ cls: "pm-day-task-subline" }), line, this.app, this.plugin);
        }
      }

      if (isDaily) {
        const icon = li.createSpan({ cls: "pm-dash-checklist-daily-icon" });
        icon.innerHTML = DAILY_ICON_SVG;
      }

      if (!isDaily && !item.checked && filePath) {
        const actions = li.createDiv({ cls: "pm-day-task-actions" });
        appendRescheduleButton(actions, (targetDate) => {
          void rescheduleChecklistItem(this.app, filePath, item, targetDate).then(
            () => this.onRefresh(),
          );
        });
        const inboxBtn = actions.createEl("button", {
          cls: "pm-dash-checklist-reschedule-btn",
          attr: { "aria-label": "Move to inbox", title: "Move to inbox" },
        });
        inboxBtn.innerHTML = INBOX_SVG;
        inboxBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void moveChecklistItemToInbox(this.app, filePath, item, resolvedInboxPath).then(
            () => this.onRefresh(),
          );
        });
        const deleteBtn = actions.createEl("button", {
          cls: "pm-dash-checklist-reschedule-btn pm-dash-checklist-delete-btn",
          attr: { "aria-label": "Delete", title: "Delete task" },
        });
        deleteBtn.innerHTML = TRASH_SVG;
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
            void deleteChecklistItem(this.app, filePath, item).then(() => this.onRefresh());
          }).open();
        });
      }

      if (filePath) {
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          void toggleChecklistItem(this.app, filePath, item).then(() => {
            // Optimistic local toggle — avoids a full re-render on every click.
            item.checked = !item.checked;
            li.toggleClass("pm-dash-checklist-item--checked", item.checked);
            box.toggleClass("pm-dash-checkbox--checked", item.checked);
          });
        });
      }
    };

    for (const item of dailyItems) renderItem(item, true);
    for (const item of otherItems) renderItem(item, false);
  }

  private renderAdjacentUnclosedSection(
    container: HTMLElement,
    days: AdjacentDayData[],
    key: string,
    title: string,
    resolvedInboxPath: string,
  ): void {
    if (days.length === 0) return;

    const habitsTag = (this.plugin.settings.dailyHabitsTag || "daily").replace(/^#/, "");

    const { body } = this.createCollapsibleSection(container, title, key, {
      sub: true,
      tooltip: key.includes("previous")
        ? "Unclosed checklist items from the previous 7 days."
        : "Unclosed checklist items from the next 7 days.",
    });

    const list = body.createEl("ul", { cls: "pm-dash-checklist" });
    for (const day of days) {
      for (const item of day.unclosedItems) {
        const li = list.createEl("li", { cls: "pm-day-task-row pm-dash-checklist-item" });
        const box = li.createSpan({ cls: "pm-dash-checkbox" });
        const displayText = item.displayTitle(habitsTag);
        void renderInlineMarkdown(li.createSpan({ cls: "pm-dash-checklist-text" }), displayText, this.app, this.plugin);
        if (item.subLines.length > 0) {
          const tooltip = li.createDiv({ cls: "pm-day-task-sublines-tooltip" });
          for (const line of dedentLines(item.subLines).split("\n")) {
            void renderInlineMarkdown(tooltip.createDiv({ cls: "pm-day-task-subline" }), line, this.app, this.plugin);
          }
        }
        const actions = li.createDiv({ cls: "pm-day-task-actions" });
        const dateLabel = actions.createSpan({ cls: "pm-dash-checklist-date-label", text: day.date.format("ddd, MMM D") });
        if (day.filePath) {
          dateLabel.addClass("pm-dash-checklist-date-label--link");
          dateLabel.addEventListener("click", (e) => {
            e.stopPropagation();
            openNoteFile(this.app, day.filePath!);
          });
        }
        if (day.filePath) {
          appendRescheduleButton(actions, (targetDate) => {
            void rescheduleChecklistItem(this.app, day.filePath!, item, targetDate).then(
              () => this.onRefresh(),
            );
          });
          const inboxBtn = actions.createEl("button", {
            cls: "pm-dash-checklist-reschedule-btn",
            attr: { "aria-label": "Move to inbox", title: "Move to inbox" },
          });
          inboxBtn.innerHTML = INBOX_SVG;
          inboxBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void moveChecklistItemToInbox(this.app, day.filePath!, item, resolvedInboxPath).then(
              () => this.onRefresh(),
            );
          });
          const deleteBtn = actions.createEl("button", {
            cls: "pm-dash-checklist-reschedule-btn pm-dash-checklist-delete-btn",
            attr: { "aria-label": "Delete", title: "Delete task" },
          });
          deleteBtn.innerHTML = TRASH_SVG;
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
              void deleteChecklistItem(this.app, day.filePath!, item).then(() => this.onRefresh());
            }).open();
          });
          box.addEventListener("click", (e) => {
            e.stopPropagation();
            void toggleChecklistItem(this.app, day.filePath!, item).then(() => {
              item.checked = true;
              li.addClass("pm-dash-checklist-item--checked");
              box.addClass("pm-dash-checkbox--checked");
            });
          });
        }
      }
    }
  }

  private renderDeadlinesSection(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, { priority: string | undefined; due: string | undefined }>,
  ): void {
    const { body } = this.createCollapsibleSection(container, "Approaching Deadlines", "tasks.deadlines", {
      sub: true,
      tooltip: "Tasks due within the next 7 days. Priority and deadline are inherited from parent tasks.",
    });
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No tasks due within 7 days" });
      return;
    }
    for (const task of tasks) {
      const eff = effectiveValuesMap.get(task.id);
      this.renderTaskRow(body, task, projectMap, eff?.priority, eff?.due);
    }
  }

  private renderPrioritySection(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, { priority: string | undefined; due: string | undefined }>,
  ): void {
    const { body } = this.createCollapsibleSection(container, "Priority Queue", "tasks.priority", {
      sub: true,
      tooltip: "High-priority active tasks sorted by priority. Tasks already shown in Approaching Deadlines are excluded.",
    });
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No prioritized tasks" });
      return;
    }
    for (const task of tasks) {
      const eff = effectiveValuesMap.get(task.id);
      this.renderTaskRow(body, task, projectMap, eff?.priority, eff?.due);
    }
  }
}
