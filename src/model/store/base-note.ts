import { App, normalizePath } from "obsidian";
import type { ChildEntry, ChildLinkSection } from "../project/child-links";
import {
  addChildLink, readChildLinkBoxes, removeChildLink, setChildLinkBoxes, syncChildLinks,
} from "../project/child-links";
import { resolveFile, touch } from "../operations/file-helpers";
import { Frontmatter } from "../project/frontmatter";
import type { CardLayout } from "../project/card-layout";
import type { ProjectTaskNote } from "./project-task-note";
import type { VaultData } from "./vault-data";

/** The little every kind of note's reading has in common: where its card was left, which is
 *  the one field written without going through what the note is. */
export interface NoteFields {
  card?: CardLayout;
}

/** Whether a field already says that: dates by the instant, lists by their members. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return false;
}

/** A write nobody was waiting on failed. Logged rather than shown: what the note holds is
 *  dropped either way, so the read that follows takes the file's own answer back. */
function writeFailed(filePath: string, error: unknown): void {
  console.error(`pm-compass: couldn't write ${filePath}`, error);
}

/**
 * A note listing others as a `- [ ] [[child]]` checklist — a project's `## Tasks`, a task's
 * `## Subtasks`. They differ only in the section and where the children sit.
 *
 * One of these per path, held by the store that reads the folder, and the one place a note's
 * fields are kept: `F` is what this kind of note parses to. A note the store has yet to read
 * — built from a path alone, to write to — holds none until it is filled.
 */
export abstract class BaseNote<F extends NoteFields = NoteFields> {
  readonly filePath: string;
  /** Everything the plugin holds, and so the way to every other note this one works with. */
  protected readonly vault: VaultData;
  protected readonly app: App;
  /** What the folder last read this note as. */
  protected fields: F | null = null;

  constructor(vault: VaultData, filePath: string) {
    this.vault = vault;
    this.app = vault.app;
    this.filePath = filePath;
  }

  /** Takes a fresh reading of this note, replacing whatever the last one said. */
  fill(fields: F): void {
    this.fields = fields;
  }

  /** What this note reads as. Only ever asked of one the store has read. */
  snapshot(): F {
    if (!this.fields) throw new Error(`Note not read: ${this.filePath}`);
    return this.fields;
  }

  // ── Setting a field, and the write that follows ──────────────────────────

  /** The fields set since the last write, each owed to the file. */
  private readonly owed = new Map<keyof F, F[keyof F]>();
  /** The writes so far, chained: two passes over one file must not interleave. Never
   *  rejects, so a failed write doesn't poison the ones after it. */
  private tail: Promise<void> = Promise.resolve();
  /** The write in the air, which is what a caller waits on. Rejects as the write did. */
  private inFlight: Promise<void> | null = null;
  private running = 0;
  private queued = false;

  /**
   * Whether this note is ahead of its file — something set and not yet written, or a write
   * still in the air. What the file says is then the older answer, so the store leaves a
   * dirty note's fields alone rather than reading over them.
   */
  get isDirty(): boolean {
    return this.owed.size > 0 || this.inFlight !== null;
  }

  /** The write in the air, for a caller that wants to wait without asking for one. */
  get saved(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  /**
   * Sets one field and owes the file the change — or does nothing, when the note already
   * says that. A note the store has yet to read can't say, and so always owes it.
   *
   * The write itself follows on the next microtask, so everything set in one turn lands in
   * a single pass over the file. `flush` is how a caller waits for it; one that doesn't
   * wait still gets the write, it just has nowhere to hear that it failed.
   */
  set<K extends keyof F>(field: K, value: F[K]): void {
    if (this.fields) {
      if (sameValue(this.fields[field], value)) return;
      this.fields[field] = value;
    }
    this.owed.set(field, value);
    // At once, so a reading a view memoized on is dropped before it draws again.
    this.vault.invalidate([this.filePath]);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      void this.flush().catch((error: unknown) => writeFailed(this.filePath, error));
    });
  }

  /** Everything set so far, on the file. Rejects with whatever the write threw. */
  flush(): Promise<void> {
    if (this.owed.size === 0) return this.saved;
    this.running++;
    const run = this.tail.then(() => this.writeOwed()).finally(() => {
      if (--this.running === 0) this.inFlight = null;
    });
    this.tail = run.catch(() => {});
    this.inFlight = run;
    return run;
  }

  private async writeOwed(): Promise<void> {
    // Taken before the write rather than after, so a field set while it runs is owed to the
    // next pass instead of being dropped with this one.
    const owed = new Map(this.owed);
    this.owed.clear();
    if (owed.size === 0) return;
    await this.writeFields(owed);
    this.vault.invalidate([this.filePath]);
  }

  /** Those fields onto the file, each as its own frontmatter spells it. */
  protected abstract writeFields(owed: ReadonlyMap<keyof F, F[keyof F]>): Promise<void>;

  /** Rewrites this note's frontmatter and stamps `updatedAt`: what a change to the note
   *  itself goes through, as against where its card was left. */
  protected async editFrontmatter(mutate: (fm: Record<string, unknown>) => void): Promise<void> {
    await this.writeFrontmatter((fm) => {
      mutate(fm);
      touch(fm);
    });
  }

  protected get tfile() {
    return resolveFile(this.app, this.filePath);
  }

  /** Which frontmatter list and heading hold this note's children. */
  protected abstract get childSection(): ChildLinkSection;

  /** The folder the children's own notes live in. */
  protected abstract get childFolder(): string;

  /** The child note at that path — always a task note, whichever kind of parent this is. */
  protected childNote(filePath: string): ProjectTaskNote {
    return this.vault.taskNotes.note(filePath);
  }

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
    // Onto the reading as well, so a render before the folder is read again draws the card
    // where it was just put rather than where it was. Only once the write has landed: what
    // this note says has to be what the file says.
    if (this.fields) this.fields.card = card ?? undefined;
    this.vault.invalidate([this.filePath]);
  }
}
