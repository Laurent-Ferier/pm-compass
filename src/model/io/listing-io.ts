import { CachedMetadata, normalizePath } from "obsidian";
import type { ChildBox, ChildEntry, ChildLinkSection } from "../project/child-links";
import {
  addChildLink, listingFromCache, removeChildEntry, removeChildLink, setChildLinkBoxes,
  syncChildLinks, updateChildLink,
} from "../project/child-links";
import { BaseIO, type FieldEdit, type FileFields } from "./base-io";
import type { NoteModel } from "../i-model";
import type { ProjectTaskIO } from "./project-task-io";

/** What a note that lists children reads as: its own fields, and the boxes under its
 *  heading — the one part of the reading that isn't frontmatter. */
export interface ListingFields extends FileFields {
  /** The `- [ ] [[child]]` entries under this note's own section, as the store last read
   *  them. Absent for a note built to write to and never read. */
  listing?: ChildBox[];
  /** Vault-relative path, injected by the vault reader. */
  filePath: string;
}

/**
 * The model over a note that lists children, as far as that note's file needs it. The listing
 * is part of what the note reads as, and a reading is the model's — so a file about to rewrite
 * a listing asks the model what it currently says, and tells it what it left.
 */
export interface ListingModel<Fields> extends NoteModel<Fields> {
  /** The boxes it lists, as last read or written. None for a model over a note nothing has
   *  read — one built to write to. */
  readonly listing: ChildBox[] | undefined;

  /** The listing its note has just written, taken onto the reading. Tells nobody: the re-read
   *  that follows a moment later then lands what this already says. */
  listingWritten(boxes: ChildBox[]): void;
}

/**
 * The file behind a note that lists other notes below it: a project over its root tasks under
 * `## Tasks`, a task over its subtasks under `## Subtasks`. The two differ only in which
 * section holds the list and where the children's own notes sit, which is what `ProjectIO`
 * and `ProjectTaskIO` supply — everything else about listing children is here.
 *
 * Its own layer rather than part of `BaseIO` because a day note lists nothing: it holds
 * checklist lines that are the record themselves, not a copy of notes living elsewhere. Being
 * a separate class is what says so — there is no file here that has to answer "do I list
 * children" with no.
 *
 * The listing is part of the reading. `readListing` takes it off Obsidian's own reading of
 * the file, the store hands it to `fill` alongside the frontmatter, and `sameFields` then
 * tells "a box moved" apart from "a field moved" — so a checklist ticked by hand reaches the
 * views like any other edit.
 *
 * Which is also why every write to a listing goes through this class rather than reaching for
 * `child-links` directly: each one hands back the listing it left, `wrote` takes that onto
 * the reading, and the plugin's own repair coming back a moment later wakes nobody.
 */
export abstract class ListingIO<Fields extends ListingFields, Edit = FieldEdit<Fields>>
  extends BaseIO<Fields, Edit, ListingModel<Fields>> {
  /** Which frontmatter list and heading hold the note's children. */
  protected abstract get childSection(): ChildLinkSection;

  /** The folder the children's own notes live in. */
  protected abstract get childFolder(): string;

  /** The child at that path — always a task note, whichever kind of parent this is. */
  protected childFile(filePath: string): ProjectTaskIO {
    return this.vault.projects.taskNotes.file(filePath);
  }

  /** Where a listed child's own note sits. */
  private childPath(basename: string): string {
    return normalizePath(`${this.childFolder}/${basename}.md`);
  }

  // ── The listing as a reading ─────────────────────────────────────────────

  /**
   * The note's listing out of Obsidian's reading of the file. The store filling this file
   * calls it with the cache it already has — the section the listing sits under is the
   * note's own to know, so the reading happens here and the lookup there.
   */
  readListing(cache: CachedMetadata | null): ChildBox[] {
    return listingFromCache(cache, this.childSection);
  }

  /** The boxes this note lists. What its model holds, falling back to a fresh reading for a
   *  note the store has yet to read — a listing edited before the folder was ever walked. */
  private childBoxes(): ChildBox[] {
    const held = this.note?.listing;
    if (held) return held;
    const file = this.tfile;
    return file ? this.readListing(this.app.metadataCache.getFileCache(file)) : [];
  }

  /**
   * Hands a listing this note has just written to the model that holds its reading. Obsidian
   * reparses the file a moment later, and that re-reading then lands what the model already
   * holds, so nothing is woken and no reconciler runs over a change the plugin made itself.
   *
   * Null is a write that didn't happen, and leaves the reading alone.
   */
  private wrote(boxes: ChildBox[] | null): void {
    if (!boxes) return;
    // No model to move ahead — a note written before the folder ever read it. Only a re-read
    // can say what it now lists.
    if (!this.note) return this.markStale();
    this.note.listingWritten(boxes);
  }

  /** Whether this note's listing already names that child. */
  listsChild(basename: string): boolean {
    return this.childBoxes().some((box) => box.basename === basename);
  }

  // ── Keeping it in step with the tasks it names ───────────────────────────

  /**
   * Whether this listing is known to agree with the tasks it names — only then can a
   * disagreeing box be read as a fresh edit rather than a note predating the sync.
   *
   * Not part of the reading: it is not what the file says, so it stays out of `fields` and
   * takes no part in `sameFields` — a note whose standing changed hasn't moved as far as a
   * view is concerned. Being held here rather than beside the notes is what makes it go
   * wherever the note goes, and go when it does.
   */
  private verified = false;

  /** Takes this listing as agreeing with its tasks, a pass over the whole folder having
   *  just made it so. */
  markVerified(): void {
    this.verified = true;
  }

  /** Puts this note's boxes and the tasks they name back in step: mirrored onto the tasks
   *  for a listing known to agree, repaired from them for one seen for the first time. */
  async syncChildBoxes(): Promise<void> {
    if (this.verified) {
      await this.applyChildBoxes();
      return;
    }
    await this.repairChildBoxes();
    this.verified = true;
  }

  override gone(): void {
    super.gone();
    this.verified = false;
  }

  /** Pushes every box onto the task it names: ticked closes it, unticked reopens it. Only
   *  for a listing known to agree, where a disagreeing box can only be a fresh edit. */
  async applyChildBoxes(): Promise<void> {
    for (const { basename, checked } of this.childBoxes()) {
      await this.childFile(this.childPath(basename)).applyParentBox(checked);
    }
  }

  /** Rewrites every box from the status of the task it names — `applyChildBoxes` the other
   *  way round, and what a listing gets the first time it is seen. */
  async repairChildBoxes(): Promise<void> {
    const fixes = new Map<string, boolean>();
    for (const { basename, checked } of this.childBoxes()) {
      // Null for anything but a task note — a link the user wrote keeps its box.
      const done = this.childFile(this.childPath(basename)).isDone();
      if (done !== null && done !== checked) fixes.set(basename, done);
    }
    if (fixes.size === 0) return;
    this.wrote(await setChildLinkBoxes(this.app, this.filePath, this.childSection, fixes));
  }

  /** Make this note's whole listing agree with `children`. Reports whether it wrote. */
  async syncChildListing(children: ChildEntry[]): Promise<boolean> {
    const left = await syncChildLinks(this.app, this.filePath, this.childSection, children, this.childFolder);
    this.wrote(left);
    return left !== null;
  }

  // ── Adding and removing one ──────────────────────────────────────────────

  /**
   * Registers a child: its ID in the section's frontmatter list, its checklist line under
   * the heading. Idempotent, so a partly applied move is safe to retry. The box follows
   * the child's own status, a stale list being able to tick a task reopened since;
   * `knownChecked` is for a child too new to have a cache entry.
   */
  async addChild(
    childId: string, childTitle: string, childBasename: string, knownChecked?: boolean,
  ): Promise<void> {
    const checked = knownChecked
      ?? (this.childFile(this.childPath(childBasename)).isDone() ?? false);
    this.wrote(
      await addChildLink(this.app, this.filePath, this.childSection, childId, childTitle, childBasename, checked),
    );
  }

  /** Unregister a child, undoing `addChild` and cleaning up an emptied heading. */
  async removeChild(childId: string, childBasename: string): Promise<void> {
    this.wrote(await removeChildLink(this.app, this.filePath, this.childSection, childId, childBasename));
  }

  /** Rewrites one child's line — its title, its box, or both. What a task mirrors itself
   *  onto the note that lists it with; an entry that isn't there is left absent. */
  async updateChild(childBasename: string, changes: { title?: string; checked?: boolean }): Promise<void> {
    this.wrote(await updateChildLink(this.app, this.filePath, this.childSection, childBasename, changes));
  }

  /** Drops a child's line without touching the ID list — a task deleted outside the plugin,
   *  which leaves no id to prune from. Reports whether this note held the line. */
  async dropChildEntry(childBasename: string): Promise<boolean> {
    const left = await removeChildEntry(this.app, this.filePath, this.childSection, childBasename);
    this.wrote(left);
    return left !== null;
  }
}
