import { moment } from "./moment";
import { walkAncestors, type Task } from "./shared";
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

export function daysLabel(dueDate: string): { text: string; overdue: boolean } {
  const today = moment().startOf("day");
  const due = moment(dueDate, "YYYY-MM-DD").startOf("day");
  const days = due.diff(today, "days");
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: "today", overdue: false };
  if (days === 1) return { text: "tomorrow", overdue: false };
  return { text: `in ${days}d`, overdue: false };
}

/** A task's priority/deadline after inheritance from its ancestors — see
 *  `computeEffectiveValues`, which is the only thing that builds these. */
export interface EffectiveValues {
  priority: Priority | undefined;
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
  for (const task of tasks) {
    let priority = task.priority;
    let due = task.due;
    // Inherit the highest priority / earliest due from ancestors, but stop at a
    // done/cancelled ancestor: work closed above no longer drives this task.
    walkAncestors(taskById, task.id, (ancestor) => {
      if (DONE_STATUSES.has(ancestor.status)) return "stop";
      if (priorityScore(ancestor.priority) > priorityScore(priority)) {
        priority = ancestor.priority;
      }
      if (ancestor.due && (!due || ancestor.due < due)) {
        due = ancestor.due;
      }
      return;
    });
    map.set(task.id, { priority, due });
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
