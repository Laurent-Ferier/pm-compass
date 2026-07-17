export type TaskStatus = string;
export type TaskPriority = "critical" | "high" | "medium" | "low";
export type TaskType = "task" | "milestone" | "subtask";

export interface Task {
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
  const visited = new Set<string>([taskId]);
  const queue = [taskId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childMap.get(cur) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      found.push(child.id);
      queue.push(child.id);
    }
  }
  return found;
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
