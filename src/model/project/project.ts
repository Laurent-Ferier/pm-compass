/**
 * A project: the obsidian-pm note a task tree hangs off. `ProjectIO` reads and writes the
 * file; this is the shape the rest of the plugin passes around.
 */
import { BaseModel, type ModelCache } from "../base-model";
import type { ProjectTask } from "./project-task";
import type { CardLayout } from "./card-layout";
import type { ChildBox } from "./child-links";
import type { ListingModel } from "../io/listing-io";
import type { CacheKey } from "../cache/folder-cache";
// Mutual: a project is what its file reads as, and the file is what reads the vault for it.
import type { ProjectIO } from "../io/project-io";

/** What a project's note is born carrying, obsidian-pm's own default and this plugin's.
 *  A project still wearing it was never given an icon — see `chosenIcon`. */
export const DEFAULT_PROJECT_ICON = "📋";

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
  /** The `- [ ] [[task]]` boxes under its `## Tasks` — the one part of the reading that isn't
   *  frontmatter. See [task-listings.md](../../../docs/technical/task-listings.md). */
  listing?: ChildBox[];
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
 * Which tasks belong to it is no part of the file, and no part of a project: a caller with the
 * folder's tasks in hand groups them by `projectId` itself.
 *
 * Made by `ProjectCache` alone: the constructor takes the key only a cache holds.
 */
export class Project extends BaseModel<ProjectIO, ProjectFields>
implements ProjectFields, ListingModel<ProjectFields> {
  constructor(_key: CacheKey, file: ProjectIO, cache: ModelCache, fields: ProjectFields) {
    super(file, cache, fields);
  }

  /** Sets one field and owes the file the change — see `ProjectTask` for how that write is
   *  made. Nothing when the reading already says that. */
  private write<K extends keyof ProjectFields>(field: K, value: ProjectFields[K]): void {
    if (this.put(field, value)) this.persistence.owe(String(field), { field, value });
  }

  /** The `- [ ] [[task]]` boxes under its `## Tasks`, which its file reads and rewrites. */
  get listing(): ChildBox[] | undefined {
    return this.state.listing;
  }

  listingWritten(boxes: ChildBox[]): void {
    this.put("listing", boxes);
  }

  /** Where its card was left among the projects, and how big it was made. The write lands
   *  first: what this holds has to be what the file says. */
  async moveCard(card: CardLayout | null): Promise<void> {
    await this.persistence.writeCard(card);
    this.put("card", card ?? undefined);
    this.refresh();
  }

  // Setting one of the fields below puts it on the reading and owes the vault the change.
  // The rest are the file's own to say.

  get id(): string {
    return this.state.id;
  }

  get title(): string {
    return this.state.title;
  }

  set title(value: string) {
    this.write("title", value);
  }

  get color(): string | undefined {
    return this.state.color;
  }

  set color(value: string | undefined) {
    this.write("color", value);
  }

  get icon(): string | undefined {
    return this.state.icon;
  }

  set icon(value: string | undefined) {
    this.write("icon", value);
  }

  /**
   * The icon in as far as it says which project this is: the one it was given, and nothing
   * where it still carries the clipboard every project is born with. obsidian-pm writes that
   * on every project it creates, as does `createProject`, so drawing it would put the same
   * glyph on most of a vault's projects and tell a reader nothing.
   */
  get chosenIcon(): string | undefined {
    return this.state.icon === DEFAULT_PROJECT_ICON ? undefined : this.state.icon;
  }

  get archived(): boolean | undefined {
    return this.state.archived;
  }

  set archived(value: boolean | undefined) {
    this.write("archived", value || undefined);
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
