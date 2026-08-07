import type { IModel } from "./i-model";

/** What a model tells that it has changed: the store holding it, which gathers a burst of
 *  tellings into the one a view hears. */
export interface ModelStore {
  changed(model: IModel): void;
}

/** What a model needs of the file under it: where it reads from, and the right to be woken
 *  by it. Named here rather than taken from `BaseFile` so the model layer says what it uses
 *  of the IO layer, not which class provides it. */
export interface ModelFile {
  readonly filePath: string;
  attach(model: IModel): void;
  detach(model: IModel): void;
}

/**
 * What the plugin makes of one note, and where that reading is kept.
 *
 * The file underneath is the vault: it reads the note and wakes the models over it when the
 * text has moved. A model takes that reading into state of its own — so what the plugin
 * passes around is a live object rather than a copy that falls behind — and tells its store,
 * which is what a view is listening to.
 *
 * `reload` is the only thing a subclass has to answer: what the file now says, taken in, and
 * whether it moved anything. A re-read that lands the same state wakes no view.
 */
export abstract class BaseModel<NoteFile extends ModelFile> implements IModel {
  /** Whether the file behind it has gone. */
  private gone = false;

  constructor(readonly persistence: NoteFile, protected readonly store: ModelStore) {
    persistence.attach(this);
  }

  abstract get id(): string;

  get filePath(): string {
    return this.persistence.filePath;
  }

  /** The file has been read again. */
  refresh(): void {
    if (this.reload()) this.store.changed(this);
  }

  /** Takes the file's reading into this model's own state, and says whether that moved
   *  anything a view would draw differently. */
  protected abstract reload(): boolean;

  /** The file is gone. What this model holds is the last thing it said. */
  discard(): void {
    if (this.gone) return;
    this.gone = true;
    this.persistence.detach(this);
    this.store.changed(this);
  }

  get isGone(): boolean {
    return this.gone;
  }
}
