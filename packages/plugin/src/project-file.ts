import { App, TFile } from "obsidian";
import type { Project } from "./shared";

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

  private get tfile(): TFile | null {
    const f = this.app.vault.getFileByPath(this.filePath);
    return f instanceof TFile ? f : null;
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
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm["title"] = data.title;
      if (data.color) { fm["color"] = data.color; } else { delete fm["color"]; }
      if (data.icon) { fm["icon"] = data.icon; } else { delete fm["icon"]; }
      fm["updatedAt"] = new Date().toISOString();
    });
  }
}
