import { App } from "obsidian";
import type { Project } from "./shared";
import {
  ensureFolderRecursive, generateId, resolveFile, slugify, touch, uniquePathIn,
} from "./file-helpers";
import { PROJECT_TASK_SECTION, addChildLink, removeChildLink } from "./child-links";

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

/**
 * Wraps the markdown file for a single project, providing typed async operations
 * on its frontmatter. One instance per file.
 *
 * Analogous to ProjectTaskFile but for the project root file (pm-project: true).
 */
export class ProjectFile {
  readonly filePath: string;
  private readonly app: App;

  constructor(app: App, filePath: string) {
    this.app = app;
    this.filePath = filePath;
  }

  private get tfile() {
    return resolveFile(this.app, this.filePath);
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
    if (!fm || fm["pm-project"] !== true) return null;
    const id = String(fm["id"] ?? "");
    if (!id) return null;
    return {
      id,
      title: String(fm["title"] ?? file.basename),
      color: fm["color"] ? String(fm["color"]) : undefined,
      icon: fm["icon"] ? String(fm["icon"]) : undefined,
    };
  }

  /** Update the project's title, color, and icon in the frontmatter. */
  async update(data: UpdateProjectData): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm["title"] = data.title;
      if (data.color) { fm["color"] = data.color; } else { delete fm["color"]; }
      if (data.icon) { fm["icon"] = data.icon; } else { delete fm["icon"]; }
      touch(fm);
    });
  }

  /**
   * Register a task at the project's root (updates taskIds + the `## Tasks`
   * checklist). Only root-level tasks are listed here; nested ones are tracked
   * by their parent task's `subtaskIds`.
   */
  async addTaskLink(taskId: string, taskTitle: string, taskBasename: string): Promise<void> {
    await addChildLink(this.app, this.filePath, PROJECT_TASK_SECTION, taskId, taskTitle, taskBasename);
  }

  /** Unregister a root-level task (updates taskIds + the `## Tasks` checklist). */
  async removeTaskLink(taskId: string, taskBasename: string): Promise<void> {
    await removeChildLink(this.app, this.filePath, PROJECT_TASK_SECTION, taskId, taskBasename);
  }

  /**
   * Create a project file in the projects folder.
   *
   * The frontmatter mirrors what the obsidian-pm plugin emits — including the
   * fields this plugin never reads (`description`, `customFields`,
   * `teamMembers`, `savedViews`) — so a project created here is indistinguishable
   * from one created there. That schema is owned by obsidian-pm, not this repo;
   * it is reproduced from observed files and would need revisiting if that
   * plugin's format changes.
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
