import { App, normalizePath } from "obsidian";
import type { ChildEntry, ChildLinkSection } from "./operations/child-links";
import {
  addChildLink, readChildLinkBoxes, removeChildLink, setChildLinkBoxes, syncChildLinks,
} from "./operations/child-links";
import { resolveFile } from "./operations/file-helpers";
import type { ProjectTaskFile } from "./project-task-file";

/**
 * A note that lists other notes as a `- [ ] [[child]]` checklist: a project listing
 * its root tasks under `## Tasks`, a task listing its subtasks under `## Subtasks`.
 * They differ only in which section holds the list and where the children's notes
 * sit, so the listing is managed once here.
 */
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
   * Register a child: its ID in the section's frontmatter list, its checklist line
   * under the heading. Idempotent, so a partially applied move is safe to retry.
   *
   * The box follows the child's own status rather than the caller's — a stale list
   * would tick a task reopened since, and the box would then close it again.
   * `knownChecked` is for a child written moments ago, with no cache to read yet.
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

  /**
   * Push every box in this note's listing onto the task it names: a ticked one closes
   * that task, an unticked one reopens it. Only for a listing already known to agree
   * with its tasks, where a disagreeing box can only be a fresh edit. `body` is the
   * note's content as the change event handed it over.
   */
  async applyChildBoxes(body: string): Promise<void> {
    for (const { basename, checked } of readChildLinkBoxes(body, this.childSection)) {
      await this.childNote(this.childPath(basename)).applyParentBox(checked);
    }
  }

  /**
   * Rewrite every box from the status of the task it names — the opposite of
   * `applyChildBoxes`, and what a listing gets the first time it is seen. Until then a
   * disagreeing box may be a fresh tick or a note predating the sync, and answering
   * with the status is the reading that can't lose data.
   */
  async repairChildBoxes(body: string): Promise<void> {
    const fixes = new Map<string, boolean>();
    for (const { basename, checked } of readChildLinkBoxes(body, this.childSection)) {
      // Null for anything that isn't a task note — a link the user put here themselves,
      // which has no status to answer for and keeps its box.
      const done = this.childNote(this.childPath(basename)).isDone();
      if (done !== null && done !== checked) fixes.set(basename, done);
    }
    if (fixes.size > 0) await setChildLinkBoxes(this.app, this.filePath, this.childSection, fixes);
  }

  /** Make this note's whole listing agree with `children`. Reports whether it wrote. */
  async syncChildListing(children: ChildEntry[]): Promise<boolean> {
    return syncChildLinks(this.app, this.filePath, this.childSection, children, this.childFolder);
  }
}
