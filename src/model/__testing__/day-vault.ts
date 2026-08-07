import { TFile } from "obsidian";
import { asApp } from "./as-app";
import { bare } from "./bare";

/**
 * An in-memory vault over plain file contents — all the line operations need, which read and
 * write whole files and look at nothing else. `store` is the backing map, to assert on final
 * content; `writes` is every path written, which lets a test assert a no-op wrote nothing.
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
  return { app, store, writes };
}
