import { App } from "obsidian";
import type { PMCompassSettings } from "../settings";
import { ProjectNoteStore } from "./project-note-store";
import type { ProjectTaskNoteStore } from "./project-task-note-store";
import { TaskStore } from "./task-store";

// The shapes a caller has to name to ask for a write. Re-exported here so nothing outside
// this folder reaches for a note class to get at them.
export type { CreateTaskOpts, UpdateTaskData } from "./project-task-note";

/**
 * Everything the plugin holds: the projects folder, as `projectNotes`, and — as `taskStore` —
 * the day notes and the inbox beside it. What either half reads as, and when it says it has
 * changed, is that store's own; this is what starts them and hands them out.
 */
export class VaultData {
  /** The day notes and the inbox: the half of the vault that is not the projects folder.
   *  A view wanting to hear about them subscribes to it. */
  readonly taskStore: TaskStore;

  /** The projects folder read whole. `projectNotes.note(path)` is how anything — a view, an
   *  operation, another note — gets a project note; nothing else can build one, and it is
   *  what a view subscribes to for the folder's changes. */
  readonly projectNotes: ProjectNoteStore;

  /** The folder's task notes, and the tasks they parse to — the project store's other half. */
  get taskNotes(): ProjectTaskNoteStore {
    return this.projectNotes.taskNotes;
  }

  constructor(readonly app: App, readonly settings: () => PMCompassSettings) {
    // Each store holds this, which is how a note of one kind reaches the other's.
    this.projectNotes = new ProjectNoteStore(this, settings().projectsFolder);
    this.taskStore = new TaskStore(this, settings);
  }

  /** Begins watching the vault, both halves. Reads no notes yet — the first read does that. */
  start(): void {
    this.projectNotes.start();
    this.taskStore.start();
  }

  /**
   * Fills both halves from the vault in the background, so the first dashboard paints from
   * what is already held rather than from a cold read. Nothing awaits it: every read awaits
   * the parses it is owed on its own.
   */
  warm(): void {
    void this.load().catch((e) => {
      // Nothing is owed to anyone here: a read that follows simply finds a cold cache.
      console.error("pm-compass: couldn't warm the project cache", e);
    });
    this.taskStore.warm();
  }

  dispose(): void {
    this.projectNotes.dispose();
    this.forget();
    this.taskStore.dispose();
  }

  /** Re-points at the folder the settings now name, and the day half at its own scheme. */
  async reconfigure(): Promise<void> {
    this.projectNotes.retarget(this.settings().projectsFolder);
    await this.taskStore.reconfigure();
  }

  /**
   * The projects folder as it now reads, `projects` and `tasks` filled — the project store's
   * own reading, which is where a caller can also take it from.
   *
   * The relationships between the notes are built here, once the read has landed: which
   * tasks a project holds, and which sit under which. Neither is anything a note says, so
   * neither belongs to a model.
   */
  async load(): Promise<ProjectNoteStore> {
    const store = await this.projectNotes.load();
    store.link(store.tasks);
    this.taskNotes.link(store.tasks);
    return store;
  }

  /** Forgets every project note read so far, both halves of the folder together. */
  forget(): void {
    this.projectNotes.clear();
  }

  /** Marks the project notes a write of the plugin's own touched — what a note calls once
   *  it has written itself, so the read that follows sees the write. */
  invalidate(paths: string[]): void {
    this.projectNotes.invalidate(paths);
  }
}
