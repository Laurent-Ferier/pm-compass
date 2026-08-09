import { App } from "obsidian";
import type { IModel, NoteModel } from "../i-model";
import { resolveFile } from "../file-helpers";
import { Frontmatter, touch } from "../project/frontmatter";
import type { CardLayout } from "../project/card-layout";
import type { VaultData } from "../service/vault-data";

/** The little every kind of note's reading has in common: where its card was left, which is
 *  the one field written without going through what the note is. */
export interface FileFields {
  card?: CardLayout;
}

/** All a note asks of the store that made it: somewhere to say its file wants re-reading.
 *  Structural, so the stores satisfy it by having the method and this layer names none of
 *  them — which store announces a path is the store's own business. */
export interface NoteCache {
  invalidate(path: string): void;
}

/** Whether a field already says that: dates by the instant, lists by their members — each
 *  compared as a field in its own right, a listing's being boxes — and a record such as a
 *  card layout by its own. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
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

/** A write nobody was waiting on failed. Logged rather than shown: what the file holds is
 *  dropped either way, so the read that follows takes the vault's own answer back. */
function writeFailed(filePath: string, error: unknown): void {
  console.error(`pm-compass: couldn't write ${filePath}`, error);
}

/** One field owed to the file: what to put there, spelled the way that note's own
 *  frontmatter wants it — which is `writeOwed`'s to know. */
export interface FieldEdit<Fields> {
  field: keyof Fields;
  value: Fields[keyof Fields];
}

/**
 * The file behind one note of the vault: what this plugin reads out of it and writes back.
 * It holds none of what the note says — that is the reader's, which this hands each fresh
 * reading to. `Fields` is what this kind of note parses to.
 *
 * One of these per path, held by the store that reads that part of the vault.
 *
 * The `- [ ] [[child]]` listing below is a project's `## Tasks` and a task's `## Subtasks`,
 * which differ only in the section and where the children sit. A day note lists nothing and
 * leaves that half alone.
 *
 * `Edit` is what one change owed to the vault looks like — what `owe` gathers and `writeOwed`
 * applies. A file whose fields are frontmatter owes field edits, which is the default and
 * what a model owes as it sets one; one whose content is a list of lines owes edits of its
 * own kind (`TaskIO`'s `LineEdit`), and gathers them itself.
 *
 * `Note` is the model this hands its readings to, a plain `NoteModel` unless the file asks
 * more of it — a listing note's model also holds the listing, which is `ListingIO`'s to say.
 */
export abstract class BaseIO<
  Fields extends FileFields = FileFields,
  Edit = FieldEdit<Fields>,
  Note extends NoteModel<Fields> = NoteModel<Fields>,
> {
  readonly filePath: string;
  /** Everything the plugin holds, and so the way to every other note this one works with. */
  protected readonly vault: VaultData;
  /** The store this note was made by, as far as this note needs it. */
  private readonly cache: NoteCache;

  constructor(cache: NoteCache, vault: VaultData, filePath: string) {
    this.cache = cache;
    this.vault = vault;
    this.filePath = filePath;
  }

  /** The app the vault is over, which is what every read and write of the file goes through. */
  protected get app(): App {
    return this.vault.app;
  }

  /**
   * Hands the note's reader a fresh reading of the file — the whole of it, listing included.
   * Whether that moved anything is the reader's to say, it being where the last one is kept.
   *
   * Nothing for a file no reader has yet: what a note says is held by the model over it, so
   * a reading with nothing to take it is a reading nobody asked for.
   */
  fill(fields: Fields): void {
    this.note?.take(fields);
  }

  /** Owes the store holding this note a re-read of it, the vault being about to say — or
   *  having just said — something else. */
  protected markStale(): void {
    this.cache.invalidate(this.filePath);
  }

  // ── The models reading it ────────────────────────────────────────────────
  //
  // A file holds no meaning of its own: what the plugin makes of the note lives in the
  // models attached here, and this is what tells them the file has moved.

  private readonly models = new Set<IModel>();
  /** The model over the whole note, which is where its reading is kept. Null for a file
   *  nothing has read yet — one built to write to, and never asked what it says. */
  protected note: Note | null = null;

  /** Registers a model over this file. A model does this for itself as it is built. */
  attach(model: IModel): void {
    this.models.add(model);
  }

  /** Registers the model that takes the whole reading, as against one holding a slice of
   *  it. One per file: a second would be a second answer to what the note says. */
  attachNote(model: Note): void {
    this.note = model;
    this.attach(model);
  }

  detach(model: IModel): void {
    this.models.delete(model);
  }

  /** The models over this file, as a list to walk: a copy, so one detaching itself doesn't
   *  disturb the pass. */
  protected attached(): IModel[] {
    return [...this.models];
  }

  /** Every model over this file. One holding a slice of it wakes only what moved — see
   *  `TaskIO`. */
  protected wake(): void {
    for (const model of this.attached()) model.refresh();
  }

  /** The file is gone: every model over it is told, and nothing reads it again. What each
   *  holds stands — the last thing the note said. */
  gone(): void {
    for (const model of [...this.models]) model.discard();
    this.models.clear();
    this.note = null;
  }

  // ── The changes owed to the file, and the write that lands them ──────────

  /** The edits gathered since the last write, each owed to the vault, by the key that says
   *  which change it is — a second edit of the same thing replaces the first. */
  private readonly owed = new Map<string, Edit>();
  /** The writes so far, chained: two passes over one file must not interleave. Never
   *  rejects, so a failed write doesn't poison the ones after it. */
  private tail: Promise<void> = Promise.resolve();
  /** The write in the air, which is what a caller waits on. Rejects as the write did. */
  private inFlight: Promise<void> | null = null;
  private running = 0;
  private queued = false;

  /**
   * Whether this is ahead of the vault — something set and not yet written, or a write still
   * in the air. What is on disk is then the older answer, so the store keeps a dirty file's
   * reading from its models rather than handing them the vault's older one.
   */
  get isDirty(): boolean {
    return this.owed.size > 0 || this.inFlight !== null;
  }

  /** The write in the air, for a caller that wants to wait without asking for one. */
  get saved(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  /**
   * Gathers one change, keyed so a second of the same kind replaces it rather than queueing
   * behind it. What the note now says is the reader's, which has already taken it — this is
   * only the vault's half of the change.
   *
   * The write itself follows on the next microtask, so everything owed in one turn lands in
   * a single pass over the file. `flush` is how a caller waits for it; one that doesn't
   * wait still gets the write, it just has nowhere to hear that it failed.
   */
  owe(key: string, edit: Edit): void {
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

  /** Everything set so far, onto the vault. Rejects with whatever the write threw. */
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
  protected abstract writeOwed(owed: readonly Edit[]): Promise<void>;

  /** Rewrites the note's frontmatter and stamps `updatedAt`: what a change to the note
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

  /** Rewrites the note's frontmatter, stamping nothing. Throws when the file is gone: every
   *  caller was handed the path by something that had just read it. */
  protected async writeFrontmatter(mutate: (fm: Record<string, unknown>) => void): Promise<void> {
    const file = this.tfile;
    if (!file) throw new Error(`File not found: ${this.filePath}`);
    await this.app.fileManager.processFrontMatter(file, mutate);
  }

  /**
   * Writes where the note's card was left in the graph and how big it was made. Both kinds of
   * note carry one: a project has a card among the projects, a task among its siblings.
   *
   * The whole of it: `cardLayout` says everything about how the card is drawn, so the caller
   * hands over what it should now say, and an empty one — nothing left worth storing — drops
   * the key. Where a card sits is not an edit of the note, so `updatedAt` is left alone:
   * nudging the drawing must not move a note up a list sorted by it.
   *
   * The reading is the model's to move, once this has landed — see `Project.moveCard`.
   */
  async writeCard(card: CardLayout | null): Promise<void> {
    await this.writeFrontmatter((fm) => {
      if (card && (card.x !== undefined || card.w !== undefined)) { fm[Frontmatter.CardLayout] = card; }
      else { delete fm[Frontmatter.CardLayout]; }
    });
    this.markStale();
  }
}
