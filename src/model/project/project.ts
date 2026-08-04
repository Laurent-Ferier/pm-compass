/**
 * A project: the obsidian-pm note a task tree hangs off. `ProjectFile` reads and writes
 * the note; this is the shape the rest of the plugin passes around.
 */
import type { Task } from "./task";
import type { CardLayout } from "./card-layout";

export interface Project {
  id: string;
  title: string;
  /** Tasks belonging to this project, populated by the vault reader. */
  tasks: Task[];
  color?: string;
  icon?: string;
  /** Put away: its tasks are left out of the graph, the dashboard and the inbox. */
  archived?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  /** Where its card sits among the projects and how big it is, when either has been chosen
   *  by hand — see `card-layout.ts`. */
  card?: CardLayout;
  /** Vault-relative path, injected by the vault reader. */
  filePath: string;
}

export function isTask(x: Project | Task): x is Task {
  return "projectId" in x;
}
