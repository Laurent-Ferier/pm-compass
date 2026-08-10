import { vi } from "vitest";
import { TFile, TFolder, type HeadingCache, type LinkCache, type ListItemCache } from "obsidian";
import { asApp } from "./as-app";
import { bare } from "./bare";

/**
 * An in-memory vault good enough to exercise the file-mutating model code: frontmatter
 * round-trips through a real parse/serialize cycle, so tests assert on file content
 * rather than on mock call shapes. Callers must still `vi.mock("obsidian", …)` with a
 * `TFile` class, since `resolveFile` narrows with `instanceof TFile`.
 */

function tfile(path: string): TFile {
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  const f = bare(TFile);
  Object.assign(f, {
    path,
    // Taken from the name rather than assumed `.md`: code filtering a folder's children
    // by extension has to see the attachments Obsidian would hand it too.
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : "",
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

/** One line's span, as Obsidian's cache positions everything: only the start matters here,
 *  and only its line and column are read. */
function at(line: number, col: number) {
  return { start: { line, col, offset: 0 }, end: { line, col, offset: 0 } };
}

/**
 * The structural half of Obsidian's file cache: headings, checklist items and wiki-links,
 * each positioned. Enough for code reading a note's shape rather than its text — a `##`
 * section's checklist, say — and no more; nothing here is a markdown parser.
 */
function parseStructure(content: string) {
  const headings: HeadingCache[] = [];
  const listItems: ListItemCache[] = [];
  const links: LinkCache[] = [];

  content.split("\n").forEach((line, number) => {
    const heading = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
    if (heading) headings.push({ heading: heading[2], level: heading[1].length, position: at(number, 0) });

    const item = /^([ \t]*)[-*+][ \t]+(?:\[(.)\][ \t]+)?/.exec(line);
    // `parent` is only ever read as "is this nested", so the line above is close enough.
    if (item) listItems.push({ task: item[2], parent: item[1] ? number - 1 : -number, position: at(number, item[1].length) });

    for (const link of line.matchAll(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g)) {
      links.push({
        link: link[1], displayText: link[2] ?? link[1], original: link[0], position: at(number, link.index),
      });
    }
  });

  return { headings, listItems, links };
}

/**
 * Obsidian's `on`/`offref` pair over a plain listener set, plus the `_emit` a test fires
 * events with. The ref it hands back is the registration itself, which is all `offref`
 * needs of it.
 */
function eventful() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  return {
    on: vi.fn((name: string, cb: (...args: never[]) => void) => {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(cb);
      return { name, cb };
    }),
    offref: vi.fn((ref: { name: string; cb: (...args: never[]) => void }) => {
      listeners.get(ref.name)?.delete(ref.cb);
    }),
    /** Fires one of Obsidian's events at whoever registered for it. */
    _emit: (name: string, ...args: unknown[]) => {
      for (const cb of [...(listeners.get(name) ?? [])]) (cb as (...a: unknown[]) => void)(...args);
    },
  };
}

/** `_files` is the backing map — read it to assert on final file contents;
 *  `_folders` holds the paths created via createFolder / ensureFolderRecursive.
 *  `vault._emit` and `metadataCache._emit` fire the vault events a watcher listens for. */
export function makeApp(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const folders = new Set<string>();

  const vault = {
    ...eventful(),
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
    ...eventful(),
    getFileCache: vi.fn((file: TFile) => {
      const content = files.get(file.path);
      if (!content) return null;
      return { frontmatter: parseFm(content), ...parseStructure(content) };
    }),
  };

  return asApp({ vault, fileManager, metadataCache, _files: files, _folders: folders });
}
