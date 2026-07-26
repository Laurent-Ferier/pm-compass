import type { RecurringTaskDefinition } from "./recurring-task";
import type { InboxSortBy } from "./day-task-actions";

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
  recurringTasks: RecurringTaskDefinition[];
  recurringTasksHeading: string;
  smallTaskMaxWeeksAhead: number;
  dailyTasksHeading: string;
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
  inboxSortBy: "created",
  recurringTasks: [],
  recurringTasksHeading: "# Routine",
  smallTaskMaxWeeksAhead: 1,
  dailyTasksHeading: "# Tasks",
};
