import { describe, it, expect } from "vitest";
import {
  MAX_CARD_HEIGHT, MAX_CARD_WIDTH, MIN_CARD_HEIGHT, MIN_CARD_WIDTH, clamp, toCardLayout,
} from "./card-layout";

describe("toCardLayout", () => {
  it("reads a place and a size a card was given", () => {
    expect(toCardLayout({ x: 120, y: -40, w: 240, h: 96 }))
      .toEqual({ x: 120, y: -40, w: 240, h: 96 });
  });

  it("reads a card that was dragged but never resized", () => {
    expect(toCardLayout({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it("reads a card that was resized but never dragged", () => {
    expect(toCardLayout({ w: 200, h: 90 })).toEqual({ w: 200, h: 90 });
  });

  it.each([
    ["nothing at all", undefined],
    ["a key that is not a mapping", "160x72"],
    ["a mapping with none of the four", { note: "hand-typed" }],
    ["numbers that are not numbers", { x: "120", y: "40" }],
  ])("reads %s as no layout, so the card is simply placed", (_case, value) => {
    expect(toCardLayout(value)).toBeUndefined();
  });

  it.each([
    ["half a place", { x: 10 }],
    ["half a size", { w: 200 }],
  ])("drops %s: it names nothing the card can be drawn by", (_case, value) => {
    expect(toCardLayout(value)).toBeUndefined();
  });

  it("keeps the place when only the size is unusable", () => {
    expect(toCardLayout({ x: 10, y: 20, w: 200 })).toEqual({ x: 10, y: 20 });
  });

  it("holds a hand-typed size to what a card may be drawn at", () => {
    expect(toCardLayout({ w: 5000, h: 1 })).toEqual({ w: MAX_CARD_WIDTH, h: MIN_CARD_HEIGHT });
    expect(toCardLayout({ w: 0, h: 9000 })).toEqual({ w: MIN_CARD_WIDTH, h: MAX_CARD_HEIGHT });
  });

  it("reads a place anywhere, negative or not — the drawing is normalised, not the note", () => {
    expect(toCardLayout({ x: -5000, y: -5000 })).toEqual({ x: -5000, y: -5000 });
  });
});

describe("clamp", () => {
  it("hands back a value already between the bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("holds one outside them to the bound it passed", () => {
    expect([clamp(-1, 0, 10), clamp(11, 0, 10)]).toEqual([0, 10]);
  });
});
