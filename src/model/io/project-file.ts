import { FrontMatterCache, TFile } from "obsidian";
import { type ProjectFields } from "../project/project";
import { Frontmatter, frontmatterTimestamp } from "../project/frontmatter";
import { PROJECT_TASK_SECTION } from "../project/child-links";
import { toCardLayout } from "../project/card-layout";
import { type FieldEdit } from "./base-file";
import { ListingFile } from "./listing-file";
import type { VaultData } from "../service/vault-data";
import type { StoreKey } from "../store/file-store";
// Mutual, but only for how the folder a project's tasks sit in is named, and for how a
// field is put on a file.
import { setOrClear, tasksFolderFor } from "./project-task-file";

/**
 * One note under the projects folder that is a project. `ProjectTaskFile` is the other kind
 * of note the folder holds.
 */

/**
 * The file behind one project note: where its frontmatter is held as it was last read, and
 * the typed operations that write it back. Lists its children as `ProjectTaskFile` does —
 * hence `ListingFile` — but only its root-level tasks.
 *
 * Built from a path when all that is wanted is to write to it; the store fills it once the
 * folder has been read. `Project` is what it reads as.
 *
 * Made by `ProjectStore` alone: its constructor takes the key only a store holds, and
 * `vault.projectNotes.file(path)` is how everything else gets one.
 */
export class ProjectFile extends ListingFile<ProjectFields> {
  constructor(_key: StoreKey, vault: VaultData, filePath: string) {
    super(vault, filePath);
  }

  /** The fields set on this project, onto its file in one pass. */
  protected async writeOwed(owed: readonly FieldEdit<ProjectFields>[]): Promise<void> {
    await this.editFrontmatter((fm) => {
      for (const { field, value } of owed) {
        switch (field) {
          case "title": fm[Frontmatter.Title] = value; break;
          case "color": setOrClear(fm, Frontmatter.Color, value); break;
          case "icon": setOrClear(fm, Frontmatter.Icon, value); break;
          // Only a real `true` puts a project away — see `parseProject`.
          case "archived": setOrClear(fm, Frontmatter.Archived, value === true || undefined); break;
          default: throw new Error(`Not a project's to set: ${String(field)}`);
        }
      }
    });
  }

  protected get childSection() {
    return PROJECT_TASK_SECTION;
  }

  protected get childFolder() {
    return tasksFolderFor(this.filePath);
  }

  /**
   * Read project metadata from the frontmatter.
   * Returns null when the file does not exist or has no frontmatter.
   */
  async readMetadata(): Promise<Pick<ProjectFields, "id" | "title" | "color" | "icon" | "archived"> | null> {
    const file = this.tfile;
    if (!file) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm || fm[Frontmatter.IsProject] !== true) return null;
    const id = String(fm[Frontmatter.Id] ?? "");
    if (!id) return null;
    return {
      id,
      title: String(fm[Frontmatter.Title] ?? file.basename),
      color: fm[Frontmatter.Color] ? String(fm[Frontmatter.Color]) : undefined,
      icon: fm[Frontmatter.Icon] ? String(fm[Frontmatter.Icon]) : undefined,
      archived: fm[Frontmatter.Archived] === true || undefined,
    };
  }

}

/**
 * One note's frontmatter read as the project it describes. A note not marked a project, or
 * missing the id that places it, names none and reads as null. The fields alone: the store
 * that asked builds the note around them.
 */
export function parseProject(file: TFile, fm: FrontMatterCache): ProjectFields | null {
  if (fm[Frontmatter.IsProject] !== true) return null;
  const id = String(fm[Frontmatter.Id] ?? "");
  if (!id) return null;
  return {
    id,
    title: String(fm[Frontmatter.Title] ?? file.basename),
    color: fm[Frontmatter.Color] ? String(fm[Frontmatter.Color]) : undefined,
    icon: fm[Frontmatter.Icon] ? String(fm[Frontmatter.Icon]) : undefined,
    // Read as the markers are: only a real `true` puts a project away.
    archived: fm[Frontmatter.Archived] === true || undefined,
    createdAt: frontmatterTimestamp(fm[Frontmatter.CreatedAt]),
    updatedAt: frontmatterTimestamp(fm[Frontmatter.UpdatedAt]),
    card: toCardLayout(fm[Frontmatter.CardLayout]),
    filePath: file.path,
  };
}
