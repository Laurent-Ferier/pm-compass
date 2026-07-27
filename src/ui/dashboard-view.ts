import { Notice } from "obsidian";
import { openNoteFile } from "./task-creator";
import { isEffectivelyClosed, type Task, type Project } from "../model/shared";
import { DayTask, resolveHabitsTag } from "../model/day-task";
import { DayMarkdownFile } from "../model/day-markdown-file";
import { DailyNotesConfig } from "../model/week-summary";
import { ScheduleOutcome } from "../model/task-vocabulary";
import { NAV_PREV_SVG, NAV_NEXT_SVG, CALENDAR_SVG, TRASH_SVG, INBOX_SVG, PROMOTE_SVG, setSvgIcon } from "./icons";
import { addDays, diffDays, sameDay, startOfDay } from "../model/dates";
import { formatPattern } from "../model/date-format";
import {
  bucketTasksByHorizon, buildParentIdSet,
  computeEffectiveValues, selectApproachingDeadlines, selectPriorityQueue,
  type EffectiveValues, type TaskHorizons,
} from "../model/task-scoring";
import {
  loadDayChecklist, rescheduleChecklistItem, moveChecklistItemToInbox, deleteChecklistItem,
  toggleChecklistItem, reorderChecklistItem, closeInboxItem, unscheduleInboxItem,
} from "../model/day-task-actions";
import { type AddDragHandle, type ReorderDrop } from "./drag-reorder";
import { TaskList } from "./task-list";
import type { BaseTask } from "../model/base-task";
import { BaseTabView } from "./base-tab-view";
import {
  appendEditTitleButton, dayTaskTitleEdit, appendNoteActionButton,
  appendRescheduleButton, migrateNoteKey,
} from "./day-task-row";
import { ConfirmModal } from "./task-creator";
import { openDatePicker } from "./date-picker";
import { createBadgeBand } from "./task-badges";

export const DASHBOARD_VIEW_TYPE = "pm-compass-dashboard";

// ── Dashboard (tasks tab) ─────────────────────────────────────────────────────

export interface AdjacentDayData {
  offset: number;
  date: Date;
  unclosedItems: DayTask[];
  filePath: string | null;
}

export class DashboardView extends BaseTabView {
  dashboardDate: Date = startOfDay(new Date());
  /** Set on each render; read by the day-task rows' promote action, which sits
   *  several levels below `render` in the call chain. */
  private projects: Project[] = [];

  /** What every list of one render draws from, set once at the top of `render()` so a
   *  section only has to say what is in it. */
  private context: {
    projectMap: Map<string, Project>;
    effectiveValues: Map<string, EffectiveValues>;
    habitsTag: string;
    inboxPath: string;
  } = { projectMap: new Map(), effectiveValues: new Map(), habitsTag: "daily", inboxPath: "" };

  /** Puts the dashboard on `date`, for the `showDay` handler `PMCompassView` gives every
   *  tab — which also has to bring this one to the front. */
  setDate(date: Date): void {
    this.dashboardDate = startOfDay(date);
  }

  /** Every date on the tab reads against the day on show, not the real today. */
  protected override referenceDate(): Date {
    return this.dashboardDate;
  }

  render(
    content: HTMLElement,
    checklistItems: DayTask[],
    dnPath: string | null,
    tasks: Task[],
    projects: Project[],
    adjacentData: AdjacentDayData[],
    resolvedInboxPath: string,
    /** Inbox lines carrying a ⏳ target day, still waiting on that day's note. */
    plannedItems: DayTask[] = [],
  ): void {
    this.projects = projects;
    const { here: plannedHere, adjacent: adjacentAll } = this.placePlanned(plannedItems, adjacentData);
    const dayItems = [...checklistItems, ...plannedHere];

    // ── Date navigator ──────────────────────────────────────────────────────
    const dateNav = content.createDiv({ cls: "pm-dash-date-nav" });

    const isToday = sameDay(this.dashboardDate, new Date());

    const prevDayBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Previous day" } });
    setSvgIcon(prevDayBtn, NAV_PREV_SVG);
    prevDayBtn.addEventListener("click", () => { this.dashboardDate = addDays(this.dashboardDate, -1); this.onRefresh(); });

    const dateLabelText = dateNav.createSpan({
      cls: `pm-dash-date-text${dnPath ? " pm-dash-date-text--has-note" : " pm-dash-date-text--no-note"}`,
      text: formatPattern(this.dashboardDate, "dddd, MMMM D"),
    });
    dateLabelText.addEventListener("click", () => {
      if (dnPath) {
        openNoteFile(this.app, dnPath);
      } else {
        void DayMarkdownFile.ensure(this.app, this.dashboardDate).then((dmf) => {
          if (dmf) openNoteFile(this.app, dmf.filePath);
        });
      }
    });

    if (!isToday) {
      const todayBtn = dateNav.createEl("button", { cls: "pm-dash-today-btn", text: "Today" });
      todayBtn.addEventListener("click", () => { this.dashboardDate = startOfDay(new Date()); this.onRefresh(); });
    }

    const calBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn pm-dash-cal-btn", attr: { "aria-label": "Pick date" } });
    setSvgIcon(calBtn, CALENDAR_SVG);
    calBtn.addEventListener("click", () => {
      openDatePicker(calBtn, {
        initial: this.dashboardDate,
        onPick: (date) => { this.dashboardDate = date; this.onRefresh(); },
      });
    });

    const nextDayBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Next day" } });
    setSvgIcon(nextDayBtn, NAV_NEXT_SVG);
    nextDayBtn.addEventListener("click", () => { this.dashboardDate = addDays(this.dashboardDate, 1); this.onRefresh(); });

    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const activeTasks = tasks.filter((t) => !isEffectivelyClosed(t, taskById));

    // A planned day joins the neighbouring notes in the same order, so "two days ago" reads
    // as one horizon whether the row is written in that day's note or still in the inbox.
    const pastDays = adjacentAll.filter((d) => d.offset < 0).sort((a, b) => b.offset - a.offset);
    const futureDays = adjacentAll.filter((d) => d.offset > 0).sort((a, b) => a.offset - b.offset);

    const effectiveValuesMap = computeEffectiveValues(activeTasks, taskById);
    this.context = {
      projectMap,
      effectiveValues: effectiveValuesMap,
      habitsTag: resolveHabitsTag(this.plugin.settings.dailyHabitsTag),
      inboxPath: resolvedInboxPath,
    };
    const parentIds = buildParentIdSet(activeTasks);
    // The horizons split around the day on show, so a task's section matches its badge.
    const today = this.referenceDate();

    const merged = this.plugin.settings.mergeDailyAndProjectTasks;
    const approachingDeadlines = selectApproachingDeadlines(
      activeTasks, effectiveValuesMap, parentIds, today,
    );
    const deadlineIds = new Set(approachingDeadlines.map((t) => t.id));
    // An undated task is the Inbox's alone (`selectUndatedTasks`): no horizon here holds
    // it, and no deadline queues it.
    const priorityQueue = selectPriorityQueue(activeTasks, effectiveValuesMap, parentIds, deadlineIds);

    if (merged) {
      // The same tasks the two project sections would show, rebucketed so each sits beside
      // the day-note rows of its own urgency.
      const horizons = bucketTasksByHorizon(
        [...approachingDeadlines, ...priorityQueue], effectiveValuesMap, today,
      );
      this.renderMergedSections(content, dayItems, dnPath, pastDays, futureDays, horizons);
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
      this.renderDeadlinesSection(projectTasksBody, approachingDeadlines);
      this.renderPrioritySection(projectTasksBody, priorityQueue);
    } else if (approachingDeadlines.length === 0 && priorityQueue.length === 0) {
      projectTasksBody.createDiv({ cls: "pm-dash-empty", text: "No tasks due or prioritized" });
    } else {
      // The two queues in their own sections' order: due within the week, then waiting.
      this.taskList()
        .addAll([...approachingDeadlines, ...priorityQueue])
        .render(projectTasksBody);
    }
  }

  /**
   * The three horizons, each holding its day-note rows above its project tasks: past days
   * and overdue tasks, the picked day's checklist and what is due today, then the coming
   * days and everything left. `splitTaskLists` keeps them as three sections; off, they run
   * into one untitled list in that order — which is why every row here carries its date,
   * "today" included: it is all that tells the horizons apart.
   */
  private renderMergedSections(
    content: HTMLElement,
    checklistItems: DayTask[],
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
        empty: "Nothing overdue",
      },
      {
        title: "Current", key: "tasks.current",
        tooltip: "The day's own checklist, and project tasks due today.",
        days: [], checklist: true, tasks: horizons.current,
        empty: `Nothing on ${isToday ? "today" : formatPattern(this.dashboardDate, "MMM D")}`,
      },
      {
        title: "Next up", key: "tasks.nextUp",
        tooltip: "Unclosed checklist items from the coming days, and the project tasks waiting behind them.",
        days: futureDays, checklist: false, tasks: horizons.nextUp,
        empty: "Nothing coming up",
      },
    ];

    let rendered = false;
    for (const section of sections) {
      const dayItems = section.checklist ? checklistItems : [];
      const has = section.days.length > 0 || dayItems.length > 0 || section.tasks.length > 0;
      const body = flatBody
        ?? this.createCollapsibleSection(content, section.title, section.key, { tooltip: section.tooltip }).body;
      if (!has) {
        // Ungrouped, a per-horizon message has nowhere to belong; one for the whole list
        // follows instead.
        if (split) body.createDiv({ cls: "pm-dash-empty", text: section.empty });
        continue;
      }
      rendered = true;
      const list = this.taskList();
      list.addAll(section.checklist ? this.orderedDayRows(dayItems) : section.days.flatMap((d) => d.unclosedItems));
      list.addAll(section.tasks);
      // Dated, the two kinds interleave — deepest overdue first, nearest deadline first.
      // "Current" all falls on the one day, so only the note orders it: its checklist, in
      // its own (draggable) order, then the tasks due that day.
      list.render(body, {
        sortByDate: !section.checklist,
        dateOf: this.effectiveDateOf(),
        reorder: section.checklist ? this.reorder(dnPath) : undefined,
      });
    }
    if (flatBody && !rendered) flatBody.createDiv({ cls: "pm-dash-empty", text: "Nothing to do" });
  }

  /**
   * A list of whatever the dashboard puts in it, with the one branch where the two kinds of
   * task part ways. Everything else a row needs it carries — its own file, and for a day
   * task the day its note is for — so no section has to thread that down.
   */
  private taskList(): TaskList {
    const { projectMap, effectiveValues, habitsTag, inboxPath } = this.context;
    return new TaskList((task, list, lead) => {
      if (task instanceof DayTask) {
        this.renderChecklistRow(list, task, habitsTag, inboxPath, lead);
      } else {
        this.renderProjectTaskRow(list, task as Task, projectMap, effectiveValues);
      }
    });
  }

  /** A project task sorts by the deadline in force, which can be an ancestor's; a day task
   *  by its own note's day. */
  private effectiveDateOf() {
    const { effectiveValues } = this.context;
    return (task: BaseTask) => task instanceof DayTask
      ? task.plannedDate
      : effectiveValues.get((task as Task).id)?.due ?? task.plannedDate;
  }

  /** The drag a list of `filePath`'s own rows can persist. Habit rows are excluded —
   *  `reconcileRecurringHabits` rewrites them into their definitions' order on every
   *  refresh — as are another day's rows, whose order lives in their own note. */
  private reorder(filePath: string | null) {
    if (!filePath) return undefined;
    const { habitsTag } = this.context;
    return {
      canMove: (task: BaseTask) =>
        task instanceof DayTask && task.filePath === filePath && !task.tags.includes(`#${habitsTag}`),
      onDrop: ({ item, next }: ReorderDrop<DayTask>) => this.runMutation(
        () => reorderChecklistItem(this.app, filePath, item, next),
        "Couldn't reorder the task",
      ),
    };
  }

  /** A day's own rows in the order they are shown: its habit rows, then the rest. */
  private orderedDayRows(items: DayTask[]): DayTask[] {
    const isHabit = (it: DayTask) => it.tags.includes(`#${this.context.habitsTag}`);
    return [...items.filter(isHabit), ...items.filter((it) => !isHabit(it))];
  }

  /**
   * Places each planned inbox line against the day on show: its own checklist, or — a
   * neighbouring day — that day's `AdjacentDayData`, which every section already renders.
   * Bounded by the same `unclosedDaysBefore`/`unclosedDaysAfter` window as the notes; a
   * line aimed further out stays in the Inbox tab alone.
   */
  private placePlanned(
    plannedItems: DayTask[],
    adjacentData: AdjacentDayData[],
  ): { here: DayTask[]; adjacent: AdjacentDayData[] } {
    const before = this.plugin.settings.unclosedDaysBefore ?? 7;
    const after = this.plugin.settings.unclosedDaysAfter ?? 7;

    const here: DayTask[] = [];
    // Keyed on the days the notes already gave us, so a day holding both a note's rows and
    // a planned line stays one entry — a copy, leaving the caller's list untouched.
    const byOffset = new Map(adjacentData.map((d) => [d.offset, d]));
    for (const item of plannedItems) {
      const day = item.plannedDate;
      // Its distance from the day on show, inside the same window the notes are read over.
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

  async loadAdjacentUnclosed(
    date: Date,
    config: DailyNotesConfig,
  ): Promise<AdjacentDayData[]> {
    const before = this.plugin.settings.unclosedDaysBefore ?? 7;
    const after = this.plugin.settings.unclosedDaysAfter ?? 7;
    const offsets = [
      ...Array.from({ length: before }, (_, i) => -(i + 1)),
      ...Array.from({ length: after }, (_, i) => i + 1),
    ];
    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);
    const results = await Promise.all(offsets.map(async (offset) => {
      const day = addDays(date, offset);
      const { items, filePath } = await loadDayChecklist(this.app, day, config);
      const unclosedItems = items.filter((it) => !it.checked && !it.tags.includes(`#${habitsTag}`));
      return { offset, date: day, unclosedItems, filePath };
    }));
    return results.filter((d) => d.unclosedItems.length > 0);
  }

  /** The day's own checklist. With `splitTaskLists` off, `adjacent` carries the overdue and
   *  upcoming days, whose rows join this one list in their own sections' order. */
  private renderChecklistSection(
    container: HTMLElement,
    items: DayTask[],
    filePath: string | null,
    date: Date,
    adjacent?: { pastDays: AdjacentDayData[]; futureDays: AdjacentDayData[] },
  ): void {
    const isToday = sameDay(date, new Date());
    const dateLabel = isToday ? "Today" : formatPattern(date, "MMM D");
    // Grouped, the one list is all the enclosing "Daily Tasks" section holds, so it needs
    // no header of its own — and a checklist title would misname the adjacent days' rows.
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
   * A day-note checklist line on `BaseTabView.renderDayTaskRow`'s skeleton — this adds only
   * what the dashboard puts at its two ends, everything else coming off the task itself.
   *
   * Habit-tagged rows skip title editing and reschedule/inbox/delete, which only make sense
   * for a single day's own task, not a shared habit definition. Every dated row is badged
   * with its day, read against the day on show — which is what tells the merged lists'
   * horizons apart.
   */
  private renderChecklistRow(
    list: HTMLElement,
    item: DayTask,
    habitsTag: string,
    resolvedInboxPath: string,
    lead: { addDragHandle: AddDragHandle<DayTask>; movable: boolean },
  ): void {
    const filePath = item.filePath;
    const isDaily = item.tags.includes(`#${habitsTag}`);
    // A line still waiting in the inbox for this day, which has no note to hold it yet.
    const planned = filePath === resolvedInboxPath;
    // The day the row falls under: its note's, or — a planned line — its ⏳ target.
    const day = item.plannedDate;
    const rowDate = day ?? this.dashboardDate;

    this.renderDayTaskRow(list, item, {
      cls: "pm-dash-checklist-item",
      titleCls: "pm-dash-checklist-text",
      habitsTag,
      addDragHandle: lead.addDragHandle,
      movable: lead.movable,
      toggleLabel: item.checked ? "Reopen task" : "Close task",
      // A planned line has no entry in this day's note to tick, and `- [x]` in the inbox
      // is deleted on the next read — so it closes as the Inbox's own checkbox does.
      onToggle: planned
        ? () => this.runMutation(
            () => closeInboxItem(this.app, resolvedInboxPath, item),
            "Couldn't close the task",
          )
        : filePath
        ? (box, li) => {
            void toggleChecklistItem(this.app, filePath, item).then((newRawLine) => {
              // Optimistic local toggle — avoids a full re-render on every click.
              migrateNoteKey(this.openNoteKeys, filePath, item.rawLine, newRawLine);
              item.checked = !item.checked;
              item.rawLine = newRawLine;
              li.toggleClass("pm-dash-checklist-item--checked", item.checked);
              box.toggleClass("pm-dash-checkbox--checked", item.checked);
              box.setAttribute("aria-checked", String(item.checked));
              box.setAttribute("aria-label", item.checked ? "Reopen task" : "Close task");
            }).catch((e) => {
              // The optimistic patch never ran, so the checkbox still shows the old
              // state; a full refresh re-reads the file and resyncs it.
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
      actions: (actions, li, titleSpan) => {
        if (!filePath) return;
        if (!isDaily) {
          appendEditTitleButton(
            actions, li.querySelector(".pm-day-task-row-main")!, titleSpan,
            dayTaskTitleEdit(
              li.querySelector(".pm-day-task-row-main")!, item, filePath, this.app,
              "pm-dash-checklist-text", this.openNoteKeys, () => this.onRefresh(),
            ),
          );
        }
        appendNoteActionButton(actions, li, item, filePath, this.app, this.openNoteKeys, () => this.onRefresh());
        if (isDaily || item.checked) return;

        appendRescheduleButton(actions, (targetDate) => {
          this.runMutation(
            async () => {
              const outcome = await rescheduleChecklistItem(
                this.app, filePath, resolvedInboxPath, item, targetDate, this.plugin.settings.dailyTasksHeading,
              );
              // A day with no daily note doesn't take the item — it waits in the inbox,
              // past day included, which is worth saying: it just left the checklist.
              if (outcome === ScheduleOutcome.Targeted) {
                new Notice(`Moved to the inbox, targeted for ${formatPattern(targetDate, "MMM D")}.`);
              }
            },
            "Couldn't reschedule the task",
          );
        }, undefined, rowDate);

        const promoteBtn = actions.createEl("button", {
          cls: "pm-task-action-btn",
          attr: { "aria-label": "Promote to project task", title: "Promote to a project task" },
        });
        setSvgIcon(promoteBtn, PROMOTE_SVG);
        promoteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openPromoteModal(item, filePath, this.projects, habitsTag);
        });

        // A planned line is in the inbox already, so the same slot drops its target day.
        const inboxBtn = actions.createEl("button", {
          cls: "pm-task-action-btn",
          attr: planned
            ? { "aria-label": "Unplan", title: "Clear the target day, keeping it in the inbox" }
            : { "aria-label": "Move to inbox", title: "Move to inbox" },
        });
        setSvgIcon(inboxBtn, INBOX_SVG);
        inboxBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.runMutation(
            () => planned
              ? unscheduleInboxItem(this.app, resolvedInboxPath, item)
              : moveChecklistItemToInbox(this.app, filePath, item, resolvedInboxPath),
            planned ? "Couldn't clear the target day" : "Couldn't move the task to the inbox",
          );
        });

        const deleteBtn = actions.createEl("button", {
          cls: "pm-task-action-btn pm-task-action-btn--delete",
          attr: { "aria-label": "Delete", title: "Delete task" },
        });
        setSvgIcon(deleteBtn, TRASH_SVG);
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
            this.runMutation(() => deleteChecklistItem(this.app, filePath, item), "Couldn't delete the task");
          }).open();
        });
      },
    });
  }

  private renderDeadlinesSection(
    container: HTMLElement,
    tasks: Task[],
  ): void {
    const { body } = this.createCollapsibleSection(container, "Approaching Deadlines", "tasks.deadlines", {
      sub: true,
      tooltip: "Tasks due within the next 7 days. Priority and deadline are inherited from parent tasks.",
    });
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No tasks due within 7 days" });
      return;
    }
    // Already in due order; the same list class as every other section, so the rows line
    // up with the day tasks' above them.
    this.taskList().addAll(tasks).render(body);
  }

  private renderPrioritySection(
    container: HTMLElement,
    tasks: Task[],
  ): void {
    const { body } = this.createCollapsibleSection(container, "Priority Queue", "tasks.priority", {
      sub: true,
      tooltip: "High-priority active tasks sorted by priority. Tasks already shown in Approaching Deadlines are excluded.",
    });
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No prioritized tasks" });
      return;
    }
    // Already in urgency order — sorting by date here would undo it.
    this.taskList().addAll(tasks).render(body);
  }
}
