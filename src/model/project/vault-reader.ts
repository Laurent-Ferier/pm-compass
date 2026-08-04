import { App, FrontMatterCache, TFile, TFolder, normalizePath, parseYaml } from "obsidian";
import { splitFrontmatterBody } from "../operations/file-helpers";
import { parseDate, parseTimestamp, timestampDay } from "../dates";
import { type Project } from "./project";
import { Task, toTaskType } from "./task";
import { Status, toPriority } from "../base-task";
import { Frontmatter } from "./frontmatter";
import { toCardLayout } from "./card-layout";

export interface VaultData {
  projects: Project[];
  tasks: Task[];
}

/**
 * A `YYYY-MM-DD` frontmatter field as a day. obsidian-pm quotes these, so they arrive as
 * text; an unquoted one YAML has already made a `Date` of is read by its UTC calendar day,
 * which is the day it was written as. Anything else reads as no date at all.
 */
function day(value: unknown): Date | undefined {
  if (value instanceof Date) return timestampDay(value);
  return (typeof value === "string" ? parseDate(value) : null) ?? undefined;
}

/** An ISO frontmatter timestamp as the instant it names. */
function timestamp(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  return (typeof value === "string" ? parseTimestamp(value) : null) ?? undefined;
}

/**
 * A copy a file-syncing tool left beside the original when both ends had edits: Syncthing's
 * `.sync-conflict-<date>-<device>` and Dropbox's `(conflicted copy …)`. It carries the same
 * frontmatter `id` as the original, so reading it would put the task on the board twice.
 */
function isConflictCopy(basename: string): boolean {
  return /\.sync-conflict-\d/.test(basename) || /\(conflicted copy\b/i.test(basename);
}

/**
 * A note's frontmatter, read from the file when the metadata cache hasn't got it.
 * Obsidian reparses a file it has just written asynchronously, so a read landing in that
 * gap sees no frontmatter at all — and a task that vanishes for one render takes the
 * layout with it. Every file under the projects folder carries frontmatter, so this
 * fallback only ever runs for that gap, or for a note that genuinely has none.
 */
async function readFrontmatter(app: App, file: TFile): Promise<FrontMatterCache | null> {
  const { frontmatterBlock } = splitFrontmatterBody(await app.vault.cachedRead(file));
  if (!frontmatterBlock) return null;
  try {
    const parsed: unknown = parseYaml(frontmatterBlock.replace(/^\s*---\r?\n/, "").replace(/---\r?\n?$/, ""));
    // A YAML list or scalar parses fine and names no fields; only a mapping is frontmatter.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Frontmatter Obsidian itself can't parse names no task; the note is simply skipped.
    return null;
  }
}

function collectMdFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      if (!isConflictCopy(child.basename)) files.push(child);
    } else if (child instanceof TFolder) {
      files.push(...collectMdFiles(child));
    }
  }
  return files;
}

export async function loadVaultData(
  app: App,
  projectsFolder: string,
): Promise<VaultData> {
  const abstractFile = app.vault.getAbstractFileByPath(
    normalizePath(projectsFolder),
  );
  if (!(abstractFile instanceof TFolder)) {
    return { projects: [], tasks: [] };
  }

  const files = collectMdFiles(abstractFile);
  // Read together rather than one after the next inside the loop below: on a cold cache
  // that is every file in the folder, and the reads don't depend on each other.
  const missed = files.filter((f) => !app.metadataCache.getFileCache(f)?.frontmatter);
  const fallbacks = new Map(
    (await Promise.all(missed.map(async (f) => [f, await readFrontmatter(app, f)] as const))),
  );

  const projects: Project[] = [];
  const tasks: Task[] = [];
  // An id names one project or task, so a second file claiming it is a duplicate of that
  // note — a hand-made copy, a restored backup — and reading it would double the row.
  const seenIds = new Set<string>();

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter ?? fallbacks.get(file);
    if (!fm) continue;

    if (fm[Frontmatter.IsProject] === true) {
      const id = String(fm[Frontmatter.Id] ?? "");
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      projects.push({
        id,
        title: String(fm[Frontmatter.Title] ?? file.basename),
        tasks: [],
        color: fm[Frontmatter.Color] ? String(fm[Frontmatter.Color]) : undefined,
        icon: fm[Frontmatter.Icon] ? String(fm[Frontmatter.Icon]) : undefined,
        // Read as the markers are: only a real `true` puts a project away.
        archived: fm[Frontmatter.Archived] === true || undefined,
        createdAt: timestamp(fm[Frontmatter.CreatedAt]),
        updatedAt: timestamp(fm[Frontmatter.UpdatedAt]),
        card: toCardLayout(fm[Frontmatter.CardLayout]),
        filePath: file.path,
      });
    } else if (fm[Frontmatter.IsTask] === true) {
      const id = String(fm[Frontmatter.Id] ?? "");
      const projectId = String(fm[Frontmatter.ProjectId] ?? "");
      if (!id || !projectId || seenIds.has(id)) continue;
      seenIds.add(id);
      tasks.push(new Task({
        id,
        projectId,
        title: String(fm[Frontmatter.Title] ?? file.basename),
        parentId: fm[Frontmatter.ParentId] ? String(fm[Frontmatter.ParentId]) : undefined,
        status: String(fm[Frontmatter.Status] ?? Status.Todo),
        // `|| undefined`: an unrecognised (hand-typed) value narrows to `None`, and an
        // absent priority and an unusable one should both read as "no priority".
        priority: toPriority(fm[Frontmatter.Priority]) || undefined,
        type: toTaskType(fm[Frontmatter.Type]),
        dependencies: Array.isArray(fm[Frontmatter.Dependencies])
          ? (fm[Frontmatter.Dependencies] as string[])
          : [],
        subtasks: [],
        start: day(fm[Frontmatter.Start]),
        due: day(fm[Frontmatter.Due]),
        progress:
          typeof fm[Frontmatter.Progress] === "number" ? fm[Frontmatter.Progress] : undefined,
        completed: timestamp(fm[Frontmatter.Completed]),
        assignees: Array.isArray(fm[Frontmatter.Assignees])
          ? (fm[Frontmatter.Assignees] as string[])
          : undefined,
        tags: Array.isArray(fm[Frontmatter.Tags]) ? (fm[Frontmatter.Tags] as string[]) : undefined,
        createdAt: timestamp(fm[Frontmatter.CreatedAt]),
        updatedAt: timestamp(fm[Frontmatter.UpdatedAt]),
        card: toCardLayout(fm[Frontmatter.CardLayout]),
        filePath: file.path,
      }));
    }
  }

  // Populate each project's tasks array
  const projectIndex = new Map(projects.map((p) => [p.id, p]));
  for (const task of tasks) {
    projectIndex.get(task.projectId)?.tasks.push(task);
  }

  return { projects, tasks };
}

/** Reads the projectsFolder setting from obsidian-pm's data.json. Returns null if unavailable. */
export async function readObsidianPmSettings(
  app: App,
): Promise<{ projectsFolder: string } | null> {
  try {
    const path = normalizePath(
      `${app.vault.configDir}/plugins/obsidian-pm/data.json`,
    );
    const raw = await app.vault.adapter.read(path);
    const data = JSON.parse(raw) as { projectsFolder?: string };
    return data.projectsFolder ? { projectsFolder: data.projectsFolder } : null;
  } catch {
    return null;
  }
}
