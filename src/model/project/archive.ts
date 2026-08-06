/**
 * Leaving archived projects out. A project is put away whole — its tasks go with it —
 * so the views that hide it drop every task of it at once and keep each parent/child
 * chain they do show intact.
 */
import type { Project } from "./project";
import type { ProjectTask } from "./project-task";

/** The projects still in play. */
export function activeProjects(projects: Project[]): Project[] {
  return projects.filter((p) => !p.archived);
}

/**
 * The tasks of those projects. A task naming no project of the list is kept: an orphan is
 * not archived, and dropping it would hide it with no way of bringing it back.
 * Returns `tasks` itself when nothing is archived.
 */
export function withoutArchivedTasks(tasks: ProjectTask[], projects: Project[]): ProjectTask[] {
  const archived = new Set(projects.filter((p) => p.archived).map((p) => p.id));
  if (archived.size === 0) return tasks;
  return tasks.filter((t) => !archived.has(t.projectId));
}
