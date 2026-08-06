import { formatDate, parseDate, startOfDay } from "./dates";
// Persisted here, but defined with the comparison that reads them, and re-exported so
// callers can import them from the settings they live in.
import { TaskSortKey, TaskSortDir } from "./base-task";
export { TaskSortKey, TaskSortDir };
import type { RecurringTaskDefinition } from "./daily/recurring-task";


export interface PMCompassSettings {
  projectsFolder: string;
  syncObsidianPmSettings: boolean;
  /** The graph's one display filter: on, it holds back the tasks that count as finished
   *  and the projects that have been archived. */
  panelConfig: { showActiveOnly: boolean };
  dailyHabitsTag: string;
  dashboardCollapsed: Record<string, boolean>;
  unclosedDaysBefore: number;
  unclosedDaysAfter: number;
  inboxFilePath: string;
  inboxStaleAfterDays: number;
  inboxSortBy: TaskSortKey;
  /** Per mode, so flipping "Title" to Z → A doesn't also flip "Newest" to oldest-first. */
  inboxSortDir: Partial<Record<TaskSortKey, TaskSortDir>>;
  /** Hides inbox items carrying a ⏳ target date: they are planned, not untriaged. */
  inboxHidePlanned: boolean;
  /** The projects whose undated tasks the inbox holds back. Named by what is hidden rather
   *  than what is shown, so a project the vault gains — a new one, or one back from the
   *  archive — shows up rather than being filtered out unasked. Ids of projects that are
   *  gone drop off the list the next time the picker writes it.
   *  Inbox items carry no project and are never filtered. */
  inboxHiddenProjects: string[];
  recurringTasks: RecurringTaskDefinition[];
  recurringTasksHeading: string;
  dailyTasksHeading: string;
  /** Splits the dashboard's tasks into sections — the three horizons when merged, else
   *  the checklist and the queues. Off, each group is one list in that order. */
  splitTaskLists: boolean;
  /** Merges the daily and project tasks into "Overdue" / "Current" / "Next up", each
   *  holding both kinds; off, the two keep their own sections. */
  mergeDailyAndProjectTasks: boolean;
  /** Checks every project and parent task's checklist against the tasks that exist, once
   *  at the start of a session. Off, each note is checked the first time it changes instead. */
  verifyListingsOnLoad: boolean;
  /** Asks before deleting a task, an inbox item, a checklist item or a habit. */
  confirmDeletes: boolean;
  /** Asks before removing a task's note, nested checklist lines going with it. */
  confirmNoteRemoval: boolean;
  /** Asks before a drag and drop in the graph relocates a task. */
  confirmTaskMoves: boolean;
  /** Asks before an edge's menu drops a dependency. */
  confirmDependencyRemoval: boolean;
  /** Asks before "Reset layout" strips the card field from every task note it reaches. */
  confirmLayoutReset: boolean;
}

export const DEFAULT_SETTINGS: PMCompassSettings = {
  projectsFolder: "Projects",
  syncObsidianPmSettings: true,
  panelConfig: { showActiveOnly: true },
  dailyHabitsTag: "daily",
  dashboardCollapsed: {},
  unclosedDaysBefore: 30,
  unclosedDaysAfter: 15,
  inboxFilePath: "",
  inboxStaleAfterDays: 7,
  inboxSortBy: TaskSortKey.Created,
  inboxSortDir: {},
  inboxHidePlanned: false,
  inboxHiddenProjects: [],
  recurringTasks: [],
  recurringTasksHeading: "# Routine",
  dailyTasksHeading: "# Tasks",
  splitTaskLists: true,
  mergeDailyAndProjectTasks: true,
  verifyListingsOnLoad: true,
  confirmDeletes: true,
  confirmNoteRemoval: true,
  confirmTaskMoves: true,
  confirmDependencyRemoval: true,
  confirmLayoutReset: true,
};

/** A recurring habit as `data.json` holds it: its `createdAt` is `YYYY-MM-DD` text, JSON
 *  having no date of its own. */
export type StoredRecurringTask = Omit<RecurringTaskDefinition, "createdAt"> & { createdAt: string };

/** The settings as `data.json` holds them; only the dates differ from `PMCompassSettings`
 *  — see the `readSettings`/`writeSettings` pair. */
export type StoredSettings = Omit<PMCompassSettings, "recurringTasks"> & {
  recurringTasks: StoredRecurringTask[];
};

/** Stored settings with their text dates parsed. An unparseable one falls back to today,
 *  a habit's `createdAt` being a label rather than something acted on. */
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
