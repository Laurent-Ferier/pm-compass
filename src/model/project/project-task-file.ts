import { App, normalizePath } from "obsidian";
import { dayAsTimestamp, formatDate, formatTimestamp } from "../dates";
import { addDependencyToTask, removeDependencyFromTask } from "./task";
import type { Task } from "./task";
import type { Priority } from "../base-task";
import {
  BODY_PREFIX_RE,
  BodyPrefixKind,
  basenameOf,
  bodyPrefix,
  ensureFolderRecursive,
  generateId,
  parentDirOf,
  resolveFile,
  slugify,
  splitFrontmatterBody,
  stringArray,
  touch,
  uniquePathIn,
} from "../operations/file-helpers";
import type { ChildLinkSection } from "./child-links";
import { PROJECT_TASK_SECTION, SUBTASK_SECTION, updateChildLink } from "./child-links";
// Mutual, but each side only reaches for the other inside a method body.
import { ProjectFile } from "./project-file";
import { BaseNote } from "./base-note";
import { Status, toStatus } from "../base-task";
import { Frontmatter } from "./frontmatter";

/** The task fields a row or ribbon can patch in place, without opening the editor. */
export enum PatchableField {
  Status = Frontmatter.Status,
  Priority = Frontmatter.Priority,
  Title = Frontmatter.Title,
}

/** Drops taskId from every task that depends on it. Those in `skip` are left alone, for
 *  a subtree moving whole, whose internal dependencies stay valid. */
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
    // Skipped rather than thrown on, unlike `removeDependency`'s own callers: a vault the
    // reader has since fallen behind is this pass's normal case.
    if (!resolveFile(app, dependent.filePath)) continue;
    await new ProjectTaskFile(app, dependent.filePath).removeDependency(taskId);
  }
}

/** The `Project:`/`Parent:` wiki-link opening a task's body, for wherever it now sits. */
export function bodyPrefixFor(
  destination: { projectFilePath: string; projectTitle: string; parentTask?: Task },
): string {
  return destination.parentTask
    ? bodyPrefix(destination.parentTask, BodyPrefixKind.Parent)
    : bodyPrefix(
      { filePath: destination.projectFilePath, title: destination.projectTitle },
      BodyPrefixKind.Project,
    );
}

/** Every task of a project lives in this one folder whatever its depth, nesting being
 *  `parentId`'s business — so only a change of project moves a file. */
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
  // At the closing day's UTC midnight: a day is all a promoted checklist line knows.
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

/** Sets the status and the `completed` timestamp following from it: closing stamps one,
 *  reopening clears it, a cancel keeps what is there. An empty `value` clears both. */
function writeStatus(fm: Record<string, unknown>, value: string): void {
  if (value) { fm[Frontmatter.Status] = value; } else { delete fm[Frontmatter.Status]; }
  if (toStatus(value) === Status.Done) {
    if (!fm[Frontmatter.Completed]) fm[Frontmatter.Completed] = new Date().toISOString();
  } else if (toStatus(value) !== Status.Cancelled) {
    delete fm[Frontmatter.Completed];
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

/** One project task's markdown file, with typed operations on its frontmatter and body.
 *  A task lists its subtasks as a project lists its root tasks — hence `BaseNote`. */
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

  /** The direct subtask IDs from `subtaskIds`; empty when the file or field is absent. */
  async readSubtaskIds(): Promise<string[]> {
    const file = this.tfile;
    if (!file) return [];
    const cache = this.app.metadataCache.getFileCache(file);
    const ids: unknown = cache?.frontmatter?.[Frontmatter.SubtaskIds];
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

  /** The `Project:`/`Parent:` wiki-link opening the body, empty for a hand-made note.
   *  `setBodyPrefix` writes unconditionally, so callers compare against this first. */
  async readBodyPrefix(): Promise<string> {
    const file = this.tfile;
    if (!file) return "";
    const { body } = splitFrontmatterBody(await this.app.vault.cachedRead(file));
    return (BODY_PREFIX_RE.exec(body.trim())?.[0] ?? "").trim();
  }

  /** Replaces the wiki-link opening the body, inserting one when absent. Leaves the
   *  description untouched. */
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

  /** Rewrites this task's frontmatter and stamps `updatedAt`. Throws when the file is
   *  gone: every caller here was handed the path by something that had just read it. */
  private async editFrontmatter(mutate: (fm: Record<string, unknown>) => void): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      mutate(fm);
      touch(fm);
    });
  }

  /** Patches one field and its side-effects. An empty `value` clears it, except for
   *  `title`, which a task can't be without. */
  async patchField(field: PatchableField, value: string): Promise<void> {
    await this.editFrontmatter((fm) => {
      if (field === PatchableField.Priority) {
        if (value) { fm[field] = value; } else { delete fm[field]; }
      } else if (field === PatchableField.Title) {
        if (value) fm[Frontmatter.Title] = value;
      } else {
        writeStatus(fm, value);
      }
    });
    // Pushed here as well as from the change event, so the listing moves with the edit
    // even when no view is open to hear it.
    if (field === PatchableField.Status) await this.syncParentListing({ checked: toStatus(value) === Status.Done });
    if (field === PatchableField.Title && value) await this.syncParentListing({ title: value });
  }

  /** Whether this task counts as finished. Null when the file isn't a task note. */
  isDone(): boolean | null {
    const file = this.tfile;
    if (!file) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return fm?.[Frontmatter.IsTask] === true ? toStatus(fm[Frontmatter.Status]) === Status.Done : null;
  }

  /** True when this task reads as done but carries no `completed` timestamp — closed by a
   *  status edited outside the plugin. */
  needsCompletedStamp(): boolean {
    const file = this.tfile;
    if (!file) return false;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!fm?.[Frontmatter.IsTask]
      && fm[Frontmatter.Status] === Status.Done
      && !fm[Frontmatter.Completed];
  }

  /** Stamps `completed` with the current time. Re-checked inside the write: the cache the
   *  caller read can be a step behind another edit to the same note. */
  async stampCompleted(): Promise<void> {
    await this.editFrontmatter((fm) => {
      if (fm[Frontmatter.Status] === Status.Done && !fm[Frontmatter.Completed]) {
        fm[Frontmatter.Completed] = new Date().toISOString();
      }
    });
  }

  /** Closes or reopens this task to match a box flipped by hand in its parent, whose
   *  event can outrun this note's reparse — so the file, not the cache, decides. */
  async applyParentBox(checked: boolean): Promise<void> {
    const file = this.tfile;
    if (!file) return;
    const done = this.isDone();
    if (done === null || done === checked) return;
    // Every rewrite wakes this sync from the other side, so confirm against the file first.
    const onDisk = await this.statusOnDisk();
    if (onDisk !== null && checked === (toStatus(onDisk) === Status.Done)) return;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (fm[Frontmatter.IsTask] !== true) return;
      if (checked === (toStatus(fm[Frontmatter.Status]) === Status.Done)) return;
      writeStatus(fm, checked ? Status.Done : Status.Todo);
      touch(fm);
    });
  }

  /** The `status` the file itself carries, ahead of the cache. Null when unreadable,
   *  which costs a skippable write and never a wrong one. */
  private async statusOnDisk(): Promise<string | null> {
    const file = this.tfile;
    if (!file) return null;
    const { frontmatterBlock } = splitFrontmatterBody(await this.app.vault.cachedRead(file));
    return /^status:[ \t]*"?([\w-]+)/m.exec(frontmatterBlock)?.[1] ?? null;
  }

  /** Where this task's checklist line sits — `## Subtasks` in its parent or `## Tasks`
   *  in its project — named by the body's wiki-link. Null rather than a guess. */
  private parentLink(body: string): ParentLink | null {
    const match = BODY_PREFIX_RE.exec(body.trim());
    if (!match) return null;

    // The regex alternation is the enum's own members, so group 1 can only be one of them.
    if ((match[1] as BodyPrefixKind) === BodyPrefixKind.Parent) {
      // A subtask's parent is a sibling in the shared `_tasks` folder.
      const path = normalizePath(`${parentDirOf(this.filePath)}/${match[2]}.md`);
      return { filePath: path, section: SUBTASK_SECTION };
    }
    const projectFilePath = projectFileForTask(this.filePath);
    return projectFilePath ? { filePath: projectFilePath, section: PROJECT_TASK_SECTION } : null;
  }

  /** Mirrors this task's title and status onto the line that lists it — `applyParentBox`
   *  the other way round. `body` is the change event's own content. */
  async pushToListing(body?: string): Promise<void> {
    const file = this.tfile;
    if (!file) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.[Frontmatter.IsTask] !== true) return;
    await this.syncParentListing(
      { title: String(fm[Frontmatter.Title] ?? file.basename), checked: toStatus(fm[Frontmatter.Status]) === Status.Done },
      body === undefined ? undefined : splitFrontmatterBody(body).body,
    );
  }

  /** Mirrors this task onto its line in the parent: title, box, or both. Only `done`
   *  ticks the box — a cancelled task is closed, but was never finished. */
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
    await this.editFrontmatter((fm) => {
      if (due) { fm[Frontmatter.Due] = formatDate(due); } else { delete fm[Frontmatter.Due]; }
    });
  }

  /** Full update of all task fields and optional description body. */
  async update(data: UpdateTaskData): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    const rawBefore = await this.app.vault.read(file);
    const currentBody = splitFrontmatterBody(rawBefore).body.trim();

    // The Project:/Parent: wiki-link prefix survives the update.
    const prefixMatch = currentBody.match(BODY_PREFIX_RE);
    const wikiPrefix = prefixMatch ? prefixMatch[0] : "";
    const currentDescription = currentBody.slice(wikiPrefix.length).trim();
    const newDescription = data.description.trim();

    await this.editFrontmatter((fm) => {
      fm[Frontmatter.Title] = data.title;
      writeStatus(fm, data.status);
      if (data.priority) { fm[Frontmatter.Priority] = data.priority; } else { delete fm[Frontmatter.Priority]; }
      fm[Frontmatter.Type] = data.type;
      if (data.start) { fm[Frontmatter.Start] = formatDate(data.start); } else { delete fm[Frontmatter.Start]; }
      if (data.due) { fm[Frontmatter.Due] = formatDate(data.due); } else { delete fm[Frontmatter.Due]; }
      if (data.progress > 0) { fm[Frontmatter.Progress] = data.progress; } else { delete fm[Frontmatter.Progress]; }
      fm[Frontmatter.Dependencies] = data.dependencies;
      if (data.tags.length > 0) { fm[Frontmatter.Tags] = data.tags; } else { delete fm[Frontmatter.Tags]; }
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

  private async patchDependencies(apply: (current: string[]) => string[]): Promise<void> {
    await this.editFrontmatter((fm) => {
      fm[Frontmatter.Dependencies] = apply(stringArray(fm[Frontmatter.Dependencies]));
    });
  }

  /** Idempotently add depId to this task's dependency list. */
  async addDependency(depId: string): Promise<void> {
    await this.patchDependencies((current) => addDependencyToTask(current, depId));
  }

  /** Idempotently remove depId from this task's dependency list. */
  async removeDependency(depId: string): Promise<void> {
    await this.patchDependencies((current) => removeDependencyFromTask(current, depId));
  }

  /** Deletes this task file and its subtasks, prunes it from dependent tasks, and
   *  unlinks it from whatever lists it. */
  async delete(taskId: string, allTasks: Task[] = [], parentTask?: Task): Promise<void> {
    // Read while the file is still there to say so.
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

  /** Trashes this task and everything under it, leaving the listings alone — only the
   *  outermost task has a lister that survives, and that one is `delete`'s job. */
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

  /** Creates a task file in the project's tasks folder, returning its generated ID. */
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
    const prefix = bodyPrefixFor(opts);
    const description = opts.description.trim();
    const fullBody = description ? `${prefix}\n\n${description}` : prefix;
    lines.push("", fullBody);

    await app.vault.create(filename, lines.join("\n") + "\n");

    // Listed in whatever holds it: its parent task, or the project itself.
    const parent: BaseNote = opts.parentTask
      ? new ProjectTaskFile(app, opts.parentTask.filePath)
      : new ProjectFile(app, opts.projectFilePath);
    // The box is passed in: the file is too new for `addChild` to read its status
    // from the metadata cache.
    await parent.addChild(id, opts.title, fileBasename, toStatus(opts.status) === Status.Done);

    return { id, file: new ProjectTaskFile(app, filename) };
  }
}
