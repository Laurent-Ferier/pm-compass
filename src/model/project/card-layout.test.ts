import { describe, it, expect } from "vitest";
import {
  CardPart, MAX_CARD_HEIGHT, MAX_CARD_WIDTH, MIN_CARD_HEIGHT, MIN_CARD_WIDTH, cardHas,
  cardWithout, clamp, toCardLayout,
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

describe("cardHas", () => {
  it("says which halves a card carries", () => {
    expect(cardHas({ x: 1, y: 2 }, CardPart.Place)).toBe(true);
    expect(cardHas({ x: 1, y: 2 }, CardPart.Size)).toBe(false);
    expect(cardHas({ w: 200, h: 90 }, CardPart.Size)).toBe(true);
    expect(cardHas({ w: 200, h: 90 }, CardPart.Place)).toBe(false);
  });

  it("says a card that isn't there carries neither", () => {
    expect(cardHas(undefined, CardPart.Place)).toBe(false);
    expect(cardHas(undefined, CardPart.Size)).toBe(false);
  });
});

describe("cardWithout", () => {
  it("keeps the other half", () => {
    expect(cardWithout({ x: 1, y: 2, w: 200, h: 90 }, CardPart.Place)).toEqual({ w: 200, h: 90 });
    expect(cardWithout({ x: 1, y: 2, w: 200, h: 90 }, CardPart.Size)).toEqual({ x: 1, y: 2 });
  });

  it("leaves nothing worth storing when the half dropped was all there was", () => {
    expect(cardWithout({ x: 1, y: 2 }, CardPart.Place)).toBeNull();
    expect(cardWithout({ w: 200, h: 90 }, CardPart.Size)).toBeNull();
  });

  it("leaves nothing worth storing for a card that isn't there", () => {
    expect(cardWithout(undefined, CardPart.Place)).toBeNull();
    expect(cardWithout(undefined, CardPart.Size)).toBeNull();
  });
});
