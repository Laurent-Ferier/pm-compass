// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// Nothing here reaches Obsidian at runtime; the checks below are static. The stub only
// stands in for the `getIcon` this module's own name list is checked against.
const KNOWN = "lucide-check";
vi.mock("obsidian", () => ({
  setIcon: (el: HTMLElement, name: string) => { el.setAttribute("data-icon", name); },
  getIcon: (name: string) => {
    if (name !== KNOWN) return null;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-icon", name);
    return svg;
  },
}));

import { Icon, STATUS_ICONS, isIconName, renderIcon } from "./icons";
import { STATUSES } from "../model/base-task";

// The icon names Obsidian actually ships, read out of its own bundle (1.12.7, the
// manifest's minAppVersion) by scripts/dump-icon-ids.mjs — rerun it after upgrading
// Obsidian. `getIconIds()` would say the same thing, but the tests mock the obsidian
// module and CI has no Obsidian to ask. An icon Obsidian doesn't know renders an empty
// element and raises nothing, so this is the only place a typo gets caught.
const AVAILABLE = JSON.parse(
  readFileSync(join(__dirname, "__testing__", "obsidian-icon-ids.json"), "utf8"),
) as string[];

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__mocks__" ? [] : sourceFiles(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** The argument naming the icon in every `setIcon` / `addRibbonIcon` call in `source`:
 *  the last one for `setIcon(el, icon)` and `.setIcon(icon)`, the first for a ribbon. */
function iconArguments(source: string): string[] {
  const found: string[] = [];
  const call = /(setIcon|addRibbonIcon)\(/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    const args = splitArguments(source, m.index + m[0].length);
    if (!args.length) continue;
    found.push(m[1] === "addRibbonIcon" ? args[0] : args[args.length - 1]);
  }
  return found;
}

/** What every `getIcon(): string` override in `source` returns — the name Obsidian
 *  draws on a view's tab, which reaches `setIcon` inside Obsidian rather than here. */
function iconReturns(source: string): string[] {
  return [...source.matchAll(/getIcon\(\)\s*:\s*string\s*\{([^}]*)\}/g)]
    .map((m) => m[1].replace(/^\s*return\s*/, "").trim().replace(/;$/, ""));
}

/** The top-level arguments of the call whose `(` ends at `start`, nesting and string
 *  literals left intact. Returns nothing if the call runs past the end of the source. */
function splitArguments(source: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0, quote = "", from = start;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if ("]})".includes(c)) {
      if (depth === 0) return [...args, source.slice(from, i).trim()];
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(source.slice(from, i).trim());
      from = i + 1;
    }
  }
  return [];
}

describe("icons", () => {
  it("names only icons Obsidian ships", () => {
    const available = new Set(AVAILABLE);
    const missing = Object.values(Icon).filter((name) => !available.has(name));
    expect(missing).toEqual([]);
  });

  it("gives every status a glyph", () => {
    for (const status of STATUSES) expect(STATUS_ICONS[status]).toBeDefined();
  });

  // Every name has to come through the enum, or the check above proves nothing.
  it("leaves no icon name spelled out at a call site", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...iconArguments(source), ...iconReturns(source)]
        .filter((expr) => /"[a-z][a-z0-9-]*"/.test(expr))
        .map((expr) => `${file}: ${expr}`);
    });
    expect(offenders).toEqual([]);
  });
});

// A project's icon is the one the enum above doesn't cover: whatever was chosen for it.
describe("a project's own icon", () => {
  it("reads a name as a name and a glyph as a glyph", () => {
    expect(isIconName("folder-open")).toBe(true);
    expect(isIconName("🚀")).toBe(false);
  });

  it("draws a name through Obsidian and a glyph as the text it is", () => {
    const el = document.createElement("span");
    el.empty = function () { this.innerHTML = ""; };
    el.setText = function (text: string) { this.textContent = text; };
    renderIcon(el, "folder-open");
    expect(el.getAttribute("data-icon")).toBe("folder-open");
    renderIcon(el, "🚀");
    expect(el.textContent).toBe("🚀");
  });
});
