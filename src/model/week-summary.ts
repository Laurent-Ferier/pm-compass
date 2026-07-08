import { App, TFile, normalizePath } from "obsidian";
import { moment, type Moment } from "./moment";
import { DayTask, parseDate } from "./day-task";

export interface DailyNotesConfig {
  folder: string;
  format: string;
  template: string;
}

export interface DailyTaskCounts {
  closedOnTime: number;
  closedLate: number;
  open: number;
  total: number;
}

/** Counts one-off (non-habit) checklist items for a single day.
 *  Habit-tagged items are excluded. Items without a ✅ timestamp are treated as closed on time. */
export function computeDailyTaskCounts(
  items: DayTask[],
  noteDate: string,
  habitsTag: string,
): DailyTaskCounts {
  let closedOnTime = 0;
  let done = 0;
  let total = 0;
  for (const task of items) {
    if (task.tags.includes(`#${habitsTag}`)) continue;
    total++;
    if (task.checked) {
      done++;
      if (!task.completedAt || task.completedAt <= parseDate(noteDate)) closedOnTime++;
    }
  }
  return { closedOnTime, closedLate: done - closedOnTime, open: total - done, total };
}

export interface DayEntry {
  dateStr: string;
  dayIndex: number;
  filePath: string;
  hasNote: boolean;
  isFuture: boolean;
  tasks: DayTask[];
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

  static async load(app: App, weekStart: Moment, config: DailyNotesConfig, habitsTag: string): Promise<WeekSummary> {
    const today = moment();

    const dayMeta = Array.from({ length: 7 }, (_, i) => {
      const day = moment(weekStart).add(i, "days");
      const dateStr: string = day.format("YYYY-MM-DD");
      const isFuture: boolean = day.isAfter(today, "day");
      const filePath = normalizePath(
        config.folder
          ? `${config.folder}/${day.format(config.format)}.md`
          : `${day.format(config.format)}.md`,
      );
      const file = app.vault.getAbstractFileByPath(filePath);
      return { dateStr, isFuture, filePath, file: file instanceof TFile ? file : null };
    });

    const rawContents = await Promise.all(
      dayMeta.map(({ file }) => (file ? app.vault.read(file) : Promise.resolve(null))),
    );

    const itemCompletionCount = new Map<string, number>();
    const itemPresenceCount = new Map<string, number>();
    const itemCheckedDays = new Map<string, number[]>();
    const days: DayEntry[] = [];

    for (let i = 0; i < 7; i++) {
      const { dateStr, isFuture, filePath, file } = dayMeta[i];
      const raw = rawContents[i];
      const tasks =
        raw !== null
          ? raw
              .split("\n")
              .map((l, idx) => DayTask.parse(l, idx))
              .filter((t): t is DayTask => t !== null)
          : [];
      const taskCounts = computeDailyTaskCounts(tasks, dateStr, habitsTag);
      let habitsDone = 0;
      let habitsTotal = 0;
      for (const task of tasks) {
        if (!task.tags.includes(`#${habitsTag}`)) continue;
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
        dateStr,
        dayIndex: i,
        filePath,
        hasNote: file !== null,
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
