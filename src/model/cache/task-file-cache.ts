import { normalizePath } from "obsidian";
import { addDays, startOfDay } from "../dates";
import type { IModel } from "../i-model";
import type { Task } from "../daily/task";
import { DayNote } from "../daily/day-note";
import { InBox } from "../daily/inbox";
import type { DailyNotesConfig } from "../service/day-note-service";
import { FileCache } from "./file-cache";
import { ChangeOrigin, CacheEvent, originOf, type WarmedDay } from "./cache-events";
import { TaskIO } from "../io/task-io";
import type { VaultData } from "../service/vault-data";

/** Where the inbox note lives: the settings' path, else `Inbox.md` beside the day notes. */
export function resolveInboxPath(inboxFilePath: string, dnConfig: DailyNotesConfig): string {
  if (inboxFilePath) return normalizePath(inboxFilePath);
  return normalizePath(dnConfig.folder ? `${dnConfig.folder}/Inbox.md` : "Inbox.md");
}

/** How many day notes the warm-up reads at once. */
const WARM_CONCURRENCY = 8;

/** The window either side of a day, nearest-past first through farthest future — the
 *  order the rows land in. The day itself is left out: its own read covers it. */
function windowOffsets(before: number, after: number): number[] {
  return [
    ...Array.from({ length: before }, (_, i) => i - before),
    ...Array.from({ length: after }, (_, i) => i + 1),
  ];
}

/** One day note, or the inbox, flattened to what a reader that only counts lines needs —
 *  as much of a `DayNote` as the week summary asks for. */
export interface DayNoteEntry {
  path: string;
  /** The day the note stands for; null for the inbox, which belongs to no day. */
  date: Date | null;
  exists: boolean;
  /** Its top-level checklist lines, each stamped with the note it came from. */
  items: Task[];
  /** The note's lines, for a reader wanting its own reading of them. */
  lines: string[];
}

/**
 * The day notes and the inbox, held one note per path. Every note is read off the file, so
 * the mark `FileCache` carries about where a re-read comes from means nothing here.
 */
export class TaskFileCache extends FileCache<DayNote> {
  /** Whether the inbox changed since the views were last told. The day notes go through the
   *  paths `FileCache` gathers; the inbox is its own telling. */
  private pendingInbox = false;
  /** One file per path, kept: it is where that note's reading and the models over it live,
   *  so a second one would be a second answer to what the file says. */
  private readonly files = new Map<string, TaskIO>();
  /** Whether a read is taking a file's own change in. See `changed`. */
  private catchingUp = false;
  /** The path the inbox now held was read at. A difference from `inboxPath` is a note the
   *  cache has left behind, which `retarget` drops. */
  private readInbox: string;

  constructor(
    readonly vault: VaultData,
    private dailyNotes: DailyNotesConfig,
    /** What a day note appearing calls. The pass itself belongs to the cache above this
     *  one, which holds the settings the habits are read from. */
    private readonly dayArrived: (filePath: string) => void,
  ) {
    super(vault.app);
    this.readInbox = this.inboxPath;
  }

  /** The file behind that path, made on the first ask and kept. */
  file(filePath: string): TaskIO {
    const kept = this.files.get(filePath);
    if (kept) return kept;
    const made = new TaskIO(this, this.vault, filePath);
    this.files.set(filePath, made);
    return made;
  }

  override drop(path: string): boolean {
    if (!super.drop(path)) return false;
    this.files.get(path)?.gone();
    this.files.delete(path);
    return true;
  }

  override clear(): void {
    super.clear();
    for (const file of this.files.values()) file.gone();
    this.files.clear();
  }

  /** The daily-notes scheme in force. */
  get config(): DailyNotesConfig {
    return this.dailyNotes;
  }

  /** Where the inbox note lives, off the settings and the scheme in force — read on each
   *  use, so a path changed while the plugin runs is answered on at once. */
  get inboxPath(): string {
    return resolveInboxPath(this.vault.settings().inboxFilePath, this.dailyNotes);
  }

  /** Re-points at the daily-notes scheme and the inbox now in force, dropping what the last
   *  ones named: the scheme is what says which day a path is, so every reading is taken under
   *  one, and a note held at the inbox's old path is one nothing owns any more. */
  retarget(config: DailyNotesConfig): void {
    const sameScheme = config.folder === this.dailyNotes.folder && config.format === this.dailyNotes.format;
    this.dailyNotes = config;
    const inbox = this.inboxPath;
    const same = sameScheme && inbox === this.readInbox;
    this.readInbox = inbox;
    if (!same) this.clear();
  }

  /** Whether this path is a day note or the inbox, and so worth telling the cache about. */
  owns(path: string): boolean {
    return path === this.inboxPath || this.vault.dayNotes.dayOf(path, this.dailyNotes) !== null;
  }

  /** The path a day's note has, whether or not the file exists. */
  pathOf(date: Date): string {
    return this.vault.dayNotes.pathOf(date, this.dailyNotes);
  }

  /** What is held for that day right now — for a first paint that must not await. Nothing
   *  for a day whose note has changed since: what it holds is a reading the vault has left
   *  behind, and the re-read is the caller's to wait for. */
  cached(date: Date): DayNote | null {
    const path = this.pathOf(date);
    if (this.isStale(path)) return null;
    return this.held(path) ?? null;
  }

  /** Whether a day's note has been read and found there. A note the vault has touched since
   *  still counts: the file exists either way, and what changed inside it is the re-read's to
   *  say — which is what separates this from `cached`. */
  hasNote(date: Date): boolean {
    return this.held(this.pathOf(date))?.exists ?? false;
  }

  /**
   * One day's checklist, read off `filePath` when the note doesn't sit where the naming
   * scheme says — Templater can land the one it makes elsewhere.
   *
   * Reads what is there and makes nothing: creating today's note is the service's, which
   * knows whether a read means "show me today".
   */
  async day(date: Date, filePath?: string): Promise<DayNote> {
    return this.read(filePath ?? this.pathOf(date), startOfDay(date));
  }

  /** The inbox as it was last read, checked lines and all — for a caller asking a question
   *  of its lines rather than showing them. Nothing when it has never been read, or when the
   *  vault has touched it since: either way the answer is the file's, not this reading's. */
  heldInbox(): InBox | null {
    if (this.isStale(this.inboxPath)) return null;
    return (this.held(this.inboxPath) as InBox | undefined) ?? null;
  }

  /** The inbox note. Its checked lines are dropped as it is read: an inbox holds what is
   *  still to do, and a line ticked off there has been filed elsewhere already. */
  async inbox(): Promise<InBox> {
    const path = this.inboxPath;
    const note = await this.read(path, null) as InBox;
    if (!note.items.some((it) => it.checked)) return note;

    // The prune marks the note, so the read below takes the file as it now stands.
    await this.file(path).pruneChecked();
    return await this.read(path, null) as InBox;
  }

  // ── Telling the views ────────────────────────────────────────────────────

  /** Files a path under the day it is, the inbox being its own telling. */
  protected override mark(path: string, origin: ChangeOrigin): void {
    if (path !== this.inboxPath) return super.mark(path, origin);
    this.pendingInbox = true;
    this.schedule();
  }

  /**
   * A day note that has just appeared is one the vault may have moved on without: habits the
   * definitions call for, inbox items aimed at a day that now has somewhere to put them.
   *
   * Creation alone. Run on every change, the habit reconcile would rewrite a day note while
   * it is being typed into — and a note being opened is `main.ts`'s to forward, the workspace
   * being no business of the model layer's.
   */
  protected override created(path: string): void {
    this.dayArrived(path);
  }

  /**
   * A model over one of these notes says it reads differently — filed for the next telling,
   * unless a read is what woke it.
   *
   * A note is marked the moment it changes, so the views have already been told about
   * whatever the read is only now parsing. Telling them again asks a view for a second
   * rebuild of what it is drawing off that very reading.
   */
  override changed(model: IModel): void {
    if (!this.catchingUp) super.changed(model);
  }

  protected announce(): void {
    const days = this.takePending();
    const inbox = this.pendingInbox;
    this.pendingInbox = false;
    if (days.size > 0) {
      this.emit(CacheEvent.DaysChanged, { paths: [...days.keys()], origin: originOf(days.values()) });
    }
    if (inbox) this.emit(CacheEvent.InboxChanged, { path: this.inboxPath });
  }

  // ── Reading a window of days ahead of the asking ─────────────────────────

  /** Bumped by each new `warmWindow`, so the one it replaces stops delivering. */
  private warmPass = 0;

  override dispose(): void {
    super.dispose();
    this.warmPass += 1;
  }

  /** The days either side of `centre` this cache already holds — for a first paint that must
   *  not await. What is missing arrives through `DayWarmed`. */
  cachedWindow(centre: Date, before: number, after: number): WarmedDay[] {
    return windowOffsets(before, after)
      .map((offset) => ({ offset, entry: this.cached(addDays(centre, offset)) }))
      .filter((d): d is WarmedDay => d.entry !== null);
  }

  /**
   * Reads the days either side of `centre`, telling about each through `DayWarmed` as it
   * lands — deepest overdue first, farthest ahead last, which is the order the rows end up
   * in. Told as each lands rather than coalesced: a list takes its rows one at a time.
   *
   * A few at a time rather than all at once: the window runs to dozens of notes, and a
   * burst of that size stalls the first paint on a phone. Entries are held by path, so a
   * window shifted by a day re-reads one note rather than the lot.
   */
  async warmWindow(centre: Date, before: number, after: number): Promise<void> {
    const pass = ++this.warmPass;
    const offsets = windowOffsets(before, after);
    const done = new Map<number, DayNote>();
    let next = 0;

    // Read a few at a time; deliver strictly in offset order, buffering whatever finishes
    // early. `insertSorted` makes the order cosmetic, but fewer DOM moves is fewer.
    const queue = [...offsets];
    const workers = Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, async () => {
      for (let offset = queue.shift(); offset !== undefined; offset = queue.shift()) {
        const entry = await this.day(addDays(centre, offset));
        if (pass !== this.warmPass) return;
        done.set(offset, entry);
        while (next < offsets.length && done.has(offsets[next])) {
          const at = offsets[next++];
          this.emit(CacheEvent.DayWarmed, { entry: done.get(at)!, offset: at });
        }
      }
    });
    await Promise.all(workers);
    if (pass === this.warmPass) this.emit(CacheEvent.WarmupFinished, { days: offsets.length });
  }

  private async read(path: string, day: Date | null): Promise<DayNote> {
    const held = this.held(path);
    if (held && !this.isStale(path)) return held;
    this.unstale(path);

    const file = this.file(path);
    const fields = await file.read();
    // The note does the reading and the parsing, and wakes whatever holds one of its lines.
    // Built before it is filled: what a note says is the day's, so a reading taken with no
    // day over it would have nowhere to land. Taken from what is held rather than made afresh:
    // two reads of one path in flight would otherwise leave a note the file never fills.
    const note = this.held(path) ?? this.noteOver(file, day);
    this.catchingUp = true;
    try {
      file.fill(fields);
    } finally {
      this.catchingUp = false;
    }
    this.keep(path, note);
    return note;
  }

  /** The inbox is its own kind of day: it holds the project tasks nothing dates as well as
   *  its own lines. */
  private noteOver(file: TaskIO, day: Date | null): DayNote {
    return file.filePath === this.inboxPath
      ? new InBox(file, this, this.vault.projects.cache)
      : new DayNote(file, this, day);
  }
}
