import { moment as _moment, setIcon } from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import type { Task, Project } from "../model/shared";
import { resolveHabitsTag } from "../model/day-task";
import { openNoteFile } from "./task-creator";
import { WeekSummary, DailyNotesConfig } from "../model/week-summary";
import { BaseTabView } from "./base-tab-view";
import { buildProgressCircle, buildTriColorCircle } from "./progress-circle";
import { computeEffectiveValues } from "../model/task-scoring";
import { DONE_STATUSES, STATUS_COLORS } from "../model/task-vocabulary";
import { NAV_PREV_SVG, NAV_NEXT_SVG, setSvgIcon } from "./icons";

export class WeekSummaryView extends BaseTabView {
  weekOffset = 0;

  async render(
    content: HTMLElement,
    tasks: Task[],
    projects: Project[],
    config: DailyNotesConfig,
  ): Promise<void> {
    const weekStart = moment().startOf("isoWeek").add(this.weekOffset, "weeks");
    const weekEnd = moment(weekStart).endOf("isoWeek");
    const weekNumber = weekStart.isoWeek();
    const isCurrentWeek = this.weekOffset === 0;

    // ── Week navigator ──────────────────────────────────────────────────────
    const weekNav = content.createDiv({ cls: "pm-dash-date-nav" });

    const prevWeekBtn = weekNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Previous week" } });
    setSvgIcon(prevWeekBtn, NAV_PREV_SVG);
    prevWeekBtn.addEventListener("click", () => { this.weekOffset--; this.onRefresh(); });

    const weekLabel = weekNav.createDiv({ cls: "pm-dash-week-label" });
    weekLabel.createSpan({ cls: "pm-dash-week-number", text: `Week ${weekNumber}` });
    weekLabel.createSpan({
      cls: "pm-dash-week-range",
      text: `${weekStart.format("MMM D")} – ${weekEnd.format("MMM D")}`,
    });

    if (!isCurrentWeek) {
      const thisWeekBtn = weekNav.createEl("button", { cls: "pm-dash-today-btn", text: "This week" });
      thisWeekBtn.addEventListener("click", () => { this.weekOffset = 0; this.onRefresh(); });
    }

    const nextWeekBtn = weekNav.createEl("button", { cls: "pm-dash-nav-btn", attr: { "aria-label": "Next week" } });
    setSvgIcon(nextWeekBtn, NAV_NEXT_SVG);
    nextWeekBtn.addEventListener("click", () => { this.weekOffset++; this.onRefresh(); });

    const isInWeek = (dateStr: string | undefined): boolean => {
      if (!dateStr) return false;
      const d = moment(dateStr.slice(0, 10), "YYYY-MM-DD");
      return d.isSameOrAfter(weekStart, "day") && d.isSameOrBefore(weekEnd, "day");
    };

    const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));
    const completedThisWeek = tasks.filter((t) => isInWeek(t.completed));
    const createdThisWeek = tasks.filter((t) => isInWeek(t.createdAt));
    const inProgressTasks = activeTasks.filter((t) => t.status === "in-progress");
    const blockedTasks = activeTasks.filter((t) => t.status === "blocked");
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const effectiveValuesMap = computeEffectiveValues(activeTasks, taskById);

    const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);

    const weekData = await WeekSummary.load(this.app, weekStart, config, habitsTag);

    // ── Daily Tasks (outer collapsible: habits + task circles) ──────────────
    const habitsTooltip = `Only checklist items tagged #${habitsTag} are tracked here. Configure in plugin settings.`;
    const { body: habitsBody } = this.createCollapsibleSection(content, "Daily Tasks", "stats.habits", { tooltip: habitsTooltip });

    // ── Grouped habits (collapsible sub-section inside Task Habits) ─────────
    const { body: groupedBody } = this.createCollapsibleSection(habitsBody, "Habits by task", "stats.habitsGrouped", {
      sub: true,
      tooltip: "Habit items grouped by name, showing how many days each was completed this week.",
    });

    if (weekData.habits.length > 0) {
      const itemsList = groupedBody.createDiv({ cls: "pm-dash-items-list" });
      for (const { key: text, completionCount: doneCount, presenceCount: presCount, checkedDays } of weekData.habits) {
        const displayText = text;
        const itemWrap = itemsList.createDiv({ cls: "pm-dash-item-wrap" });
        const row = itemWrap.createDiv({ cls: "pm-dash-item-row" });
        row.appendChild(buildProgressCircle({
          size: 28, r: 11, strokeWidth: 3, ratio: doneCount / presCount, svgClass: "pm-dash-item-circle",
        }));
        row.createSpan({ cls: `pm-dash-item-text${doneCount === 0 ? " pm-dash-item-text--never" : ""}`, text: displayText });
        row.createSpan({ cls: "pm-dash-item-count", text: `${doneCount}/${presCount}` });
        if (checkedDays.length > 0) {
          const chevron = row.createEl("button", { cls: "pm-dash-chevron pm-dash-item-chevron", attr: { "aria-label": "Show days" } });
          setIcon(chevron, "chevron-down");
          const daysDiv = itemWrap.createDiv({ cls: "pm-dash-item-days" });
          for (const dayIdx of checkedDays) {
            const chip = daysDiv.createEl("button", { cls: "pm-dash-item-day-chip", text: DAY_ABBR[dayIdx] });
            chip.addEventListener("click", (e) => {
              e.stopPropagation();
              openNoteFile(this.app, weekData.days[dayIdx].filePath);
            });
          }
          row.addEventListener("click", () => {
            itemWrap.toggleClass("pm-dash-item-wrap--open", !itemWrap.hasClass("pm-dash-item-wrap--open"));
          });
        }
      }
    } else {
      groupedBody.createDiv({ cls: "pm-dash-empty", text: `No #${habitsTag} checklist items found this week` });
    }

    // ── Daily Progress (collapsible sub-section inside Task Habits) ──────────
    const { body: dailyBody } = this.createCollapsibleSection(habitsBody, "Habits by day", "stats.dailyProgress", {
      sub: true,
      tooltip: "Daily completion ratio of habit checklist items. Click a circle to open that day's note.",
    });
    const circlesRow = dailyBody.createDiv({ cls: "pm-dash-circles-row" });
    for (let i = 0; i < 7; i++) {
      const { habitsDone: done, habitsTotal: total, hasNote, isFuture, filePath } = weekData.days[i];
      const wrap = circlesRow.createDiv({ cls: `pm-dash-day-circle${hasNote ? " pm-dash-day-circle--clickable" : ""}` });
      wrap.appendChild(buildProgressCircle({
        size: 56, r: 20, strokeWidth: 4,
        ratio: hasNote && total > 0 ? done / total : 0,
        svgClass: "pm-dash-circle-svg",
        trackDim: isFuture || !hasNote,
        emptyFill: hasNote && total === 0,
        label: !hasNote ? "—" : total === 0 ? "—" : `${done}/${total}`,
      }));
      wrap.createSpan({ cls: "pm-dash-circle-day", text: DAY_ABBR[i] });
      if (hasNote) {
        wrap.addEventListener("click", () => openNoteFile(this.app, filePath));
      }
    }

    // ── Tasks (7-day circles, tri-color: closed / late / open) — sub-section ──
    const { body: dailyTasksBody } = this.createCollapsibleSection(habitsBody, "Small tasks", "stats.dailyTasksCircles", {
      sub: true,
      tooltip: `One-off checklist items per day (excludes #${habitsTag} habit items). Green = done same day, orange = done late, grey = open.`,
    });
    const dailyTasksCirclesRow = dailyTasksBody.createDiv({ cls: "pm-dash-circles-row" });
    for (let i = 0; i < 7; i++) {
      const { taskCounts, hasNote, isFuture, filePath } = weekData.days[i];
      const { closedOnTime, closedLate, total } = taskCounts;
      const done = closedOnTime + closedLate;
      const wrap = dailyTasksCirclesRow.createDiv({
        cls: `pm-dash-day-circle${hasNote ? " pm-dash-day-circle--clickable" : ""}`,
      });
      wrap.appendChild(buildTriColorCircle({
        size: 56, r: 20, strokeWidth: 4,
        ratio1: total > 0 ? closedOnTime / total : 0,
        ratio2: total > 0 ? closedLate / total : 0,
        trackDim: isFuture || !hasNote,
        label: !hasNote ? "—" : total === 0 ? "—" : `${done}/${total}`,
      }));
      wrap.createSpan({ cls: "pm-dash-circle-day", text: DAY_ABBR[i] });
      if (hasNote) {
        wrap.addEventListener("click", () => openNoteFile(this.app, filePath));
      }
    }
    // Legend
    const dailyLegend = dailyTasksBody.createDiv({ cls: "pm-dash-daily-legend" });
    for (const { color, label } of [
      { color: "#22c55e", label: "Closed" },
      { color: "#f97316", label: "Late" },
      { color: "var(--background-modifier-border)", label: "Open" },
    ]) {
      const item = dailyLegend.createDiv({ cls: "pm-dash-daily-legend-item" });
      const dot = item.createSpan({ cls: "pm-dash-daily-legend-dot" });
      dot.style.setProperty("--pm-legend-dot-color", color);
      item.createSpan({ cls: "pm-dash-daily-legend-label", text: label });
    }

    // ── Project Tasks (outer collapsible) ───────────────────────────────────
    const { body: projectTasksBody } = this.createCollapsibleSection(content, "Project Tasks", "stats.projectTasks");

    // ── Stat rows (sub-section, expandable rows) ─────────────────────────────
    const { body: statsBody } = this.createCollapsibleSection(projectTasksBody, "Week Stats", "stats.weekStats", {
      sub: true,
      tooltip: "Task activity this week: completed, created, in-progress, and blocked. Click a row to expand the task list.",
    });
    const statDefs: [string, Task[], string][] = [
      ["Completed", completedThisWeek, STATUS_COLORS["done"]],
      ["Created", createdThisWeek, "#6366f1"],
      ["In Progress", inProgressTasks, STATUS_COLORS["in-progress"]],
      ["Blocked", blockedTasks, STATUS_COLORS["blocked"]],
    ];
    for (const [label, taskList, color] of statDefs) {
      const wrap = statsBody.createDiv({ cls: "pm-dash-stat-row" });
      const rowHeader = wrap.createDiv({ cls: "pm-dash-stat-row-header" });
      const num = rowHeader.createSpan({ cls: "pm-dash-stat-number", text: String(taskList.length) });
      num.style.setProperty("--pm-stat-number-color", color);
      rowHeader.createSpan({ cls: "pm-dash-stat-label", text: label });
      const chevron = rowHeader.createEl("button", { cls: "pm-dash-chevron", attr: { "aria-label": "Expand" } });
      setIcon(chevron, "chevron-down");
      const expandList = wrap.createDiv({ cls: "pm-dash-expand-list" });
      this.renderExpandList(expandList, taskList, projectMap, effectiveValuesMap);
      rowHeader.addEventListener("click", () => {
        wrap.toggleClass("pm-dash-stat-row--open", !wrap.hasClass("pm-dash-stat-row--open"));
      });
    }
  }
}
