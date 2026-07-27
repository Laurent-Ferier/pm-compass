/** Canonical status/priority value sets, shared by every view that renders or edits a Task. */

export const STATUSES = ["todo", "in-progress", "blocked", "review", "done", "cancelled"] as const;
/**
 * The priority scale. A string enum rather than a bare union of literals, so call
 * sites name the level (`Priority.High`) while the stored value stays the plain
 * lowercase string it has always been — task frontmatter written by obsidian-pm and
 * checklist markers written by the Obsidian Tasks plugin both keep working unchanged.
 */
export enum Priority {
  None = "",
  Critical = "critical",
  High = "high",
  Medium = "medium",
  Low = "low",
  /** Obsidian Tasks' ⏬ rung. Checklist lines only — project tasks have no counterpart
   *  for it, so it is absent from `PRIORITIES` and folds to `Low` on promotion. */
  Lowest = "lowest",
}

/** The levels a task can be *set* to, in picker order (`Lowest` excluded — see above). */
export const PRIORITIES = [
  Priority.None,
  Priority.Critical,
  Priority.High,
  Priority.Medium,
  Priority.Low,
] as const;

const PRIORITY_VALUES = new Set<string>(Object.values(Priority));

/**
 * Narrows an arbitrary stored value (frontmatter field, parsed marker) to a `Priority`.
 * Anything unrecognised — a hand-typed frontmatter value, a level from a future
 * obsidian-pm — becomes `None` rather than being carried around as an unknown string.
 */
export function toPriority(value: unknown): Priority {
  return typeof value === "string" && PRIORITY_VALUES.has(value)
    ? (value as Priority)
    : Priority.None;
}

/** Statuses that count as "no longer active" for scoring/filtering purposes. */
export const DONE_STATUSES = new Set(["done", "cancelled"]);

/** The one status that carries down the tree — see `effectiveStatus` in `shared.ts`. */
export const CANCELLED_STATUS = "cancelled";

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

/** Warm-to-cool down the scale. `None` has no colour of its own and falls back to the
 *  CSS default, hence the partial record; `Lowest` needs one despite being off the
 *  project scale, or a `⏬` checklist line would look identical to an unset one. */
export const PRIORITY_COLORS: Partial<Record<Priority, string>> = {
  [Priority.Critical]: "#ef4444",
  [Priority.High]: "#f97316",
  [Priority.Medium]: "#eab308",
  [Priority.Low]: "#22c55e",
  [Priority.Lowest]: "#38bdf8",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  [Priority.None]: "None",
  [Priority.Critical]: "Critical",
  [Priority.High]: "High",
  [Priority.Medium]: "Medium",
  [Priority.Low]: "Low",
  [Priority.Lowest]: "Lowest",
};

/** Higher score = more urgent; used to compare priorities and to combine with
 *  `deadlinePoints`. Unscored levels (`None`, `Lowest`) rank below every scored one. */
export const PRIORITY_SCORE: Partial<Record<Priority, number>> = {
  [Priority.Critical]: 400,
  [Priority.High]: 300,
  [Priority.Medium]: 200,
  [Priority.Low]: 100,
};

/** A status' display label, falling back to the raw value for anything unrecognised. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Reads an overridden status as "todo / cancelled". Takes the two already-rendered
 *  forms: the graph shows raw values, the task rows their labels. */
export function joinStatuses(own: string, inForce: string): string {
  return own === inForce ? inForce : `${own} / ${inForce}`;
}

export function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

export function getPriorityColor(priority: Priority | undefined): string {
  return priority ? (PRIORITY_COLORS[priority] ?? "") : "";
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripWikiLinks(str: string): string {
  return str.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match: string, page: string, display: string | undefined) => display?.trim() ?? page.trim(),
  );
}

export function withAlpha(hex: string, alphaHex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const expanded = h.length === 3 ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h;
  return `#${expanded}${alphaHex}`;
}

/** What planning a task for a day actually did with it — a day only takes the task in
 *  once its note exists, so the other outcome is a ⏳ target date left on the task. */
export enum ScheduleOutcome {
  /** The task now lives in that day's note. */
  Moved = "moved",
  /** The day has no note yet: the task waits in the inbox with a ⏳ target date. */
  Targeted = "targeted",
  /** Nothing happened — the task was gone, or its target note couldn't be created. */
  Failed = "failed",
}

/** Which key the Inbox list is ordered on — persisted as `settings.inboxSortBy`. */
export enum InboxSortBy {
  Created = "created",
  Priority = "priority",
  Title = "title",
  Due = "due",
  /** File order: the items as they appear in the Inbox file. */
  File = "file",
}

/** Which way that key runs — persisted per mode as `settings.inboxSortDir`. */
export enum InboxSortDir {
  Asc = "asc",
  Desc = "desc",
}
