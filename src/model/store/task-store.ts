import { App } from "obsidian";
import type { PMCompassSettings } from "../settings";
import { DayStore, type DayNoteEntry } from "./day-store";
import { DayMarkdownFile, matchDailyNotePath, readDailyNotesConfig } from "./day-markdown-file";
import * as actions from "../daily/day-task-actions";
import { resolveInboxPath, resolveTaskSortDir, sortInboxItems, type ScheduleOutcome } from "../daily/day-task-actions";
import { TaskSortKey } from "../settings";
import type { Task } from "../daily/task";
import type { Priority } from "../base-task";
import type { DailyNotesConfig } from "../daily/week-summary";
import { addDays, startOfDay } from "../dates";
import type { StoreEvent, StoreEvents, WarmedDay } from "./store-events";

export type { DayNoteEntry } from "./day-store";

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

/**
 * The one way into the day notes and the inbox: it holds what it has read, re-reads only
 * the notes that changed, and says so through its events. The projects folder is
 * `VaultData`'s, which holds one of these.
 */
export class TaskStore {
  /** The day notes and the inbox, held and watched. Its events are this store's, handed on
   *  through `on` — nothing outside reaches past here for a day. */
  private readonly days: DayStore;
  /** The daily-notes scheme, read off the core plugin's own config. Resolving it takes a
   *  file read, so the day store starts on this plugin's guess and is re-pointed once the
   *  real one lands — dropping, at worst, what it read in that gap. */
  private configPass: Promise<void> | null = null;
  /** Bumped by each new `warmWindow`, so the one it replaces stops delivering. */
  private warmPass = 0;

  constructor(private readonly app: App, private readonly settings: () => PMCompassSettings) {
    const guess: DailyNotesConfig = { folder: "", format: "YYYY-MM-DD", template: "" };
    this.days = new DayStore(app, guess, resolveInboxPath(settings().inboxFilePath, guess));
  }

  /** Begins watching the vault. Reads no notes yet — the first read does that. */
  start(): void {
    this.days.start();
    void this.reconfigure();
  }

  /** What the day notes and the inbox say when they change — a view subscribes here. */
  on<K extends StoreEvent>(event: K, handler: (payload: StoreEvents[K]) => void): () => void {
    return this.days.on(event, handler);
  }

  /**
   * Fills the cache from the vault in the background, so the first dashboard paints from
   * what is already held rather than from a cold read. Nothing awaits it: every read
   * awaits the parses it is owed on its own.
   */
  warm(): void {
    void (async () => {
      try {
        await this.inbox();
        const { unclosedDaysBefore, unclosedDaysAfter } = this.settings();
        await this.runWarm(new Date(), unclosedDaysBefore, unclosedDaysAfter);
      } catch (e) {
        // Nothing is owed to anyone here: a read that follows simply finds a cold cache.
        console.error("pm-compass: couldn't warm the day cache", e);
      }
    })();
  }

  dispose(): void {
    this.days.dispose();
    this.warmPass += 1;
    this.days.clear();
  }

  /** Re-points at the daily-notes scheme the settings now name. */
  async reconfigure(): Promise<void> {
    this.configPass = (async () => {
      const config = await readDailyNotesConfig(this.app);
      this.days.retarget(config, resolveInboxPath(this.settings().inboxFilePath, config));
    })();
    await this.configPass;
  }

  /** One day's checklist. Today's note is created on demand; another day is read only if
   *  it has one. */
  async day(date: Date): Promise<DayNoteEntry> {
    await this.configPass;
    return this.days.day(date);
  }

  /** The seven days from `weekStart`, in order. */
  async week(weekStart: Date): Promise<DayNoteEntry[]> {
    await this.configPass;
    const days: DayNoteEntry[] = [];
    for (let i = 0; i < 7; i++) days.push(await this.days.day(addDays(startOfDay(weekStart), i)));
    return days;
  }

  /** The days either side of `centre` that are already held — for a first paint that
   *  must not await. What is missing arrives through `DayWarmed`. */
  daysCached(centre: Date, before: number, after: number): WarmedDay[] {
    return windowOffsets(before, after)
      .map((offset) => ({ offset, entry: this.days.cached(addDays(centre, offset)) }))
      .filter((d): d is WarmedDay => d.entry !== null);
  }

  /**
   * Reads the days either side of `centre` in the background, delivering each through
   * `DayWarmed` as it lands — deepest overdue first, farthest ahead last, which is the
   * order the rows end up in.
   *
   * A few at a time rather than all at once: the window runs to dozens of notes, and a
   * burst of that size stalls the first paint on a phone. Entries are held by path, so a
   * window shifted by a day re-reads one note rather than the lot.
   */
  warmWindow(centre: Date, before: number, after: number): void {
    void this.runWarm(centre, before, after);
  }

  private async runWarm(centre: Date, before: number, after: number): Promise<void> {
    await this.configPass;
    const pass = ++this.warmPass;
    const offsets = windowOffsets(before, after);
    const done = new Map<number, DayNoteEntry>();
    let next = 0;

    // Read a few at a time; deliver strictly in offset order, buffering whatever finishes
    // early. `insertSorted` makes the order cosmetic, but fewer DOM moves is fewer.
    const queue = [...offsets];
    const workers = Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, async () => {
      for (let offset = queue.shift(); offset !== undefined; offset = queue.shift()) {
        const entry = await this.days.day(addDays(centre, offset));
        if (pass !== this.warmPass) return;
        done.set(offset, entry);
        while (next < offsets.length && done.has(offsets[next])) {
          const at = offsets[next++];
          this.days.warmed(done.get(at)!, at);
        }
      }
    });
    await Promise.all(workers);
    if (pass === this.warmPass) this.days.warmupFinished(offsets.length);
  }

  /** The unclosed inbox lines, in the order the settings ask for. */
  async inbox(): Promise<Task[]> {
    await this.configPass;
    const { items } = await this.days.inbox();
    const sortBy = this.settings().inboxSortBy ?? TaskSortKey.Created;
    return sortInboxItems(items, sortBy, resolveTaskSortDir(sortBy, this.settings().inboxSortDir));
  }

  /** Where the inbox note lives, for the views that write a line into it by name. */
  get inboxPath(): string {
    return resolveInboxPath(this.settings().inboxFilePath, this.dailyNotesConfig);
  }

  /** The daily-notes scheme in force. The guess until `reconfigure` has landed. */
  get dailyNotesConfig(): DailyNotesConfig {
    return this.days.config;
  }

  // ── Writing a day note, or the inbox ─────────────────────────────────────
  //
  // Thin over `day-task-actions`, which does the writing; what these add is the marking,
  // so the refresh each one leads to reads the note it just wrote. Every day operation the
  // views make goes through one, so none of them has to hold the vault itself.

  /** The day's note, made if it doesn't exist. Null when the vault says nowhere to put
   *  one — see `canCreateDayNotes`. */
  async ensureDayNote(date: Date): Promise<string | null> {
    const made = await DayMarkdownFile.ensure(this.app, date, this.dailyNotesConfig);
    if (made) this.days.invalidate([made.filePath]);
    return made?.filePath ?? null;
  }

  /** Whether a day can take a task now: it has a note, or it is today and one can be made. */
  dayTakesTasks(date: Date): Promise<boolean> {
    return actions.dayTakesTasks(this.app, date, this.dailyNotesConfig);
  }

  /** The day a note stands for, or null when its name is not a day's. */
  dayOfNote(filePath: string): Date | null {
    return matchDailyNotePath(filePath, this.dailyNotesConfig);
  }

  /** Puts one day's habit lines back in step with the definitions. */
  async reconcileHabits(filePath: string, date: Date): Promise<void> {
    const { recurringTasks, recurringTasksHeading, dailyHabitsTag } = this.settings();
    await this.marking([filePath], () => new DayMarkdownFile(this.app, filePath)
      .reconcileRecurringHabits(recurringTasks, date, recurringTasksHeading, dailyHabitsTag));
  }

  async toggleChecklistItem(filePath: string, item: Task): Promise<string> {
    return this.marking([filePath], () => actions.toggleChecklistItem(this.app, filePath, item));
  }

  async updateChecklistItemTitle(filePath: string, item: Task, title: string): Promise<void> {
    await this.marking([filePath], () => new DayMarkdownFile(this.app, filePath).updateTitle(item, title));
  }

  /** The prose under a checklist line — its sub-lines, as one block of text. */
  async updateChecklistItemNote(filePath: string, item: Task, text: string): Promise<void> {
    await this.marking([filePath], () => new DayMarkdownFile(this.app, filePath).updateSubLines(item, text));
  }

  async setChecklistItemPriority(filePath: string, item: Task, priority: Priority): Promise<void> {
    await this.marking([filePath], () => actions.setChecklistItemPriority(this.app, filePath, item, priority));
  }

  async reorderChecklistItem(filePath: string, item: Task, anchor: Task | null): Promise<void> {
    await this.marking([filePath], () => actions.reorderChecklistItem(this.app, filePath, item, anchor));
  }

  async deleteChecklistItem(filePath: string, item: Task): Promise<void> {
    await this.marking([filePath], () => actions.deleteChecklistItem(this.app, filePath, item));
  }

  /** Moves a day's line back to the inbox, both notes being written. */
  async moveChecklistItemToInbox(filePath: string, item: Task): Promise<void> {
    await this.marking([filePath, this.inboxPath],
      () => actions.moveChecklistItemToInbox(this.app, filePath, item, this.inboxPath));
  }

  /** Moves a line onto another day — or, that day having no note, leaves it in the inbox
   *  under a target date for it. */
  async rescheduleChecklistItem(filePath: string, item: Task, date: Date): Promise<ScheduleOutcome> {
    return this.marking([filePath, this.inboxPath, this.days.pathOf(date)], () => actions.rescheduleChecklistItem(
      this.app, filePath, this.inboxPath, item, date,
      this.settings().dailyTasksHeading, this.dailyNotesConfig,
    ));
  }

  /** Adds a task to a day, through the inbox when that day has no note yet. */
  async addTaskToDay(date: Date, title: string): Promise<ScheduleOutcome> {
    return this.marking([this.inboxPath, this.days.pathOf(date)], () => actions.addTaskToDay(
      this.app, date, title, this.inboxPath, this.settings().dailyTasksHeading, this.dailyNotesConfig,
    ));
  }

  addInboxItem(title: string): Promise<void> {
    return this.marking([this.inboxPath], () => actions.appendInboxItem(this.app, this.inboxPath, title));
  }

  removeInboxItem(item: Task): Promise<void> {
    return this.marking([this.inboxPath], () => actions.removeInboxItem(this.app, this.inboxPath, item));
  }

  /** Closes an inbox line by moving it into today's note marked done. */
  closeInboxItem(item: Task): Promise<void> {
    return this.marking([this.inboxPath, this.days.pathOf(new Date())],
      () => actions.closeInboxItem(this.app, this.inboxPath, item));
  }

  scheduleInboxItem(item: Task, date: Date): Promise<ScheduleOutcome> {
    return this.marking([this.inboxPath, this.days.pathOf(date)], () => actions.scheduleInboxItem(
      this.app, this.inboxPath, item, date, this.settings().dailyTasksHeading, this.dailyNotesConfig,
    ));
  }

  unscheduleInboxItem(item: Task): Promise<void> {
    return this.marking([this.inboxPath], () => actions.unscheduleInboxItem(this.app, this.inboxPath, item));
  }

  /** Runs a write and marks what it touched — whether or not it threw. A failed write can
   *  still have landed part of a two-note move, so the notes are re-read either way. */
  private async marking<T>(paths: string[], write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } finally {
      this.days.invalidate(paths);
    }
  }
}
