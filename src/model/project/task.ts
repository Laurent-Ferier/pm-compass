/**
 * A project task: the note obsidian-pm writes under a project, parsed. `ProjectTaskFile`
 * reads and writes the note; this is the shape the rest of the plugin passes around.
 */
import { BaseTask, STATUSES, Status, Priority } from "../base-task";
import { WalkAction, walkAncestors } from "./task-tree";

export type TaskStatus = string;
/** Kept as an alias so `Task.priority` reads in Task terms; the values live in `Priority`. */
export type TaskPriority = Priority;

/** What a task is on its project's scale. Stored in the `type` frontmatter field;
 *  `Subtask` is implied by nesting rather than chosen — see `typeAfterMove`. */
export enum TaskType {
  Task = "task",
  Milestone = "milestone",
  Subtask = "subtask",
}

const TASK_TYPE_VALUES = new Set<string>(Object.values(TaskType));

/** Narrows a stored `type` to a `TaskType`, or `undefined` when absent or unrecognised —
 *  a task with no type reads as a plain `Task` everywhere it matters. */
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
  /** Nested subtasks (empty array when read directly from vault files). */
  subtasks: Task[];
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
  /** Vault-relative path, injected by the vault reader. */
  filePath: string;
}

/** An obsidian-pm task file, parsed. A `BaseTask` so it can share a list with the daily
 *  notes' own tasks — see `ui/task-list.ts`. */
export class Task extends BaseTask implements TaskFields {
  // Declared, not initialized: the constructor copies `TaskFields` wholesale, so the
  // interface above stays the one place a task's fields are listed.
  declare id: string;
  declare title: string;
  declare projectId: string;
  declare parentId?: string;
  declare status: TaskStatus;
  declare priority?: TaskPriority;
  declare type?: TaskType;
  declare dependencies: string[];
  declare subtasks: Task[];
  declare start?: Date;
  declare due?: Date;
  declare progress?: number;
  declare completed?: Date;
  declare assignees?: string[];
  declare tags?: string[];
  declare createdAt?: Date;
  declare updatedAt?: Date;
  declare filePath: string;

  constructor(fields: TaskFields) {
    super();
    Object.assign(this, fields);
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

/**
 * Returns a new deps array with id added.
 * Idempotent: if id is already present the original array is returned unchanged.
 */
export function addDependencyToTask(deps: string[], id: string): string[] {
  return deps.includes(id) ? deps : [...deps, id];
}

/**
 * Returns a new deps array with id removed.
 * Idempotent: if id is absent the original array is returned unchanged.
 */
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

/**
 * Why a move was refused. Callers branch on this, never on the `reason` text that
 * comes with it — the latter is display text and free to be reworded.
 */
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
 * Validates whether taskId can be moved under the given destination.
 * Mirrors isValidDependencyTarget's shape. Takes a parent *ID* rather than file
 * paths so this module stays free of vault/App dependencies.
 *
 * Rules: the task exists; the destination parent exists and lives in the
 * destination project; the task is not moved under itself or its own subtree;
 * and the destination differs from where the task already is.
 *
 * Note `AlreadyHere` is reported as invalid so a picker greys out the task's
 * current location; as a move it simply means there is nothing to do.
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
    // Walk up from the destination parent: if we meet the moved task, the
    // destination sits inside its own subtree. Cheaper than a descendant BFS
    // (O(depth)). The parent itself is not on the walk, and needs no check —
    // moving under itself is the case above.
    let ownSubtree = false;
    walkAncestors(new Map(tasks.map(t => [t.id, t])), parent.id, (ancestor) => {
      if (ancestor.id !== taskId) return;
      ownSubtree = true;
      return WalkAction.Stop;
    });
    if (ownSubtree) {
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
 * Validates whether sourceId can be added to targetTask.dependencies.
 * Rules: both tasks must exist, be in the same project and at the same level
 * (same parentId), the dependency must not already exist, and it must not
 * create a cycle (checked transitively via BFS over the full dependency graph).
 *
 * @param tasks     Full flat task list used to look up both tasks.
 * @param sourceId  The prerequisite task (whose connect button was clicked).
 * @param targetId  The task that will gain the new dependency entry.
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
  if (source.parentId !== target.parentId) return { valid: false, reason: "Tasks must be at the same level" };
  if (target.dependencies.includes(sourceId)) return { valid: false, reason: "Dependency already exists" };
  // BFS from sourceId following existing dependencies; if we can reach targetId,
  // then sourceId already (transitively) depends on targetId, and adding
  // targetId → sourceId would close a cycle.
  const taskById = new Map(tasks.map(t => [t.id, t]));
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
