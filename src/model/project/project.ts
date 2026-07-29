/**
 * A project: the obsidian-pm note a task tree hangs off. `ProjectFile` reads and writes
 * the note; this is the shape the rest of the plugin passes around.
 */
import type { Task } from "./task";

export interface Project {
  id: string;
  title: string;
  /** Tasks belonging to this project, populated by the vault reader. */
  tasks: Task[];
  color?: string;
  icon?: string;
  createdAt?: Date;
  updatedAt?: Date;
  /** Vault-relative path, injected by the vault reader. */
  filePath: string;
}

export function isTask(x: Project | Task): x is Task {
  return "projectId" in x;
}
