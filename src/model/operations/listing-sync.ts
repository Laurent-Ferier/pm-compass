import { App } from "obsidian";
import { asFrontmatterRecord, resolveFile, splitFrontmatterBody } from "./file-helpers";
import { ProjectFile } from "../project-file";
import { ProjectTaskFile } from "../project-task-file";

/**
 * Put a note that just changed and the checklists it takes part in back in step.
 *
 * The direction follows which note changed, not what moved inside it — the change
 * event only says the file was reparsed. A listing drives the tasks it names; a task
 * drives the line that lists it; a task with subtasks does both, to different files.
 * Neither direction writes when nothing moved, which is what keeps the two from
 * waking each other forever.
 *
 * `verified` holds the listings already known to agree with their tasks — see
 * `BaseNote.applyChildBoxes`. Others are repaired instead, and join the set.
 * `data` is the note's content as the event handed it over, so nothing is re-read.
 */
export async function syncChangedNote(
  app: App, verified: Set<string>, filePath: string, data: string,
): Promise<void> {
  const file = resolveFile(app, filePath);
  if (!file) return;
  const fm = asFrontmatterRecord(app.metadataCache.getFileCache(file)?.frontmatter);
  const isTask = fm?.["pm-task"] === true;
  const isProject = fm?.["pm-project"] === true;
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
