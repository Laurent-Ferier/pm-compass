import { parseDate, parseTimestamp, timestampDay } from "../dates";

/**
 * The frontmatter keys obsidian-pm writes on a project or task note, and how their values
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
  Tags = "tags",
  /** Project-only presentation fields. */
  Color = "color",
  Icon = "icon",
  /** Project-only: `true` puts the project away, leaving it out of the live views. */
  Archived = "archived",
  CreatedAt = "createdAt",
  UpdatedAt = "updatedAt",
  /** When the opening pass first found this task's `parentId` naming nothing. A later pass
   *  that still finds nothing attaches the task to its project — see `listing-repair.ts`. */
  OrphanedAt = "orphanedAt",
  /** This plugin's own, which obsidian-pm neither writes nor reads: where the task's card
   *  was dragged to in the graph and how big it was made — see `card-layout.ts`. */
  CardLayout = "cardLayout",
}

/** Stamps `updatedAt` with the current time: what every write of a note's own fields ends
 *  with, as against where its card was left. */
export function touch(fm: Record<string, unknown>): void {
  fm[Frontmatter.UpdatedAt] = new Date().toISOString();
}

// ── What an unknown value off a note narrows to ──────────────────────────────
//
// Frontmatter arrives as whatever YAML made of it, and obsidian-pm's own notes are hand-edited
// — so every field is read through one of these rather than trusted to be what it should be.

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

/** A string array, dropping non-string entries. */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Types Obsidian's `any`-typed FrontMatterCache as a plain unknown-valued record. */
export function asFrontmatterRecord(value: unknown): Record<string, unknown> | undefined {
  return value as Record<string, unknown> | undefined;
}

// ── The block itself ─────────────────────────────────────────────────────────

// A leading BOM or blank line before the opening `---` is kept in the captured block, so
// a file `processFrontMatter` just wrote still round-trips through the split.
const FRONTMATTER_BLOCK = /^\s*---[\s\S]*?\n---\n?/;

/** Splits file content into its frontmatter block, delimiters included, and the rest. */
export function splitFrontmatterBody(raw: string): { frontmatterBlock: string; body: string } {
  const match = raw.match(FRONTMATTER_BLOCK);
  return {
    frontmatterBlock: match ? match[0] : "",
    body: match ? raw.slice(match[0].length) : "",
  };
}
