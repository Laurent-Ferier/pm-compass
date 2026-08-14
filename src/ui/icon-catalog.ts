/**
 * What narrows the picker's icons tab. A glyph answers to its own name and to the words
 * Lucide gives it, so `launch` finds `rocket` — the emoji tab has answered to what a glyph
 * stands for since it was written, and a grid of well over a thousand names needs it more.
 *
 * The words are matched as fragments, as the emoji's are, so `plan` finds `planning`.
 *
 * The table is a hundred kilobytes nothing but the picker reads, so it is imported when
 * `loadIconWords()` is called rather than at the top of this file: everything the plugin does
 * before somebody opens the picker is spared reading it. Until it has been read a glyph
 * answers to its own name alone.
 */

/** name → its words, which is the table's own shape. */
let words: Map<string, string> | undefined;

/** Reads the table in, once, and hands back once it is there to be searched. */
export async function loadIconWords(): Promise<void> {
  words ??= new Map((await import("./lucide-keywords")).LUCIDE_KEYWORDS);
}

/**
 * The names of `names` that answer to `query`, those bearing it in their own name first —
 * what somebody typing a name is after, before the glyphs that merely stand for it. Order
 * is otherwise the one given, and an empty query is `names` as given.
 *
 * A name is asked for its own spelling before its words, which spares the table the needle
 * a name already answers.
 */
export function matchingIconNames(names: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return names;
  const bearing: string[] = [];
  const standing: string[] = [];
  for (const name of names) {
    if (name.includes(needle)) bearing.push(name);
    else if (words?.get(name)?.includes(needle)) standing.push(name);
  }
  return [...bearing, ...standing];
}
