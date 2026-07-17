import { App } from "obsidian";
import { DayTask, formatDate } from "./day-task";
import { deleteChecklistItem } from "./day-task-actions";
import { ProjectTaskFile } from "./project-task-file";
import { ProjectFile } from "./project-file";
import { basenameOf } from "./file-helpers";
import type { MoveChoice, Task } from "./shared";

/**
 * `DayTask.priority` comes from the Obsidian Tasks emoji scale, which has a
 * "lowest" rung that the project-task vocabulary doesn't. Fold it into "low"
 * rather than writing a value no picker can display.
 */
const PRIORITY_FALLBACK: Record<string, string> = { lowest: "low" };

/**
 * Inbox lines usually carry no priority marker. Promote them as "medium" rather
 * than unset: a task entering a project should sit in the middle of the pile,
 * not below everything that has one.
 */
const DEFAULT_PRIORITY = "medium";

/**
 * Turn an inbox checklist line into a real project task, then drop the line.
 *
 * Bridges the two task models: an inbox item is a line of markdown, a project
 * task is a file with frontmatter, and nothing links them — so the item's
 * metadata (dates, priority, tags, sub-lines) is translated across here.
 *
 * The inbox line is removed last, mirroring the ordering rule already used by
 * `rescheduleChecklistItem`: confirm the target exists before touching the
 * source. A crash mid-way therefore leaves a visible duplicate — the task plus
 * the original line — rather than losing the item.
 */
export async function promoteChecklistItem(
  app: App,
  sourcePath: string,
  item: DayTask,
  target: MoveChoice,
  opts: { projectsFolder: string; habitsTag: string },
): Promise<{ taskId: string; projectId: string }> {
  const destination = target.kind === "new-project"
    ? await createDestinationProject(app, target.title, opts.projectsFolder)
    : target;

  // Tags are recorded as frontmatter, so strip them from the title rather than
  // carrying `#tag` text into it.
  const title = item.displayTitle(opts.habitsTag) || item.title;
  const priority = item.priority
    ? (PRIORITY_FALLBACK[item.priority] ?? item.priority)
    : DEFAULT_PRIORITY;

  const { id, file } = await ProjectTaskFile.create(app, {
    projectId: destination.projectId,
    projectFilePath: destination.projectFilePath,
    projectTitle: destination.projectTitle,
    parentTask: destination.parentTask,
    title,
    // Indented notes under the inbox line are the user's context for it; carry
    // them over as the task description instead of discarding them.
    description: item.subLines.map((l) => l.trim()).join("\n").trim(),
    status: "todo",
    priority,
    type: destination.parentTask ? "subtask" : "task",
    progress: 0,
    start: item.startDate ? formatDate(item.startDate) : "",
    due: item.dueDate ? formatDate(item.dueDate) : "",
    tags: item.tags.map((t) => t.replace(/^#/, "")),
    dependencies: [],
  });

  // A root-level task is listed on the project file; ProjectTaskFile.create only
  // links nested ones into their parent.
  if (!destination.parentTask) {
    await new ProjectFile(app, destination.projectFilePath)
      .addTaskLink(id, title, basenameOf(file.filePath));
  }

  await deleteChecklistItem(app, sourcePath, item);
  return { taskId: id, projectId: destination.projectId };
}

async function createDestinationProject(
  app: App,
  title: string,
  projectsFolder: string,
): Promise<{ projectId: string; projectFilePath: string; projectTitle: string; parentTask?: Task }> {
  const { id, filePath } = await ProjectFile.create(app, { projectsFolder, title });
  return { projectId: id, projectFilePath: filePath, projectTitle: title };
}
