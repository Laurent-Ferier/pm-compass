/**
 * A project: the obsidian-pm note a task tree hangs off. `ProjectNote` reads and writes the
 * note; this is the shape the rest of the plugin passes around.
 */
import { BaseModel, type ModelStore } from "../base-model";
import type { ProjectTask } from "./project-task";
import type { CardLayout } from "./card-layout";
import type { StoreKey } from "../store/note-store";
// Mutual: a project is what its note reads as, and the note is what reads the file for it.
import type { ProjectNote } from "../store/project-note";

/** A project as its file holds it. Split out from `Project` so the reader and the tests can
 *  name the shape they build. */
export interface ProjectFields {
  id: string;
  title: string;
  color?: string;
  icon?: string;
  /** Put away: its tasks are left out of the graph, the dashboard and the inbox. */
  archived?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  /** Where its card sits among the projects and how big it is, when either has been chosen
   *  by hand — see `card-layout.ts`. */
  card?: CardLayout;
  /** Vault-relative path, injected by the vault reader. */
  filePath: string;
}

/**
 * What a project is to everything downstream of the reader, and where that reading is kept.
 *
 * The state below is this object's own: its note reads the file and wakes it whenever the
 * text moves, so a project handed out once goes on saying what its file says. Setting a
 * field writes through the note, which is where the file's spelling of it lives.
 *
 * Which tasks belong to it is no part of the file, and no part of a project: the store that
 * read the folder holds that — `ProjectNoteStore.tasksOf`.
 *
 * Made by `ProjectNoteStore` alone: the constructor takes the key only a store holds.
 */
export class Project extends BaseModel<ProjectNote, ProjectFields> implements ProjectFields {
  /** What the note last read as. Replaced whole on every wake. */
  private state: ProjectFields;

  constructor(_key: StoreKey, note: ProjectNote, store: ModelStore) {
    super(note, store);
    this.state = { ...note.snapshot() };
  }

  /** Takes what the note now says. Every field is the file's, so a reading that reached
   *  here is one that moved. */
  protected reload(): boolean {
    this.state = { ...this.persistence.snapshot() };
    return true;
  }

  // Setting one of the fields below puts it on the note and owes the file the change — see
  // `ProjectTask` for how that write is made. The rest are the file's own to say.

  get id(): string {
    return this.state.id;
  }

  get title(): string {
    return this.state.title;
  }

  set title(value: string) {
    this.persistence.set("title", value);
  }

  get color(): string | undefined {
    return this.state.color;
  }

  set color(value: string | undefined) {
    this.persistence.set("color", value);
  }

  get icon(): string | undefined {
    return this.state.icon;
  }

  set icon(value: string | undefined) {
    this.persistence.set("icon", value);
  }

  get archived(): boolean | undefined {
    return this.state.archived;
  }

  set archived(value: boolean | undefined) {
    this.persistence.set("archived", value || undefined);
  }

  get createdAt(): Date | undefined {
    return this.state.createdAt;
  }

  get updatedAt(): Date | undefined {
    return this.state.updatedAt;
  }

  get card(): CardLayout | undefined {
    return this.state.card;
  }

  /** Its fields as a plain record, the tasks left off: they are the reader's, not the file's. */
  toFields(): ProjectFields {
    return { ...this.state };
  }
}

export function isTask(x: Project | ProjectTask): x is ProjectTask {
  return "projectId" in x;
}
