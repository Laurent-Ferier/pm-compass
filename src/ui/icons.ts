import { setIcon } from "obsidian";
import { Status, toStatus } from "../model/base-task";

/**
 * Every icon the plugin draws, all from the Lucide set bundled inside Obsidian. Members
 * are named for what the icon means, not what it depicts, so two meanings sharing a glyph
 * get an entry each and either can move alone.
 *
 * An unknown name renders an empty element without raising, hence the enum: `icons.test.ts`
 * checks every value against what Obsidian ships. The `lucide-` prefix skips Obsidian's
 * legacy aliases, where `folder` means folder-open and `pencil` means edit-3.
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

  // ── Acting on a project ──
  NewProject = "lucide-folder-plus",
  /** Takes the tasks under it too, hence a folder rather than the task's bin. */
  DeleteProject = "lucide-folder-x",

  // ── Inbox controls ──
  /** The note an inbox item is written in. */
  InboxNote = "lucide-file-text",
  SortAscending = "lucide-arrow-up",
  SortDescending = "lucide-arrow-down",
  /** The filter's two states: items with a planned day are hidden, or shown. */
  PlannedHidden = "lucide-calendar-off",
  PlannedShown = "lucide-calendar-clock",
  /** The project filter's two states: narrowed to a few projects, or open to all. */
  ProjectFilterNarrowed = "lucide-folder-check",
  ProjectFilterAll = "lucide-folder",

  // ── Move-target modal ──
  CompletedHidden = "lucide-eye-off",
  CompletedShown = "lucide-eye",
  /** The twisty of a folder in the target tree. */
  FolderToggle = "lucide-chevron-down",

  // ── Number settings ──
  /** The steppers beside a day count. Obsidian hides the input's own spinner. */
  StepUp = "lucide-chevron-up",
  StepDown = "lucide-chevron-down",

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

/**
 * A project's icon is not one of the enum's: it is whatever was chosen for that project,
 * and can be a glyph itself — obsidian-pm writes an emoji — or the name of one Obsidian
 * draws. They are told apart by shape: a name is ASCII letters, digits and dashes, which
 * no emoji is.
 */
export function isIconName(icon: string): boolean {
  return /^[a-z0-9-]+$/i.test(icon);
}

/** Draws `icon` into `el`, whichever of the two kinds it is. */
export function renderIcon(el: HTMLElement, icon: string): void {
  el.empty();
  if (isIconName(icon)) setIcon(el, icon);
  else el.setText(icon);
}
