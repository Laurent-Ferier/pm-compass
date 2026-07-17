import { vi } from "vitest";
import { TFile } from "obsidian";

/**
 * An in-memory vault good enough to exercise the file-mutating model code:
 * frontmatter round-trips through a real parse/serialize cycle, so tests assert
 * on resulting file content rather than on mock call shapes.
 *
 * Callers must still `vi.mock("obsidian", …)` with a `TFile` class — file
 * objects are built against whatever that mock provides, because `resolveFile`
 * narrows with `instanceof TFile`.
 */

function tfile(path: string): TFile {
  const f: TFile = Object.create(TFile.prototype);
  Object.assign(f, {
    path,
    basename: path.split("/").pop()!.replace(/\.md$/, ""),
    extension: "md",
  });
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
  return typeof v === "boolean" || typeof v === "number" ? String(v) : `"${v}"`;
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

export interface MockApp {
  vault: Record<string, ReturnType<typeof vi.fn>>;
  fileManager: Record<string, ReturnType<typeof vi.fn>>;
  metadataCache: Record<string, ReturnType<typeof vi.fn>>;
  /** The backing store — read it to assert on final file contents. */
  _files: Map<string, string>;
  /** Folder paths created via createFolder / ensureFolderRecursive. */
  _folders: Set<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeApp(initialFiles: Record<string, string> = {}): any {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const folders = new Set<string>();

  const vault = {
    createFolder: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    getAbstractFileByPath: vi.fn((path: string) =>
      files.has(path) ? tfile(path) : folders.has(path) ? { path } : null,
    ),
    getFileByPath: vi.fn((path: string) => (files.has(path) ? tfile(path) : null)),
    create: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return tfile(path);
    }),
    read: vi.fn(async (file: TFile) => files.get(file.path) ?? ""),
    modify: vi.fn(async (file: TFile, content: string) => {
      files.set(file.path, content);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { vault, fileManager, metadataCache, _files: files, _folders: folders } as unknown as any;
}
