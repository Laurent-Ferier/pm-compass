import { Task } from "../daily/task";
import type { VaultData } from "../service/vault-data";
import { ProjectTaskFile } from "../io/project-task-file";
import { MoveChoiceKind, TaskType, type MoveChoice, type ProjectTask } from "../project/project-task";
import { Priority, Status } from "../base-task";

/** `Lowest` has no project-task counterpart, so it folds into `Low` rather than being
 *  written as a value no picker can display. */
const PRIORITY_FALLBACK: Partial<Record<Priority, Priority>> = { [Priority.Lowest]: Priority.Low };

/** An unmarked inbox line promotes as `Medium`, so it lands in the middle of the pile
 *  rather than below everything carrying a level. */
const DEFAULT_PRIORITY = Priority.Medium;

/**
 * Turns an inbox checklist line into a project task, translating its metadata across the
 * two models, then drops the line. The line goes last, as in `rescheduleChecklistItem`,
 * so a crash mid-way leaves a visible duplicate rather than losing the item.
 */
export async function promoteChecklistItem(
  vault: VaultData,
  sourcePath: string,
  item: Task,
  target: MoveChoice,
  opts: { projectsFolder: string; habitsTag: string },
): Promise<{ taskId: string; projectId: string }> {
  const destination = target.kind === MoveChoiceKind.NewProject
    ? await createDestinationProject(vault, target.title, opts.projectsFolder)
    : target;

  // Tags become frontmatter, so `#tag` text is stripped from the title.
  const title = item.displayTitle(opts.habitsTag) || item.title;
  const priority = item.priority
    ? (PRIORITY_FALLBACK[item.priority] ?? item.priority)
    : DEFAULT_PRIORITY;

  const file = await ProjectTaskFile.create(vault, {
    projectId: destination.projectId,
    projectFilePath: destination.projectFilePath,
    projectTitle: destination.projectTitle,
    parentTask: destination.parentTask,
    title,
    // The indented notes under the line are its context, and become the description.
    description: item.subLines.map((l) => l.trim()).join("\n").trim(),
    // A ticked line promotes to a task already done, on the day it was ticked.
    status: item.checked ? Status.Done : Status.Todo,
    completed: item.checked ? (item.completedAt ?? item.noteDate ?? new Date()) : null,
    priority,
    type: destination.parentTask ? TaskType.Subtask : TaskType.Task,
    // Progress is the user's own slider, not a reading of the status.
    progress: 0,
    start: item.startDate,
    // A project task has neither a ⏳ nor a day note, so both fold into `due`, an
    // explicit date beating the day the line sat under.
    due: item.dueDate ?? item.scheduledDate ?? item.noteDate,
    tags: [...item.tagNames],
    dependencies: [],
  });

  await vault.tasks.notes.file(sourcePath).removeLine(item);
  return { taskId: file.snapshot().id, projectId: destination.projectId };
}

async function createDestinationProject(
  vault: VaultData,
  title: string,
  projectsFolder: string,
): Promise<{ projectId: string; projectFilePath: string; projectTitle: string; parentTask?: ProjectTask }> {
  const project = await vault.projects.createProject({ projectsFolder, title });
  return { projectId: project.id, projectFilePath: project.filePath, projectTitle: title };
}
