import { App, Menu } from "obsidian";
import { Icon } from "./icons";
import { ConfirmModal, TaskModal, TaskModalMode } from "./task-creator";
import { openMoveTaskModal } from "./move-target-modal";
import { collectDescendants } from "../model/project/task-tree";
import type { Task } from "../model/project/task";
import type { Project } from "../model/project/project";

export interface TaskContextMenuOptions {
  task: Task;
  projects: Project[];
  /** Full flat task list: what the subtask modal, the move picker and the delete count
   *  are all read off. */
  allTasks: Task[];
  onRefresh: () => void;
  /** Runs the confirmed delete, so each view keeps its own way of reporting a failure. */
  onDelete: (task: Task, parentTask: Task | undefined) => void;
}

/** The right-click menu on a project task, wherever it is drawn — a dashboard or Inbox
 *  row, a graph node. Lives apart from either so both can reach it. */
export function openTaskContextMenu(app: App, e: MouseEvent, opts: TaskContextMenuOptions): void {
  const { task, projects, allTasks, onRefresh, onDelete } = opts;
  const project = projects.find((p) => p.id === task.projectId);
  const menu = new Menu();
  menu.addItem((item) =>
    item.setTitle("Add subtask").setIcon(Icon.AddSubtask).onClick(() => {
      if (!project) return;
      new TaskModal(app, {
        mode: TaskModalMode.Create,
        projectId: project.id,
        projectFilePath: project.filePath,
        projectTitle: project.title,
        parentTask: task,
        existingTasks: allTasks.filter((t) => t.projectId === task.projectId),
        onSuccess: onRefresh,
      }).open();
    })
  );
  menu.addItem((item) =>
    item.setTitle("Move task…").setIcon(Icon.MoveTask).onClick(() => {
      openMoveTaskModal(app, task, projects, allTasks, onRefresh);
    })
  );
  menu.addItem((item) =>
    item.setTitle("Delete task").setIcon(Icon.DeleteTask).onClick(() => {
      const descendantCount = collectDescendants(allTasks, task.id).length;
      const msg = descendantCount > 0
        ? `Delete "${task.title}" and its ${descendantCount} subtask${descendantCount > 1 ? "s" : ""}?`
        : `Delete "${task.title}"?`;
      new ConfirmModal(app, msg, () => {
        onDelete(task, task.parentId ? allTasks.find((t) => t.id === task.parentId) : undefined);
      }).open();
    })
  );
  menu.showAtMouseEvent(e);
}
