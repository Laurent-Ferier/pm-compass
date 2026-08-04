/**
 * Where a task's card sits in the graph and how big it has been made — the one thing about
 * a task that is about the drawing rather than about the work. It lives in the task's own
 * frontmatter, under `cardLayout`, so an arrangement belongs to the vault and travels with it.
 *
 * Held flat, as the key spells it: `cardLayout: {x, y, w, h}`. Every part is optional and
 * the pairs are independent — a card can have been dragged and never resized, or resized
 * and never dragged.
 */

/** A card's place and size as the `cardLayout` frontmatter key holds them. `x`/`y` are the
 *  centre, in the layout space `graph-layout` works in. */
export interface CardLayout {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** The two halves of a card's layout. Each is set by a gesture of its own and can be
 *  forgotten without the other — a card put somewhere is not a card made bigger. */
export enum CardPart {
  Place = "place",
  Size = "size",
}

/** Whether the card carries that half at all, which is what says whether forgetting it
 *  would edit the note. */
export function cardHas(card: CardLayout | undefined, part: CardPart): boolean {
  return (part === CardPart.Place ? card?.x : card?.w) !== undefined;
}

/** `card` with that half dropped, or null when doing so leaves nothing worth storing —
 *  which is what the key is then set to, dropping it. */
export function cardWithout(card: CardLayout | undefined, part: CardPart): CardLayout | null {
  if (part === CardPart.Place) {
    return card?.w !== undefined ? { w: card.w, h: card.h } : null;
  }
  return card?.x !== undefined ? { x: card.x, y: card.y } : null;
}

/** How small and how large a card may be made. A card under the floor has no room for its
 *  own title, and one over the ceiling is a wall rather than a card. */
export const MIN_CARD_WIDTH = 120;
export const MIN_CARD_HEIGHT = 56;
export const MAX_CARD_WIDTH = 640;
export const MAX_CARD_HEIGHT = 480;

/** `value`, held between the two bounds. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A finite number, or undefined for anything else — YAML will hand back whatever was
 *  typed into the note. */
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The `cardLayout` frontmatter value, narrowed. Undefined when there is nothing usable in it at
 * all, so a note carrying junk under the key reads the same as one carrying nothing: the
 * layout places the card and the drawing still works.
 */
export function toCardLayout(value: unknown): CardLayout | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const card: CardLayout = {};
  // A place is both coordinates or neither: half of one names no point.
  const x = number(raw.x);
  const y = number(raw.y);
  if (x !== undefined && y !== undefined) { card.x = x; card.y = y; }
  // A size likewise, and only one the card can actually be drawn at.
  const w = number(raw.w);
  const h = number(raw.h);
  if (w !== undefined && h !== undefined) {
    card.w = clamp(w, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
    card.h = clamp(h, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT);
  }
  return card.x === undefined && card.w === undefined ? undefined : card;
}
