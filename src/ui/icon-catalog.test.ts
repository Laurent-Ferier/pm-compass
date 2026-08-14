import { describe, it, expect } from "vitest";
import { loadIconWords, matchingIconNames } from "./icon-catalog";
import { LUCIDE_KEYWORDS } from "./lucide-keywords";

// The catalogue reads the table in when the picker opens; a glyph answers to its name alone
// before that.
await loadIconWords();

const OBSIDIAN_IDS: string[] = (await import("./__testing__/obsidian-icon-ids.json")).default;
const ALL = OBSIDIAN_IDS.map((id) => id.slice("lucide-".length));
const found = (query: string) => matchingIconNames(ALL, query);

const named = LUCIDE_KEYWORDS.map(([name]) => name);

describe("the table of words", () => {
  it("gives an entry to most of what Obsidian ships, each a name and words in lowercase", () => {
    expect(LUCIDE_KEYWORDS.length).toBeGreaterThan(ALL.length / 2);
    expect(LUCIDE_KEYWORDS.filter(([name]) => !/^[a-z0-9-]+$/.test(name))).toEqual([]);
    expect(LUCIDE_KEYWORDS.filter(([, words]) => !/^[a-z0-9]+( [a-z0-9]+)*$/.test(words))).toEqual([]);
  });

  it("names a glyph once, and one Obsidian draws", () => {
    expect(named).toHaveLength(new Set(named).size);
    expect(named.filter((n) => !ALL.includes(n))).toEqual([]);
  });

  it("spends no word the name already carries", () => {
    const repeated = LUCIDE_KEYWORDS.filter(([name, words]) => words.split(" ").some((w) => name.includes(w)));
    expect(repeated).toEqual([]);
  });

  it("says a word once for a glyph, whatever Lucide's tags repeat", () => {
    const doubled = LUCIDE_KEYWORDS.filter(([, words]) => {
      const said = words.split(" ");
      return said.length !== new Set(said).size;
    });
    expect(doubled).toEqual([]);
  });
});

describe("searching it", () => {
  it("hands back the names as given for an empty query", () => {
    expect(matchingIconNames(ALL, "  ")).toBe(ALL);
  });

  it("finds a glyph by what it stands for, not only by its name", () => {
    expect(found("launch")).toContain("rocket");
    expect(found("departure")).toContain("plane-takeoff");
  });

  it("leads with the names bearing the word, the ones merely meaning it behind", () => {
    const matches = found("alarm");
    const bell = matches.indexOf("bell"); // stands for one without being named one
    expect(bell).toBeGreaterThan(0);
    expect(matches.slice(0, bell).every((name) => name.includes("alarm"))).toBe(true);
  });

  it("matches a word by any fragment of it, so a stem finds what grew from it", () => {
    expect(found("depart")).toContain("plane-takeoff");
  });

  it("ignores the case and the spaces around the query", () => {
    expect(found("  LAUNCH ")).toEqual(found("launch"));
  });

  it("hands back nothing when no name and no word answers", () => {
    expect(found("zzz")).toEqual([]);
  });

  it("keeps to the names it was given", () => {
    expect(matchingIconNames(["rocket", "folder"], "launch")).toEqual(["rocket"]);
    expect(matchingIconNames(["folder"], "launch")).toEqual([]);
  });
});
