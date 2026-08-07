import { FrontMatterCache, TFile, normalizePath } from "obsidian";
import { dayAsTimestamp, formatDate, formatTimestamp } from "../dates";
import { addDependencyToTask, removeDependencyFromTask, toTaskType, type ProjectTask, type ProjectTaskFields } from "../project/project-task";
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
import type { ChildLinkSection } from "../project/child-links";
import { PROJECT_TASK_SECTION, SUBTASK_SECTION } from "../project/child-links";
import { type FieldEdit } from "./base-file";
import { ListingFile } from "./listing-file";
import type { VaultData } from "../service/vault-data";
import type { StoreKey } from "../store/file-store";
import { Status, toPriority, toStatus } from "../base-task";
import { Frontmatter, frontmatterDay, frontmatterTimestamp } from "../project/frontmatter";
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
    await vault.projectTasks.file(dependent.filePath).removeDependency(taskId);
  }
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
type ChildLister = Pick<ProjectTaskFile, "addChild" | "removeChild" | "updateChild" | "listsChild">;

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

export interface CreateTaskOpts {
  projectId: string;
  projectFilePath: string;
  projectTitle: string;
  parentTask?: ProjectTask;
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
 * The file behind one project task note, with typed operations on its frontmatter and body.
 * A task lists its subtasks as a project lists its root tasks — hence `ListingFile`.
 *
 * Made by `ProjectTaskStore` alone: its constructor takes the key only a store holds,
 * and `vault.projectTasks.file(path)` is how everything else gets one.
 */
export class ProjectTaskFile extends ListingFile<ProjectTaskFields> {
  constructor(_key: StoreKey, vault: VaultData, filePath: string) {
    super(vault, filePath);
  }

  protected get childSection() {
    return SUBTASK_SECTION;
  }

  /** Every task of a project shares one folder, so a subtask is a sibling. */
  protected get childFolder() {
    return parentDirOf(this.filePath);
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
    this.vault.invalidate([this.filePath]);
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
    if (cleared) this.vault.invalidate([this.filePath]);
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
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.[Frontmatter.IsTask] !== true) return;
    await this.syncParentListing({
      title: String(fm[Frontmatter.Title] ?? file.basename),
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
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.[Frontmatter.IsTask] !== true) return;
    const id = String(fm[Frontmatter.Id] ?? "");
    if (!id) return;

    const parent = this.listedIn(await this.listingHome(fm));
    if (!parent) return;
    const basename = basenameOf(this.filePath);
    if (parent.listsChild(basename)) return;
    await parent.addChild(id, String(fm[Frontmatter.Title] ?? file.basename), basename);
  }

  /** Where this task's line belongs: the body's own link, and — for a task naming no parent
   *  and opening with no prefix — the project whose folder it sits in. A subtask with no
   *  prefix names nothing to place it by, and is left to the opening pass. */
  private async listingHome(fm: FrontMatterCache): Promise<ParentLink | null> {
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

    this.vault.invalidate([this.filePath]);
  }

  /** Rewrites the list off the file rather than off this note's reading: a caller holding
   *  a task read before another edit landed must not write that reading back. */
  private async patchDependencies(apply: (current: string[]) => string[]): Promise<void> {
    await this.editFrontmatter((fm) => {
      fm[Frontmatter.Dependencies] = apply(stringArray(fm[Frontmatter.Dependencies]));
    });
    this.vault.invalidate([this.filePath]);
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
      ? this.vault.projectTasks.file(parentTask.filePath)
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
      await this.vault.projectTasks.file(child.filePath).trashWithSubtasks(child.id, allTasks);
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
      ? this.vault.projectNotes.file(link.filePath)
      : this.vault.projectTasks.file(link.filePath);
  }

  /** Creates a task file in the project's tasks folder, returning its generated ID. */
  static async create(
    vault: VaultData,
    opts: CreateTaskOpts,
  ): Promise<{ id: string; file: ProjectTaskFile }> {
    const app = vault.app;
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
    const parent: ChildLister = opts.parentTask
      ? vault.projectTasks.file(opts.parentTask.filePath)
      : vault.projectNotes.file(opts.projectFilePath);
    // The box is passed in: the file is too new for `addChild` to read its status
    // from the metadata cache.
    await parent.addChild(id, opts.title, fileBasename, toStatus(opts.status) === Status.Done);

    return { id, file: vault.projectTasks.file(filename) };
  }
}

/**
 * One note's frontmatter read as the task it describes. A note not marked a task, or missing
 * the ids that place it under a project, names none and reads as null. The fields alone: the
 * store that asked builds the task around them.
 */
export function parseTask(file: TFile, fm: FrontMatterCache): ProjectTaskFields | null {
  if (fm[Frontmatter.IsTask] !== true) return null;
  const id = String(fm[Frontmatter.Id] ?? "");
  const projectId = String(fm[Frontmatter.ProjectId] ?? "");
  if (!id || !projectId) return null;
  return {
    id,
    projectId,
    title: String(fm[Frontmatter.Title] ?? file.basename),
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
    assignees: Array.isArray(fm[Frontmatter.Assignees])
      ? (fm[Frontmatter.Assignees] as string[])
      : undefined,
    tags: Array.isArray(fm[Frontmatter.Tags]) ? (fm[Frontmatter.Tags] as string[]) : undefined,
    createdAt: frontmatterTimestamp(fm[Frontmatter.CreatedAt]),
    updatedAt: frontmatterTimestamp(fm[Frontmatter.UpdatedAt]),
    card: toCardLayout(fm[Frontmatter.CardLayout]),
    filePath: file.path,
  };
}
