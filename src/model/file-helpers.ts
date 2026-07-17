import { App, TFile, normalizePath } from "obsidian";

/** Resolve a vault-relative path to its TFile, or null if it doesn't exist / isn't a file. */
export function resolveFile(app: App, filePath: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(filePath);
  return f instanceof TFile ? f : null;
}

/**
 * Creates a vault folder along with any missing ancestor folders.
 * `vault.createFolder()` requires the parent to already exist, which throws
 * "Parent folder doesn't exist" for nested paths (e.g. "Journal/Daily") when
 * an intermediate segment hasn't been created/synced yet on a given device.
 */
export async function ensureFolderRecursive(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (app.vault.getAbstractFileByPath(current)) continue;
    try {
      await app.vault.createFolder(current);
    } catch (e) {
      // The existence check above can still lose to a folder that the vault
      // knows about but hasn't indexed yet; treat that as success and let any
      // other failure (permissions, invalid name) surface.
      if (!/already exists/i.test(String(e))) throw e;
    }
  }
}

/**
 * The auto-generated `Project: [[…]]` / `Parent: [[…]]` wiki-link that opens a
 * task file's body, with any trailing blank line. Task bodies are rewritten in
 * several places (edit, move) and the prefix must survive each one.
 */
export const BODY_PREFIX_RE = /^(?:Project|Parent): \[\[[^\]]+\]\]\n?\n?/;

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

/**
 * Picks a free `<folder>/<slug>.md` path, suffixing `-2`, `-3`… on collision.
 *
 * `taken` reserves paths that aren't on disk yet, so callers relocating several
 * files at once can allocate every destination up front without two of them
 * claiming the same name.
 */
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

// A leading BOM or blank line before the opening `---` is tolerated and kept in
// the captured block, so a file `processFrontMatter` just wrote to still round-
// trips through `splitFrontmatterBody` instead of its body edits being skipped.
const FRONTMATTER_BLOCK = /^\s*---[\s\S]*?\n---\n?/;

/**
 * Splits raw markdown file content into its frontmatter block (including the
 * `---` delimiters, or "" if absent) and everything after it.
 */
export function splitFrontmatterBody(raw: string): { frontmatterBlock: string; body: string } {
  const match = raw.match(FRONTMATTER_BLOCK);
  return {
    frontmatterBlock: match ? match[0] : "",
    body: match ? raw.slice(match[0].length) : "",
  };
}

/** Stamps `updatedAt` on a frontmatter object with the current time. */
export function touch(fm: Record<string, unknown>): void {
  fm["updatedAt"] = new Date().toISOString();
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
