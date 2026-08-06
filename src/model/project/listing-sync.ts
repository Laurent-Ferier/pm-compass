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
 * The listing half is answered from what the note holds, so this needs no text and no read of
 * its own — a caller with nothing but a path can drive it. `data` is the change event's own
 * content where there is one, and only spares the task half a read of its body: the
 * `Project:`/`Parent:` link naming where a task is listed is still body text nobody holds.
 */
export async function syncChangedNote(
  vault: VaultData, verified: Set<string>, filePath: string, data?: string,
): Promise<void> {
  const file = resolveFile(vault.app, filePath);
  if (!file) return;
  const fm = asFrontmatterRecord(vault.app.metadataCache.getFileCache(file)?.frontmatter);
  const isTask = fm?.[Frontmatter.IsTask] === true;
  const isProject = fm?.[Frontmatter.IsProject] === true;
  if (!isTask && !isProject) return;

  if (isTask) await vault.taskNotes.note(filePath).pushToListing(data);

  const note = isProject ? vault.projectNotes.note(filePath) : vault.taskNotes.note(filePath);
  if (verified.has(filePath)) {
    await note.applyChildBoxes();
    return;
  }
  await note.repairChildBoxes();
  verified.add(filePath);
}
