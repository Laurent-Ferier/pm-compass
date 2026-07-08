import { App, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type PMCompassPlugin from "../main";
import type { Task, Project } from "../model/shared";
import { daysLabel } from "../model/task-scoring";
import {
  PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS, STATUS_LABELS, STATUSES, PRIORITIES,
  getStatusColor, getPriorityColor,
} from "../model/task-vocabulary";
import { INFO_SVG, setSvgIcon } from "./icons";
import { renderInlineMarkdown } from "./day-task-row";
import { TaskModal, ConfirmModal, patchTaskField, deleteTaskFile, openDropdown, openNoteFile } from "./task-creator";
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

  constructor(
    protected readonly app: App,
    protected readonly plugin: PMCompassPlugin,
    protected readonly onRefresh: () => void,
  ) {}

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
    setIcon(chevron, "chevron-down");
    header.createSpan({ cls: "pm-dash-section-title", text: title });

    if (options?.tooltip) {
      const info = header.createSpan({ cls: "pm-dash-section-info" });
      setSvgIcon(info, INFO_SVG);
      info.createDiv({ cls: "pm-dash-section-tooltip", text: options.tooltip });
      info.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = info.classList.toggle("pm-dash-section-info--open");
        if (isOpen) {
          const close = (ev: MouseEvent) => {
            if (!info.contains(ev.target as Node)) {
              info.classList.remove("pm-dash-section-info--open");
              document.removeEventListener("click", close, true);
            }
          };
          document.addEventListener("click", close, true);
        }
      });
    }

    const body = section.createDiv({ cls: "pm-dash-section-body" });
    if (isCollapsed) body.style.display = "none";

    header.addEventListener("click", () => {
      const nowCollapsed = !(this.plugin.settings.dashboardCollapsed[key] ?? false);
      this.plugin.settings.dashboardCollapsed[key] = nowCollapsed;
      void this.plugin.saveSettings();
      chevron.toggleClass("pm-dash-section-chevron--collapsed", nowCollapsed);
      body.style.display = nowCollapsed ? "none" : "";
    });

    return { section, body };
  }

  protected renderTaskRow(
    container: HTMLElement,
    task: Task,
    projectMap: Map<string, Project>,
    effectivePriority?: string,
    effectiveDue?: string,
    readonly = false,
  ): void {
    const row = container.createDiv({ cls: `pm-dash-task-row${readonly ? " pm-dash-task-row--readonly" : ""}` });
    row.dataset.taskId = task.id;

    const ribbonColor = getPriorityColor(effectivePriority ?? task.priority);
    const ribbon = row.createDiv({ cls: "pm-dash-task-ribbon" });
    if (ribbonColor) ribbon.style.setProperty("--pm-ribbon-color", ribbonColor);
    const ownLabel = PRIORITY_LABELS[task.priority ?? ""] ?? "None";
    const effLabel = effectivePriority ? PRIORITY_LABELS[effectivePriority] ?? effectivePriority : ownLabel;
    ribbon.title = effectivePriority && effectivePriority !== task.priority
      ? `Effective priority: ${effLabel} (own: ${ownLabel})`
      : `Priority: ${ownLabel}`;
    if (!readonly) {
      ribbon.addEventListener("click", (e) => {
        e.stopPropagation();
        openDropdown(
          ribbon,
          PRIORITIES.map((p) => ({
            label: PRIORITY_LABELS[p],
            color: PRIORITY_COLORS[p] ?? "#6b7280",
            onSelect: () => {
              void patchTaskField(this.app, task.filePath, "priority", p).then(
                () => this.onRefresh(),
              );
            },
          })),
        );
      });
    }

    const project = projectMap.get(task.projectId);
    const displayDue = effectiveDue ?? task.due;
    const statusColor = getStatusColor(task.status);

    const body = row.createDiv({ cls: "pm-dash-task-body" });

    const line1 = body.createDiv({ cls: "pm-dash-task-line" });
    void renderInlineMarkdown(line1.createSpan({ cls: "pm-dash-task-title" }), task.title, this.app, this.plugin);
    if (project) {
      const badge = line1.createSpan({ cls: "pm-dash-task-project", text: project.title });
      if (project.color) badge.style.setProperty("--pm-project-color", project.color);
    }

    const line2 = body.createDiv({ cls: "pm-dash-task-line" });
    const statusBadge = line2.createSpan({ cls: "pm-dash-task-status" });
    statusBadge.setText(STATUS_LABELS[task.status] ?? task.status);
    statusBadge.style.setProperty("--pm-status-bg", `${statusColor}22`);
    statusBadge.style.setProperty("--pm-status-color", statusColor);
    statusBadge.style.setProperty("--pm-status-border-color", `${statusColor}55`);
    if (!readonly) {
      statusBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        openDropdown(
          statusBadge,
          STATUSES.map((s) => ({
            label: STATUS_LABELS[s],
            color: STATUS_COLORS[s],
            onSelect: () => {
              void patchTaskField(this.app, task.filePath, "status", s).then(
                () => this.onRefresh(),
              );
            },
          })),
        );
      });
    }
    if (displayDue) {
      const { text, overdue } = daysLabel(displayDue);
      const dueSpan = line2.createSpan({
        cls: `pm-dash-task-due${overdue ? " pm-dash-task-due--overdue" : ""}`,
        text,
      });
      if (effectiveDue && effectiveDue !== task.due) {
        dueSpan.title = `Effective deadline: ${effectiveDue} (own: ${task.due ?? "none"})`;
      }
    }

    if (!readonly) {
      const editBtn = row.createEl("button", {
        cls: "pm-dash-task-edit-btn",
        attr: { title: "Edit task" },
      });
      setIcon(editBtn, "pencil");
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
          openNoteFile(this.app, task.filePath);
          return;
        }
        new TaskModal(this.app, {
          mode: "edit",
          task,
          existingTasks: this.allTasks.filter((t) => t.projectId === task.projectId),
          onSuccess: () => this.onRefresh(),
        }).open();
      });
    }

    row.addEventListener("click", (e) => {
      if (!readonly && (e.target as HTMLElement).closest(".pm-dash-task-ribbon, .pm-dash-task-status, .pm-dash-task-edit-btn")) return;
      void this.openInGraph(task);
    });

    if (!readonly) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openTaskContextMenu(e, task, projectMap);
      });
    }
  }

  protected renderExpandList(
    container: HTMLElement,
    tasks: Task[],
    projectMap: Map<string, Project>,
    effectiveValuesMap: Map<string, { priority: string | undefined; due: string | undefined }>,
  ): void {
    for (const task of tasks) {
      const eff = effectiveValuesMap.get(task.id);
      this.renderTaskRow(container, task, projectMap, eff?.priority, eff?.due, true);
    }
    if (tasks.length === 0) container.createDiv({ cls: "pm-dash-expand-empty", text: "No tasks" });
  }

  protected openTaskContextMenu(e: MouseEvent, task: Task, projectMap: Map<string, Project>): void {
    const project = projectMap.get(task.projectId);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Add subtask").setIcon("plus").onClick(() => {
        if (!project) return;
        new TaskModal(this.app, {
          mode: "create",
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
      item.setTitle("Delete task").setIcon("trash").onClick(() => {
        const descendantCount = this.countDescendants(task.id);
        const msg = descendantCount > 0
          ? `Delete "${task.title}" and its ${descendantCount} subtask${descendantCount > 1 ? "s" : ""}?`
          : `Delete "${task.title}"?`;
        new ConfirmModal(this.app, msg, () => {
          const parentTask = task.parentId ? this.allTasks.find((t) => t.id === task.parentId) : undefined;
          void deleteTaskFile(this.app, task, parentTask, this.allTasks).then(() => this.onRefresh());
        }).open();
      })
    );
    menu.showAtMouseEvent(e);
  }

  protected countDescendants(taskId: string): number {
    let count = 0;
    for (const child of this.allTasks.filter((t) => t.parentId === taskId)) {
      count += 1 + this.countDescendants(child.id);
    }
    return count;
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
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    this.app.workspace.revealLeaf(leaf);

    if (leaf.view instanceof TaskGraphView) {
      await leaf.view.openTask(task.projectId, task.id);
    }
  }
}
