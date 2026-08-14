#!/usr/bin/env node
/**
 * Refresh the words the icons tab of the picker searches, which `src/ui/icon-catalog.ts`
 * reads from `src/ui/lucide-keywords.ts`.
 *
 * Usage:  node scripts/dump-icon-keywords.mjs [lucide-static version]
 *
 * The words are Lucide's own tags, fetched from the `lucide-static` package on unpkg —
 * the table is not in Obsidian's bundle, which keeps the drawings alone. They are kept
 * for the names `src/ui/__testing__/obsidian-icon-ids.json` says Obsidian ships, so run
 * `dump-icon-ids.mjs` first after an Obsidian upgrade; a name Lucide has since renamed
 * simply ends up with no words, and is still found by its own name.
 *
 * A word the name already contains is dropped: the search reads the name too, so keeping
 * `folder` against `folder-open` would only cost bytes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const IDS = join(here, "..", "src", "ui", "__testing__", "obsidian-icon-ids.json");
const OUT = join(here, "..", "src", "ui", "lucide-keywords.ts");

const version = process.argv[2] ?? "latest";
const url = `https://unpkg.com/lucide-static@${version}/tags.json`;

const response = await fetch(url);
if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`);
// unpkg redirects `latest` to the version it resolved, which is what the header records.
const resolved = /lucide-static@([^/]+)/.exec(response.url)?.[1] ?? version;
const tags = await response.json();

const names = JSON.parse(readFileSync(IDS, "utf8")).map((id) => id.slice("lucide-".length));

const entries = [];
for (const name of names) {
  const words = (tags[name] ?? [])
    .flatMap((tag) => tag.toLowerCase().split(/[^a-z0-9]+/))
    .filter((word) => word && !name.includes(word));
  const unique = [...new Set(words)];
  if (unique.length) entries.push(`  [${JSON.stringify(name)}, ${JSON.stringify(unique.join(" "))}],`);
}
if (entries.length < 500) throw new Error(`only ${entries.length} names carry words — the table is off`);

writeFileSync(OUT, `/**
 * The words each of Obsidian's glyphs answers to: the name, then the words it also carries,
 * all lowercase. Lucide's own tags, and the whole of what \`icon-catalog.ts\` has to go on.
 *
 * Generated from lucide-static ${resolved} by scripts/dump-icon-keywords.mjs. Do not edit.
 */
export const LUCIDE_KEYWORDS: [name: string, words: string][] = [
${entries.join("\n")}
];
`);
console.log(`${entries.length} of ${names.length} names carry words, from lucide-static ${resolved} → ${OUT}`);
