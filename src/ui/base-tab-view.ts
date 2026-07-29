import { App, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import {
  BaseTask, isDoneStatus, joinStatuses, statusLabel, toStatus,
  PRIORITIES, PRIORITY_COLORS, PRIORITY_LABELS, Priority,
  STATUS_COLORS, STATUS_LABELS, Status, type RollupLookup,
} from "../model/base-task";
import {
  buildChildMap, collectDescendants, effectiveStatus,
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
import {
  renderTaskTitle, appendRescheduleButton, attachActionsTapToggle,
  renderNoteChevron,
} from "./day-task-row";
import { formatDate, sameDay, timestampDay } from "../model/dates";
import type { DatePickerOptions } from "./date-picker";
import {
  TaskModal, TaskModalMode, ConfirmModal, patchTaskField, patchTaskDue,
  deleteTaskFile, openDropdown, openNoteFile,
} from "./task-creator";
import { MoveTargetModal, openMoveTaskModal } from "./move-target-modal";
import { promoteChecklistItem } from "../model/operations/checklist-promote";
import { setChecklistItemPriority } from "../model/daily/day-task-actions";
import type { DayTask } from "../model/daily/day-task";
import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";

/** Base class for the Dashboard/Inbox/Week Summary tabs: collapsible sections,
 *  a shared project-task row renderer, and the task-graph handoff used when a
 *  row is clicked. */
export abstract class BaseTabView {
  allTasks: Task[] = [];

  /** Keys (see `renderNoteChevron`) of tasks whose note panel is currently expanded.
   *  Survives across `render()` calls (unlike the DOM, which is torn down and rebuilt
   *  on every refresh), so editing a note doesn't collapse it back on save. */
  protected readonly openNoteKeys = new Set<string>();

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
    /** Takes the Dashboard to a day — where every date on a row leads, whichever tab and
     *  whichever kind of task it sits on. Defaulted so a view can be built without one. */
    protected readonly showDay: (date: Date) => void = () => {},
  ) {}

  /**
   * Run a mutating action, refresh on success, and surface a failure as a
   * Notice instead of letting the rejection vanish. A failed vault write
   * (locked or read-only file, a sync conflict) would otherwise leave the row
   * stale with no feedback at all.
   */
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

  /**
   * Makes a ribbon rendered by `renderPriorityRibbon` a dropdown trigger: same picker,
   * same affordance (pointer, hover, enlarged tap zone) on a checklist line and on a
   * project task, only `apply` differs — a marker in the checklist line one side, a
   * frontmatter field the other.
   */
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

  /** A project task as a row of a task list: its usual row, in the `li` a `ul` may hold.
   *  Both tabs' lists draw their non-day rows through this. */
  protected renderProjectTaskRow(
    list: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    effectiveValues: Map<string, EffectiveValues>,
    showCreated = false,
  ): void {
    // The shell makes the `<li>` now, so the list is handed straight over.
    this.renderTaskRow(list, task, projectMap, effectiveValues.get(task.id), false, showCreated);
  }

  /**
   * The two slots a checklist line fills the same way in both tabs: where its priority
   * ribbon writes, and the note panel under it. Both need a resolved file, and a habit
   * takes its level from its definition rather than from the row — so both come back
   * undefined where there is nothing to write to.
   */
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
        main, li, item, filePath, this.app, this.plugin, this.openNoteKeys, () => this.onRefresh(),
      ),
    };
  }

  /**
   * The binary control: a `- [ ]` is ticked or it is not. A span rather than an input,
   * so it sits on the row's grid — announced as a checkbox only when `onToggle` gives it
   * something to write to, since an unfocusable, stateless one is worse than none.
   */
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
      // The row itself toggles its action bar on a tap; the box is not part of that.
      e.stopPropagation();
      e.preventDefault();
      opts.onToggle!(box, li);
    };
    box.addEventListener("click", toggle);
    // What a real checkbox answers to, so the span standing in for one answers to it too.
    box.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") toggle(e);
    });
  }

  /**
   * The control for a task whose scale has more than two rungs: the status icon, opening
   * a picker of that scale. Inert without `setStatus` — there is nowhere to write the pick.
   */
  private renderRowStatusPicker(
    main: HTMLElement,
    item: BaseTask,
    opts: { statusInForce?: string; setStatus?: (status: Status) => void },
  ): void {
    // A task under a cancelled ancestor reads cancelled, which only the view can work
    // out; `statusValue` is the task's own and is what a row falls back to.
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
   * Every row in the plugin, whichever kind of task it holds, and the reason the lists sit
   * on one grid: the `<li>` and the middle of its line — leading slot, priority ribbon,
   * status control, title. What differs goes in the slots it leaves open (`lead`,
   * `titleHost`, `notePanel`, `badges`, `actions`), and what control it draws is the task's
   * own answer, not the caller's — see `statusScale`.
   */
  protected renderRowShell(
    list: HTMLElement,
    item: BaseTask,
    opts: {
      /** The row's own class; `--checked` is appended to it unless `markClosed` says not to. */
      cls: string;
      /** The `<li>`'s shared class, and the inner line's. The two kinds of row sit on
       *  different grids, so each names its own — everything between them is the same. */
      rowCls?: string;
      mainCls?: string;
      /** Whether a closed row says so with a `--checked` modifier on `cls`. A project
       *  task says it instead with the closed date it carries in place of a deadline. */
      markClosed?: boolean;
      /** Whether the inner line is the row proper, the `<li>` being only a list slot —
       *  which is where the tap-toggle's open state and its background belong. */
      lineIsRow?: boolean;
      /** Where the title and everything after it goes, given the inner line. A project
       *  task nests one level deeper than a checklist line; default is the line itself. */
      titleHost?: (main: HTMLElement) => HTMLElement;
      /** The leading slot, for a row that names its own. Default is the checklist's:
       *  the habit mark, else the grip, else the day, else the inbox. */
      lead?: (main: HTMLElement) => void;
      /** What clicking the row itself does, where it does anything. */
      onRowClick?: () => void;
      titleCls: string;
      habitsTag: string;
      /** The file this row is written to. The task usually knows it; the Inbox passes the
       *  list's own path, which is the file its rows all live in. */
      filePath?: string | null;
      /** The grip, with the row's own item already bound: only a checklist line has an
       *  order to persist, so the caller — which knows what kind it is drawing — closes
       *  over it rather than the shell narrowing back to find out. */
      addDragHandle: (parent: HTMLElement, row: HTMLElement, draggable?: boolean) => void;
      /** True only for a row this list can reorder; the others put their day in the slot
       *  instead, having no order to persist from here. */
      movable: boolean;
      toggleLabel: string;
      /** What ticking the box does. Absent, the box is inert: there is nothing to write to. */
      onToggle?: (box: HTMLElement, li: HTMLElement) => void;
      /** The status in force, where an ancestor overrides the task's own — the view works
       *  that out, since it needs the whole tree. Defaults to the task's own. */
      statusInForce?: string;
      /** What picking a status does, for a task whose scale has more than two rungs. */
      setStatus?: (status: Status) => void;
      /** The roll-up behind the priority ribbon's two ends. Absent for a checklist line,
       *  which has no tree either side of it. */
      rollup?: RollupLookup;
      /** Where the priority ribbon writes a new level. Absent, the ribbon is a picture:
       *  a habit takes its level from its definition, and a row with no file has nowhere
       *  to put one. */
      setPriority?: (priority: Priority) => Promise<unknown>;
      /** The expandable note under the row. Only a task whose body is a handful of
       *  indented lines has one — a project task's body is a whole document. */
      notePanel?: (main: HTMLElement, li: HTMLElement) => void;
      badges?: (main: HTMLElement) => void;
      /** The row's trailing controls, given the line to build them on. Each kind makes its
       *  own toolbar: a checklist line opens a `.pm-task-actions` slot, a project row has
       *  `renderTaskActions` build one for it. */
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
    // The row proper: the `<li>` for a checklist line, the line inside it for a project
    // task, whose `<li>` carries no styling of its own.
    const rowEl = opts.lineIsRow ? main : li;
    attachActionsTapToggle(rowEl);
    if (opts.onRowClick) rowEl.addEventListener("click", () => opts.onRowClick!());

    // The leading slot, on every row and always the same width so the lists line up: the
    // recurring mark on a habit, else the grip where this list can persist the order, else
    // the day the line falls under, else the inbox a line no day holds yet waits in.
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
    // All three levels every time: with no roll-up the two ends are the task's own, which
    // is exactly what `renderPriorityRibbon` falls back to anyway.
    const ribbon = renderPriorityRibbon(
      main,
      item.ownPriority ?? undefined,
      item.priorityFromAbove(opts.rollup) ?? undefined,
      item.priorityFromBelow(opts.rollup) ?? undefined,
    );
    if (opts.setPriority) {
      // A `Lowest` line has no rung in the picker, so nothing is marked — which is the truth.
      this.attachPriorityDropdown(ribbon, item.ownPriority ?? undefined, opts.setPriority);
    }

    // What control the row draws is the task's own answer: two rungs on its scale means
    // a checkbox, more means the status picker. The row never asks what kind it is.
    if (item.statusScale.length > 2) {
      this.renderRowStatusPicker(main, item, opts);
    } else {
      this.renderRowCheckbox(main, li, item, opts);
    }

    const titleHost = opts.titleHost?.(main) ?? main;
    const titleSpan = renderTaskTitle(
      titleHost, item.rowTitle(opts.habitsTag), this.app, this.plugin, opts.titleCls,
    );

    opts.notePanel?.(main, li);

    opts.badges?.(titleHost);

    if (filePath && opts.actions) {
      opts.actions(main, li, titleSpan);
    }
  }

  /**
   * The add-task bar a list tab ends with: sticky at the bottom, above the keyboard on
   * mobile. Shared by the Inbox and the Dashboard — the same line, only the file it lands
   * in differs, which is what `add` decides. Returns the bar and its input, for a tab that
   * shows it on demand — the Dashboard, behind its "+".
   */
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

  /** The one way a date reads on any row: `daysLabel`'s label, or the overdue chip once
   *  it is past. */
  protected renderDateBadge(
    container: HTMLElement,
    date: Date,
    opts: {
      title: string;
      /** How many days past the date the warning glyph appears; a deadline warns the day
       *  after, the Inbox waits for its staleness threshold. `0` never warns. */
      warnAfterDays?: number;
      /** The count without the alarm — see `renderDaysBadge`. */
      quiet?: boolean;
      /** Replaces `title` once that glyph is showing. */
      warnTitle?: string;
      /** Counts from the real today rather than `referenceDate` — for an age, which is time
       *  elapsed and can't be read against a day the user is merely looking at. */
      fromToday?: boolean;
      onClick?: (badge: HTMLElement) => void;
    },
  ): void {
    const { text, overdue, daysOverdue } = daysLabel(date, opts.fromToday ? new Date() : this.referenceDate());
    if (overdue) {
      // The default goes after the spread: before it, a caller passing the key at all —
      // an explicit `undefined` included — would take it back out again.
      renderDaysBadge(container, daysOverdue, { ...opts, warnAfterDays: opts.warnAfterDays ?? 1 });
    } else {
      renderMetaBadge(container, { text, ...opts });
    }
  }

  /**
   * A project task's row, drawn by the same shell as a checklist line's — the two differ
   * only in what they put in the slots it leaves open: a project icon in the lead, a body
   * nested one level deeper, warnings and a project pill beside the title, and a toolbar
   * of its own. `eff` is the task's `computeEffectiveValues` entry, whose roll-ups always
   * travel together.
   */
  protected renderTaskRow(
    list: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    eff?: EffectiveValues,
    readonly = false,
    /** Whether the row carries its creation date. Only the Inbox does: there a task's age
     *  is what it is triaged on, while on the dashboard it competes with the deadline the
     *  row is actually there for. */
    showCreated = false,
  ): void {
    const project = projectMap.get(task.projectId);
    const displayDue = eff?.due ?? task.due;
    // A deadline the task doesn't own: shown, named on hover, but not editable from here.
    const inheritedDue = !!eff?.due && (!task.due || !sameDay(eff.due, task.due));
    // Under a cancelled parent the tooltip spells out both: "In Progress / Cancelled".
    const statusInForce = effectiveStatus(task, this.taskById());
    // The row's own roll-up, as the shell's ribbon reads it.
    // One row, one roll-up: the id is not consulted because there is nothing to look up.
    const rollup: RollupLookup = () => eff;

    this.renderRowShell(list, task, {
      cls: "pm-dash-task-item",
      // The `<li>` is only a list slot for a project task; the row proper is the line
      // inside it, which is where its own class and modifier belong.
      rowCls: "",
      lineIsRow: true,
      // A closed project task is marked by the date it closed on, not by a dimmed row.
      markClosed: false,
      mainCls: `pm-dash-task-row${readonly ? " pm-dash-task-row--readonly" : ""}`,
      titleCls: "pm-dash-task-title",
      // A project task's title carries no habit tag to strip.
      habitsTag: "",
      // A project task nests a body between the row and its first line.
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
      // No toolbar to reveal on a read-only echo, so the row keeps the graph on its click.
      onRowClick: readonly ? () => void this.openInGraph(task) : undefined,
      // The drag is a checklist-only affair; a project task never claims the grip.
      addDragHandle: () => {},
      movable: false,
      toggleLabel: "",

      // The leading slot: the project, in its own colour. Always there — it is what names
      // the project once the row is too narrow for the name.
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
        // Before the dates, so the date badge stays the row's last column as it is on a day
        // task's row: merged into one list, the two kinds' dates line up.
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
        // then when it is due. Either opens its day; the toolbar's "Set deadline" button is
        // where a deadline is changed. `createdAt` is an instant; the badge is a day, so it
        // shows the day that field records rather than the one it falls on locally.
        const created = showCreated && task.createdAt ? timestampDay(task.createdAt) : undefined;
        // Closed work is dated by the day it closed, in place of a deadline it no longer has
        // to meet — whose overdue alarm would be a warning about nothing.
        const completedDay = isDoneStatus(statusInForce) && task.closedOn
          ? timestampDay(task.closedOn)
          : undefined;
        const dateBand = created || completedDay || displayDue ? createBadgeBand(line1) : line1;

        if (created) {
          // Quiet: a project task's age is how long it has been on the books, not a warning.
          // And an age counts from today, not from whichever day the dashboard is showing.
          this.renderDateBadge(dateBand, created, {
            quiet: true,
            fromToday: true,
            title: `Created on ${formatDate(created)} — show that day`,
            onClick: readonly ? undefined : () => this.showDay(created),
          });
        }

        if (completedDay) {
          // A cancelled task keeps the timestamp it had when it was done, so the day it names
          // is the day it closed — which is all the badge claims for one.
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

  /** A project task's deadline edit — seeded with its `due`, writing the pick or the clear
   *  back. Used by the toolbar's button. */
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
   * The floating toolbar a project-task row reveals when tapped — the same one a
   * checklist row carries, holding what a task can be *done to* from a list: open its full
   * editor (where the title is edited too), move its deadline, drop that deadline to send it
   * back to the Inbox, jump to it in the graph.
   *
   * The rarer structural actions (add a subtask, move, delete) stay behind the "More"
   * button, which opens the very menu the desktop right-click opens. That keeps the
   * toolbar the same size as a checklist row's, and — unlike the right-click it mirrors —
   * makes those actions reachable on a phone at all.
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

    // Only on a task holding a deadline of its own: that deadline is what puts the row on a
    // dashboard horizon, and dropping it hands the task back to the Inbox. A row with an
    // inherited deadline has nothing here to clear, and one already undated is in the Inbox.
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

  /**
   * Offers a destination for a checklist item — an existing project, a task
   * within it, or a brand-new project — then turns the line into a real task.
   *
   * Shared by the Inbox and the Dashboard: an inbox line and a day-note line are
   * the same thing, and both can turn out to be project work. `sourcePath` is
   * whichever file holds the line.
   */
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
      // Any destination is legal: the task doesn't exist yet, so it has no
      // subtree to move into and no dependencies to invalidate.
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
    const project = projectMap.get(task.projectId);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Add subtask").setIcon(Icon.AddSubtask).onClick(() => {
        if (!project) return;
        new TaskModal(this.app, {
          mode: TaskModalMode.Create,
          projectId: project.id,
          projectFilePath: project.filePath,
          projectTitle: project.title,
          parentTask: task,
          existingTasks: this.allTasks.filter((t) => t.projectId === task.projectId),
          onSuccess: () => this.onRefresh(),
        }).open();
      })
    );
    menu.addItem((item) =>
      item.setTitle("Move task…").setIcon(Icon.MoveTask).onClick(() => {
        openMoveTaskModal(this.app, task, [...projectMap.values()], this.allTasks, () => this.onRefresh());
      })
    );
    menu.addItem((item) =>
      item.setTitle("Delete task").setIcon(Icon.DeleteTask).onClick(() => {
        const descendantCount = this.countDescendants(task.id);
        const msg = descendantCount > 0
          ? `Delete "${task.title}" and its ${descendantCount} subtask${descendantCount > 1 ? "s" : ""}?`
          : `Delete "${task.title}"?`;
        new ConfirmModal(this.app, msg, () => {
          const parentTask = task.parentId ? this.allTasks.find((t) => t.id === task.parentId) : undefined;
          this.runMutation(
            () => deleteTaskFile(this.app, task, parentTask, this.allTasks),
            "Couldn't delete the task",
          );
        }).open();
      })
    );
    menu.showAtMouseEvent(e);
  }

  protected countDescendants(taskId: string): number {
    return collectDescendants(this.allTasks, taskId).length;
  }

  protected async openInGraph(task: Task): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(TASK_GRAPH_VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TASK_GRAPH_VIEW_TYPE, active: true });
      // Obsidian may defer view construction past setViewState resolution; wait
      // up to 500 ms for the view to be attached before proceeding.
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
