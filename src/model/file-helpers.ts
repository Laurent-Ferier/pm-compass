import { App, TFile, normalizePath } from "obsidian";

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

/** Generates a 16-char lowercase hex ID with 64 bits of cryptographic randomness. */
export function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Turns a title into a filename-safe slug: only the characters a filesystem refuses give
 *  way, and everything else — apostrophes, accents, any script — is kept. obsidian-pm names
 *  its notes by this same rule, and a note it doesn't recognise as its task's own it writes
 *  a second copy of. */
function slugify(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]/g, "-")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

/**
 * A free `<folder>/<title>.md` path for a note called `title`, suffixing the head of `id` on
 * collision — the one other name obsidian-pm reads as that task's own. `untitled` names the
 * file when the title slugs to nothing — what the note is, `"task"` or `"project"`, since the
 * person's own words didn't survive.
 *
 * `taken` reserves paths not on disk yet, so a batch of moves can allocate every destination
 * up front and two moving siblings can't both claim the same name.
 */
export function uniquePathIn(
  app: App,
  folder: string,
  title: string,
  untitled: string,
  id: string,
  taken?: Set<string>,
): string {
  const slug = slugify(title) || untitled;
  const isFree = (p: string) => !app.vault.getAbstractFileByPath(p) && !taken?.has(p);
  const at = (name: string) => normalizePath(`${folder}/${name}.md`);
  let candidate = at(slug);
  if (!isFree(candidate)) {
    // Two notes of one title, the second bearing its own id. A third would have to be a
    // collision on the id as well, and counts from there.
    const owned = `${slug}-${id.slice(0, 8)}`;
    candidate = at(owned);
    for (let counter = 2; !isFree(candidate); counter++) candidate = at(`${owned}-${counter}`);
  }
  taken?.add(candidate);
  return candidate;
}

/** Vault-relative path -> filename without its directory or `.md` extension. */
export function basenameOf(filePath: string): string {
  return filePath.split("/").pop()!.replace(/\.md$/, "");
}
