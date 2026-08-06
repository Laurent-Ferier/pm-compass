import type { Project } from "./project";
import { isValidMoveTarget, MoveIssue, TaskType, type Task } from "./task";
import { collectDescendants, walkAncestors } from "./task-tree";
import {
  basenameOf, BodyPrefixKind, bodyPrefix, ensureFolderRecursive, resolveFile, slugify, stringArray, touch,
  uniquePathIn,
} from "../operations/file-helpers";
import { bodyPrefixFor, pruneDependents, tasksFolderFor } from "../store/project-task-note";
import type { VaultData } from "../store/vault-data";
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
  vault: VaultData,
  task: Task,
  destination: MoveDestination,
  allTasks: Task[],
  projects: Project[],
): Promise<void> {
  const app = vault.app;
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
  /** The moving tasks as they read before any of this. The steps below unlink and repoint
   *  by the name a file still carries, while the renames between them take it away — so
   *  where each one came from is held rather than asked for again. */
  const was = new Map([task, ...descendants].map((t) => [t.id, t.toFields()]));
  const wasOf = (t: Task) => was.get(t.id)!;
  const changingProject = task.projectId !== destination.projectId;

  /** Where the subtree lands and everything above it. A dependency joining one of these to
   *  a moving task becomes a link between a task and its own ancestor once the move lands:
   *  a level lifts both ends onto the same card and draws nothing, and the pair says the
   *  parent waits on what waits on the parent. So the move drops it. */
  const newAncestorIds = new Set<string>();
  if (destination.parentTask) {
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    newAncestorIds.add(destination.parentTask.id);
    walkAncestors(byId, destination.parentTask.id, (ancestor) => { newAncestorIds.add(ancestor.id); });
  }
  /** Whether a moving task's dependency on `id` survives. */
  const keepsDependency = (id: string) =>
    !newAncestorIds.has(id) && (!changingProject || movedIds.has(id));
  /** Rewrites the list only when something goes, so a move adds no key to a file without one. */
  const pruneDependencies = (fm: Record<string, unknown>) => {
    const current = stringArray(fm[Frontmatter.Dependencies]);
    const kept = current.filter(keepsDependency);
    if (kept.length !== current.length) fm[Frontmatter.Dependencies] = kept;
  };

  // ── 1. Destination folder ────────────────────────────────────────────────
  const destFolder = tasksFolderFor(destination.projectFilePath);
  if (changingProject) await ensureFolderRecursive(app, destFolder);

  // ── 2. Renames planned up front, each name reserved so two moving siblings
  //       can't both claim `slug-2`. ────────────────────────────────────────
  const newPaths = new Map<string, string>();
  if (changingProject) {
    const taken = new Set<string>();
    for (const t of [task, ...descendants]) {
      newPaths.set(t.id, uniquePathIn(app, destFolder, slugify(wasOf(t).title) || "task", taken));
    }
  }
  const pathOf = (t: Task) => newPaths.get(t.id) ?? wasOf(t).filePath;

  // ── 3. A dependency may span levels — the graph lifts it to the cards that
  //       stand for its ends — but not projects, no view being able to draw
  //       one. So only a change of project prunes the outside dependents. The
  //       new ancestors are pruned either way: one of them waiting on a task
  //       moving under it is the link nothing can draw. ───────────────────────
  for (const id of movedIds) {
    if (changingProject) {
      await pruneDependents(vault, id, allTasks, movedIds);
      continue;
    }
    for (const ancestor of allTasks.filter((t) => newAncestorIds.has(t.id) && t.dependencies.includes(id))) {
      if (!resolveFile(app, ancestor.filePath)) continue;
      await vault.taskNotes.note(ancestor.filePath).removeDependency(id);
    }
  }

  // ── 4. Unlinked from the old parent before the rename, the link being
  //       matched by the current basename. ─────────────────────────────────
  const oldParent = task.parentId ? allTasks.find((t) => t.id === task.parentId) : undefined;
  const oldBasename = basenameOf(wasOf(task).filePath);
  if (oldParent) {
    await vault.taskNotes.note(oldParent.filePath).removeChild(task.id, oldBasename);
  } else {
    // Root task: its listing lives on the project file itself.
    const oldProjectPath = changingProject
      ? projects.find((p) => p.id === task.projectId)?.filePath
      : destination.projectFilePath;
    if (oldProjectPath) {
      await vault.projectNotes.note(oldProjectPath).removeChild(task.id, oldBasename);
    }
  }

  // ── 5. Relocate files (guarded, so a half-applied rename re-runs cleanly) ─
  for (const t of [task, ...descendants]) {
    const from = wasOf(t).filePath;
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
    // Dependencies survive a change of depth, being lifted for display rather than read as
    // between siblings — bar the two kinds no level can draw: across projects, and onto the
    // task's own new ancestors.
    pruneDependencies(fm);
    touch(fm);
  });

  for (const child of descendants) {
    const childFile = resolveFile(app, pathOf(child));
    if (!childFile) continue;
    await app.fileManager.processFrontMatter(childFile, (fm: Record<string, unknown>) => {
      fm[Frontmatter.ProjectId] = destination.projectId;
      // Same rule as the moved task's own.
      pruneDependencies(fm);
      touch(fm);
    });
  }

  /** Each descendant beside the parent it travels with. Paired from the parents' side so
   *  the pair is only ever built from notes on the move — a descendant's parent always is
   *  one, the walk that found the child having come through it. */
  const movingPairs = [...movingById.values()].flatMap((parent) =>
    descendants.filter((c) => c.parentId === parent.id).map((child) => ({ parent, child })));

  // ── 7. Body prefixes ─────────────────────────────────────────────────────
  await vault.taskNotes.note(pathOf(task)).setBodyPrefix(bodyPrefixFor(destination));
  // A child is only rewritten when its parent's filename changed.
  for (const { parent, child } of movingPairs) {
    const parentPath = pathOf(parent);
    if (parentPath === wasOf(parent).filePath) continue;
    await vault.taskNotes.note(pathOf(child)).setBodyPrefix(
      bodyPrefix({ filePath: parentPath, title: wasOf(parent).title }, BodyPrefixKind.Parent),
    );
  }

  // ── 7b. Each moving parent's `## Subtasks` entry repointed at a renamed child.
  //        Obsidian's link auto-update can't be trusted: with the parent already
  //        in the destination folder, `[[kid]]` is ambiguous. ────────────────
  for (const { parent, child } of movingPairs) {
    const oldChildBasename = basenameOf(wasOf(child).filePath);
    const newChildBasename = basenameOf(pathOf(child));
    if (oldChildBasename === newChildBasename) continue;
    const parentFile = vault.taskNotes.note(pathOf(parent));
    await parentFile.removeChild(child.id, oldChildBasename);
    await parentFile.addChild(child.id, child.title, newChildBasename);
  }

  // ── 8. Link into the new parent (or project root), last ──────────────────
  const newBasename = basenameOf(pathOf(task));
  if (destination.parentTask) {
    await vault.taskNotes.note(destination.parentTask.filePath)
      .addChild(task.id, task.title, newBasename);
  } else {
    await vault.projectNotes.note(destination.projectFilePath)
      .addChild(task.id, task.title, newBasename);
  }
}
