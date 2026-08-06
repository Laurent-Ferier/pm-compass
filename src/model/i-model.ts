/**
 * What a note wakes when the file under it moves — the model layer's whole surface to the
 * IO layer below it, which is why this imports nothing.
 *
 * A note holds none of what it says; the models attached to it do. So the note reads, and
 * the models take what it now says: `refresh` when the file has changed, `discard` when it
 * is gone.
 */
export interface IModel {
  /** What names this model — its note's `id`, or the path for a note carrying none. */
  readonly id: string;

  /** The note it reads from. Null for a reading parsed out of no note, which nothing can
   *  act on and nothing wakes. */
  readonly filePath: string | null;

  /** The note has been read again: take what it now says. Only ever called for a reading
   *  that actually moved. */
  refresh(): void;

  /** The note is gone. What the model holds stands, and nothing will change it again. */
  discard(): void;
}
