import type { Moment } from "../moment";

/**
 * Asserts a hand-rolled moment fake to `Moment`.
 *
 * The fakes implement the handful of methods the code under test actually calls
 * (`format`, `startOf`, `add`, `diff`, …) out of the ~80 on the real interface, so
 * they can never satisfy it structurally. Rather than widening every signature that
 * takes a `Moment` — which would drop the type safety the production code relies on —
 * each fake factory asserts once, here, at the point where it hands the fake over.
 *
 * The returned value keeps the fake's own type as well, so a factory that calls
 * itself recursively (`startOf()` returning another fake) still sees its own members.
 */
export function asMoment<T>(fake: T): T & Moment {
  return fake as T & Moment;
}
