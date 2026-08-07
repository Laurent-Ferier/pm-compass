import { startOfDay, sameDay } from "../dates";
import type { IModel } from "../i-model";
import type { Task } from "../daily/task";
import { DaySummary } from "../daily/day-summary";
import { InBox } from "../daily/inbox";
import type { DailyNotesConfig } from "../daily/week-summary";
import { DayMarkdownFile, dayNotePath, matchDailyNotePath } from "./day-markdown-file";
import { FileCache } from "./file-cache";
import { ChangeOrigin, StoreEvent, originOf } from "./store-events";
import { TaskFile } from "../io/task-file";
import type { VaultData } from "../service/vault-data";

/** One day note, or the inbox, as the store holds it — what `DaySummary` is to a caller
 *  that only wants to read it. */
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
 * The day notes and the inbox, held one summary per path. Every note is read off the file, so
 * the mark `FileCache` carries about where a re-read comes from means nothing here.
 */
export class DayStore extends FileCache<DaySummary> {
  /** Whether the inbox changed since the views were last told. The day notes go through the
   *  paths `FileCache` gathers; the inbox is its own telling. */
  private pendingInbox = false;
  /** One file per path, kept: it is where that note's reading and the models over it live,
   *  so a second one would be a second answer to what the file says. */
  private readonly files = new Map<string, TaskFile>();
  /** Whether a read is taking a file's own change in. See `changed`. */
  private catchingUp = false;

  constructor(
    private readonly vault: VaultData,
    private dailyNotes: DailyNotesConfig,
    private inbox_: string,
    /** What a day note appearing calls. The pass itself belongs to the store above this
     *  one, which holds the settings the habits are read from. */
    private readonly dayArrived: (filePath: string) => void,
  ) {
    super(vault.app);
  }

  /** The file behind that path, made on the first ask and kept. */
  file(filePath: string): TaskFile {
    const kept = this.files.get(filePath);
    if (kept) return kept;
    const made = new TaskFile(this, this.vault, filePath);
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

  /** Where the inbox note lives. */
  get inboxPath(): string {
    return this.inbox_;
  }

  /** Re-points at the daily-notes scheme and inbox the settings now name. */
  retarget(config: DailyNotesConfig, inboxPath: string): void {
    const same = config.folder === this.dailyNotes.folder
      && config.format === this.dailyNotes.format
      && inboxPath === this.inbox_;
    this.dailyNotes = config;
    this.inbox_ = inboxPath;
    if (!same) this.clear();
  }

  /** Whether this path is a day note or the inbox, and so worth telling the store about. */
  owns(path: string): boolean {
    return path === this.inbox_ || matchDailyNotePath(path, this.dailyNotes) !== null;
  }

  /** The path a day's note has, whether or not the file exists. */
  pathOf(date: Date): string {
    return dayNotePath(date, this.dailyNotes);
  }

  /** What is held for that day right now — for a first paint that must not await. Nothing
   *  for a day whose note has changed since: what it holds is a reading the vault has left
   *  behind, and the re-read is the caller's to wait for. */
  cached(date: Date): DaySummary | null {
    const path = this.pathOf(date);
    if (this.isStale(path)) return null;
    return this.held(path) ?? null;
  }

  /**
   * One day's checklist. Today's note is created on demand; another day is read only if
   * it has one, so a render doesn't litter the vault with empty notes.
   */
  async day(date: Date): Promise<DaySummary> {
    const path = this.pathOf(date);
    if (sameDay(date, new Date()) && !this.held(path)?.exists) {
      // `ensure` can land the note under another path — Templater's, when it runs one.
      const made = await DayMarkdownFile.ensure(this.app, date, this.dailyNotes);
      if (made && made.filePath !== path) return this.read(made.filePath, startOfDay(date));
    }
    return this.read(path, startOfDay(date));
  }

  /** The inbox note. Its checked lines are dropped as it is read: an inbox holds what is
   *  still to do, and a line ticked off there has been filed elsewhere already. */
  async inbox(): Promise<InBox> {
    const summary = await this.read(this.inbox_, null) as InBox;
    if (!summary.items.some((it) => it.checked)) return summary;

    await new DayMarkdownFile(this.app, this.inbox_).removeCheckedTasks();
    // Re-read rather than trusting the lines the prune worked from — it rewrote the file.
    this.touch(this.inbox_);
    return await this.read(this.inbox_, null) as InBox;
  }

  // ── Telling the views ────────────────────────────────────────────────────

  /** Files a path under the day it is, the inbox being its own telling. */
  protected override mark(path: string, origin: ChangeOrigin): void {
    if (path !== this.inbox_) return super.mark(path, origin);
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
      this.emit(StoreEvent.DaysChanged, { paths: [...days.keys()], origin: originOf(days.values()) });
    }
    if (inbox) this.emit(StoreEvent.InboxChanged, { path: this.inbox_ });
  }

  /** Says a day of the warm-up has landed. The pass is `TaskService`'s — it reads through
   *  here, and these are the days this store now holds. Told as each lands rather than
   *  coalesced: a list takes its rows one at a time. */
  warmed(entry: DaySummary, offset: number): void {
    this.emit(StoreEvent.DayWarmed, { entry, offset });
  }

  warmupFinished(days: number): void {
    this.emit(StoreEvent.WarmupFinished, { days });
  }

  private async read(path: string, day: Date | null): Promise<DaySummary> {
    const held = this.held(path);
    if (held && !this.isStale(path)) return held;
    this.unstale(path);

    // The note does the reading and the parsing, and wakes whatever holds one of its lines.
    const file = this.file(path);
    const fields = await file.read();
    this.catchingUp = true;
    try {
      file.fill(fields);
    } finally {
      this.catchingUp = false;
    }
    const summary = held ?? this.summaryOver(file, day);
    this.keep(path, summary);
    return summary;
  }

  /** The inbox is its own kind of day: it holds the project tasks nothing dates as well as
   *  its own lines. */
  private summaryOver(file: TaskFile, day: Date | null): DaySummary {
    return file.filePath === this.inbox_
      ? new InBox(file, this, this.vault.projects)
      : new DaySummary(file, this, day);
  }
}
