import { compareDays, diffDays, sameDay, timestampDay } from "../dates";
import { buildChildMap, isEffectivelyClosed, walkAncestors, walkDescendants } from "./task-tree";
import { type Task } from "./task";
import { isDoneStatus, maxPriority, priorityRank, Priority, Status, toStatus } from "../base-task";
import { WalkAction } from "./task-tree";

export function deadlinePoints(dueDate: Date | undefined): number {
  if (!dueDate) return 0;
  const days = diffDays(new Date(), dueDate);
  if (days < 0) return 1000;
  if (days === 0) return 500;
  if (days === 1) return 200;
  if (days <= 3) return 100;
  if (days <= 7) return 50;
  if (days <= 14) return 20;
  return 5;
}

/** A task's priority/deadline once the tree around it is taken into account — see
 *  `computeEffectiveValues`, which is the only thing that builds these. */
export interface EffectiveValues {
  /** What the task ranks as: the higher of the two roll-ups, so it sorts by the most
   *  urgent thing it is part of. The coarse half of the sort key — see `priorityKey`. */
  priority: Priority | undefined;
  /** Highest priority at or above the task, and the top of its ribbon, which fades from
   *  here to `subtreePriority`. */
  ancestorPriority: Priority | undefined;
  /** Highest priority at or below the task, and the bottom of the ribbon. Both roll-ups
   *  include its own level, so a task nothing outranks gets a solid bar. */
  subtreePriority: Priority | undefined;
  due: Date | undefined;
}

/** Priority as a sort key: the level in force, with the subtree's as a fraction under it
 *  to split ties. `priorityRank` steps by 50, so the fraction can't cross a level. */
function priorityKey(task: Task, effective: EffectiveValues | undefined): number {
  return priorityRank(effective?.priority) + priorityRank(effective?.subtreePriority ?? task.priority) / 1000;
}

/** Orders dated tasks by the day they are due, the most urgent breaking a tie. */
function byDueThenPriority(map: Map<string, EffectiveValues>) {
  return (a: Task, b: Task) => {
    const ea = map.get(a.id)!;
    const eb = map.get(b.id)!;
    const dateDiff = compareDays(ea.due!, eb.due!);
    if (dateDiff !== 0) return dateDiff;
    return priorityKey(b, eb) - priorityKey(a, ea);
  };
}

/** Deadline and priority as one number, for the lists that weigh the two together. */
function scoreOf(map: Map<string, EffectiveValues>) {
  return (task: Task) => {
    const e = map.get(task.id);
    return deadlinePoints(e?.due) + priorityKey(task, e);
  };
}

export function buildParentIdSet(tasks: Task[]): Set<string> {
  return new Set(tasks.flatMap((t) => (t.parentId ? [t.parentId] : [])));
}

export function computeEffectiveValues(
  tasks: Task[],
  taskById: Map<string, Task>,
): Map<string, EffectiveValues> {
  const map = new Map<string, EffectiveValues>();
  const childMap = buildChildMap(tasks);
  for (const task of tasks) {
    let ancestorPriority = task.priority;
    let due = task.due;
    // The highest priority and earliest due from the ancestors, pruned at a closed one,
    // which no longer drives this task.
    walkAncestors(taskById, task.id, (ancestor) => {
      if (isDoneStatus(ancestor.status)) return WalkAction.Prune;
      ancestorPriority = maxPriority(ancestorPriority, ancestor.priority);
      if (ancestor.due && (!due || compareDays(ancestor.due, due) < 0)) {
        due = ancestor.due;
      }
      return;
    });
    // The same roll-up downward: a closed subtask hides its own subtree, not its
    // siblings'.
    let subtreePriority = task.priority;
    walkDescendants(childMap, task.id, (child) => {
      if (isDoneStatus(child.status)) return WalkAction.Prune;
      subtreePriority = maxPriority(subtreePriority, child.priority);
      return;
    });
    const priority = maxPriority(ancestorPriority, subtreePriority);
    map.set(task.id, { priority, ancestorPriority, subtreePriority, due });
  }
  return map;
}

export function selectApproachingDeadlines(
  activeTasks: Task[],
  effectiveValuesMap: Map<string, EffectiveValues>,
  parentIds: Set<string>,
  today: Date,
): Task[] {
  return activeTasks
    .filter((t) => {
      const due = effectiveValuesMap.get(t.id)?.due;
      if (!due) return false;
      const days = diffDays(today, due);
      return days >= 0 && days <= 7;
    })
    .filter((t) => !parentIds.has(t.id))
    .sort(byDueThenPriority(effectiveValuesMap));
}

/** Undated tasks with the effective values they were picked by, which their ribbons need. */
export interface UndatedSelection {
  tasks: Task[];
  effectiveValues: Map<string, EffectiveValues>;
}

/** Active tasks carrying a priority but nothing that dates them: judged but not planned.
 *  No dashboard horizon holds them, so the Inbox shows them beside its own items. */
export function selectUndatedTasks(tasks: Task[]): UndatedSelection {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const active = tasks.filter((t) => !isEffectivelyClosed(t, taskById));
  const effectiveValues = computeEffectiveValues(active, taskById);
  const parentIds = buildParentIdSet(active);
  const selected = active
    .filter((t) => {
      const e = effectiveValues.get(t.id);
      return !!e?.priority && !e.due;
    })
    // A parent is represented by the subtasks below it, as in the dashboard's lists.
    .filter((t) => !parentIds.has(t.id))
    .sort((a, b) => priorityKey(b, effectiveValues.get(b.id))
                  - priorityKey(a, effectiveValues.get(a.id)));
  return { tasks: selected, effectiveValues };
}

/**
 * Project tasks whose `completed` timestamp falls on `day`, earliest first, so a past day
 * reads as a record of what was done. Takes every task, since these are the ones the other
 * selections drop; a parent closed alongside its own child is left out. The status is
 * checked too — a stale timestamp would otherwise list an active task here as well.
 */
export function selectCompletedOn(tasks: Task[], day: Date): Task[] {
  const done = tasks.filter((t) =>
    toStatus(t.status) === Status.Done && t.completed && sameDay(timestampDay(t.completed), day));
  const parentIds = buildParentIdSet(done);
  return done
    .filter((t) => !parentIds.has(t.id))
    .sort((a, b) => a.completed!.getTime() - b.completed!.getTime());
}

/** The three horizons the dashboard's merged sections show, in that order. */
export interface TaskHorizons {
  overdue: Task[];
  current: Task[];
  nextUp: Task[];
}

/** Splits selected tasks by effective due date — past, today, everything else, undated
 *  included. The dated buckets sort by date then priority, `nextUp` by combined score. */
export function bucketTasksByHorizon(
  tasks: Task[],
  effectiveValuesMap: Map<string, EffectiveValues>,
  today: Date,
): TaskHorizons {
  const horizons: TaskHorizons = { overdue: [], current: [], nextUp: [] };
  for (const task of tasks) {
    const due = effectiveValuesMap.get(task.id)?.due;
    const days = due ? diffDays(today, due) : undefined;
    if (days === undefined) horizons.nextUp.push(task);
    else if (days < 0) horizons.overdue.push(task);
    else if (days === 0) horizons.current.push(task);
    else horizons.nextUp.push(task);
  }
  const byDue = byDueThenPriority(effectiveValuesMap);
  horizons.overdue.sort(byDue);
  horizons.current.sort(byDue);
  const score = scoreOf(effectiveValuesMap);
  horizons.nextUp.sort((a, b) => score(b) - score(a));
  return horizons;
}

/** The dated work waiting behind the deadlines; an undated task waits in the Inbox.
 *  Uncapped, since the merged dashboard cuts its three horizons out of this queue. */
export function selectPriorityQueue(
  activeTasks: Task[],
  effectiveValuesMap: Map<string, EffectiveValues>,
  parentIds: Set<string>,
  excludeIds: Set<string>,
): Task[] {
  const score = scoreOf(effectiveValuesMap);
  return activeTasks
    .filter((t) => !!effectiveValuesMap.get(t.id)?.due
                && !parentIds.has(t.id) && !excludeIds.has(t.id))
    .sort((a, b) => score(b) - score(a));
}
