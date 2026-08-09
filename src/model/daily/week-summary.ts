import { diffDays, startOfDay } from "../dates";
import type { DayNoteEntry } from "../cache/task-file-cache";
import { Task } from "./task";

export interface DailyTaskCounts {
  closedOnTime: number;
  closedLate: number;
  open: number;
  total: number;
}

/** Counts one-off (non-habit) checklist items for a single day.
 *  Habit-tagged items are excluded. Items without a ✅ timestamp are treated as closed on time. */
export function computeDailyTaskCounts(
  items: Task[],
  noteDate: Date,
  habitsTag: string,
): DailyTaskCounts {
  let closedOnTime = 0;
  let done = 0;
  let total = 0;
  for (const task of items) {
    if (task.hasTag(habitsTag)) continue;
    total++;
    if (task.checked) {
      done++;
      // By the day alone: a ✅ carries only a date, and a task closed on its own day is
      // on time whatever hour a timestamp would put on it.
      if (!task.completedAt || diffDays(noteDate, task.completedAt) <= 0) closedOnTime++;
    }
  }
  return { closedOnTime, closedLate: done - closedOnTime, open: total - done, total };
}

export interface DayEntry {
  date: Date;
  dayIndex: number;
  filePath: string;
  hasNote: boolean;
  isFuture: boolean;
  tasks: Task[];
  taskCounts: DailyTaskCounts;
  habitsDone: number;
  habitsTotal: number;
}

export interface HabitSummary {
  key: string;
  completionCount: number;
  presenceCount: number;
  /** Indices (0 = Mon … 6 = Sun) of the days on which the habit was completed. */
  checkedDays: number[];
}

export class WeekSummary {
  readonly days: DayEntry[];
  readonly habits: HabitSummary[];

  private constructor(days: DayEntry[], habits: HabitSummary[]) {
    this.days = days;
    this.habits = habits;
  }

  /**
   * The week as the cache read it, one entry per day starting Monday.
   *
   * Every line is parsed here rather than taken from the entry's own `items`: a nested
   * checkbox under a task is one of that task's sub-lines there, and the week counts it
   * as a task of its own.
   */
  static from(entries: DayNoteEntry[], habitsTag: string): WeekSummary {
    const today = new Date();

    const dayMeta = entries.map((entry) => ({
      date: startOfDay(entry.date ?? today),
      isFuture: diffDays(today, entry.date ?? today) > 0,
      filePath: entry.path,
      exists: entry.exists,
    }));

    const rawContents = entries.map((entry) => (entry.exists ? entry.lines : null));

    const itemCompletionCount = new Map<string, number>();
    const itemPresenceCount = new Map<string, number>();
    const itemCheckedDays = new Map<string, number[]>();
    const days: DayEntry[] = [];

    for (let i = 0; i < 7; i++) {
      const { date, isFuture, filePath, exists } = dayMeta[i];
      const lines = rawContents[i];
      const tasks = lines
        ? lines.map((l, idx) => Task.parse(l, idx)).filter((t): t is Task => t !== null)
        : [];
      const taskCounts = computeDailyTaskCounts(tasks, date, habitsTag);
      let habitsDone = 0;
      let habitsTotal = 0;
      for (const task of tasks) {
        if (!task.hasTag(habitsTag)) continue;
        const key = task.displayTitle(habitsTag);
        habitsTotal++;
        itemPresenceCount.set(key, (itemPresenceCount.get(key) ?? 0) + 1);
        if (task.checked) {
          habitsDone++;
          itemCompletionCount.set(key, (itemCompletionCount.get(key) ?? 0) + 1);
          if (!itemCheckedDays.has(key)) itemCheckedDays.set(key, []);
          itemCheckedDays.get(key)!.push(i);
        }
      }
      days.push({
        date,
        dayIndex: i,
        filePath,
        hasNote: exists,
        isFuture,
        tasks,
        taskCounts,
        habitsDone,
        habitsTotal,
      });
    }

    const habits: HabitSummary[] = [...itemPresenceCount.keys()]
      .sort((a, b) => (itemCompletionCount.get(b) ?? 0) - (itemCompletionCount.get(a) ?? 0))
      .map((key) => ({
        key,
        completionCount: itemCompletionCount.get(key) ?? 0,
        presenceCount: itemPresenceCount.get(key)!,
        checkedDays: itemCheckedDays.get(key) ?? [],
      }));

    return new WeekSummary(days, habits);
  }
}
