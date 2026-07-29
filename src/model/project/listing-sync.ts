import { App } from "obsidian";
import { asFrontmatterRecord, resolveFile, splitFrontmatterBody } from "../operations/file-helpers";
import { ProjectFile } from "./project-file";
import { ProjectTaskFile } from "./project-task-file";
import { Frontmatter } from "./frontmatter";

/**
 * Puts a note that just changed and the checklists it takes part in back in step. The
 * direction follows which note changed, the event saying only that it was reparsed: a
 * listing drives the tasks it names, a task the line that lists it, a task with subtasks
 * both. Neither writes when nothing moved, which stops the two waking each other forever.
 *
 * `verified` holds the listings known to agree with their tasks (see `applyChildBoxes`);
 * others are repaired and join it. `data` is the event's own content, so nothing is re-read.
 */
export async function syncChangedNote(
  app: App, verified: Set<string>, filePath: string, data: string,
): Promise<void> {
  const file = resolveFile(app, filePath);
  if (!file) return;
  const fm = asFrontmatterRecord(app.metadataCache.getFileCache(file)?.frontmatter);
  const isTask = fm?.[Frontmatter.IsTask] === true;
  const isProject = fm?.[Frontmatter.IsProject] === true;
  if (!isTask && !isProject) return;

  const { body } = splitFrontmatterBody(data);
  if (isTask) await new ProjectTaskFile(app, filePath).pushToListing(data);

  const note = isProject ? new ProjectFile(app, filePath) : new ProjectTaskFile(app, filePath);
  if (verified.has(filePath)) {
    await note.applyChildBoxes(body);
    return;
  }
  await note.repairChildBoxes(body);
  verified.add(filePath);
}
