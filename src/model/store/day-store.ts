import { App } from "obsidian";
import { startOfDay, sameDay } from "../dates";
import type { DayTask } from "../daily/day-task";
import type { DailyNotesConfig } from "../daily/week-summary";
import { DayMarkdownFile, dayNotePath, matchDailyNotePath, parseTasksFromLines } from "./day-markdown-file";
import { NoteCache } from "./note-cache";
import { StoreEvent } from "./store-events";
import { resolveFile } from "../operations/file-helpers";

/** One day note, or the inbox, as the store holds it. */
export interface DayNoteEntry {
  path: string;
  /** The day the note stands for; null for the inbox, which belongs to no day. */
  date: Date | null;
  exists: boolean;
  /** Its top-level checklist lines, each stamped with the note it came from. */
  items: DayTask[];
  /** The note's lines, for a reader wanting its own reading of them. */
  lines: string[];
}

/**
 * The day notes and the inbox, held one entry per path. Every note is read off the file, so
 * the mark `NoteCache` carries about where a re-read comes from means nothing here.
 */
export class DayStore extends NoteCache<DayNoteEntry> {
  /** Whether the inbox changed since the views were last told. The day notes go through the
   *  paths `NoteCache` gathers; the inbox is its own telling. */
  private pendingInbox = false;

  constructor(
    app: App,
    private dailyNotes: DailyNotesConfig,
    private inbox_: string,
  ) {
    super(app);
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
  cached(date: Date): DayNoteEntry | null {
    const path = this.pathOf(date);
    if (this.isStale(path)) return null;
    return this.held(path) ?? null;
  }

  /**
   * One day's checklist. Today's note is created on demand; another day is read only if
   * it has one, so a render doesn't litter the vault with empty notes.
   */
  async day(date: Date): Promise<DayNoteEntry> {
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
  async inbox(): Promise<DayNoteEntry> {
    const entry = await this.read(this.inbox_, null);
    if (!entry.items.some((it) => it.checked)) return entry;

    const items = await new DayMarkdownFile(this.app, this.inbox_).removeCheckedTasks();
    // Re-read rather than trusting the lines the prune worked from — it rewrote the file.
    this.touch(this.inbox_);
    const pruned = { ...await this.read(this.inbox_, null), items };
    this.keep(this.inbox_, pruned);
    return pruned;
  }

  // ── Telling the views ────────────────────────────────────────────────────

  /** Files a path under the day it is, the inbox being its own telling. */
  protected override mark(path: string): void {
    if (path !== this.inbox_) return super.mark(path);
    this.pendingInbox = true;
    this.schedule();
  }

  protected announce(): void {
    const days = this.takePending();
    const inbox = this.pendingInbox;
    this.pendingInbox = false;
    if (days.length > 0) this.emit(StoreEvent.DaysChanged, { paths: days });
    if (inbox) this.emit(StoreEvent.InboxChanged, { path: this.inbox_ });
  }

  /** Says a day of the warm-up has landed. The pass is `TaskStore`'s — it reads through
   *  here, and these are the days this store now holds. Told as each lands rather than
   *  coalesced: a list takes its rows one at a time. */
  warmed(entry: DayNoteEntry, offset: number): void {
    this.emit(StoreEvent.DayWarmed, { entry, offset });
  }

  warmupFinished(days: number): void {
    this.emit(StoreEvent.WarmupFinished, { days });
  }

  private async read(path: string, day: Date | null): Promise<DayNoteEntry> {
    const held = this.held(path);
    if (held && !this.isStale(path)) return held;
    this.unstale(path);

    const exists = resolveFile(this.app, path) !== null;
    // Parsed from the lines just read, rather than through `parseTasks`, which would read
    // the file a second time.
    const lines = await new DayMarkdownFile(this.app, path).readLines();
    const items = parseTasksFromLines(lines, path).map((t) => t.withSource(path, day ?? undefined));
    const entry: DayNoteEntry = { path, date: day, exists, items, lines };
    this.keep(path, entry);
    return entry;
  }
}
