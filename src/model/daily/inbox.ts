import { DaySummary } from "./day-summary";
import type { ModelStore } from "../base-model";
import { withoutArchivedTasks } from "../project/archive";
import { selectUndatedTasks, type UndatedSelection } from "../project/task-scoring";
import type { ProjectTask } from "../project/project-task";
import type { TaskNote } from "../store/task-note";
import type { ProjectNoteStore } from "../store/project-note-store";
import { StoreEvent } from "../store/store-events";

/**
 * The inbox: what has been written down and not yet placed.
 *
 * Two halves, for the same reason. Its own note's lines, which it holds as any day does —
 * hence `DaySummary`. And the project tasks carrying a priority but nothing that dates them:
 * no dashboard horizon holds those, so they wait here to be given a day. The second half is
 * the projects folder's, so this listens to it and takes the tasks again whenever it moves.
 *
 * Made by `DayStore` alone.
 */
export class InBox extends DaySummary {
  private undated_: UndatedSelection = { tasks: [], effectiveValues: new Map() };
  /** The folder's reading the selection was made from, so an unchanged one isn't picked
   *  over again — `ProjectNoteStore.tasks` is the same array until a note moves. */
  private pickedFrom: ProjectTask[] | null = null;
  private readonly unsubscribe: () => void;

  constructor(note: TaskNote, store: ModelStore, private readonly projects: ProjectNoteStore) {
    super(note, store, null);
    // The folder's own telling, so a project task gaining or losing a deadline moves it in
    // or out of here — the day store hears about it as it would about a line.
    this.unsubscribe = projects.on(StoreEvent.ProjectsChanged, () => this.store.changed(this));
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

  override discard(): void {
    this.unsubscribe();
    super.discard();
  }
}
