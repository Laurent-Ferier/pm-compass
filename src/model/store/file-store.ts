import { App, CachedMetadata, FrontMatterCache, TFile, parseYaml } from "obsidian";
import { resolveFile, splitFrontmatterBody } from "../operations/file-helpers";
import type { IModel } from "../i-model";
import type { ListingFields, ListingIO } from "../io/listing-io";
import { FileCache, folderNoteFiles, isFolderNotePath } from "./file-cache";
import type { VaultData } from "../service/vault-data";

/**
 * The machinery every store over a folder of notes shares: which files under it are worth
 * opening, where a note's frontmatter comes from, and the caches the models and the files
 * behind them are held in. `ProjectStore` and `ProjectTaskStore` are the two that build on
 * it. The per-path holding underneath is `FileCache`'s.
 */

/**
 * So a note or a task can only come from the store that goes on holding it: the value
 * never leaves this module, leaving no way to construct one that the store won't refresh.
 */
const STORE_KEY = Symbol("pm-compass store");
export type StoreKey = typeof STORE_KEY;

/** What a store holds one of per note: whatever that note parsed to, which is a model over
 *  it — the store tells the views by way of the ones a re-reading wakes. */
interface StoredModel extends IModel {
  filePath: string;
}

/** One note as this store reads it: the frontmatter its fields come from, and the cache its
 *  listing is read out of — null where Obsidian has yet to build one. */
interface NoteMetadata {
  fm: FrontMatterCache;
  cache: CachedMetadata | null;
}

/**
 * One note's frontmatter, and the rest of Obsidian's reading of it alongside. The metadata
 * cache answers both, since that is what Obsidian's own change events are about — falling
 * back to the file for the frontmatter when the cache has nothing, which is the gap where a
 * note has just been created and not yet reparsed. `force` reads the file regardless: what
 * the cache holds is Obsidian's reading of the last version it got round to, so a read
 * landing just after a write sees the note as it was, not as it is.
 *
 * The cache is handed back either way. On the forced path it is behind the file by exactly
 * the write that forced the read — but that write was to the frontmatter, and a stale
 * listing is a better reading than no listing at all.
 */
async function noteMetadata(app: App, file: TFile, force = false): Promise<NoteMetadata | null> {
  const cache = force ? null : app.metadataCache.getFileCache(file);
  if (cache?.frontmatter) return { fm: cache.frontmatter, cache };

  const { frontmatterBlock } = splitFrontmatterBody(await app.vault.cachedRead(file));
  if (!frontmatterBlock) return null;
  try {
    const parsed: unknown = parseYaml(frontmatterBlock.replace(/^\s*---\r?\n/, "").replace(/---\r?\n?$/, ""));
    // A YAML list or scalar parses fine and names no fields; only a mapping is frontmatter.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { fm: parsed, cache: force ? app.metadataCache.getFileCache(file) : null };
  } catch {
    // Frontmatter Obsidian itself can't parse names no task; the note is simply skipped.
    return null;
  }
}

/**
 * One kind of note under a folder, held as it was last parsed. The store holds one entry
 * per note, so a change to one file re-reads that file and nothing else. The re-read
 * happens inside `entries()` — see `FileCache` for why that is what makes it correct.
 *
 * Every note it holds lists children — the projects folder holds nothing else — so a
 * reading here is always frontmatter plus a listing. `TaskFileStore` reads the other kind of
 * note and builds on `FileCache` directly.
 */
export abstract class FileStore<
  Fields extends ListingFields, NoteIO extends ListingIO<Fields>, Model extends StoredModel,
> extends FileCache<Model> {
  /** The only `StoreKey` there is, so only a store can make a project or a task. */
  protected readonly key: StoreKey = STORE_KEY;
  /** The file behind each path, kept so every ask gets the same one — it is where that
   *  note's fields live, so a second one would be a second answer to what the file says. */
  private readonly files = new Map<string, NoteIO>();
  /** The model over each file, made on the first reading and kept. One object per note, so
   *  what the plugin passes around is the reading the file goes on waking rather than a copy
   *  of what it said once. */
  private readonly models = new Map<string, Model>();
  /** Whether the folder walk has happened; until it has, the marks say nothing useful. */
  private walked = false;
  private cached: Model[] | null = null;

  constructor(protected readonly vault: VaultData, private folder: string) {
    super(vault.app);
  }

  /** One note's frontmatter read as this store's own fields, or null when the note is not
   *  one of its kind. */
  protected abstract parseFields(file: TFile, fm: FrontMatterCache): Fields | null;

  /** The file behind that path, for `file` to hand out and keep. */
  protected abstract makeFile(filePath: string): NoteIO;

  /** The model a filled file reads as — what this store holds one of per note, and hands
   *  out. Built once, on the first reading; `model` is what keeps it. */
  protected abstract wrap(noteFile: NoteIO): Model;

  /**
   * The file behind that path, made on the first ask and kept. The same object every time,
   * so nothing outside a store ever builds one — and so what it holds of the note has a
   * single home.
   */
  file(filePath: string): NoteIO {
    const kept = this.files.get(filePath);
    if (kept) return kept;
    const made = this.makeFile(filePath);
    this.files.set(filePath, made);
    return made;
  }

  /** The model over that file, made on the first reading and kept — the file wakes it from
   *  then on. */
  protected model(noteFile: NoteIO): Model {
    const kept = this.models.get(noteFile.filePath);
    if (kept) return kept;
    const made = this.wrap(noteFile);
    this.models.set(noteFile.filePath, made);
    return made;
  }

  /**
   * The model a note just written reads as, filled from what was written rather than read
   * back — so a caller that has just made one has it before Obsidian gets round to the file.
   * The path is marked with it, which is what puts the note in the folder's own reading.
   */
  adopt(fields: Fields): Model {
    const noteFile = this.file(fields.filePath);
    noteFile.fill(fields);
    this.invalidate(fields.filePath);
    return this.model(noteFile);
  }

  /** A note's frontmatter read onto the file that holds it, and the model it now reads as.
   *  The listing comes with it: a note that lists children holds its boxes as it holds its
   *  fields, so a box ticked by hand is a reading that moved rather than body text nobody
   *  was watching. */
  private parseNote(file: TFile, fm: FrontMatterCache, cache: CachedMetadata | null): Model | null {
    const fields = this.parseFields(file, fm);
    if (!fields) return null;
    const noteFile = this.file(file.path);
    fields.listing = noteFile.readListing(cache);
    // A file owing a write of its own is ahead of the vault; what it holds stands, and the
    // read that follows the write takes the file's answer back.
    if (!noteFile.isDirty) noteFile.fill(fields);
    return this.model(noteFile);
  }

  /** A note another store has already claimed, and so not worth opening here. Nothing is
   *  claimed by default. */
  protected claimedElsewhere(_path: string): boolean {
    return false;
  }

  /** Re-points at another folder, dropping what the last one held. */
  retarget(folder: string): void {
    if (folder === this.folder) return;
    this.folder = folder;
    this.clear();
  }

  override clear(): void {
    super.clear();
    for (const path of [...this.files.keys()]) this.discardFile(path);
    this.walked = false;
  }

  /** Whether this path is one of ours, and so worth telling the store about. */
  owns(path: string): boolean {
    return isFolderNotePath(path, this.folder);
  }

  /** Every note file under the folder, whether or not this store reads it as its own kind —
   *  for a pass that has to account for the ones it doesn't. */
  protected folderFiles(): TFile[] {
    return folderNoteFiles(this.app, this.folder);
  }

  override drop(path: string): boolean {
    if (!super.drop(path)) return false;
    this.discardFile(path);
    return true;
  }

  /** A note the folder no longer holds — gone, or no longer of this kind. The models over
   *  it are told, and nothing here points at it again. */
  private discardFile(path: string): void {
    this.files.get(path)?.gone();
    this.files.delete(path);
    this.models.delete(path);
  }

  /** The reading `entries` hands back stands until something changes, and every change
   *  comes through here. */
  protected override invalidated(): void {
    this.cached = null;
  }

  /** Everything of this kind in the folder, re-reading whatever has changed since the last
   *  call. The result is held until something does change, so repeated reads hand back the
   *  same array — which is what lets a consumer memoize on its identity. */
  protected async entries(): Promise<Model[]> {
    if (!this.walked) await this.walk();
    else await this.reparseStale();
    return (this.cached ??= this.snapshot());
  }

  /**
   * The same reading as `entries`, taken without awaiting anything: the metadata cache
   * answers every note, and one it has yet to reach is left out until it does.
   *
   * Sound for the notes this plugin writes, because a write goes through the store that
   * holds them — so by the time anything asks, the cache has been told. A caller wanting
   * the file itself, whatever Obsidian has got round to, wants `entries`.
   */
  protected syncEntries(): Model[] {
    if (!this.walked) this.walkSync();
    else this.reparseStaleSync();
    return (this.cached ??= this.snapshot());
  }

  /** The note at that path as it now reads, or null when the folder holds none there —
   *  a path outside it, a note of the other kind, a duplicate of one already kept. */
  protected async entry(filePath: string): Promise<Model | null> {
    return (await this.entries()).find((e) => e.filePath === filePath) ?? null;
  }

  /** Every note in the folder, read at once: the reads don't depend on each other, and on
   *  a cold metadata cache this is every file in it. */
  private async walk(): Promise<void> {
    const folder = this.folder;
    const files = folderNoteFiles(this.app, folder);
    const parsed = await Promise.all(files.map((f) => this.parse(f)));
    // The settings can name another folder while this one is being read; what it found
    // then belongs to a folder the store has left.
    if (folder !== this.folder) return;
    this.forgetAll();
    for (const entry of parsed) if (entry) this.keep(entry.filePath, entry);
    this.clearStale();
    this.walked = true;
    this.cached = null;
  }

  private async reparseStale(): Promise<void> {
    if (!this.hasStale()) return;
    const owed = this.takeStale();
    const paths = owed.map(([path]) => path);
    // A file with a write of its own still in the air is read once it lands: it is about to
    // say something else, and reading it now would take the change back.
    await Promise.all(paths.map((path) => this.file(path).saved.catch(() => {})));
    const parsed = await Promise.all(owed.map(async ([path, fromWrite]) => {
      const file = resolveFile(this.app, path);
      return file ? await this.parse(file, fromWrite) : null;
    }));
    for (const [i, entry] of parsed.entries()) this.landed(paths[i], entry);
    this.cached = null;
  }

  /**
   * Re-parses one note now rather than at the next read — for a store handed a note's text
   * as the vault event lands, the metadata cache holding that reading already. Waking the
   * models over it here is what lets the store tell the views that the note moved rather
   * than only that its path was touched.
   *
   * Nothing before the folder has been walked: nothing has read it, so there is nothing to
   * keep in step. Nothing either for a note owed a read off the file — a write of the
   * plugin's own, which only the lazy read can answer.
   */
  reparseNow(path: string): void {
    if (!this.walked || this.owedFromFile(path)) return;
    const file = resolveFile(this.app, path);
    this.unstale(path);
    this.landed(path, file ? this.parseSync(file) : null);
    this.cached = null;
  }

  /**
   * Keeps what a re-parse landed. A note that no longer parses as this kind — its
   * frontmatter edited away, the file gone, another store's now — leaves the folder as far
   * as this one is concerned.
   *
   * A note that has just arrived is told about from here: its model is built as the note is
   * filled, so nothing was yet awake to say that the reading moved.
   */
  private landed(path: string, entry: Model | null): void {
    if (!entry) { this.forget(path); this.discardFile(path); return; }
    const arrived = !this.holds(path);
    this.keep(entry.filePath, entry);
    if (arrived) this.changed(entry);
  }

  /** The folder walked off the metadata cache alone — `walk` without the awaiting. */
  private walkSync(): void {
    const parsed = folderNoteFiles(this.app, this.folder).map((f) => this.parseSync(f));
    this.forgetAll();
    for (const entry of parsed) if (entry) this.keep(entry.filePath, entry);
    this.clearStale();
    this.walked = true;
    this.cached = null;
  }

  private reparseStaleSync(): void {
    if (!this.hasStale()) return;
    for (const [path] of this.takeStale()) {
      const file = resolveFile(this.app, path);
      this.landed(path, file ? this.parseSync(file) : null);
    }
    this.cached = null;
  }

  private parseSync(file: TFile): Model | null {
    if (this.claimedElsewhere(file.path)) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    return cache?.frontmatter ? this.parseNote(file, cache.frontmatter, cache) : null;
  }

  private async parse(file: TFile, force = false): Promise<Model | null> {
    if (this.claimedElsewhere(file.path)) return null;
    const meta = await noteMetadata(this.app, file, force);
    return meta ? this.parseNote(file, meta.fm, meta.cache) : null;
  }

  /** The entries as one reading of the folder, built fresh each time it changes. */
  private snapshot(): Model[] {
    const kept: Model[] = [];
    // An id names one project or task, so a second file claiming it is a duplicate of that
    // note — a hand-made copy, a restored backup — and reading it would double the row.
    // Resolved by path, the entries having no order of their own.
    const seenIds = new Set<string>();

    for (const path of this.heldPaths().sort()) {
      const entry = this.held(path)!;
      if (!entry.id || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      kept.push(entry);
    }
    return kept;
  }
}
