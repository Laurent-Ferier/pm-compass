import type { App } from "obsidian";
import { TFile } from "obsidian";
import { asApp } from "./as-app";
import { asVault } from "./as-vault";
import { bare } from "./bare";
import { TaskIO, type NoteIOs } from "../io/task-io";
import type { TaskFileStore } from "../store/task-file-store";

/**
 * The day notes' files over an app, as `TaskFileStore` would hold them: one `TaskIO` per path,
 * kept, over a store that only records the re-reads a write owes it. `invalidated` is those
 * paths, for a test asserting a write said so.
 */
export function noteFilesOf(app: App) {
  const invalidated: string[] = [];
  const store = {
    invalidate: (paths: string[]) => invalidated.push(...paths),
    // What `DayNoteService.ensure` reads the file it made into. A pass only ever asks the
    // note where it is, so the path standing in for one is all these tests need.
    day: (_date: Date, filePath?: string) => Promise.resolve({ path: filePath }),
  } as unknown as TaskFileStore;
  const vault = Object.assign(asVault(app), { tasks: { notes: store } });
  const kept = new Map<string, TaskIO>();
  const files: NoteIOs = {
    vault,
    file(filePath: string): TaskIO {
      const held = kept.get(filePath) ?? new TaskIO(store, vault, filePath);
      kept.set(filePath, held);
      return held;
    },
  };
  return Object.assign(files, { invalidated });
}

/**
 * An in-memory vault over plain file contents — all the line operations need, which read and
 * write whole files and look at nothing else. `store` is the backing map, to assert on final
 * content; `writes` is every path written, which lets a test assert a no-op wrote nothing;
 * `files` is the notes over it, for the passes that go through one.
 *
 * Callers must still `vi.mock("obsidian", …)` with a `TFile` class: `resolveFile` narrows
 * with `instanceof TFile`.
 */
export function makeDayVault(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  const writes: string[] = [];

  const vaultFile = (path: string) => {
    const f = bare(TFile);
    Object.assign(f, { path });
    return f;
  };

  const app = asApp({
    vault: {
      getAbstractFileByPath: (path: string) => (store.has(path) ? vaultFile(path) : null),
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        writes.push(file.path);
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        writes.push(path);
        store.set(path, content);
        return vaultFile(path);
      },
    },
  });
  return { app, store, writes, files: noteFilesOf(app) };
}
