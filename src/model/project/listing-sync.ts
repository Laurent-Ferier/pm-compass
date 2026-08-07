import { asFrontmatterRecord, resolveFile } from "../operations/file-helpers";
import type { VaultData } from "../service/vault-data";
import { Frontmatter } from "./frontmatter";

/**
 * Puts a note and the checklists it takes part in back in step. The direction follows which
 * note it is: a listing drives the tasks it names, a task the line that lists it, a task with
 * subtasks both. Neither writes when nothing moved, which stops the two waking each other
 * forever.
 *
 * Driven by a path alone: the listing half is answered from what the note holds, and the task
 * half opens the file for the `Project:`/`Parent:` link naming where it is listed, which is
 * body text nobody holds a reading of.
 */
export async function syncChangedNote(vault: VaultData, filePath: string): Promise<void> {
  const file = resolveFile(vault.app, filePath);
  if (!file) return;
  const fm = asFrontmatterRecord(vault.app.metadataCache.getFileCache(file)?.frontmatter);
  const isTask = fm?.[Frontmatter.IsTask] === true;
  const isProject = fm?.[Frontmatter.IsProject] === true;
  if (!isTask && !isProject) return;

  if (isTask) await vault.projectTasks.file(filePath).pushToListing();

  const note = isProject ? vault.projects.file(filePath) : vault.projectTasks.file(filePath);
  await note.syncChildBoxes();
}
