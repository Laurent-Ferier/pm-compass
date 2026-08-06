import type { App } from "obsidian";
import type { ProjectTask, ProjectTaskFields } from "../project/project-task";
import type { Project, ProjectFields } from "../project/project";
import type { VaultData } from "../store/vault-data";
import type { BaseNote, NoteFields } from "../store/base-note";
import { ProjectNoteStore } from "../store/project-note-store";
import { emptyApp } from "./as-app";

/**
 * The projects folder's own objects, for a test: a note and a task can only be made by the
 * store that holds them, so a test asks a store too rather than reaching for `new`.
 */

/**
 * The projects half of a `VaultData` — its project store, which holds both kinds of note. The
 * day half is left off: a test that wants a note or a task has no use for it, and standing it
 * up would pull the daily-notes machinery into every such test.
 */
export function notesOf(app: App, folder = "Projects"): VaultData {
  const vault = { app } as VaultData;
  const projectNotes = new ProjectNoteStore(vault, folder);
  return Object.assign(vault, {
    projectNotes,
    taskNotes: projectNotes.taskNotes,
    // The folder read whole, relationships and all — what the store asks for when a write
    // of the plugin's own leaves it a read it owes.
    load: async () => {
      const store = await projectNotes.load();
      store.link(store.tasks);
      projectNotes.taskNotes.link(store.tasks);
      return store;
    },
    // What `VaultData` does with a write of the plugin's own, minus telling the views: a
    // note setting a field says so through here.
    invalidate: (paths: string[]) => {
      for (const path of paths) {
        projectNotes.touch(path, true);
        projectNotes.taskNotes.touch(path, true);
      }
    },
  });
}

/** A vault with nothing behind it, for the many tests that want a `ProjectTask` and nothing else
 *  the folder holds. */
const detached = notesOf(emptyApp());

/** A task built from fields, as a store would have read it. */
export function newTask(fields: ProjectTaskFields): ProjectTask {
  return detached.taskNotes.make(fields);
}

/** A project built from fields, as a store would have read it. */
export function newProject(fields: ProjectFields): Project {
  return detached.projectNotes.make(fields);
}

/** Another task's reading with some of it replaced — the tests' way of varying one field. */
export function withFields(task: ProjectTask, overrides: Partial<ProjectTaskFields>): ProjectTask {
  return newTask({ ...task.toFields(), ...overrides });
}

/** A field set on a note and written — the two steps a call site takes, in one, for a test
 *  that only wants the file to say the new thing. */
export function setField<Fields extends NoteFields, K extends keyof Fields>(
  note: BaseNote<Fields>, field: K, value: Fields[K],
): Promise<void> {
  note.set(field, value);
  return note.flush();
}

/** Several fields set at once, which is one pass over the file. */
export function setFields<Fields extends NoteFields>(note: BaseNote<Fields>, values: Partial<Fields>): Promise<void> {
  for (const [field, value] of Object.entries(values)) note.set(field as keyof Fields, value as Fields[keyof Fields]);
  return note.flush();
}
