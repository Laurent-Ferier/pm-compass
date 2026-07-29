import { App, TFile, TFolder, normalizePath } from "obsidian";
import { parseDate, parseTimestamp } from "./dates";
import { Task, type Project } from "./shared";
import { Status, toPriority } from "./task-vocabulary";

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
  if (value instanceof Date) {
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  return (typeof value === "string" ? parseDate(value) : null) ?? undefined;
}

/** An ISO frontmatter timestamp as the instant it names. */
function timestamp(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  return (typeof value === "string" ? parseTimestamp(value) : null) ?? undefined;
}

function collectMdFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      files.push(child);
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
  const projects: Project[] = [];
  const tasks: Task[] = [];

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) continue;

    if (fm["pm-project"] === true) {
      const id = String(fm["id"] ?? "");
      if (!id) continue;
      projects.push({
        id,
        title: String(fm["title"] ?? file.basename),
        tasks: [],
        color: fm["color"] ? String(fm["color"]) : undefined,
        icon: fm["icon"] ? String(fm["icon"]) : undefined,
        createdAt: timestamp(fm["createdAt"]),
        updatedAt: timestamp(fm["updatedAt"]),
        filePath: file.path,
      });
    } else if (fm["pm-task"] === true) {
      const id = String(fm["id"] ?? "");
      const projectId = String(fm["projectId"] ?? "");
      if (!id || !projectId) continue;
      tasks.push(new Task({
        id,
        projectId,
        title: String(fm["title"] ?? file.basename),
        parentId: fm["parentId"] ? String(fm["parentId"]) : undefined,
        status: String(fm["status"] ?? Status.Todo),
        // `|| undefined`: an unrecognised (hand-typed) value narrows to `None`, and an
        // absent priority and an unusable one should both read as "no priority".
        priority: toPriority(fm["priority"]) || undefined,
        type: fm["type"] ? (String(fm["type"]) as Task["type"]) : undefined,
        dependencies: Array.isArray(fm["dependencies"])
          ? (fm["dependencies"] as string[])
          : [],
        subtasks: [],
        start: day(fm["start"]),
        due: day(fm["due"]),
        progress:
          typeof fm["progress"] === "number" ? fm["progress"] : undefined,
        completed: timestamp(fm["completed"]),
        assignees: Array.isArray(fm["assignees"])
          ? (fm["assignees"] as string[])
          : undefined,
        tags: Array.isArray(fm["tags"]) ? (fm["tags"] as string[]) : undefined,
        createdAt: timestamp(fm["createdAt"]),
        updatedAt: timestamp(fm["updatedAt"]),
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
