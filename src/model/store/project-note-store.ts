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

/**
 * The projects folder, read whole: its project notes held as they were last parsed, and — as
 * `taskNotes` — the task notes beside them.
 *
 * The folder is read in two passes. The projects first, off the metadata cache, so a task's
 * `projectId` names a project already read; then the notes that are left, parsed as tasks and
 * hung off the project each one names. `projects` and `tasks` are what `load` leaves behind,
 * and stay the same arrays until a note changes — so a consumer can memoize on their identity.
 *
 * The only place a `ProjectNote` is made: everything else asks for one by path.
 */
export interface CreateProjectOpts {
  projectsFolder: string;
  title: string;
}

const DEFAULT_PROJECT_ICON = "📋";

export class ProjectNoteStore extends NoteStore<ProjectFields, ProjectNote, Project> {
  /** The folder's task notes, and the tasks they parse to. Made here because they are read
   *  through this store: a note this one claimed is one that store leaves unopened. */
  readonly taskNotes: ProjectTaskNoteStore;

  /** The folder as it last read, each project carrying the tasks that name it. */
  projects: Project[] = [];
  /** Every task note in the folder, whether or not a project claims it. */
  tasks: ProjectTask[] = [];
  /** The halves the last reading was built from, so an unchanged one is not linked again. */
  private linked: { projects: Project[]; tasks: ProjectTask[] } | null = null;

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
   * be linked into the project it names.
   */
  async load(): Promise<this> {
    const projects = this.data();
    const tasks = await this.taskNotes.data();
    if (this.linked?.projects === projects && this.linked.tasks === tasks) return this;

    // Onto the projects themselves: there is one of each, and a view holding one is meant
    // to see the folder as it now reads.
    for (const project of projects) project.tasks.length = 0;
    const byId = new Map(projects.map((p) => [p.id, p]));
    // A task whose project is nowhere in the folder is still a task; it simply hangs off
    // nothing, and the views that walk the projects leave it out.
    for (const task of tasks) byId.get(task.projectId)?.tasks.push(task);

    this.projects = projects;
    this.tasks = tasks;
    this.linked = { projects, tasks };
    return this;
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
    this.linked = null;
  }

  /** Forgets every note read so far, both halves of the folder together. */
  override clear(): void {
    super.clear();
    this.taskNotes.clear();
    this.linked = null;
    this.projects = [];
    this.tasks = [];
  }

  // ── Watching the folder ──────────────────────────────────────────────────
  //
  // Only this half watches: the two read the same folder, and an edit can move a note from
  // one to the other, so every change is marked in both and told once.

  override dispose(): void {
    super.dispose();
    this.taskNotes.dispose();
  }

  override touch(path: string, fromWrite = false): boolean {
    const mine = super.touch(path, fromWrite);
    return this.taskNotes.touch(path, fromWrite) || mine;
  }

  override drop(path: string): boolean {
    const mine = super.drop(path);
    return this.taskNotes.drop(path) || mine;
  }

  protected announce(): void {
    const paths = this.takePending();
    if (paths.length > 0) this.emit(StoreEvent.ProjectsChanged, { paths });
  }
}
