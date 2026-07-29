import { formatDate, parseDate, startOfDay } from "./dates";
// Ordered on and persisted here, but defined with the comparison that reads them.
// Re-exported so every caller can keep importing them from the settings they live in.
import { TaskSortKey, TaskSortDir } from "./base-task";
export { TaskSortKey, TaskSortDir };
import type { RecurringTaskDefinition } from "./daily/recurring-task";


export interface PMCompassSettings {
  projectsFolder: string;
  syncObsidianPmSettings: boolean;
  panelConfig: { showActiveOnly: boolean };
  nodePositions: Record<string, { x: number; y: number }>;
  dailyHabitsTag: string;
  dashboardCollapsed: Record<string, boolean>;
  unclosedDaysBefore: number;
  unclosedDaysAfter: number;
  inboxFilePath: string;
  inboxStaleAfterDays: number;
  inboxSortBy: TaskSortKey;
  /** Per mode, so flipping "Title" to Z → A doesn't also flip "Newest" to oldest-first. */
  inboxSortDir: Partial<Record<TaskSortKey, TaskSortDir>>;
  /** Hides inbox items that already carry a ⏳ target date — they are planned, so they
   *  are no longer what the inbox is for triaging. */
  inboxHidePlanned: boolean;
  recurringTasks: RecurringTaskDefinition[];
  recurringTasksHeading: string;
  dailyTasksHeading: string;
  /** Splits the dashboard's tasks into sections — the three horizons when merged, else the
   *  day's checklist and the project queues; off, each group is one list in that order. */
  splitTaskLists: boolean;
  /** Merges the daily and project tasks into "Overdue" / "Current" / "Next up", each
   *  holding both kinds; off, the two keep their own sections. */
  mergeDailyAndProjectTasks: boolean;
  /** Checks every project and parent task's checklist against the tasks that exist when
   *  the dashboard opens. Off, each note is checked the first time it changes instead. */
  verifyListingsOnLoad: boolean;
}

export const DEFAULT_SETTINGS: PMCompassSettings = {
  projectsFolder: "Projects",
  syncObsidianPmSettings: true,
  panelConfig: { showActiveOnly: true },
  nodePositions: {},
  dailyHabitsTag: "daily",
  dashboardCollapsed: {},
  unclosedDaysBefore: 7,
  unclosedDaysAfter: 7,
  inboxFilePath: "",
  inboxStaleAfterDays: 7,
  inboxSortBy: TaskSortKey.Created,
  inboxSortDir: {},
  inboxHidePlanned: false,
  recurringTasks: [],
  recurringTasksHeading: "# Routine",
  dailyTasksHeading: "# Tasks",
  splitTaskLists: true,
  mergeDailyAndProjectTasks: true,
  verifyListingsOnLoad: true,
};

/** A recurring habit as `data.json` holds it: its `createdAt` is `YYYY-MM-DD` text, JSON
 *  having no date of its own. */
export type StoredRecurringTask = Omit<RecurringTaskDefinition, "createdAt"> & { createdAt: string };

/** The settings as they are written to and read from `data.json`. Only the dates differ
 *  from `PMCompassSettings` — see `readSettings`/`writeSettings`, the pair that convert. */
export type StoredSettings = Omit<PMCompassSettings, "recurringTasks"> & {
  recurringTasks: StoredRecurringTask[];
};

/** Stored settings as the plugin holds them: text dates parsed. An unparseable one falls
 *  back to today, a habit's `createdAt` being a label rather than something acted on. */
export function readSettings(stored: Partial<StoredSettings>): Partial<PMCompassSettings> {
  if (!stored.recurringTasks) return stored as Partial<PMCompassSettings>;
  return {
    ...stored,
    recurringTasks: stored.recurringTasks.map((task) => ({
      ...task,
      createdAt: parseDate(task.createdAt) ?? startOfDay(new Date()),
    })),
  };
}

/** The inverse: what gets written to `data.json`. */
export function writeSettings(settings: PMCompassSettings): StoredSettings {
  return {
    ...settings,
    recurringTasks: settings.recurringTasks.map((task) => ({
      ...task,
      createdAt: formatDate(task.createdAt),
    })),
  };
}
