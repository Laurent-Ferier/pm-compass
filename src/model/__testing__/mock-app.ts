import { vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { asApp } from "./as-app";
import { bare } from "./bare";

/**
 * An in-memory vault good enough to exercise the file-mutating model code: frontmatter
 * round-trips through a real parse/serialize cycle, so tests assert on file content
 * rather than on mock call shapes. Callers must still `vi.mock("obsidian", …)` with a
 * `TFile` class, since `resolveFile` narrows with `instanceof TFile`.
 */

function tfile(path: string): TFile {
  const f = bare(TFile);
  Object.assign(f, {
    path,
    basename: path.split("/").pop()!.replace(/\.md$/, ""),
    extension: "md",
  });
  return f;
}

/** A folder holding the files sitting directly in it. Falls back to a bare marker for a
 *  test whose `vi.mock("obsidian", …)` supplies no `TFolder` — accessing a missing export
 *  throws, so the check has to be a `try`, and only code narrowing with `instanceof
 *  TFolder` needs the real thing. */
function tfolder(path: string, allPaths: string[]): TFolder | { path: string } {
  try {
    if (typeof TFolder !== "function") return { path };
  } catch {
    return { path };
  }
  const children = allPaths
    .filter((p) => p.slice(0, p.lastIndexOf("/")) === path)
    .map(tfile);
  const f = bare(TFolder);
  Object.assign(f, { path, name: path.split("/").pop() ?? "", children });
  return f;
}

/**
 * Booleans and numbers must survive the round-trip unquoted: the vault reader
 * gates on `fm["pm-task"] === true`, so a mock that stringified them would pass
 * tests that the real `processFrontMatter` — which preserves types — would fail.
 */
function parseScalar(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  return val.replace(/^"(.*)"$/, "$1");
}

function serializeScalar(v: unknown): string {
  return typeof v === "boolean" || typeof v === "number" ? String(v) : `"${String(v)}"`;
}

function parseFm(content: string): Record<string, unknown> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      fm[kv[1]] = inner ? inner.split(",").map((v) => v.trim().replace(/^"(.*)"$/, "$1")) : [];
    } else {
      fm[kv[1]] = parseScalar(val);
    }
  }
  return fm;
}

function serializeFm(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${x}"`).join(", ")}]`;
      return `${k}: ${serializeScalar(v)}`;
    })
    .join("\n");
}

/** `_files` is the backing store — read it to assert on final file contents;
 *  `_folders` holds the paths created via createFolder / ensureFolderRecursive. */
export function makeApp(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const folders = new Set<string>();

  const vault = {
    createFolder: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    getAbstractFileByPath: vi.fn((path: string) => {
      if (files.has(path)) return tfile(path);
      // A TFolder rather than a bare marker, so code walking `children` — the vault
      // reader, the unlink pass — sees what Obsidian would hand it.
      return folders.has(path) ? tfolder(path, [...files.keys()]) : null;
    }),
    getFileByPath: vi.fn((path: string) => (files.has(path) ? tfile(path) : null)),
    create: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return tfile(path);
    }),
    read: vi.fn(async (file: TFile) => files.get(file.path) ?? ""),
    cachedRead: vi.fn(async (file: TFile) => files.get(file.path) ?? ""),
    modify: vi.fn(async (file: TFile, content: string) => {
      files.set(file.path, content);
    }),
    /** Obsidian's atomic read-modify-write: the callback sees the content as it stands. */
    process: vi.fn(async (file: TFile, fn: (data: string) => string) => {
      const next = fn(files.get(file.path) ?? "");
      files.set(file.path, next);
      return next;
    }),
    delete: vi.fn(async (file: TFile) => {
      files.delete(file.path);
    }),
  };

  const fileManager = {
    processFrontMatter: vi.fn(async (file: TFile, cb: (fm: Record<string, unknown>) => void) => {
      const content = files.get(file.path) ?? "";
      const fm = parseFm(content);
      cb(fm);
      const rest = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
      files.set(file.path, `---\n${serializeFm(fm)}\n---\n${rest}`);
    }),
    renameFile: vi.fn(async (file: TFile, newPath: string) => {
      const content = files.get(file.path);
      if (content === undefined) return;
      files.delete(file.path);
      files.set(newPath, content);
    }),
    trashFile: vi.fn(async (file: TFile) => {
      files.delete(file.path);
    }),
  };

  const metadataCache = {
    getFileCache: vi.fn((file: TFile) => {
      const content = files.get(file.path);
      if (!content) return null;
      return { frontmatter: parseFm(content) };
    }),
  };

  return asApp({ vault, fileManager, metadataCache, _files: files, _folders: folders });
}
