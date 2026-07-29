import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ChildEntry, ChildLinkSection } from "./child-links";
import { PROJECT_TASK_SECTION, SUBTASK_SECTION, removeChildEntry } from "./child-links";
import { asFrontmatterRecord, basenameOf, parentDirOf, stringArray } from "./file-helpers";
import { ProjectFile } from "../project-file";
import { ProjectTaskFile } from "../project-task-file";
import type { Project, Task } from "../shared";
import { COMPLETED_STATUS } from "../task-vocabulary";

export interface RepairResult {
  /** Notes whose listing was rewritten. */
  listingsRewritten: number;
  /** Task notes whose `Project:`/`Parent:` link was put back in step with `parentId`. */
  prefixesFixed: number;
}

/** How a task should be listed by whatever holds it. */
function entryFor(task: Task): ChildEntry {
  return {
    id: task.id,
    title: task.title,
    basename: basenameOf(task.filePath),
    checked: task.status === COMPLETED_STATUS,
  };
}

/**
 * The task `parentId` names, or undefined for a task that belongs at its project's root.
 *
 * A `parentId` naming nothing, or a task in another project's folder where the
 * checklist's basename link can't resolve, falls back to the root — otherwise the task
 * would be listed nowhere and the pass would drop the entry it had.
 */
function parentOf(task: Task, byId: Map<string, Task>): Task | undefined {
  if (!task.parentId) return undefined;
  const parent = byId.get(task.parentId);
  if (!parent) return undefined;
  return parentDirOf(parent.filePath) === parentDirOf(task.filePath) ? parent : undefined;
}

/**
 * Make every project's `## Tasks` and every parent task's `## Subtasks` agree with the
 * tasks that actually exist — entries added, titles refreshed, boxes matched to
 * statuses, departed entries dropped. This is what lets a later ticked box be read as
 * an edit the user just made.
 *
 * Also puts each task's `Project:`/`Parent:` body link back in step with its
 * `parentId`: `moveTask` commits the two separately, and a crash between them leaves
 * the listing and the status push following different parents.
 */
export async function repairListings(
  app: App, projects: Project[], tasks: Task[],
): Promise<RepairResult> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const children = new Map<string, Task[]>();
  const roots = new Map<string, Task[]>();

  for (const task of tasks) {
    const parent = parentOf(task, byId);
    const bucket = parent ? children : roots;
    const key = parent ? parent.id : task.projectId;
    bucket.set(key, [...(bucket.get(key) ?? []), task]);
  }

  let listingsRewritten = 0;
  for (const project of projects) {
    const note = new ProjectFile(app, project.filePath);
    if (await note.syncChildListing((roots.get(project.id) ?? []).map(entryFor))) listingsRewritten++;
  }
  // Every task, not just the ones with children: a parent that has lost its last
  // subtask still has the entry and the `subtaskIds` to clear, and a note with neither
  // costs one read and no write.
  for (const task of tasks) {
    const note = new ProjectTaskFile(app, task.filePath);
    if (await note.syncChildListing((children.get(task.id) ?? []).map(entryFor))) listingsRewritten++;
  }

  let prefixesFixed = 0;
  for (const task of tasks) {
    const parent = parentOf(task, byId);
    const project = byProject.get(task.projectId);
    // Nothing to point at, so nothing to correct — a task whose project note is
    // missing keeps whatever prefix it has.
    if (!parent && !project) continue;
    const wanted = parent
      ? `Parent: [[${basenameOf(parent.filePath)}|${parent.title}]]`
      : `Project: [[${basenameOf(project!.filePath)}|${project!.title}]]`;
    const note = new ProjectTaskFile(app, task.filePath);
    if (await note.readBodyPrefix() !== wanted) {
      await note.setBodyPrefix(wanted);
      prefixesFixed++;
    }
  }

  return { listingsRewritten, prefixesFixed };
}

/**
 * Drop a deleted task's checklist entry from whatever listed it.
 *
 * For a task deleted outside the plugin, which `ProjectTaskFile.delete` never saw. The
 * repair pass can't do this itself: with the file gone, an entry naming it is
 * indistinguishable from a link the user wrote to a note not created yet, so the pass
 * leaves both alone. Here the deletion is the evidence, and the path is exact.
 */
export async function unlinkDeletedTask(app: App, filePath: string): Promise<void> {
  const folder = parentDirOf(filePath);
  if (!folder.endsWith("_tasks") || !filePath.endsWith(".md")) return;

  const basename = basenameOf(filePath);
  // The project owning the folder first: one read, and the commonest holder. Then the
  // siblings that list anything at all — a task with no `subtaskIds` can't be the one.
  const candidates: { path: string; section: ChildLinkSection }[] = [
    { path: normalizePath(folder.replace(/_tasks$/, ".md")), section: PROJECT_TASK_SECTION },
    ...listingSiblings(app, folder).map((path) => ({ path, section: SUBTASK_SECTION })),
  ];

  for (const { path, section } of candidates) {
    // A task is listed in exactly one place, so the first hit is the only one.
    if (await removeChildEntry(app, path, section, basename)) return;
  }
}

/** The task notes in `folder` that list subtasks, read off the cache rather than disk. */
function listingSiblings(app: App, folder: string): string[] {
  const dir = app.vault.getAbstractFileByPath(folder);
  if (!(dir instanceof TFolder)) return [];
  return dir.children.flatMap((child) => {
    if (!(child instanceof TFile) || child.extension !== "md") return [];
    const fm = asFrontmatterRecord(app.metadataCache.getFileCache(child)?.frontmatter);
    if (fm?.["pm-task"] !== true || stringArray(fm["subtaskIds"]).length === 0) return [];
    return [child.path];
  });
}
