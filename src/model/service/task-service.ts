import { normalizePath } from "obsidian";
import { TaskFileStore } from "../store/task-file-store";
import type { DayNote } from "../daily/day-note";
import type { InBox } from "../daily/inbox";
import { resolveTaskSortDir, sortInboxItems } from "../base-task";
import { TaskSortKey } from "../settings";
import { Task, resolveHabitsTag } from "../daily/task";
import type { Priority } from "../base-task";
import { DEFAULT_DAILY_NOTES_CONFIG, type DailyNotesConfig } from "./day-note-service";
import {
  addDays, diffDays, formatDate, sameDay, startOfDay, startOfIsoWeek, weekdayIndex,
} from "../dates";
import type { StoreEvent, StoreEvents, WarmedDay } from "../store/store-events";
import type { VaultData } from "../service/vault-data";
import { reconcileRecurringHabits } from "../operations/habit-reconcile";
import { ensureFolderRecursive, parentDirOf, resolveFile } from "../operations/file-helpers";
import { isTodayOrLaterInWeek } from "../daily/recurring-task";
import { BaseService } from "./base-service";

/** What a backfill of the week's habits did to the vault. */
export interface BackfillResult {
  filesChanged: number;
  filesCreated: number;
}

/** What planning a task for a day actually did with it — a day only takes the task in
 *  once its note exists, so the other outcome is a ⏳ target date left on the task. */
export enum ScheduleOutcome {
  /** The task now lives in that day's note. */
  Moved = "moved",
  /** The day has no note yet: the task waits in the inbox with a ⏳ target date. */
  Targeted = "targeted",
  /** Nothing happened — the task was gone, or its target note couldn't be created. */
  Failed = "failed",
}

/** Where the inbox note lives: the settings' path, else `Inbox.md` beside the day notes. */
function resolveInboxPath(inboxFilePath: string, dnConfig: DailyNotesConfig): string {
  if (inboxFilePath) return normalizePath(inboxFilePath);
  return normalizePath(dnConfig.folder ? `${dnConfig.folder}/Inbox.md` : "Inbox.md");
}

/** How long a day note is left to settle before it is put back in step. */
const RECONCILE_DEBOUNCE_MS = 800;

/**
 * The one way into the day notes and the inbox. It holds none of them — `TaskFileStore` below it
 * does, and re-reads only the notes that changed — but it is what the settings, the writes
 * and the reconciles go through, and its events are that store's handed on. The projects
 * folder is `ProjectService`'s, which is built the same way.
 */
export class TaskService extends BaseService {
  /** The day notes and the inbox, held and watched. Its events are this store's, handed on
   *  through `on` — nothing outside reaches past here for a day. */
  private readonly days: TaskFileStore;
  /** The daily-notes scheme, read off the core plugin's own config. Resolving it takes a
   *  file read, so the day store starts on this plugin's guess and is re-pointed once the
   *  real one lands — dropping, at worst, what it read in that gap. */
  private configPass: Promise<void> | null = null;
  /** A reconcile waiting on its note to settle, by path. */
  private readonly reconciling = new Map<string, number>();

  constructor(vault: VaultData) {
    super(vault);
    const guess = DEFAULT_DAILY_NOTES_CONFIG;
    this.days = new TaskFileStore(
      vault, guess, resolveInboxPath(this.settings().inboxFilePath, guess), (path) => this.reconcileDay(path),
    );
  }

  // ── The vault it works on, and what it is read under ────────────────────
  //
  // The store, the settings in force and where a day's note lives — what both halves below
  // stand on. The three private helpers at the end are what a write that moves a line
  // between two notes is made of, and belong to neither half on their own.


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
      const config = await this.vault.dayNotes.readConfig();
      this.days.retarget(config, resolveInboxPath(this.settings().inboxFilePath, config));
    })();
    await this.configPass;
  }

  /** The day notes and the inbox as they were last read: the files a write that spans both
   *  halves of the vault goes through, and the store `VaultData.days` hands to the service
   *  beside this one. Nothing outside the model layer asks for it — a view asks here. */
  get notes(): TaskFileStore {
    return this.days;
  }

  /** Where the inbox note lives, for the views that write a line into it by name. */
  get inboxPath(): string {
    return resolveInboxPath(this.settings().inboxFilePath, this.dailyNotesConfig);
  }

  /** The tag a habit line carries, as `Task` spells it. The setting is read through here
   *  by the reconcile and by the views alike: a stored value the settings tab never
   *  cleaned would otherwise reach the reconcile as a tag matching nothing, and every
   *  pass would insert the whole set again. */
  get habitsTag(): string {
    return resolveHabitsTag(this.settings().dailyHabitsTag);
  }

  /** The daily-notes scheme in force. The guess until `reconfigure` has landed. */
  get dailyNotesConfig(): DailyNotesConfig {
    return this.days.config;
  }

  /** The day's note, made if it doesn't exist. Null when the vault says nowhere to put
   *  one — see `DayNoteService.canCreate`. */
  ensureDayNote(date: Date): Promise<DayNote | null> {
    return this.vault.dayNotes.ensure(date, this.dailyNotesConfig);
  }

  /** Whether a task planned for `date` belongs in that day's note yet: only today and days
   *  that already have one, so planning ahead conjures no string of empty notes. */
  async dayTakesTasks(date: Date): Promise<boolean> {
    const config = this.dailyNotesConfig;
    const path = this.vault.dayNotes.pathOf(date, config);
    if (path === this.vault.dayNotes.pathOf(new Date(), config)) return true;
    return !!resolveFile(this.app, path);
  }

  /** The day a note stands for, or null when its name is not a day's. */
  dayOfNote(filePath: string): Date | null {
    return this.vault.dayNotes.dayOf(filePath, this.dailyNotesConfig);
  }

  // A move between two notes goes target-first: the note is made, the line put in, and only
  // then taken out of the note it came from, so a failure part-way leaves the item in both
  // places rather than in neither. What goes in is `lineToMove`'s reading of the source, the
  // caller's copy of a line saying nothing certain about the block under it.

  /** The note a line is in. A line no note holds — one parsed out of text, which nothing
   *  wakes — is nothing a write can reach, and asking to write it is a mistake worth
   *  hearing about rather than a change that quietly never lands. */
  private noteOf(item: Task): string {
    if (!item.filePath) throw new Error(`No note holds the line "${item.title}"`);
    return item.filePath;
  }

  /**
   * The line as the source note reads it right now, its sub-lines with it — what a move puts
   * in the target. Null once the note no longer holds it, leaving the target alone: a move
   * with nothing to make.
   *
   * Matched on its own index first, then on the line as it reads, which is how a pass over
   * the lines resolves a task it was handed.
   */
  private async lineToMove(filePath: string, item: Task): Promise<Task | null> {
    const held = await this.days.file(filePath).parsedTasks();
    return held.find((t) => t.lineIndex === item.lineIndex && t.rawLine === item.rawLine)
      ?? held.find((t) => t.rawLine === item.rawLine)
      ?? null;
  }

  /**
   * Sends a day's checklist item to the inbox, carrying its line over as it stands — the
   * same task, only unscheduled, under the ⏳ target date a reschedule leaves on it (`null`
   * for a plain unschedule). A line with no ➕ gets today's, which the age badge and the
   * default sort read; indentation is dropped so it lands top-level.
   *
   * Answers whether the item was found and moved.
   */
  private async sendToInbox(item: Task, targetDate: Date | null): Promise<boolean> {
    const source = this.noteOf(item);
    const moving = await this.lineToMove(source, item);
    if (!moving) return false;
    const line = Task.toUncheckedLine(moving.rawLine).replace(/^\s+/, "");
    const created = moving.createdAt ? line : `${line} ➕ ${formatDate(new Date())}`;
    // Cleared with no target: a leftover ⏳ would have `migrateInboxTargets` pull the
    // item straight back into a day.
    const inboxLine = Task.withUpdatedScheduledDate(created, targetDate);
    await this.days.file(this.inboxPath).addLine(
      Task.parse(inboxLine, 0)!.withSubLines(moving.subLines),
    );
    return (await this.days.file(source).removeLine(moving)) !== null;
  }

  // ── The day's checklist ──────────────────────────────────────────────────
  //
  // A change to one line is that line's own: the task sets it, its note owes the file the
  // pass, and the re-read that follows tells the views. What touches a second note is
  // nobody's line to set, so the write asks each note for the change instead — which is the
  // same owing, and the same marking of what to re-read.
  //
  // Which note a line is in is the line's to say. A caller hands over the task and nothing
  // else: a path beside it is a second answer to the same question, and the one that can be
  // wrong.


  /** One day's checklist. Today's note is created on demand; another day is read only if
   *  it has one, so a render doesn't litter the vault with empty notes. */
  async day(date: Date): Promise<DayNote> {
    await this.configPass;
    return await this.ensureToday(date) ?? this.days.day(date);
  }

  /**
   * Today's note, made if it isn't there yet — a day being shown is one the plugin keeps a
   * note for. Nothing for any other day, and nothing for a day already held: the read has
   * seen the file, and asking again would mark the path for a re-read on every render. A
   * refusal is nothing too, and leaves the day read as the empty note it is.
   */
  private async ensureToday(date: Date): Promise<DayNote | null> {
    if (!sameDay(date, new Date())) return null;
    if (this.days.hasNote(date)) return null;
    return this.vault.dayNotes.ensure(date, this.dailyNotesConfig);
  }

  /** The seven days from `weekStart`, in order. Each is its own note, so they are read
   *  together rather than one after another. */
  async week(weekStart: Date): Promise<DayNote[]> {
    const start = startOfDay(weekStart);
    return Promise.all(Array.from({ length: 7 }, (_, i) => this.day(addDays(start, i))));
  }

  /** The days either side of `centre` that are already held — for a first paint that
   *  must not await. What is missing arrives through `DayWarmed`. */
  daysCached(centre: Date, before: number, after: number): WarmedDay[] {
    return this.days.cachedWindow(centre, before, after);
  }

  /** Reads the days either side of `centre` in the background, each delivered through
   *  `DayWarmed` as it lands. Reading ahead creates nothing, today included: a day shown is
   *  what makes a note, and `day` is where that happens. */
  warmWindow(centre: Date, before: number, after: number): void {
    void this.runWarm(centre, before, after);
  }

  private async runWarm(centre: Date, before: number, after: number): Promise<void> {
    await this.configPass;
    await this.days.warmWindow(centre, before, after);
  }

  // A change to one line is that line's own: the task sets it, its note owes the file the
  // pass, and the re-read that follows tells the views. What is left below touches a second
  // note, and so is nobody's line to set — the write asks each note for the change instead,
  // which is the same owing, and the same marking of what to re-read.
  //
  // Which note a line is in is the line's to say. A caller hands over the task and nothing
  // else: a path beside it is a second answer to the same question, and the one that can be
  // wrong.

  async toggleChecklistItem(item: Task): Promise<string> {
    item.setChecked(!item.checked);
    await item.flush();
    return item.rawLine;
  }

  async updateChecklistItemTitle(item: Task, title: string): Promise<void> {
    item.setTitle(title);
    await item.flush();
  }

  /** The prose under a checklist line — its sub-lines, as one block of text. */
  async updateChecklistItemNote(item: Task, text: string): Promise<void> {
    item.setNote(text);
    await item.flush();
  }

  async setChecklistItemPriority(item: Task, priority: Priority): Promise<void> {
    item.setPriority(priority);
    await item.flush();
  }

  async deleteChecklistItem(item: Task): Promise<void> {
    item.remove();
    await item.flush();
  }

  /** Places a line just before `anchor` in its own note, or after the last task when that
   *  is null. */
  async reorderChecklistItem(item: Task, anchor: Task | null): Promise<void> {
    await this.days.file(this.noteOf(item)).moveLineBefore(item, anchor);
  }

  /** Moves a day's line back to the inbox, both notes being written. */
  async moveChecklistItemToInbox(item: Task): Promise<void> {
    await this.sendToInbox(item, null);
  }

  /** Replans a day's checklist item for `date`. A day that doesn't take tasks yet sends the
   *  item back to the inbox with a ⏳ rather than getting a note of its own. */
  async rescheduleChecklistItem(item: Task, date: Date): Promise<ScheduleOutcome> {
    const source = this.noteOf(item);
    if (!await this.dayTakesTasks(date)) {
      return await this.sendToInbox(item, date) ? ScheduleOutcome.Targeted : ScheduleOutcome.Failed;
    }
    const moving = await this.lineToMove(source, item);
    if (!moving) return ScheduleOutcome.Failed;
    const target = await this.ensureDayNote(date);
    if (!target) return ScheduleOutcome.Failed;
    const unchecked = Task.parse(Task.toUncheckedLine(moving.rawLine), 0)!.withSubLines(moving.subLines);
    await this.days.file(target.path).insertUnderHeading(
      [unchecked.rawLine, ...unchecked.subLines], this.settings().dailyTasksHeading,
    );
    const removed = await this.days.file(source).removeLine(moving);
    return removed ? ScheduleOutcome.Moved : ScheduleOutcome.Failed;
  }

  /** Writes a new task onto `date`, by the same rule `scheduleInboxItem` follows — so a
   *  task is only ever in a day that exists or in the inbox. */
  async addTaskToDay(date: Date, title: string): Promise<ScheduleOutcome> {
    const task = Task.create(title, new Date());
    if (!await this.dayTakesTasks(date)) {
      const line = Task.withUpdatedScheduledDate(task.rawLine, date);
      await this.days.file(this.inboxPath).addLine(Task.parse(line, 0)!);
      return ScheduleOutcome.Targeted;
    }
    const target = await this.ensureDayNote(date);
    if (!target) return ScheduleOutcome.Failed;
    await this.days.file(target.path).insertUnderHeading(
      [task.rawLine], this.settings().dailyTasksHeading,
    );
    return ScheduleOutcome.Moved;
  }

  // ── The inbox ────────────────────────────────────────────────────────────
  //
  // Where a task waits for a day to be picked for it. A line leaves here for a day note
  // once that day takes tasks, and comes back the same way — see `moveChecklistItemToInbox`
  // above.


  /** The unclosed inbox lines, in the order the settings ask for. */
  async inbox(): Promise<Task[]> {
    return this.sortedInboxItems(await this.inboxModel());
  }

  /** An inbox already read, put in the order the settings ask for — for a caller that
   *  holds the model and must not read the note a second time for its order. */
  sortedInboxItems(inbox: InBox): Task[] {
    const sortBy = this.settings().inboxSortBy ?? TaskSortKey.Created;
    return sortInboxItems(inbox.items, sortBy, resolveTaskSortDir(sortBy, this.settings().inboxSortDir));
  }

  /** The inbox whole: its own lines, and the project tasks nothing dates that wait there
   *  beside them. */
  async inboxModel(): Promise<InBox> {
    await this.configPass;
    return this.days.inbox();
  }

  async addInboxItem(title: string): Promise<void> {
    await this.days.file(this.inboxPath).createLine(title, new Date());
  }

  async removeInboxItem(item: Task): Promise<void> {
    item.remove();
    await item.flush();
  }

  /** Closes an inbox line by moving it into today's note marked ✅, so the inbox leaves a
   *  record rather than erasing the task. Any ⏳ target date goes with it. */
  async closeInboxItem(item: Task): Promise<void> {
    const moving = await this.lineToMove(this.inboxPath, item);
    if (!moving) return;
    const today = await this.ensureDayNote(new Date());
    if (!today) return;
    const line = Task.withUpdatedScheduledDate(Task.toCheckedLine(moving.rawLine, new Date()), null);
    await this.days.file(today.path).addLine(Task.parse(line, 0)!.withSubLines(moving.subLines));
    await this.days.file(this.inboxPath).removeLine(moving);
  }

  /** Plans an inbox item for `date`: into that day's checklist when it takes tasks, else
   *  left in the inbox under a ⏳ for `migrateInboxTargets` to move once the day exists. */
  async scheduleInboxItem(item: Task, date: Date): Promise<ScheduleOutcome> {
    if (!await this.dayTakesTasks(date)) {
      const targeted = await this.days.file(this.inboxPath).setLineScheduled(item, date);
      return targeted ? ScheduleOutcome.Targeted : ScheduleOutcome.Failed;
    }
    const moving = await this.lineToMove(this.inboxPath, item);
    if (!moving) return ScheduleOutcome.Failed;
    const target = await this.ensureDayNote(date);
    if (!target) return ScheduleOutcome.Failed;
    // The day note is the schedule now, so the ⏳ it was waiting on has been honoured.
    const line = Task.withUpdatedScheduledDate(moving.rawLine, null);
    await this.days.file(target.path).insertUnderHeading(
      [line, ...moving.subLines], this.settings().dailyTasksHeading,
    );
    const removed = await this.days.file(this.inboxPath).removeLine(moving);
    return removed ? ScheduleOutcome.Moved : ScheduleOutcome.Failed;
  }

  async unscheduleInboxItem(item: Task): Promise<void> {
    item.setScheduledDate(null);
    await item.flush();
  }

  /**
   * Moves every inbox item whose ⏳ target day takes tasks into that day's checklist, which
   * is what makes a target date a plan rather than a label. A day that never gets a note
   * keeps its item: pulling it forward would rewrite the plan the user picked.
   *
   * Each note it writes marks its own re-read, a throw halfway through included. How many
   * items moved is what it hands back.
   */
  async migrateInboxTargets(): Promise<number> {
    // Only a line under a ⏳ has anywhere to go, and the inbox the store holds says whether
    // there is one — so the read below is the price of having work to do, not of asking.
    const held = this.days.heldInbox();
    if (held && !held.items.some((item) => item.scheduledDate)) return 0;

    const items = await this.days.file(this.inboxPath).parsedTasks();

    let moved = 0;
    // Sequentially: each move rewrites the inbox, invalidating the line indices a
    // concurrent batch would be resolving against. Completed items travel to today,
    // keeping their ✅, a record of work belonging on the day it was closed.
    for (const item of items) {
      if (!item.scheduledDate) continue;
      const day = item.checked ? new Date() : item.scheduledDate;
      if (!await this.dayTakesTasks(day)) continue;
      if (await this.scheduleInboxItem(item, day) === ScheduleOutcome.Moved) moved++;
    }
    return moved;
  }

  // ── Habits, and putting a day note back in step ──────────────────────────
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
      void this.reconcileDayNote(filePath, date).catch((e: unknown) => {
        console.error("pm-compass: couldn't reconcile the day note", e);
      });
    }, RECONCILE_DEBOUNCE_MS));
  }

  /**
   * Brings one day note current with the habits and inbox items it's owed.
   *
   * - Habits: inserts the lines its definitions call for, under their heading.
   * - Inbox: moves the items aimed at this day out of the inbox and into its checklist.
   *
   * Both are changes the notes are owed, and each note marks its own re-read.
   */
  private async reconcileDayNote(filePath: string, date: Date): Promise<void> {
    const { recurringTasks, recurringTasksHeading } = this.settings();
    // Only today and the rest of the week get habits: reopening an older note must not
    // insert one that didn't exist, or was configured differently, at the time.
    if (isTodayOrLaterInWeek(date, new Date())) {
      await reconcileRecurringHabits(
        this.days.file(filePath), recurringTasks, date, recurringTasksHeading, this.habitsTag,
      );
    }

    // Whatever the day is: an item aimed at any day that has a note belongs in it, and a
    // note appearing is what makes this pass worth running.
    await this.migrateInboxTargets();
  }

  /**
   * Today and the rest of the ISO week given the habits their definitions call for, each
   * day's note made if it isn't there. A day already past is left alone: a habit changed
   * mid-week must not rewrite it. Each note written owes its store a re-read, which the note
   * itself says.
   */
  async backfillHabits(today: Date = new Date()): Promise<BackfillResult> {
    const settings = this.settings();
    const config = await this.vault.dayNotes.readConfig();
    const weekStart = startOfIsoWeek(today);

    const days: Date[] = [];
    for (let i = weekdayIndex(today); i < 7; i++) {
      days.push(addDays(weekStart, i));
    }

    await this.ensureWeekFolders(days, config);

    // Each day is an independent file, so reconciling them can run concurrently instead of
    // blocking one after another (this runs on every dashboard render, see pm-compass-view.ts).
    const results = await Promise.all(
      days.map(async (day) => {
        const filePath = this.vault.dayNotes.pathOf(day, config);
        const existed = !!resolveFile(this.app, filePath);

        const notePath = (await this.vault.dayNotes.ensure(day, config))?.path;
        if (!notePath) return { changed: false, created: false };

        const { changed } = await reconcileRecurringHabits(
          this.days.file(notePath),
          settings.recurringTasks,
          day,
          settings.recurringTasksHeading,
          this.habitsTag,
        );
        return { changed, created: !existed };
      }),
    );

    return {
      filesChanged: results.filter((r) => r.changed).length,
      filesCreated: results.filter((r) => r.created).length,
    };
  }

  /**
   * The parent folder of each day's note, made once up front. `ensure` checks this too, but
   * the days are backfilled concurrently, and the format can embed slashes ("YYYY/MM/DD"), so
   * several days can share a parent that they would otherwise race to create.
   *
   * Skipped when no note can be made anyway: the folders of a guessed format would be the
   * very files `ensure` refuses to write.
   */
  private async ensureWeekFolders(days: Date[], config: DailyNotesConfig): Promise<void> {
    if (!await this.vault.dayNotes.canCreate()) return;
    const parentDirs = new Set<string>();
    for (const day of days) {
      const parentDir = parentDirOf(this.vault.dayNotes.pathOf(day, config));
      if (parentDir) parentDirs.add(parentDir);
    }
    for (const parentDir of parentDirs) {
      await ensureFolderRecursive(this.app, parentDir);
    }
  }
}
