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
