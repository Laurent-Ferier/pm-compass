import { App, Menu } from "obsidian";
import { Icon } from "./icons";
import { confirmAction, TaskModal, TaskModalMode } from "./task-creator";
import { openMoveTaskModal } from "./move-target-modal";
import { collectDescendants } from "../model/project/task-tree";
import type { Task } from "../model/project/task";
import type { Project } from "../model/project/project";
import type { VaultData } from "../model/store/vault-data";

export interface TaskActionsOptions {
  task: Task;
  /** The one way to the vault: the subtask modal writes through it. */
  vault: VaultData;
  projects: Project[];
  /** Full flat task list: what the subtask modal, the move picker and the delete count
   *  are all read off. */
  allTasks: Task[];
  onRefresh: () => void;
  /** Runs the confirmed delete, so each view keeps its own way of reporting a failure. */
  onDelete: (task: Task, parentTask: Task | undefined) => void;
  /** The `confirmDeletes` setting: off, the delete runs without asking. */
  confirmDelete: boolean;
}

export interface TaskContextMenuOptions extends TaskActionsOptions {
  /** What a view has to offer for this task that the others don't — the graph's links out
   *  of the level being drawn, which only it knows the level of. */
  extraItems?: (menu: Menu, task: Task) => void;
}

/** Opens the subtask editor under the task, on the project the task belongs to. */
export function addSubtask(app: App, opts: TaskActionsOptions): void {
  const { task, projects, allTasks, onRefresh } = opts;
  const project = projects.find((p) => p.id === task.projectId);
  if (!project) return;
  new TaskModal(app, {
    mode: TaskModalMode.Create,
    vault: opts.vault,
    projectId: project.id,
    projectFilePath: project.filePath,
    projectTitle: project.title,
    parentTask: task,
    existingTasks: allTasks.filter((t) => t.projectId === task.projectId),
    onSuccess: onRefresh,
  }).open();
}

/** Offers the task another parent or project. */
export function moveTask(app: App, opts: TaskActionsOptions): void {
  openMoveTaskModal(app, opts.vault, opts.task, opts.projects, opts.allTasks, opts.onRefresh);
}

/** Deletes the task, asking first where the setting says to and counting the subtree the
 *  delete takes with it. */
export function deleteTask(app: App, opts: TaskActionsOptions): void {
  const { task, allTasks, onDelete, confirmDelete } = opts;
  const descendantCount = collectDescendants(allTasks, task.id).length;
  const msg = descendantCount > 0
    ? `Delete "${task.title}" and its ${descendantCount} subtask${descendantCount > 1 ? "s" : ""}?`
    : `Delete "${task.title}"?`;
  confirmAction(app, confirmDelete, msg, () => {
    onDelete(task, task.parentId ? allTasks.find((t) => t.id === task.parentId) : undefined);
  });
}

/** The right-click menu on a project task, wherever it is drawn — a dashboard or Inbox
 *  row, a graph node. Lives apart from either so both can reach it. */
export function openTaskContextMenu(app: App, e: MouseEvent, opts: TaskContextMenuOptions): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item.setTitle("Add subtask").setIcon(Icon.AddSubtask).onClick(() => addSubtask(app, opts))
  );
  opts.extraItems?.(menu, opts.task);
  menu.addItem((item) =>
    item.setTitle("Move task…").setIcon(Icon.MoveTask).onClick(() => moveTask(app, opts))
  );
  menu.addItem((item) =>
    item.setTitle("Delete task").setIcon(Icon.DeleteTask).onClick(() => deleteTask(app, opts))
  );
  menu.showAtMouseEvent(e);
}
