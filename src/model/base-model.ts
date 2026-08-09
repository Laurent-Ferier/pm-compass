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
  flush(): Promise<void>;
}

/**
 * What one note reads as, and the keeping of it: the fields its file last handed over,
 * whether that file has gone, and the telling of both to the store.
 *
 * Held by the model over the note rather than inherited by it, because a reading has to name
 * the model it is of — what the file wakes and the store hears about — and a model can only
 * name itself once it exists. `BaseModel` holds one; so does `ProjectTask`, which could not
 * have inherited one anyway: it is a `BaseTask` first, so that it can share a list with a day
 * note's lines, and a class has only one parent to spend.
 */
export class NoteReading<NoteIO extends ModelIO<Fields>, Fields extends object> {
  /** What its file reads as, and the only copy of it. */
  private state: Fields;
  /** Whether the file behind it has gone. */
  private gone = false;
  constructor(
    readonly persistence: NoteIO,
    private readonly store: ModelStore,
    fields: Fields,
    /** The model this reading is of, which is what the file wakes and the store hears
     *  about — never the reading itself, which is nobody's to hold. */
    private readonly of: NoteModel<Fields>,
  ) {
    this.state = fields;
    persistence.attachNote(of);
  }

  /** The reading its file has just taken, kept whole, and whether that moved anything a view
   *  would draw differently. */
  take(fields: Fields): boolean {
    const moved = !sameFields(this.state, fields);
    this.state = fields;
    // The model's own refreshing, not this one's: what a reading moving means is the
    // model's to say, and a day note builds its rows before it tells anyone.
    if (moved) this.of.refresh();
    return moved;
  }

  /** One field the vault already holds, taken onto the reading so a render before the next
   *  read draws what was just written. Tells nobody: the re-read that follows a write of the
   *  plugin's own then lands what the reading already says. */
  put<K extends keyof Fields>(field: K, value: Fields[K]): boolean {
    if (sameValue(this.state[field], value)) return false;
    this.state = { ...this.state, [field]: value };
    return true;
  }

  /** What the file last said, for the model reading its own fields off it. */
  get fields(): Fields {
    return this.state;
  }

  /** The whole reading, replaced, telling nobody — for a model deciding for itself what
   *  counts as having moved, and when to say so. `take` is that decision made the usual way. */
  replace(fields: Fields): void {
    this.state = fields;
  }

  /** Everything set on this model, on its file. Rejects with whatever the write threw. */
  flush(): Promise<void> {
    return this.persistence.flush();
  }

  get filePath(): string {
    return this.persistence.filePath;
  }

  /** What it holds has moved: the views are told, through the store that gathers a burst of
   *  tellings into one. */
  refresh(): void {
    this.store.changed(this.of);
  }

  /** The file is gone. What this model holds is the last thing it said. */
  discard(): void {
    if (this.gone) return;
    this.gone = true;
    this.persistence.detach(this.of);
    this.store.changed(this.of);
  }

  get isGone(): boolean {
    return this.gone;
  }
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
  /** Held rather than inherited, as `ProjectTask` holds one: a reading needs to name the
   *  model it is of, and a model can only name itself once it exists. */
  private readonly note: NoteReading<NoteIO, Fields>;

  constructor(
    persistence: NoteIO,
    /** For a model that makes models of its own — a day note's lines have their own. What
     *  this model has to say for itself goes through `refresh`. */
    protected readonly store: ModelStore,
    fields: Fields,
  ) {
    this.note = new NoteReading(persistence, store, fields, this);
  }

  abstract get id(): string;

  get persistence(): NoteIO {
    return this.note.persistence;
  }

  /** What its file reads as. */
  protected get state(): Fields {
    return this.note.fields;
  }

  /** The whole reading, replaced, telling nobody — for a subclass overriding `take`. */
  protected replaceState(fields: Fields): void {
    this.note.replace(fields);
  }

  /** The reading its file has just taken, kept whole, and whether that moved anything a view
   *  would draw differently. */
  take(fields: Fields): boolean {
    return this.note.take(fields);
  }

  /** One field the vault already holds, taken onto the reading so a render before the next
   *  read draws what was just written. Tells nobody: the re-read that follows a write of the
   *  plugin's own then lands what the reading already says. */
  protected put<K extends keyof Fields>(field: K, value: Fields[K]): boolean {
    return this.note.put(field, value);
  }

  /** Everything set on this model, on its file. Rejects with whatever the write threw. */
  flush(): Promise<void> {
    return this.note.flush();
  }

  get filePath(): string {
    return this.note.filePath;
  }

  /** What it holds has moved: the views are told, through the store that gathers a burst of
   *  tellings into one. */
  refresh(): void {
    this.note.refresh();
  }

  /** The file is gone. What this model holds is the last thing it said. */
  discard(): void {
    this.note.discard();
  }

  get isGone(): boolean {
    return this.note.isGone;
  }
}
