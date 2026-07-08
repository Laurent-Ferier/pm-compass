import { App, TFile } from "obsidian";

/** Resolve a vault-relative path to its TFile, or null if it doesn't exist / isn't a file. */
export function resolveFile(app: App, filePath: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(filePath);
  return f instanceof TFile ? f : null;
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

/** Vault-relative path -> filename without its directory or `.md` extension. */
export function basenameOf(filePath: string): string {
  return filePath.split("/").pop()!.replace(/\.md$/, "");
}
