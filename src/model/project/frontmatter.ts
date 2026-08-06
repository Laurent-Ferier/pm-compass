import { parseDate, parseTimestamp, timestampDay } from "../dates";

/**
 * The frontmatter keys obsidian-pm writes on a project or task note, and how its dates
 * read. Every read and write of a note's frontmatter goes through these, so the one place
 * a key's spelling lives is here — the notes themselves keep the exact strings they
 * always had.
 */
export enum Frontmatter {
  /** Marker fields: `true` on the note that is a project / a task. */
  IsProject = "pm-project",
  IsTask = "pm-task",
  Id = "id",
  Title = "title",
  ProjectId = "projectId",
  ParentId = "parentId",
  /** Listing bookkeeping: the children a task's note lists, and a project's own. */
  SubtaskIds = "subtaskIds",
  TaskIds = "taskIds",
  Status = "status",
  Priority = "priority",
  Type = "type",
  Dependencies = "dependencies",
  Start = "start",
  Due = "due",
  Progress = "progress",
  Completed = "completed",
  Assignees = "assignees",
  Tags = "tags",
  /** Project-only presentation fields. */
  Color = "color",
  Icon = "icon",
  /** Project-only: `true` puts the project away, leaving it out of the live views. */
  Archived = "archived",
  CreatedAt = "createdAt",
  UpdatedAt = "updatedAt",
  /** This plugin's own, which obsidian-pm neither writes nor reads: where the task's card
   *  was dragged to in the graph and how big it was made — see `card-layout.ts`. */
  CardLayout = "cardLayout",
}

/**
 * A `YYYY-MM-DD` frontmatter field as a day. obsidian-pm quotes these, so they arrive as
 * text; an unquoted one YAML has already made a `Date` of is read by its UTC calendar day,
 * which is the day it was written as. Anything else reads as no date at all.
 */
export function frontmatterDay(value: unknown): Date | undefined {
  if (value instanceof Date) return timestampDay(value);
  return (typeof value === "string" ? parseDate(value) : null) ?? undefined;
}

/** An ISO frontmatter timestamp as the instant it names. */
export function frontmatterTimestamp(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  return (typeof value === "string" ? parseTimestamp(value) : null) ?? undefined;
}
