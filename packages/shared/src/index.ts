// Shared types mirroring the obsidian-pm plugin schema.
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
