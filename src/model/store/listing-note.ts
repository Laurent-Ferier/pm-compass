import { CachedMetadata, normalizePath } from "obsidian";
import type { ChildBox, ChildEntry, ChildLinkSection } from "../project/child-links";
import {
  addChildLink, listingFromCache, removeChildLink, setChildLinkBoxes, syncChildLinks,
} from "../project/child-links";
import { BaseNote, type FieldEdit, type NoteFields } from "./base-note";
import type { ProjectTaskNote } from "./project-task-note";

/** What a note that lists children reads as: its own fields, and the boxes under its
 *  heading — the one part of the reading that isn't frontmatter. */
export interface ListingFields extends NoteFields {
  /** The `- [ ] [[child]]` entries under this note's own section, as the store last read
   *  them. Absent for a note built to write to and never read. */
  listing?: ChildBox[];
}

/**
 * A note that lists other notes below it: a project over its root tasks under `## Tasks`, a
 * task over its subtasks under `## Subtasks`. The two differ only in which section holds the
 * list and where the children's own notes sit, which is what `ProjectNote` and
 * `ProjectTaskNote` supply — everything else about listing children is here.
 *
 * Its own layer rather than part of `BaseNote` because a day note lists nothing: it holds a
 * file of checklist lines that are the record themselves, not a copy of notes living
 * elsewhere. Being a separate class is what says so — there is no note here that has to
 * answer "do I list children" with no.
 *
 * The listing is part of the reading. `readListing` takes it off Obsidian's own reading of
 * the file, the store hands it to `fill` alongside the frontmatter, and `sameFields` then
 * tells "a box moved" apart from "a field moved" — so a checklist ticked by hand reaches the
 * views like any other edit, and the plugin's own repair coming back reaches nobody.
 */
export abstract class ListingNote<F extends ListingFields, E = FieldEdit<F>> extends BaseNote<F, E> {
  /** Which frontmatter list and heading hold this note's children. */
  protected abstract get childSection(): ChildLinkSection;

  /** The folder the children's own notes live in. */
  protected abstract get childFolder(): string;

  /** The child note at that path — always a task note, whichever kind of parent this is. */
  protected childNote(filePath: string): ProjectTaskNote {
    return this.vault.taskNotes.note(filePath);
  }

  /** Where a listed child's own note sits. */
  private childPath(basename: string): string {
    return normalizePath(`${this.childFolder}/${basename}.md`);
  }

  // ── The listing as a reading ─────────────────────────────────────────────

  /**
   * This note's listing out of Obsidian's reading of the file. The store filling this note
   * calls it with the cache it already has — the section the listing sits under is the
   * note's own to know, so the reading happens here and the lookup there.
   */
  readListing(cache: CachedMetadata | null): ChildBox[] {
    return listingFromCache(cache, this.childSection);
  }

  /** The boxes this note lists. Its own reading, falling back to a fresh one for a note the
   *  store has yet to fill — a listing edited before the folder was ever walked. */
  private childBoxes(): ChildBox[] {
    if (this.fields?.listing) return this.fields.listing;
    const file = this.tfile;
    return file ? this.readListing(this.app.metadataCache.getFileCache(file)) : [];
  }

  /** Whether this note's listing already names that child. */
  listsChild(basename: string): boolean {
    return this.childBoxes().some((box) => box.basename === basename);
  }

  // ── Keeping it in step with the tasks it names ───────────────────────────

  /** Pushes every box onto the task it names: ticked closes it, unticked reopens it. Only
   *  for a listing known to agree, where a disagreeing box can only be a fresh edit. */
  async applyChildBoxes(): Promise<void> {
    for (const { basename, checked } of this.childBoxes()) {
      await this.childNote(this.childPath(basename)).applyParentBox(checked);
    }
  }

  /** Rewrites every box from the status of the task it names — `applyChildBoxes` the other
   *  way round, and what a listing gets the first time it is seen. */
  async repairChildBoxes(): Promise<void> {
    const fixes = new Map<string, boolean>();
    for (const { basename, checked } of this.childBoxes()) {
      // Null for anything but a task note — a link the user wrote keeps its box.
      const done = this.childNote(this.childPath(basename)).isDone();
      if (done !== null && done !== checked) fixes.set(basename, done);
    }
    if (fixes.size > 0) await setChildLinkBoxes(this.app, this.filePath, this.childSection, fixes);
  }

  /** Make this note's whole listing agree with `children`. Reports whether it wrote. */
  async syncChildListing(children: ChildEntry[]): Promise<boolean> {
    return syncChildLinks(this.app, this.filePath, this.childSection, children, this.childFolder);
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
      ?? (this.childNote(this.childPath(childBasename)).isDone() ?? false);
    await addChildLink(this.app, this.filePath, this.childSection, childId, childTitle, childBasename, checked);
  }

  /** Unregister a child, undoing `addChild` and cleaning up an emptied heading. */
  async removeChild(childId: string, childBasename: string): Promise<void> {
    await removeChildLink(this.app, this.filePath, this.childSection, childId, childBasename);
  }
}
