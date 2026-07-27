import { moment } from "./moment";
import { buildChildMap, walkAncestors, walkDescendants, type Task } from "./shared";
import { DONE_STATUSES, PRIORITY_SCORE, Priority } from "./task-vocabulary";

export function deadlinePoints(dueDate: string | undefined): number {
  if (!dueDate) return 0;
  const today = moment().startOf("day");
  const due = moment(dueDate, "YYYY-MM-DD").startOf("day");
  const days = due.diff(today, "days");
  if (days < 0) return 1000;
  if (days === 0) return 500;
  if (days === 1) return 200;
  if (days <= 3) return 100;
  if (days <= 7) return 50;
  if (days <= 14) return 20;
  return 5;
}

/** Past this many days out, a date reads better than a count. */
const RELATIVE_DAYS = 7;

/** A date as a badge label: "today", "in 3d" within the week, the date itself beyond it,
 *  the days past for a reached one — which `renderDaysBadge` takes as `daysOverdue`. */
export function daysLabel(dueDate: string): { text: string; overdue: boolean; daysOverdue: number } {
  const today = moment().startOf("day");
  const due = moment(dueDate, "YYYY-MM-DD").startOf("day");
  const days = due.diff(today, "days");
  if (days < 0) return { text: `${-days} d`, overdue: true, daysOverdue: -days };
  if (days === 0) return { text: "today", overdue: false, daysOverdue: 0 };
  if (days <= RELATIVE_DAYS) return { text: `in ${days}d`, overdue: false, daysOverdue: 0 };
  // "Jan 5" alone would read as this year's.
  const sameYear = due.format("YYYY") === today.format("YYYY");
  return { text: due.format(sameYear ? "MMM D" : "MMM D, YYYY"), overdue: false, daysOverdue: 0 };
}

/** A task's priority/deadline once the tree around it is taken into account — see
 *  `computeEffectiveValues`, which is the only thing that builds these. */
export interface EffectiveValues {
  /** What the task ranks as: the higher of the two roll-ups, so it sorts by the most
   *  urgent thing it is part of. The subtree half of that is unobservable for now — the
   *  two dashboard lists sorting by this drop parent tasks, the only tasks a subtask can
   *  outrank. */
  priority: Priority | undefined;
  /** Highest priority at or above the task: its ancestors' and its own. The top of its
   *  priority ribbon, which fades from here to `subtreePriority`. */
  ancestorPriority: Priority | undefined;
  /** Highest priority at or below the task: its subtree's and its own — the bottom of the
   *  ribbon. Both roll-ups include the task's own level, so a task nothing outranks in
   *  either direction gets a solid bar. */
  subtreePriority: Priority | undefined;
  due: string | undefined;
}

/** `PRIORITY_SCORE` for a possibly-unset level; unscored levels count as 0. */
function priorityScore(priority: Priority | undefined): number {
  return PRIORITY_SCORE[priority ?? Priority.None] ?? 0;
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
      if (ancestor.due && (!due || ancestor.due < due)) {
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
  todayStr: string,
): Task[] {
  const today = moment(todayStr, "YYYY-MM-DD").startOf("day");
  return activeTasks
    .filter((t) => {
      const due = effectiveValuesMap.get(t.id)?.due;
      if (!due) return false;
      const days = moment(due, "YYYY-MM-DD").diff(today, "days");
      return days >= 0 && days <= 7;
    })
    .filter((t) => !parentIds.has(t.id))
    .sort((a, b) => {
      const ea = effectiveValuesMap.get(a.id)!;
      const eb = effectiveValuesMap.get(b.id)!;
      const dateDiff = moment(ea.due, "YYYY-MM-DD").diff(moment(eb.due, "YYYY-MM-DD"), "days");
      if (dateDiff !== 0) return dateDiff;
      return priorityScore(eb.priority) - priorityScore(ea.priority);
    });
}

export function selectPriorityQueue(
  activeTasks: Task[],
  effectiveValuesMap: Map<string, EffectiveValues>,
  parentIds: Set<string>,
  excludeIds: Set<string>,
  limit = 15,
): Task[] {
  return activeTasks
    .filter((t) => { const e = effectiveValuesMap.get(t.id); return e?.priority || e?.due; })
    .sort((a, b) => {
      const ea = effectiveValuesMap.get(a.id)!;
      const eb = effectiveValuesMap.get(b.id)!;
      return (deadlinePoints(eb.due) + priorityScore(eb.priority))
           - (deadlinePoints(ea.due) + priorityScore(ea.priority));
    })
    .filter((t) => !parentIds.has(t.id) && !excludeIds.has(t.id))
    .slice(0, limit);
}
