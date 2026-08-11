import { FrontMatterCache, TFile, normalizePath } from "obsidian";
import { dayAsTimestamp, formatDate, formatTimestamp } from "../dates";
import { addDependencyToTask, removeDependencyFromTask, toTaskType, type ProjectTask, type ProjectTaskFields } from "../project/project-task";
import type { Priority } from "../base-task";
import {
  basenameOf,
  ensureFolderRecursive,
  generateId,
  parentDirOf,
  resolveFile,
  uniquePathIn,
} from "../file-helpers";
import type { ChildLinkSection } from "../project/child-links";
import { PROJECT_TASK_SECTION, SUBTASK_SECTION } from "../project/child-links";
import { type FieldEdit, type NoteCache } from "./base-io";
import { ListingIO } from "./listing-io";
import type { VaultData } from "../service/vault-data";
import type { CacheKey } from "../cache/folder-cache";
import { Status, toPriority, toStatus } from "../base-task";
import {
  Frontmatter, asFrontmatterRecord, frontmatterDay, frontmatterTimestamp, splitFrontmatterBody,
  stringArray, touch,
} from "../project/frontmatter";
import { toCardLayout } from "../project/card-layout";

/** Drops taskId from every task that depends on it. Those in `skip` are left alone, for
 *  a subtree moving whole, whose internal dependencies stay valid. */
export async function pruneDependents(
  vault: VaultData,
  taskId: string,
  allTasks: ProjectTask[],
  skip?: Set<string>,
): Promise<void> {
  const dependents = allTasks.filter(
    (t) => t.id !== taskId && !skip?.has(t.id) && Array.isArray(t.dependencies) && t.dependencies.includes(taskId),
  );
  for (const dependent of dependents) {
    // Skipped rather than thrown on, unlike `removeDependency`'s own callers: a vault the
    // reader has since fallen behind is this pass's normal case.
    if (!resolveFile(vault.app, dependent.filePath)) continue;
    await vault.projects.taskCache.file(dependent.filePath).removeDependency(taskId);
  }
}

/** What a task body's opening wiki-link points at: the note that lists the task. */
export enum BodyPrefixKind {
  Project = "Project",
  Parent = "Parent",
}

/** The `Project: [[…]]` / `Parent: [[…]]` wiki-link opening a task body, with any
 *  trailing blank line. Group 1 is the kind, group 2 the linked basename. */
export const BODY_PREFIX_RE = new RegExp(
  `^(${BodyPrefixKind.Project}|${BodyPrefixKind.Parent}): \\[\\[([^\\]|]+)(?:\\|[^\\]]*)?\\]\\]\n?\n?`,
);

/** That same prefix written out, pointing at the note that lists the task: a parent task
 *  or the project itself. The one writer of what `BODY_PREFIX_RE` reads. */
export function bodyPrefix(
  listedIn: { filePath: string; title: string },
  kind: BodyPrefixKind,
): string {
  return `${kind}: [[${basenameOf(listedIn.filePath)}|${listedIn.title}]]`;
}

/** Narrows an unknown frontmatter value to a string, falling back when it is anything else. */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** The `Project:`/`Parent:` wiki-link opening a task's body, for wherever it now sits. */
export function bodyPrefixFor(
  destination: { projectFilePath: string; projectTitle: string; parentTask?: ProjectTask },
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

/** A note others are listed on, whichever kind it is: a project's `## Tasks`, a task's
 *  `## Subtasks`. */
type ChildLister = Pick<ProjectTaskIO, "addChild" | "removeChild" | "updateChild" | "listsChild">;

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

/** A new note's frontmatter, from the reading it is to have. Every optional field is read
 *  for truth, so one left unsaid is one the file doesn't carry. */
function buildFrontmatter(fields: ProjectTaskFields): string[] {
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
  if (fields.progress) lines.push(`progress: ${fields.progress}`);
  if (fields.dependencies.length > 0) {
    lines.push(`dependencies: [${fields.dependencies.map((d) => `"${d}"`).join(", ")}]`);
  } else {
    lines.push("dependencies: []");
  }
  lines.push("subtaskIds: []");
  if (fields.tags?.length) {
    lines.push(`tags: [${fields.tags.map((t) => `"${t}"`).join(", ")}]`);
  }
  if (fields.createdAt) lines.push(`createdAt: "${formatTimestamp(fields.createdAt)}"`);
  if (fields.updatedAt) lines.push(`updatedAt: "${formatTimestamp(fields.updatedAt)}"`);
  lines.push("---");
  return lines;
}

/** A frontmatter key set, or dropped when the field says nothing: an empty value is a
 *  field the file shouldn't carry rather than one it carries empty. */
export function setOrClear(fm: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") { delete fm[key]; } else { fm[key] = value; }
}

/** One settable field onto the frontmatter, spelled as the file spells it. */
function writeTaskField(fm: Record<string, unknown>, field: keyof ProjectTaskFields, value: unknown): void {
  switch (field) {
    // A task can't be without one, so an empty title is no title to write.
    case "title": if (value) fm[Frontmatter.Title] = value; break;
    case "status": writeStatus(fm, typeof value === "string" ? value : ""); break;
    case "priority": setOrClear(fm, Frontmatter.Priority, value); break;
    case "type": setOrClear(fm, Frontmatter.Type, value); break;
    case "start": setOrClear(fm, Frontmatter.Start, value instanceof Date ? formatDate(value) : undefined); break;
    case "due": setOrClear(fm, Frontmatter.Due, value instanceof Date ? formatDate(value) : undefined); break;
    case "progress":
      setOrClear(fm, Frontmatter.Progress, typeof value === "number" && value > 0 ? value : undefined);
      break;
    case "dependencies": fm[Frontmatter.Dependencies] = value ?? []; break;
    case "tags": setOrClear(fm, Frontmatter.Tags, Array.isArray(value) && value.length > 0 ? value : undefined); break;
    // `id`, `projectId`, `parentId` and the stamps are nobody's to set: a task's place is
    // `moveTask`'s, and the rest the file's own.
    default: throw new Error(`Not a task's to set: ${String(field)}`);
  }
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

export interface CreateTaskOpts extends UpdateTaskData {
  projectId: string;
  projectFilePath: string;
  projectTitle: string;
  parentTask?: ProjectTask;
  /** Only for a task created already closed — see `buildFrontmatter`. */
  completed?: Date | null;
}

/** Everything an update carries that is a field of the note, in the order it is written —
 *  the body beside them is no field, and goes on the note's text. Each name has to be both
 *  the dialog's and the task's, so a field renamed on either side stops compiling here
 *  rather than quietly going unwritten. */
const UPDATE_FIELDS = [
  "title", "status", "priority", "type", "start", "due", "progress", "dependencies", "tags",
] as const satisfies readonly (keyof UpdateTaskData & keyof ProjectTaskFields)[];

/**
 * The file behind one project task note, with typed operations on its frontmatter and body.
 * A task lists its subtasks as a project lists its root tasks — hence `ListingIO`.
 *
 * Made by `ProjectTaskCache` alone: its constructor takes the key only a cache holds,
 * and `vault.projects.taskCache.file(path)` is how everything else gets one.
 */
export class ProjectTaskIO extends ListingIO<ProjectTaskFields> {
  constructor(_key: CacheKey, cache: NoteCache, vault: VaultData, filePath: string) {
    super(cache, vault, filePath);
  }

  protected get childSection() {
    return SUBTASK_SECTION;
  }

  /** Every task of a project shares one folder, so a subtask is a sibling. */
  protected get childFolder() {
    return parentDirOf(this.filePath);
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
    // `process` rather than read-then-modify: the description is taken from the text being
    // replaced, so an edit landing in between is kept rather than written back over.
    await this.app.vault.process(file, (current) => {
      const { frontmatterBlock, body } = splitFrontmatterBody(current);
      if (!frontmatterBlock) return current;
      const description = body.trim().replace(BODY_PREFIX_RE, "").trim();
      const fullBody = description ? `${prefix}\n\n${description}\n` : `${prefix}\n`;
      return frontmatterBlock + "\n" + fullBody;
    });
  }

  /**
   * The fields set on this task, onto its file in one pass — and onto the line that lists
   * it, which carries a copy of the title and the box.
   */
  protected async writeOwed(owed: readonly FieldEdit<ProjectTaskFields>[]): Promise<void> {
    await this.editFrontmatter((fm) => {
      for (const { field, value } of owed) writeTaskField(fm, field, value);
    });
    // Pushed from here as well as from the change event, so the listing moves with the edit
    // even when no view is open to hear it.
    const listing: { title?: string; checked?: boolean } = {};
    const title = owed.find((e) => e.field === "title")?.value;
    if (typeof title === "string") listing.title = title;
    const status = owed.find((e) => e.field === "status");
    if (status) listing.checked = toStatus(status.value) === Status.Done;
    if (listing.title !== undefined || listing.checked !== undefined) await this.syncParentListing(listing);
  }

  /** Whether this task counts as finished. Null when the file isn't a task note. */
  isDone(): boolean | null {
    const file = this.tfile;
    if (!file) return null;
    const fm = asFrontmatterRecord(this.app.metadataCache.getFileCache(file)?.frontmatter);
    return fm?.[Frontmatter.IsTask] === true ? toStatus(fm[Frontmatter.Status]) === Status.Done : null;
  }

  /** True when this task reads as done but carries no `completed` timestamp — closed by a
   *  status edited outside the plugin. */
  needsCompletedStamp(): boolean {
    const file = this.tfile;
    if (!file) return false;
    const fm = asFrontmatterRecord(this.app.metadataCache.getFileCache(file)?.frontmatter);
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
    this.markStale();
  }

  /**
   * Drops a `parentId` naming a task the folder doesn't hold, leaving this one a root of its
   * project — which is what the listing and the body link already say about it. Reports
   * whether it wrote.
   *
   * `expected` is the dangling id as the caller read it, and the write is skipped when the
   * file says something else: the pass walks a whole folder, and a note that gained a real
   * parent while it ran must not have it cleared.
   */
  async clearParentId(expected: string): Promise<boolean> {
    const file = this.tfile;
    if (!file) return false;
    let cleared = false;
    // `writeFrontmatter` rather than `editFrontmatter`: the stamp goes inside the guard, so
    // a note the race skips isn't marked as edited.
    await this.writeFrontmatter((fm) => {
      if (fm[Frontmatter.IsTask] !== true || fm[Frontmatter.ParentId] !== expected) return;
      delete fm[Frontmatter.ParentId];
      touch(fm);
      cleared = true;
    });
    if (cleared) this.markStale();
    return cleared;
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
   *  the other way round. */
  async pushToListing(): Promise<void> {
    const file = this.tfile;
    if (!file) return;
    const fm = asFrontmatterRecord(this.app.metadataCache.getFileCache(file)?.frontmatter);
    if (fm?.[Frontmatter.IsTask] !== true) return;
    await this.syncParentListing({
      title: stringOr(fm[Frontmatter.Title], file.basename),
      checked: toStatus(fm[Frontmatter.Status]) === Status.Done,
    });
  }

  /**
   * Lists this task on the note that should hold it when nothing does — a note that landed
   * while the plugin wasn't watching, from a sync or an editor, which `pushToListing` can
   * only mirror onto a line that is already there.
   *
   * For the arrival alone: the note is read as it stands, so a listing that already names it
   * costs a cache read and no write. The line goes where `parentLink` says, the same answer
   * the mirroring uses — bar a root task whose body names nothing, which the folder places.
   */
  async ensureListed(): Promise<void> {
    const file = this.tfile;
    if (!file) return;
    const fm = asFrontmatterRecord(this.app.metadataCache.getFileCache(file)?.frontmatter);
    if (fm?.[Frontmatter.IsTask] !== true) return;
    const id = stringOr(fm[Frontmatter.Id], "");
    if (!id) return;

    const parent = this.listedIn(await this.listingHome(fm));
    if (!parent) return;
    const basename = basenameOf(this.filePath);
    if (parent.listsChild(basename)) return;
    await parent.addChild(id, stringOr(fm[Frontmatter.Title], file.basename), basename);
  }

  /** Where this task's line belongs: the body's own link, and — for a task naming no parent
   *  and opening with no prefix — the project whose folder it sits in. A subtask with no
   *  prefix names nothing to place it by, and is left to the opening pass. */
  private async listingHome(fm: Record<string, unknown>): Promise<ParentLink | null> {
    const named = await this.readParentLink();
    if (named || fm[Frontmatter.ParentId]) return named;
    const projectFilePath = projectFileForTask(this.filePath);
    return projectFilePath ? { filePath: projectFilePath, section: PROJECT_TASK_SECTION } : null;
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
    // Through the note that holds the line, not straight at the file: that note keeps a
    // reading of its listing, and this write is one it must not hear about as an edit.
    await this.listedIn(link)?.updateChild(basenameOf(this.filePath), changes);
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
      for (const field of UPDATE_FIELDS) writeTaskField(fm, field, data[field]);
    });

    await this.syncParentListing(
      { title: data.title, checked: toStatus(data.status) === Status.Done }, currentBody,
    );

    if (currentDescription !== newDescription) {
      // `process` rather than read-then-modify: the writes above have already moved the
      // file, so the prefix to keep is read off the text being replaced.
      await this.app.vault.process(file, (current) => {
        const { frontmatterBlock, body } = splitFrontmatterBody(current);
        if (!frontmatterBlock) return current;
        const prefix = BODY_PREFIX_RE.exec(body.trim())?.[0] ?? "";
        const fullBody = newDescription ? prefix + newDescription + "\n" : prefix;
        return frontmatterBlock + (fullBody ? "\n" + fullBody : "");
      });
    }

    this.markStale();
  }

  /** Rewrites the list off the file rather than off the reading a model holds — what the
   *  passes that rewrite a whole folder use, a task read before another edit landed being
   *  their normal case. A view sets `ProjectTask.dependencies` instead. */
  private async patchDependencies(apply: (current: string[]) => string[]): Promise<void> {
    await this.editFrontmatter((fm) => {
      fm[Frontmatter.Dependencies] = apply(stringArray(fm[Frontmatter.Dependencies]));
    });
    this.markStale();
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
  async delete(taskId: string, allTasks: ProjectTask[] = [], parentTask?: ProjectTask): Promise<void> {
    // Read while the file is still there to say so.
    const link = parentTask ? null : await this.readParentLink();
    await this.trashWithSubtasks(taskId, allTasks);

    const lister = parentTask
      ? this.vault.projects.taskCache.file(parentTask.filePath)
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
  private async trashWithSubtasks(taskId: string, allTasks: ProjectTask[]): Promise<void> {
    for (const child of allTasks.filter((t) => t.parentId === taskId)) {
      await this.vault.projects.taskCache.file(child.filePath).trashWithSubtasks(child.id, allTasks);
    }

    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.trashFile(file);

    await pruneDependents(this.vault, taskId, allTasks);
  }

  /** The note holding that checklist line: a project for `## Tasks`, a task for `## Subtasks`. */
  private listedIn(link: ParentLink | null): ChildLister | null {
    if (!link) return null;
    return link.section === PROJECT_TASK_SECTION
      ? this.vault.projects.cache.file(link.filePath)
      : this.vault.projects.taskCache.file(link.filePath);
  }

  /** A new task note in its project's tasks folder: the cache makes the file, the file writes
   *  itself, and the cache takes what was written as its reading of it. The task it now reads
   *  as is handed back — what was written, before Obsidian has got round to the note. */
  static async create(vault: VaultData, opts: CreateTaskOpts): Promise<ProjectTask> {
    const tasksFolder = tasksFolderFor(opts.projectFilePath);
    await ensureFolderRecursive(vault.app, tasksFolder);
    const filePath = uniquePathIn(vault.app, tasksFolder, opts.title, "task");
    const file = vault.projects.taskCache.file(filePath);
    const written = await file.writeNew(opts);
    return vault.projects.taskCache.adopt(written);
  }

  /**
   * Writes this note for the first time: its frontmatter and body in one pass, then the line
   * listing it on whatever holds it. The reading it should have is built first and handed
   * back, so what the file says and what the cache holds are the one description of it.
   *
   * The cache's to adopt, not this note's to fill: filling is how a reading lands, and a
   * reading is the cache's to keep.
   */
  private async writeNew(opts: CreateTaskOpts): Promise<ProjectTaskFields> {
    const now = new Date();
    const fields: ProjectTaskFields = {
      id: generateId(),
      projectId: opts.projectId,
      parentId: opts.parentTask?.id,
      title: opts.title,
      status: opts.status,
      priority: opts.priority,
      type: toTaskType(opts.type),
      start: opts.start ?? undefined,
      due: opts.due ?? undefined,
      completed: opts.completed ?? undefined,
      progress: opts.progress,
      dependencies: opts.dependencies,
      tags: opts.tags,
      createdAt: now,
      updatedAt: now,
      filePath: this.filePath,
    };

    const lines = buildFrontmatter(fields);
    const prefix = bodyPrefixFor(opts);
    const description = opts.description.trim();
    lines.push("", description ? `${prefix}\n\n${description}` : prefix);
    // One write rather than an empty note filled afterwards: a note without its frontmatter
    // reads as none of ours, and the folder walk can see it in between.
    await this.app.vault.create(this.filePath, lines.join("\n") + "\n");

    // Listed in whatever holds it: its parent task, or the project itself. The box is passed
    // in, the note being too new for `addChild` to read its status from the metadata cache.
    const parent: ChildLister = opts.parentTask
      ? this.vault.projects.taskCache.file(opts.parentTask.filePath)
      : this.vault.projects.cache.file(opts.projectFilePath);
    await parent.addChild(fields.id, opts.title, basenameOf(this.filePath), toStatus(opts.status) === Status.Done);

    return fields;
  }
}

/**
 * One note's frontmatter read as the task it describes. A note not marked a task, or missing
 * the ids that place it under a project, names none and reads as null. The fields alone: the
 * cache that asked builds the task around them.
 */
export function parseTask(file: TFile, fm: FrontMatterCache): ProjectTaskFields | null {
  if (fm[Frontmatter.IsTask] !== true) return null;
  const id = stringOr(fm[Frontmatter.Id], "");
  const projectId = String(fm[Frontmatter.ProjectId] ?? "");
  if (!id || !projectId) return null;
  return {
    id,
    projectId,
    title: stringOr(fm[Frontmatter.Title], file.basename),
    parentId: fm[Frontmatter.ParentId] ? String(fm[Frontmatter.ParentId]) : undefined,
    status: String(fm[Frontmatter.Status] ?? Status.Todo),
    // `|| undefined`: an unrecognised (hand-typed) value narrows to `None`, and an absent
    // priority and an unusable one should both read as "no priority".
    priority: toPriority(fm[Frontmatter.Priority]) || undefined,
    type: toTaskType(fm[Frontmatter.Type]),
    dependencies: Array.isArray(fm[Frontmatter.Dependencies])
      ? (fm[Frontmatter.Dependencies] as string[])
      : [],
    start: frontmatterDay(fm[Frontmatter.Start]),
    due: frontmatterDay(fm[Frontmatter.Due]),
    progress:
      typeof fm[Frontmatter.Progress] === "number" ? fm[Frontmatter.Progress] : undefined,
    completed: frontmatterTimestamp(fm[Frontmatter.Completed]),
    tags: Array.isArray(fm[Frontmatter.Tags]) ? (fm[Frontmatter.Tags] as string[]) : undefined,
    createdAt: frontmatterTimestamp(fm[Frontmatter.CreatedAt]),
    updatedAt: frontmatterTimestamp(fm[Frontmatter.UpdatedAt]),
    card: toCardLayout(fm[Frontmatter.CardLayout]),
    filePath: file.path,
  };
}
