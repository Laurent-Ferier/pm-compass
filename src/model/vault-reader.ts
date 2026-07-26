import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { Task, Project } from "./shared";
import { toPriority } from "./task-vocabulary";

export interface VaultData {
  projects: Project[];
  tasks: Task[];
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
        createdAt: fm["createdAt"] ? String(fm["createdAt"]) : undefined,
        updatedAt: fm["updatedAt"] ? String(fm["updatedAt"]) : undefined,
        filePath: file.path,
      });
    } else if (fm["pm-task"] === true) {
      const id = String(fm["id"] ?? "");
      const projectId = String(fm["projectId"] ?? "");
      if (!id || !projectId) continue;
      tasks.push({
        id,
        projectId,
        title: String(fm["title"] ?? file.basename),
        parentId: fm["parentId"] ? String(fm["parentId"]) : undefined,
        status: String(fm["status"] ?? "todo"),
        // `|| undefined`: an unrecognised (hand-typed) value narrows to `None`, and an
        // absent priority and an unusable one should both read as "no priority".
        priority: toPriority(fm["priority"]) || undefined,
        type: fm["type"] ? (String(fm["type"]) as Task["type"]) : undefined,
        dependencies: Array.isArray(fm["dependencies"])
          ? (fm["dependencies"] as string[])
          : [],
        subtasks: [],
        start: fm["start"] ? String(fm["start"]) : undefined,
        due: fm["due"] ? String(fm["due"]) : undefined,
        progress:
          typeof fm["progress"] === "number" ? fm["progress"] : undefined,
        completed: fm["completed"] ? String(fm["completed"]) : undefined,
        assignees: Array.isArray(fm["assignees"])
          ? (fm["assignees"] as string[])
          : undefined,
        tags: Array.isArray(fm["tags"]) ? (fm["tags"] as string[]) : undefined,
        createdAt: fm["createdAt"] ? String(fm["createdAt"]) : undefined,
        updatedAt: fm["updatedAt"] ? String(fm["updatedAt"]) : undefined,
        filePath: file.path,
      });
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
