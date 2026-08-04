import { App, normalizePath } from "obsidian";
import type { ChildEntry, ChildLinkSection } from "./child-links";
import {
  addChildLink, readChildLinkBoxes, removeChildLink, setChildLinkBoxes, syncChildLinks,
} from "./child-links";
import { resolveFile } from "../operations/file-helpers";
import { Frontmatter } from "./frontmatter";
import type { CardLayout } from "./card-layout";
import type { ProjectTaskFile } from "./project-task-file";

/** A note listing others as a `- [ ] [[child]]` checklist — a project's `## Tasks`, a
 *  task's `## Subtasks`. They differ only in the section and where the children sit. */
export abstract class BaseNote {
  readonly filePath: string;
  protected readonly app: App;

  constructor(app: App, filePath: string) {
    this.app = app;
    this.filePath = filePath;
  }

  protected get tfile() {
    return resolveFile(this.app, this.filePath);
  }

  /** Which frontmatter list and heading hold this note's children. */
  protected abstract get childSection(): ChildLinkSection;

  /** The folder the children's own notes live in. */
  protected abstract get childFolder(): string;

  /** The child note at that path — always a task note, whichever kind of parent this is. */
  protected abstract childNote(filePath: string): ProjectTaskFile;

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

  /** Where a listed child's own note sits. */
  private childPath(basename: string): string {
    return normalizePath(`${this.childFolder}/${basename}.md`);
  }

  /** Pushes every box onto the task it names: ticked closes it, unticked reopens it. Only
   *  for a listing known to agree, where a disagreeing box can only be a fresh edit. */
  async applyChildBoxes(body: string): Promise<void> {
    for (const { basename, checked } of readChildLinkBoxes(body, this.childSection)) {
      await this.childNote(this.childPath(basename)).applyParentBox(checked);
    }
  }

  /** Rewrites every box from the status of the task it names — `applyChildBoxes` the other
   *  way round, and what a listing gets the first time it is seen. */
  async repairChildBoxes(body: string): Promise<void> {
    const fixes = new Map<string, boolean>();
    for (const { basename, checked } of readChildLinkBoxes(body, this.childSection)) {
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

  /** Rewrites this note's frontmatter, stamping nothing. Throws when the file is gone: every
   *  caller was handed the path by something that had just read it. */
  protected async writeFrontmatter(mutate: (fm: Record<string, unknown>) => void): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, mutate);
  }

  /**
   * Records where this note's card was left in the graph and how big it was made. Both kinds
   * of note carry one: a project has a card among the projects, a task among its siblings.
   *
   * The whole of it: `cardLayout` says everything about how the card is drawn, so the caller
   * hands over what it should now say, and an empty one — nothing left worth storing — drops
   * the key. Where a card sits is not an edit of the note, so `updatedAt` is left alone:
   * nudging the drawing must not move a note up a list sorted by it.
   */
  async patchCard(card: CardLayout | null): Promise<void> {
    await this.writeFrontmatter((fm) => {
      if (card && (card.x !== undefined || card.w !== undefined)) { fm[Frontmatter.CardLayout] = card; }
      else { delete fm[Frontmatter.CardLayout]; }
    });
  }
}
