import { App, EventRef, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { Coalescer, StoreEvent, TypedEmitter, type StoreEvents } from "./store-events";

/** How long a burst of vault events is gathered before the views hear about it. */
const COALESCE_MS = 50;

/**
 * A copy a file-syncing tool left beside the original when both ends had edits: Syncthing's
 * `.sync-conflict-<date>-<device>` and Dropbox's `(conflicted copy …)`. It carries the same
 * frontmatter `id` as the original, so reading it would put the task on the board twice.
 */
function isConflictCopy(basename: string): boolean {
  return /\.sync-conflict-\d/.test(basename) || /\(conflicted copy\b/i.test(basename);
}

function collectMdFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      if (!isConflictCopy(child.basename)) files.push(child);
    } else if (child instanceof TFolder) {
      files.push(...collectMdFiles(child));
    }
  }
  return files;
}

/** Every note under a folder worth reading. Empty when the folder is missing. */
export function folderNoteFiles(app: App, folder: string): TFile[] {
  const found = app.vault.getAbstractFileByPath(normalizePath(folder));
  return found instanceof TFolder ? collectMdFiles(found) : [];
}

/** Whether a note at this path is one the folder holds, and not a sync tool's copy of one. */
export function isFolderNotePath(path: string, folder: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (!path.startsWith(normalizePath(folder) + "/")) return false;
  return !isConflictCopy(path.slice(path.lastIndexOf("/") + 1, -".md".length));
}

/**
 * A part of the vault held one entry per note path, with the marks saying which of those
 * notes have changed since they were last parsed. `NoteStore` — the projects folder — and
 * `DayStore` — the day notes and the inbox — are the two readings built on it; what each
 * adds is which paths it claims, how a note is parsed, and when the re-read happens.
 *
 * Each store watches the vault for what `owns` says is its kind, gathers a burst of changes
 * into a single telling, and is what a view subscribes to.
 *
 * The rule that makes it trustworthy: a vault event marks a note stale *at once*, and only
 * the telling is delayed. So a read taken straight after a write — or after one of the
 * plugin's own passes — parses what it is owed before answering, whatever the coalescing
 * window is doing.
 */
export abstract class NoteCache<T> {
  private readonly byPath = new Map<string, T>();
  /** Each ref with the object that handed it out: only that one can drop it. */
  private readonly refs: { off: (ref: EventRef) => void; ref: EventRef }[] = [];
  private readonly emitter = new TypedEmitter<StoreEvents>();
  /** Paths changed since the views were last told; the coalescer holds the timer that
   *  will tell them. */
  private readonly pending = new Set<string>();
  private readonly coalescer = new Coalescer(COALESCE_MS, () => this.announce());
  /**
   * Paths whose note has changed since it was last parsed, each with whether it has to be
   * read off the file. A write of the plugin's own has to: Obsidian reparses a file it has
   * just written on its own schedule, so the metadata cache still holds the old note, and
   * the read that follows a write must see the write. A cache that always reads the file —
   * `DayStore` does — simply never asks.
   */
  private readonly stale = new Map<string, boolean>();

  constructor(protected readonly app: App) {}

  /** Whether this path is one of ours, and so worth telling the cache about. */
  abstract owns(path: string): boolean;

  /** Tells the views about what has gathered since the last window closed. */
  protected abstract announce(): void;

  /** Begins watching the vault. Reads no notes yet — the first read does that. */
  start(): void {
    const { metadataCache, vault } = this.app;
    const onMeta = { off: (r: EventRef) => metadataCache.offref(r) };
    const onVault = { off: (r: EventRef) => vault.offref(r) };
    this.refs.push(
      { ...onMeta, ref: metadataCache.on("changed", (file: TFile) => this.onTouched(file.path)) },
      { ...onVault, ref: vault.on("modify", (file: TAbstractFile) => this.onTouched(file.path)) },
      { ...onVault, ref: vault.on("create", (file: TAbstractFile) => this.onTouched(file.path)) },
      { ...onVault, ref: vault.on("delete", (file: TAbstractFile) => this.onGone(file.path)) },
      {
        ...onVault,
        ref: vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          this.onGone(oldPath);
          this.onTouched(file.path);
        }),
      },
    );
  }

  /** Stops watching the vault, and tells no one anything more. What has been read stays
   *  read. */
  dispose(): void {
    for (const { off, ref } of this.refs) off(ref);
    this.refs.length = 0;
    this.coalescer.cancel();
    this.emitter.clear();
  }

  on<K extends StoreEvent>(event: K, handler: (payload: StoreEvents[K]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  /** Marks the notes a write of the plugin's own touched, so the read that follows it
   *  parses them again — off the files, the metadata cache still holding what they said
   *  before — rather than racing the vault's own event. */
  invalidate(paths: string[]): void {
    // Marked here rather than through the watching, so a write before `start` still says so.
    for (const path of paths) if (this.touch(path, true)) this.mark(path);
  }

  /** A vault event never comes from a write of the plugin's own — those go through
   *  `touch` — so the metadata cache is trusted for it. */
  private onTouched(path: string): void {
    if (this.touch(path)) this.mark(path);
  }

  private onGone(path: string): void {
    if (this.drop(path)) this.mark(path);
  }

  protected emit<K extends StoreEvent>(event: K, payload: StoreEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  /** Files a path for the next telling. */
  protected mark(path: string): void {
    this.pending.add(path);
    this.schedule();
  }

  /** Opens the window the next telling goes out at the end of, for a subclass filing a
   *  change that is not a path of its own. */
  protected schedule(): void {
    this.coalescer.schedule();
  }

  /** The paths gathered since the last telling, cleared as they are taken. */
  protected takePending(): string[] {
    const paths = [...this.pending];
    this.pending.clear();
    return paths;
  }

  /** Whether this path last parsed as one of ours. */
  holds(path: string): boolean {
    return this.byPath.has(path);
  }

  /** Marks a note for re-reading. `fromWrite` says the plugin wrote it, which is what
   *  decides whether the metadata cache can be trusted for it. Returns whether it was
   *  ours to mark. */
  touch(path: string, fromWrite = false): boolean {
    if (!this.owns(path)) return false;
    this.stale.set(path, fromWrite || (this.stale.get(path) ?? false));
    this.invalidated();
    return true;
  }

  /** Forgets a note that has gone. Returns whether it was ours. */
  drop(path: string): boolean {
    if (!this.owns(path)) return false;
    this.byPath.delete(path);
    this.stale.delete(path);
    this.invalidated();
    return true;
  }

  /** Forgets every note read so far. */
  clear(): void {
    this.byPath.clear();
    this.stale.clear();
    this.invalidated();
  }

  /** Told whenever what the cache holds may have changed, for a subclass keeping anything
   *  built from it. Nothing is kept by default. */
  protected invalidated(): void {}

  // ── What a subclass reads and writes the entries through ─────────────────

  /** What this cache last parsed at that path. */
  protected held(path: string): T | undefined {
    return this.byPath.get(path);
  }

  protected keep(path: string, entry: T): void {
    this.byPath.set(path, entry);
  }

  protected forget(path: string): void {
    this.byPath.delete(path);
  }

  /** Drops the entries without touching the marks — a re-read of the whole folder, which
   *  is about to fill them again. */
  protected forgetAll(): void {
    this.byPath.clear();
  }

  /** Every path an entry is held for, in no order of its own. */
  protected heldPaths(): string[] {
    return [...this.byPath.keys()];
  }

  protected isStale(path: string): boolean {
    return this.stale.has(path);
  }

  /** Takes a path off the stale list without re-reading it — the caller is the re-read. */
  protected unstale(path: string): void {
    this.stale.delete(path);
  }

  protected hasStale(): boolean {
    return this.stale.size > 0;
  }

  /** The paths owed a re-read, each with whether it has to come off the file, cleared as
   *  they are taken. */
  protected takeStale(): [string, boolean][] {
    const owed = [...this.stale];
    this.stale.clear();
    return owed;
  }

  protected clearStale(): void {
    this.stale.clear();
  }
}
