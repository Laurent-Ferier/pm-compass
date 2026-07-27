/**
 * What a list needs of a task whichever kind it is: a daily note's checklist line
 * (`DayTask`) or an obsidian-pm project task (`Task`). Every list the dashboard and the
 * Inbox show is built on this (`ui/task-list.ts`); nothing here papers over how differently
 * the two are stored and written back.
 */
export abstract class BaseTask {
  abstract readonly title: string;

  /** The vault file holding it: the note a checklist line lives in, a project task's own
   *  file. Null for a line parsed out of any file, which nothing can act on. */
  abstract readonly filePath: string | null;

  /**
   * The date the task is *shown* under, `YYYY-MM-DD`, which is what orders a list — a
   * checklist line is dated by the note holding it, whatever the line itself says.
   * Undefined when nothing dates it. An ancestor's deadline can still pull a project task
   * forward; that roll-up is `computeEffectiveValues`', not this.
   */
  abstract get plannedDate(): string | undefined;
}
