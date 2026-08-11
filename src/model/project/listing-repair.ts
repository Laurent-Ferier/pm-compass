import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ChildEntry } from "./child-links";
import { basenameOf, parentDirOf } from "../file-helpers";
import { BodyPrefixKind, bodyPrefix, type ProjectTaskIO } from "../io/project-task-io";
import type { VaultData } from "../service/vault-data";
import type { Project } from "./project";
import type { ProjectTask } from "./project-task";
import { Status, toStatus } from "../base-task";
import { Frontmatter, asFrontmatterRecord, stringArray } from "./frontmatter";

/**
 * How long a task's `parentId` must have named nothing before the task is attached to its
 * project instead.
 *
 * A parent note a sync has yet to deliver reads exactly like one that never existed, so a
 * single sighting decides nothing: clearing on it would throw away real parentage, which
 * nothing could put back — a parent landing later is not read for the children it claims.
 * A wait long enough that no delivery is still in flight tells the two apart on its own.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** How many notes the repair has open at once. Enough that a folder of hundreds isn't read
 *  one note at a time, few enough that it doesn't land on a phone as a single burst. */
const REPAIR_CONCURRENCY = 8;

/** `work` over every item, that many at a time, in the order they were given. */
async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = [];
  for (let at = 0; at < items.length; at += REPAIR_CONCURRENCY) {
    done.push(...await Promise.all(items.slice(at, at + REPAIR_CONCURRENCY).map(work)));
  }
  return done;
}

/** A note that could be holding the deleted task's line — a project or another task, which
 *  differ only in the section their listing sits under, and that is the note's own to know. */
type ChildLister = Pick<ProjectTaskIO, "dropChildEntry">;

/** How a task should be listed by whatever holds it. */
function entryFor(task: ProjectTask): ChildEntry {
  return {
    id: task.id,
    title: task.title,
    basename: basenameOf(task.filePath),
    checked: toStatus(task.status) === Status.Done,
  };
}

/**
 * The task `parentId` names, or undefined for one at its project's root — where a `parentId`
 * that resolves to nothing falls back, rather than being listed nowhere.
 *
 * `dangling` is the difference between the two ways of arriving at undefined: a task with no
 * parent at all, and one naming a parent the folder doesn't hold. Only the second is
 * something to repair — a parent in another folder is a real task, just not a sibling.
 */
function parentOf(
  task: ProjectTask, byId: Map<string, ProjectTask>,
): { parent?: ProjectTask; dangling: boolean } {
  if (!task.parentId) return { dangling: false };
  const parent = byId.get(task.parentId);
  if (!parent) return { dangling: true };
  return parentDirOf(parent.filePath) === parentDirOf(task.filePath)
    ? { parent, dangling: false }
    : { dangling: false };
}

/**
 * Makes every `## Tasks` and `## Subtasks` section agree with the tasks that exist —
 * entries added, titles refreshed, boxes matched to statuses, departed entries dropped —
 * which is what lets a later ticked box be read as a fresh edit. Also puts each task's
 * body link back in step with its `parentId`, which `moveTask` commits separately.
 *
 * A task whose `parentId` names nothing is listed and linked under its project here like any
 * other root, and its frontmatter follows a pass later — marked on the first sighting,
 * detached from the parent it names once the mark is `ORPHAN_GRACE_MS` old, and unmarked
 * instead if the parent turns up in between.
 */
export async function repairListings(
  vault: VaultData, projects: Project[], tasks: ProjectTask[],
): Promise<void> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const children = new Map<string, ProjectTask[]>();
  const roots = new Map<string, ProjectTask[]>();
  const dangling: ProjectTask[] = [];
  const reunited: ProjectTask[] = [];

  for (const task of tasks) {
    const { parent, dangling: orphaned } = parentOf(task, byId);
    if (orphaned) dangling.push(task);
    else if (task.orphanedAt) reunited.push(task);
    const bucket = parent ? children : roots;
    const key = parent ? parent.id : task.projectId;
    bucket.set(key, [...(bucket.get(key) ?? []), task]);
  }

  await inBatches(projects, (project) =>
    vault.projects.cache.file(project.filePath).syncChildListing((roots.get(project.id) ?? []).map(entryFor)));

  // One pass per task, both of its notes' repairs in it: the listing under it, then the body
  // link that follows from `parentId`. Its own note either way, so the two stay in order
  // while the tasks either side of it are being read.
  await inBatches(tasks, async (task) => {
    const note = vault.projects.taskCache.file(task.filePath);
    // Every task, not just those with children: one that lost its last subtask still has
    // an entry to clear, and a note with none costs a read and no write.
    await note.syncChildListing((children.get(task.id) ?? []).map(entryFor));

    const { parent } = parentOf(task, byId);
    const project = byProject.get(task.projectId);
    // Nothing to point at: a task whose project note is missing keeps its prefix, which
    // project it meant not being in the note. Nothing lists it either.
    if (!parent && !project) return;

    const wanted = parent
      ? bodyPrefix(parent, BodyPrefixKind.Parent)
      : bodyPrefix(project!, BodyPrefixKind.Project);
    if (await note.readBodyPrefix() === wanted) return;
    await note.setBodyPrefix(wanted);
  });

  // Last, so a task whose id is dropped has already been listed and linked as the root the
  // pass decided it is: the frontmatter is brought into line with that, not ahead of it.
  const now = new Date();
  const isOld = (at: Date) => now.getTime() - at.getTime() >= ORPHAN_GRACE_MS;
  await inBatches(dangling.filter((t) => !t.orphanedAt), (task) =>
    vault.projects.taskCache.file(task.filePath).markOrphaned(task.parentId!, now));
  await inBatches(dangling.filter((t) => t.orphanedAt && isOld(t.orphanedAt)), (task) =>
    vault.projects.taskCache.file(task.filePath).detachFromParent(task.parentId!));
  await inBatches(reunited, (task) =>
    vault.projects.taskCache.file(task.filePath).clearOrphanMark());
}

/**
 * Drops a deleted task's checklist entry from whatever listed it, for a deletion outside
 * the plugin. The repair pass can't: with the file gone, an entry naming it looks like a
 * link to a note not created yet. Here the deletion is the evidence.
 */
export async function unlinkDeletedTask(vault: VaultData, filePath: string): Promise<void> {
  const folder = parentDirOf(filePath);
  if (!folder.endsWith("_tasks") || !filePath.endsWith(".md")) return;

  const basename = basenameOf(filePath);
  // The folder's project first, being one read and the commonest holder, then the
  // siblings that list anything — one with no `subtaskIds` can't be it.
  const candidates: ChildLister[] = [
    vault.projects.cache.file(normalizePath(folder.replace(/_tasks$/, ".md"))),
    ...listingSiblings(vault.app, folder).map((path) => vault.projects.taskCache.file(path)),
  ];

  for (const note of candidates) {
    // A task is listed in exactly one place, so the first hit is the only one.
    if (await note.dropChildEntry(basename)) return;
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
