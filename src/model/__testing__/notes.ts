import type { App } from "obsidian";
import type { ProjectTask, ProjectTaskFields } from "../project/project-task";
import type { Project, ProjectFields } from "../project/project";
import type { VaultData } from "../service/vault-data";
import type { BaseIO, FileFields } from "../io/base-io";
import { ProjectService } from "../service/project-service";
import { emptyApp } from "./as-app";
import { asVault } from "./as-vault";
import { noteFilesOf } from "./day-vault";
import type { TaskService } from "../service/task-service";
import type { PMCompassSettings } from "../settings";

/**
 * The projects folder's own objects, for a test: a note and a task can only be made by the
 * store that holds them, so a test asks a store too rather than reaching for `new`.
 */

/**
 * The projects half of a `VaultData` — its project store, which holds both kinds of note. The
 * day half is left off bar the notes themselves, which a promotion writes to: a test that
 * wants a note or a task has no use for the rest, and standing the daily-notes machinery up
 * would pull it into every such test.
 */
export function notesOf(app: App, folder = "Projects"): VaultData {
  const vault = Object.assign(asVault(app), {
    settings: () => ({ projectsFolder: folder }) as PMCompassSettings,
  });
  const dayFiles = noteFilesOf(app);
  // The service builds the store under it, as it does on a real vault, so a write made
  // through one is read back through the other.
  const service = new ProjectService(vault);
  const projects = service.notes;
  // What a note's own `markStale` reaches, minus telling the views: the telling is scheduled
  // through a `window` these tests don't stand up. Both halves, since the task store asks
  // this one. Marked on the instance, the store being the real one the files are made by.
  projects.invalidate = (paths: string[]) => {
    for (const path of paths) {
      projects.touch(path, true);
      projects.projectTasks.touch(path, true);
    }
  };
  return Object.assign(vault, {
    projects: service,
    // Only the day notes' files, which is all a write reaching across the two halves takes.
    tasks: { notes: dayFiles } as unknown as TaskService,
    // The folder read whole, relationships and all — what the store asks for when a write
    // of the plugin's own leaves it a read it owes.
    load: async () => {
      const store = await projects.load();
      store.link(store.tasks);
      projects.projectTasks.link(store.tasks);
      return store;
    },
  });
}

/** A vault with nothing behind it, for the many tests that want a `ProjectTask` and nothing else
 *  the folder holds. */
const detached = notesOf(emptyApp());

/** A task built from fields, as a store would have read it. */
export function newTask(fields: ProjectTaskFields): ProjectTask {
  return detached.projects.taskNotes.make(fields);
}

/** A project built from fields, as a store would have read it. */
export function newProject(fields: ProjectFields): Project {
  return detached.projects.notes.make(fields);
}

/** Another task's reading with some of it replaced — the tests' way of varying one field. */
export function withFields(task: ProjectTask, overrides: Partial<ProjectTaskFields>): ProjectTask {
  return newTask({ ...task.toFields(), ...overrides });
}

/** A field set on a note and written — the two steps a call site takes, in one, for a test
 *  that only wants the file to say the new thing. */
export function setField<Fields extends FileFields, K extends keyof Fields>(
  note: BaseIO<Fields>, field: K, value: Fields[K],
): Promise<void> {
  note.set(field, value);
  return note.flush();
}

/** Several fields set at once, which is one pass over the file. */
export function setFields<Fields extends FileFields>(note: BaseIO<Fields>, values: Partial<Fields>): Promise<void> {
  for (const [field, value] of Object.entries(values)) note.set(field as keyof Fields, value as Fields[keyof Fields]);
  return note.flush();
}
