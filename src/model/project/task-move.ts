import { App } from "obsidian";
import type { Project } from "./project";
import { isValidMoveTarget, MoveIssue, TaskType, type Task } from "./task";
import { collectDescendants } from "./task-tree";
import {
  basenameOf, BodyPrefixKind, bodyPrefix, ensureFolderRecursive, resolveFile, slugify, stringArray, touch,
  uniquePathIn,
} from "../operations/file-helpers";
import { bodyPrefixFor, ProjectTaskFile, pruneDependents, tasksFolderFor } from "./project-task-file";
import { ProjectFile } from "./project-file";
import { Frontmatter } from "./frontmatter";

export interface MoveDestination {
  projectId: string;
  projectFilePath: string;
  projectTitle: string;
  /** Absent means the task lands at the project root. */
  parentTask?: Task;
}

/** `type` only means anything against the task's depth: `Subtask` nested, `Task` at
 *  root, `Milestone` surviving a move between projects. Lossy: nesting a milestone
 *  makes it a subtask, and nothing records what to restore it to. */
function typeAfterMove(task: Task, destination: MoveDestination): TaskType {
  if (destination.parentTask) return TaskType.Subtask;
  return task.type === TaskType.Milestone ? TaskType.Milestone : TaskType.Task;
}

/**
 * Moves a task and its whole subtree under a different parent, project, or both. Only a
 * change of project relocates files, depth being `parentId`'s business.
 *
 * The `parentId`/`projectId` frontmatter write is the commit point, since that is all
 * the vault reader consults; the listings are denormalized copies. The steps are ordered
 * and idempotent, so a failure leaves at worst a stale link section, and a re-run repairs
 * it. Throws on an invalid destination or a missing file.
 */
export async function moveTask(
  app: App,
  task: Task,
  destination: MoveDestination,
  allTasks: Task[],
  projects: Project[],
): Promise<void> {
  const destParentId = destination.parentTask?.id;

  // Re-assert rather than trust the caller's picker to have filtered.
  const check = isValidMoveTarget(allTasks, task.id, {
    projectId: destination.projectId,
    parentTaskId: destParentId,
  });
  if (!check.valid) {
    // A no-op destination is "invalid" so pickers grey it out; as a move it is a no-op.
    if (check.issue === MoveIssue.AlreadyHere) return;
    throw new Error(check.reason);
  }

  if (!resolveFile(app, task.filePath)) throw new Error(`File not found: ${task.filePath}`);

  const descendantIds = new Set(collectDescendants(allTasks, task.id));
  const movedIds = new Set<string>([task.id, ...descendantIds]);
  const descendants = allTasks.filter((t) => descendantIds.has(t.id));
  /** Everything on the move, for the steps below that ask a child for its parent. */
  const movingById = new Map([task, ...descendants].map((t) => [t.id, t]));
  const changingProject = task.projectId !== destination.projectId;

  // ── 1. Destination folder ────────────────────────────────────────────────
  const destFolder = tasksFolderFor(destination.projectFilePath);
  if (changingProject) await ensureFolderRecursive(app, destFolder);

  // ── 2. Renames planned up front, each name reserved so two moving siblings
  //       can't both claim `slug-2`. ────────────────────────────────────────
  const newPaths = new Map<string, string>();
  if (changingProject) {
    const taken = new Set<string>();
    for (const t of [task, ...descendants]) {
      newPaths.set(t.id, uniquePathIn(app, destFolder, slugify(t.title) || "task", taken));
    }
  }
  const pathOf = (t: Task) => newPaths.get(t.id) ?? t.filePath;

  // ── 3. Dependents outside the subtree pruned before the move, so no window
  //       exposes a dependency spanning projects. Descendants too: nothing on
  //       disk enforces the rule that would make them safe. ─────────────────
  for (const id of movedIds) {
    await pruneDependents(app, id, allTasks, movedIds);
  }

  // ── 4. Unlinked from the old parent before the rename, the link being
  //       matched by the current basename. ─────────────────────────────────
  const oldParent = task.parentId ? allTasks.find((t) => t.id === task.parentId) : undefined;
  const oldBasename = basenameOf(task.filePath);
  if (oldParent) {
    await new ProjectTaskFile(app, oldParent.filePath).removeChild(task.id, oldBasename);
  } else {
    // Root task: its listing lives on the project file itself.
    const oldProjectPath = changingProject
      ? projects.find((p) => p.id === task.projectId)?.filePath
      : destination.projectFilePath;
    if (oldProjectPath) {
      await new ProjectFile(app, oldProjectPath).removeChild(task.id, oldBasename);
    }
  }

  // ── 5. Relocate files (guarded, so a half-applied rename re-runs cleanly) ─
  for (const t of [task, ...descendants]) {
    const from = t.filePath;
    const to = pathOf(t);
    if (from === to) continue;
    const file = resolveFile(app, from);
    if (file) await app.fileManager.renameFile(file, to);
  }

  // ── 6. Frontmatter — the commit ──────────────────────────────────────────
  const movedFile = resolveFile(app, pathOf(task));
  if (!movedFile) throw new Error(`File not found after move: ${pathOf(task)}`);
  await app.fileManager.processFrontMatter(movedFile, (fm: Record<string, unknown>) => {
    fm[Frontmatter.ProjectId] = destination.projectId;
    if (destParentId) { fm[Frontmatter.ParentId] = destParentId; } else { delete fm[Frontmatter.ParentId]; }
    fm[Frontmatter.Type] = typeAfterMove(task, destination);
    // Dependencies share a project and a parent, so a move invalidates the task's own,
    // its siblings staying behind. A filter rather than a clear, should that rule loosen.
    fm[Frontmatter.Dependencies] = stringArray(fm[Frontmatter.Dependencies]).filter((d) => movedIds.has(d));
    touch(fm);
  });

  for (const child of descendants) {
    const childFile = resolveFile(app, pathOf(child));
    if (!childFile) continue;
    await app.fileManager.processFrontMatter(childFile, (fm: Record<string, unknown>) => {
      fm[Frontmatter.ProjectId] = destination.projectId;
      // A descendant's dependencies are siblings travelling with it, so they survive.
      // Filtered anyway, to repair a pre-existing breach.
      fm[Frontmatter.Dependencies] = stringArray(fm[Frontmatter.Dependencies]).filter((d) => movedIds.has(d));
      touch(fm);
    });
  }

  // ── 7. Body prefixes ─────────────────────────────────────────────────────
  await new ProjectTaskFile(app, pathOf(task)).setBodyPrefix(bodyPrefixFor(destination));
  // A child is only rewritten when its parent's filename changed.
  for (const child of descendants) {
    const parent = child.parentId ? movingById.get(child.parentId) : undefined;
    if (!parent) continue;
    const parentPath = pathOf(parent);
    if (parentPath === parent.filePath) continue;
    await new ProjectTaskFile(app, pathOf(child)).setBodyPrefix(
      bodyPrefix({ filePath: parentPath, title: parent.title }, BodyPrefixKind.Parent),
    );
  }

  // ── 7b. Each moving parent's `## Subtasks` entry repointed at a renamed child.
  //        Obsidian's link auto-update can't be trusted: with the parent already
  //        in the destination folder, `[[kid]]` is ambiguous. ────────────────
  for (const child of descendants) {
    const oldChildBasename = basenameOf(child.filePath);
    const newChildBasename = basenameOf(pathOf(child));
    if (oldChildBasename === newChildBasename) continue;
    const parent = child.parentId ? movingById.get(child.parentId) : undefined;
    if (!parent) continue;
    const parentFile = new ProjectTaskFile(app, pathOf(parent));
    await parentFile.removeChild(child.id, oldChildBasename);
    await parentFile.addChild(child.id, child.title, newChildBasename);
  }

  // ── 8. Link into the new parent (or project root), last ──────────────────
  const newBasename = basenameOf(pathOf(task));
  if (destination.parentTask) {
    await new ProjectTaskFile(app, destination.parentTask.filePath)
      .addChild(task.id, task.title, newBasename);
  } else {
    await new ProjectFile(app, destination.projectFilePath)
      .addChild(task.id, task.title, newBasename);
  }
}
