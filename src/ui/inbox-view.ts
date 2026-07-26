import { Notice, setIcon } from "obsidian";
import { ConfirmModal, openDropdown } from "./task-creator";
import { DayTask, formatDate, resolveHabitsTag } from "../model/day-task";
import {
  removeInboxItem, closeInboxItem, scheduleInboxItem, appendInboxItem, isWithinPlanningWindow,
  setInboxItemPriority,
} from "../model/day-task-actions";
import { PRIORITIES, PRIORITY_COLORS, PRIORITY_LABELS } from "../model/task-vocabulary";
import { renderPriorityRibbon } from "./task-badges";
import type { Project } from "../model/shared";
import { BaseTabView } from "./base-tab-view";
import {
  renderTaskTitle,
  appendEditTitleButton,
  renderNoteChevron,
  appendNoteActionButton,
  appendRescheduleButton,
  attachActionsTapToggle,
} from "./day-task-row";
import { DAILY_ICON_SVG, PROMOTE_SVG, TRASH_SVG, setSvgIcon } from "./icons";

/** Items older than this show the "old" (red) age badge, regardless of the
 *  configurable `staleAfterDays` warning threshold — the two are independent:
 *  this is a fixed visual escalation, `staleAfterDays` is a user-tunable warning. */
const OLD_AGE_DAYS = 14;

export class InboxView extends BaseTabView {
  async render(
    container: HTMLElement,
    resolvedPath: string,
    items: DayTask[],
    staleAfterDays: number,
    projects: Project[] = [],
  ): Promise<void> {
    const habitsTag = resolveHabitsTag(this.plugin.settings.dailyHabitsTag);

    // ── Task list ─────────────────────────────────────────────────────────────
    if (items.length === 0) {
      container.createDiv({ cls: "pm-dash-empty", text: "Inbox is empty" });
    } else {
      this.renderSortBar(container);
      const list = container.createDiv({ cls: "pm-inbox-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: "pm-day-task-row pm-inbox-row" });
        attachActionsTapToggle(row);

        const main = row.createDiv({ cls: "pm-day-task-row-main" });

        this.renderPriorityControl(main, item, resolvedPath, habitsTag);

        const cb = main.createEl("input", {
          type: "checkbox",
          cls: "pm-inbox-cb",
          attr: { "aria-label": "Close task" },
        });
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          this.runMutation(() => closeInboxItem(this.app, resolvedPath, item), "Couldn't close the task");
        });

        const isDailyItem = item.tags.includes(`#${habitsTag}`);
        const titleSpan = renderTaskTitle(main, item.habitMatchTitle(habitsTag), this.app, this.plugin, "pm-inbox-title");

        if (isDailyItem) {
          const icon = main.createSpan({ cls: "pm-inbox-daily-icon" });
          setSvgIcon(icon, DAILY_ICON_SVG);
        }

        renderNoteChevron(main, row, item, resolvedPath, this.app, this.plugin, this.openNoteKeys, () => this.onRefresh());

        if (item.createdAt) {
          const daysOld = Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000);
          const isStale = staleAfterDays > 0 && daysOld >= staleAfterDays;
          if (isStale) {
            const warn = main.createSpan({ cls: "pm-inbox-stale-warn", text: "⚠️" });
            warn.title = `In inbox for ${daysOld} days (threshold: ${staleAfterDays})`;
          }
          const badge = main.createSpan({
            cls: `pm-inbox-age${daysOld > OLD_AGE_DAYS ? " pm-inbox-age--old" : ""}`,
            text: `${daysOld} d`,
          });
          badge.title = `Created on ${formatDate(item.createdAt)}`;
        }

        const actions = main.createDiv({ cls: "pm-day-task-actions pm-inbox-actions" });

        if (!isDailyItem) {
          appendEditTitleButton(
            actions, main, titleSpan, item, resolvedPath, this.app,
            "pm-inbox-title", this.openNoteKeys, () => this.onRefresh(),
          );
        }
        // Habits are regenerated from their definition, so promoting one out of
        // the inbox into a project would only strand it.
        if (!isDailyItem) {
          const promoteBtn = actions.createEl("button", {
            cls: "pm-day-task-action-btn",
            attr: { "aria-label": "Promote to project task" },
          });
          promoteBtn.title = "Promote to a project task";
          setSvgIcon(promoteBtn, PROMOTE_SVG);
          promoteBtn.addEventListener("click", () => this.openPromoteModal(item, resolvedPath, projects, habitsTag));
        }

        appendNoteActionButton(actions, row, item, resolvedPath, this.app, this.openNoteKeys, () => this.onRefresh());

        appendRescheduleButton(
          actions,
          (date) => {
            if (!isDailyItem) {
              const check = isWithinPlanningWindow(date, this.plugin.settings.smallTaskMaxWeeksAhead);
              if (!check.valid) {
                new Notice(check.reason!);
                return;
              }
            }
            this.runMutation(
              () => scheduleInboxItem(this.app, resolvedPath, item, date, this.plugin.settings.dailyTasksHeading),
              "Couldn't schedule the task",
            );
          },
          { ariaLabel: "Schedule", title: "Schedule for a day" },
        );

        const deleteBtn = actions.createEl("button", {
          cls: "pm-day-task-action-btn pm-day-task-action-btn--delete",
          attr: { "aria-label": "Delete" },
        });
        setSvgIcon(deleteBtn, TRASH_SVG);
        deleteBtn.addEventListener("click", () => {
          new ConfirmModal(this.app, `Delete "${item.title}"?`, () => {
            this.runMutation(() => removeInboxItem(this.app, resolvedPath, item), "Couldn't delete the task");
          }).open();
        });
      }
    }

    // ── Add-task bar (sticky at bottom, above keyboard on mobile) ────────────
    const addBar = container.createDiv({ cls: "pm-inbox-add-bar" });
    const addInput = addBar.createEl("input", {
      type: "text",
      cls: "pm-inbox-add-input",
      attr: { placeholder: "➕ Add a task…" },
    });
    addInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const title = addInput.value.trim();
        if (!title) return;
        addInput.value = "";
        addInput.disabled = true;
        void appendInboxItem(this.app, resolvedPath, title)
          .then(() => this.onRefresh())
          .catch((e) => {
            console.error("pm-compass: couldn't add the task", e);
            new Notice("Couldn't add the task");
          })
          .finally(() => { addInput.disabled = false; });
      }
    });
  }

  /**
   * The list's ordering control: a single button toggling between the two modes
   * `sortInboxItems` supports, rather than a dropdown — with only "newest first" and
   * "priority first" to choose from, a toggle costs one tap instead of two. The choice
   * is persisted (`settings.inboxSortBy`) and applied by `readInboxItems` on the next
   * read, so the refresh below is what actually re-orders the list.
   */
  private renderSortBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "pm-inbox-sort-bar" });
    const sortBy = this.plugin.settings.inboxSortBy ?? "created";
    const btn = bar.createEl("button", {
      cls: "pm-inbox-sort-btn",
      attr: { "aria-label": "Change sort order", title: "Change sort order" },
    });
    setIcon(btn, "arrow-up-down");
    btn.createSpan({ text: sortBy === "priority" ? "Priority" : "Newest" });
    btn.addEventListener("click", () => {
      this.plugin.settings.inboxSortBy = sortBy === "priority" ? "created" : "priority";
      this.runMutation(() => this.plugin.saveSettings(), "Couldn't change the sort order");
    });
  }

  /**
   * The coloured priority ribbon at the row's leading edge — the same badge (and the
   * same dropdown wiring) project-task rows use in `BaseTabView.renderTaskRow`, writing
   * the Obsidian Tasks priority marker back into the checklist line instead of a
   * frontmatter field.
   *
   * Habit lines get an inert ribbon: they're regenerated from their definition on every
   * reconcile, so a priority set here would silently disappear on the next refresh.
   */
  private renderPriorityControl(
    main: HTMLElement,
    item: DayTask,
    resolvedPath: string,
    habitsTag: string,
  ): void {
    const ribbon = renderPriorityRibbon(main, "pm-inbox-ribbon", item.priority ?? undefined);
    if (item.tags.includes(`#${habitsTag}`)) return;

    ribbon.addClass("pm-inbox-ribbon--editable");
    ribbon.addEventListener("click", (e) => {
      e.stopPropagation();
      openDropdown(
        ribbon,
        PRIORITIES.map((p) => ({
          label: PRIORITY_LABELS[p],
          color: PRIORITY_COLORS[p] ?? "#6b7280",
          onSelect: () => {
            this.runMutation(
              () => setInboxItemPriority(this.app, resolvedPath, item, p),
              "Couldn't update the priority",
            );
          },
        })),
      );
    });
  }
}
