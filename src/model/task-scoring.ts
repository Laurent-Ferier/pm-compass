import { compareDays, diffDays, sameDay, timestampDay } from "./dates";
import { buildChildMap, isEffectivelyClosed, walkAncestors, walkDescendants, type Task } from "./shared";
import { DONE_STATUSES, PRIORITY_SCORE, Priority, Status, toStatus } from "./task-vocabulary";

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
   *  urgent thing it is part of. The subtree half of that is unobservable for now — the
   *  two dashboard lists sorting by this drop parent tasks, the only tasks a subtask can
   *  outrank. It is the coarse half of the sort key; the level written on the task itself
   *  refines it, see `priorityKey`. */
  priority: Priority | undefined;
  /** Highest priority at or above the task: its ancestors' and its own. The top of its
   *  priority ribbon, which fades from here to `subtreePriority`. */
  ancestorPriority: Priority | undefined;
  /** Highest priority at or below the task: its subtree's and its own — the bottom of the
   *  ribbon. Both roll-ups include the task's own level, so a task nothing outranks in
   *  either direction gets a solid bar. */
  subtreePriority: Priority | undefined;
  due: Date | undefined;
}

/** `PRIORITY_SCORE` for a possibly-unset level; unscored levels count as 0. */
function priorityScore(priority: Priority | undefined): number {
  return PRIORITY_SCORE[priority ?? Priority.None] ?? 0;
}

/** Priority as a sort key: the effective level, with the task's own level as a fraction
 *  under it, so two tasks the same inheritance ranks alike are split by what they carry
 *  themselves. `PRIORITY_SCORE` steps by 100, so the fraction can never cross a level. */
function priorityKey(task: Task, effective: EffectiveValues | undefined): number {
  return priorityScore(effective?.priority) + priorityScore(task.priority) / 1000;
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
    // Inherit the highest priority / earliest due from ancestors, pruning at a
    // done/cancelled one: work closed above no longer drives this task.
    walkAncestors(taskById, task.id, (ancestor) => {
      if (DONE_STATUSES.has(ancestor.status)) return "prune";
      if (priorityScore(ancestor.priority) > priorityScore(ancestorPriority)) {
        ancestorPriority = ancestor.priority;
      }
      if (ancestor.due && (!due || compareDays(ancestor.due, due) < 0)) {
        due = ancestor.due;
      }
      return;
    });
    // The same roll-up downward, pruned by the same rule — which matters more here,
    // where a closed subtask hides its own subtree but says nothing about its siblings'.
    let subtreePriority = task.priority;
    walkDescendants(childMap, task.id, (child) => {
      if (DONE_STATUSES.has(child.status)) return "prune";
      if (priorityScore(child.priority) > priorityScore(subtreePriority)) {
        subtreePriority = child.priority;
      }
      return;
    });
    const priority = priorityScore(subtreePriority) > priorityScore(ancestorPriority)
      ? subtreePriority
      : ancestorPriority;
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
    .sort((a, b) => {
      const ea = effectiveValuesMap.get(a.id)!;
      const eb = effectiveValuesMap.get(b.id)!;
      const dateDiff = compareDays(ea.due!, eb.due!);
      if (dateDiff !== 0) return dateDiff;
      return priorityKey(b, eb) - priorityKey(a, ea);
    });
}

/** Undated tasks, with the effective values they were picked by — the rows need them for
 *  the inherited priority their ribbon fades through. */
export interface UndatedSelection {
  tasks: Task[];
  effectiveValues: Map<string, EffectiveValues>;
}

/**
 * Active tasks carrying a priority but nothing that dates them, most urgent first: work
 * judged but not planned. No dashboard horizon holds them, so the Inbox shows them beside
 * its own untriaged items, where giving one a deadline moves it onto the dashboard.
 *
 * Takes the raw task list rather than a prepared selection — the Inbox keeps no scoring
 * state of its own.
 */
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
    // A parent is represented by the subtasks below it, as in the dashboard's own lists.
    .filter((t) => !parentIds.has(t.id))
    .sort((a, b) => priorityKey(b, effectiveValues.get(b.id))
                  - priorityKey(a, effectiveValues.get(a.id)));
  return { tasks: selected, effectiveValues };
}

/**
 * Project tasks whose `completed` timestamp falls on `day`, earliest first — the project
 * half of what that day holds, shown beside its checklist so a day past reads as a record
 * of what was done rather than only of what was left open.
 *
 * Takes every task, closed ones included: these are exactly the tasks the dashboard's other
 * selections drop. A parent closed alongside a child of its own is left out, the child
 * standing for it as in every other list here.
 *
 * The timestamp alone doesn't make a task done: a cancel keeps the one already written, and
 * a file reopened outside the plugin can carry a stale one — which, unchecked, would put an
 * active task in this list *and* in the queues it is still due in.
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

/**
 * Splits already-selected tasks by their effective due date: past, today, and everything
 * else — undated included, a priority alone being work waiting rather than work due. The
 * dated buckets sort by due date then priority; `nextUp`, mixing the two, sorts by the
 * same combined score `selectPriorityQueue` uses.
 */
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
  const byDue = (a: Task, b: Task) => {
    const ea = effectiveValuesMap.get(a.id)!;
    const eb = effectiveValuesMap.get(b.id)!;
    const dateDiff = compareDays(ea.due!, eb.due!);
    if (dateDiff !== 0) return dateDiff;
    return priorityKey(b, eb) - priorityKey(a, ea);
  };
  horizons.overdue.sort(byDue);
  horizons.current.sort(byDue);
  const score = (task: Task) => {
    const e = effectiveValuesMap.get(task.id);
    return deadlinePoints(e?.due) + priorityKey(task, e);
  };
  horizons.nextUp.sort((a, b) => score(b) - score(a));
  return horizons;
}

/**
 * The dated work waiting behind the deadlines. A task nothing dates isn't queued at all —
 * the Inbox is where it waits to be planned (`selectUndatedTasks`).
 *
 * Uncapped, because the merged dashboard cuts its three horizons out of this queue: a cap
 * would not trim a tail but empty whichever horizon the top scorers left no room for.
 */
export function selectPriorityQueue(
  activeTasks: Task[],
  effectiveValuesMap: Map<string, EffectiveValues>,
  parentIds: Set<string>,
  excludeIds: Set<string>,
): Task[] {
  return activeTasks
    .filter((t) => !!effectiveValuesMap.get(t.id)?.due)
    .sort((a, b) => {
      const ea = effectiveValuesMap.get(a.id)!;
      const eb = effectiveValuesMap.get(b.id)!;
      return (deadlinePoints(eb.due) + priorityKey(b, eb))
           - (deadlinePoints(ea.due) + priorityKey(a, ea));
    })
    .filter((t) => !parentIds.has(t.id) && !excludeIds.has(t.id));
}
