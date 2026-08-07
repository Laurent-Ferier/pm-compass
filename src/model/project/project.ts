/**
 * A project: the obsidian-pm note a task tree hangs off. `ProjectFile` reads and writes the
 * file; this is the shape the rest of the plugin passes around.
 */
import { BaseModel, type ModelStore } from "../base-model";
import type { ProjectTask } from "./project-task";
import type { CardLayout } from "./card-layout";
import type { StoreKey } from "../store/file-store";
// Mutual: a project is what its file reads as, and the file is what reads the vault for it.
import type { ProjectFile } from "../io/project-file";

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
 * The state below is this object's own: its file reads the vault and wakes it whenever the
 * text moves, so a project handed out once goes on saying what its file says. Setting a
 * field writes through the file, which is where the vault's spelling of it lives.
 *
 * Which tasks belong to it is no part of the file, and no part of a project: the store that
 * read the folder holds that — `ProjectStore.tasksOf`.
 *
 * Made by `ProjectStore` alone: the constructor takes the key only a store holds.
 */
export class Project extends BaseModel<ProjectFile> implements ProjectFields {
  /** What the file last read as. Replaced whole on every wake. */
  private state: ProjectFields;

  constructor(_key: StoreKey, file: ProjectFile, store: ModelStore) {
    super(file, store);
    this.state = { ...file.snapshot() };
  }

  /** Takes what the file now says. Every field is the vault's, so a reading that reached
   *  here is one that moved. */
  protected reload(): boolean {
    this.state = { ...this.persistence.snapshot() };
    return true;
  }

  // Setting one of the fields below puts it on the file and owes the vault the change — see
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
