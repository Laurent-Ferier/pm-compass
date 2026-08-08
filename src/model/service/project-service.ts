import type { Project, ProjectFields } from "../project/project";
import type { ProjectTask } from "../project/project-task";
import type { CardLayout } from "../project/card-layout";
import { BaseService } from "./base-service";
import type { ProjectStore, FolderReconcilers } from "../store/project-store";
import type { ProjectTaskStore } from "../store/project-task-store";
import type { StoreEvent, StoreEvents } from "../store/store-events";
import { ProjectTaskFile, type CreateTaskOpts, type UpdateTaskData } from "../io/project-task-file";
import { ensureFolderRecursive, generateId, resolveFile, slugify, uniquePathIn } from "../operations/file-helpers";
import { activeProjects, withoutArchivedTasks } from "../project/archive";
import { repairListings, unlinkDeletedTask, type RepairOpts, type RepairResult } from "../project/listing-repair";
import { syncChangedNote } from "../project/listing-sync";

export interface CreateProjectOpts {
  projectsFolder: string;
  title: string;
}

/** What checking the folder reports: what the repair pass did, plus what the walk around it
 *  noticed — notes calling themselves tasks that nothing here can read as one. */
export interface VerifyResult extends RepairResult {
  unreadableTaskNotes: number;
}

const DEFAULT_PROJECT_ICON = "📋";

/**
 * The one way into the projects folder for anything that is not a reading. It holds no note —
 * `ProjectStore` and `ProjectTaskStore` below it do, and re-read only what changed — but it is
 * what the settings, the writes that span notes and the listing passes go through, and its
 * events are those stores' handed on. The day notes are `TaskService`'s, which is built the
 * same way.
 *
 * One service over both stores rather than one each: creating a task writes the task note
 * *and* the listing of the project or parent that holds it, so the writes cross the halves
 * already.
 */
export class ProjectService extends BaseService implements FolderReconcilers {
  /** The projects folder as it was last read. */
  private get notes(): ProjectStore {
    return this.vault.projectNotes;
  }

  /** The task notes beside them, as they were last read. */
  private get taskNotes(): ProjectTaskStore {
    return this.vault.projectTasks;
  }

  /** What the projects folder says when it changes — a view subscribes here. */
  on<K extends StoreEvent>(event: K, handler: (payload: StoreEvents[K]) => void): () => void {
    return this.notes.on(event, handler);
  }

  // ── Writing the folder ───────────────────────────────────────────────────
  //
  // Setting one field of one note goes through the model — see `Project` and `ProjectTask`.
  // What is here is what touches a second note, or makes one, and so is nobody's field to set.

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

    const fields: ProjectFields = {
      id,
      title: opts.title,
      icon: DEFAULT_PROJECT_ICON,
      createdAt: now,
      updatedAt: now,
      filePath,
    };
    return this.notes.adopt(fields);
  }

  /** Creates a task note and lists it on whatever holds it, returning its generated ID. */
  async createTask(opts: CreateTaskOpts): Promise<string> {
    const file = await ProjectTaskFile.create(this.vault, opts);
    return file.snapshot().id;
  }

  /** The whole of a task, as the editor's dialog hands it over: its fields and the prose
   *  body beneath them, which is no field of its own. */
  async updateTask(filePath: string, data: UpdateTaskData): Promise<void> {
    await this.taskNotes.file(filePath).update(data);
  }

  /** Deletes a task, its subtasks, and the mentions of it the other notes carry. Those run
   *  to whatever depended on it, so the whole folder is taken as owed. */
  async deleteTask(task: ProjectTask, allTasks: ProjectTask[] = [], parentTask?: ProjectTask): Promise<void> {
    await this.taskNotes.file(task.filePath).delete(task.id, allTasks, parentTask);
    this.vault.forget();
  }

  /** Where a project's or a task's card was left in the graph, and how big it was made. */
  writeCardLayout(entry: Project | ProjectTask, card: CardLayout | null): Promise<void> {
    return entry.persistence.patchCard(card);
  }

  /** A task note's prose body. The one read here that doesn't come out of a store: it is the
   *  note's text, which nothing holds a reading of. */
  readDescription(filePath: string): Promise<string> {
    return this.taskNotes.file(filePath).readDescription();
  }

  // ── Keeping the listings in step ─────────────────────────────────────────
  //
  // A project lists its tasks and a task its subtasks, as `- [ ] [[child]]` lines. Nothing
  // stops those being edited by hand, or falling behind a task written elsewhere, so this
  // is what puts the two back in step: `syncChangedNote` note by note as they change, and
  // `verifyListings` once over the folder at the start of a session.

  /** The opening pass, kept so a second caller awaits it rather than starting another. */
  private verifyPass: Promise<void> | null = null;

  /**
   * Starts the opening pass over every listing in the folder, once per session, handing
   * back its promise. Nothing should block a render on it: it reads every note, and one
   * changed while it runs is simply one it hasn't reached — which `syncChangedNote`
   * handles by answering that note's boxes with the statuses.
   */
  ensureListingsVerified(): Promise<void> {
    if (!this.settings().verifyListingsOnLoad) return Promise.resolve();
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
    const live = activeProjects(this.notes.projects);
    const tasks = withoutArchivedTasks(this.notes.tasks, this.notes.projects);
    const result = await repairListings(this.vault, live, tasks, opts);
    for (const p of live) p.persistence.markVerified();
    for (const t of tasks) t.persistence.markVerified();
    return { ...result, unreadableTaskNotes: this.notes.unreadableTaskNotes() };
  }

  /** How many of the folder's projects the pass leaves alone, for a caller reporting what
   *  it skipped rather than claiming a clean sweep. */
  get archivedCount(): number {
    const { projects } = this.notes;
    return projects.length - activeProjects(projects).length;
  }

  /** Puts a note and the checklists it takes part in back in step. */
  syncChangedNote(filePath: string): Promise<void> {
    return syncChangedNote(this.vault, filePath);
  }

  /**
   * Puts the notes a window of changes gathered back in step: their checklists, and — for a
   * task closed by a status edited elsewhere — the `completed` stamp that edit left off. A
   * task that arrived from outside is also listed by whatever should hold it, nothing having
   * had the chance to.
   *
   * The paths are the ones whose models woke, so this runs on notes that actually changed
   * rather than on every reparse Obsidian reports — which is what keeps the plugin's own
   * writes from buying another pass each. None of the three redraws anything of itself, and
   * they run in turn, note after note: each writes a file the next one reads.
   */
  changed(paths: string[], arrived: Set<string>): void {
    void paths
      .reduce((chain, path) => chain.then(() => this.reconcileNote(path, arrived.has(path))), Promise.resolve())
      // Nothing awaits this pass, so the last word on it is here.
      .catch((e: unknown) => { console.error("pm-compass: couldn't put the changed notes back in step", e); });
  }

  /** A task note deleted outside the plugin leaves the note that listed it holding a line
   *  for something gone. A deletion through the plugin dropped that entry already, so this
   *  finds nothing to do. */
  deleted(path: string): void {
    void unlinkDeletedTask(this.vault, path).catch((e: unknown) => {
      console.error("pm-compass: couldn't unlink the deleted task", e);
    });
  }

  private async reconcileNote(path: string, arrived: boolean): Promise<void> {
    // A path the vault no longer resolves is a note that went in this window; what its
    // going costs the notes around it is `deleted`'s.
    if (!resolveFile(this.app, path)) return;
    const file = this.taskNotes.file(path);
    try {
      // Before the sync, not instead of it: together they would write this file at once.
      if (file.needsCompletedStamp()) await file.stampCompleted();
    } catch (e: unknown) {
      console.error("pm-compass: couldn't stamp the completion date", e);
    }
    try {
      if (arrived) await file.ensureListed();
    } catch (e: unknown) {
      console.error("pm-compass: couldn't list the task that arrived", e);
    }
    try {
      await this.syncChangedNote(path);
    } catch (e: unknown) {
      console.error("pm-compass: couldn't sync the checklist", e);
    }
  }
}
