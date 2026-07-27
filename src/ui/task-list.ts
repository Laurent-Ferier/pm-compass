import type { BaseTask } from "../model/base-task";
import type { DayTask } from "../model/day-task";
import { createDragReorder, renderInertDragHandle, type AddDragHandle, type ReorderDrop } from "./drag-reorder";

/** Draws one task's row into the list, wrapping it in an `li` if it isn't one. Every row
 *  leads with the same slot: `addDragHandle` fills it with the grip, and `movable` says
 *  whether this list can reorder the row — one it can't may put something else there. */
export type RenderTaskRow = (
  task: BaseTask,
  list: HTMLElement,
  lead: { addDragHandle: AddDragHandle<DayTask>; movable: boolean },
) => void;

export interface TaskListOptions {
  /** Extra class on the `<ul>`, for a list its view styles further (the Inbox's). */
  cls?: string;
  /** Orders the tasks by date, undated last — stably, so tasks sharing a date keep the
   *  order they were added in. Off, the list shows what it was given, which is what a
   *  single note's own order is. */
  sortByDate?: boolean;
  /** The date to order a task by, when the caller knows one the task doesn't: a project
   *  task pulled forward by an ancestor's deadline. Defaults to its `plannedDate`. */
  dateOf?: (task: BaseTask) => string | undefined;
  /** Drag-to-reorder for the tasks `canMove` accepts — the rows of one file, in that
   *  file's own order. Wired only past a second such row: one row has nowhere to go. */
  reorder?: {
    canMove: (task: BaseTask) => boolean;
    onDrop: (drop: ReorderDrop<DayTask>) => void;
  };
}

/**
 * Every list the dashboard and the Inbox show, whatever the settings put in it: one day's
 * checklist, several days' unclosed lines, project tasks, or any mix of those. It owns
 * only where a row goes — the order and the reorder drag; how a row looks is the view's,
 * passed once as a `RenderTaskRow`.
 */
export class TaskList {
  private readonly tasks: BaseTask[] = [];

  constructor(private readonly renderRow: RenderTaskRow) {}

  add(task: BaseTask): this {
    this.tasks.push(task);
    return this;
  }

  addAll(tasks: BaseTask[]): this {
    for (const task of tasks) this.add(task);
    return this;
  }

  /** Renders the tasks into a `<ul>` of `body`, which it returns. */
  render(body: HTMLElement, opts: TaskListOptions = {}): HTMLElement {
    const list = body.createEl("ul", { cls: `pm-dash-checklist${opts.cls ? ` ${opts.cls}` : ""}` });

    // A drag is wired only past a second movable row: one row has nowhere to go.
    const reorder = opts.reorder && this.tasks.filter(opts.reorder.canMove).length > 1
      ? opts.reorder
      : undefined;
    const addDragHandle = reorder ? createDragReorder<DayTask>(list, reorder.onDrop) : undefined;

    const dateOf = opts.dateOf ?? ((task: BaseTask) => task.plannedDate);
    const tasks = opts.sortByDate
      ? [...this.tasks].sort((a, b) => {
          const da = dateOf(a);
          const db = dateOf(b);
          // Nothing dates it, so nothing orders it: it goes after everything that has a day.
          if (!da || !db) return da === db ? 0 : da ? -1 : 1;
          return da < db ? -1 : da > db ? 1 : 0;
        })
      : this.tasks;

    for (const task of tasks) {
      // A row this list can't reorder still gets the slot, at the grip's width, so the
      // lists sharing a screen line up whether or not each can be dragged.
      const movable = addDragHandle !== undefined && reorder!.canMove(task);
      this.renderRow(task, list, {
        addDragHandle: movable ? addDragHandle : renderInertDragHandle,
        movable,
      });
    }
    return list;
  }
}
