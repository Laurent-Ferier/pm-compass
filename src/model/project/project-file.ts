import { App } from "obsidian";
import type { Project } from "./project";
import {
  ensureFolderRecursive, generateId, slugify, touch, uniquePathIn,
} from "../operations/file-helpers";
import { PROJECT_TASK_SECTION } from "./child-links";
import { BaseNote } from "./base-note";
import { Frontmatter } from "./frontmatter";
import { ProjectTaskFile, tasksFolderFor } from "./project-task-file";

export interface CreateProjectOpts {
  projectsFolder: string;
  title: string;
}

const DEFAULT_PROJECT_ICON = "📋";

export interface UpdateProjectData {
  title: string;
  color: string;
  icon: string;
}

/** One project's root file, with typed operations on its frontmatter. Lists its children
 *  as `ProjectTaskFile` does — hence `BaseNote` — but only its root-level tasks. */
export class ProjectFile extends BaseNote {
  protected get childSection() {
    return PROJECT_TASK_SECTION;
  }

  protected get childFolder() {
    return tasksFolderFor(this.filePath);
  }

  protected childNote(filePath: string): ProjectTaskFile {
    return new ProjectTaskFile(this.app, filePath);
  }

  /**
   * Read project metadata from the frontmatter.
   * Returns null when the file does not exist or has no frontmatter.
   */
  async readMetadata(): Promise<Pick<Project, "id" | "title" | "color" | "icon"> | null> {
    const file = this.tfile;
    if (!file) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm || fm[Frontmatter.IsProject] !== true) return null;
    const id = String(fm[Frontmatter.Id] ?? "");
    if (!id) return null;
    return {
      id,
      title: String(fm[Frontmatter.Title] ?? file.basename),
      color: fm[Frontmatter.Color] ? String(fm[Frontmatter.Color]) : undefined,
      icon: fm[Frontmatter.Icon] ? String(fm[Frontmatter.Icon]) : undefined,
    };
  }

  /** Update the project's title, color, and icon in the frontmatter. */
  async update(data: UpdateProjectData): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[Frontmatter.Title] = data.title;
      if (data.color) { fm[Frontmatter.Color] = data.color; } else { delete fm[Frontmatter.Color]; }
      if (data.icon) { fm[Frontmatter.Icon] = data.icon; } else { delete fm[Frontmatter.Icon]; }
      touch(fm);
    });
  }

  /**
   * Creates a project file in the projects folder. The frontmatter mirrors what
   * obsidian-pm emits, fields this plugin never reads included, so a project created
   * here is indistinguishable from one created there. That schema is obsidian-pm's,
   * reproduced from observed files, and would need revisiting if its format changes.
   */
  static async create(app: App, opts: CreateProjectOpts): Promise<{ id: string; filePath: string }> {
    await ensureFolderRecursive(app, opts.projectsFolder);
    const filePath = uniquePathIn(app, opts.projectsFolder, slugify(opts.title) || "project");

    const id = generateId();
    const now = new Date().toISOString();

    const lines = [
      "---",
      "pm-project: true",
      `id: "${id}"`,
      `title: "${opts.title.replace(/"/g, '\\"')}"`,
      'description: ""',
      `icon: "${DEFAULT_PROJECT_ICON}"`,
      "taskIds: []",
      "customFields: []",
      "teamMembers: []",
      "savedViews: []",
      `createdAt: "${now}"`,
      `updatedAt: "${now}"`,
      "---",
      "",
      `# ${DEFAULT_PROJECT_ICON} ${opts.title}`,
      "",
      "## Tasks",
    ];

    await app.vault.create(filePath, lines.join("\n") + "\n");
    return { id, filePath };
  }
}
