import { FrontMatterCache, TFile } from "obsidian";
import { ProjectTask, type ProjectTaskFields } from "../project/project-task";
import type { IModel } from "../i-model";
import { FileStore } from "./file-store";
import type { VaultData } from "../service/vault-data";
// Mutual: this store is made by the project store, and reads what that one has claimed.
import type { ProjectStore } from "./project-store";
import { ProjectTaskIO, parseTask } from "../io/project-task-io";

/**
 * The projects folder's task notes, held as they were last parsed. It reads what the project
 * note store has left: a note that store claimed is one this one leaves unopened, which is
 * why `VaultData` reads the projects first.
 *
 * The only place a `ProjectTask` or a `ProjectTaskIO` is made: everything else asks for one.
 */
export class ProjectTaskStore extends FileStore<ProjectTaskFields, ProjectTaskIO, ProjectTask> {
  constructor(vault: VaultData, folder: string, private readonly projects: ProjectStore) {
    super(vault, folder);
  }

  protected parseFields(file: TFile, fm: FrontMatterCache): ProjectTaskFields | null {
    return parseTask(file, fm);
  }

  protected makeFile(filePath: string): ProjectTaskIO {
    return new ProjectTaskIO(this.key, this, this.vault, filePath);
  }

  protected wrap(file: ProjectTaskIO, fields: ProjectTaskFields): ProjectTask {
    return new ProjectTask(this.key, file, this, fields);
  }

  /**
   * A task over a note of its own, filled from those fields and left out of the folder —
   * so two of them over the same path stay separate readings. The one way to build a task
   * the folder didn't read, which is what a test wants and nothing in the plugin does.
   */
  make(fields: ProjectTaskFields): ProjectTask {
    const file = new ProjectTaskIO(this.key, this, this.vault, fields.filePath);
    return new ProjectTask(this.key, file, this, fields);
  }

  /** The projects are read first, so a note one of them parsed as is one this pass can
   *  leave unopened. */
  protected override claimedElsewhere(path: string): boolean {
    return this.projects.holds(path);
  }

  /** The project half watches the folder for both and tells the views once, marking this
   *  one as it goes — so nothing is ever gathered here to tell. */
  protected announce(): void {}

  /** A task saying it now reads differently is filed on the half that does the telling,
   *  which would otherwise gather it here and never say so. */
  override changed(model: IModel): void {
    this.projects.changed(model);
  }

  /** A re-read a task note owes is asked of that same half, which marks this one on its way
   *  through — so the note is re-read and the views hear about it. */
  override invalidate(path: string): void {
    this.projects.invalidate(path);
  }

  /** Every task note in the folder, re-reading whatever has changed. Repeated calls hand
   *  back the same array until something does. */
  data(): Promise<ProjectTask[]> {
    return this.entries();
  }
}
