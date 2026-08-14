import type { EmojiDrawer } from "./emoji-keywords";

/**
 * The emoji a project's icon can be chosen from, in the drawers the picker draws them under,
 * each entry with the words it answers to: Unicode's own label and keywords, as
 * `emoji-keywords.ts` has them. A glyph appears once, and its words are matched as fragments,
 * so `plan` finds `planning` — the same search the icons tab does over Lucide's words, over
 * the same joined string, which is why neither pays to take one apart.
 *
 * The table is a hundred kilobytes nothing but the picker reads, so it is imported when
 * `loadEmojiDrawers()` is called rather than at the top of this file: everything the plugin
 * does before somebody opens the picker is spared reading it. Until it has been read there
 * are no drawers to offer, which is what `emojiGroups()` says.
 */

export type { EmojiDrawer };

let drawers: EmojiDrawer[] = [];

/** Reads the table in, once, and hands back once it is there to be searched. */
export async function loadEmojiDrawers(): Promise<void> {
  if (!drawers.length) drawers = (await import("./emoji-keywords")).EMOJI_DRAWERS;
}

/** Every drawer, in the order the picker draws them: the table as generated, or none of it
 *  before `loadEmojiDrawers()` has read it in. */
export function emojiGroups(): EmojiDrawer[] {
  return drawers;
}

/**
 * The drawers whose entries answer to `query`, each cut to the entries that do — a drawer
 * matched by its own name keeps all of them, so `travel` shows the travel drawer whole.
 * An empty query is every drawer as written.
 */
export function matchingEmojiGroups(query: string): EmojiDrawer[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return drawers;
  return drawers.flatMap((drawer) => {
    if (drawer.name.toLowerCase().includes(needle)) return [drawer];
    const entries = drawer.entries.filter(([, words]) => words.includes(needle));
    return entries.length ? [{ name: drawer.name, entries }] : [];
  });
}
