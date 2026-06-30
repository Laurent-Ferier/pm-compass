import { App, ItemView, Menu, TAbstractFile, TFile, WorkspaceLeaf, moment as _moment, normalizePath, setIcon } from "obsidian";
// Obsidian declares moment as `typeof namespace` which loses the call signature in TS5 bundler mode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import type PMCompassPlugin from "./main";
import { loadVaultData } from "./vault-reader";
import { TaskModal, ConfirmModal, patchTaskField, deleteTaskFile, openDropdown, openNoteFile } from "./task-creator";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";
import type { Task, Project } from "./shared";
import { DayTask } from "./day-task";

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
const DAILY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
const INFO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
const NAV_PREV_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const NAV_NEXT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
const CALENDAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const TRASH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
const INBOX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;

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

/** Counts one-off (non-habit) checklist items for a single day.
 *  Items tagged with the habits tag are excluded (those are tracked by Daily Progress).
 *  Items without a ✅ timestamp are treated as closed on time (legacy check-offs). */
export function computeDailyTaskCounts(
  items: DayTask[],
  noteDate: string,
  habitsTag: string,
): { closedOnTime: number; closedLate: number; open: number; total: number } {
  let closedOnTime = 0;
  let done = 0;
  let total = 0;
  for (const task of items) {
    if (task.tags.includes(`#${habitsTag}`)) continue;
    total++;
    if (task.checked) {
      done++;
      if (!task.completedAt || task.completedAt <= noteDate) closedOnTime++;
    }
  }
  return { closedOnTime, closedLate: done - closedOnTime, open: total - done, total };
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

// ── Inbox helpers ────────────────────────────────────────────────────────────

export function resolveInboxPath(inboxFilePath: string, dnConfig: DailyNotesConfig): string {
  if (inboxFilePath) return normalizePath(inboxFilePath);
  return normalizePath(dnConfig.folder ? `${dnConfig.folder}/Inbox.md` : "Inbox.md");
}

export async function readInboxItems(app: App, resolvedPath: string): Promise<DayTask[]> {
  const file = app.vault.getAbstractFileByPath(resolvedPath);
  if (!(file instanceof TFile)) return [];
  const content = await app.vault.read(file);
  // Normalize CRLF so rawLine values are always LF-only and survive round-trips.
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  const parsed = lines.map((l, i) => DayTask.parse(l, i));
  const hasChecked = parsed.some((t) => t?.checked);
  if (hasChecked) {
    const cleanedLines = lines.filter((_, i) => !parsed[i]?.checked);
    await app.vault.modify(file, cleanedLines.join("\n"));
    return parseAndSortInboxLines(cleanedLines);
  }

  return parseAndSortInboxLines(lines);
}

function parseAndSortInboxLines(lines: string[]): DayTask[] {
  const items = lines
    .map((line, i) => DayTask.parse(line, i))
    .filter((t): t is DayTask => t !== null && !t.checked);

  items.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return 0;
  });

  return items;
}

export async function appendInboxItem(app: App, resolvedPath: string, title: string): Promise<void> {
  const today = moment().format("YYYY-MM-DD");
  const newLine = `- [ ] ${title} ➕ ${today}`;
  const file = app.vault.getAbstractFileByPath(resolvedPath);
  if (file instanceof TFile) {
    const content = await app.vault.read(file);
    await app.vault.modify(file, content ? `${content.trimEnd()}\n${newLine}` : newLine);
  } else {
    await app.vault.create(resolvedPath, newLine);
  }
}

export async function removeInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(resolvedPath);
  if (!(file instanceof TFile)) return;
  const content = await app.vault.read(file);
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  // Prefer the stored lineIndex (handles duplicates); fall back to indexOf.
  const idx = lines[item.lineIndex] === item.rawLine ? item.lineIndex : lines.indexOf(item.rawLine);
  if (idx === -1) return;
  lines.splice(idx, 1);
  await app.vault.modify(file, lines.join("\n"));
}

export async function scheduleInboxItem(
  app: App,
  resolvedPath: string,
  item: DayTask,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any,
): Promise<void> {
  await removeInboxItem(app, resolvedPath, item);
  const file = await ensureDailyNote(app, date);
  if (!file) return;
  const content = await app.vault.read(file);
  await app.vault.modify(file, content ? `${content.trimEnd()}\n${item.rawLine}` : item.rawLine);
}

// Finds item in file using lineIndex → rawLine → title fallback, removes it, and saves.
// Returns false if the item could not be located.
async function removeChecklistLine(app: App, sourceFilePath: string, item: DayTask): Promise<boolean> {
  const sourceFile = app.vault.getAbstractFileByPath(sourceFilePath);
  if (!(sourceFile instanceof TFile)) return false;
  const content = await app.vault.read(sourceFile);
  const lines = content.split("\n");

  let target = item.lineIndex;
  if (lines[target] !== item.rawLine) {
    const byRaw = lines.indexOf(item.rawLine);
    if (byRaw !== -1) {
      target = byRaw;
    } else {
      const byTitle = lines.findIndex((l) => l.includes(item.title));
      if (byTitle === -1) return false;
      target = byTitle;
    }
  }
  lines.splice(target, 1);
  await app.vault.modify(sourceFile, lines.join("\n"));
  return true;
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
  const targetFile = await ensureDailyNote(app, date);
  if (!targetFile) return;
  if (!await removeChecklistLine(app, sourceFilePath, item)) return;
  const targetContent = await app.vault.read(targetFile);
  const newLine = DayTask.toUncheckedLine(item.rawLine);
  await app.vault.modify(targetFile, targetContent ? `${targetContent.trimEnd()}\n${newLine}` : newLine);
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

export async function deleteChecklistItem(
  app: App,
  sourceFilePath: string,
  item: DayTask,
): Promise<void> {
  await removeChecklistLine(app, sourceFilePath, item);
}

export async function moveChecklistItemToInbox(
  app: App,
  sourceFilePath: string,
  item: DayTask,
  resolvedInboxPath: string,
): Promise<void> {
  if (!await removeChecklistLine(app, sourceFilePath, item)) return;
  await appendInboxItem(app, resolvedInboxPath, item.title);
}

// ── End Inbox helpers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureDailyNote(app: App, date: any): Promise<TFile | null> {
  const config = await readDailyNotesConfig(app);
  const dateStr = date.format(config.format);
  const filePath = normalizePath(
    config.folder ? `${config.folder}/${dateStr}.md` : `${dateStr}.md`,
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
      dateStr,
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

interface AdjacentDayData {
  offset: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any;
  unclosedItems: DayTask[];
  filePath: string | null;
}


export function renderTextWithInlineTags(container: HTMLElement, text: string, app: App): void {
  let last = 0;
  for (const match of DayTask.matchAllTags(text)) {
    if (match.index! > last) container.appendText(text.slice(last, match.index));
    const tagName = match[0].slice(1); // strip leading #
    const a = container.createEl("a", { cls: "tag", text: match[0], href: match[0] });
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).internalPlugins?.plugins?.["global-search"]?.instance
        ?.openGlobalSearch(`tag:#${tagName}`);
    });
    last = match.index! + match[0].length;
  }
  if (last < text.length) container.appendText(text.slice(last));
}

async function loadDayChecklist(
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

  // Only auto-create the note for today; for other dates just read if present.
  let file: TFile | null = null;
  if (date.isSame(moment(), "day")) {
    file = await ensureDailyNote(app, date);
  } else {
    const existing = app.vault.getAbstractFileByPath(expectedPath);
    file = existing instanceof TFile ? existing : null;
  }

  if (!file) return { items: [], filePath: null };

  const content = await app.vault.read(file);
  const items: DayTask[] = content.split("\n")
    .map((line, i) => DayTask.parse(line, i))
    .filter((t): t is DayTask => t !== null);
  return { items, filePath: file.path };
}

async function toggleChecklistItem(
  app: App,
  filePath: string,
  item: DayTask,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return;
  const content = await app.vault.read(file);
  const lines = content.split("\n");

  // Guard against the file being edited between render and click: prefer exact
  // rawLine match, fall back to title substring search.
  let target = item.lineIndex;
  if (lines[target] !== item.rawLine) {
    const byRaw = lines.indexOf(item.rawLine);
    if (byRaw !== -1) {
      target = byRaw;
    } else {
      const byTitle = lines.findIndex((l) => l.includes(item.title));
      if (byTitle === -1) return;
      target = byTitle;
    }
  }

  const line = lines[target];
  if (item.checked) {
    // Unchecking: remove [x] marker and strip any ✅ timestamp.
    lines[target] = DayTask.toUncheckedLine(line);
  } else {
    // Checking: add [x] marker and append a ✅ date timestamp.
    lines[target] = DayTask.toCheckedLine(line, moment().format("YYYY-MM-DD"));
  }
  await app.vault.modify(file, lines.join("\n"));
}

export class DashboardView extends ItemView {
  plugin: PMCompassPlugin;

  private allTasks: Task[] = [];
  private watchedDailyPaths = new Set<string>();
  private refreshTimer: ReturnType<typeof window.setTimeout> | null = null;
  private rendering = false;
  private activeTab: "tasks" | "stats" | "inbox" = "tasks";
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

    // Refresh when any watched daily note is modified or created.
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (this.watchedDailyPaths.has(file.path)) this.scheduleRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (this.watchedDailyPaths.has(file.path)) this.scheduleRefresh();
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

      const content = container.createDiv({ cls: "pm-dash-content" });

      const dnConfig = await readDailyNotesConfig(this.app);
      const resolvedInboxPath = resolveInboxPath(this.plugin.settings.inboxFilePath, dnConfig);
      const [{ items: checklistItems, filePath: dnPath }, vaultData, adjacentData, inboxItems] = await Promise.all([
        loadDayChecklist(this.app, this.dashboardDate, dnConfig),
        loadVaultData(this.app, this.plugin.settings.projectsFolder),
        this.loadAdjacentUnclosed(this.dashboardDate, dnConfig),
        readInboxItems(this.app, resolvedInboxPath),
      ]);

      this.watchedDailyPaths = new Set([
        ...(dnPath ? [dnPath] : []),
        ...adjacentData.map((d) => d.filePath).filter((p): p is string => p !== null),
        resolvedInboxPath,
      ]);
      const { tasks, projects } = vaultData;
      this.allTasks = tasks;

      const staleAfterDays = this.plugin.settings.inboxStaleAfterDays ?? 7;
      const hasStaleInboxItems = staleAfterDays > 0 && inboxItems.some((item) => {
        if (!item.createdAt) return false;
        return moment().diff(moment(item.createdAt, "YYYY-MM-DD"), "days") >= staleAfterDays;
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
        await this.renderStatsTab(content, tasks, projects, dnConfig);
      } else if (this.activeTab === "inbox") {
        await this.renderInboxTab(content, resolvedInboxPath, inboxItems, staleAfterDays);
      } else {
        this.renderTasksTab(content, checklistItems, dnPath, tasks, projects, adjacentData, resolvedInboxPath);
      }
    } finally {
      this.rendering = false;
    }
  }

  private async renderInboxTab(
    container: HTMLElement,
    resolvedPath: string,
    items: DayTask[],
    staleAfterDays: number,
  ): Promise<void> {
    // ── Add-task bar ─────────────────────────────────────────────────────────
    const addBar = container.createDiv({ cls: "pm-inbox-add-bar" });
    const addInput = addBar.createEl("input", {
      type: "text",
      cls: "pm-inbox-add-input",
      attr: { placeholder: "➕ Add a task…" },
    });
    addInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const title = addInput.value.trim();
        if (!title) return;
        void appendInboxItem(this.app, resolvedPath, title).then(() => this.render());
      }
    });

    // ── Task list ─────────────────────────────────────────────────────────────
    if (items.length === 0) {
      container.createDiv({ cls: "pm-dash-empty", text: "Inbox is empty" });
    } else {
      const list = container.createDiv({ cls: "pm-inbox-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: "pm-inbox-row" });

        const cb = row.createEl("input", { type: "checkbox", cls: "pm-inbox-cb" });
        cb.addEventListener("change", () => {
          void removeInboxItem(this.app, resolvedPath, item).then(() => this.render());
        });

        row.createSpan({ cls: "pm-inbox-title", text: item.title });

        if (item.createdAt) {
          const daysOld = moment().diff(moment(item.createdAt, "YYYY-MM-DD"), "days");
          const isStale = staleAfterDays > 0 && daysOld >= staleAfterDays;
          if (isStale) {
            const warn = row.createSpan({ cls: "pm-inbox-stale-warn", text: "⚠️" });
            warn.title = `In inbox for ${daysOld} days (threshold: ${staleAfterDays})`;
          }
          const badge = row.createSpan({
            cls: `pm-inbox-age${daysOld > 14 ? " pm-inbox-age--old" : ""}`,
            text: daysOld === 0 ? "0j" : `${daysOld}j`,
          });
          badge.title = `Created on ${item.createdAt}`;
        }

        const actions = row.createDiv({ cls: "pm-inbox-actions" });

        const scheduleBtn = actions.createEl("button", {
          cls: "pm-inbox-btn",
          attr: { "aria-label": "Schedule" },
        });
        scheduleBtn.innerHTML = CALENDAR_SVG;
        const dateInput = actions.createEl("input", {
          type: "date",
          cls: "pm-inbox-date-picker",
        });
        dateInput.addEventListener("change", () => {
          if (!dateInput.value) return;
          const date = moment(dateInput.value, "YYYY-MM-DD");
          void scheduleInboxItem(this.app, resolvedPath, item, date).then(() =>
            this.render(),
          );
        });
        scheduleBtn.addEventListener("click", () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (dateInput as any).showPicker();
          } catch {
            dateInput.click();
          }
        });

        const deleteBtn = actions.createEl("button", {
          cls: "pm-inbox-btn pm-inbox-btn--delete",
          attr: { "aria-label": "Delete" },
        });
        deleteBtn.innerHTML = TRASH_SVG;
        deleteBtn.addEventListener("click", () => {
          new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
            void removeInboxItem(this.app, resolvedPath, item).then(() => this.render());
          }).open();
        });
      }
    }
  }

  private renderTasksTab(
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

    // Hidden date input — triggered programmatically by the calendar button
    const dateInput = dateNav.createEl("input", { type: "date", cls: "pm-dash-date-picker-input" });
    dateInput.value = this.dashboardDate.format("YYYY-MM-DD");
    dateInput.addEventListener("change", () => {
      if (dateInput.value) {
        this.dashboardDate = moment(dateInput.value, "YYYY-MM-DD");
        void this.render();
      }
    });

    const prevDayBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Previous day" } });
    prevDayBtn.innerHTML = NAV_PREV_SVG;
    prevDayBtn.addEventListener("click", () => { this.dashboardDate = moment(this.dashboardDate).subtract(1, "day"); void this.render(); });

    // Date text — click to open (or create) the daily note
    const dateLabelText = dateNav.createSpan({
      cls: `pm-dash-date-text${dnPath ? " pm-dash-date-text--has-note" : " pm-dash-date-text--no-note"}`,
      text: this.dashboardDate.format("dddd, MMMM D"),
    });
    dateLabelText.addEventListener("click", () => {
      if (dnPath) {
        openNoteFile(this.app, dnPath);
      } else {
        void ensureDailyNote(this.app, this.dashboardDate).then((file) => {
          if (file) openNoteFile(this.app, file.path);
        });
      }
    });

    if (!isToday) {
      const todayBtn = dateNav.createEl("button", { cls: "pm-dash-today-btn", text: "Today" });
      todayBtn.addEventListener("click", () => { this.dashboardDate = moment(); void this.render(); });
    }

    // Calendar icon button opens the date picker
    const calBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn pm-dash-cal-btn", attr: { "aria-label": "Pick date" } });
    calBtn.innerHTML = CALENDAR_SVG;
    calBtn.addEventListener("click", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (dateInput as any).showPicker(); } catch { dateInput.click(); }
    });

    const nextDayBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Next day" } });
    nextDayBtn.innerHTML = NAV_NEXT_SVG;
    nextDayBtn.addEventListener("click", () => { this.dashboardDate = moment(this.dashboardDate).add(1, "day"); void this.render(); });

    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));

    const pastDays = adjacentData.filter((d) => d.offset < 0).sort((a, b) => b.offset - a.offset);
    const futureDays = adjacentData.filter((d) => d.offset > 0).sort((a, b) => a.offset - b.offset);

    this.renderAdjacentUnclosedSection(content, pastDays, "tasks.previousUnclosed", "Overdue tasks", resolvedInboxPath);
    this.renderChecklistSection(content, checklistItems, dnPath, this.dashboardDate, resolvedInboxPath);
    this.renderAdjacentUnclosedSection(content, futureDays, "tasks.upcomingUnclosed", "Upcoming tasks", resolvedInboxPath);

    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const effectiveValuesMap = this.computeEffectiveValues(activeTasks, taskById);
    const parentIds = buildParentIdSet(activeTasks);

    const approachingDeadlines = selectApproachingDeadlines(
      activeTasks, effectiveValuesMap, parentIds, moment().format("YYYY-MM-DD"),
    );

    this.renderDeadlinesSection(content, approachingDeadlines, projectMap, effectiveValuesMap);

    const deadlineIds = new Set(approachingDeadlines.map((t) => t.id));

    const priorityQueue = selectPriorityQueue(activeTasks, effectiveValuesMap, parentIds, deadlineIds);

    this.renderPrioritySection(content, priorityQueue, projectMap, effectiveValuesMap);
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

    if (!isCurrentWeek) {
      const thisWeekBtn = weekNav.createEl("button", { cls: "pm-dash-today-btn", text: "This week" });
      thisWeekBtn.addEventListener("click", () => { this.weekOffset = 0; void this.render(); });
    }

    const nextWeekBtn = weekNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Next week" } });
    nextWeekBtn.innerHTML = NAV_NEXT_SVG;
    nextWeekBtn.addEventListener("click", () => { this.weekOffset++; void this.render(); });

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
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const effectiveValuesMap = this.computeEffectiveValues(activeTasks, taskById);

    const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    const habitsTag = (this.plugin.settings.dailyHabitsTag || "daily").replace(/^#/, "");

    // ── Data accumulation pass over 7 days (reads in parallel) ─────────────
    const itemCompletionCount = new Map<string, number>();
    const itemPresenceCount = new Map<string, number>();
    const itemCheckedDays = new Map<string, number[]>();
    const dailyData: Array<{
      done: number; total: number; taskCounts: ReturnType<typeof computeDailyTaskCounts>;
      hasNote: boolean; isFuture: boolean; filePath: string;
    }> = [];

    const dayEntries = Array.from({ length: 7 }, (_, i) => {
      const day = moment(weekStart).add(i, "days");
      const isFuture = day.isAfter(moment(), "day");
      const filePath = normalizePath(
        config.folder ? `${config.folder}/${day.format(config.format)}.md` : `${day.format(config.format)}.md`,
      );
      const file = this.app.vault.getAbstractFileByPath(filePath);
      return { isFuture, file: file instanceof TFile ? file : null, filePath, dateStr: day.format("YYYY-MM-DD") };
    });
    const rawContents = await Promise.all(
      dayEntries.map(({ file }) => file ? this.app.vault.read(file) : Promise.resolve(null)),
    );

    for (let i = 0; i < 7; i++) {
      const { isFuture, file, dateStr } = dayEntries[i];
      const raw = rawContents[i];
      const dayItems = raw !== null
        ? raw.split("\n").map((l, idx) => DayTask.parse(l, idx)).filter((t): t is DayTask => t !== null)
        : [];
      const taskCounts = computeDailyTaskCounts(dayItems, dateStr, habitsTag);
      let done = 0;
      let total = 0;
      for (const task of dayItems) {
        if (!task.tags.includes(`#${habitsTag}`)) continue;
        const key = task.displayTitle(habitsTag);
        if (task.checked) {
          done++;
          total++;
          itemCompletionCount.set(key, (itemCompletionCount.get(key) ?? 0) + 1);
          itemPresenceCount.set(key, (itemPresenceCount.get(key) ?? 0) + 1);
          if (!itemCheckedDays.has(key)) itemCheckedDays.set(key, []);
          itemCheckedDays.get(key)!.push(i);
        } else {
          total++;
          itemPresenceCount.set(key, (itemPresenceCount.get(key) ?? 0) + 1);
        }
      }
      dailyData.push({ done, total, taskCounts, hasNote: file !== null, isFuture, filePath: dayEntries[i].filePath });
    }

    // ── Task Habits (outer collapsible: grouped items + daily progress) ──────
    const habitsTooltip = `Only checklist items tagged #${habitsTag} are tracked here. Configure in plugin settings.`;
    const { body: habitsBody } = this.createCollapsibleSection(content, "Task Habits", "stats.habits", { tooltip: habitsTooltip });

    // ── Grouped habits (collapsible sub-section inside Task Habits) ─────────
    const { body: groupedBody } = this.createCollapsibleSection(habitsBody, "Weekly Recap", "stats.habitsGrouped", {
      sub: true,
      tooltip: "Habit items grouped by name, showing how many days each was completed this week.",
    });

    if (itemPresenceCount.size > 0) {
      const sortedItems = [...itemPresenceCount.keys()].sort((a, b) =>
        (itemCompletionCount.get(b) ?? 0) - (itemCompletionCount.get(a) ?? 0)
      );
      const itemsList = groupedBody.createDiv({ cls: "pm-dash-items-list" });
      for (const text of sortedItems) {
        const doneCount = itemCompletionCount.get(text) ?? 0;
        const presCount = itemPresenceCount.get(text)!;
        const checkedDays = itemCheckedDays.get(text) ?? [];
        const displayText = text;
        const itemWrap = itemsList.createDiv({ cls: "pm-dash-item-wrap" });
        const row = itemWrap.createDiv({ cls: "pm-dash-item-row" });
        row.appendChild(buildProgressCircle({
          size: 28, r: 11, strokeWidth: 3, ratio: doneCount / presCount, svgClass: "pm-dash-item-circle",
        }));
        row.createSpan({ cls: `pm-dash-item-text${doneCount === 0 ? " pm-dash-item-text--never" : ""}`, text: displayText });
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
    const { body: dailyBody } = this.createCollapsibleSection(habitsBody, "Daily Progress", "stats.dailyProgress", {
      sub: true,
      tooltip: "Daily completion ratio of habit checklist items. Click a circle to open that day's note.",
    });
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

    // ── Daily Tasks (7-day circles, tri-color: closed / late / open) ──────────
    const { body: dailyTasksBody } = this.createCollapsibleSection(content, "Daily Tasks", "stats.dailyTasks", {
      tooltip: `One-off checklist items per day (excludes #${habitsTag} habit items). Green = done same day, orange = done late, grey = open.`,
    });
    const dailyTasksCirclesRow = dailyTasksBody.createDiv({ cls: "pm-dash-circles-row" });
    for (let i = 0; i < 7; i++) {
      const { taskCounts, hasNote, isFuture, filePath } = dailyData[i];
      const { closedOnTime, closedLate, total } = taskCounts;
      const done = closedOnTime + closedLate;
      const wrap = dailyTasksCirclesRow.createDiv({
        cls: `pm-dash-day-circle${hasNote ? " pm-dash-day-circle--clickable" : ""}`,
      });
      wrap.appendChild(buildTriColorCircle({
        size: 56, r: 20, strokeWidth: 4,
        ratio1: total > 0 ? closedOnTime / total : 0,
        ratio2: total > 0 ? closedLate / total : 0,
        trackDim: isFuture || !hasNote,
        label: !hasNote ? "—" : total === 0 ? "—" : `${done}/${total}`,
      }));
      wrap.createSpan({ cls: "pm-dash-circle-day", text: DAY_ABBR[i] });
      if (hasNote) {
        wrap.addEventListener("click", () => openNoteFile(this.app, filePath));
      }
    }
    // Legend
    const dailyLegend = dailyTasksBody.createDiv({ cls: "pm-dash-daily-legend" });
    for (const { color, label } of [
      { color: "#22c55e", label: "Closed" },
      { color: "#f97316", label: "Late" },
      { color: "var(--background-modifier-border)", label: "Open" },
    ]) {
      const item = dailyLegend.createDiv({ cls: "pm-dash-daily-legend-item" });
      const dot = item.createSpan({ cls: "pm-dash-daily-legend-dot" });
      dot.style.backgroundColor = color;
      item.createSpan({ cls: "pm-dash-daily-legend-label", text: label });
    }

    // ── Stat rows (collapsible section, expandable rows) ────────────────────
    const { body: statsBody } = this.createCollapsibleSection(content, "Week Stats", "stats.weekStats", {
      tooltip: "Task activity this week: completed, created, in-progress, and blocked. Click a row to expand the task list.",
    });
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
      this.renderExpandTaskList(expandList, taskList, projectMap, effectiveValuesMap);
      rowHeader.addEventListener("click", () => {
        wrap.toggleClass("pm-dash-stat-row--open", !wrap.hasClass("pm-dash-stat-row--open"));
      });
    }

    // ── Status breakdown (collapsible section, expandable bars) ─────────────
    const { body: statusBody } = this.createCollapsibleSection(content, "Active Tasks by Status", "stats.activeByStatus", {
      tooltip: "All active tasks broken down by their current status. Click a row to expand the task list.",
    });
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
      this.renderExpandTaskList(expandList, statusTasks, projectMap, effectiveValuesMap);
      barRow.addEventListener("click", () => {
        wrap.toggleClass("pm-dash-bar-wrap--open", !wrap.hasClass("pm-dash-bar-wrap--open"));
      });
    }

    // ── Completed this week by project ──────────────────────────────────────
    const { body: projectSection } = this.createCollapsibleSection(content, "Completed by Project", "stats.completedByProject", {
      tooltip: "Tasks completed this week, grouped by project.",
    });
    if (completedThisWeek.length > 0) {
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
    } else {
      projectSection.createDiv({ cls: "pm-dash-empty", text: "No tasks completed this week" });
    }
  }

  private computeEffectiveValues(
    tasks: Task[],
    taskById: Map<string, Task>,
  ): Map<string, { priority: string | undefined; due: string | undefined }> {
    return computeEffectiveValues(tasks, taskById);
  }

  private renderExpandTaskList(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap?: Map<string, { priority: string | undefined; due: string | undefined }>,
  ): void {
    if (tasks.length === 0) {
      container.createDiv({ cls: "pm-dash-expand-empty", text: "No tasks" });
      return;
    }
    for (const task of tasks) {
      const row = container.createDiv({ cls: "pm-dash-expand-task" });
      const effective = effectiveValuesMap?.get(task.id);
      if (effective?.priority) {
        const color = getPriorityColor(effective.priority);
        if (color) {
          row.style.borderLeft = `3px solid ${color}`;
          row.style.paddingLeft = "5px";
        }
      }
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
    items: DayTask[],
    filePath: string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    date: any,
    resolvedInboxPath: string,
  ): void {
    const isToday = date.isSame(moment(), "day");
    const dateLabel = isToday ? "Today" : date.format("MMM D");
    const { body } = this.createCollapsibleSection(container, `${dateLabel}'s Checklist`, "tasks.checklist", {
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
        cls: `pm-dash-checklist-item${item.checked ? " pm-dash-checklist-item--checked" : ""}`,
      });

      const box = li.createSpan({ cls: "pm-dash-checkbox" });
      if (item.checked) box.addClass("pm-dash-checkbox--checked");

      const displayText = item.displayTitle(habitsTag);
      renderTextWithInlineTags(li.createSpan({ cls: "pm-dash-checklist-text" }), displayText, this.app);

      if (isDaily) {
        const icon = li.createSpan({ cls: "pm-dash-checklist-daily-icon" });
        icon.innerHTML = DAILY_ICON_SVG;
      }

      if (!isDaily && !item.checked && filePath) {
        const actions = li.createDiv({ cls: "pm-dash-checklist-actions" });
        appendRescheduleButton(actions, (targetDate) => {
          void rescheduleChecklistItem(this.app, filePath, item, targetDate).then(
            () => this.render(),
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
            () => this.render(),
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
            void deleteChecklistItem(this.app, filePath, item).then(() => this.render());
          }).open();
        });
      }

      if (filePath) {
        li.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".pm-dash-checklist-reschedule-btn")) return;
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

  private async loadAdjacentUnclosed(
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
      tooltip: key.includes("previous")
        ? "Unclosed checklist items from the previous 7 days."
        : "Unclosed checklist items from the next 7 days.",
    });

    const list = body.createEl("ul", { cls: "pm-dash-checklist" });
    for (const day of days) {
      for (const item of day.unclosedItems) {
        const li = list.createEl("li", { cls: "pm-dash-checklist-item" });
        const box = li.createSpan({ cls: "pm-dash-checkbox" });
        const displayText = item.displayTitle(habitsTag);
        renderTextWithInlineTags(li.createSpan({ cls: "pm-dash-checklist-text" }), displayText, this.app);
        const actions = li.createDiv({ cls: "pm-dash-checklist-actions" });
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
              () => this.render(),
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
              () => this.render(),
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
              void deleteChecklistItem(this.app, day.filePath!, item).then(() => this.render());
            }).open();
          });
          li.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".pm-dash-checklist-reschedule-btn")) return;
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

  private renderTaskRow(
    container: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    effectivePriority?: string,
    effectiveDue?: string,
  ): void {
    const row = container.createDiv({ cls: "pm-dash-task-row" });
    row.dataset.taskId = task.id;

    // Priority ribbon — click to change priority; colour reflects effective (inherited) priority
    const ribbonColor = getPriorityColor(effectivePriority ?? task.priority);
    const ribbon = row.createDiv({ cls: "pm-dash-task-ribbon" });
    if (ribbonColor) ribbon.style.backgroundColor = ribbonColor;
    const ownLabel = PRIORITY_LABELS[task.priority ?? ""] ?? "None";
    const effLabel = effectivePriority ? PRIORITY_LABELS[effectivePriority] ?? effectivePriority : ownLabel;
    ribbon.title = effectivePriority && effectivePriority !== task.priority
      ? `Effective priority: ${effLabel} (own: ${ownLabel})`
      : `Priority: ${ownLabel}`;
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

    // Due date badge — show the closest effective deadline (may be inherited from a parent)
    const displayDue = effectiveDue ?? task.due;
    if (displayDue) {
      const { text, overdue } = daysLabel(displayDue);
      const dueSpan = meta.createSpan({
        cls: `pm-dash-task-due${overdue ? " pm-dash-task-due--overdue" : ""}`,
        text,
      });
      if (effectiveDue && effectiveDue !== task.due) {
        dueSpan.title = `Effective deadline: ${effectiveDue} (own: ${task.due ?? "none"})`;
      }
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
