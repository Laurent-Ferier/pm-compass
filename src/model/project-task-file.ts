import { App, normalizePath } from "obsidian";
import { formatDate, formatTimestamp } from "./dates";
import { addDependencyToTask, removeDependencyFromTask } from "./shared";
import type { Task } from "./shared";
import type { Priority } from "./task-vocabulary";
import {
  BODY_PREFIX_RE,
  basenameOf,
  ensureFolderRecursive,
  generateId,
  resolveFile,
  slugify,
  splitFrontmatterBody,
  stringArray,
  touch,
  uniquePathIn,
} from "./file-helpers";
import { SUBTASK_SECTION, addChildLink, removeChildLink } from "./child-links";

/**
 * Drop taskId from the dependency list of every task that references it.
 * Tasks whose ID is in `skip` are left alone — used when a whole subtree moves
 * together and its internal dependencies stay valid.
 */
export async function pruneDependents(
  app: App,
  taskId: string,
  allTasks: Task[],
  skip?: Set<string>,
): Promise<void> {
  const dependents = allTasks.filter(
    (t) => t.id !== taskId && !skip?.has(t.id) && Array.isArray(t.dependencies) && t.dependencies.includes(taskId),
  );
  for (const dependent of dependents) {
    const depFile = resolveFile(app, dependent.filePath);
    if (!depFile) continue;
    await app.fileManager.processFrontMatter(depFile, (fm: Record<string, unknown>) => {
      const current: string[] = stringArray(fm["dependencies"]);
      fm["dependencies"] = removeDependencyFromTask(current, taskId);
      touch(fm);
    });
  }
}

/**
 * Every task in a project lives directly in this one folder, whatever its depth
 * — nesting is expressed by `parentId` alone. So a reparent within a project
 * moves no files; only a change of project relocates anything.
 */
export function tasksFolderFor(projectFilePath: string): string {
  return normalizePath(projectFilePath.replace(/\.md$/, "_tasks"));
}

function buildFrontmatter(fields: {
  id: string;
  projectId: string;
  parentId?: string;
  title: string;
  status: string;
  priority: Priority;
  type: string;
  start: Date | null;
  due: Date | null;
  progress: number;
  dependencies: string[];
  tags: string[];
  /** The instant the file records, written as the ISO timestamp obsidian-pm expects. */
  createdAt: Date;
  updatedAt: Date;
}): string[] {
  const lines = ["---", "pm-task: true", `id: "${fields.id}"`, `title: "${fields.title.replace(/"/g, '\\"')}"`];
  lines.push(`projectId: "${fields.projectId}"`);
  if (fields.parentId) lines.push(`parentId: "${fields.parentId}"`);
  lines.push(`status: ${fields.status}`);
  if (fields.priority) lines.push(`priority: ${fields.priority}`);
  lines.push(`type: ${fields.type}`);
  if (fields.start) lines.push(`start: "${formatDate(fields.start)}"`);
  if (fields.due) lines.push(`due: "${formatDate(fields.due)}"`);
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
  lines.push(`createdAt: "${formatTimestamp(fields.createdAt)}"`);
  lines.push(`updatedAt: "${formatTimestamp(fields.updatedAt)}"`);
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
  priority: Priority;
  type: string;
  progress: number;
  start: Date | null;
  due: Date | null;
  tags: string[];
  dependencies: string[];
}

export interface UpdateTaskData {
  title: string;
  description: string;
  status: string;
  priority: Priority;
  type: string;
  progress: number;
  start: Date | null;
  due: Date | null;
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
    return body.trim().replace(BODY_PREFIX_RE, "");
  }

  /**
   * Replace the auto-generated `Project:`/`Parent:` wiki-link opening the body,
   * inserting one when absent. Leaves the description untouched.
   */
  async setBodyPrefix(prefix: string): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    const raw = await this.app.vault.read(file);
    const { frontmatterBlock, body } = splitFrontmatterBody(raw);
    if (!frontmatterBlock) return;
    const description = body.trim().replace(BODY_PREFIX_RE, "").trim();
    const fullBody = description ? `${prefix}\n\n${description}\n` : `${prefix}\n`;
    await this.app.vault.modify(file, frontmatterBlock + "\n" + fullBody);
  }

  /**
   * Patch a single field, handling related side-effects (e.g. the completed date).
   *
   * An empty `value` clears the field, except for `title`, which a task can't be without —
   * the callers that edit one in place refuse an empty input rather than clearing it here.
   */
  async patchField(field: "status" | "priority" | "title", value: string): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (field === "priority") {
        if (value) { fm[field] = value; } else { delete fm[field]; }
      } else if (field === "title") {
        if (value) fm["title"] = value;
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

  /** Sets the deadline, or — `null` — clears it. Its own method rather than a
   *  `patchField` case: every other field is text, this one is a day. */
  async patchDue(due: Date | null): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (due) { fm["due"] = formatDate(due); } else { delete fm["due"]; }
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
    const prefixMatch = currentBody.match(BODY_PREFIX_RE);
    const wikiPrefix = prefixMatch ? prefixMatch[0] : "";
    const currentDescription = currentBody.slice(wikiPrefix.length).trim();
    const newDescription = data.description.trim();

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm["title"] = data.title;
      fm["status"] = data.status;
      if (data.priority) { fm["priority"] = data.priority; } else { delete fm["priority"]; }
      fm["type"] = data.type;
      if (data.start) { fm["start"] = formatDate(data.start); } else { delete fm["start"]; }
      if (data.due) { fm["due"] = formatDate(data.due); } else { delete fm["due"]; }
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
      const current: string[] = stringArray(fm["dependencies"]);
      fm["dependencies"] = addDependencyToTask(current, depId);
      touch(fm);
    });
  }

  /** Idempotently remove depId from this task's dependency list. */
  async removeDependency(depId: string): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const current: string[] = stringArray(fm["dependencies"]);
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

    await pruneDependents(this.app, taskId, allTasks);

    if (parentTask) {
      const taskBasename = basenameOf(this.filePath);
      await new ProjectTaskFile(this.app, parentTask.filePath).removeSubtaskLink(taskId, taskBasename);
    }
  }

  /** Register a newly-created subtask inside this file (updates subtaskIds + body). */
  async addSubtaskLink(subtaskId: string, subtaskTitle: string, subtaskBasename: string): Promise<void> {
    await addChildLink(this.app, this.filePath, SUBTASK_SECTION, subtaskId, subtaskTitle, subtaskBasename);
  }

  /** Remove a subtask wiki-link from this file (updates subtaskIds + body). */
  async removeSubtaskLink(subtaskId: string, subtaskBasename: string): Promise<void> {
    await removeChildLink(this.app, this.filePath, SUBTASK_SECTION, subtaskId, subtaskBasename);
  }

  /**
   * Create a new task file in the project's tasks folder.
   * Returns the generated task ID and a ProjectTaskFile pointing to the new file.
   */
  static async create(
    app: App,
    opts: CreateTaskOpts,
  ): Promise<{ id: string; file: ProjectTaskFile }> {
    const tasksFolder = tasksFolderFor(opts.projectFilePath);
    await ensureFolderRecursive(app, tasksFolder);

    const filename = uniquePathIn(app, tasksFolder, slugify(opts.title) || "task");

    const id = generateId();
    const now = new Date();
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
