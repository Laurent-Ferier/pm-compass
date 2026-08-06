import { App, normalizePath } from "obsidian";
import type { ChildEntry, ChildLinkSection } from "../project/child-links";
import {
  addChildLink, readChildLinkBoxes, removeChildLink, setChildLinkBoxes, syncChildLinks,
} from "../project/child-links";
import type { IModel } from "../i-model";
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

/** Whether a field already says that: dates by the instant, lists by their members, and a
 *  record — a card layout — by its own. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (isRecord(a) && isRecord(b)) return sameFields(a, b);
  return false;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && !(x instanceof Date);
}

/** Whether two readings say the same thing, field by field. */
export function sameFields(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/** A write nobody was waiting on failed. Logged rather than shown: what the note holds is
 *  dropped either way, so the read that follows takes the file's own answer back. */
function writeFailed(filePath: string, error: unknown): void {
  console.error(`pm-compass: couldn't write ${filePath}`, error);
}

/** One field owed to the file: what to put there, spelled the way that note's own
 *  frontmatter wants it — which is `writeOwed`'s to know. */
export interface FieldEdit<F> {
  field: keyof F;
  value: F[keyof F];
}

/**
 * One note of the vault, as this plugin reads and writes it.
 *
 * One of these per path, held by the store that reads that part of the vault, and the one
 * place a note's own reading is kept: `F` is what this kind of note parses to. A note the
 * store has yet to read — built from a path alone, to write to — holds none until it is
 * filled.
 *
 * The `- [ ] [[child]]` listing below is a project's `## Tasks` and a task's `## Subtasks`,
 * which differ only in the section and where the children sit. A day note lists nothing and
 * leaves that half alone.
 *
 * `E` is what a change to it is. A note whose fields are frontmatter owes field edits, which
 * is the default and what `set` gathers; one whose content is a list of lines owes edits of
 * its own kind, and gathers them itself.
 */
export abstract class BaseNote<F extends NoteFields = NoteFields, E = FieldEdit<F>> {
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

  /**
   * Takes a fresh reading of this note, replacing whatever the last one said, and wakes the
   * models over it — but only when the reading actually moved. A re-read that lands what the
   * note already held is Obsidian repeating itself, or this plugin's own write coming back,
   * and neither is anything a view has to be told about.
   */
  fill(fields: F): void {
    const moved = !this.fields || !sameFields(this.fields, fields);
    this.fields = fields;
    if (moved) this.wake();
  }

  /** Owes the store holding this note a re-read of it, the file being about to say — or
   *  having just said — something else. The projects folder by default; a note another
   *  store holds says so itself. */
  protected markStale(): void {
    this.vault.invalidate([this.filePath]);
  }

  /** What this note reads as. Only ever asked of one the store has read. */
  snapshot(): F {
    if (!this.fields) throw new Error(`Note not read: ${this.filePath}`);
    return this.fields;
  }

  // ── The models reading it ────────────────────────────────────────────────
  //
  // A note holds no meaning of its own: what the plugin makes of the file lives in the
  // models attached here, and this is what tells them the file has moved.

  private readonly models = new Set<IModel>();

  /** Registers a model over this note. A model does this for itself as it is built. */
  attach(model: IModel): void {
    this.models.add(model);
  }

  detach(model: IModel): void {
    this.models.delete(model);
  }

  /** The models over this note, as a list to walk: a copy, so one detaching itself doesn't
   *  disturb the pass. */
  protected attached(): IModel[] {
    return [...this.models];
  }

  /** Every model over this note. One holding a slice of it wakes only what moved — see
   *  `TaskNote`. */
  protected wake(): void {
    for (const model of this.attached()) model.refresh();
  }

  /** The file is gone: every model over it is told, and this note reads as nothing. */
  gone(): void {
    for (const model of [...this.models]) model.discard();
    this.models.clear();
    this.fields = null;
  }

  // ── The changes owed to the file, and the write that lands them ──────────

  /** The edits gathered since the last write, each owed to the file, by the key that says
   *  which change it is — a second edit of the same thing replaces the first. */
  private readonly owed = new Map<string, E>();
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
   * Only a note whose changes *are* field edits, which is what the `this` type says: one
   * over a list of lines owes edits of another shape and gathers them its own way.
   */
  set<K extends keyof F>(this: BaseNote<F, FieldEdit<F>>, field: K, value: F[K]): void {
    if (this.fields) {
      if (sameValue(this.fields[field], value)) return;
      this.fields[field] = value;
    }
    this.owe(String(field), { field, value });
  }

  /**
   * Gathers one change, keyed so a second of the same kind replaces it rather than queueing
   * behind it.
   *
   * The write itself follows on the next microtask, so everything owed in one turn lands in
   * a single pass over the file. `flush` is how a caller waits for it; one that doesn't
   * wait still gets the write, it just has nowhere to hear that it failed.
   */
  protected owe(key: string, edit: E): void {
    this.owed.set(key, edit);
    // At once, so a reading a view memoized on is dropped before it draws again.
    this.wake();
    this.markStale();
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
    const run = this.tail.then(() => this.runPass()).finally(() => {
      if (--this.running === 0) this.inFlight = null;
    });
    this.tail = run.catch(() => {});
    this.inFlight = run;
    return run;
  }

  private async runPass(): Promise<void> {
    // Taken before the write rather than after, so a change owed while it runs belongs to
    // the next pass instead of being dropped with this one.
    const owed = [...this.owed.values()];
    this.owed.clear();
    if (owed.length === 0) return;
    await this.writeOwed(owed);
    this.markStale();
  }

  /** Those changes onto the file, in the order they were owed, in one pass. */
  protected abstract writeOwed(owed: readonly E[]): Promise<void>;

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

  /** Which frontmatter list and heading hold this note's children. A note that lists none
   *  — a day note — never reaches this, nor anything below it. */
  protected get childSection(): ChildLinkSection {
    throw new Error(`This note lists no children: ${this.filePath}`);
  }

  /** The folder the children's own notes live in. */
  protected get childFolder(): string {
    throw new Error(`This note lists no children: ${this.filePath}`);
  }

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
    this.wake();
    this.markStale();
  }
}
