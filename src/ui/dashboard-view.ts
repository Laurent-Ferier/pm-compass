import { Notice, setIcon } from "obsidian";
import { openNoteFile } from "./task-creator";
import { isEffectivelyClosed } from "../model/project/task-tree";
import { type Project } from "../model/project/project";
import { type ProjectTask } from "../model/project/project-task";
import { Task } from "../model/daily/task";
import { ScheduleOutcome } from "../model/service/task-service";
import { DEFAULT_SETTINGS } from "../model/settings";
import { Icon } from "./icons";
import { diffDays, sameDay, startOfDay } from "../model/dates";
import { formatPattern } from "../model/date-format";
import {
  bucketTasksByHorizon, buildParentIdSet,
  computeEffectiveValues, selectCompletedOn, selectPriorityQueue,
  type EffectiveValues, type TaskHorizons,
} from "../model/project/task-scoring";
import { type AddDragHandle, type ReorderDrop } from "./drag-reorder";
import { TaskList } from "./task-list";
import type { BaseTask } from "../model/base-task";
import { BaseTabView, NavPeriod } from "./base-tab-view";
import { CacheEvent, type WarmedDay } from "../model/cache/cache-events";
import {
  appendActionButton, appendEditTitleButton, dayTaskTitleEdit, appendNoteActionButton,
  appendRescheduleButton, migrateNoteKey,
} from "./day-task-row";
import { confirmAction } from "./task-creator";
import { openDatePicker } from "./date-picker";
import { createBadgeBand } from "./task-badges";

export const DASHBOARD_VIEW_TYPE = "pm-compass-dashboard";

// ── Dashboard (tasks tab) ─────────────────────────────────────────────────────

export interface AdjacentDayData {
  offset: number;
  date: Date;
  unclosedItems: Task[];
  filePath: string | null;
}

/** A horizon's rendered list and the message standing in for it while it holds nothing —
 *  what `fillAdjacentDays` adds to. */
interface HorizonSlot {
  list: TaskList;
  empty: HTMLElement | null;
}

export class DashboardView extends BaseTabView {
  dashboardDate: Date = startOfDay(new Date());
  /** Set on each render, for the day-task rows' promote action several levels below it. */
  private projects: Project[] = [];

  /** Kept across renders, so a run of tasks can be typed in without reopening the bar. */
  private addBarOpen = false;

  /** This render's "+" and the bar it toggles — built at opposite ends of `render`. */
  private addBarToggle: HTMLElement | null = null;
  private addBar: { bar: HTMLElement; input: HTMLInputElement } | null = null;

  /** Takes down the tap-away watcher of the bar currently open. */
  private addBarDismiss: (() => void) | null = null;

  /** The two horizons a background read still fills, and the whole-list message ungrouped
   *  lists show meanwhile. Null until a merged render leaves them. */
  private horizonSlots: { overdue: HorizonSlot; nextUp: HorizonSlot } | null = null;
  private nothingToDo: HTMLElement | null = null;

  /** Drops the horizon subscription of the paint before this one, whose tree is gone. */
  private stopWarm: (() => void) | null = null;

  /** The days the last paint drew from the cache, which the warm-up need not repeat. */
  private paintedDays = new Set<number>();

  /** What every list of one render draws from, set once at the top of `render()`. */
  private context: {
    projectMap: Map<string, Project>;
    effectiveValues: Map<string, EffectiveValues>;
    habitsTag: string;
    inboxPath: string;
  } = { projectMap: new Map(), effectiveValues: new Map(), habitsTag: "daily", inboxPath: "" };

  /** Puts the dashboard on `date`, for the `showDay` handler every tab is given. */
  setDate(date: Date): void {
    this.dashboardDate = startOfDay(date);
  }

  /** Every date on the tab reads against the day on show, not the real today. */
  protected override referenceDate(): Date {
    return this.dashboardDate;
  }

  render(
    content: HTMLElement,
    checklistItems: Task[],
    dnPath: string | null,
    tasks: ProjectTask[],
    projects: Project[],
    resolvedInboxPath: string,
    /** Inbox lines carrying a ⏳ target day, still waiting on that day's note. */
    plannedItems: Task[] = [],
  ): void {
    this.startRenderPass();
    this.stopFill();
    this.projects = projects;
    // Whatever the cache already holds, painted at once; the rest of the window arrives
    // through `DayWarmed` and drops into the horizons a day at a time.
    const { before, after } = this.unclosedWindow();
    const cachedDays = this.plugin.tasks.daysCached(this.dashboardDate, before, after);
    // What the paint already carries, so the warm-up's own delivery of the same day
    // doesn't put its rows in a second time.
    this.paintedDays = new Set(cachedDays.map((d) => d.offset));
    const cached = cachedDays
      .map((d) => this.toAdjacent(d))
      .filter((d): d is AdjacentDayData => d !== null);
    const { here: plannedHere, adjacent: adjacentAll } = this.placePlanned(plannedItems, cached);
    const dayItems = [...checklistItems, ...plannedHere];

    // ── Date navigator ──────────────────────────────────────────────────────
    this.renderPeriodNav(content, {
      period: NavPeriod.Day,
      showing: () => this.dashboardDate,
      onGo: (date) => this.setDate(date),
      label: (nav) => {
        const dateLabelText = nav.createSpan({
          cls: `pm-dash-date-text${dnPath ? " pm-dash-date-text--has-note" : " pm-dash-date-text--no-note"}`,
          text: formatPattern(this.dashboardDate, "dddd, MMMM D"),
        });
        dateLabelText.addEventListener("click", () => {
          if (dnPath) {
            openNoteFile(this.app, dnPath);
          } else {
            void this.createAndOpenDayNote();
          }
        });
      },
      trail: (host) => {
        // Between the date and the calendar: it adds to the day those two name.
        this.addBarToggle = host.createEl("button", {
          cls: "pm-dash-nav-btn pm-dash-add-btn",
          attr: { "aria-label": "Add a task", "aria-expanded": "false" },
        });
        setIcon(this.addBarToggle, Icon.AddTask);
        this.addBarToggle.addEventListener("click", () => this.setAddBarOpen(!this.addBarOpen));

        const calBtn = host.createEl("button", { cls: "pm-dash-nav-btn pm-dash-cal-btn", attr: { "aria-label": "Pick date" } });
        setIcon(calBtn, Icon.PickDate);
        calBtn.addEventListener("click", () => {
          openDatePicker(calBtn, {
            initial: this.dashboardDate,
            onPick: (date) => { this.dashboardDate = date; this.onRefresh(); },
          });
        });
      },
    });

    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const activeTasks = tasks.filter((t) => !isEffectivelyClosed(t, taskById));

    // A planned day joins the neighbouring notes in order, so "two days ago" reads as one
    // horizon whether its rows are in that day's note or still in the inbox.
    const pastDays = adjacentAll.filter((d) => d.offset < 0).sort((a, b) => b.offset - a.offset);
    const futureDays = adjacentAll.filter((d) => d.offset > 0).sort((a, b) => a.offset - b.offset);

    // Over every task, closed ones included: a finished row's ribbon must answer for the
    // same tree as an open one's, or a task's priority would change when it is ticked.
    const effectiveValuesMap = computeEffectiveValues(tasks, taskById);
    this.context = {
      projectMap,
      effectiveValues: effectiveValuesMap,
      habitsTag: this.plugin.tasks.habitsTag,
      inboxPath: resolvedInboxPath,
    };
    const parentIds = buildParentIdSet(activeTasks);
    // The horizons split around the day on show, so a task's section matches its badge.
    const today = this.referenceDate();

    const merged = this.plugin.settings.mergeDailyAndProjectTasks;
    // An undated task is the Inbox's alone: no horizon here holds it.
    const priorityQueue = selectPriorityQueue(activeTasks, effectiveValuesMap, parentIds, today);
    // What the day closed, off the full list — the active ones have dropped it already.
    const completedHere = selectCompletedOn(tasks, today);

    if (merged) {
      // The same tasks the priority queue would show, rebucketed so each sits beside the
      // day-note rows of its own urgency.
      const horizons = bucketTasksByHorizon(priorityQueue, effectiveValuesMap, today);
      // Finished work belongs to the day's horizon; the list sinks it below the open rows.
      horizons.current = [...horizons.current, ...completedHere];
      this.renderMergedSections(content, dayItems, dnPath, pastDays, futureDays, horizons);
      this.renderDayAddBar(content);
      return;
    }

    const split = this.plugin.settings.splitTaskLists;
    const { body: dailyTasksBody } = this.createCollapsibleSection(content, "Daily Tasks", "tasks.dailyGroup");
    if (split) {
      this.renderAdjacentUnclosedSection(dailyTasksBody, pastDays, "tasks.previousUnclosed", "Overdue tasks");
      this.renderChecklistSection(dailyTasksBody, dayItems, dnPath, this.dashboardDate);
      this.renderAdjacentUnclosedSection(dailyTasksBody, futureDays, "tasks.upcomingUnclosed", "Upcoming tasks");
    } else {
      this.renderChecklistSection(dailyTasksBody, dayItems, dnPath, this.dashboardDate, { pastDays, futureDays });
    }

    const { body: projectTasksBody } = this.createCollapsibleSection(content, "Project Tasks", "tasks.projectGroup");
    if (split) {
      this.renderPrioritySection(projectTasksBody, priorityQueue);
      this.renderCompletedSection(projectTasksBody, completedHere);
    } else if (priorityQueue.length === 0 && completedHere.length === 0) {
      projectTasksBody.createDiv({ cls: "pm-dash-empty", text: "No tasks due or prioritized" });
    } else {
      // The queues in their sections' order: the ranked work, then what closed.
      this.taskList()
        .addAll([...priorityQueue, ...completedHere])
        .render(projectTasksBody);
    }

    this.renderDayAddBar(content);
  }

  /** Drops the open add-task bar's document-level watcher too, no render following to
   *  do it. */
  dispose(): void {
    super.dispose();
    this.addBarDismiss?.();
    this.addBarDismiss = null;
    // Its sections are going away with the view.
    this.stopFill();
  }

  /** Drops the horizons a fill still running would write into — they belong to a tree
   *  about to be replaced. Called by every render, its own and the other tabs'. */
  stopFill(): void {
    this.stopWarm?.();
    this.stopWarm = null;
    this.horizonSlots = null;
    this.nothingToDo = null;
  }

  /** Shows or hides the add-task bar and its "+", the focus following it. `focus` is off
   *  when a render replays the state onto a still-detached tree. */
  private setAddBarOpen(open: boolean, focus = true): void {
    this.addBarOpen = open;
    this.addBarDismiss?.();
    this.addBarDismiss = null;
    if (!open && focus) this.addBar?.input.blur();
    this.addBar?.bar.classList.toggle("pm-add-bar--collapsed", !open);
    this.addBarToggle?.classList.toggle("is-active", open);
    this.addBarToggle?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    if (focus) this.addBar?.input.focus();
    this.addBarDismiss = this.watchAddBarTapAway();
  }

  /** Closes the bar on the first tap outside it. Not `blur`: a tap on a row leaves the
   *  input focused. Capture, since rows stop the event from bubbling. */
  private watchAddBarTapAway(): () => void {
    const onPointerDown = (e: Event): void => {
      const target = e.target as Node;
      if (this.addBar?.bar.contains(target) || this.addBarToggle?.contains(target)) return;
      this.setAddBarOpen(false);
    };
    activeDocument.addEventListener("pointerdown", onPointerDown, true);
    return () => activeDocument.removeEventListener("pointerdown", onPointerDown, true);
  }

  /**
   * The add-task bar, writing onto the day on show: that is the day the task is meant for.
   * A day with no note takes the task through the inbox under a ⏳ for it, which is worth
   * saying since the row then lands in Current with no note ever appearing. The bar stays
   * hidden until the navigator's "+" asks for it.
   */
  private renderDayAddBar(content: HTMLElement): void {
    const date = this.dashboardDate;
    const dayLabel = sameDay(date, new Date()) ? "today" : formatPattern(date, "MMM D");
    this.addBar = this.renderAddBar(content, `➕ Add a task to ${dayLabel}…`, async (title) => {
      const outcome = await this.plugin.tasks.addTaskToDay(date, title);
      // The input has cleared by now, so a silent failure loses what was typed.
      if (outcome === ScheduleOutcome.Failed) {
        throw new Error(`couldn't write the task onto ${formatPattern(date, "YYYY-MM-DD")}`);
      }
      if (outcome === ScheduleOutcome.Targeted) {
        const label = formatPattern(date, "MMM D");
        // A past day is unlikely to get a note, so promise nothing about moving there.
        new Notice(diffDays(new Date(), date) < 0
          ? `${label} has no daily note — added to the inbox, targeted for that day.`
          : `Added to the inbox, targeted for ${label} — it moves there once that daily note exists.`);
      }
    });
    // Escape puts the bar away, the keyboard with it.
    this.addBar.input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") this.setAddBarOpen(false);
    });
    this.setAddBarOpen(this.addBarOpen, false);
  }

  /**
   * The three horizons, each holding its day-note rows above its project tasks: overdue,
   * the picked day, then what is coming. `splitTaskLists` keeps them as three sections;
   * off, they run into one list, which is why every row carries its date.
   */
  private renderMergedSections(
    content: HTMLElement,
    checklistItems: Task[],
    dnPath: string | null,
    pastDays: AdjacentDayData[],
    futureDays: AdjacentDayData[],
    horizons: TaskHorizons,
  ): void {
    const split = this.plugin.settings.splitTaskLists;
    const isToday = sameDay(this.dashboardDate, new Date());
    const flatBody = split ? null : content.createDiv({ cls: "pm-dash-merged-list" });

    const sections = [
      {
        title: "Overdue", key: "tasks.overdue",
        tooltip: "Unclosed checklist items from the previous days, and project tasks past their due date.",
        days: pastDays, checklist: false, tasks: horizons.overdue,
        empty: "Nothing overdue", fill: "overdue" as const,
      },
      {
        title: "Current", key: "tasks.current",
        tooltip: "The day's own checklist, and project tasks due today.",
        days: [], checklist: true, tasks: horizons.current,
        empty: `Nothing on ${isToday ? "today" : formatPattern(this.dashboardDate, "MMM D")}`, fill: null,
      },
      {
        title: "Next up", key: "tasks.nextUp",
        tooltip: "Unclosed checklist items from the coming days, and the project tasks waiting behind them.",
        days: futureDays, checklist: false, tasks: horizons.nextUp,
        empty: "Nothing coming up", fill: "nextUp" as const,
      },
    ];

    let rendered = false;
    const slots: Partial<Record<"overdue" | "nextUp", HorizonSlot>> = {};
    for (const section of sections) {
      const dayItems = section.checklist ? checklistItems : [];
      const has = section.days.length > 0 || dayItems.length > 0 || section.tasks.length > 0;
      const body = flatBody
        ?? this.createCollapsibleSection(content, section.title, section.key, { tooltip: section.tooltip }).body;
      // Ungrouped, a per-horizon message has nowhere to belong; one whole-list message
      // follows instead.
      const empty = !has && split ? body.createDiv({ cls: "pm-dash-empty", text: section.empty }) : null;
      // "Current" is the day on show alone: no later read adds to it, so an empty one
      // stays a message. The other two are still filling, and need their list ready.
      if (!has && !section.fill) continue;
      if (has) rendered = true;
      const list = this.taskList();
      list.addAll(section.checklist ? this.orderedDayRows(dayItems) : section.days.flatMap((d) => d.unclosedItems));
      list.addAll(section.tasks);
      // Dated, the two kinds interleave — deepest overdue first, nearest deadline first.
      // "Current" is all one day, so the note orders it: its checklist, then that day's tasks.
      list.render(body, {
        sortByDate: !section.checklist,
        dateOf: this.effectiveDateOf(),
        reorder: section.checklist ? this.reorder(dnPath) : undefined,
      });
      if (section.fill) slots[section.fill] = { list, empty };
    }
    this.horizonSlots = { overdue: slots.overdue!, nextUp: slots.nextUp! };
    this.nothingToDo = flatBody && !rendered
      ? flatBody.createDiv({ cls: "pm-dash-empty", text: "Nothing to do" })
      : null;
  }

  /** A day note's unclosed rows as a horizon wants them, or null when it holds none. */
  private toAdjacent({ entry, offset }: WarmedDay): AdjacentDayData | null {
    const unclosedItems = entry.unclosedItems(this.plugin.tasks.habitsTag);
    if (unclosedItems.length === 0 || !entry.date) return null;
    return { offset, date: entry.date, unclosedItems, filePath: entry.path };
  }

  /**
   * Takes the window's days as the cache reads them, dropping each one's unclosed rows
   * into the horizon it belongs to — the sections having been drawn without them.
   * Delivered deepest overdue first and farthest ahead last, which is the order the rows
   * end up in, so each lands at the bottom of what is there.
   */
  fillAdjacentDays(): void {
    if (!this.horizonSlots) return;
    const cache = this.plugin.tasks;
    this.stopWarm = cache.on(CacheEvent.DayWarmed, (warmed) => this.dropIntoHorizon(warmed));
    const { before, after } = this.unclosedWindow();
    cache.warmWindow(this.dashboardDate, before, after);
  }

  private dropIntoHorizon(warmed: WarmedDay): void {
    const slots = this.horizonSlots;
    if (this.paintedDays.has(warmed.offset)) return;
    const day = this.toAdjacent(warmed);
    if (!slots || !day) return;
    const slot = warmed.offset < 0 ? slots.overdue : slots.nextUp;
    slot.empty?.remove();
    slot.empty = null;
    this.nothingToDo?.remove();
    this.nothingToDo = null;
    for (const item of day.unclosedItems) slot.list.insertSorted(item);
  }

  /** A list of whatever the dashboard puts in it, with the one branch where the two kinds
   *  of task part ways. Everything else a row needs it carries. */
  private taskList(): TaskList {
    const { projectMap, effectiveValues, habitsTag, inboxPath } = this.context;
    return new TaskList((task, list, lead) => task.row({
      checklistLine: (line) => this.renderChecklistRow(list, line, habitsTag, inboxPath, lead),
      projectTask: (projectTask) => this.renderProjectTaskRow(list, projectTask, projectMap, effectiveValues),
    }));
  }

  /** A project task sorts by the deadline in force, a day task by its note's day — both
   *  off the task itself, see `plannedDateInForce`. */
  private effectiveDateOf() {
    const { effectiveValues } = this.context;
    return (task: BaseTask) => task.plannedDateInForce((id) => effectiveValues.get(id));
  }

  /** The drag a list of `filePath`'s own rows can persist. Habits are excluded, being
   *  reordered from their definitions, as are another day's rows. */
  private reorder(filePath: string | null) {
    if (!filePath) return undefined;
    const { habitsTag } = this.context;
    return {
      canMove: (task: BaseTask) =>
        task.keepsFileOrder && task.filePath === filePath && !task.hasTag(habitsTag),
      onDrop: ({ item, next }: ReorderDrop<Task>) => this.runMutation(
        () => this.plugin.tasks.reorderChecklistItem(item, next),
        "Couldn't reorder the task",
      ),
    };
  }

  /** A day's own rows in the order they are shown: its habit rows, then the rest. */
  private orderedDayRows(items: Task[]): Task[] {
    const isHabit = (it: Task) => it.hasTag(this.context.habitsTag);
    return [...items.filter(isHabit), ...items.filter((it) => !isHabit(it))];
  }

  /** Places each planned inbox line against the day on show, or a neighbour's
   *  `AdjacentDayData`. Bounded by the same window as the notes. */
  private placePlanned(
    plannedItems: Task[],
    adjacentData: AdjacentDayData[],
  ): { here: Task[]; adjacent: AdjacentDayData[] } {
    const { before, after } = this.unclosedWindow();

    const here: Task[] = [];
    // Keyed on the days the notes gave, so one holding both a note's rows and a planned
    // line stays a single entry. A copy, leaving the caller's list untouched.
    const byOffset = new Map(adjacentData.map((d) => [d.offset, d]));
    for (const item of plannedItems) {
      const day = item.plannedDate;
      const offset = day ? diffDays(this.referenceDate(), day) : undefined;
      if (offset === undefined || offset < -before || offset > after) continue;
      if (offset === 0) {
        here.push(item);
        continue;
      }
      const existing = byOffset.get(offset);
      const entry = existing
        ? { ...existing, unclosedItems: [...existing.unclosedItems, item] }
        : { offset, date: day!, unclosedItems: [item], filePath: item.filePath };
      byOffset.set(offset, entry);
    }
    return { here, adjacent: [...byOffset.values()] };
  }

  /** The day's note, made for the click that asked for it. The one creation a user
   *  requests outright, so it is also the one that reports what stopped it. */
  private async createAndOpenDayNote(): Promise<void> {
    const note = await this.plugin.tasks.ensureDayNote(this.dashboardDate);
    if (note) {
      openNoteFile(this.app, note.path);
      return;
    }
    new Notice(await this.plugin.vault.dayNotes.canCreate()
      ? "Couldn't create the day note"
      : "Turn on the daily notes core plugin to create day notes.");
  }

  /** How many days either side of the one on show are read for unclosed rows. The three
   *  readers share it, so a planned line and a note's rows are bounded the same way. */
  private unclosedWindow(): { before: number; after: number } {
    const { unclosedDaysBefore, unclosedDaysAfter } = this.plugin.settings;
    return {
      before: unclosedDaysBefore ?? DEFAULT_SETTINGS.unclosedDaysBefore,
      after: unclosedDaysAfter ?? DEFAULT_SETTINGS.unclosedDaysAfter,
    };
  }

  /** The day's own checklist. With `splitTaskLists` off, `adjacent` carries the overdue
   *  and upcoming days, whose rows join this list in their sections' order. */
  private renderChecklistSection(
    container: HTMLElement,
    items: Task[],
    filePath: string | null,
    date: Date,
    adjacent?: { pastDays: AdjacentDayData[]; futureDays: AdjacentDayData[] },
  ): void {
    const isToday = sameDay(date, new Date());
    const dateLabel = isToday ? "Today" : formatPattern(date, "MMM D");
    // Grouped, this list is all "Daily Tasks" holds, and a checklist title would misname
    // the adjacent days' rows.
    const body = adjacent
      ? container
      : this.createCollapsibleSection(container, `${dateLabel}'s Checklist`, "tasks.checklist", {
          sub: true,
          tooltip: "Checklist items from the daily note. Click an item to toggle it.",
        }).body;

    const pastDays = adjacent?.pastDays ?? [];
    const futureDays = adjacent?.futureDays ?? [];

    if (items.length === 0 && pastDays.length === 0 && futureDays.length === 0) {
      body.createDiv({
        cls: "pm-dash-empty",
        text: `No checklist items in ${dateLabel.toLowerCase()}'s note`,
      });
      return;
    }

    const list = this.taskList();
    list.addAll(pastDays.flatMap((d) => d.unclosedItems));
    list.addAll(this.orderedDayRows(items));
    list.addAll(futureDays.flatMap((d) => d.unclosedItems));
    list.render(body, { reorder: this.reorder(filePath) });
  }

  private renderAdjacentUnclosedSection(
    container: HTMLElement,
    days: AdjacentDayData[],
    key: string,
    title: string,
  ): void {
    if (days.length === 0) return;

    const { body } = this.createCollapsibleSection(container, title, key, {
      sub: true,
      tooltip: key.includes("previous")
        ? "Unclosed checklist items from the previous 7 days."
        : "Unclosed checklist items from the next 7 days.",
    });

    this.taskList()
      .addAll(days.flatMap((d) => d.unclosedItems))
      .render(body);
  }

  /**
   * A day-note checklist line on `renderRowShell`'s skeleton, adding only what the
   * dashboard puts at its two ends. A habit row skips title editing and everything past
   * the note button, belonging to a shared definition; a ticked one skips reschedule and
   * move-to-inbox, which would untick it, but keeps unplan.
   */
  private renderChecklistRow(
    list: HTMLElement,
    item: Task,
    habitsTag: string,
    resolvedInboxPath: string,
    lead: { addDragHandle: AddDragHandle<Task>; movable: boolean },
  ): void {
    const filePath = item.filePath;
    const isDaily = item.hasTag(habitsTag);
    // A line waiting in the inbox for this day, which has no note to hold it yet.
    const planned = filePath === resolvedInboxPath;
    // The day the row falls under: its note's, or a planned line's ⏳ target.
    const day = item.plannedDate;
    const rowDate = day ?? this.dashboardDate;

    this.renderRowShell(list, item, {
      cls: "pm-dash-checklist-item",
      titleCls: "pm-dash-checklist-text",
      habitsTag,
      addDragHandle: (parent, row, draggable) => lead.addDragHandle(parent, row, item, draggable),
      movable: lead.movable,
      ...this.checklistSlots(item, habitsTag),
      toggleLabel: item.checked ? "Reopen task" : "Close task",
      // A planned line has no entry in this day's note to tick, so it closes as the
      // Inbox's own checkbox does.
      onToggle: planned
        ? () => this.runMutation(
            () => this.plugin.tasks.closeInboxItem(item),
            "Couldn't close the task",
          )
        : filePath
        ? (box, li) => {
            // Taken before the write: the line moves with the tick, so it reads as the new
            // one from here on.
            const oldRawLine = item.rawLine;
            item.setChecked(!item.checked);
            void item.flush().then(() => {
              // Optimistic local toggle — avoids a full re-render on every click.
              migrateNoteKey(this.openNoteKeys, item, oldRawLine, item.rawLine);
              li.toggleClass("pm-dash-checklist-item--checked", item.checked);
              box.toggleClass("pm-dash-checkbox--checked", item.checked);
              box.setAttribute("aria-checked", String(item.checked));
              box.setAttribute("aria-label", item.checked ? "Reopen task" : "Close task");
            }).catch((e) => {
              // The patch never ran, so a refresh re-reads the file and resyncs the box.
              console.error("pm-compass: couldn't update the task", e);
              new Notice("Couldn't update the task");
              this.onRefresh();
            });
          }
        : undefined,
      badges: (main) => {
        if (!day) return;
        this.renderDateBadge(createBadgeBand(main), day, {
          title: `${formatPattern(rowDate, "ddd, MMM D")} — show that day`,
          onClick: () => this.showDay(day),
        });
      },
      actions: (main, li, titleSpan) => {
        if (!filePath) return;
        const actions = main.createDiv({ cls: "pm-task-actions" });
        if (!isDaily) {
          appendEditTitleButton(
            actions, main, titleSpan,
            dayTaskTitleEdit(
              item, "pm-dash-checklist-text", this.openNoteKeys, () => this.onRefresh(),
            ),
          );
        }
        appendNoteActionButton(
          actions, li, item, this.app, this.openNoteKeys,
          this.plugin.settings.confirmNoteRemoval, () => this.onRefresh(),
        );
        if (isDaily) return;

        // A ticked line records work done, not a plan, so it is neither re-planned nor
        // moved to the inbox — both would untick it.
        const replannable = !item.checked;

        if (replannable) {
          appendRescheduleButton(actions, (targetDate) => {
            this.runMutation(
              async () => {
                const outcome = await this.plugin.tasks.rescheduleChecklistItem(item, targetDate);
                // A day with no note doesn't take the item; it waits in the inbox, which
                // is worth saying since it has just left the checklist.
                if (outcome === ScheduleOutcome.Targeted) {
                  new Notice(`Moved to the inbox, targeted for ${formatPattern(targetDate, "MMM D")}.`);
                }
              },
              "Couldn't reschedule the task",
            );
          }, undefined, rowDate);
        }

        appendActionButton(actions, {
          icon: Icon.PromoteToProjectTask,
          label: "Promote to project task",
          title: "Promote to a project task",
          onClick: () => this.openPromoteModal(item, filePath, this.projects, habitsTag),
        });

        // A planned line is in the inbox already, so the slot drops its target day —
        // clearing the ⏳ alone, which a ticked line survives.
        if (replannable || planned) {
          appendActionButton(actions, {
            icon: Icon.MoveToInbox,
            label: planned ? "Unplan" : "Move to inbox",
            title: planned ? "Clear the target day, keeping it in the inbox" : "Move to inbox",
            onClick: () => this.runMutation(
              () => {
                if (!planned) return this.plugin.tasks.moveChecklistItemToInbox(item);
                item.setScheduledDate(null);
                return item.flush();
              },
              planned ? "Couldn't clear the target day" : "Couldn't move the task to the inbox",
            ),
          });
        }

        appendActionButton(actions, {
          icon: Icon.DeleteTask,
          label: "Delete",
          title: "Delete task",
          danger: true,
          onClick: () => {
            confirmAction(this.app, this.plugin.settings.confirmDeletes, `Delete "${item.title}"?`, () => {
              this.runMutation(() => { item.remove(); return item.flush(); }, "Couldn't delete the task");
            });
          },
        });
      },
    });
  }

  /**
   * One project-task queue as its own sub-section, on the same list class as every other
   * section so the rows line up with the day tasks' above them. Each queue arrives in the
   * order its selection put it in — urgency, closing time — so neither is re-sorted here.
   * `empty` is what an empty queue shows; without one it draws no section at all.
   */
  private renderQueueSection(
    container: HTMLElement,
    tasks: ProjectTask[],
    section: { title: string; key: string; tooltip: string; empty?: string },
  ): void {
    if (tasks.length === 0 && section.empty === undefined) return;
    const { body } = this.createCollapsibleSection(container, section.title, section.key, {
      sub: true,
      tooltip: section.tooltip,
    });
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: section.empty });
      return;
    }
    this.taskList().addAll(tasks).render(body);
  }

  private renderPrioritySection(container: HTMLElement, tasks: ProjectTask[]): void {
    this.renderQueueSection(container, tasks, {
      title: "Priority Queue",
      key: "tasks.priority",
      tooltip: "Every dated task, most urgent first — overdue at the top. "
        + "Priority and deadline are inherited from parent tasks.",
      empty: "No tasks due or prioritized",
    });
  }

  /** What the day on show closed. Absent on a day that closed nothing, which is most. */
  private renderCompletedSection(container: HTMLElement, tasks: ProjectTask[]): void {
    this.renderQueueSection(container, tasks, {
      title: "Completed",
      key: "tasks.completed",
      tooltip: "Project tasks completed on this day.",
    });
  }
}
