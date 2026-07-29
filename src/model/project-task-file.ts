import { App, normalizePath } from "obsidian";
import { dayAsTimestamp, formatDate, formatTimestamp } from "./dates";
import { addDependencyToTask, removeDependencyFromTask } from "./shared";
import type { Task } from "./shared";
import type { Priority } from "./task-vocabulary";
import {
  BODY_PREFIX_RE,
  basenameOf,
  ensureFolderRecursive,
  generateId,
  parentDirOf,
  resolveFile,
  slugify,
  splitFrontmatterBody,
  stringArray,
  touch,
  uniquePathIn,
} from "./operations/file-helpers";
import type { ChildLinkSection } from "./operations/child-links";
import { PROJECT_TASK_SECTION, SUBTASK_SECTION, updateChildLink } from "./operations/child-links";
// Mutual, but each side only reaches for the other inside a method body: the
// `extends` above resolves through base-note, which imports neither at runtime.
import { ProjectFile } from "./project-file";
import { BaseNote } from "./base-note";
import { Status, toStatus } from "./task-vocabulary";

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

/** The checklist line a task is listed on: which note holds it, under which section. */
interface ParentLink {
  filePath: string;
  section: ChildLinkSection;
}

/** `tasksFolderFor` read backwards. Null for a task outside that layout. */
function projectFileForTask(taskFilePath: string): string | null {
  const folder = parentDirOf(taskFilePath);
  return folder.endsWith("_tasks") ? normalizePath(folder.replace(/_tasks$/, ".md")) : null;
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
  /** The day the task was closed, for one created already done. */
  completed: Date | null;
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
  // The instant `patchField` writes, at the closing day's UTC midnight: a day is all
  // a promoted checklist line knows.
  if (fields.completed) lines.push(`completed: "${dayAsTimestamp(fields.completed)}"`);
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

/**
 * Set the status, and the `completed` timestamp that follows from it: closing stamps
 * one, reopening clears it. A cancel keeps whatever is already there — see
 * `Status.Done`. An empty `value` clears the status altogether.
 */
function writeStatus(fm: Record<string, unknown>, value: string): void {
  if (value) { fm["status"] = value; } else { delete fm["status"]; }
  if (toStatus(value) === Status.Done) {
    if (!fm["completed"]) fm["completed"] = new Date().toISOString();
  } else if (toStatus(value) !== Status.Cancelled) {
    delete fm["completed"];
  }
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
  /** Only for a task created already closed — see `buildFrontmatter`. */
  completed?: Date | null;
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
 * multi-task daily notes. A task lists its subtasks the way a project lists its
 * root tasks, which is what it inherits from `BaseNote`.
 */
export class ProjectTaskFile extends BaseNote {
  protected get childSection() {
    return SUBTASK_SECTION;
  }

  /** Every task of a project shares one folder, so a subtask is a sibling. */
  protected get childFolder() {
    return parentDirOf(this.filePath);
  }

  protected childNote(filePath: string): ProjectTaskFile {
    return new ProjectTaskFile(this.app, filePath);
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
   * The auto-generated `Project:`/`Parent:` wiki-link opening the body, without its
   * trailing blank line. Empty when the body has none — a hand-made task note.
   * `setBodyPrefix` writes unconditionally, so callers compare against this first.
   */
  async readBodyPrefix(): Promise<string> {
    const file = this.tfile;
    if (!file) return "";
    const { body } = splitFrontmatterBody(await this.app.vault.cachedRead(file));
    return (BODY_PREFIX_RE.exec(body.trim())?.[0] ?? "").trim();
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
        writeStatus(fm, value);
      }
      touch(fm);
    });
    // Pushed here as well as from the change event: the listing then moves with the
    // edit, and still moves when the dashboard is closed and nobody is listening.
    if (field === "status") await this.syncParentListing({ checked: toStatus(value) === Status.Done });
    if (field === "title" && value) await this.syncParentListing({ title: value });
  }

  /** Whether this task counts as finished. Null when the file isn't a task note. */
  isDone(): boolean | null {
    const file = this.tfile;
    if (!file) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return fm?.["pm-task"] === true ? toStatus(fm["status"]) === Status.Done : null;
  }

  /**
   * Close or reopen this task to match a box flipped by hand in its parent. The cache
   * says whether there is anything to do, the file says what to write: the parent's
   * event can outrun this note's own reparse.
   */
  async applyParentBox(checked: boolean): Promise<void> {
    const file = this.tfile;
    if (!file) return;
    const done = this.isDone();
    if (done === null || done === checked) return;
    // `processFrontMatter` rewrites the note whatever its callback decides, and every
    // rewrite wakes this sync from the other side — so confirm against the file first.
    const onDisk = await this.statusOnDisk();
    if (onDisk !== null && checked === (toStatus(onDisk) === Status.Done)) return;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (fm["pm-task"] !== true) return;
      if (checked === (toStatus(fm["status"]) === Status.Done)) return;
      writeStatus(fm, checked ? Status.Done : Status.Todo);
      touch(fm);
    });
  }

  /**
   * The `status` the file itself carries, ahead of the metadata cache. Null when it
   * can't be read off — which only ever costs a skippable write, never a wrong one.
   */
  private async statusOnDisk(): Promise<string | null> {
    const file = this.tfile;
    if (!file) return null;
    const { frontmatterBlock } = splitFrontmatterBody(await this.app.vault.cachedRead(file));
    return /^status:[ \t]*"?([\w-]+)/m.exec(frontmatterBlock ?? "")?.[1] ?? null;
  }

  /**
   * Where this task's own checklist line sits: `## Subtasks` in its parent task, or
   * `## Tasks` in its project, named by the wiki-link the body opens with. Null when
   * that prefix or the `_tasks` folder is missing — a hand-made file, not a guess.
   */
  private parentLink(body: string): ParentLink | null {
    const match = BODY_PREFIX_RE.exec(body.trim());
    if (!match) return null;

    if (match[1] === "Parent") {
      // A subtask's parent is a sibling in the shared `_tasks` folder.
      const path = normalizePath(`${parentDirOf(this.filePath)}/${match[2]}.md`);
      return { filePath: path, section: SUBTASK_SECTION };
    }
    const projectFilePath = projectFileForTask(this.filePath);
    return projectFilePath ? { filePath: projectFilePath, section: PROJECT_TASK_SECTION } : null;
  }

  /**
   * Mirror this task's title and status onto the checklist line that lists it — the
   * other direction of `applyParentBox`, and what catches a status changed outside the
   * plugin before a stale box answers it. `body` is the change event's own content.
   */
  async pushToListing(body?: string): Promise<void> {
    const file = this.tfile;
    if (!file) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.["pm-task"] !== true) return;
    await this.syncParentListing(
      { title: String(fm["title"] ?? file.basename), checked: toStatus(fm["status"]) === Status.Done },
      body === undefined ? undefined : splitFrontmatterBody(body).body,
    );
  }

  /**
   * Mirror this task onto its checklist line in the parent: the title it is listed
   * under, whether its box is ticked, or both. Only `done` ticks the box — a cancelled
   * task is closed, but it was never finished.
   */
  private async syncParentListing(
    changes: { title?: string; checked?: boolean }, body?: string,
  ): Promise<void> {
    const file = this.tfile;
    if (!file) return;
    const text = body ?? splitFrontmatterBody(await this.app.vault.read(file)).body;
    const link = this.parentLink(text);
    if (!link) return;
    await updateChildLink(this.app, link.filePath, link.section, basenameOf(this.filePath), changes);
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
      writeStatus(fm, data.status);
      if (data.priority) { fm["priority"] = data.priority; } else { delete fm["priority"]; }
      fm["type"] = data.type;
      if (data.start) { fm["start"] = formatDate(data.start); } else { delete fm["start"]; }
      if (data.due) { fm["due"] = formatDate(data.due); } else { delete fm["due"]; }
      if (data.progress > 0) { fm["progress"] = data.progress; } else { delete fm["progress"]; }
      fm["dependencies"] = data.dependencies;
      if (data.tags.length > 0) { fm["tags"] = data.tags; } else { delete fm["tags"]; }
      touch(fm);
    });

    await this.syncParentListing(
      { title: data.title, checked: toStatus(data.status) === Status.Done }, currentBody,
    );

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
   * from any dependent tasks' dependency lists, and unlinks it from whatever lists
   * it — the parent `parentTask` names, or else the note its body links back to.
   */
  async delete(taskId: string, allTasks: Task[] = [], parentTask?: Task): Promise<void> {
    // Read while the file is still there to say so, and only when the caller hasn't
    // already named the parent.
    const link = parentTask ? null : await this.readParentLink();
    await this.trashWithSubtasks(taskId, allTasks);

    const lister = parentTask
      ? new ProjectTaskFile(this.app, parentTask.filePath)
      : this.listedIn(link);
    await lister?.removeChild(taskId, basenameOf(this.filePath));
  }

  /** Where this task's own checklist line sits, off the file. Null when it has none. */
  private async readParentLink(): Promise<ParentLink | null> {
    const file = this.tfile;
    if (!file) return null;
    return this.parentLink(splitFrontmatterBody(await this.app.vault.read(file)).body);
  }

  /**
   * Trash this task and everything under it, leaving every listing intact: a subtask's
   * sits in a parent being trashed alongside it. Only the outermost task has a lister
   * that survives, and unlinking that one is `delete`'s job.
   */
  private async trashWithSubtasks(taskId: string, allTasks: Task[]): Promise<void> {
    for (const child of allTasks.filter((t) => t.parentId === taskId)) {
      await new ProjectTaskFile(this.app, child.filePath).trashWithSubtasks(child.id, allTasks);
    }

    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.trashFile(file);

    await pruneDependents(this.app, taskId, allTasks);
  }

  /** The note holding that checklist line: a project for `## Tasks`, a task for `## Subtasks`. */
  private listedIn(link: ParentLink | null): BaseNote | null {
    if (!link) return null;
    return link.section === PROJECT_TASK_SECTION
      ? new ProjectFile(this.app, link.filePath)
      : new ProjectTaskFile(this.app, link.filePath);
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
      completed: opts.completed ?? null,
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

    // List the new task in whatever holds it: its parent task, or the project itself.
    const parent: BaseNote = opts.parentTask
      ? new ProjectTaskFile(app, opts.parentTask.filePath)
      : new ProjectFile(app, opts.projectFilePath);
    // The box is passed in: the file was written moments ago, so `addChild` has no
    // metadata cache to read the status from.
    await parent.addChild(id, opts.title, fileBasename, toStatus(opts.status) === Status.Done);

    return { id, file: new ProjectTaskFile(app, filename) };
  }
}
