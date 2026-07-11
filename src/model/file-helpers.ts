import { App, TFile } from "obsidian";

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
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

const FRONTMATTER_BLOCK = /^---[\s\S]*?\n---\n?/;

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
