import { App, Component, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import {
  BaseTask, isDoneStatus, joinStatuses, statusLabel, toStatus,
  PRIORITIES, PRIORITY_COLORS, PRIORITY_LABELS, Priority,
  STATUS_COLORS, STATUS_LABELS, Status, type RollupLookup,
} from "../model/base-task";
import {
  buildChildMap, effectiveStatus,
  isCompletedWithOpenSubtasks, isOpenUnderCompletedParent,
} from "../model/project/task-tree";
import { type Project } from "../model/project/project";
import { type Task } from "../model/project/task";
import { daysLabel } from "../model/date-format";
import { type EffectiveValues } from "../model/project/task-scoring";
import { PatchableField } from "../model/project/project-task-file";
import {
  renderPriorityRibbon, renderStatusIcon, renderSubtaskWarning, renderParentDoneWarning,
  createBadgeBand, renderMetaBadge, renderDaysBadge,
} from "./task-badges";
import { Icon } from "./icons";
import { openTaskContextMenu } from "./task-context-menu";
import {
  renderTaskTitle, appendRescheduleButton, attachActionsTapToggle,
  renderNoteChevron,
} from "./day-task-row";
import { formatDate, sameDay, timestampDay } from "../model/dates";
import type { DatePickerOptions } from "./date-picker";
import {
  TaskModal, TaskModalMode, patchTaskField, patchTaskDue,
  deleteTaskFile, openDropdown, openNoteFile,
} from "./task-creator";
import { MoveTargetModal } from "./move-target-modal";
import { promoteChecklistItem } from "../model/operations/checklist-promote";
import { setChecklistItemPriority } from "../model/daily/day-task-actions";
import type { DayTask } from "../model/daily/day-task";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";

/** Base class for the Dashboard/Inbox/Week Summary tabs: collapsible sections, a shared
 *  project-task row renderer, and the task-graph handoff a row click makes. */
export abstract class BaseTabView {
  allTasks: Task[] = [];

  /** Keys (see `renderNoteChevron`) of tasks whose note panel is expanded. Survives
   *  `render()`, which rebuilds the DOM, so saving a note doesn't collapse it. */
  protected readonly openNoteKeys = new Set<string>();

  /** Owns the lifecycle of the markdown rendered into this tab's rows. Retired and
   *  replaced per pass by `startRenderPass`: every refresh rebuilds every row, and a
   *  longer-lived owner would hold each pass's renderers — and their detached DOM — for
   *  as long as it lived. */
  private renderHost = new Component();

  /** Cached `buildChildMap(this.allTasks)`, rebuilt when `allTasks` is replaced. */
  private childMapCache?: { tasks: Task[]; map: Map<string | undefined, Task[]> };
  /** Cached id→task map for the current `allTasks`, rebuilt when it is replaced. */
  private taskByIdCache?: { tasks: Task[]; map: Map<string, Task> };

  /** The child map for the current `allTasks`, built once per task-list identity. */
  protected childMap(): Map<string | undefined, Task[]> {
    if (this.childMapCache?.tasks !== this.allTasks) {
      this.childMapCache = { tasks: this.allTasks, map: buildChildMap(this.allTasks) };
    }
    return this.childMapCache.map;
  }

  /** The id→task map for the current `allTasks`, built once per task-list identity. */
  protected taskById(): Map<string, Task> {
    if (this.taskByIdCache?.tasks !== this.allTasks) {
      this.taskByIdCache = { tasks: this.allTasks, map: new Map(this.allTasks.map((t) => [t.id, t])) };
    }
    return this.taskByIdCache.map;
  }

  constructor(
    protected readonly app: App,
    protected readonly plugin: PMCompassPlugin,
    protected readonly onRefresh: () => void,
    /** Takes the Dashboard to a day, where every date on a row leads. Defaulted so a
     *  view can be built without one. */
    protected readonly showDay: (date: Date) => void = () => {},
  ) {}

  /** Retires the previous pass's markdown along with the rows it was rendered into. Call
   *  from the top of `render`, before anything is drawn. */
  protected startRenderPass(): void {
    this.renderHost.unload();
    this.renderHost = new Component();
    this.renderHost.load();
  }

  /** Releases what the last pass rendered, no render following to do it. */
  dispose(): void {
    this.renderHost.unload();
  }

  /** Runs a mutating action, refreshes on success, and surfaces a failure as a Notice
   *  rather than leaving the row silently stale. */
  protected runMutation(action: () => Promise<unknown>, failureMessage: string): void {
    void action()
      .then(() => this.onRefresh())
      .catch((e) => {
        console.error(`pm-compass: ${failureMessage}`, e);
        new Notice(failureMessage);
      });
  }

  protected createCollapsibleSection(
    container: HTMLElement,
    title: string,
    key: string,
    options?: { tooltip?: string; sub?: boolean },
  ): { section: HTMLElement; body: HTMLElement } {
    const isCollapsed = this.plugin.settings.dashboardCollapsed[key] ?? false;
    const section = container.createDiv({
      cls: `pm-dash-section${options?.sub ? " pm-dash-section--sub" : ""}`,
    });

    const header = section.createDiv({ cls: "pm-dash-section-header pm-dash-section-header--collapsible" });
    const chevron = header.createSpan({
      cls: `pm-dash-section-chevron${isCollapsed ? " pm-dash-section-chevron--collapsed" : ""}`,
    });
    setIcon(chevron, Icon.SectionToggle);
    header.createSpan({ cls: "pm-dash-section-title", text: title });

    if (options?.tooltip) {
      const info = header.createSpan({ cls: "pm-dash-section-info" });
      setIcon(info, Icon.SectionInfo);
      info.createDiv({ cls: "pm-dash-section-tooltip", text: options.tooltip });
      info.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = info.classList.toggle("pm-dash-section-info--open");
        if (isOpen) {
          const close = (ev: MouseEvent) => {
            if (!info.contains(ev.target as Node)) {
              info.classList.remove("pm-dash-section-info--open");
              activeDocument.removeEventListener("click", close, true);
            }
          };
          activeDocument.addEventListener("click", close, true);
        }
      });
    }

    const body = section.createDiv({ cls: "pm-dash-section-body" });
    if (isCollapsed) body.setCssStyles({ display: "none" });

    header.addEventListener("click", () => {
      const nowCollapsed = !(this.plugin.settings.dashboardCollapsed[key] ?? false);
      this.plugin.settings.dashboardCollapsed[key] = nowCollapsed;
      void this.plugin.saveSettings();
      chevron.toggleClass("pm-dash-section-chevron--collapsed", nowCollapsed);
      body.style.display = nowCollapsed ? "none" : "";
    });

    return { section, body };
  }

  /** Makes a priority ribbon a dropdown trigger — same picker either kind of row, only
   *  `apply` differs: a checklist marker one side, a frontmatter field the other. */
  private attachPriorityDropdown(
    ribbon: HTMLElement,
    current: Priority | undefined,
    apply: (priority: Priority) => Promise<unknown>,
  ): void {
    ribbon.addClass("pm-task-ribbon--editable");
    ribbon.addEventListener("click", (e) => {
      e.stopPropagation();
      openDropdown(
        ribbon,
        PRIORITIES.map((p) => ({
          label: PRIORITY_LABELS[p],
          color: PRIORITY_COLORS[p] ?? "#6b7280",
          selected: p === (current || Priority.None),
          onSelect: () => this.runMutation(() => apply(p), "Couldn't update the priority"),
        })),
      );
    });
  }

  /** A project task as a row of a task list; both tabs draw their non-day rows here. */
  protected renderProjectTaskRow(
    list: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    effectiveValues: Map<string, EffectiveValues>,
    showCreated = false,
  ): void {
    this.renderTaskRow(list, task, projectMap, effectiveValues.get(task.id), false, showCreated);
  }

  /** The two slots a checklist line fills the same way in both tabs: where its ribbon
   *  writes, and its note panel. Undefined where there is nothing to write to. */
  protected checklistSlots(item: DayTask, filePath: string | null, habitsTag: string): {
    setPriority?: (priority: Priority) => Promise<unknown>;
    notePanel?: (main: HTMLElement, li: HTMLElement) => void;
  } {
    if (!filePath) return {};
    return {
      setPriority: item.hasTag(habitsTag)
        ? undefined
        : (p) => setChecklistItemPriority(this.app, filePath, item, p),
      notePanel: (main, li) => renderNoteChevron(
        main, li, item, filePath, this.app, this.renderHost, this.openNoteKeys, () => this.onRefresh(),
      ),
    };
  }

  /** The binary control. A span rather than an input, so it sits on the row's grid;
   *  announced as a checkbox only when `onToggle` gives it somewhere to write. */
  private renderRowCheckbox(
    main: HTMLElement,
    li: HTMLElement,
    item: BaseTask,
    opts: { toggleLabel: string; onToggle?: (box: HTMLElement, li: HTMLElement) => void },
  ): void {
    const box = main.createSpan({
      cls: `pm-dash-checkbox${item.isClosed ? " pm-dash-checkbox--checked" : ""}`,
      attr: opts.onToggle
        ? {
            role: "checkbox",
            "aria-label": opts.toggleLabel,
            "aria-checked": String(item.isClosed),
            tabindex: "0",
          }
        : { "aria-hidden": "true" },
    });
    if (!opts.onToggle) return;
    const toggle = (e: Event) => {
      // The row toggles its action bar on a tap; the box is not part of that.
      e.stopPropagation();
      e.preventDefault();
      opts.onToggle!(box, li);
    };
    box.addEventListener("click", toggle);
    // What a real checkbox answers to.
    box.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") toggle(e);
    });
  }

  /** The control for a scale of more than two rungs: the status icon, opening a picker
   *  of that scale. Inert without `setStatus`. */
  private renderRowStatusPicker(
    main: HTMLElement,
    item: BaseTask,
    opts: { statusInForce?: string; setStatus?: (status: Status) => void },
  ): void {
    // A task under a cancelled ancestor reads cancelled, which only the view can work out.
    const inForce = opts.statusInForce ?? item.statusValue;
    const icon = renderStatusIcon(main, "pm-dash-task-status-icon", inForce, {
      title: `Status: ${joinStatuses(statusLabel(item.statusValue), statusLabel(inForce))}`,
      interactive: !!opts.setStatus,
    });
    if (!opts.setStatus) return;
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      openDropdown(icon, item.statusScale.map((s) => ({
        label: STATUS_LABELS[s],
        color: STATUS_COLORS[s],
        selected: s === toStatus(item.statusValue),
        onSelect: () => opts.setStatus!(s),
      })));
    });
  }

  /**
   * Every row in the plugin: the `<li>` and the middle of its line — leading slot,
   * priority ribbon, status control, title. What differs goes in the slots it leaves
   * open, and the control it draws is the task's own answer (see `statusScale`).
   */
  protected renderRowShell(
    list: HTMLElement,
    item: BaseTask,
    opts: {
      /** The row's own class; `--checked` is appended unless `markClosed` says not to. */
      cls: string;
      /** The `<li>`'s class and the inner line's — the two kinds sit on different grids. */
      rowCls?: string;
      mainCls?: string;
      /** Whether a closed row says so with `--checked`. A project task says it with the
       *  closed date it carries in place of a deadline. */
      markClosed?: boolean;
      /** Whether the inner line is the row proper, the `<li>` being only a list slot. */
      lineIsRow?: boolean;
      /** Where the title and everything after it goes; default is the line itself. */
      titleHost?: (main: HTMLElement) => HTMLElement;
      /** The leading slot, for a row that names its own. Default is the checklist's:
       *  the habit mark, else the grip, else the day, else the inbox. */
      lead?: (main: HTMLElement) => void;
      /** What clicking the row itself does, where it does anything. */
      onRowClick?: () => void;
      titleCls: string;
      habitsTag: string;
      /** The file this row is written to; the Inbox passes its list's own path. */
      filePath?: string | null;
      /** The grip, with the row's item already bound — only a checklist line has an
       *  order to persist, so the caller closes over it. */
      addDragHandle: (parent: HTMLElement, row: HTMLElement, draggable?: boolean) => void;
      /** True only for a row this list can reorder; the others put their day in the slot. */
      movable: boolean;
      toggleLabel: string;
      /** What ticking the box does. Absent, the box is inert. */
      onToggle?: (box: HTMLElement, li: HTMLElement) => void;
      /** The status an ancestor forces, which only the view can work out. Defaults to
       *  the task's own. */
      statusInForce?: string;
      /** What picking a status does, for a scale of more than two rungs. */
      setStatus?: (status: Status) => void;
      /** The roll-up behind the ribbon's two ends. Absent for a checklist line. */
      rollup?: RollupLookup;
      /** Where the ribbon writes a new level. Absent, the ribbon is a picture. */
      setPriority?: (priority: Priority) => Promise<unknown>;
      /** The expandable note under the row. Only a task whose body is a handful of
       *  indented lines has one. */
      notePanel?: (main: HTMLElement, li: HTMLElement) => void;
      badges?: (main: HTMLElement) => void;
      /** The row's trailing controls, given the line to build them on. */
      actions?: (main: HTMLElement, li: HTMLElement, titleSpan: HTMLElement) => void;
    },
  ): void {
    const isHabit = item.hasTag(opts.habitsTag);
    const filePath = opts.filePath ?? item.filePath;

    const li = list.createEl("li", {
      cls: [
        opts.rowCls ?? "pm-day-task-row",
        opts.cls,
        item.isClosed && opts.markClosed !== false ? `${opts.cls}--checked` : "",
      ].filter(Boolean).join(" "),
    });
    const main = li.createDiv({ cls: opts.mainCls ?? "pm-day-task-row-main" });
    // The row proper: the `<li>` for a checklist line, the line inside it for a project task.
    const rowEl = opts.lineIsRow ? main : li;
    attachActionsTapToggle(rowEl);
    if (opts.onRowClick) rowEl.addEventListener("click", () => opts.onRowClick!());

    // The leading slot, always the same width so the lists line up: the recurring mark,
    // else the grip, else the day the line falls under, else the inbox.
    const day = item.plannedDate;
    if (opts.lead) {
      opts.lead(main);
    } else if (isHabit) {
      const icon = main.createSpan({
        cls: "pm-day-task-lead pm-dash-checklist-daily-icon",
        attr: { "aria-label": "Recurring habit", title: "Recurring habit — reordered from the settings" },
      });
      setIcon(icon, Icon.RecurringHabit);
    } else if (opts.movable) {
      opts.addDragHandle(main, li, true);
    } else if (day) {
      const icon = main.createSpan({
        cls: "pm-day-task-lead pm-day-task-note-icon",
        attr: { "aria-label": "Show that day", title: `${formatDate(day)} — show that day on the dashboard` },
      });
      setIcon(icon, Icon.TaskDay);
      icon.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showDay(day);
      });
    } else {
      const icon = main.createSpan({
        cls: "pm-day-task-lead pm-day-task-inbox-icon",
        attr: { "aria-label": "In the inbox", title: "In the inbox — no day yet" },
      });
      setIcon(icon, Icon.InInbox);
    }
    // All three levels every time: with no roll-up the two ends are the task's own.
    const ribbon = renderPriorityRibbon(
      main,
      item.ownPriority ?? undefined,
      item.priorityFromAbove(opts.rollup) ?? undefined,
      item.priorityFromBelow(opts.rollup) ?? undefined,
    );
    if (opts.setPriority) {
      // A `Lowest` line has no rung in the picker, so nothing is marked.
      this.attachPriorityDropdown(ribbon, item.ownPriority ?? undefined, opts.setPriority);
    }

    // The task's own scale picks the control: two rungs a checkbox, more the picker.
    if (item.statusScale.length > 2) {
      this.renderRowStatusPicker(main, item, opts);
    } else {
      this.renderRowCheckbox(main, li, item, opts);
    }

    const titleHost = opts.titleHost?.(main) ?? main;
    const titleSpan = renderTaskTitle(
      titleHost, item.rowTitle(opts.habitsTag), this.app, this.renderHost, opts.titleCls,
    );

    opts.notePanel?.(main, li);

    opts.badges?.(titleHost);

    if (filePath && opts.actions) {
      opts.actions(main, li, titleSpan);
    }
  }

  /** The add-task bar a list tab ends with: sticky at the bottom, above the mobile
   *  keyboard. Only the file the line lands in differs, which is what `add` decides. */
  protected renderAddBar(
    container: HTMLElement,
    placeholder: string,
    add: (title: string) => Promise<unknown>,
  ): { bar: HTMLElement; input: HTMLInputElement } {
    const addBar = container.createDiv({ cls: "pm-add-bar" });
    const addInput = addBar.createEl("input", {
      type: "text",
      cls: "pm-add-input",
      attr: { placeholder },
    });
    addInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const title = addInput.value.trim();
      if (!title) return;
      addInput.value = "";
      addInput.disabled = true;
      void add(title)
        .then(() => this.onRefresh())
        .catch((err) => {
          console.error("pm-compass: couldn't add the task", err);
          new Notice("Couldn't add the task");
        })
        .finally(() => { addInput.disabled = false; });
    });
    return { bar: addBar, input: addInput };
  }

  /** The day the tab's date badges count from. Today, except on the dashboard. */
  protected referenceDate(): Date {
    return new Date();
  }

  /** The one way a date reads on any row: `daysLabel`'s label, or the overdue chip. */
  protected renderDateBadge(
    container: HTMLElement,
    date: Date,
    opts: {
      title: string;
      /** How many days past the date the warning glyph appears; `0` never warns. */
      warnAfterDays?: number;
      /** The count without the alarm — see `renderDaysBadge`. */
      quiet?: boolean;
      /** Replaces `title` once that glyph is showing. */
      warnTitle?: string;
      /** Counts from the real today rather than `referenceDate` — for an age, which is
       *  elapsed time and can't be read against a day merely being looked at. */
      fromToday?: boolean;
      onClick?: (badge: HTMLElement) => void;
    },
  ): void {
    const { text, overdue, daysOverdue } = daysLabel(date, opts.fromToday ? new Date() : this.referenceDate());
    if (overdue) {
      // The default goes after the spread, or an explicit `undefined` would undo it.
      renderDaysBadge(container, daysOverdue, { ...opts, warnAfterDays: opts.warnAfterDays ?? 1 });
    } else {
      renderMetaBadge(container, { text, ...opts });
    }
  }

  /** A project task's row, drawn by the same shell as a checklist line's and differing
   *  only in the slots it fills. `eff` is its `computeEffectiveValues` entry. */
  protected renderTaskRow(
    list: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    eff?: EffectiveValues,
    readonly = false,
    /** Whether the row carries its creation date. Only the Inbox does, where age is what
     *  a task is triaged on. */
    showCreated = false,
  ): void {
    const project = projectMap.get(task.projectId);
    const displayDue = eff?.due ?? task.due;
    // A deadline the task doesn't own: shown, named on hover, but not editable from here.
    const inheritedDue = !!eff?.due && (!task.due || !sameDay(eff.due, task.due));
    // Under a cancelled parent the tooltip spells out both: "In Progress / Cancelled".
    const statusInForce = effectiveStatus(task, this.taskById());
    // One row, one roll-up, so the id is not consulted.
    const rollup: RollupLookup = () => eff;

    this.renderRowShell(list, task, {
      cls: "pm-dash-task-item",
      // The `<li>` is only a list slot; the row proper is the line inside it.
      rowCls: "",
      lineIsRow: true,
      // Marked by the date it closed on, not by a dimmed row.
      markClosed: false,
      mainCls: `pm-dash-task-row${readonly ? " pm-dash-task-row--readonly" : ""}`,
      titleCls: "pm-dash-task-title",
      // No habit tag to strip from the title.
      habitsTag: "",
      // A body nests between the row and its first line.
      titleHost: (main) => main.createDiv({ cls: "pm-dash-task-body" })
        .createDiv({ cls: "pm-dash-task-line" }),
      rollup,
      statusInForce,
      setStatus: readonly ? undefined : (status) => {
        this.runMutation(
          () => patchTaskField(this.app, task.filePath, PatchableField.Status, status),
          "Couldn't update the status",
        );
      },
      setPriority: readonly ? undefined
        : (p) => patchTaskField(this.app, task.filePath, PatchableField.Priority, p),
      // No toolbar to reveal on a read-only echo, so the click opens the graph.
      onRowClick: readonly ? () => void this.openInGraph(task) : undefined,
      // The grip is a checklist-only affair.
      addDragHandle: () => {},
      movable: false,
      toggleLabel: "",

      // The project in its own colour — what names it once the row is too narrow for
      // the name itself.
      lead: (main) => {
        main.dataset.taskId = task.id;
        if (!project) return;
        const lead = main.createSpan({
          cls: "pm-day-task-lead pm-dash-task-project-icon",
          attr: { title: `${project.title} — open in the task graph`, "aria-label": project.title },
        });
        if (project.color) lead.style.setProperty("--pm-project-color", project.color);
        setIcon(lead, Icon.Project);
        lead.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.openInGraph(task);
        });
      },

      badges: (line1) => {
        // A parent/subtask completion mismatch, right after the title it is about.
        if (isCompletedWithOpenSubtasks(task, this.childMap(), this.taskById())) {
          renderSubtaskWarning(line1, "pm-dash-task-warn");
        }
        if (isOpenUnderCompletedParent(task, this.taskById())) {
          renderParentDoneWarning(line1, "pm-dash-task-warn");
        }
        // Before the dates, so the date badge stays the row's last column as on a day
        // task's row and the two kinds line up in a merged list.
        if (project) {
          // Dropped on a narrow view, where the leading icon carries the project alone.
          const badge = line1.createSpan({
            cls: "pm-dash-task-project",
            text: project.title,
            attr: { title: `${project.title} — open in the task graph` },
          });
          if (project.color) badge.style.setProperty("--pm-project-color", project.color);
          badge.addEventListener("click", (e) => {
            e.stopPropagation();
            void this.openInGraph(task);
          });
        }
        // The dates the row ends with: when it was written, where the tab asks for that,
        // then when it is due. Either opens its day; a deadline is changed from the toolbar.
        const created = showCreated && task.createdAt ? timestampDay(task.createdAt) : undefined;
        // Closed work is dated by the day it closed, in place of a deadline whose overdue
        // alarm would warn about nothing.
        const completedDay = isDoneStatus(statusInForce) && task.closedOn
          ? timestampDay(task.closedOn)
          : undefined;
        const dateBand = created || completedDay || displayDue ? createBadgeBand(line1) : line1;

        if (created) {
          // An age is how long the task has been on the books, not a warning, and counts
          // from today rather than the day the dashboard is showing.
          this.renderDateBadge(dateBand, created, {
            quiet: true,
            fromToday: true,
            title: `Created on ${formatDate(created)} — show that day`,
            onClick: readonly ? undefined : () => this.showDay(created),
          });
        }

        if (completedDay) {
          // A cancelled task keeps the timestamp it had, so the day it names is the day
          // it closed — all the badge claims for one.
          const closedWord = toStatus(statusInForce) === Status.Done ? "Completed" : "Closed";
          this.renderDateBadge(dateBand, completedDay, {
            quiet: true,
            title: `${closedWord} on ${formatDate(completedDay)} — show that day`,
            onClick: readonly ? undefined : () => this.showDay(completedDay),
          });
        } else if (displayDue) {
          this.renderDateBadge(dateBand, displayDue, {
            // A relative label doesn't name the date itself.
            title: inheritedDue
              ? `Effective deadline: ${formatDate(displayDue)} (own: ${task.due ? formatDate(task.due) : "none"}) — show that day`
              : `Deadline: ${formatDate(displayDue)} — show that day`,
            onClick: readonly ? undefined : () => this.showDay(displayDue),
          });
        }
      },

      actions: readonly ? undefined : (row) => {
        this.renderTaskActions(row, task, projectMap);
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.openTaskContextMenu(e, task, projectMap);
        });
      },
    });
  }

  /** A project task's deadline edit for the toolbar button: seeded with its `due`,
   *  writing the pick or the clear back. */
  private deadlineEdit(task: Task): DatePickerOptions {
    return {
      initial: task.due,
      onPick: (date) => this.runMutation(
        () => patchTaskDue(this.app, task.filePath, date),
        "Couldn't update the deadline",
      ),
      onClear: task.due
        ? () => this.runMutation(
          () => patchTaskDue(this.app, task.filePath, null),
          "Couldn't clear the deadline",
        )
        : undefined,
    };
  }

  /**
   * The floating toolbar a project-task row reveals when tapped: open the full editor,
   * move the deadline, drop it to send the task back to the Inbox, jump to the graph.
   * The structural actions stay behind "More", which opens the right-click menu — so
   * they are reachable on a phone without growing the toolbar.
   */
  private renderTaskActions(
    row: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
  ): void {
    const actions = row.createDiv({ cls: "pm-task-actions" });

    const detailsBtn = actions.createEl("button", {
      cls: "pm-task-action-btn",
      attr: { "aria-label": "Edit task details", title: "Edit task details (ctrl-click to open the note)" },
    });
    setIcon(detailsBtn, Icon.TaskDetails);
    detailsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        openNoteFile(this.app, task.filePath);
        return;
      }
      new TaskModal(this.app, {
        mode: TaskModalMode.Edit,
        task,
        existingTasks: this.allTasks.filter((t) => t.projectId === task.projectId),
        onSuccess: () => this.onRefresh(),
      }).open();
    });

    const { initial, onPick, onClear } = this.deadlineEdit(task);
    appendRescheduleButton(
      actions,
      onPick,
      { ariaLabel: "Set deadline", title: "Set the deadline" },
      initial,
      onClear,
    );

    // Only on a task holding a deadline of its own: that is what puts the row on a
    // dashboard horizon, and dropping it hands the task back to the Inbox.
    if (task.due) {
      const inboxBtn = actions.createEl("button", {
        cls: "pm-task-action-btn",
        attr: { "aria-label": "Move to inbox", title: "Move to inbox — clears the deadline" },
      });
      setIcon(inboxBtn, Icon.MoveToInbox);
      inboxBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.runMutation(
          () => patchTaskDue(this.app, task.filePath, null),
          "Couldn't move the task to the inbox",
        );
      });
    }

    const graphBtn = actions.createEl("button", {
      cls: "pm-task-action-btn",
      attr: { "aria-label": "Open in graph", title: "Open in the task graph" },
    });
    setIcon(graphBtn, Icon.OpenInGraph);
    graphBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openInGraph(task);
    });

    const moreBtn = actions.createEl("button", {
      cls: "pm-task-action-btn",
      attr: { "aria-label": "More actions", title: "More actions" },
    });
    setIcon(moreBtn, Icon.MoreActions);
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openTaskContextMenu(e, task, projectMap);
    });
  }

  protected renderExpandList(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, EffectiveValues>,
  ): void {
    for (const task of tasks) {
      this.renderTaskRow(container, task, projectMap, effectiveValuesMap.get(task.id), true);
    }
    if (tasks.length === 0) container.createDiv({ cls: "pm-dash-expand-empty", text: "No tasks" });
  }

  /** Offers a destination for a checklist item — a project, a task within it, or a new
   *  project — then turns the line into a real task. `sourcePath` is the file holding it. */
  protected openPromoteModal(
    item: DayTask,
    sourcePath: string,
    projects: Project[],
    habitsTag: string,
  ): void {
    new MoveTargetModal(this.app, {
      heading: `Promote "${item.displayTitle(habitsTag)}"`,
      ctaLabel: "Promote",
      projects,
      tasks: this.allTasks,
      allowNewProject: true,
      // Any destination is legal: the task has no subtree yet, and no dependencies.
      onChoose: (choice) => {
        promoteChecklistItem(this.app, sourcePath, item, choice, {
          projectsFolder: this.plugin.settings.projectsFolder,
          habitsTag,
        })
          .then(() => {
            new Notice(`Promoted "${item.displayTitle(habitsTag)}"`);
            this.onRefresh();
          })
          .catch((e) => {
            console.error("pm-compass: promote failed", e);
            new Notice(`Promote failed: ${e instanceof Error ? e.message : String(e)}`);
          });
      },
    }).open();
  }

  protected openTaskContextMenu(e: MouseEvent, task: Task, projectMap: Map<string, Project>): void {
    openTaskContextMenu(this.app, e, {
      task,
      projects: [...projectMap.values()],
      allTasks: this.allTasks,
      onRefresh: () => this.onRefresh(),
      onDelete: (t, parentTask) => this.runMutation(
        () => deleteTaskFile(this.app, t, parentTask, this.allTasks),
        "Couldn't delete the task",
      ),
      confirmDelete: this.plugin.settings.confirmDeletes,
    });
  }

  protected async openInGraph(task: Task): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(TASK_GRAPH_VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TASK_GRAPH_VIEW_TYPE, active: true });
      // Obsidian may defer view construction past setViewState; wait up to 500 ms.
      for (let i = 0; i < 10 && !(leaf.view instanceof TaskGraphView); i++) {
        await new Promise((r) => window.setTimeout(r, 50));
      }
    }
    await this.app.workspace.revealLeaf(leaf);

    if (leaf.view instanceof TaskGraphView) {
      await leaf.view.openTask(task.projectId, task.id);
    }
  }
}
