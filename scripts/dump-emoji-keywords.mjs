#!/usr/bin/env node
/**
 * Refresh the emoji the picker offers, which `src/ui/emoji-catalog.ts` reads from
 * `src/ui/emoji-keywords.ts`.
 *
 * Usage:  node scripts/dump-emoji-keywords.mjs [emojibase-data version]
 *
 * The emoji, the drawers they sit in and the words they answer to are Unicode's own, by way
 * of the `emojibase-data` package on unpkg: the CLDR label and the CLDR keywords, under the
 * groups the standard files them in.
 *
 * Two departures from the standard, both about what a project's icon is for:
 *
 * - Flags and the invisible components (skin tones, joiners) are left out. A flag names no
 *   project, and a component draws nothing on its own.
 * - The drawers are ordered by what a project is likely to want, not by Unicode's order,
 *   which opens on smileys — see `GROUPS` below. The picker draws the first drawers it can
 *   fit, so the order decides what somebody sees before typing.
 *
 * A word the label already carries is dropped: the label is searched too.
 *
 * The drawers come out as a table each, in the order they are drawn — the shape the picker
 * reads them in.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "emoji-keywords.ts");

/** The drawers, in the order the picker draws them, each naming the Unicode groups it holds.
 *  A group given with a `subgroup` is that slice of it alone: of group 9, the flags, only
 *  subgroup 97 — `other flags`, the chequered flag and its kin — marks a milestone, where the
 *  country flags beside it name no project. */
const GROUPS = [
  { name: "Objects", holds: [{ group: 7 }] },
  { name: "Travel and places", holds: [{ group: 5 }] },
  { name: "Activities", holds: [{ group: 6 }] },
  { name: "Animals and nature", holds: [{ group: 3 }] },
  { name: "Food and drink", holds: [{ group: 4 }] },
  { name: "Symbols", holds: [{ group: 8 }, { group: 9, subgroup: 97 }] },
  { name: "Smileys and emotion", holds: [{ group: 0 }] },
  { name: "People and body", holds: [{ group: 1 }] },
];

/** Whether an emoji is one of the `holds` entry's — the whole group, or the one subgroup. */
const held = (emoji, of) =>
  emoji.group === of.group && (of.subgroup === undefined || emoji.subgroup === of.subgroup);

const version = process.argv[2] ?? "latest";
const url = `https://unpkg.com/emojibase-data@${version}/en/data.json`;

const response = await fetch(url);
if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`);
// unpkg redirects `latest` to the version it resolved, which is what the header records.
const resolved = /emojibase-data@([^/]+)/.exec(response.url)?.[1] ?? version;
const emoji = await response.json();

const words = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const SELECTOR = "️";

/**
 * The glyph as a note should carry it. emojibase spells every one in its emoji presentation,
 * variation selector and all; a character already drawn as an emoji needs none, and dropping
 * it is what keeps `📋` here the same string as the clipboard a project is created with.
 *
 * Only a lone character loses it. `type: 0` is a character drawn as text unless asked
 * otherwise, and a joined sequence — 👨‍⚕️, 🏳️‍⚧️ — is only the sequence Unicode lists with
 * the selector in place; without it, nothing promises it draws as one glyph.
 */
const glyphOf = (e) => {
  const lone = [...e.emoji].length === 2 && e.emoji.endsWith(SELECTOR);
  return e.type === 1 && lone ? e.emoji.slice(0, -SELECTOR.length) : e.emoji;
};

let count = 0;
const drawers = GROUPS.map((drawer) => {
  const holds = emoji
    .filter((e) => e.emoji && drawer.holds.some((of) => held(e, of)))
    .sort((a, b) => a.order - b.order);
  count += holds.length;
  const entries = holds.map((e) => {
    // The label as one word, so a cell can say it and a search still reads through it.
    const label = words(e.label).join("-");
    const tags = (e.tags ?? []).flatMap(words).filter((w) => !label.includes(w));
    return `    [${JSON.stringify(glyphOf(e))}, ${JSON.stringify([label, ...new Set(tags)].join(" "))}],`;
  });
  return `  { name: ${JSON.stringify(drawer.name)}, entries: [\n${entries.join("\n")}\n  ] },`;
});
if (count < 500) throw new Error(`only ${count} emoji — the extraction is off`);

writeFileSync(OUT, `/**
 * The emoji a project's icon can be chosen from, in the drawers the picker draws them under
 * and the order it draws them in. An entry is the glyph and the words it answers to: its
 * label first, as one word, then Unicode's keywords for it, all lowercase.
 *
 * Generated from emojibase-data ${resolved} by scripts/dump-emoji-keywords.mjs. Do not edit.
 */
export interface EmojiDrawer {
  name: string;
  entries: [glyph: string, words: string][];
}

export const EMOJI_DRAWERS: EmojiDrawer[] = [
${drawers.join("\n")}
];
`);
console.log(`${count} emoji in ${GROUPS.length} drawers, from emojibase-data ${resolved} → ${OUT}`);
