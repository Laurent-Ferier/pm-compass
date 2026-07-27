import type { RecurringTaskDefinition } from "./recurring-task";
import { InboxSortBy, type InboxSortDir } from "./task-vocabulary";

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
  inboxSortBy: InboxSortBy;
  /** Per mode, so flipping "Title" to Z → A doesn't also flip "Newest" to oldest-first. */
  inboxSortDir: Partial<Record<InboxSortBy, InboxSortDir>>;
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
  inboxSortBy: InboxSortBy.Created,
  inboxSortDir: {},
  inboxHidePlanned: false,
  recurringTasks: [],
  recurringTasksHeading: "# Routine",
  dailyTasksHeading: "# Tasks",
  splitTaskLists: true,
  mergeDailyAndProjectTasks: true,
};
