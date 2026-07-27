import { parseDate, parseTimestamp } from "../dates";

/** A `YYYY-MM-DD` fixture day as the `Date` the model holds. Throws on anything that
 *  isn't one, so a typo in a fixture fails the test rather than reading as "no date". */
export function day(text: string): Date {
  const date = parseDate(text);
  if (!date) throw new Error(`Not a day: ${text}`);
  return date;
}

/** A fixture instant, for the timestamp fields — `createdAt`, `updatedAt`, `completed`.
 *  Not interchangeable with `day`: those record a UTC calendar day (see `timestampDay`),
 *  and a local midnight passed off as one lands on the day before for half the world. */
export function timestamp(text: string): Date {
  const date = parseTimestamp(text);
  if (!date) throw new Error(`Not a timestamp: ${text}`);
  return date;
}
