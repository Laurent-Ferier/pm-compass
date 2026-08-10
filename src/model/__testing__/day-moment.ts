import { asMoment } from "./as-moment";

/**
 * Enough of moment for `date-format` to work a daily note's name: rendering a `Date` as
 * `YYYY-MM-DD`, and the strict parse of that filename back. Anything else formats as the
 * pattern itself and parses as invalid, which is all a day-note test asks of it.
 *
 * Supplied through a test's own `vi.mock("obsidian", …)` — the stub in `src/__mocks__`
 * has no moment to inherit.
 */
export function dayMoment(input: string | Date, format?: string, strict?: boolean) {
  if (input instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const text = `${input.getFullYear()}-${pad(input.getMonth() + 1)}-${pad(input.getDate())}`;
    return asMoment({ format: (fmt?: string) => (fmt === "YYYY-MM-DD" || !fmt ? text : fmt) });
  }
  const m = strict && format === "YYYY-MM-DD" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(input) : null;
  if (!m) return asMoment({ isValid: () => false, toDate: () => new Date(NaN) });
  const [, y, mo, d] = m;
  return asMoment({
    isValid: () => true,
    toDate: () => new Date(Number(y), Number(mo) - 1, Number(d)),
  });
}
