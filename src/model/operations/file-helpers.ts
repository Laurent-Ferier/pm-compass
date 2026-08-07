import { App, TFile, normalizePath } from "obsidian";
import { Frontmatter } from "../project/frontmatter";

/** Resolve a vault-relative path to its TFile, or null if it doesn't exist / isn't a file. */
export function resolveFile(app: App, filePath: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(filePath);
  return f instanceof TFile ? f : null;
}

/** The folder a path sits in, or "" for one at the vault root. */
export function parentDirOf(filePath: string): string {
  const cut = filePath.lastIndexOf("/");
  return cut === -1 ? "" : filePath.slice(0, cut);
}

/** The note at `filePath`, created empty with its folders when absent. Null if that fails. */
export async function ensureNote(app: App, filePath: string): Promise<TFile | null> {
  const path = normalizePath(filePath);
  const existing = resolveFile(app, path);
  if (existing) return existing;

  try {
    const parentDir = parentDirOf(path);
    if (parentDir) await ensureFolderRecursive(app, parentDir);
    return await app.vault.create(path, "");
  } catch {
    // Another writer can win the race between the check and the create; anything else
    // leaves nothing to resolve, hence null.
    return resolveFile(app, path);
  }
}

/** Creates a folder with any missing ancestors — `vault.createFolder()` throws on a
 *  nested path whose intermediate segments don't exist yet. */
export async function ensureFolderRecursive(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (app.vault.getAbstractFileByPath(current)) continue;
    try {
      await app.vault.createFolder(current);
    } catch (e) {
      // The check above can lose to a folder the vault knows but hasn't indexed; that
      // counts as success, and any other failure surfaces.
      if (!/already exists/i.test(String(e))) throw e;
    }
  }
}

// ── One file at a time ───────────────────────────────────────────────────────

// Serializes read-modify-write per file path. Every pass over a note computes what to
// write from what it read, so two of them racing on one path clobber each other.
const fileLocks = new Map<string, Promise<unknown>>();

/** Runs `fn` only once any other pass over `filePath` has settled. The one lock there is:
 *  a second map, anywhere, and two passes over one path stop excluding each other. */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(filePath) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  fileLocks.set(
    filePath,
    settled.then(
      () => undefined,
      () => undefined,
    ),
  );
  return settled;
}

/** The file's lines, or none at all when it doesn't exist. */
export async function readFileLines(app: App, filePath: string): Promise<string[]> {
  const file = resolveFile(app, filePath);
  if (!file) return [];
  const content = await app.vault.read(file);
  return content.replace(/\r\n/g, "\n").split("\n");
}

/** Drops trailing blank lines, so an append lands right after the last line with anything
 *  on it. */
export function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

/** Writes `lines` over the file, creating it when it isn't there. */
export async function writeFileLines(app: App, filePath: string, lines: string[]): Promise<void> {
  const file = resolveFile(app, filePath);
  const text = lines.join("\n");
  if (file) {
    await app.vault.modify(file, text);
  } else {
    await app.vault.create(filePath, text);
  }
}

/** What a task body's opening wiki-link points at: the note that lists the task. */
export enum BodyPrefixKind {
  Project = "Project",
  Parent = "Parent",
}

/** The `Project: [[…]]` / `Parent: [[…]]` wiki-link opening a task body, with any
 *  trailing blank line. Group 1 is the kind, group 2 the linked basename. */
export const BODY_PREFIX_RE = new RegExp(
  `^(${BodyPrefixKind.Project}|${BodyPrefixKind.Parent}): \\[\\[([^\\]|]+)(?:\\|[^\\]]*)?\\]\\]\n?\n?`,
);

/** That same prefix written out, pointing at the note that lists the task: a parent task
 *  or the project itself. The one writer of what `BODY_PREFIX_RE` reads. */
export function bodyPrefix(
  listedIn: { filePath: string; title: string },
  kind: BodyPrefixKind,
): string {
  return `${kind}: [[${basenameOf(listedIn.filePath)}|${listedIn.title}]]`;
}

/** Generates a 16-char lowercase hex ID with 64 bits of cryptographic randomness. */
export function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Turns a title into a filename-safe slug. Non-ASCII characters are dropped. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

/** A free `<folder>/<slug>.md` path, suffixing `-2`, `-3`… on collision. `taken` reserves
 *  paths not on disk yet, so a batch of moves can allocate every destination up front. */
export function uniquePathIn(app: App, folder: string, slug: string, taken?: Set<string>): string {
  const isFree = (p: string) => !app.vault.getAbstractFileByPath(p) && !taken?.has(p);
  let candidate = normalizePath(`${folder}/${slug}.md`);
  let counter = 2;
  while (!isFree(candidate)) {
    candidate = normalizePath(`${folder}/${slug}-${counter}.md`);
    counter++;
  }
  taken?.add(candidate);
  return candidate;
}

// A leading BOM or blank line before the opening `---` is kept in the captured block, so
// a file `processFrontMatter` just wrote still round-trips through the split.
const FRONTMATTER_BLOCK = /^\s*---[\s\S]*?\n---\n?/;

/** Splits file content into its frontmatter block, delimiters included, and the rest. */
export function splitFrontmatterBody(raw: string): { frontmatterBlock: string; body: string } {
  const match = raw.match(FRONTMATTER_BLOCK);
  return {
    frontmatterBlock: match ? match[0] : "",
    body: match ? raw.slice(match[0].length) : "",
  };
}

/** Stamps `updatedAt` on a frontmatter object with the current time. */
export function touch(fm: Record<string, unknown>): void {
  fm[Frontmatter.UpdatedAt] = new Date().toISOString();
}

/** Narrows an unknown frontmatter value to a string array, dropping non-string entries. */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Types Obsidian's `any`-typed FrontMatterCache as a plain unknown-valued record. */
export function asFrontmatterRecord(value: unknown): Record<string, unknown> | undefined {
  return value as Record<string, unknown> | undefined;
}

/** Vault-relative path -> filename without its directory or `.md` extension. */
export function basenameOf(filePath: string): string {
  return filePath.split("/").pop()!.replace(/\.md$/, "");
}
