import { Notice } from "obsidian";
import { moment, type Moment } from "../model/moment";
import { openNoteFile } from "./task-creator";
import type { Task, Project } from "../model/shared";
import { DayTask, resolveHabitsTag } from "../model/day-task";
import { DayMarkdownFile } from "../model/day-markdown-file";
import { DailyNotesConfig } from "../model/week-summary";
import { DONE_STATUSES } from "../model/task-vocabulary";
import { DAILY_ICON_SVG, NAV_PREV_SVG, NAV_NEXT_SVG, CALENDAR_SVG, TRASH_SVG, INBOX_SVG, PROMOTE_SVG, setSvgIcon } from "./icons";
import {
  buildParentIdSet,
  computeEffectiveValues, selectApproachingDeadlines, selectPriorityQueue,
  type EffectiveValues,
} from "../model/task-scoring";
import { loadDayChecklist, rescheduleChecklistItem, moveChecklistItemToInbox, deleteChecklistItem, toggleChecklistItem, isWithinPlanningWindow, reorderChecklistItem } from "../model/day-task-actions";
import { createDragReorder, type AddDragHandle } from "./drag-reorder";
import { BaseTabView } from "./base-tab-view";
import {
  renderTaskTitle, renderNoteChevron, appendEditTitleButton, appendNoteActionButton,
  attachActionsTapToggle, appendRescheduleButton, migrateNoteKey,
} from "./day-task-row";
import { ConfirmModal } from "./task-creator";
import { openDatePicker } from "./date-picker";

export const DASHBOARD_VIEW_TYPE = "pm-compass-dashboard";

// ── Dashboard (tasks tab) ─────────────────────────────────────────────────────

export interface AdjacentDayData {
  offset: number;
  date: Moment;
  unclosedItems: DayTask[];
  filePath: string | null;
}

export class DashboardView extends BaseTabView {
  dashboardDate: Moment = moment();
  /** Set on each render; read by the day-task rows' promote action, which sits
   *  several levels below `render` in the call chain. */
  private projects: Project[] = [];

  render(
    content: HTMLElement,
    checklistItems: DayTask[],
    dnPath: string | null,
    tasks: Task[],
    projects: Project[],
    adjacentData: AdjacentDayData[],
    resolvedInboxPath: string,
  ): void {
    this.projects = projects;

    // ── Date navigator ──────────────────────────────────────────────────────
    const dateNav = content.createDiv({ cls: "pm-dash-date-nav" });

    const isToday = this.dashboardDate.isSame(moment(), "day");

    const prevDayBtn = dateNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Previous day" } });
    setSvgIcon(prevDayBtn, NAV_PREV_SVG);
    prevDayBtn.addEventListener("click", () => { this.dashboardDate = moment(this.dashboardDate).subtract(1, "day"); this.onRefresh(); });

    const dateLabelText = dateNav.createSpan({
      cls: `pm-dash-date-text${dnPath ? " pm-dash-date-text--has-note" : " pm-dash-date-text--no-note"}`,
      text: this.dashboardDate.format("dddd, MMMM D"),
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
      todayBtn.addEventListener("click", () => { this.dashboardDate = moment(); this.onRefresh(); });
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
    nextDayBtn.addEventListener("click", () => { this.dashboardDate = moment(this.dashboardDate).add(1, "day"); this.onRefresh(); });

    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));

    const pastDays = adjacentData.filter((d) => d.offset < 0).sort((a, b) => b.offset - a.offset);
    const futureDays = adjacentData.filter((d) => d.offset > 0).sort((a, b) => a.offset - b.offset);

    const { body: dailyTasksBody } = this.createCollapsibleSection(content, "Daily Tasks", "tasks.dailyGroup");
    this.renderAdjacentUnclosedSection(dailyTasksBody, pastDays, "tasks.previousUnclosed", "Overdue tasks", resolvedInboxPath);
    this.renderChecklistSection(dailyTasksBody, checklistItems, dnPath, this.dashboardDate, resolvedInboxPath);
    this.renderAdjacentUnclosedSection(dailyTasksBody, futureDays, "tasks.upcomingUnclosed", "Upcoming tasks", resolvedInboxPath);

    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const effectiveValuesMap = computeEffectiveValues(activeTasks, taskById);
    const parentIds = buildParentIdSet(activeTasks);

    const approachingDeadlines = selectApproachingDeadlines(
      activeTasks, effectiveValuesMap, parentIds, moment().format("YYYY-MM-DD"),
    );

    const { body: projectTasksBody } = this.createCollapsibleSection(content, "Project Tasks", "tasks.projectGroup");
    this.renderDeadlinesSection(projectTasksBody, approachingDeadlines, projectMap, effectiveValuesMap);

    const deadlineIds = new Set(approachingDeadlines.map((t) => t.id));
    const priorityQueue = selectPriorityQueue(activeTasks, effectiveValuesMap, parentIds, deadlineIds);
    this.renderPrioritySection(projectTasksBody, priorityQueue, projectMap, effectiveValuesMap);
  }

  async loadAdjacentUnclosed(
    date: Moment,
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
      const day = moment(date).add(offset, "days");
      const { items, filePath } = await loadDayChecklist(this.app, day, config);
      const unclosedItems = items.filter((it) => !it.checked && !it.tags.includes(`#${habitsTag}`));
      return { offset, date: day, unclosedItems, filePath };
    }));
    return results.filter((d) => d.unclosedItems.length > 0);
  }

  private renderChecklistSection(
    container: HTMLElement,
    items: DayTask[],
    filePath: string | null,
    date: Moment,
    resolvedInboxPath: string,
  ): void {
    const isToday = date.isSame(moment(), "day");
    const dateLabel = isToday ? "Today" : date.format("MMM D");
    const { body } = this.createCollapsibleSection(container, `${dateLabel}'s Checklist`, "tasks.checklist", {
      sub: true,
      tooltip: "Checklist items from the daily note. Click an item to toggle it.",
    });

    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);

    if (items.length === 0) {
      body.createDiv({
        cls: "pm-dash-empty",
        text: `No checklist items in ${dateLabel.toLowerCase()}'s note`,
      });
      return;
    }

    const dailyItems = items.filter((it) => it.tags.includes(`#${habitsTag}`));
    const otherItems = items.filter((it) => !it.tags.includes(`#${habitsTag}`));

    const list = body.createEl("ul", { cls: "pm-dash-checklist" });
    // The section already shows the note's own order, so a drag can be persisted as-is —
    // except for habit rows, which `reconcileRecurringHabits` rewrites into their
    // definitions' order on every refresh and so can only be reordered from the settings.
    const addDragHandle = filePath && otherItems.length > 1
      ? createDragReorder<DayTask>(list, ({ item, next }) => this.runMutation(
          () => reorderChecklistItem(this.app, filePath, item, next),
          "Couldn't reorder the task",
        ))
      : undefined;
    for (const item of dailyItems) {
      this.renderDayTaskRow(list, item, filePath, habitsTag, resolvedInboxPath, { isDaily: true, rowDate: date, addDragHandle });
    }
    for (const item of otherItems) {
      this.renderDayTaskRow(list, item, filePath, habitsTag, resolvedInboxPath, { rowDate: date, addDragHandle });
    }
  }

  private renderAdjacentUnclosedSection(
    container: HTMLElement,
    days: AdjacentDayData[],
    key: string,
    title: string,
    resolvedInboxPath: string,
  ): void {
    if (days.length === 0) return;

    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);

    const { body } = this.createCollapsibleSection(container, title, key, {
      sub: true,
      tooltip: key.includes("previous")
        ? "Unclosed checklist items from the previous 7 days."
        : "Unclosed checklist items from the next 7 days.",
    });

    const list = body.createEl("ul", { cls: "pm-dash-checklist" });
    for (const day of days) {
      for (const item of day.unclosedItems) {
        this.renderDayTaskRow(list, item, day.filePath, habitsTag, resolvedInboxPath, {
          dateLabel: { text: day.date.format("ddd, MMM D"), onClick: () => openNoteFile(this.app, day.filePath!) },
          rowDate: day.date,
        });
      }
    }
  }

  /**
   * Renders a single checklist `<li>` shared by the "Today's Checklist" and
   * "Overdue/Upcoming tasks" sections: checkbox, title, optional note chevron, and
   * (when the item has a file to act on) the edit/note/reschedule/inbox/delete actions.
   * `isDaily` (habit-tagged) rows skip title editing and reschedule/inbox/delete —
   * those only make sense for a single day's own task, not a shared habit definition —
   * and get a small calendar icon instead; `dateLabel`, used by the adjacent-day
   * sections, appends a day label that opens that day's note. `addDragHandle`, passed
   * only by the section whose rows sit in one file in that file's own order, prepends
   * the reorder grip (inert on habit rows, which keep it purely for alignment).
   */
  private renderDayTaskRow(
    list: HTMLElement,
    item: DayTask,
    filePath: string | null,
    habitsTag: string,
    resolvedInboxPath: string,
    opts: {
      isDaily?: boolean;
      dateLabel?: { text: string; onClick: () => void };
      rowDate?: Moment;
      addDragHandle?: AddDragHandle<DayTask>;
    } = {},
  ): void {
    const { isDaily = false, dateLabel, rowDate, addDragHandle } = opts;

    const li = list.createEl("li", {
      cls: `pm-day-task-row pm-dash-checklist-item${item.checked ? " pm-dash-checklist-item--checked" : ""}`,
    });
    attachActionsTapToggle(li);

    const main = li.createDiv({ cls: "pm-day-task-row-main" });

    addDragHandle?.(main, li, item, !isDaily);

    const box = main.createSpan({ cls: "pm-dash-checkbox" });
    if (item.checked) box.addClass("pm-dash-checkbox--checked");

    const displayText = item.habitMatchTitle(habitsTag);
    const titleSpan = renderTaskTitle(main, displayText, this.app, this.plugin, "pm-dash-checklist-text");

    if (filePath) {
      renderNoteChevron(main, li, item, filePath, this.app, this.plugin, this.openNoteKeys, () => this.onRefresh());
    }

    if (isDaily) {
      const icon = main.createSpan({ cls: "pm-dash-checklist-daily-icon" });
      setSvgIcon(icon, DAILY_ICON_SVG);
    }

    if (dateLabel) {
      const label = main.createSpan({ cls: "pm-dash-checklist-date-label", text: dateLabel.text });
      if (filePath) {
        label.addClass("pm-dash-checklist-date-label--link");
        label.addEventListener("click", (e) => { e.stopPropagation(); dateLabel.onClick(); });
      }
    }

    if (filePath) {
      const actions = main.createDiv({ cls: "pm-day-task-actions" });
      if (!isDaily) {
        appendEditTitleButton(
          actions, main, titleSpan, item, filePath, this.app,
          "pm-dash-checklist-text", this.openNoteKeys, () => this.onRefresh(),
        );
      }
      appendNoteActionButton(actions, li, item, filePath, this.app, this.openNoteKeys, () => this.onRefresh());
      if (!isDaily && !item.checked) {
        appendRescheduleButton(actions, (targetDate) => {
          const check = isWithinPlanningWindow(targetDate, this.plugin.settings.smallTaskMaxWeeksAhead);
          if (!check.valid) {
            new Notice(check.reason!);
            return;
          }
          this.runMutation(
            () => rescheduleChecklistItem(this.app, filePath, item, targetDate, this.plugin.settings.dailyTasksHeading),
            "Couldn't reschedule the task",
          );
        }, undefined, rowDate);
        const promoteBtn = actions.createEl("button", {
          cls: "pm-day-task-action-btn",
          attr: { "aria-label": "Promote to project task", title: "Promote to a project task" },
        });
        setSvgIcon(promoteBtn, PROMOTE_SVG);
        promoteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openPromoteModal(item, filePath, this.projects, habitsTag);
        });
        const inboxBtn = actions.createEl("button", {
          cls: "pm-day-task-action-btn",
          attr: { "aria-label": "Move to inbox", title: "Move to inbox" },
        });
        setSvgIcon(inboxBtn, INBOX_SVG);
        inboxBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.runMutation(
            () => moveChecklistItemToInbox(this.app, filePath, item, resolvedInboxPath),
            "Couldn't move the task to the inbox",
          );
        });
        const deleteBtn = actions.createEl("button", {
          cls: "pm-day-task-action-btn pm-day-task-action-btn--delete",
          attr: { "aria-label": "Delete", title: "Delete task" },
        });
        setSvgIcon(deleteBtn, TRASH_SVG);
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
            this.runMutation(() => deleteChecklistItem(this.app, filePath, item), "Couldn't delete the task");
          }).open();
        });
      }
    }

    if (filePath) {
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggleChecklistItem(this.app, filePath, item).then((newRawLine) => {
          // Optimistic local toggle — avoids a full re-render on every click.
          migrateNoteKey(this.openNoteKeys, filePath, item.rawLine, newRawLine);
          item.checked = !item.checked;
          item.rawLine = newRawLine;
          li.toggleClass("pm-dash-checklist-item--checked", item.checked);
          box.toggleClass("pm-dash-checkbox--checked", item.checked);
        }).catch((e) => {
          // The optimistic patch never ran, so the checkbox still shows the old
          // state; a full refresh re-reads the file and resyncs it.
          console.error("pm-compass: couldn't update the task", e);
          new Notice("Couldn't update the task");
          this.onRefresh();
        });
      });
    }
  }

  private renderDeadlinesSection(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, EffectiveValues>,
  ): void {
    const { body } = this.createCollapsibleSection(container, "Approaching Deadlines", "tasks.deadlines", {
      sub: true,
      tooltip: "Tasks due within the next 7 days. Priority and deadline are inherited from parent tasks.",
    });
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No tasks due within 7 days" });
      return;
    }
    for (const task of tasks) {
      const eff = effectiveValuesMap.get(task.id);
      this.renderTaskRow(body, task, projectMap, eff?.priority, eff?.due);
    }
  }

  private renderPrioritySection(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, EffectiveValues>,
  ): void {
    const { body } = this.createCollapsibleSection(container, "Priority Queue", "tasks.priority", {
      sub: true,
      tooltip: "High-priority active tasks sorted by priority. Tasks already shown in Approaching Deadlines are excluded.",
    });
    if (tasks.length === 0) {
      body.createDiv({ cls: "pm-dash-empty", text: "No prioritized tasks" });
      return;
    }
    for (const task of tasks) {
      const eff = effectiveValuesMap.get(task.id);
      this.renderTaskRow(body, task, projectMap, eff?.priority, eff?.due);
    }
  }
}
