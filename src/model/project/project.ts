/**
 * A project: the obsidian-pm note a task tree hangs off. `ProjectNote` reads and writes the
 * note; this is the shape the rest of the plugin passes around.
 */
import type { ProjectTask } from "./project-task";
import type { CardLayout } from "./card-layout";
import type { StoreKey } from "../store/note-store";
// Mutual: a project is what its note reads as, and the note is where its fields are kept.
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
 * What a project is to everything downstream of the reader.
 *
 * The fields below belong to its note, which is where they are kept, so there is one answer
 * to what the file says. What a project holds of its own is the tasks hung off it — no part
 * of the file, linked by the reader on each reading, and empty on one fresh from the store.
 *
 * Made by `ProjectNoteStore` alone: the constructor takes the key only a store holds.
 */
export class Project implements ProjectFields {
  /** Tasks belonging to this project, populated by the vault reader. */
  readonly tasks: ProjectTask[] = [];

  constructor(_key: StoreKey, readonly persistence: ProjectNote) {}

  // Setting one of the fields below puts it on the note and owes the file the change — see
  // `ProjectTask` for how that write is made. The rest are the file's own to say.

  get id(): string {
    return this.persistence.snapshot().id;
  }

  get title(): string {
    return this.persistence.snapshot().title;
  }

  set title(value: string) {
    this.persistence.set("title", value);
  }

  get color(): string | undefined {
    return this.persistence.snapshot().color;
  }

  set color(value: string | undefined) {
    this.persistence.set("color", value);
  }

  get icon(): string | undefined {
    return this.persistence.snapshot().icon;
  }

  set icon(value: string | undefined) {
    this.persistence.set("icon", value);
  }

  get archived(): boolean | undefined {
    return this.persistence.snapshot().archived;
  }

  set archived(value: boolean | undefined) {
    this.persistence.set("archived", value || undefined);
  }

  get createdAt(): Date | undefined {
    return this.persistence.snapshot().createdAt;
  }

  get updatedAt(): Date | undefined {
    return this.persistence.snapshot().updatedAt;
  }

  get card(): CardLayout | undefined {
    return this.persistence.snapshot().card;
  }

  get filePath(): string {
    return this.persistence.filePath;
  }

  /** Its fields as a plain record, the tasks left off: they are the reader's, not the file's. */
  toFields(): ProjectFields {
    return { ...this.persistence.snapshot() };
  }
}

export function isTask(x: Project | ProjectTask): x is ProjectTask {
  return "projectId" in x;
}
