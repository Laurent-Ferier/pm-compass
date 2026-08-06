import { App, FrontMatterCache, TFile, parseYaml } from "obsidian";
import { resolveFile, splitFrontmatterBody } from "../operations/file-helpers";
import type { BaseNote, NoteFields } from "./base-note";
import { NoteCache, folderNoteFiles, isFolderNotePath } from "./note-cache";
import type { VaultData } from "./vault-data";

/**
 * The machinery every store over a folder of notes shares: which files under it are worth
 * opening, where a note's frontmatter comes from, and the caches the parsed notes and the
 * note objects are held in. `ProjectNoteStore` and `ProjectTaskNoteStore` are the two that
 * build on it. The per-path holding underneath is `NoteCache`'s.
 */

/**
 * So a note or a task can only come from the store that goes on holding it: the value
 * never leaves this module, leaving no way to construct one that the store won't refresh.
 */
const STORE_KEY = Symbol("pm-compass store");
export type StoreKey = typeof STORE_KEY;

/** What a store holds one of per note: whatever that note parsed to. */
interface StoredNote {
  id: string;
  filePath: string;
}

/**
 * One note's frontmatter. The metadata cache answers it, since that is what Obsidian's own
 * change events are about — falling back to the file when the cache has nothing, which is
 * the gap where a note has just been created and not yet reparsed. `force` reads the file
 * regardless: what the cache holds is Obsidian's reading of the last version it got round
 * to, so a read landing just after a write sees the note as it was, not as it is.
 */
async function noteFrontmatter(app: App, file: TFile, force = false): Promise<FrontMatterCache | null> {
  if (!force) {
    const cached = app.metadataCache.getFileCache(file)?.frontmatter;
    if (cached) return cached;
  }
  const { frontmatterBlock } = splitFrontmatterBody(await app.vault.cachedRead(file));
  if (!frontmatterBlock) return null;
  try {
    const parsed: unknown = parseYaml(frontmatterBlock.replace(/^\s*---\r?\n/, "").replace(/---\r?\n?$/, ""));
    // A YAML list or scalar parses fine and names no fields; only a mapping is frontmatter.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Frontmatter Obsidian itself can't parse names no task; the note is simply skipped.
    return null;
  }
}

/**
 * One kind of note under a folder, held as it was last parsed. The store holds one entry
 * per note, so a change to one file re-reads that file and nothing else. The re-read
 * happens inside `entries()` — see `NoteCache` for why that is what makes it correct.
 */
export abstract class NoteStore<F extends NoteFields, N extends BaseNote<F>, T extends StoredNote> extends NoteCache<T> {
  /** The only `StoreKey` there is, so only a store can make a note or a task. */
  protected readonly key: StoreKey = STORE_KEY;
  /** The note object for a path, kept so every ask gets the same one — it is where that
   *  note's fields live, so a second one would be a second answer to what the file says. */
  private readonly handles = new Map<string, N>();
  /** Whether the folder walk has happened; until it has, the marks say nothing useful. */
  private walked = false;
  private cached: T[] | null = null;

  constructor(protected readonly vault: VaultData, private folder: string) {
    super(vault.app);
  }

  /** One note's frontmatter read as this store's own fields, or null when the note is not
   *  one of its kind. */
  protected abstract parseFields(file: TFile, fm: FrontMatterCache): F | null;

  /** A note object over that path, for `note` to hand out and keep. */
  protected abstract makeNote(filePath: string): N;

  /** The value a filled note reads as — what this store holds one of per note, and hands
   *  out. Built fresh each time the note is read, the note being the thing that lasts. */
  protected abstract wrap(note: N): T;

  /**
   * The note at that path, made on the first ask and kept. The same object every time, so
   * nothing outside a store ever builds a note — and so what a note holds has one home.
   */
  note(filePath: string): N {
    const kept = this.handles.get(filePath);
    if (kept) return kept;
    const made = this.makeNote(filePath);
    this.handles.set(filePath, made);
    return made;
  }

  /** A note's frontmatter read onto the note itself, and the value it now reads as. */
  private parseNote(file: TFile, fm: FrontMatterCache): T | null {
    const fields = this.parseFields(file, fm);
    if (!fields) return null;
    const note = this.note(file.path);
    // A note owing the file a write of its own is ahead of it; what it holds stands, and
    // the read that follows the write takes the file's answer back.
    if (!note.isDirty) note.fill(fields);
    return this.wrap(note);
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
    this.handles.clear();
    this.walked = false;
  }

  /** Whether this path is one of ours, and so worth telling the store about. */
  owns(path: string): boolean {
    return isFolderNotePath(path, this.folder);
  }

  override drop(path: string): boolean {
    if (!super.drop(path)) return false;
    this.handles.delete(path);
    return true;
  }

  /** The reading `entries` hands back stands until something changes, and every change
   *  comes through here. */
  protected override invalidated(): void {
    this.cached = null;
  }

  /** Everything of this kind in the folder, re-reading whatever has changed since the last
   *  call. The result is held until something does change, so repeated reads hand back the
   *  same array — which is what lets a consumer memoize on its identity. */
  protected async entries(): Promise<T[]> {
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
  protected syncEntries(): T[] {
    if (!this.walked) this.walkSync();
    else this.reparseStaleSync();
    return (this.cached ??= this.snapshot());
  }

  /** The note at that path as it now reads, or null when the folder holds none there —
   *  a path outside it, a note of the other kind, a duplicate of one already kept. */
  protected async entry(filePath: string): Promise<T | null> {
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
    // A note with a write of its own still in the air is read once it lands: the file is
    // about to say something else, and reading it now would take the change back.
    await Promise.all(paths.map((path) => this.note(path).saved.catch(() => {})));
    const parsed = await Promise.all(owed.map(async ([path, fromWrite]) => {
      const file = resolveFile(this.app, path);
      return file ? await this.parse(file, fromWrite) : null;
    }));
    for (const [i, entry] of parsed.entries()) {
      // A note that no longer parses as this kind — its frontmatter edited away, the file
      // gone, another store's now — leaves the folder as far as this one is concerned.
      if (entry) this.keep(entry.filePath, entry);
      else this.forget(paths[i]);
    }
    this.cached = null;
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
      const entry = file ? this.parseSync(file) : null;
      // As in `reparseStale`: a note that no longer parses as this kind leaves the folder.
      if (entry) this.keep(entry.filePath, entry);
      else this.forget(path);
    }
    this.cached = null;
  }

  private parseSync(file: TFile): T | null {
    if (this.claimedElsewhere(file.path)) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return fm ? this.parseNote(file, fm) : null;
  }

  private async parse(file: TFile, force = false): Promise<T | null> {
    if (this.claimedElsewhere(file.path)) return null;
    const fm = await noteFrontmatter(this.app, file, force);
    return fm ? this.parseNote(file, fm) : null;
  }

  /** The entries as one reading of the folder, built fresh each time it changes. */
  private snapshot(): T[] {
    const kept: T[] = [];
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
