/**
 * The vocabulary and the abstraction every kind of task shares — a checklist line
 * (`DayTask`) and a project task (`Task`). Imports nothing, so any layer can depend on it.
 */

/** The status scale; the stored value is the plain lowercase string. */
export enum Status {
  /** Where a task starts, and what an unset `status` field reads as. */
  Todo = "todo",
  InProgress = "in-progress",
  Blocked = "blocked",
  Review = "review",
  /** Finished rather than dropped; the one status that sets the `completed` timestamp. */
  Done = "done",
  /** The one status that carries down the tree — see `effectiveStatus` in `project/task-tree.ts`. */
  Cancelled = "cancelled",
}

/** Every status, in picker order. */
export const STATUSES = [
  Status.Todo,
  Status.InProgress,
  Status.Blocked,
  Status.Review,
  Status.Done,
  Status.Cancelled,
] as const;

/** The priority scale; call sites name the level, the stored value is the lowercase
 *  string obsidian-pm frontmatter and Obsidian Tasks markers use. */
export enum Priority {
  None = "",
  Critical = "critical",
  High = "high",
  Medium = "medium",
  Low = "low",
  /** Obsidian Tasks' ⏬ rung. Checklist lines only: off `PRIORITIES`, folds to `Low`
   *  on promotion. */
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

/** Narrows a stored value to a `Priority`; anything unrecognised becomes `None`. */
export function toPriority(value: unknown): Priority {
  return typeof value === "string" && PRIORITY_VALUES.has(value)
    ? (value as Priority)
    : Priority.None;
}

const STATUS_VALUES = new Set<string>(Object.values(Status));

/** Narrows a stored status, or `undefined` for an unknown one — still shown as it
 *  stands (see `statusLabel`), it just matches nothing. */
export function toStatus(value: unknown): Status | undefined {
  return typeof value === "string" && STATUS_VALUES.has(value) ? (value as Status) : undefined;
}

/** Whether a status is no longer active — finished or dropped. Unrecognised is open. */
export function isDoneStatus(status: string): boolean {
  const known = toStatus(status);
  return known === Status.Done || known === Status.Cancelled;
}

export const STATUS_COLORS: Record<Status, string> = {
  [Status.Todo]: "#6b7280",
  [Status.InProgress]: "#3b82f6",
  [Status.Blocked]: "#ef4444",
  [Status.Review]: "#8b5cf6",
  [Status.Done]: "#22c55e",
  [Status.Cancelled]: "#9ca3af",
};

export const STATUS_LABELS: Record<Status, string> = {
  [Status.Todo]: "To Do",
  [Status.InProgress]: "In Progress",
  [Status.Blocked]: "Blocked",
  [Status.Review]: "Review",
  [Status.Done]: "Done",
  [Status.Cancelled]: "Cancelled",
};

/** Warm-to-cool down the scale. `None` falls back to the CSS default, hence the partial
 *  record; `Lowest` needs one or a `⏬` line would look unset. */
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

/** Higher = more urgent. Steps by 100 because `task-scoring` adds `deadlinePoints`
 *  to these same numbers. */
const PRIORITY_RANK: Record<Priority, number> = {
  [Priority.Critical]: 400,
  [Priority.High]: 300,
  [Priority.Medium]: 200,
  [Priority.Low]: 100,
  /** Half a rung below `Low`, so a `⏬` line doesn't tie with an untriaged one. */
  [Priority.Lowest]: 50,
  /** Unset ranks below every set level, and must stay falsy — callers test it. */
  [Priority.None]: 0,
};

/** Where a priority sits on the scale. Unset, and anything off it, ranks 0. */
export function priorityRank(priority: Priority | null | undefined): number {
  return priority ? (PRIORITY_RANK[priority] ?? 0) : 0;
}

/** The more urgent of two levels, either of which may be unset. */
export function maxPriority(
  a: Priority | undefined,
  b: Priority | undefined,
): Priority | undefined {
  return priorityRank(b) > priorityRank(a) ? b : a;
}

/** A status' display label, falling back to the raw value for anything unrecognised. */
export function statusLabel(status: string): string {
  const known = toStatus(status);
  return known ? STATUS_LABELS[known] : status;
}

/** Reads an overridden status as "todo / cancelled". Takes the two already-rendered
 *  forms: the graph shows raw values, the task rows their labels. */
export function joinStatuses(own: string, inForce: string): string {
  return own === inForce ? inForce : `${own} / ${inForce}`;
}

export function getStatusColor(status: string): string {
  return STATUS_COLORS[toStatus(status) ?? Status.Todo];
}

export function getPriorityColor(priority: Priority | undefined): string {
  return priority ? (PRIORITY_COLORS[priority] ?? "") : "";
}

/** Which key a task list is ordered on — see `BaseTask.compareTo`. Only the Inbox lets
 *  the user pick (persisted as `settings.inboxSortBy`). */
export enum TaskSortKey {
  Created = "created",
  Priority = "priority",
  Title = "title",
  Due = "due",
  /** The tasks as they appear in the file holding them; one with no line sorts last. */
  File = "file",
}

/** Which way that key runs. Stored per key (`settings.inboxSortDir`), since one value
 *  cannot mean both "newest first" and "A → Z". */
export enum TaskSortDir {
  Asc = "asc",
  Desc = "desc",
}

/** What a roll-up over the tree knows about one task — `computeEffectiveValues`' entry,
 *  described structurally so this file need not know that module exists. */
export interface Rollup {
  /** What the task ranks as: the higher of the two roll-ups below. */
  priority?: Priority;
  /** Highest at or above the task — the top of its priority ribbon. */
  ancestorPriority?: Priority;
  /** Highest at or below the task — the bottom of the ribbon, and the tiebreak. */
  subtreePriority?: Priority;
  due?: Date;
}

/** Where a list looks up the roll-up for a task, by `rollupId`. */
export type RollupLookup = (id: string) => Rollup | undefined;

/** The direction each mode starts in — the natural reading of its key. */
export const DEFAULT_SORT_DIR: Record<TaskSortKey, TaskSortDir> = {
  [TaskSortKey.Created]: TaskSortDir.Desc,
  [TaskSortKey.Priority]: TaskSortDir.Desc,
  [TaskSortKey.Due]: TaskSortDir.Asc,
  [TaskSortKey.Title]: TaskSortDir.Asc,
  [TaskSortKey.File]: TaskSortDir.Asc,
};

const sortSign = (dir: TaskSortDir): number => (dir === TaskSortDir.Asc ? 1 : -1);

/** Oldest first in `Asc`; items missing the date last either way — unranked, not
 *  earliest or latest. */
function byDate(a: Date | null, b: Date | null, dir: TaskSortDir): number {
  if (a && b) return sortSign(dir) * (a.getTime() - b.getTime());
  if (a) return -1;
  if (b) return 1;
  return 0;
}

/** Case- and accent-insensitive title order, so "Écrire" lands next to "ecrire". */
function byTitle(a: BaseTask, b: BaseTask, dir: TaskSortDir): number {
  return sortSign(dir) * a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
}

/** Most urgent first in `Desc`; unset last either way. Ties on the level in force go by
 *  the subtree level, which is part of the key — so `dir` turns it too. */
function byPriority(a: BaseTask, b: BaseTask, dir: TaskSortDir, rollup?: RollupLookup): number {
  const [ra, rb] = [priorityRank(a.priorityInForce(rollup)), priorityRank(b.priorityInForce(rollup))];
  if (ra && rb) {
    return sortSign(dir) * (ra - rb
      || priorityRank(a.priorityFromBelow(rollup)) - priorityRank(b.priorityFromBelow(rollup)));
  }
  if (ra) return -1;
  if (rb) return 1;
  return 0;
}

/** What a list needs of a task whichever kind it is — a checklist line (`DayTask`) or a
 *  project task (`Task`). Every dashboard and Inbox list is built on this. */
export abstract class BaseTask {
  abstract readonly title: string;

  /** The vault file holding it. Null for a line parsed out of no file, which nothing
   *  can act on. */
  abstract readonly filePath: string | null;

  /** The day the task is *shown* under — a checklist line takes its note's day, whatever
   *  the line says. Ignores what an ancestor's deadline rolls up. */
  abstract get plannedDate(): Date | undefined;

  // ── What a row draws ───────────────────────────────────────────────────────
  // So a row can be rendered from the task alone: where the two kinds disagree,
  // they disagree behind these members.

  /** Its tags, bare — no leading `#`, whichever form the file stores. */
  abstract get tagNames(): readonly string[];

  /** The level written on the task itself, and what a list falls back to. */
  abstract get ownPriority(): Priority | null;

  /** The status it reads as, on its own scale. A checklist line has only two. */
  abstract get statusValue(): string;

  /** When it closed, if it did. An instant, not a day. */
  abstract get closedOn(): Date | null;

  /** The statuses this kind can be set to, in picker order. Two means a row draws a
   *  checkbox, more a status picker. */
  abstract get statusScale(): readonly Status[];

  /** The title as a row prints it: a habit line drops the tag that marks it one. */
  abstract rowTitle(habitsTag: string): string;

  // ── What a list orders on ──────────────────────────────────────────────────

  /** Its own deadline, ignoring anything it inherits. */
  abstract get ownDue(): Date | null;

  /** When it was written: an instant for a project task, a day for a checklist line. */
  abstract get createdOn(): Date | null;

  /** Where it sits in its file, for `TaskSortKey.File`. Null for a task with no line. */
  abstract get fileLine(): number | null;

  /** The id a roll-up files this task's inherited values under. Null for a task that
   *  inherits nothing, so a mixed list can read both kinds alike. */
  abstract get rollupId(): string | null;

  /** This task's roll-up, if the list has one for it. */
  private rollupOf(rollup?: RollupLookup): Rollup | undefined {
    const id = this.rollupId;
    return id ? rollup?.(id) : undefined;
  }

  /** The level it ranks as: what the tree around it makes it, else what it carries. */
  priorityInForce(rollup?: RollupLookup): Priority | null {
    return this.rollupOf(rollup)?.priority ?? this.ownPriority;
  }

  /** The top of the priority ribbon: the highest level at or above it. */
  priorityFromAbove(rollup?: RollupLookup): Priority | null {
    return this.rollupOf(rollup)?.ancestorPriority ?? this.ownPriority;
  }

  /** The bottom of the ribbon, and the tiebreak: the highest level at or below it. */
  priorityFromBelow(rollup?: RollupLookup): Priority | null {
    return this.rollupOf(rollup)?.subtreePriority ?? this.ownPriority;
  }

  /** The deadline it is held to: an ancestor's when that is sooner, else its own. */
  dueInForce(rollup?: RollupLookup): Date | null {
    return this.rollupOf(rollup)?.due ?? this.ownDue;
  }

  /** The day a list shows it under, an ancestor's deadline included. Unlike `dueInForce`,
   *  a checklist line answers with its note's day. */
  plannedDateInForce(rollup?: RollupLookup): Date | undefined {
    return this.rollupOf(rollup)?.due ?? this.plannedDate;
  }

  // ── How two tasks compare ──────────────────────────────────────────────────

  /**
   * Where this task sorts against another on `key`: closed work last, then the mode's
   * key with anything missing it last, then the shared tie-breaks. `dir` flips the key
   * only, and defaults to the direction that mode reads naturally in.
   */
  compareTo(
    other: BaseTask,
    opts: { key: TaskSortKey; dir?: TaskSortDir; rollup?: RollupLookup },
  ): number {
    const { key, dir = DEFAULT_SORT_DIR[key], rollup } = opts;

    const closed = BaseTask.closedLast(this, other);
    if (closed !== 0) return closed;

    // The file's own order. A task with no line is missing the key and stays last;
    // those are settled by the other fact a file records, when it was written.
    if (key === TaskSortKey.File) {
      const [la, lb] = [this.fileLine, other.fileLine];
      if (la !== null && lb !== null) {
        const diff = sortSign(dir) * (la - lb);
        if (diff !== 0) return diff;
      } else if (la !== null) return -1;
      else if (lb !== null) return 1;
      const created = byDate(this.createdOn, other.createdOn, TaskSortDir.Desc);
      return created !== 0 ? created : byPriority(this, other, TaskSortDir.Desc, rollup);
    }

    const onKey =
      key === TaskSortKey.Priority ? byPriority(this, other, dir, rollup)
      : key === TaskSortKey.Due ? byDate(this.dueInForce(rollup), other.dueInForce(rollup), dir)
      : key === TaskSortKey.Title ? byTitle(this, other, dir)
      : byDate(this.createdOn, other.createdOn, dir);
    if (onKey !== 0) return onKey;

    // Tasks the mode can't tell apart go by priority, then by newest.
    if (key !== TaskSortKey.Priority) {
      const diff = byPriority(this, other, TaskSortDir.Desc, rollup);
      if (diff !== 0) return diff;
    }
    return byDate(this.createdOn, other.createdOn, TaskSortDir.Desc);
  }

  /** Closed work below open work: the first thing every order asks, and the only part a
   *  list with no sort key of its own still wants. */
  static closedLast(a: BaseTask, b: BaseTask): number {
    return a.isClosed === b.isClosed ? 0 : (a.isClosed ? 1 : -1);
  }

  /** `compareTo` as a comparator, for `Array.prototype.sort`. */
  static comparator(
    opts: { key: TaskSortKey; dir?: TaskSortDir; rollup?: RollupLookup },
  ): (a: BaseTask, b: BaseTask) => number {
    return (a, b) => a.compareTo(b, opts);
  }

  /** Whether it carries `tag`, given bare. */
  hasTag(tag: string): boolean {
    return this.tagNames.includes(tag);
  }

  /** Whether its own status closes it. Ancestors don't count — views that need them
   *  use `effectiveStatus`. */
  get isClosed(): boolean {
    return isDoneStatus(this.statusValue);
  }
}
