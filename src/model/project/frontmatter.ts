/**
 * The frontmatter keys obsidian-pm writes on a project or task note. Every read and
 * write of a note's frontmatter goes through these, so the one place a key's spelling
 * lives is here — the notes themselves keep the exact strings they always had.
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
