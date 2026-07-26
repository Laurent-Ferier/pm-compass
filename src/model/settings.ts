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
  inboxSortBy: InboxSortBy.Created,
  inboxSortDir: {},
  recurringTasks: [],
  recurringTasksHeading: "# Routine",
  smallTaskMaxWeeksAhead: 1,
  dailyTasksHeading: "# Tasks",
};
