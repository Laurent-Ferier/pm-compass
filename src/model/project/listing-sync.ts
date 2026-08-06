import { asFrontmatterRecord, resolveFile } from "../operations/file-helpers";
import type { VaultData } from "../store/vault-data";
import { Frontmatter } from "./frontmatter";

/**
 * Puts a note and the checklists it takes part in back in step. The direction follows which
 * note it is: a listing drives the tasks it names, a task the line that lists it, a task with
 * subtasks both. Neither writes when nothing moved, which stops the two waking each other
 * forever.
 *
 * `verified` holds the listings known to agree with their tasks (see `applyChildBoxes`);
 * others are repaired and join it.
 *
 * Driven by a path alone: the listing half is answered from what the note holds, and the task
 * half opens the file for the `Project:`/`Parent:` link naming where it is listed, which is
 * body text nobody holds a reading of.
 */
export async function syncChangedNote(
  vault: VaultData, verified: Set<string>, filePath: string,
): Promise<void> {
  const file = resolveFile(vault.app, filePath);
  if (!file) return;
  const fm = asFrontmatterRecord(vault.app.metadataCache.getFileCache(file)?.frontmatter);
  const isTask = fm?.[Frontmatter.IsTask] === true;
  const isProject = fm?.[Frontmatter.IsProject] === true;
  if (!isTask && !isProject) return;

  if (isTask) await vault.taskNotes.note(filePath).pushToListing();

  const note = isProject ? vault.projectNotes.note(filePath) : vault.taskNotes.note(filePath);
  if (verified.has(filePath)) {
    await note.applyChildBoxes();
    return;
  }
  await note.repairChildBoxes();
  verified.add(filePath);
}
