import { describe, it, expect } from "vitest";
import { EMOJI_GROUPS, matchingEmojiGroups } from "./emoji-catalog";

const entries = () => EMOJI_GROUPS.flatMap((g) => g.entries);
const found = (query: string) => matchingEmojiGroups(query).flatMap((g) => g.entries).map((e) => e.glyph);

describe("the catalogue", () => {
  it("offers every glyph once", () => {
    const glyphs = entries().map((e) => e.glyph);
    expect(glyphs).toHaveLength(new Set(glyphs).size);
  });

  it("gives every glyph a word to be found by, in lowercase", () => {
    const wordless = entries().filter((e) => e.words.length === 0);
    expect(wordless).toEqual([]);
    const shouted = entries().flatMap((e) => e.words).filter((w) => w !== w.toLowerCase());
    expect(shouted).toEqual([]);
  });

  it("names every drawer once", () => {
    const names = EMOJI_GROUPS.map((g) => g.name);
    expect(names).toHaveLength(new Set(names).size);
  });
});

describe("searching it", () => {
  it("hands back every drawer for an empty query", () => {
    expect(matchingEmojiGroups("  ")).toEqual(EMOJI_GROUPS);
  });

  it("matches a word by any fragment of it, so a stem finds what grew from it", () => {
    expect(found("plan")).toContain("🗓️");
    expect(found("ning")).toContain("🗓️");
  });

  it("cuts a drawer to the entries that answer", () => {
    const groups = matchingEmojiGroups("rocket");
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((e) => e.glyph)).toEqual(["🚀"]);
  });

  it("keeps a drawer whole when its own name is what matched", () => {
    const groups = matchingEmojiGroups("travel");
    const travel = EMOJI_GROUPS.find((g) => g.name === "Travel")!;
    expect(groups).toEqual([travel]);
  });

  it("ignores the case and the spaces around the query", () => {
    expect(found("  ROCKET ")).toEqual(["🚀"]);
  });

  it("hands back nothing when no word answers", () => {
    expect(matchingEmojiGroups("zzz")).toEqual([]);
  });
});
