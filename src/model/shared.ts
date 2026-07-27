import { BaseTask } from "./base-task";
import { CANCELLED_STATUS, DONE_STATUSES } from "./task-vocabulary";
import type { Priority } from "./task-vocabulary";

export type TaskStatus = string;
/** Kept as an alias so `Task.priority` reads in Task terms; the values live in `Priority`. */
export type TaskPriority = Priority;
export type TaskType = "task" | "milestone" | "subtask";

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
  start?: string;
  due?: string;
  progress?: number;
  completed?: string;
  assignees?: string[];
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
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
  declare start?: string;
  declare due?: string;
  declare progress?: number;
  declare completed?: string;
  declare assignees?: string[];
  declare tags?: string[];
  declare createdAt?: string;
  declare updatedAt?: string;
  declare filePath: string;

  constructor(fields: TaskFields) {
    super();
    Object.assign(this, fields);
  }

  /** Its own deadline. The one in force can be an ancestor's — `computeEffectiveValues`. */
  get plannedDate(): string | undefined {
    return this.due;
  }
}

export interface Project {
  id: string;
  title: string;
  /** Tasks belonging to this project, populated by the vault reader. */
  tasks: Task[];
  color?: string;
  icon?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Vault-relative path, injected by the vault reader. */
  filePath: string;
}

export function isTask(x: Project | Task): x is Task {
  return "projectId" in x;
}

export function buildChildMap(tasks: Task[]): Map<string | undefined, Task[]> {
  const map = new Map<string | undefined, Task[]>();
  for (const t of tasks) {
    const key = t.parentId ?? undefined;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return map;
}

/** Instruction a `walkTree` visitor may return to steer the traversal. */
export type WalkAction = "stop" | "prune" | void;

/**
 * The single guarded traversal every task-tree walk is built on. Visits the
 * neighbours of `startId` (not `startId` itself), expanding each via `next`.
 * A visitor returning "stop" halts the whole walk; "prune" keeps the walk going
 * but does not expand that node's neighbours. A visited-set guards against
 * malformed `parentId` cycles, which nothing in the vault format prevents.
 *
 * `next` takes an id and returns the tasks reachable from it — pass a child map
 * (downward) or a parent lookup (upward). Prefer the `walkDescendants` /
 * `walkAncestors` wrappers below over calling this directly.
 */
export function walkTree(
  startId: string,
  next: (id: string) => Task[],
  visit: (task: Task) => WalkAction,
): void {
  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const neighbour of next(cur)) {
      if (visited.has(neighbour.id)) continue;
      visited.add(neighbour.id);
      const action = visit(neighbour);
      if (action === "stop") return;
      if (action !== "prune") queue.push(neighbour.id);
    }
  }
}

/** Walk downward through descendants, using a prebuilt `buildChildMap` result. */
export function walkDescendants(
  childMap: Map<string | undefined, Task[]>,
  startId: string,
  visit: (task: Task) => WalkAction,
): void {
  walkTree(startId, (id) => childMap.get(id) ?? [], visit);
}

/** Walk upward through the ancestor chain, using an id→task lookup. */
export function walkAncestors(
  byId: Map<string, Task>,
  startId: string,
  visit: (task: Task) => WalkAction,
): void {
  walkTree(
    startId,
    (id) => {
      const parentId = byId.get(id)?.parentId;
      const parent = parentId ? byId.get(parentId) : undefined;
      return parent ? [parent] : [];
    },
    visit,
  );
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

/**
 * IDs of every task below taskId, found by walking `parentId` breadth-first.
 * Excludes taskId itself. Guards against malformed `parentId` cycles, which
 * nothing in the vault format prevents.
 */
export function collectDescendants(tasks: Task[], taskId: string): string[] {
  const childMap = buildChildMap(tasks);
  const found: string[] = [];
  walkDescendants(childMap, taskId, (child) => {
    found.push(child.id);
  });
  return found;
}

/**
 * True when an ancestor of `task` is cancelled — which cancels `task` too, a
 * state derived here rather than written into each descendant's file.
 */
export function hasCancelledAncestor(task: Task, byId: Map<string, Task>): boolean {
  let cancelled = false;
  walkAncestors(byId, task.id, (ancestor) => {
    if (ancestor.status === CANCELLED_STATUS) {
      cancelled = true;
      return "stop";
    }
    return;
  });
  return cancelled;
}

/** The status a task is really in: `cancelled` when an ancestor is, its own otherwise. */
export function effectiveStatus(task: Task, byId: Map<string, Task>): TaskStatus {
  return hasCancelledAncestor(task, byId) ? CANCELLED_STATUS : task.status;
}

/** True when a task is closed — by its own status, or by a cancelled ancestor. */
export function isEffectivelyClosed(task: Task, byId: Map<string, Task>): boolean {
  return DONE_STATUSES.has(effectiveStatus(task, byId));
}

/**
 * True if any descendant of `startId` (at any depth) is still active — i.e. its
 * status is not in `DONE_STATUSES`. Stops at the first open descendant found.
 * A cancelled descendant prunes its own subtree, cancelled with it.
 */
export function hasOpenDescendants(
  childMap: Map<string | undefined, Task[]>,
  startId: string,
): boolean {
  let open = false;
  walkDescendants(childMap, startId, (child) => {
    if (child.status === CANCELLED_STATUS) return "prune";
    if (!DONE_STATUSES.has(child.status)) {
      open = true;
      return "stop";
    }
    return;
  });
  return open;
}

/**
 * The warning condition: a task marked done while at least one of its
 * descendants is still open. Surfaces work that a closed-off parent is quietly
 * hiding. Cancelled, or under something cancelled, it stays silent: open work
 * below a called-off task is no inconsistency.
 */
export function isCompletedWithOpenSubtasks(
  task: Task,
  childMap: Map<string | undefined, Task[]>,
  byId: Map<string, Task>,
): boolean {
  if (effectiveStatus(task, byId) === CANCELLED_STATUS) return false;
  return DONE_STATUSES.has(task.status) && hasOpenDescendants(childMap, task.id);
}

/**
 * The mirror of `isCompletedWithOpenSubtasks`, seen from the child: a task that
 * is still open while its direct parent is already done. Flags the child side of
 * the same inconsistent boundary, which a cancelled ancestor doesn't create.
 */
export function isOpenUnderCompletedParent(
  task: Task,
  byId: Map<string, Task>,
): boolean {
  if (DONE_STATUSES.has(task.status)) return false;
  if (hasCancelledAncestor(task, byId)) return false;
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  return !!parent && DONE_STATUSES.has(parent.status);
}

/** Where a task may be sent: a project, and optionally a parent task inside it. */
export type MoveChoice =
  | {
      kind: "existing";
      projectId: string;
      projectFilePath: string;
      projectTitle: string;
      parentTask?: Task;
    }
  | { kind: "new-project"; title: string };

/**
 * Why a move was refused. Callers branch on `issue`, never on `reason` — the
 * latter is display text and free to be reworded.
 */
export type MoveIssue =
  | "task-not-found"
  | "self"
  | "parent-not-found"
  | "own-subtree"
  | "parent-wrong-project"
  | "already-here";

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
 * Note "already-here" is reported as invalid so a picker greys out the task's
 * current location; as a move it simply means there is nothing to do.
 */
export function isValidMoveTarget(
  tasks: Task[],
  taskId: string,
  destination: { projectId: string; parentTaskId?: string },
): MoveTargetCheck {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { valid: false, issue: "task-not-found", reason: "Task not found" };
  if (destination.parentTaskId === taskId) {
    return { valid: false, issue: "self", reason: "Cannot move a task under itself" };
  }

  if (destination.parentTaskId) {
    const parent = tasks.find(t => t.id === destination.parentTaskId);
    if (!parent) return { valid: false, issue: "parent-not-found", reason: "Parent task not found" };
    // Walk up from the destination parent: if we meet the moved task, the
    // destination sits inside its own subtree. Cheaper than a descendant BFS
    // (O(depth)), and the visited guard stops malformed parentId cycles.
    const byId = new Map(tasks.map(t => [t.id, t]));
    const visited = new Set<string>();
    let cur: Task | undefined = parent;
    while (cur) {
      if (cur.id === taskId) {
        return { valid: false, issue: "own-subtree", reason: "Cannot move a task under its own subtask" };
      }
      if (visited.has(cur.id)) break;
      visited.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    if (parent.projectId !== destination.projectId) {
      return {
        valid: false,
        issue: "parent-wrong-project",
        reason: "Parent task is not in the destination project",
      };
    }
  }

  if (task.projectId === destination.projectId && (task.parentId ?? undefined) === destination.parentTaskId) {
    return { valid: false, issue: "already-here", reason: "Task is already here" };
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
