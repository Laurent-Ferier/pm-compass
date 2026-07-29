/** Walking the task tree, and the state derived that way rather than stored on a task.
 *  Depth lives in `parentId`, so these take a child map or an id→task lookup. */
import { isDoneStatus, Status, toStatus } from "../base-task";
import type { Task, TaskStatus } from "./task";

export function buildChildMap(tasks: Task[]): Map<string | undefined, Task[]> {
  const map = new Map<string | undefined, Task[]>();
  for (const t of tasks) {
    const key = t.parentId ?? undefined;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return map;
}

/** Instruction a `walkTree` visitor may return to steer the traversal. */
export enum WalkAction {
  /** Halt the whole walk. */
  Stop = "stop",
  /** Keep walking, but do not expand this node's neighbours. */
  Prune = "prune",
}

/** What a `walkTree` visitor may return: an instruction, or nothing to keep going. */
export type WalkStep = WalkAction | void;

/**
 * The guarded traversal every task-tree walk is built on: visits the neighbours of
 * `startId`, expanding each via `next` — a child map downward, a parent lookup upward.
 * A visited set guards the `parentId` cycles the vault format doesn't prevent. Prefer
 * the `walkDescendants` / `walkAncestors` wrappers.
 */
export function walkTree(
  startId: string,
  next: (id: string) => Task[],
  visit: (task: Task) => WalkStep,
): void {
  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const neighbour of next(cur)) {
      if (visited.has(neighbour.id)) continue;
      visited.add(neighbour.id);
      const action = visit(neighbour);
      if (action === WalkAction.Stop) return;
      if (action !== WalkAction.Prune) queue.push(neighbour.id);
    }
  }
}

/** Walk downward through descendants, using a prebuilt `buildChildMap` result. */
export function walkDescendants(
  childMap: Map<string | undefined, Task[]>,
  startId: string,
  visit: (task: Task) => WalkStep,
): void {
  walkTree(startId, (id) => childMap.get(id) ?? [], visit);
}

/** Walk upward through the ancestor chain, using an id→task lookup. */
export function walkAncestors(
  byId: Map<string, Task>,
  startId: string,
  visit: (task: Task) => WalkStep,
): void {
  walkTree(
    startId,
    (id) => {
      const parentId = byId.get(id)?.parentId;
      const parent = parentId ? byId.get(parentId) : undefined;
      return parent ? [parent] : [];
    },
    visit,
  );
}

/** Every task below `taskId`, itself excluded. */
export function collectDescendants(tasks: Task[], taskId: string): string[] {
  const childMap = buildChildMap(tasks);
  const found: string[] = [];
  walkDescendants(childMap, taskId, (child) => {
    found.push(child.id);
  });
  return found;
}

/** True when an ancestor is cancelled, which cancels `task` too — derived here rather
 *  than written into each descendant's file. */
export function hasCancelledAncestor(task: Task, byId: Map<string, Task>): boolean {
  let cancelled = false;
  walkAncestors(byId, task.id, (ancestor) => {
    if (toStatus(ancestor.status) === Status.Cancelled) {
      cancelled = true;
      return WalkAction.Stop;
    }
    return;
  });
  return cancelled;
}

/** The status a task is really in: `cancelled` when an ancestor is, its own otherwise. */
export function effectiveStatus(task: Task, byId: Map<string, Task>): TaskStatus {
  return hasCancelledAncestor(task, byId) ? Status.Cancelled : task.status;
}

/** True when a task is closed — by its own status, or by a cancelled ancestor. */
export function isEffectivelyClosed(task: Task, byId: Map<string, Task>): boolean {
  return isDoneStatus(effectiveStatus(task, byId));
}

/** True if any descendant of `startId` is still open. A cancelled one prunes its own
 *  subtree, cancelled with it. */
export function hasOpenDescendants(
  childMap: Map<string | undefined, Task[]>,
  startId: string,
): boolean {
  let open = false;
  walkDescendants(childMap, startId, (child) => {
    if (toStatus(child.status) === Status.Cancelled) return WalkAction.Prune;
    if (!isDoneStatus(child.status)) {
      open = true;
      return WalkAction.Stop;
    }
    return;
  });
  return open;
}

/** A task marked done while a descendant is still open, surfacing work a closed parent
 *  hides. Silent under a cancellation, where open work below is no inconsistency. */
export function isCompletedWithOpenSubtasks(
  task: Task,
  childMap: Map<string | undefined, Task[]>,
  byId: Map<string, Task>,
): boolean {
  if (toStatus(effectiveStatus(task, byId)) === Status.Cancelled) return false;
  return isDoneStatus(task.status) && hasOpenDescendants(childMap, task.id);
}

/** `isCompletedWithOpenSubtasks` from the child's side: still open under a parent
 *  already done. A cancelled ancestor doesn't create that boundary. */
export function isOpenUnderCompletedParent(
  task: Task,
  byId: Map<string, Task>,
): boolean {
  if (isDoneStatus(task.status)) return false;
  if (hasCancelledAncestor(task, byId)) return false;
  const parent = task.parentId ? byId.get(task.parentId) : undefined;
  return !!parent && isDoneStatus(parent.status);
}
