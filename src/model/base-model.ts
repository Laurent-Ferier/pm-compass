import type { IModel, NoteModel } from "./i-model";
import { sameFields, sameValue } from "./io/base-io";

/** What a model tells that it has changed: the store holding it, which gathers a burst of
 *  tellings into the one a view hears. */
export interface ModelStore {
  changed(model: IModel): void;
}

/** What a model needs of the file under it: where it reads from, and the right to be woken
 *  by it. Named here rather than taken from `BaseIO` so the model layer says what it uses
 *  of the IO layer, not which class provides it. */
export interface ModelIO<Fields> {
  readonly filePath: string;
  attachNote(model: NoteModel<Fields>): void;
  detach(model: IModel): void;
}

/**
 * What the plugin makes of one note, and where that reading is kept.
 *
 * The file underneath is the vault: it reads the note and hands what it read to the model
 * over it, which is where that reading is kept — so what the plugin passes around is a live
 * object rather than a copy that falls behind. The model then tells its store, which is what
 * a view is listening to.
 *
 * Every field the note has is here and nowhere else. A re-read landing what this already
 * holds is Obsidian repeating itself, or the plugin's own write coming back, and neither is
 * anything a view has to be told about — which is what `take` answers.
 */
export abstract class BaseModel<NoteIO extends ModelIO<Fields>, Fields extends object>
implements NoteModel<Fields> {
  /** What its file reads as, and the only copy of it. */
  protected state: Fields;
  /** Whether the file behind it has gone. */
  private gone = false;

  constructor(readonly persistence: NoteIO, protected readonly store: ModelStore, fields: Fields) {
    this.state = fields;
    persistence.attachNote(this);
  }

  /** The reading its file has just taken, kept whole, and whether that moved anything a view
   *  would draw differently. */
  take(fields: Fields): boolean {
    const moved = !sameFields(this.state, fields);
    this.state = fields;
    if (moved) this.refresh();
    return moved;
  }

  /** One field the vault already holds, taken onto the reading so a render before the next
   *  read draws what was just written. Tells nobody: the re-read that follows a write of the
   *  plugin's own then lands what the reading already says. */
  protected put<K extends keyof Fields>(field: K, value: Fields[K]): boolean {
    if (sameValue(this.state[field], value)) return false;
    this.state = { ...this.state, [field]: value };
    return true;
  }

  abstract get id(): string;

  get filePath(): string {
    return this.persistence.filePath;
  }

  /** What it holds has moved: the views are told, through the store that gathers a burst of
   *  tellings into one. */
  refresh(): void {
    this.store.changed(this);
  }

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
