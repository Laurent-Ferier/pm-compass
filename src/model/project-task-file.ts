import { App, normalizePath } from "obsidian";
import { addDependencyToTask, removeDependencyFromTask } from "./shared";
import type { Task } from "./shared";
import { basenameOf, resolveFile, splitFrontmatterBody, touch } from "./file-helpers";

/** Generates a 16-char lowercase hex ID with 64 bits of cryptographic randomness. */
export function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

function buildFrontmatter(fields: {
  id: string;
  projectId: string;
  parentId?: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  start: string;
  due: string;
  progress: number;
  dependencies: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}): string[] {
  const lines = ["---", "pm-task: true", `id: "${fields.id}"`, `title: "${fields.title.replace(/"/g, '\\"')}"`];
  lines.push(`projectId: "${fields.projectId}"`);
  if (fields.parentId) lines.push(`parentId: "${fields.parentId}"`);
  lines.push(`status: ${fields.status}`);
  if (fields.priority) lines.push(`priority: ${fields.priority}`);
  lines.push(`type: ${fields.type}`);
  if (fields.start) lines.push(`start: "${fields.start}"`);
  if (fields.due) lines.push(`due: "${fields.due}"`);
  if (fields.progress > 0) lines.push(`progress: ${fields.progress}`);
  if (fields.dependencies.length > 0) {
    lines.push(`dependencies: [${fields.dependencies.map((d) => `"${d}"`).join(", ")}]`);
  } else {
    lines.push("dependencies: []");
  }
  lines.push("subtaskIds: []");
  if (fields.tags.length > 0) {
    lines.push(`tags: [${fields.tags.map((t) => `"${t}"`).join(", ")}]`);
  }
  lines.push(`createdAt: "${fields.createdAt}"`);
  lines.push(`updatedAt: "${fields.updatedAt}"`);
  lines.push("---");
  return lines;
}

export interface CreateTaskOpts {
  projectId: string;
  projectFilePath: string;
  projectTitle: string;
  parentTask?: Task;
  title: string;
  description: string;
  status: string;
  priority: string;
  type: string;
  progress: number;
  start: string;
  due: string;
  tags: string[];
  dependencies: string[];
}

export interface UpdateTaskData {
  title: string;
  description: string;
  status: string;
  priority: string;
  type: string;
  progress: number;
  start: string;
  due: string;
  tags: string[];
  dependencies: string[];
}

/**
 * Wraps the markdown file for a single project task, providing typed async
 * operations on its frontmatter and body. One instance per file.
 *
 * Analogous to DayMarkdownFile but for per-task frontmatter files instead of
 * multi-task daily notes.
 */
export class ProjectTaskFile {
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
   * Read the list of direct subtask IDs from the `subtaskIds` frontmatter field.
   * Returns an empty array when the file does not exist or the field is absent.
   */
  async readSubtaskIds(): Promise<string[]> {
    const file = this.tfile;
    if (!file) return [];
    const cache = this.app.metadataCache.getFileCache(file);
    const ids: unknown = cache?.frontmatter?.["subtaskIds"];
    return Array.isArray(ids) ? (ids as string[]) : [];
  }

  /** Read the user-editable description (without frontmatter or auto-prefix link). */
  async readDescription(): Promise<string> {
    const file = this.tfile;
    if (!file) return "";
    const content = await this.app.vault.read(file);
    const { body } = splitFrontmatterBody(content);
    if (!body) return "";
    return body.trim().replace(/^(?:Project|Parent): \[\[[^\]]+\]\]\n?\n?/, "");
  }

  /** Patch a single status or priority field, handling related side-effects (e.g. completed date). */
  async patchField(field: "status" | "priority", value: string): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (field === "priority") {
        if (value) { fm["priority"] = value; } else { delete fm["priority"]; }
      } else {
        if (value) { fm["status"] = value; } else { delete fm["status"]; }
        if (value === "done") {
          if (!fm["completed"]) fm["completed"] = new Date().toISOString();
        } else if (value !== "cancelled") {
          delete fm["completed"];
        }
      }
      touch(fm);
    });
  }

  /** Full update of all task fields and optional description body. */
  async update(data: UpdateTaskData): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);

    const rawBefore = await this.app.vault.read(file);
    const currentBody = splitFrontmatterBody(rawBefore).body.trim();

    // Preserve the auto-generated Project:/Parent: wiki-link prefix.
    const prefixMatch = currentBody.match(/^(?:Project|Parent): \[\[[^\]]+\]\]\n?\n?/);
    const wikiPrefix = prefixMatch ? prefixMatch[0] : "";
    const currentDescription = currentBody.slice(wikiPrefix.length).trim();
    const newDescription = data.description.trim();

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm["title"] = data.title;
      fm["status"] = data.status;
      if (data.priority) { fm["priority"] = data.priority; } else { delete fm["priority"]; }
      fm["type"] = data.type;
      if (data.start) { fm["start"] = data.start; } else { delete fm["start"]; }
      if (data.due) { fm["due"] = data.due; } else { delete fm["due"]; }
      if (data.progress > 0) { fm["progress"] = data.progress; } else { delete fm["progress"]; }
      fm["dependencies"] = data.dependencies;
      if (data.tags.length > 0) { fm["tags"] = data.tags; } else { delete fm["tags"]; }
      touch(fm);
    });

    if (currentDescription !== newDescription) {
      const rawAfter = await this.app.vault.read(file);
      const { frontmatterBlock } = splitFrontmatterBody(rawAfter);
      if (frontmatterBlock) {
        const fullBody = newDescription ? wikiPrefix + newDescription + "\n" : wikiPrefix || "";
        const body = fullBody ? "\n" + fullBody : "";
        await this.app.vault.modify(file, frontmatterBlock + body);
      }
    }
  }

  /** Idempotently add depId to this task's dependency list. */
  async addDependency(depId: string): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const current: string[] = Array.isArray(fm["dependencies"]) ? fm["dependencies"] : [];
      fm["dependencies"] = addDependencyToTask(current, depId);
      touch(fm);
    });
  }

  /** Idempotently remove depId from this task's dependency list. */
  async removeDependency(depId: string): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const current: string[] = Array.isArray(fm["dependencies"]) ? fm["dependencies"] : [];
      fm["dependencies"] = removeDependencyFromTask(current, depId);
      touch(fm);
    });
  }

  /**
   * Delete this task file. Recursively deletes subtasks first, removes this task
   * from any dependent tasks' dependency lists, and unlinks it from its parent.
   */
  async delete(taskId: string, allTasks: Task[] = [], parentTask?: Task): Promise<void> {
    for (const child of allTasks.filter((t) => t.parentId === taskId)) {
      await new ProjectTaskFile(this.app, child.filePath).delete(child.id, allTasks);
    }

    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.trashFile(file);

    const dependents = allTasks.filter(
      (t) => t.id !== taskId && Array.isArray(t.dependencies) && t.dependencies.includes(taskId),
    );
    for (const dependent of dependents) {
      const depFile = resolveFile(this.app, dependent.filePath);
      if (depFile) {
        await this.app.fileManager.processFrontMatter(depFile, (fm: Record<string, unknown>) => {
          const current: string[] = Array.isArray(fm["dependencies"]) ? fm["dependencies"] : [];
          fm["dependencies"] = removeDependencyFromTask(current, taskId);
          touch(fm);
        });
      }
    }

    if (parentTask) {
      const taskBasename = basenameOf(this.filePath);
      await new ProjectTaskFile(this.app, parentTask.filePath).removeSubtaskLink(taskId, taskBasename);
    }
  }

  /** Register a newly-created subtask inside this file (updates subtaskIds + body). */
  async addSubtaskLink(subtaskId: string, subtaskTitle: string, subtaskBasename: string): Promise<void> {
    const file = this.tfile;
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const current: string[] = Array.isArray(fm["subtaskIds"]) ? fm["subtaskIds"] : [];
      fm["subtaskIds"] = [...current, subtaskId];
      touch(fm);
    });

    const raw = await this.app.vault.read(file);
    const { frontmatterBlock, body } = splitFrontmatterBody(raw);
    if (!frontmatterBlock) return;

    const newItem = `- [ ] [[${subtaskBasename}|${subtaskTitle}]]`;
    let newBody: string;
    if (body.includes("## Subtasks")) {
      const sectionIdx = body.indexOf("## Subtasks");
      const afterHeader = body.slice(sectionIdx + "## Subtasks".length);
      const nextSectionOffset = afterHeader.search(/\n## /);
      if (nextSectionOffset !== -1) {
        const insertAt = sectionIdx + "## Subtasks".length + nextSectionOffset;
        const before = body.slice(0, insertAt).trimEnd();
        const after = body.slice(insertAt).trimStart();
        newBody = before + "\n" + newItem + "\n\n" + after;
      } else {
        newBody = body.trimEnd() + "\n" + newItem + "\n";
      }
    } else {
      const trimmed = body.trimEnd();
      newBody = (trimmed ? trimmed + "\n\n" : "") + "## Subtasks\n" + newItem + "\n";
    }

    await this.app.vault.modify(file, frontmatterBlock + newBody);
  }

  /** Remove a subtask wiki-link from this file (updates subtaskIds + body). */
  async removeSubtaskLink(subtaskId: string, subtaskBasename: string): Promise<void> {
    const file = this.tfile;
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const current: string[] = Array.isArray(fm["subtaskIds"]) ? fm["subtaskIds"] : [];
      fm["subtaskIds"] = current.filter((id) => id !== subtaskId);
      touch(fm);
    });

    const raw = await this.app.vault.read(file);
    const { frontmatterBlock, body } = splitFrontmatterBody(raw);
    if (!frontmatterBlock) return;

    const escaped = subtaskBasename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let newBody = body.replace(new RegExp(`\\n?- \\[ \\] \\[\\[${escaped}\\|[^\\]]+\\]\\]`, "g"), "");

    if (newBody !== body) {
      newBody = newBody.replace(/\n?## Subtasks\n(?=\n|$)/, "").replace(/\n{3,}/g, "\n\n");
      await this.app.vault.modify(file, frontmatterBlock + newBody);
    }
  }

  /**
   * Create a new task file in the project's tasks folder.
   * Returns the generated task ID and a ProjectTaskFile pointing to the new file.
   */
  static async create(
    app: App,
    opts: CreateTaskOpts,
  ): Promise<{ id: string; file: ProjectTaskFile }> {
    const tasksFolder = opts.projectFilePath.replace(/\.md$/, "_tasks");
    try {
      await app.vault.createFolder(normalizePath(tasksFolder));
    } catch {
      // folder already exists
    }

    const slug = slugify(opts.title) || "task";
    let filename = normalizePath(`${tasksFolder}/${slug}.md`);
    let counter = 2;
    while (app.vault.getAbstractFileByPath(filename)) {
      filename = normalizePath(`${tasksFolder}/${slug}-${counter}.md`);
      counter++;
    }

    const id = generateId();
    const now = new Date().toISOString();
    const lines = buildFrontmatter({
      id,
      projectId: opts.projectId,
      parentId: opts.parentTask?.id,
      title: opts.title,
      status: opts.status,
      priority: opts.priority,
      type: opts.type,
      start: opts.start,
      due: opts.due,
      progress: opts.progress,
      dependencies: opts.dependencies,
      tags: opts.tags,
      createdAt: now,
      updatedAt: now,
    });

    const fileBasename = basenameOf(filename);
    const bodyPrefix = opts.parentTask
      ? `Parent: [[${basenameOf(opts.parentTask.filePath)}|${opts.parentTask.title}]]`
      : `Project: [[${basenameOf(opts.projectFilePath)}|${opts.projectTitle}]]`;
    const description = opts.description.trim();
    const fullBody = description ? `${bodyPrefix}\n\n${description}` : bodyPrefix;
    lines.push("", fullBody);

    await app.vault.create(filename, lines.join("\n") + "\n");

    const taskFile = new ProjectTaskFile(app, filename);
    if (opts.parentTask) {
      await new ProjectTaskFile(app, opts.parentTask.filePath).addSubtaskLink(id, opts.title, fileBasename);
    }

    return { id, file: taskFile };
  }
}
