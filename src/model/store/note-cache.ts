import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { IModel } from "../i-model";
import { Touch, Watcher } from "../io/watcher";
import { ChangeOrigin, StoreEvent, TypedEmitter, type StoreEvents } from "./store-events";

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
 * Each store holds a `Watcher` over the vault, keeps what `owns` says is its kind, and is
 * what a view subscribes to.
 *
 * The rule that makes it trustworthy: a vault event marks a note stale *at once*, and only
 * the telling is delayed. So a read taken straight after a write — or after one of the
 * plugin's own passes — parses what it is owed before answering, whatever the coalescing
 * window is doing.
 */
export abstract class NoteCache<Model> {
  private readonly byPath = new Map<string, Model>();
  private readonly emitter = new TypedEmitter<StoreEvents>();
  /** Paths changed since the views were last told, each under where its change came from;
   *  the watcher holds the window they will be told at the end of. */
  private readonly pending = new Map<string, ChangeOrigin>();
  private readonly watcher: Watcher;
  /**
   * Paths whose note has changed since it was last parsed, each with whether it has to be
   * read off the file. A write of the plugin's own has to: Obsidian reparses a file it has
   * just written on its own schedule, so the metadata cache still holds the old note, and
   * the read that follows a write must see the write. A cache that always reads the file —
   * `DayStore` does — simply never asks.
   */
  private readonly stale = new Map<string, boolean>();

  constructor(protected readonly app: App) {
    this.watcher = new Watcher(app, {
      touched: (path, kind) => this.onTouched(path, kind),
      gone: (path, renamedTo) => this.onGone(path, renamedTo),
      announce: () => this.announce(),
    });
  }

  /** Whether this path is one of ours, and so worth telling the cache about. */
  abstract owns(path: string): boolean;

  /** Tells the views about what has gathered since the last window closed. */
  protected abstract announce(): void;

  /** Begins watching the vault. Reads no notes yet — the first read does that. */
  start(): void {
    this.watcher.start();
  }

  /** Stops watching the vault, and tells no one anything more. What has been read stays
   *  read. */
  dispose(): void {
    this.watcher.dispose();
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
    for (const path of paths) if (this.touch(path, true)) this.mark(path, ChangeOrigin.Plugin);
  }

  /** A model over one of these notes says it now reads differently. Filed for the next
   *  telling, so a burst of them reaches a view as one. One over no note says nothing:
   *  there is no reading of the vault behind it to tell about. */
  changed(model: IModel): void {
    if (model.filePath !== null) this.mark(model.filePath, this.wakeOrigin);
  }

  /** Where a model waking right now comes from. A write of the plugin's own unless the store
   *  says otherwise: one that re-reads on a vault event has that read wake its models, and
   *  what they say is then news from outside. */
  protected get wakeOrigin(): ChangeOrigin {
    return ChangeOrigin.Plugin;
  }

  /** A write of the plugin's own is registered through `touch` rather than here, so the
   *  metadata cache is trusted for what this event carries. Marked stale before the event is
   *  handed on, so a store answering it reads the note as it now is rather than as it last
   *  parsed. */
  private onTouched(path: string, kind: Touch): void {
    // A write of the plugin's own comes back as a vault event too, moments later. What tells
    // the two apart is the read that write is still owed: until it is taken, an event about
    // that path is this plugin's own edit echoing back rather than news from outside.
    const echo = this.owedFromFile(path);
    if (!this.touch(path)) return;
    if (kind === Touch.Created) this.created(path);
    if (kind === Touch.Reparsed) this.reparsed(path);
    // A cache that reads as the event lands has had the models over the note say whether it
    // moved; one that reads later can only say the path was touched, which is the older and
    // noisier telling — every reparse of an unchanged note reaches a view as a change.
    if (!this.readsOnTouch) this.mark(path, echo ? ChangeOrigin.Plugin : ChangeOrigin.Vault);
  }

  /** Whether this cache takes its re-reading from the event itself rather than at the next
   *  read. One that does tells the views through the models the re-reading wakes, and so
   *  says nothing of its own here. */
  protected get readsOnTouch(): boolean {
    return false;
  }

  private onGone(path: string, renamedTo?: string): void {
    const ours = this.drop(path);
    if (ours) this.mark(path, ChangeOrigin.Vault);
    // A rename is a note that moved, not one the vault no longer holds: only a real
    // deletion leaves the notes that mention it with something to put right. Both ends are
    // named — the move is a change to the reading whatever the note now says, and the
    // event that follows carries no text to work that out from.
    if (renamedTo === undefined) this.deleted(path);
    else if (ours) this.mark(renamedTo, ChangeOrigin.Vault);
  }

  /** A note the vault no longer holds — gone rather than moved. What that costs the notes
   *  around it is the store's own; nothing by default. */
  protected deleted(_path: string): void {}

  /** One of this cache's notes, already marked, as Obsidian has just re-read it — so a store
   *  wanting its own reading in step at once can take it off the metadata cache here.
   *  Nothing by default. */
  protected reparsed(_path: string): void {}

  /** One of this cache's notes that the vault didn't hold a moment ago. Only creation:
   *  what a store does about a note appearing is rarely what it does about one changing.
   *  Nothing by default. */
  protected created(_path: string): void {}

  protected emit<K extends StoreEvent>(event: K, payload: StoreEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  /** Files a path for the next telling, under where its change came from. A vault edit
   *  outweighs a write of the plugin's own in the same window: what a view holds off for is
   *  the note being typed into, whatever else landed beside it. */
  protected mark(path: string, origin: ChangeOrigin): void {
    if (this.pending.get(path) !== ChangeOrigin.Vault) this.pending.set(path, origin);
    this.schedule();
  }

  /** Opens the window the next telling goes out at the end of, for a subclass filing a
   *  change that is not a path of its own. */
  protected schedule(): void {
    this.watcher.schedule();
  }

  /** The paths gathered since the last telling, each with where its change came from,
   *  cleared as they are taken. */
  protected takePending(): Map<string, ChangeOrigin> {
    const paths = new Map(this.pending);
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
  protected held(path: string): Model | undefined {
    return this.byPath.get(path);
  }

  protected keep(path: string, entry: Model): void {
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

  /** Whether that path is owed a read off the file rather than the metadata cache — a write
   *  of the plugin's own, which no reading of the cache can answer yet. */
  protected owedFromFile(path: string): boolean {
    return this.stale.get(path) ?? false;
  }

  /** Takes a path off the stale list without re-reading it — the caller is the re-read. */
  protected unstale(path: string): void {
    this.stale.delete(path);
  }

  /** Whether any note here is owed a re-read — for a store deciding whether to take one
   *  rather than wait on a reader that may never come. */
  hasStale(): boolean {
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
