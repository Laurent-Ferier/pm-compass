import { DayStore } from "../store/day-store";
import type { DaySummary } from "../daily/day-summary";
import type { InBox } from "../daily/inbox";
import { DayMarkdownFile, matchDailyNotePath, readDailyNotesConfig } from "../store/day-markdown-file";
import * as actions from "../daily/day-task-actions";
import { resolveInboxPath, resolveTaskSortDir, sortInboxItems, type ScheduleOutcome } from "../daily/day-task-actions";
import { TaskSortKey } from "../settings";
import type { Task } from "../daily/task";
import type { Priority } from "../base-task";
import type { DailyNotesConfig } from "../daily/week-summary";
import { addDays, diffDays, startOfDay } from "../dates";
import type { StoreEvent, StoreEvents, WarmedDay } from "../store/store-events";
import type { VaultData } from "../service/vault-data";
import { reconcileDayNote } from "../operations/day-reconcile";
import { BaseService } from "./base-service";

export type { DayNoteEntry } from "../store/day-store";

/** How long a day note is left to settle before it is put back in step. */
const RECONCILE_DEBOUNCE_MS = 800;

/**
 * The one way into the day notes and the inbox. It holds none of them — `DayStore` below it
 * does, and re-reads only the notes that changed — but it is what the settings, the writes
 * and the reconciles go through, and its events are that store's handed on. The projects
 * folder is `ProjectService`'s, which is built the same way.
 */
export class TaskService extends BaseService {
  /** The day notes and the inbox, held and watched. Its events are this store's, handed on
   *  through `on` — nothing outside reaches past here for a day. */
  private readonly days: DayStore;
  /** The daily-notes scheme, read off the core plugin's own config. Resolving it takes a
   *  file read, so the day store starts on this plugin's guess and is re-pointed once the
   *  real one lands — dropping, at worst, what it read in that gap. */
  private configPass: Promise<void> | null = null;
  /** A reconcile waiting on its note to settle, by path. */
  private readonly reconciling = new Map<string, number>();

  constructor(vault: VaultData) {
    super(vault);
    const guess: DailyNotesConfig = { folder: "", format: "YYYY-MM-DD", template: "" };
    this.days = new DayStore(
      vault, guess, resolveInboxPath(this.settings().inboxFilePath, guess), (path) => this.reconcileDay(path),
    );
  }

  /** Marks the day notes a write of the plugin's own touched, so the read that follows
   *  sees the write. What a day note calls once it has written itself. */
  invalidate(paths: string[]): void {
    this.days.invalidate(paths);
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
        await this.days.warmWindow(new Date(), unclosedDaysBefore, unclosedDaysAfter);
      } catch (e) {
        // Nothing is owed to anyone here: a read that follows simply finds a cold cache.
        console.error("pm-compass: couldn't warm the day cache", e);
      }
    })();
  }

  dispose(): void {
    for (const timer of this.reconciling.values()) window.clearTimeout(timer);
    this.reconciling.clear();
    this.days.dispose();
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
  async day(date: Date): Promise<DaySummary> {
    await this.configPass;
    return this.days.day(date);
  }

  /** The seven days from `weekStart`, in order. */
  async week(weekStart: Date): Promise<DaySummary[]> {
    await this.configPass;
    const days: DaySummary[] = [];
    for (let i = 0; i < 7; i++) days.push(await this.days.day(addDays(startOfDay(weekStart), i)));
    return days;
  }

  /** The days either side of `centre` that are already held — for a first paint that
   *  must not await. What is missing arrives through `DayWarmed`. */
  daysCached(centre: Date, before: number, after: number): WarmedDay[] {
    return this.days.cachedWindow(centre, before, after);
  }

  /** Reads the days either side of `centre` in the background, each delivered through
   *  `DayWarmed` as it lands. The reading is the day store's; what is here is the wait on
   *  the daily-notes scheme, without which the window would be read under the guess. */
  warmWindow(centre: Date, before: number, after: number): void {
    void this.runWarm(centre, before, after);
  }

  private async runWarm(centre: Date, before: number, after: number): Promise<void> {
    await this.configPass;
    await this.days.warmWindow(centre, before, after);
  }

  /** The unclosed inbox lines, in the order the settings ask for. */
  async inbox(): Promise<Task[]> {
    const { items } = await this.inboxModel();
    const sortBy = this.settings().inboxSortBy ?? TaskSortKey.Created;
    return sortInboxItems(items, sortBy, resolveTaskSortDir(sortBy, this.settings().inboxSortDir));
  }

  /** The inbox whole: its own lines, and the project tasks nothing dates that wait there
   *  beside them. */
  async inboxModel(): Promise<InBox> {
    await this.configPass;
    return this.days.inbox();
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

  // ── Putting a day note back in step ──────────────────────────────────────
  //
  // A note that has just appeared, or been opened, is one the vault may have moved on
  // without: habits the definitions call for, inbox items aimed at a day that now has
  // somewhere to put them. Held off for a moment, so a note written line by line — a
  // template running, a sync landing — is reconciled once it has settled.
  //
  // The day store calls this for a note that appeared, watching the vault as it does; a
  // note being opened is a workspace event, and reaches here from `main.ts`.

  /** Files a day note for reconciling. A path that names no day, or names one already
   *  over, is nothing to do: neither a habit nor an inbox item belongs in a day gone by. */
  reconcileDay(filePath: string): void {
    const date = this.dayOfNote(filePath);
    if (!date || diffDays(new Date(), date) < 0) return;
    const running = this.reconciling.get(filePath);
    if (running) window.clearTimeout(running);
    this.reconciling.set(filePath, window.setTimeout(() => {
      this.reconciling.delete(filePath);
      void this.runReconcile(filePath, date).catch((e: unknown) => {
        console.error("pm-compass: couldn't reconcile the day note", e);
      });
    }, RECONCILE_DEBOUNCE_MS));
  }

  /** The pass itself is `reconcileDayNote`'s; what is here is the settings it runs under
   *  and the marking of whatever it wrote. */
  private async runReconcile(filePath: string, date: Date): Promise<void> {
    const { recurringTasks, recurringTasksHeading, dailyHabitsTag, dailyTasksHeading } = this.settings();
    const touched: string[] = [];
    try {
      await reconcileDayNote(this.app, filePath, date, {
        recurringTasks, recurringTasksHeading, dailyHabitsTag, dailyTasksHeading,
        inboxPath: this.inboxPath, dailyNotes: this.dailyNotesConfig,
      }, touched);
    } finally {
      // Whatever the pass wrote before it stopped is written; leaving it uncached would
      // hold a stale note until some unrelated event happened to touch the same path.
      this.days.invalidate(touched);
    }
  }

  /** Inbox items aimed at a day that now has a note, into that note's checklist. */
  async migrateInboxTargets(): Promise<void> {
    await actions.migrateInboxTargets(
      this.app, this.inboxPath, this.settings().dailyTasksHeading, this.dailyNotesConfig,
    );
  }

  // A change to one line is that line's own: the task sets it, its note owes the file the
  // pass, and the re-read that follows tells the views. What is left below touches a second
  // note, and so is nobody's line to set.

  async toggleChecklistItem(_filePath: string, item: Task): Promise<string> {
    item.setChecked(!item.checked);
    await item.flush();
    return item.rawLine;
  }

  async updateChecklistItemTitle(_filePath: string, item: Task, title: string): Promise<void> {
    item.setTitle(title);
    await item.flush();
  }

  /** The prose under a checklist line — its sub-lines, as one block of text. */
  async updateChecklistItemNote(_filePath: string, item: Task, text: string): Promise<void> {
    item.setNote(text);
    await item.flush();
  }

  async setChecklistItemPriority(_filePath: string, item: Task, priority: Priority): Promise<void> {
    item.setPriority(priority);
    await item.flush();
  }

  async reorderChecklistItem(filePath: string, item: Task, anchor: Task | null): Promise<void> {
    await this.marking([filePath], () => actions.reorderChecklistItem(this.app, filePath, item, anchor));
  }

  async deleteChecklistItem(_filePath: string, item: Task): Promise<void> {
    item.remove();
    await item.flush();
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

  async removeInboxItem(item: Task): Promise<void> {
    item.remove();
    await item.flush();
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

  async unscheduleInboxItem(item: Task): Promise<void> {
    item.setScheduledDate(null);
    await item.flush();
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
