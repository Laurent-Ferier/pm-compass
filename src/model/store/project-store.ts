import { FrontMatterCache, TFile } from "obsidian";
import { Project, type ProjectFields } from "../project/project";
import type { ProjectTask } from "../project/project-task";
import { FileStore } from "./file-store";
import { ProjectIO, parseProject } from "../io/project-io";
import { ProjectTaskStore } from "./project-task-store";
import { ChangeOrigin, StoreEvent, originOf } from "./store-events";
import type { VaultData } from "../service/vault-data";
import { Frontmatter } from "../project/frontmatter";

/**
 * What the folder tells the service above it, beside the events the views hear. The passes
 * that put the listings back in step are `ProjectService`'s; what this store knows and it
 * doesn't is which notes moved in a window, and which of them were not there before.
 */
export interface FolderReconcilers {
  /** The notes that moved in this window, and those of them the folder didn't hold before. */
  changed(paths: string[], arrived: Set<string>): void;
  /** A note the vault no longer holds — gone rather than moved. */
  deleted(path: string): void;
}

/** A folder read with nothing above it, for a test that only wants the readings. */
const noReconcilers: FolderReconcilers = { changed: () => {}, deleted: () => {} };

/**
 * The projects folder, read whole: its project notes held as they were last parsed, and — as
 * `projectTasks` — the task notes beside them.
 *
 * The folder is read in two passes. The projects first, off the metadata cache, so a task's
 * `projectId` names a project already read; then the notes that are left, parsed as tasks.
 * `projects` and `tasks` are what `load` leaves behind, and stay the same arrays until a note
 * changes — so a consumer can memoize on their identity. Which tasks a project holds is this
 * store's too, `link` building it and `tasksOf` answering it.
 *
 * The only place a `ProjectIO` is made: everything else asks for one by path.
 */
export class ProjectStore extends FileStore<ProjectFields, ProjectIO, Project> {
  /** The folder's task notes, and the tasks they parse to. Made here because they are read
   *  through this store: a note this one claimed is one that store leaves unopened. */
  readonly projectTasks: ProjectTaskStore;

  /** The folder as it last read, each project carrying the tasks that name it. */
  projects: Project[] = [];
  /** Every task note in the folder, whether or not a project claims it. */
  tasks: ProjectTask[] = [];
  /** Which tasks each project holds, by project id. Here rather than on a project: a
   *  project note says nothing about it, and the folder read whole is what does. */
  private byProject = new Map<string, ProjectTask[]>();
  /** The task list the map was built from, so an unchanged one is not linked again. */
  private linkedFrom: ProjectTask[] | null = null;

  constructor(vault: VaultData, folder: string, private readonly reconcilers: FolderReconcilers = noReconcilers) {
    super(vault, folder);
    this.projectTasks = new ProjectTaskStore(vault, folder, this);
  }

  protected parseFields(file: TFile, fm: FrontMatterCache): ProjectFields | null {
    return parseProject(file, fm);
  }

  protected makeFile(filePath: string): ProjectIO {
    return new ProjectIO(this.key, this, this.vault, filePath);
  }

  protected wrap(file: ProjectIO): Project {
    return new Project(this.key, file, this);
  }

  /**
   * A project over a note of its own, filled from those fields and left out of the folder —
   * so two of them over the same path stay separate readings. The one way to build a project
   * the folder didn't read, which is what a test wants and nothing in the plugin does.
   */
  make(fields: ProjectFields): Project {
    const file = new ProjectIO(this.key, this, this.vault, fields.filePath);
    file.fill(fields);
    return new Project(this.key, file, this);
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
    this.tasks = await this.projectTasks.data();
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

  /** Re-points both halves: they read the same folder. */
  override retarget(folder: string): void {
    super.retarget(folder);
    this.projectTasks.retarget(folder);
    this.linkedFrom = null;
  }

  /** Forgets every note read so far, both halves of the folder together. */
  override clear(): void {
    super.clear();
    this.projectTasks.clear();
    this.linkedFrom = null;
    this.byProject.clear();
    this.projects = [];
    this.tasks = [];
  }

  /**
   * Notes under the folder that call themselves tasks and that this store does not read as
   * one. Two ways in: frontmatter the reader can't place — `parseTask` wants an `id` and a
   * `projectId` and answers null without them — and a second note claiming an id another
   * already has, which the folder's reading drops rather than doubling the row.
   *
   * Counted rather than repaired, and counted here rather than in the repair pass: it is a
   * question about the folder, which only this store walks. Nothing about a note like this
   * says what it was meant to be, so what it needs is a person.
   */
  unreadableTaskNotes(): number {
    // Against every task the folder holds, archived included — the repair pass's own list
    // has those removed, and counting them as unreadable would be a lie about the vault.
    const read = new Set(this.tasks.map((t) => t.filePath));
    return this.folderFiles().filter((file) => {
      if (read.has(file.path) || this.holds(file.path)) return false;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return fm?.[Frontmatter.IsTask] === true;
    }).length;
  }

  /** The folder is read as the event lands, so what the views hear about is the notes that
   *  moved rather than the paths Obsidian happened to reparse. */
  protected override get readsOnTouch(): boolean {
    return true;
  }

  /**
   * A note in the folder as the metadata cache just reparsed it, read again at once. The
   * re-read is what tells the views — and this store — that the note moved: the models it
   * wakes say so, and `announce` is where that is answered.
   *
   * The projects go first, as everywhere: a note this half claims is one the other leaves
   * unopened.
   */
  protected override reparsed(path: string): void {
    // A note owed a read off the file is one this can't answer: the metadata cache still
    // holds what it said before the plugin's write. `announce` takes that read instead —
    // the write that owed it opened the window this is inside, so it will be taken.
    if (this.owedFromFile(path)) return;
    // A path neither half has ever held: a note that landed from outside — a sync, an
    // editor, a file copied in — rather than one this plugin is part-way through writing,
    // whose listing is `createTask`'s or `moveTask`'s.
    if (!this.holds(path) && !this.projectTasks.holds(path)) this.arrivals.add(path);
    this.reparsing = true;
    try {
      this.reparseNow(path);
      this.projectTasks.reparseNow(path);
    } finally {
      this.reparsing = false;
    }
  }

  /** Whether a vault reparse is what is waking the models. See `wakeOrigin`. */
  private reparsing = false;

  /** This store tells the views through the models its reads wake, so where a change came
   *  from is which read woke them: the one a reparse takes is an edit from outside. */
  protected override get wakeOrigin(): ChangeOrigin {
    return this.reparsing ? ChangeOrigin.Vault : ChangeOrigin.Plugin;
  }

  /** Notes that appeared in the folder since the last window closed, which is the one case
   *  a listing has to be added to rather than only mirrored onto. */
  private readonly arrivals = new Set<string>();

  // ── Watching the folder ──────────────────────────────────────────────────
  //
  // Only this half watches: the two read the same folder, and an edit can move a note from
  // one to the other, so every change is marked in both and told once.

  override dispose(): void {
    super.dispose();
    this.projectTasks.dispose();
  }

  override drop(path: string): boolean {
    const mine = super.drop(path);
    return this.projectTasks.drop(path) || mine;
  }

  /** A task note deleted outside the plugin leaves the note that listed it holding a line
   *  for something gone — which is the service's to put right. */
  protected override deleted(path: string): void {
    this.reconcilers.deleted(path);
  }

  override touch(path: string, fromWrite = false): boolean {
    const mine = super.touch(path, fromWrite);
    return this.projectTasks.touch(path, fromWrite) || mine;
  }

  /** The notes that moved in this window, handed to the service to put back in step and then
   *  told about. The reconcilers hang off here rather than off the vault's own events: a path
   *  Obsidian reparsed to what it already said is not a note anyone has to answer. */
  protected announce(): void {
    const pending = this.takePending();
    const paths = [...pending.keys()];
    if (paths.length > 0) {
      const arrived = new Set(this.arrivals);
      this.arrivals.clear();
      this.reconcilers.changed(paths, arrived);
      this.emit(StoreEvent.ProjectsChanged, { paths, origin: originOf(pending.values()) });
    }
    this.readWhatIsOwed();
  }

  /**
   * Reads the notes owed a read off the file — a write of the plugin's own, which no reading
   * of the metadata cache can answer. A view asking for the folder would take it; with none
   * open nothing would, and the reconcilers hang off the models that read wakes.
   *
   * Through the vault so the relationships between the notes are rebuilt with them. The read
   * clears what it took, so the window it opens in turn finds nothing owed and stops.
   */
  private readWhatIsOwed(): void {
    if (!this.hasStale() && !this.projectTasks.hasStale()) return;
    void this.vault.load().catch((e: unknown) => {
      console.error("pm-compass: couldn't read the notes a write left owed", e);
    });
  }
}
