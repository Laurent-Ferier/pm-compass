/**
 * A project task: the note obsidian-pm writes under a project, parsed. `ProjectTaskNote`
 * reads and writes the note; this is the shape the rest of the plugin passes around.
 */
import { BaseTask, STATUSES, Status, Priority } from "../base-task";
import { isAncestor } from "./task-tree";
import type { CardLayout } from "./card-layout";
import type { StoreKey } from "../store/note-store";
// Mutual: a task is what its note reads as, and the note is where its fields are kept.
import type { ProjectTaskNote } from "../store/project-task-note";

export type TaskStatus = string;
/** An alias so `Task.priority` reads in Task terms; the values live in `Priority`. */
export type TaskPriority = Priority;

/** What a task is on its project's scale. Stored in the `type` frontmatter field;
 *  `Subtask` is implied by nesting rather than chosen — see `typeAfterMove`. */
export enum TaskType {
  Task = "task",
  Milestone = "milestone",
  Subtask = "subtask",
}

const TASK_TYPE_VALUES = new Set<string>(Object.values(TaskType));

/** Narrows a stored `type`, or `undefined` when absent or unrecognised — a task with
 *  no type reads as a plain `Task`. */
export function toTaskType(value: unknown): TaskType | undefined {
  return typeof value === "string" && TASK_TYPE_VALUES.has(value) ? (value as TaskType) : undefined;
}

/** A project task as its file holds it. Split out from `Task` so the reader and the tests
 *  can name the shape they build. */
export interface TaskFields {
  id: string;
  title: string;
  projectId: string;
  parentId?: string;
  status: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  /** IDs of tasks that must complete before this one. */
  dependencies: string[];
  /** Days, as `dates.ts` holds them; the file's own `YYYY-MM-DD` fields, parsed. */
  start?: Date;
  due?: Date;
  progress?: number;
  /** Instants: obsidian-pm writes these as ISO timestamps. */
  completed?: Date;
  assignees?: string[];
  tags?: string[];
  createdAt?: Date;
  updatedAt?: Date;
  /** Where its card sits in the graph and how big it is, when either has been chosen by
   *  hand. About the drawing rather than the work — see `card-layout.ts`. */
  card?: CardLayout;
  /** Vault-relative path, injected by the vault reader. */
  filePath: string;
}

/**
 * An obsidian-pm task file, parsed. A `BaseTask` so it can share a list with the daily
 * notes' own tasks — see `ui/task-list.ts`.
 *
 * What a task *is* to the rest of the plugin; what it is to the vault is its note, which is
 * where the fields below are kept. A task holds none of them itself, so there is one answer
 * to what the file says and no copy to fall behind it.
 *
 * Made by `ProjectTaskNoteStore` alone: the constructor takes the key only a store holds,
 * so every task in play is one the store read and goes on holding.
 */
export class Task extends BaseTask implements TaskFields {
  constructor(_key: StoreKey, readonly persistence: ProjectTaskNote) {
    super();
  }

  // ── What the note reads as ───────────────────────────────────────────────
  //
  // Setting one of these puts it on the note and owes the file the change; the write
  // follows on the next microtask, so everything set in one turn lands in one pass. A
  // caller that wants to know it landed awaits `persistence.flush()`.
  //
  // The rest are read-only: `id` and the stamps are the file's own, `completed` follows
  // `status`, `projectId` and `parentId` are `moveTask`'s, and `card` is `patchCard`'s.

  get id(): string {
    return this.persistence.snapshot().id;
  }

  get title(): string {
    return this.persistence.snapshot().title;
  }

  set title(value: string) {
    this.persistence.set("title", value);
  }

  get projectId(): string {
    return this.persistence.snapshot().projectId;
  }

  get parentId(): string | undefined {
    return this.persistence.snapshot().parentId;
  }

  get status(): TaskStatus {
    return this.persistence.snapshot().status;
  }

  set status(value: TaskStatus) {
    this.persistence.set("status", value);
  }

  get priority(): TaskPriority | undefined {
    return this.persistence.snapshot().priority;
  }

  set priority(value: TaskPriority | undefined) {
    this.persistence.set("priority", value || undefined);
  }

  get type(): TaskType | undefined {
    return this.persistence.snapshot().type;
  }

  set type(value: TaskType | undefined) {
    this.persistence.set("type", value);
  }

  get dependencies(): string[] {
    return this.persistence.snapshot().dependencies;
  }

  set dependencies(value: string[]) {
    this.persistence.set("dependencies", value);
  }

  get start(): Date | undefined {
    return this.persistence.snapshot().start;
  }

  set start(value: Date | undefined) {
    this.persistence.set("start", value);
  }

  get due(): Date | undefined {
    return this.persistence.snapshot().due;
  }

  set due(value: Date | undefined) {
    this.persistence.set("due", value);
  }

  get progress(): number | undefined {
    return this.persistence.snapshot().progress;
  }

  set progress(value: number | undefined) {
    this.persistence.set("progress", value);
  }

  get completed(): Date | undefined {
    return this.persistence.snapshot().completed;
  }

  get assignees(): string[] | undefined {
    return this.persistence.snapshot().assignees;
  }

  get tags(): string[] | undefined {
    return this.persistence.snapshot().tags;
  }

  set tags(value: string[] | undefined) {
    this.persistence.set("tags", value);
  }

  get createdAt(): Date | undefined {
    return this.persistence.snapshot().createdAt;
  }

  get updatedAt(): Date | undefined {
    return this.persistence.snapshot().updatedAt;
  }

  get card(): CardLayout | undefined {
    return this.persistence.snapshot().card;
  }

  /** Where the file sits. The note's own, and fixed: a task that moves gets a new note. */
  get filePath(): string {
    return this.persistence.filePath;
  }

  /** Its fields as a plain record: a reading that goes on saying what the task said, for
   *  whatever has to hold one while the vault moves on under it. */
  toFields(): TaskFields {
    return { ...this.persistence.snapshot() };
  }

  /** Its own deadline. The one in force can be an ancestor's — `computeEffectiveValues`. */
  get plannedDate(): Date | undefined {
    return this.due;
  }

  /** Frontmatter stores these bare already. */
  get tagNames(): readonly string[] {
    return this.tags ?? [];
  }

  get ownPriority(): Priority | null {
    return this.priority ?? null;
  }

  get statusValue(): string {
    return this.status;
  }

  get closedOn(): Date | null {
    return this.completed ?? null;
  }

  get ownDue(): Date | null {
    return this.due ?? null;
  }

  get createdOn(): Date | null {
    return this.createdAt ?? null;
  }

  /** A project task lives in a file of its own, so it has no line in a list. */
  get fileLine(): number | null {
    return null;
  }

  /** Its id: what `computeEffectiveValues` keys its roll-up on. */
  get rollupId(): string | null {
    return this.id;
  }

  /** The full scale: a project task is picked from six statuses, not ticked. */
  get statusScale(): readonly Status[] {
    return STATUSES;
  }

  /** A project task's title is its own; nothing is stripped from it. */
  rowTitle(): string {
    return this.title;
  }
}

/** A new deps array with `id` added; the original when it is already there. */
export function addDependencyToTask(deps: string[], id: string): string[] {
  return deps.includes(id) ? deps : [...deps, id];
}

/** A new deps array with `id` removed; the original when it is absent. */
export function removeDependencyFromTask(deps: string[], id: string): string[] {
  return deps.filter(d => d !== id);
}

/** Which sort of destination a move targets: a project that exists, or one to create. */
export enum MoveChoiceKind {
  Existing = "existing",
  NewProject = "new-project",
}

/** Where a task may be sent: a project, and optionally a parent task inside it. */
export type MoveChoice =
  | {
      kind: MoveChoiceKind.Existing;
      projectId: string;
      projectFilePath: string;
      projectTitle: string;
      parentTask?: Task;
    }
  | { kind: MoveChoiceKind.NewProject; title: string };

/** Why a move was refused. Callers branch on this, never on the `reason` text beside
 *  it, which is free to be reworded. */
export enum MoveIssue {
  TaskNotFound = "task-not-found",
  Self = "self",
  ParentNotFound = "parent-not-found",
  OwnSubtree = "own-subtree",
  ParentWrongProject = "parent-wrong-project",
  AlreadyHere = "already-here",
}

export type MoveTargetCheck =
  | { valid: true }
  | { valid: false; issue: MoveIssue; reason: string };

/**
 * Whether `taskId` can be moved under the destination: both exist, the parent is in the
 * destination project, the task isn't moved into its own subtree, and the destination is
 * somewhere new. `AlreadyHere` counts as invalid so a picker greys that row out.
 */
export function isValidMoveTarget(
  tasks: Task[],
  taskId: string,
  destination: { projectId: string; parentTaskId?: string },
): MoveTargetCheck {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { valid: false, issue: MoveIssue.TaskNotFound, reason: "Task not found" };
  if (destination.parentTaskId === taskId) {
    return { valid: false, issue: MoveIssue.Self, reason: "Cannot move a task under itself" };
  }

  if (destination.parentTaskId) {
    const parent = tasks.find(t => t.id === destination.parentTaskId);
    if (!parent) return { valid: false, issue: MoveIssue.ParentNotFound, reason: "Parent task not found" };
    // Meeting the moved task on the way up means the destination is inside its own
    // subtree. O(depth), against a descendant BFS. The parent itself is checked above.
    if (isAncestor(new Map(tasks.map(t => [t.id, t])), taskId, parent.id)) {
      return { valid: false, issue: MoveIssue.OwnSubtree, reason: "Cannot move a task under its own subtask" };
    }
    if (parent.projectId !== destination.projectId) {
      return {
        valid: false,
        issue: MoveIssue.ParentWrongProject,
        reason: "Parent task is not in the destination project",
      };
    }
  }

  if (task.projectId === destination.projectId && (task.parentId ?? undefined) === destination.parentTaskId) {
    return { valid: false, issue: MoveIssue.AlreadyHere, reason: "Task is already here" };
  }
  return { valid: true };
}

/**
 * Whether `sourceId` can be added to `targetId`'s dependencies: both exist, share a
 * project, don't sit on one line of descent, aren't already linked, and don't close a
 * cycle. `sourceId` is the prerequisite, `targetId` the task that gains the entry.
 *
 * Depth is no bar: a graph lifts each end of a stored dependency to the card standing for
 * it on the level being drawn, so two tasks at different depths of a project read fine
 * wherever they are looked at.
 */
export function isValidDependencyTarget(
  tasks: Task[],
  sourceId: string,
  targetId: string,
): { valid: boolean; reason?: string } {
  if (sourceId === targetId) return { valid: false, reason: "Cannot depend on itself" };
  const source = tasks.find(t => t.id === sourceId);
  const target = tasks.find(t => t.id === targetId);
  if (!source || !target) return { valid: false, reason: "Task not found" };
  if (source.projectId !== target.projectId) return { valid: false, reason: "Tasks must be in the same project" };
  const taskById = new Map(tasks.map(t => [t.id, t]));
  // Two tasks on one line of descent can never be drawn joined: at every level both ends
  // lift onto the same card, so the link says nothing wherever it is looked at.
  if (isAncestor(taskById, sourceId, targetId) || isAncestor(taskById, targetId, sourceId)) {
    return { valid: false, reason: "A task and one of its subtasks cannot depend on each other" };
  }
  if (target.dependencies.includes(sourceId)) return { valid: false, reason: "Dependency already exists" };
  // Reaching targetId from sourceId means sourceId already depends on it, so the new
  // edge would close a cycle.
  const visited = new Set<string>();
  const queue = [sourceId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === targetId) return { valid: false, reason: "Would create a cycle" };
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const dep of taskById.get(cur)?.dependencies ?? []) queue.push(dep);
  }
  return { valid: true };
}
