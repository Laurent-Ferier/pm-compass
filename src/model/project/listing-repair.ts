import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ChildEntry } from "./child-links";
import {
  asFrontmatterRecord, basenameOf, BodyPrefixKind, bodyPrefix, parentDirOf, stringArray,
} from "../operations/file-helpers";
import type { ProjectTaskNote } from "../store/project-task-note";
import type { VaultData } from "../store/vault-data";
import type { Project } from "./project";
import type { ProjectTask } from "./project-task";
import { Status, toStatus } from "../base-task";
import { Frontmatter } from "./frontmatter";

export interface RepairResult {
  /** Notes whose listing was rewritten. */
  listingsRewritten: number;
  /** Task notes whose `Project:`/`Parent:` link was put back in step with `parentId`. */
  prefixesFixed: number;
  /** Tasks naming a parent that isn't in the folder. Already listed and linked as roots of
   *  their project; the count is of notes whose frontmatter still says otherwise. */
  danglingParents: number;
  /** Of those, the ones whose `parentId` was cleared — see `RepairOpts.clearDanglingParents`. */
  parentsCleared: number;
  /** Tasks naming a project that isn't in the folder. Nothing holds them, so nothing lists
   *  them; which project they meant is not in the note, so this is reported, never guessed. */
  tasksWithNoProject: number;
}

export interface RepairOpts {
  /**
   * Whether to clear a `parentId` that names nothing, rather than only counting it.
   *
   * Off for the pass that runs at the start of every session: on a synced vault a parent
   * note that hasn't landed yet looks exactly like one that never existed, and clearing then
   * would throw away real parentage. On for the command, which is a deliberate act on a
   * vault the user is looking at.
   */
  clearDanglingParents?: boolean;
}

/** A note that could be holding the deleted task's line — a project or another task, which
 *  differ only in the section their listing sits under, and that is the note's own to know. */
type ChildLister = Pick<ProjectTaskNote, "dropChildEntry">;

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
 */
export async function repairListings(
  vault: VaultData, projects: Project[], tasks: ProjectTask[], opts: RepairOpts = {},
): Promise<RepairResult> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const children = new Map<string, ProjectTask[]>();
  const roots = new Map<string, ProjectTask[]>();
  const dangling: ProjectTask[] = [];

  for (const task of tasks) {
    const { parent, dangling: orphaned } = parentOf(task, byId);
    if (orphaned) dangling.push(task);
    const bucket = parent ? children : roots;
    const key = parent ? parent.id : task.projectId;
    bucket.set(key, [...(bucket.get(key) ?? []), task]);
  }

  let listingsRewritten = 0;
  for (const project of projects) {
    const note = vault.projectNotes.note(project.filePath);
    if (await note.syncChildListing((roots.get(project.id) ?? []).map(entryFor))) listingsRewritten++;
  }
  // Every task, not just those with children: one that lost its last subtask still has
  // an entry to clear, and a note with none costs a read and no write.
  for (const task of tasks) {
    const note = vault.taskNotes.note(task.filePath);
    if (await note.syncChildListing((children.get(task.id) ?? []).map(entryFor))) listingsRewritten++;
  }

  let prefixesFixed = 0;
  let tasksWithNoProject = 0;
  for (const task of tasks) {
    const { parent } = parentOf(task, byId);
    const project = byProject.get(task.projectId);
    // Nothing to point at: a task whose project note is missing keeps its prefix. Nothing
    // lists it either, so it is counted — which project it meant is not in the note.
    if (!parent && !project) {
      tasksWithNoProject++;
      continue;
    }
    const wanted = parent
      ? bodyPrefix(parent, BodyPrefixKind.Parent)
      : bodyPrefix(project!, BodyPrefixKind.Project);
    const note = vault.taskNotes.note(task.filePath);
    if (await note.readBodyPrefix() !== wanted) {
      await note.setBodyPrefix(wanted);
      prefixesFixed++;
    }
  }

  // Last, so a task whose id is cleared has already been listed and linked as the root the
  // pass decided it is: the frontmatter is brought into line with that, not ahead of it.
  let parentsCleared = 0;
  if (opts.clearDanglingParents) {
    for (const task of dangling) {
      if (await vault.taskNotes.note(task.filePath).clearParentId(task.parentId!)) parentsCleared++;
    }
  }

  return {
    listingsRewritten, prefixesFixed, danglingParents: dangling.length, parentsCleared, tasksWithNoProject,
  };
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
    vault.projectNotes.note(normalizePath(folder.replace(/_tasks$/, ".md"))),
    ...listingSiblings(vault.app, folder).map((path) => vault.taskNotes.note(path)),
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
