import { App } from "obsidian";
import type { PMCompassSettings } from "../settings";
import { ProjectStore } from "../store/project-store";
import type { ProjectTaskStore } from "../store/project-task-store";
import { TaskService } from "../service/task-service";

// The shapes a caller has to name to ask for a write. Re-exported here so nothing outside
// this folder reaches for a note class to get at them.
export type { CreateTaskOpts, UpdateTaskData } from "../io/project-task-file";

/**
 * Everything the plugin holds: the projects folder, as `projects`, and — as `tasks` —
 * the day notes and the inbox beside it. What either half reads as, and when it says it has
 * changed, is that store's own; this is what starts them and hands them out.
 */
export class VaultData {
  /** The day notes and the inbox: the half of the vault that is not the projects folder.
   *  A view wanting to hear about them subscribes to it. */
  readonly tasks: TaskService;

  /** The projects folder read whole. `projects.file(path)` is how anything — a view, an
   *  operation, another note — gets a project note; nothing else can build one, and it is
   *  what a view subscribes to for the folder's changes. */
  readonly projects: ProjectStore;

  /** The folder's task notes, and the tasks they parse to — the project store's other half. */
  get projectTasks(): ProjectTaskStore {
    return this.projects.projectTasks;
  }

  constructor(readonly app: App, readonly settings: () => PMCompassSettings) {
    // Each store holds this, which is how a note of one kind reaches the other's.
    this.projects = new ProjectStore(this, settings().projectsFolder);
    this.tasks = new TaskService(this, settings);
  }

  /** Begins watching the vault, both halves. Reads no notes yet — the first read does that. */
  start(): void {
    this.projects.start();
    this.tasks.start();
  }

  /**
   * Fills both halves from the vault in the background, so the first dashboard paints from
   * what is already held rather than from a cold read. Nothing awaits it: every read awaits
   * the parses it is owed on its own.
   *
   * The start-of-session listing pass hangs off the read, this being the start of the
   * session — it happens whether or not a dashboard is ever opened.
   */
  warm(): void {
    void this.load().then((store) => store.ensureListingsVerified()).catch((e) => {
      // Nothing is owed to anyone here: a read that follows simply finds a cold cache.
      console.error("pm-compass: couldn't warm the project cache", e);
    });
    this.tasks.warm();
  }

  dispose(): void {
    this.projects.dispose();
    this.forget();
    this.tasks.dispose();
  }

  /** Re-points at the folder the settings now name, and the day half at its own scheme. */
  async reconfigure(): Promise<void> {
    this.projects.retarget(this.settings().projectsFolder);
    await this.tasks.reconfigure();
  }

  /**
   * The projects folder as it now reads, `projects` and `tasks` filled — the project store's
   * own reading, which is where a caller can also take it from.
   *
   * The relationships between the notes are built here, once the read has landed: which
   * tasks a project holds, and which sit under which. Neither is anything a note says, so
   * neither belongs to a model.
   */
  async load(): Promise<ProjectStore> {
    const store = await this.projects.load();
    store.link(store.tasks);
    this.projectTasks.link(store.tasks);
    return store;
  }

  /** Forgets every project note read so far, both halves of the folder together. */
  forget(): void {
    this.projects.clear();
  }

  /** Marks the project notes a write of the plugin's own touched — what a note calls once
   *  it has written itself, so the read that follows sees the write. */
  invalidate(paths: string[]): void {
    this.projects.invalidate(paths);
  }
}
