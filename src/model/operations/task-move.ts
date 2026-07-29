import { App } from "obsidian";
import type { Project, Task } from "../shared";
import { collectDescendants, isValidMoveTarget } from "../shared";
import {
  basenameOf, ensureFolderRecursive, resolveFile, slugify, stringArray, touch, uniquePathIn,
} from "./file-helpers";
import { ProjectTaskFile, pruneDependents, tasksFolderFor } from "../project-task-file";
import { ProjectFile } from "../project-file";

export interface MoveDestination {
  projectId: string;
  projectFilePath: string;
  projectTitle: string;
  /** Absent means the task lands at the project root. */
  parentTask?: Task;
}

/** The `Project:`/`Parent:` wiki-link that opens a task body. */
export function bodyPrefixFor(destination: MoveDestination): string {
  return destination.parentTask
    ? `Parent: [[${basenameOf(destination.parentTask.filePath)}|${destination.parentTask.title}]]`
    : `Project: [[${basenameOf(destination.projectFilePath)}|${destination.projectTitle}]]`;
}

/**
 * `type` is only meaningful against the task's depth: "subtask" when nested,
 * "task" at root. "milestone" is a root-only concept the user chose explicitly,
 * so it survives a move between projects.
 *
 * Lossy on purpose: a milestone nested under a parent becomes a subtask, and
 * moving it back to root yields "task" — the original milestone-ness isn't
 * recorded anywhere to restore.
 */
function typeAfterMove(task: Task, destination: MoveDestination): string {
  if (destination.parentTask) return "subtask";
  return task.type === "milestone" ? "milestone" : "task";
}

/**
 * Move a task — with its whole subtree — under a different parent, a different
 * project, or both.
 *
 * Only a change of project relocates files: every task in a project lives in
 * one flat `_tasks` folder and depth is expressed by `parentId` alone.
 *
 * Crash safety: the `parentId`/`projectId` frontmatter write is the commit
 * point, because that is all the vault reader consults — the parent's
 * `subtaskIds`/`## Subtasks` (and a project's `taskIds`/`## Tasks`) are
 * denormalized copies. Writes are ordered so that a failure at any step leaves
 * a correct tree with at worst a stale link section, never a lost or duplicated
 * task, and every step is idempotent, so re-running the same move repairs it.
 *
 * @param projects All projects, used to locate the file the task is leaving.
 * @throws if the destination is invalid or the task file is missing.
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
    // A no-op destination is "invalid" so pickers can grey it out, but as a
    // move it just means there is nothing to do.
    if (check.issue === "already-here") return;
    throw new Error(check.reason);
  }

  if (!resolveFile(app, task.filePath)) throw new Error(`File not found: ${task.filePath}`);

  const descendantIds = collectDescendants(allTasks, task.id);
  const movedIds = new Set<string>([task.id, ...descendantIds]);
  const descendants = allTasks.filter((t) => descendantIds.includes(t.id));
  const changingProject = task.projectId !== destination.projectId;

  // ── 1. Destination folder ────────────────────────────────────────────────
  const destFolder = tasksFolderFor(destination.projectFilePath);
  if (changingProject) await ensureFolderRecursive(app, destFolder);

  // ── 2. Plan the renames up front, reserving each name so two moving
  //       siblings can't both claim `slug-2`. ───────────────────────────────
  const newPaths = new Map<string, string>();
  if (changingProject) {
    const taken = new Set<string>();
    for (const t of [task, ...descendants]) {
      newPaths.set(t.id, uniquePathIn(app, destFolder, slugify(t.title) || "task", taken));
    }
  }
  const pathOf = (t: Task) => newPaths.get(t.id) ?? t.filePath;

  // ── 3. Prune dependents outside the subtree, before the move, so no window
  //       exposes a dependency that spans projects. Descendants are pruned too:
  //       a clean vault has no outside dependents on them (deps must share a
  //       parent), but nothing on disk enforces that. ────────────────────────
  for (const id of movedIds) {
    await pruneDependents(app, id, allTasks, movedIds);
  }

  // ── 4. Unlink from the old parent (or project root). Must precede the
  //       rename: the link is matched by the current basename. ──────────────
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
    fm["projectId"] = destination.projectId;
    if (destParentId) { fm["parentId"] = destParentId; } else { delete fm["parentId"]; }
    fm["type"] = typeAfterMove(task, destination);
    // Dependencies must share a project and a parent, so any move invalidates
    // the moved task's own — its siblings stay behind. Expressed as the filter
    // rather than a blanket clear so it stays correct if that rule loosens.
    fm["dependencies"] = stringArray(fm["dependencies"]).filter((d) => movedIds.has(d));
    touch(fm);
  });

  for (const child of descendants) {
    const childFile = resolveFile(app, pathOf(child));
    if (!childFile) continue;
    await app.fileManager.processFrontMatter(childFile, (fm: Record<string, unknown>) => {
      fm["projectId"] = destination.projectId;
      // A descendant's dependencies are its siblings, which travel with it, so
      // they survive. Filtered defensively to repair any pre-existing breach.
      fm["dependencies"] = stringArray(fm["dependencies"]).filter((d) => movedIds.has(d));
      touch(fm);
    });
  }

  // ── 7. Body prefixes ─────────────────────────────────────────────────────
  await new ProjectTaskFile(app, pathOf(task)).setBodyPrefix(bodyPrefixFor(destination));
  // Children only need rewriting when their parent's filename actually changed.
  for (const child of descendants) {
    const parent = [task, ...descendants].find((t) => t.id === child.parentId);
    if (!parent) continue;
    const parentPath = pathOf(parent);
    if (parentPath === parent.filePath) continue;
    await new ProjectTaskFile(app, pathOf(child)).setBodyPrefix(
      `Parent: [[${basenameOf(parentPath)}|${parent.title}]]`,
    );
  }

  // ── 7b. Repoint each moving parent's `## Subtasks` entry at any child whose
  //        basename changed in the relocation. Obsidian's own link auto-update
  //        can't be trusted here: once the parent already sits in the
  //        destination folder, a `[[kid]]` link is ambiguous with a same-named
  //        file the destination already held, so fix it explicitly. ──────────
  for (const child of descendants) {
    const oldChildBasename = basenameOf(child.filePath);
    const newChildBasename = basenameOf(pathOf(child));
    if (oldChildBasename === newChildBasename) continue;
    const parent = [task, ...descendants].find((t) => t.id === child.parentId);
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
