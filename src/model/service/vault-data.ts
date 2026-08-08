import { App } from "obsidian";
import type { PMCompassSettings } from "../settings";
import { corePluginEnabled, templaterOf, type TemplaterPlugin } from "./app-plugins";
import type { ProjectStore } from "../store/project-store";
import { ProjectService } from "./project-service";
import { TaskService } from "./task-service";
import { DayNoteService } from "./day-note-service";

// The shapes a caller has to name to ask for a write. Re-exported here so nothing outside
// this folder reaches for a note class to get at them.
export type { CreateTaskOpts, UpdateTaskData } from "../io/project-task-io";

/**
 * Everything the plugin holds: the projects folder, as `projects`, and — as `tasks` — the day
 * notes and the inbox beside it. Each half is a cache under a service: what a note reads as
 * and when it says it has changed is the cache's, and what spans notes is the service's. This
 * is what builds the four of them and starts them together.
 */
export class VaultData {
  /** The day notes and the inbox: the half of the vault that is not the projects folder.
   *  A view wanting to hear about them subscribes to it. */
  readonly tasks: TaskService;

  /** The way into the projects folder: creating a note, the writes that span two of them,
   *  and the passes that keep the listings in step. A view subscribes to it for the folder's
   *  changes. */
  readonly projects: ProjectService;

  /** Where a day's note lives, and the making of one that isn't there yet. Held here rather
   *  than under `tasks`: the passes that write a day note reach it through the vault. */
  readonly dayNotes: DayNoteService;

  constructor(readonly app: App, readonly settings: () => PMCompassSettings) {
    // Each service builds the cache under it and is the way to it — `projects.notes` and
    // `tasks.notes`. Nothing holds a store here: a view has a service, and reaching a note
    // through one is what says which settings that reading was taken under.
    this.projects = new ProjectService(this);
    this.dayNotes = new DayNoteService(this);
    this.tasks = new TaskService(this);
  }

  // ── The plugins around this one ──────────────────────────────────────────

  /** Templater, when the vault has it loaded — undefined otherwise, which every caller
   *  treats as "write the template out plainly". */
  get templater(): TemplaterPlugin | undefined {
    return templaterOf(this.app);
  }

  /** Whether one of Obsidian's own core plugins is on. */
  corePluginEnabled(id: string): boolean {
    return corePluginEnabled(this.app, id);
  }

  /** Begins watching the vault, both halves. Reads no notes yet — the first read does that. */
  start(): void {
    this.projects.notes.start();
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
    void this.load().then(() => this.projects.ensureListingsVerified()).catch((e) => {
      // Nothing is owed to anyone here: a read that follows simply finds a cold cache.
      console.error("pm-compass: couldn't warm the project cache", e);
    });
    this.tasks.warm();
  }

  dispose(): void {
    this.projects.notes.dispose();
    this.forget();
    this.tasks.dispose();
  }

  /** Re-points at the folder the settings now name, and the day half at its own scheme. */
  async reconfigure(): Promise<void> {
    this.projects.notes.retarget(this.settings().projectsFolder);
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
    const store = await this.projects.notes.load();
    store.link(store.tasks);
    this.projects.taskNotes.link(store.tasks);
    return store;
  }

  /** Forgets every project note read so far, both halves of the folder together. */
  forget(): void {
    this.projects.notes.clear();
  }
}
