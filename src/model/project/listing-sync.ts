import { asFrontmatterRecord, resolveFile, splitFrontmatterBody } from "../operations/file-helpers";
import type { VaultData } from "../store/vault-data";
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
  vault: VaultData, verified: Set<string>, filePath: string, data: string,
): Promise<void> {
  const file = resolveFile(vault.app, filePath);
  if (!file) return;
  const fm = asFrontmatterRecord(vault.app.metadataCache.getFileCache(file)?.frontmatter);
  const isTask = fm?.[Frontmatter.IsTask] === true;
  const isProject = fm?.[Frontmatter.IsProject] === true;
  if (!isTask && !isProject) return;

  const { body } = splitFrontmatterBody(data);
  if (isTask) await vault.taskNotes.note(filePath).pushToListing(data);

  const note = isProject ? vault.projectNotes.note(filePath) : vault.taskNotes.note(filePath);
  if (verified.has(filePath)) {
    await note.applyChildBoxes(body);
    return;
  }
  await note.repairChildBoxes(body);
  verified.add(filePath);
}
