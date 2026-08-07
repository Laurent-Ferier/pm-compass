import { DaySummary } from "./day-summary";
import type { ModelStore } from "../base-model";
import { sameValue } from "../io/base-file";
import { withoutArchivedTasks } from "../project/archive";
import { selectUndatedTasks, type UndatedSelection } from "../project/task-scoring";
import type { ProjectTask } from "../project/project-task";
import type { TaskFile } from "../io/task-file";
import type { ProjectStore } from "../store/project-store";
import { StoreEvent } from "../store/store-events";

/**
 * The inbox: what has been written down and not yet placed.
 *
 * Two halves, for the same reason. Its own file's lines, which it holds as any day does —
 * hence `DaySummary`. And the project tasks carrying a priority but nothing that dates them:
 * no dashboard horizon holds those, so they wait here to be given a day. The second half is
 * the projects folder's, so this listens to it and takes the tasks again whenever it moves.
 *
 * Made by `DayStore` alone.
 */
export class InBox extends DaySummary {
  private undated_: UndatedSelection = { tasks: [], effectiveValues: new Map() };
  /** The folder's reading the selection was made from, so an unchanged one isn't picked
   *  over again — `ProjectStore.tasks` is the same array until a note moves. */
  private pickedFrom: ProjectTask[] | null = null;
  private readonly unsubscribe: () => void;

  constructor(file: TaskFile, store: ModelStore, private readonly projects: ProjectStore) {
    super(file, store, null);
    // The folder's own telling, so a project task gaining or losing a deadline moves it in
    // or out of here — the day store hears about it as it would about a line. Only for a
    // change this inbox holds something of: the folder is mostly notes it never shows.
    this.unsubscribe = projects.on(StoreEvent.ProjectsChanged, ({ paths }) => {
      if (this.picksAgain(paths)) this.store.changed(this);
    });
  }

  /** The project tasks that belong here, with the effective values they were picked by —
   *  which their ribbons need. An archived project's are left out: put away, not undone. */
  get undated(): UndatedSelection {
    const { tasks, projects } = this.projects;
    if (this.pickedFrom !== tasks) {
      this.pickedFrom = tasks;
      this.undated_ = selectUndatedTasks(withoutArchivedTasks(tasks, projects));
    }
    return this.undated_;
  }

  /**
   * Whether that change moved what this inbox shows: a task it holds now reading
   * differently, or the pick itself gaining or losing one — a deadline set, a project
   * archived out from under its tasks.
   *
   * The pick is taken again to answer it, which is the work the next read would have done
   * anyway. A task is named by its path rather than compared: the tasks are live models, so
   * one whose title moved is the same object either way.
   */
  private picksAgain(paths: readonly string[]): boolean {
    const held = this.undated_.tasks;
    this.pickedFrom = null;
    const picked = this.undated.tasks;
    if (!sameValue(held, picked)) return true;
    return paths.some((path) => picked.some((task) => task.filePath === path));
  }

  override discard(): void {
    this.unsubscribe();
    super.discard();
  }
}
