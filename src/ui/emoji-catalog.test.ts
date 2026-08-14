import { describe, it, expect } from "vitest";
import { emojiGroups, loadEmojiDrawers, matchingEmojiGroups } from "./emoji-catalog";
import { EMOJI_DRAWERS } from "./emoji-keywords";

// The catalogue reads the table in when the picker opens; nothing here is searchable before.
await loadEmojiDrawers();

const entries = () => emojiGroups().flatMap((g) => g.entries);
const found = (query: string) => matchingEmojiGroups(query).flatMap((g) => g.entries).map(([glyph]) => glyph);

const TABLE = EMOJI_DRAWERS.flatMap((drawer) => drawer.entries);

describe("the table of emoji", () => {
  it("gives each glyph its words: the label first, as one word, then the rest", () => {
    expect(TABLE.length).toBeGreaterThan(500);
    expect(TABLE.filter(([, words]) => !/^[a-z0-9-]+( [a-z0-9]+)*$/.test(words))).toEqual([]);
  });

  it("names every drawer, and fills it", () => {
    expect(EMOJI_DRAWERS.filter((d) => !d.name || !d.entries.length)).toEqual([]);
  });
});

describe("the catalogue", () => {
  it("offers every glyph once", () => {
    const glyphs = entries().map(([glyph]) => glyph);
    expect(glyphs).toHaveLength(new Set(glyphs).size);
  });

  it("gives every glyph a word to be found by, in lowercase", () => {
    const wordless = entries().filter(([, words]) => words === "");
    expect(wordless).toEqual([]);
    const shouted = entries().filter(([, words]) => words !== words.toLowerCase());
    expect(shouted).toEqual([]);
  });

  it("keeps the drawers as the table has them, each with its entries", () => {
    const names = emojiGroups().map((g) => g.name);
    expect(names).toEqual(EMOJI_DRAWERS.map((d) => d.name));
    expect(names).toHaveLength(new Set(names).size);
    expect(emojiGroups().filter((g) => g.entries.length === 0)).toEqual([]);
  });

  it("leads with what a project is likely to want, not with Unicode's smileys", () => {
    expect(emojiGroups()[0].name).toBe("Objects");
  });

  it("spells a glyph as a note should carry it, joined sequences whole", () => {
    const glyphs = entries().map(([glyph]) => glyph);
    // A character drawn as an emoji already needs no selector; one drawn as text keeps it,
    // and a joined sequence is only itself with every selector Unicode lists in place.
    expect(glyphs).toContain("📋");
    expect(glyphs).toContain("🗒️");
    expect(glyphs).toContain("👨‍⚕️");
    expect(glyphs).toContain("🏳️‍⚧️");
  });
});

describe("searching it", () => {
  it("hands back every drawer for an empty query", () => {
    expect(matchingEmojiGroups("  ")).toEqual(emojiGroups());
  });

  it("matches a word by any fragment of it, so a stem finds what grew from it", () => {
    expect(found("rocke")).toContain("🚀");
    expect(found("launch")).toContain("🚀");
  });

  it("cuts a drawer to the entries that answer", () => {
    const groups = matchingEmojiGroups("stethoscope");
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map(([glyph]) => glyph)).toEqual(["🩺"]);
  });

  it("keeps a drawer whole when its own name is what matched", () => {
    const [travel] = matchingEmojiGroups("travel and places");
    expect(travel).toEqual(emojiGroups().find((g) => g.name === "Travel and places"));
  });

  it("ignores the case and the spaces around the query", () => {
    expect(found("  STETHOSCOPE ")).toEqual(["🩺"]);
  });

  it("hands back nothing when no word answers", () => {
    expect(matchingEmojiGroups("qqq")).toEqual([]);
  });
});
