/**
 * The vocabulary and the abstraction every kind of task shares: a daily note's checklist
 * line (`DayTask`) and an obsidian-pm project task (`Task`). This file imports nothing,
 * so any layer can depend on it.
 */

/** The status scale. A string enum for the same reasons as `Priority` below: call sites
 *  name the value while what is stored stays the plain lowercase string. */
export enum Status {
  /** Where a task starts, and what an unset `status` field reads as. */
  Todo = "todo",
  InProgress = "in-progress",
  Blocked = "blocked",
  Review = "review",
  /** The closed status for work that was finished rather than dropped. The one that
   *  sets a task's `completed` timestamp — a cancel keeps whatever is already there. */
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

const STATUS_VALUES = new Set<string>(Object.values(Status));

/**
 * Narrows a stored status to a `Status`, or `undefined` for a value none of the views
 * knows — a hand-typed frontmatter entry, a status from a future obsidian-pm. Such a
 * value is still shown as it stands (see `statusLabel`); it just matches nothing.
 */
export function toStatus(value: unknown): Status | undefined {
  return typeof value === "string" && STATUS_VALUES.has(value) ? (value as Status) : undefined;
}

/** Whether a status counts as "no longer active" for scoring/filtering purposes —
 *  finished or dropped. An unrecognised status is never closed. */
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

/**
 * Higher = more urgent. The one ordering of the scale: every comparison of two
 * priorities goes through `priorityRank`, and `task-scoring` combines these same
 * numbers with `deadlinePoints`, which is why they step by 100 rather than by 1.
 */
const PRIORITY_RANK: Record<Priority, number> = {
  [Priority.Critical]: 400,
  [Priority.High]: 300,
  [Priority.Medium]: 200,
  [Priority.Low]: 100,
  /** Half a rung below `Low`: off the project scale (see `PRIORITIES`), but a `⏬`
   *  checklist line is triaged work and must not tie with an untriaged one. */
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

/** Which key a task list is ordered on. The Inbox is the one tab that lets the user pick
 *  (persisted as `settings.inboxSortBy`), but the key belongs with the comparison that
 *  reads it — see `BaseTask.compareTo`. */
export enum TaskSortKey {
  Created = "created",
  Priority = "priority",
  Title = "title",
  Due = "due",
  /** File order: the tasks as they appear in the file holding them. A task with a
   *  note of its own has no line to order by, and sorts last — see `fileLine`. */
  File = "file",
}

/** Which way that key runs. Stored per key, since one shared value cannot mean both
 *  "newest first" and "A → Z" (persisted as `settings.inboxSortDir`). */
export enum TaskSortDir {
  Asc = "asc",
  Desc = "desc",
}

/**
 * What a roll-up over the task tree knows about one task — `computeEffectiveValues`'
 * entry, described structurally so this file need not know that module exists. A task
 * with no tree around it never has one.
 */
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

/** Oldest first in `Asc`; items missing the date last in both directions — no marker
 *  means unranked, not earliest or latest. */
function byDate(a: Date | null, b: Date | null, dir: TaskSortDir): number {
  if (a && b) return sortSign(dir) * (a.getTime() - b.getTime());
  if (a) return -1;
  if (b) return 1;
  return 0;
}

/** Case- and accent-insensitive title order, so "Écrire" lands next to "ecrire" rather
 *  than after every ASCII title. */
function byTitle(a: BaseTask, b: BaseTask, dir: TaskSortDir): number {
  return sortSign(dir) * a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
}

/** Most urgent first in `Desc`; unset priorities last either way, as in `byDate`. Tasks the
 *  level in force ranks alike go by the level rolled up from the task and its children, so
 *  two subtasks of one high parent are split by how urgent their own subtree is. That
 *  second level is part of the key, not a tie-break, so `dir` turns it too. */
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

/**
 * What a list needs of a task whichever kind it is: a daily note's checklist line
 * (`DayTask`) or an obsidian-pm project task (`Task`). Every list the dashboard and the
 * Inbox show is built on this (`ui/task-list.ts`); nothing here papers over how differently
 * the two are stored and written back.
 */
export abstract class BaseTask {
  abstract readonly title: string;

  /** The vault file holding it: the note a checklist line lives in, a project task's own
   *  file. Null for a line parsed out of any file, which nothing can act on. */
  abstract readonly filePath: string | null;

  /**
   * The day the task is *shown* under, which is what orders a list — a checklist line is
   * dated by the note holding it, whatever the line itself says. Undefined when nothing
   * dates it. An ancestor's deadline can still pull a project task forward; that roll-up is
   * `computeEffectiveValues`', not this.
   */
  abstract get plannedDate(): Date | undefined;

  // ── What a row draws ───────────────────────────────────────────────────────
  // Everything below exists so a row can be rendered from the task alone. Where
  // the two kinds disagree, they disagree behind these members rather than in a
  // caller that narrowed back to the concrete class.

  /** Its tags, bare — no leading `#`, whichever form the file stores. */
  abstract get tagNames(): readonly string[];

  /** The level written on the task itself. What the priority ribbon fills with, and
   *  what a list falls back to when no roll-up says otherwise. */
  abstract get ownPriority(): Priority | null;

  /** The status it reads as, on its own scale. A checklist line has only two. */
  abstract get statusValue(): string;

  /** When it closed, if it did. An instant, not a day. */
  abstract get closedOn(): Date | null;

  /**
   * The statuses this kind can be set to, in picker order. Two values means a
   * checkbox; more means a status picker — which is how a row decides what control
   * to draw, rather than by asking what class the task is.
   */
  abstract get statusScale(): readonly Status[];

  /** The title as a row prints it: a habit line drops the tag that marks it one. */
  abstract rowTitle(habitsTag: string): string;

  // ── What a list orders on ──────────────────────────────────────────────────

  /** Its own deadline, ignoring anything it inherits. */
  abstract get ownDue(): Date | null;

  /** When it was written. A project task records an instant, a checklist line a day;
   *  both are compared by `getTime`, which is what they have always been. */
  abstract get createdOn(): Date | null;

  /** Where it sits in its file, for the one mode that orders on the file rather than
   *  the task. Null for a task that has no line of its own. */
  abstract get fileLine(): number | null;

  /**
   * The id a roll-up files this task's inherited values under. Null for a task that
   * inherits nothing — a checklist line has no tree above it — which is what lets a
   * mixed list read both kinds without asking which is which.
   */
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

  /** The bottom of the ribbon, and the tiebreak between tasks the level in force ranks
   *  alike: the highest level at or below it, its own included. */
  priorityFromBelow(rollup?: RollupLookup): Priority | null {
    return this.rollupOf(rollup)?.subtreePriority ?? this.ownPriority;
  }

  /** The deadline it is held to: an ancestor's when that is sooner, else its own. */
  dueInForce(rollup?: RollupLookup): Date | null {
    return this.rollupOf(rollup)?.due ?? this.ownDue;
  }

  /** The day a list shows it under, with what it inherits taken into account — an
   *  ancestor's deadline pulls a project task forward. Unlike `dueInForce`, a checklist
   *  line answers with its note's day, which is what dates a line whatever it says. */
  plannedDateInForce(rollup?: RollupLookup): Date | undefined {
    return this.rollupOf(rollup)?.due ?? this.plannedDate;
  }

  // ── How two tasks compare ──────────────────────────────────────────────────

  /**
   * Where this task sorts against another on `key`, whichever kinds the two are. The
   * whole order lives here: closed work last, then the mode's own key with anything
   * missing it last, then the tie-breaks every mode shares.
   *
   * `dir` flips the mode's key only — what is missing that key stays last either way,
   * and the tie-breaks a *different* mode falls back on keep reading most-urgent-then-
   * newest whichever way it runs. Within `Priority`, the subtree level is part of the
   * key rather than a tie-break, so it turns with it. Left out, `dir` is the direction
   * that mode reads naturally in.
   */
  compareTo(
    other: BaseTask,
    opts: { key: TaskSortKey; dir?: TaskSortDir; rollup?: RollupLookup },
  ): number {
    const { key, dir = DEFAULT_SORT_DIR[key], rollup } = opts;

    const closed = BaseTask.closedLast(this, other);
    if (closed !== 0) return closed;

    // `File` is the file's own order: the line each task sits on. A task with no line
    // there is missing this mode's key, so it stays last either way, as in every other
    // mode; what settles those is the other fact a file records, when it was written.
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

    // Whatever the mode, tasks it can't tell apart go by priority, most urgent first
    // whichever way the mode reads. Then the newest, as a last resort.
    if (key !== TaskSortKey.Priority) {
      const diff = byPriority(this, other, TaskSortDir.Desc, rollup);
      if (diff !== 0) return diff;
    }
    return byDate(this.createdOn, other.createdOn, TaskSortDir.Desc);
  }

  /**
   * Closed work below open work: a finished task is a record of what happened, not a call
   * on what to do next. The first thing every order asks, and the one part of it a list
   * with no sort key of its own still wants — see `ui/task-list.ts`.
   */
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

  /** Whether it is closed by its own status — ticked, done or cancelled. Says nothing
   *  about its ancestors: a task under a cancelled parent reads open here, and the
   *  views that care use `effectiveStatus`, which needs the whole tree. */
  get isClosed(): boolean {
    return isDoneStatus(this.statusValue);
  }
}
