import { FrontMatterCache, TFile } from "obsidian";
import { ProjectTask, type ProjectTaskFields } from "../project/project-task";
import type { CardLayout } from "../project/card-layout";
import { NoteStore } from "./note-store";
import type { VaultData } from "./vault-data";
// Mutual: this store is made by the project store, and reads what that one has claimed.
import type { ProjectNoteStore } from "./project-note-store";
import {
  ProjectTaskNote, parseTask,
  type CreateTaskOpts, type UpdateTaskData,
} from "./project-task-note";

/**
 * The projects folder's task notes, held as they were last parsed. It reads what the project
 * note store has left: a note that store claimed is one this one leaves unopened, which is
 * why `VaultData` reads the projects first.
 *
 * The only place a `ProjectTask` or a `ProjectTaskNote` is made: everything else asks for one.
 */
export class ProjectTaskNoteStore extends NoteStore<ProjectTaskFields, ProjectTaskNote, ProjectTask> {
  constructor(vault: VaultData, folder: string, private readonly projects: ProjectNoteStore) {
    super(vault, folder);
  }

  protected parseFields(file: TFile, fm: FrontMatterCache): ProjectTaskFields | null {
    return parseTask(file, fm);
  }

  protected makeNote(filePath: string): ProjectTaskNote {
    return new ProjectTaskNote(this.key, this.vault, filePath);
  }

  protected wrap(note: ProjectTaskNote): ProjectTask {
    return new ProjectTask(this.key, note);
  }

  /**
   * A task over a note of its own, filled from those fields and left out of the folder —
   * so two of them over the same path stay separate readings. The one way to build a task
   * the folder didn't read, which is what a test wants and nothing in the plugin does.
   */
  make(fields: ProjectTaskFields): ProjectTask {
    const note = new ProjectTaskNote(this.key, this.vault, fields.filePath);
    note.fill(fields);
    return new ProjectTask(this.key, note);
  }

  /** The projects are read first, so a note one of them parsed as is one this pass can
   *  leave unopened. */
  protected override claimedElsewhere(path: string): boolean {
    return this.projects.holds(path);
  }

  /** The project half watches the folder for both and tells the views once, marking this
   *  one as it goes — so nothing is ever gathered here to tell. */
  protected announce(): void {}

  /** Every task note in the folder, re-reading whatever has changed. Repeated calls hand
   *  back the same array until something does. */
  data(): Promise<ProjectTask[]> {
    return this.entries();
  }

  // ── The writes that are not one task's own fields ────────────────────────
  //
  // Setting a field goes through the task — see `ProjectTask`. What is left here is what touches
  // more than the one note, and so is nobody's field to set.

  /** Creates a task note and lists it on whatever holds it, returning its generated ID. */
  async createTask(opts: CreateTaskOpts): Promise<string> {
    const { id, file } = await ProjectTaskNote.create(this.vault, opts);
    // The parent's listing gained a line too, so both notes are owed a re-read.
    this.vault.invalidate([file.filePath, opts.parentTask?.filePath ?? opts.projectFilePath]);
    return id;
  }

  /** The whole of a task, as the editor's dialog hands it over: its fields and the prose
   *  body beneath them, which is no field of its own. */
  async updateTask(filePath: string, data: UpdateTaskData): Promise<void> {
    await this.note(filePath).update(data);
  }

  /** Deletes a task, its subtasks, and the mentions of it the other notes carry. Those run
   *  to whatever depended on it, so the whole folder is taken as owed. */
  async deleteTask(task: ProjectTask, allTasks: ProjectTask[] = [], parentTask?: ProjectTask): Promise<void> {
    await this.note(task.filePath).delete(task.id, allTasks, parentTask);
    this.vault.forget();
  }

  /** Where a task's card was left in the graph, and how big it was made. */
  writeCardLayout(task: ProjectTask, card: CardLayout | null): Promise<void> {
    return task.persistence.patchCard(card);
  }

  /** A task note's prose body. The one read here that doesn't come out of the cache: it is
   *  the note's text, which nothing holds a reading of. */
  readDescription(filePath: string): Promise<string> {
    return this.note(filePath).readDescription();
  }
}
