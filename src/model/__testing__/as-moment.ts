import type { Moment } from "../moment";

/**
 * Asserts a hand-rolled moment fake to `Moment`. A fake implements the handful of methods
 * the code calls out of the ~80 on the interface, so it can never satisfy it structurally;
 * asserting once here beats widening every signature that takes a `Moment`. The result
 * keeps the fake's own type, so a recursive factory still sees its members.
 */
export function asMoment<T>(fake: T): T & Moment {
  return fake as T & Moment;
}
