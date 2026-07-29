#!/usr/bin/env node
/**
 * Refresh the list of icon names Obsidian ships, which `src/ui/icons.test.ts` checks
 * `ObsidianIcon` against.
 *
 * Usage:  node scripts/dump-icon-ids.mjs [path/to/obsidian.asar]
 *
 * The names come from Obsidian's own bundle rather than from `getIconIds()`, because
 * the tests run under vitest with the `obsidian` module mocked, and CI has no Obsidian
 * to ask. Run this after upgrading Obsidian: Lucide renames icons from time to time,
 * and a stale list would keep vouching for a name that no longer draws anything.
 *
 * Without an argument it looks in the usual install locations. On a platform none of
 * them cover, pass the path — or read the names off the running app instead, from
 * Obsidian's developer console, which produces the very same list:
 *
 *     copy(JSON.stringify(require("obsidian").getIconIds().sort()))
 *
 * and paste that into src/ui/__testing__/obsidian-icon-ids.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "__testing__", "obsidian-icon-ids.json");

const CANDIDATES = [
  "/opt/Obsidian/resources/obsidian.asar",
  "/usr/lib/obsidian/resources/obsidian.asar",
  "/Applications/Obsidian.app/Contents/Resources/obsidian.asar",
  join(process.env.LOCALAPPDATA ?? "", "Obsidian", "resources", "obsidian.asar"),
];

/** The bundled app.js, pulled out of the asar archive (8-byte header, then a JSON
 *  index, then the files back to back). */
function readAppJs(asarPath) {
  const buf = readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const index = JSON.parse(buf.toString("utf8", 16, 16 + headerSize));
  const entry = index.files["app.js"];
  if (!entry) throw new Error(`no app.js inside ${asarPath}`);
  const base = 16 + headerSize + Number(entry.offset);
  return buf.toString("utf8", base, base + entry.size);
}

/** Obsidian keeps its icons in one object literal, keyed by name, each value the
 *  compacted drawing. `grip-vertical` is only an anchor to find that object: any name
 *  in it would do, but this one is distinctive enough not to match anything else. */
function extractIconIds(appJs) {
  const anchor = appJs.indexOf('"grip-vertical":[[1,9,12,1]');
  if (anchor < 0) throw new Error("icon table not found — Obsidian's bundle has changed shape");

  let depth = 0, start = -1;
  for (let i = anchor; i >= 0; i--) {
    if (appJs[i] === "}") depth++;
    else if (appJs[i] === "{") { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) throw new Error("icon table is not a balanced object literal");

  depth = 0;
  let end = -1;
  for (let i = start; i < appJs.length; i++) {
    if (appJs[i] === "{") depth++;
    else if (appJs[i] === "}" && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("icon table is not a balanced object literal");

  const names = [...appJs.slice(start, end + 1).matchAll(/[,{]"?([a-z][a-z0-9-]*)"?:\[/g)].map((m) => m[1]);
  // The `lucide-` prefix is how `getIconIds()` reports them, and how a call site has to
  // spell them: a bare name goes through Obsidian's legacy alias table first, where
  // `folder` means folder-open and `pencil` means edit-3.
  return [...new Set(names)].map((name) => `lucide-${name}`).sort();
}

const given = process.argv[2];
const asar = given ?? CANDIDATES.find((p) => p && existsSync(p));
if (!asar) {
  console.error("Could not find obsidian.asar. Pass its path, or see the header of this script.");
  process.exit(1);
}

const ids = extractIconIds(readAppJs(asar));
if (ids.length < 500) throw new Error(`only ${ids.length} names found — the extraction is off`);
writeFileSync(OUT, JSON.stringify(ids));
console.log(`${ids.length} icon names from ${asar} → ${OUT}`);
