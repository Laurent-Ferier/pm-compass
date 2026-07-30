import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ChildEntry, ChildLinkSection } from "./child-links";
import { PROJECT_TASK_SECTION, SUBTASK_SECTION, removeChildEntry } from "./child-links";
import {
  asFrontmatterRecord, basenameOf, BodyPrefixKind, bodyPrefix, parentDirOf, stringArray,
} from "../operations/file-helpers";
import { ProjectFile } from "./project-file";
import { ProjectTaskFile } from "./project-task-file";
import type { Project } from "./project";
import type { Task } from "./task";
import { Status, toStatus } from "../base-task";
import { Frontmatter } from "./frontmatter";

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
    checked: toStatus(task.status) === Status.Done,
  };
}

/** The task `parentId` names, or undefined for one at its project's root — where a
 *  `parentId` that resolves to nothing falls back, rather than being listed nowhere. */
function parentOf(task: Task, byId: Map<string, Task>): Task | undefined {
  if (!task.parentId) return undefined;
  const parent = byId.get(task.parentId);
  if (!parent) return undefined;
  return parentDirOf(parent.filePath) === parentDirOf(task.filePath) ? parent : undefined;
}

/**
 * Makes every `## Tasks` and `## Subtasks` section agree with the tasks that exist —
 * entries added, titles refreshed, boxes matched to statuses, departed entries dropped —
 * which is what lets a later ticked box be read as a fresh edit. Also puts each task's
 * body link back in step with its `parentId`, which `moveTask` commits separately.
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
  // Every task, not just those with children: one that lost its last subtask still has
  // an entry to clear, and a note with none costs a read and no write.
  for (const task of tasks) {
    const note = new ProjectTaskFile(app, task.filePath);
    if (await note.syncChildListing((children.get(task.id) ?? []).map(entryFor))) listingsRewritten++;
  }

  let prefixesFixed = 0;
  for (const task of tasks) {
    const parent = parentOf(task, byId);
    const project = byProject.get(task.projectId);
    // Nothing to point at: a task whose project note is missing keeps its prefix.
    if (!parent && !project) continue;
    const wanted = parent
      ? bodyPrefix(parent, BodyPrefixKind.Parent)
      : bodyPrefix(project!, BodyPrefixKind.Project);
    const note = new ProjectTaskFile(app, task.filePath);
    if (await note.readBodyPrefix() !== wanted) {
      await note.setBodyPrefix(wanted);
      prefixesFixed++;
    }
  }

  return { listingsRewritten, prefixesFixed };
}

/**
 * Drops a deleted task's checklist entry from whatever listed it, for a deletion outside
 * the plugin. The repair pass can't: with the file gone, an entry naming it looks like a
 * link to a note not created yet. Here the deletion is the evidence.
 */
export async function unlinkDeletedTask(app: App, filePath: string): Promise<void> {
  const folder = parentDirOf(filePath);
  if (!folder.endsWith("_tasks") || !filePath.endsWith(".md")) return;

  const basename = basenameOf(filePath);
  // The folder's project first, being one read and the commonest holder, then the
  // siblings that list anything — one with no `subtaskIds` can't be it.
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
    if (fm?.[Frontmatter.IsTask] !== true || stringArray(fm[Frontmatter.SubtaskIds]).length === 0) return [];
    return [child.path];
  });
}
