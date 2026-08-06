import { FrontMatterCache, TFile } from "obsidian";
import { Project, type ProjectFields } from "../project/project";
import type { ProjectTask } from "../project/project-task";
import type { CardLayout } from "../project/card-layout";
import { NoteStore } from "./note-store";
import { ensureFolderRecursive, generateId, slugify, uniquePathIn } from "../operations/file-helpers";
import { ProjectNote, parseProject } from "./project-note";
import { ProjectTaskNoteStore } from "./project-task-note-store";
import { StoreEvent } from "./store-events";
import type { VaultData } from "./vault-data";
import { activeProjects, withoutArchivedTasks } from "../project/archive";
import { repairListings, unlinkDeletedTask, type RepairOpts, type RepairResult } from "../project/listing-repair";
import { syncChangedNote } from "../project/listing-sync";
import { Frontmatter } from "../project/frontmatter";

/**
 * The projects folder, read whole: its project notes held as they were last parsed, and — as
 * `taskNotes` — the task notes beside them.
 *
 * The folder is read in two passes. The projects first, off the metadata cache, so a task's
 * `projectId` names a project already read; then the notes that are left, parsed as tasks.
 * `projects` and `tasks` are what `load` leaves behind, and stay the same arrays until a note
 * changes — so a consumer can memoize on their identity. Which tasks a project holds is this
 * store's too, `link` building it and `tasksOf` answering it.
 *
 * The only place a `ProjectNote` is made: everything else asks for one by path.
 */
export interface CreateProjectOpts {
  projectsFolder: string;
  title: string;
}

const DEFAULT_PROJECT_ICON = "📋";

/** What checking the folder reports: what the repair pass did, plus what the walk around it
 *  noticed — notes calling themselves tasks that nothing here can read as one. */
export interface VerifyResult extends RepairResult {
  unreadableTaskNotes: number;
}

export class ProjectNoteStore extends NoteStore<ProjectFields, ProjectNote, Project> {
  /** The folder's task notes, and the tasks they parse to. Made here because they are read
   *  through this store: a note this one claimed is one that store leaves unopened. */
  readonly taskNotes: ProjectTaskNoteStore;

  /** The folder as it last read, each project carrying the tasks that name it. */
  projects: Project[] = [];
  /** Every task note in the folder, whether or not a project claims it. */
  tasks: ProjectTask[] = [];
  /** Which tasks each project holds, by project id. Here rather than on a project: a
   *  project note says nothing about it, and the folder read whole is what does. */
  private byProject = new Map<string, ProjectTask[]>();
  /** The task list the map was built from, so an unchanged one is not linked again. */
  private linkedFrom: ProjectTask[] | null = null;

  constructor(vault: VaultData, folder: string) {
    super(vault, folder);
    this.taskNotes = new ProjectTaskNoteStore(vault, folder, this);
  }

  protected parseFields(file: TFile, fm: FrontMatterCache): ProjectFields | null {
    return parseProject(file, fm);
  }

  protected makeNote(filePath: string): ProjectNote {
    return new ProjectNote(this.key, this.vault, filePath);
  }

  protected wrap(note: ProjectNote): Project {
    return new Project(this.key, note, this);
  }

  /**
   * A project over a note of its own, filled from those fields and left out of the folder —
   * so two of them over the same path stay separate readings. The one way to build a project
   * the folder didn't read, which is what a test wants and nothing in the plugin does.
   */
  make(fields: ProjectFields): Project {
    const note = new ProjectNote(this.key, this.vault, fields.filePath);
    note.fill(fields);
    return new Project(this.key, note, this);
  }

  /** Every project in the folder as the metadata cache now reads it, re-parsing whatever
   *  has changed. Taken without awaiting, so the reading of the folder can begin with the
   *  projects and hand the tasks a list to hang off. */
  data(): Project[] {
    return this.syncEntries();
  }

  /** The project that note holds, or null when it names none. */
  at(filePath: string): Promise<Project | null> {
    return this.entry(filePath);
  }

  /**
   * Reads the folder and hands back itself, `projects` and `tasks` filled. The two halves are
   * read in order — the projects synchronously, then the task notes, which is what lets a task
   * be linked into the project it names. `VaultData` links them once the read has landed.
   */
  async load(): Promise<this> {
    this.projects = this.data();
    this.tasks = await this.taskNotes.data();
    return this;
  }

  /** Files each task under the project it names. A task whose project is nowhere in the
   *  folder is still a task; it simply hangs off nothing. */
  link(tasks: ProjectTask[]): void {
    if (this.linkedFrom === tasks) return;
    this.byProject = new Map();
    for (const task of tasks) {
      const held = this.byProject.get(task.projectId);
      if (held) held.push(task);
      else this.byProject.set(task.projectId, [task]);
    }
    this.linkedFrom = tasks;
  }

  /** The tasks that project holds, in the folder's own order. Empty for one with none. */
  tasksOf(projectId: string): ProjectTask[] {
    return this.byProject.get(projectId) ?? [];
  }

  /**
   * Creates a project file in the projects folder and hands back the note it made. The
   * frontmatter mirrors what obsidian-pm emits, fields this plugin never reads included, so
   * a project created here is indistinguishable from one created there. That schema is
   * obsidian-pm's, reproduced from observed files, and would need revisiting if its format
   * changes.
   */
  async createProject(opts: CreateProjectOpts): Promise<Project> {
    const app = this.app;
    await ensureFolderRecursive(app, opts.projectsFolder);
    const filePath = uniquePathIn(app, opts.projectsFolder, slugify(opts.title) || "project");

    const id = generateId();
    const now = new Date();
    const stamp = now.toISOString();

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
      `createdAt: "${stamp}"`,
      `updatedAt: "${stamp}"`,
      "---",
      "",
      `# ${DEFAULT_PROJECT_ICON} ${opts.title}`,
      "",
      "## Tasks",
    ];

    await app.vault.create(filePath, lines.join("\n") + "\n");

    const note = this.note(filePath);
    note.fill({
      id,
      title: opts.title,
      icon: DEFAULT_PROJECT_ICON,
      createdAt: now,
      updatedAt: now,
      filePath,
    });
    return this.model(note);
  }

  // ── Writing a project note ───────────────────────────────────────────────
  //
  // Thin over the note class, which does the writing; what these add is the marking, so
  // the refresh each one leads to reads the new text rather than waiting on Obsidian to
  // say the file changed.

  /** Where a project's card was left in the graph, and how big it was made. */
  writeCardLayout(project: Project, card: CardLayout | null): Promise<void> {
    return project.persistence.patchCard(card);
  }

  /** Re-points both halves: they read the same folder. */
  override retarget(folder: string): void {
    super.retarget(folder);
    this.taskNotes.retarget(folder);
    this.linkedFrom = null;
  }

  /** Forgets every note read so far, both halves of the folder together. */
  override clear(): void {
    super.clear();
    this.taskNotes.clear();
    this.linkedFrom = null;
    this.byProject.clear();
    this.projects = [];
    this.tasks = [];
  }

  // ── Keeping the listings in step ─────────────────────────────────────────
  //
  // A project lists its tasks and a task its subtasks, as `- [ ] [[child]]` lines. Nothing
  // stops those being edited by hand, or falling behind a task written elsewhere, so this
  // is what puts the two back in step: `syncChangedNote` note by note as they change, and
  // `verifyListings` once over the folder at the start of a session.

  /** Notes whose checklist is known to agree with the tasks it names — only there can a
   *  disagreeing box be read as a fresh edit rather than a note predating the sync. */
  private readonly verified = new Set<string>();
  /** The opening pass, kept so a second caller awaits it rather than starting another. */
  private verifyPass: Promise<void> | null = null;

  /**
   * Starts the opening pass over every listing in the folder, once per session, handing
   * back its promise. Nothing should block a render on it: it reads every note, and one
   * changed while it runs is simply one it hasn't reached — which `syncChangedNote`
   * handles by answering that note's boxes with the statuses.
   */
  ensureListingsVerified(): Promise<void> {
    if (!this.vault.settings().verifyListingsOnLoad) return Promise.resolve();
    this.verifyPass ??= this.verifyListings().then(
      () => undefined,
      (e: unknown) => {
        // Left unmarked, so the notes fall back to being checked one by one.
        console.error("pm-compass: couldn't check the project listings", e);
      },
    );
    return this.verifyPass;
  }

  /**
   * Repairs every live listing, and takes the notes it covered as checked. Archived projects
   * are left out and left unmarked, so the pass doesn't rewrite notes that have been put
   * away — one edited by hand is still repaired on its own by `syncChangedNote`.
   *
   * `clearDanglingParents` is the caller's to say, and only the command says yes: the
   * session-start pass must not race a sync that has yet to land a parent note.
   */
  async verifyListings(opts: RepairOpts = {}): Promise<VerifyResult> {
    const live = activeProjects(this.projects);
    const tasks = withoutArchivedTasks(this.tasks, this.projects);
    const result = await repairListings(this.vault, live, tasks, opts);
    for (const p of live) this.verified.add(p.filePath);
    for (const t of tasks) this.verified.add(t.filePath);
    return { ...result, unreadableTaskNotes: this.unreadableTaskNotes() };
  }

  /**
   * Notes under the folder that call themselves tasks and that this store does not read as
   * one. Two ways in: frontmatter the reader can't place — `parseTask` wants an `id` and a
   * `projectId` and answers null without them — and a second note claiming an id another
   * already has, which the folder's reading drops rather than doubling the row.
   *
   * Counted rather than repaired, and counted here rather than in the repair pass: it is a
   * question about the folder, which only this store walks, and the pass is handed a task
   * list with the archived ones already taken out. Nothing about a note like this says what
   * it was meant to be, so what it needs is a person.
   */
  private unreadableTaskNotes(): number {
    // Against every task the folder holds, archived included — the repair pass's own list
    // has those removed, and counting them as unreadable would be a lie about the vault.
    const read = new Set(this.tasks.map((t) => t.filePath));
    return this.folderFiles().filter((file) => {
      if (read.has(file.path) || this.holds(file.path)) return false;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return fm?.[Frontmatter.IsTask] === true;
    }).length;
  }

  /** How many of the folder's projects the pass leaves alone, for a caller reporting what
   *  it skipped rather than claiming a clean sweep. */
  get archivedCount(): number {
    return this.projects.length - activeProjects(this.projects).length;
  }

  /** Puts a note and the checklists it takes part in back in step. `data` is the change
   *  event's own content where there is one — see `syncChangedNote` for what it saves. */
  syncChangedNote(filePath: string, data?: string): Promise<void> {
    return syncChangedNote(this.vault, this.verified, filePath, data);
  }

  /** The folder is read as the event lands, off the text the metadata cache carries with
   *  it, so what the views hear about is the notes that moved. */
  protected override get readsOnTouch(): boolean {
    return true;
  }

  /**
   * A note in the folder as the metadata cache just reparsed it: read again at once, its
   * checklists put back in step, and — for a task closed by a status edited elsewhere — the
   * `completed` stamp that edit left off.
   *
   * The re-read is what tells the views: the models it wakes say whether the note moved.
   * The projects go first, as everywhere — a note this half claims is one the other leaves
   * unopened. Neither the sync nor the stamp redraws anything of itself.
   */
  protected override reparsed(path: string, data: string): void {
    this.reparseNow(path);
    this.taskNotes.reparseNow(path);
    const note = this.taskNotes.note(path);
    if (note.needsCompletedStamp()) {
      // Sync behind the stamp: together they would write this file at once.
      void note.stampCompleted()
        .catch((e: unknown) => { console.error("pm-compass: couldn't stamp the completion date", e); })
        .then(() => this.syncChangedNote(path, data))
        .catch((e: unknown) => { console.error("pm-compass: couldn't sync the checklist", e); });
      return;
    }
    this.syncChangedNote(path, data).catch((e: unknown) => {
      console.error("pm-compass: couldn't sync the checklist", e);
    });
  }

  // ── Watching the folder ──────────────────────────────────────────────────
  //
  // Only this half watches: the two read the same folder, and an edit can move a note from
  // one to the other, so every change is marked in both and told once.

  override dispose(): void {
    super.dispose();
    this.taskNotes.dispose();
  }

  /** A note leaving a path takes its listing's good standing with it; whatever arrives
   *  there next is unchecked. */
  override drop(path: string): boolean {
    this.verified.delete(path);
    const mine = super.drop(path);
    return this.taskNotes.drop(path) || mine;
  }

  /** A task note deleted outside the plugin leaves the note that listed it holding a line
   *  for something gone. A deletion through the plugin dropped that entry already, so this
   *  finds nothing to do. */
  protected override deleted(path: string): void {
    void unlinkDeletedTask(this.app, path).catch((e: unknown) => {
      console.error("pm-compass: couldn't unlink the deleted task", e);
    });
  }

  override touch(path: string, fromWrite = false): boolean {
    const mine = super.touch(path, fromWrite);
    return this.taskNotes.touch(path, fromWrite) || mine;
  }

  protected announce(): void {
    const paths = this.takePending();
    if (paths.length > 0) this.emit(StoreEvent.ProjectsChanged, { paths });
  }
}
