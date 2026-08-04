import { compareDays, diffDays, sameDay, timestampDay } from "../dates";
import { buildChildMap, isEffectivelyClosed, walkDescendants } from "./task-tree";
import { type Task } from "./task";
import { isDoneStatus, maxPriority, priorityRank, Priority, Status, toStatus } from "../base-task";
import { WalkAction } from "./task-tree";

/** How much a due date weighs, counted from `today` — the day on show, not the real one,
 *  so a row's rank matches the badge beside it. */
export function deadlinePoints(dueDate: Date | undefined, today: Date = new Date()): number {
  if (!dueDate) return 0;
  const days = diffDays(today, dueDate);
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
function scoreOf(map: Map<string, EffectiveValues>, today: Date) {
  return (task: Task) => {
    const e = map.get(task.id);
    return deadlinePoints(e?.due, today) + priorityKey(task, e);
  };
}

export function buildParentIdSet(tasks: Task[]): Set<string> {
  return new Set(tasks.flatMap((t) => (t.parentId ? [t.parentId] : [])));
}

/** What a chain of tasks rolls up to: the most urgent level and the earliest deadline
 *  over all of them. */
interface AncestorRollup {
  priority: Priority | undefined;
  due: Date | undefined;
}

const NO_ROLLUP: AncestorRollup = { priority: undefined, due: undefined };

function addToRollup(rollup: AncestorRollup, task: Task): AncestorRollup {
  const earlier = task.due && (!rollup.due || compareDays(task.due, rollup.due) < 0);
  return {
    priority: maxPriority(rollup.priority, task.priority),
    due: earlier ? task.due : rollup.due,
  };
}

/**
 * Rolls a task and everything above it into one value, memoized: a chain is walked once
 * however many tasks hang off it, which matters where every task in the vault asks. A
 * cycle is cut where it closes, as `walkAncestors` does, and goes uncached — the answer
 * there depends on which link asked.
 */
function ancestorRollups(taskById: Map<string, Task>): (taskId: string) => AncestorRollup {
  const memo = new Map<string, AncestorRollup>();
  return (taskId: string) => {
    const cached = memo.get(taskId);
    if (cached) return cached;
    // Up to the root, a memoized link or a repeat, collecting what has to be folded back.
    const chain: Task[] = [];
    const seen = new Set<string>();
    let above = NO_ROLLUP;
    let current = taskById.get(taskId);
    while (current && !seen.has(current.id)) {
      const hit = memo.get(current.id);
      if (hit) {
        above = hit;
        break;
      }
      seen.add(current.id);
      chain.push(current);
      current = current.parentId ? taskById.get(current.parentId) : undefined;
    }
    const cyclical = !!current && seen.has(current.id);
    // Down again, so each link keeps the roll-up of the whole chain over it.
    let rollup = above;
    for (let i = chain.length - 1; i >= 0; i--) {
      rollup = addToRollup(rollup, chain[i]);
      if (!cyclical) memo.set(chain[i].id, rollup);
    }
    return rollup;
  };
}

export function computeEffectiveValues(
  tasks: Task[],
  taskById: Map<string, Task>,
): Map<string, EffectiveValues> {
  const map = new Map<string, EffectiveValues>();
  const childMap = buildChildMap(tasks);
  const rollupAbove = ancestorRollups(taskById);
  for (const task of tasks) {
    // The highest priority and earliest due over the whole line above, closed links
    // included: a task stays part of the tree it hangs off whatever state that is in, so
    // ticking a parent leaves the rows under it where they were.
    const above = task.parentId ? rollupAbove(task.parentId) : NO_ROLLUP;
    const { priority: ancestorPriority, due } = addToRollup(above, task);
    // Downward the roll-up stops at closed work, which is behind the task rather than
    // over it: a closed subtask hides its own subtree, not its siblings'.
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
  const score = scoreOf(effectiveValuesMap, today);
  horizons.nextUp.sort((a, b) => score(b) - score(a));
  return horizons;
}

/**
 * Every dated task in one ranked queue, most urgent first — overdue at the head, since
 * nothing outscores its 1000 deadline points. An undated task waits in the Inbox instead.
 * Uncapped, since the merged dashboard cuts its three horizons out of this queue.
 */
export function selectPriorityQueue(
  activeTasks: Task[],
  effectiveValuesMap: Map<string, EffectiveValues>,
  parentIds: Set<string>,
  today: Date,
): Task[] {
  const score = scoreOf(effectiveValuesMap, today);
  return activeTasks
    .filter((t) => !!effectiveValuesMap.get(t.id)?.due && !parentIds.has(t.id))
    .sort((a, b) => score(b) - score(a));
}
