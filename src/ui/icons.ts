import { getIcon } from "obsidian";
import { Status, toStatus } from "../model/task-vocabulary";

/**
 * Every icon the plugin draws, in one place. All of them come from the Lucide set
 * bundled inside Obsidian — nothing is drawn by hand and nothing is fetched.
 *
 * Members are named for what the icon *means*, not for what it depicts, so changing a
 * glyph is a one-line edit here. Two meanings sharing a drawing therefore get an entry
 * each — `AddTask` and `AddSubtask` are both a plus today, and either can move without
 * disturbing the other.
 *
 * A name Obsidian doesn't know renders an empty element without raising anything
 * (`IconName` is a bare `string` in the API), hence the enum: `icons.test.ts` checks
 * every value against the set Obsidian actually ships, refreshed by
 * `scripts/dump-icon-ids.mjs`.
 *
 * The `lucide-` prefix is not decoration. A bare name goes through Obsidian's table of
 * legacy aliases first, where `folder` means folder-open and `pencil` means edit-3; the
 * prefix asks for the Lucide icon itself.
 */
/* eslint-disable @typescript-eslint/no-duplicate-enum-values -- see above: one entry per
   meaning, whatever it happens to be drawn as. */
export enum Icon {
  // ── Opening the plugin's own views ──
  /** Ribbon: open the dashboard. */
  OpenDashboard = "lucide-gauge",
  /** The dashboard's own tab. */
  DashboardTab = "lucide-layout-dashboard",
  /** Ribbon: open the task graph. */
  OpenTaskGraph = "lucide-workflow",
  /** The task graph's own tab. */
  TaskGraphTab = "lucide-workflow",

  // ── Chrome: headers, sections, navigation ──
  Refresh = "lucide-refresh-cw",
  Settings = "lucide-settings",
  /** The twisty of a collapsible section. */
  SectionToggle = "lucide-chevron-down",
  /** The marker that opens a section's explanatory tooltip. */
  SectionInfo = "lucide-info",
  /** A day back on the dashboard, a week back on the summary. */
  PreviousPeriod = "lucide-chevron-left",
  NextPeriod = "lucide-chevron-right",
  PreviousMonth = "lucide-chevron-left",
  NextMonth = "lucide-chevron-right",
  /** The grip a row is dragged by. */
  DragHandle = "lucide-grip-vertical",

  // ── What a row leads with ──
  RecurringHabit = "lucide-refresh-cw",
  /** The day a task sits on, which clicking takes the dashboard to. */
  TaskDay = "lucide-calendar",
  /** No day yet: the task is waiting in the inbox. */
  InInbox = "lucide-inbox",
  /** The task's project, tinted with the project's own colour. */
  Project = "lucide-folder-open",

  // ── Acting on a task ──
  AddTask = "lucide-plus",
  AddSubtask = "lucide-plus",
  /** Rename in place, from the row's toolbar. */
  EditTitle = "lucide-pencil",
  /** Edit a task or a project from a graph node. */
  EditTask = "lucide-pencil",
  /** Open the full editing modal. */
  TaskDetails = "lucide-square-pen",
  OpenInGraph = "lucide-git-fork",
  /** Leave the plugin for the note the task is written in. */
  OpenNote = "lucide-arrow-up-right",
  /** The row's overflow menu. */
  MoreActions = "lucide-ellipsis",
  MoveTask = "lucide-folder-input",
  PromoteToProjectTask = "lucide-folder-input",
  MoveToInbox = "lucide-inbox",
  /** Give the task another day. */
  Reschedule = "lucide-calendar",
  /** Take the dashboard to another day. */
  PickDate = "lucide-calendar",
  DeleteTask = "lucide-trash-2",
  /** Show or hide the note attached to a row. */
  ToggleNote = "lucide-chevron-down",
  AddNote = "lucide-sticky-note",
  RemoveNote = "lucide-eraser",
  AddDependency = "lucide-link",
  RemoveDependency = "lucide-unlink",

  // ── Inbox controls ──
  /** The note an inbox item is written in. */
  InboxNote = "lucide-file-text",
  SortAscending = "lucide-arrow-up",
  SortDescending = "lucide-arrow-down",
  /** The filter's two states: items with a planned day are hidden, or shown. */
  PlannedHidden = "lucide-calendar-off",
  PlannedShown = "lucide-calendar-clock",

  // ── Move-target modal ──
  CompletedHidden = "lucide-eye-off",
  CompletedShown = "lucide-eye",
  /** The twisty of a folder in the target tree. */
  FolderToggle = "lucide-chevron-down",

  // ── Recurring-task settings ──
  MoveUp = "lucide-arrow-up",
  MoveDown = "lucide-arrow-down",
  EditRecurringTask = "lucide-pencil",
  DeleteRecurringTask = "lucide-trash-2",

  // ── Warnings a row or a node can carry ──
  /** Completed, but still hiding unfinished subtasks. */
  SubtaskWarning = "lucide-alert-triangle",
  /** Still open, but its parent task is completed. */
  ParentDoneWarning = "lucide-unlink",
  /** Sitting unfinished for longer than the section tolerates. */
  AgeWarning = "lucide-alert-triangle",

  // ── Statuses, drawn where a checklist row draws its checkbox ──
  StatusTodo = "lucide-circle",
  StatusInProgress = "lucide-circle-dot",
  StatusBlocked = "lucide-circle-slash",
  /** Apart from the circle family: `review` waits on somebody else. */
  StatusReview = "lucide-eye",
  StatusDone = "lucide-circle-check",
  StatusCancelled = "lucide-circle-x",
}
/* eslint-enable @typescript-eslint/no-duplicate-enum-values -- end of the enum. */

export const STATUS_ICONS: Record<Status, Icon> = {
  [Status.Todo]: Icon.StatusTodo,
  [Status.InProgress]: Icon.StatusInProgress,
  [Status.Blocked]: Icon.StatusBlocked,
  [Status.Review]: Icon.StatusReview,
  [Status.Done]: Icon.StatusDone,
  [Status.Cancelled]: Icon.StatusCancelled,
};

/** A status' glyph, falling back to `todo` for anything unrecognised. */
export function statusIcon(status: string): Icon {
  return STATUS_ICONS[toStatus(status) ?? Status.Todo];
}

/** An icon as markup, for the one caller that builds HTML strings rather than elements:
 *  the graph's cytoscape node labels. Everywhere else, use `setIcon`. */
export function iconMarkup(icon: Icon): string {
  return getIcon(icon)?.outerHTML ?? "";
}
