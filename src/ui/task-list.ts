import { BaseTask } from "../model/base-task";
import { compareDays } from "../model/dates";
import type { DayTask } from "../model/daily/day-task";
import { createDragReorder, renderInertDragHandle, type AddDragHandle, type ReorderDrop } from "./drag-reorder";

/** Draws one task's row into the list, wrapping it in an `li` if it isn't one. Every row
 *  leads with the same slot, which `addDragHandle` fills where `movable` allows. */
export type RenderTaskRow = (
  task: BaseTask,
  list: HTMLElement,
  lead: { addDragHandle: AddDragHandle<DayTask>; movable: boolean },
) => void;

export interface TaskListOptions {
  /** Extra class on the `<ul>`, for a list its view styles further (the Inbox's). */
  cls?: string;
  /** Orders the tasks by date, undated last and stably. Off, the list shows what it was
   *  given, which is a single note's own order. */
  sortByDate?: boolean;
  /** The date to order a task by, when the caller knows one the task doesn't: a project
   *  task pulled forward by an ancestor's deadline. Defaults to its `plannedDate`. */
  dateOf?: (task: BaseTask) => Date | undefined;
  /** Drag-to-reorder for the tasks `canMove` accepts — the rows of one file, in that
   *  file's own order. Wired only past a second such row: one row has nowhere to go. */
  reorder?: {
    canMove: (task: BaseTask) => boolean;
    onDrop: (drop: ReorderDrop<DayTask>) => void;
  };
}

/** Every list the dashboard and the Inbox show, of any mix of tasks. It owns only where
 *  a row goes; how one looks is the view's, passed once as a `RenderTaskRow`. */
export class TaskList {
  private readonly tasks: BaseTask[] = [];

  /** The `<ul>` of the last `render` and the order its rows are in, for `insertSorted`. */
  private list: HTMLElement | null = null;
  private rendered: BaseTask[] = [];
  private compare: ((a: BaseTask, b: BaseTask) => number) | null = null;

  constructor(private readonly renderRow: RenderTaskRow) {}

  addAll(tasks: BaseTask[]): this {
    this.tasks.push(...tasks);
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

    this.compare = opts.sortByDate ? byDate(opts.dateOf) : null;
    const tasks = this.compare ? [...this.tasks].sort(this.compare) : this.tasks;
    this.list = list;
    this.rendered = [...tasks];

    for (const task of tasks) {
      // An unreorderable row still gets the slot at the grip's width, so the lists
      // sharing a screen line up.
      const movable = addDragHandle !== undefined && reorder!.canMove(task);
      this.renderRow(task, list, {
        addDragHandle: movable ? addDragHandle : renderInertDragHandle,
        movable,
      });
    }
    return list;
  }

  /**
   * Adds one task to a list already rendered, at the place the render's own order gives
   * it — how the horizons take the day notes read after the first paint. The row is
   * unmovable: a list filled this way carries no reorder.
   */
  insertSorted(task: BaseTask): void {
    const list = this.list;
    if (!list) throw new Error("pm-compass: insertSorted before render");
    const at = this.compare
      ? this.rendered.findIndex((other) => this.compare!(task, other) < 0)
      : -1;
    this.tasks.push(task);
    this.renderRow(task, list, { addDragHandle: renderInertDragHandle, movable: false });
    if (at < 0) {
      this.rendered.push(task);
      return;
    }
    // The row went on the end; every index before the old end still names its own row.
    list.insertBefore(list.lastElementChild!, list.children[at]);
    this.rendered.splice(at, 0, task);
  }
}

/** Orders the tasks by date, undated last and stably, closed rows sinking below. */
function byDate(dateOf?: (task: BaseTask) => Date | undefined) {
  const date = dateOf ?? ((task: BaseTask) => task.plannedDate);
  return (a: BaseTask, b: BaseTask): number => {
    const closed = BaseTask.closedLast(a, b);
    if (closed !== 0) return closed;
    const da = date(a);
    const db = date(b);
    // Nothing dates it, so it goes after everything that has a day.
    if (!da || !db) return da === db ? 0 : da ? -1 : 1;
    return compareDays(da, db);
  };
}
