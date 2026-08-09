import type { App } from "obsidian";
import { TFile } from "obsidian";
import { asApp } from "./as-app";
import { asVault } from "./as-vault";
import { bare } from "./bare";
import { TaskIO } from "../io/task-io";
import type { TaskFileCache } from "../cache/task-file-cache";

/**
 * The day notes' files over an app, as `TaskFileCache` would hold them: one `TaskIO` per path,
 * kept, over a cache that only records the re-reads a write owes it. `invalidated` is those
 * paths, for a test asserting a write said so.
 */
export function noteFilesOf(app: App) {
  const invalidated: string[] = [];
  const cache = {
    invalidate: (path: string) => invalidated.push(path),
    // What `DayNoteService.ensure` reads the file it made into. A pass only ever asks the
    // note where it is, so the path standing in for one is all these tests need.
    day: (_date: Date, filePath?: string) => Promise.resolve({ path: filePath }),
  } as unknown as TaskFileCache;
  const vault = Object.assign(asVault(app), { tasks: { cache } });
  const kept = new Map<string, TaskIO>();
  // Typed off the real cache, so the double stops compiling if what it stands for moves.
  const files: Pick<TaskFileCache, "vault" | "file"> = {
    vault,
    file(filePath: string): TaskIO {
      const held = kept.get(filePath) ?? new TaskIO(cache, vault, filePath);
      kept.set(filePath, held);
      return held;
    },
  };
  return Object.assign(files, { invalidated });
}

/**
 * An in-memory vault over plain file contents — all the line operations need, which read and
 * write whole files and look at nothing else. `contents` is the backing map, to assert on final
 * content; `writes` is every path written, which lets a test assert a no-op wrote nothing;
 * `files` is the notes over it, for the passes that go through one.
 *
 * Callers must still `vi.mock("obsidian", …)` with a `TFile` class: `resolveFile` narrows
 * with `instanceof TFile`.
 */
export function makeDayVault(initialFiles: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initialFiles));
  const writes: string[] = [];

  const vaultFile = (path: string) => {
    const f = bare(TFile);
    Object.assign(f, { path });
    return f;
  };

  const app = asApp({
    vault: {
      getAbstractFileByPath: (path: string) => (contents.has(path) ? vaultFile(path) : null),
      read: async (file: { path: string }) => contents.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        writes.push(file.path);
        contents.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        writes.push(path);
        contents.set(path, content);
        return vaultFile(path);
      },
    },
  });
  return { app, contents, writes, files: noteFilesOf(app) };
}
