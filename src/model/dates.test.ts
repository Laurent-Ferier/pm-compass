import { describe, it, expect } from "vitest";
import {
  addDays, compareDays, diffDays, formatDate, formatTimestamp, isoWeekNumber, parseDate,
  parseTimestamp, sameDay, startOfDay, startOfIsoWeek, timestampDay, weekdayIndex,
} from "./dates";

describe("parseDate", () => {
  it("reads a day as its local midnight", () => {
    expect(parseDate("2026-07-15")).toEqual(new Date(2026, 6, 15));
  });

  it("takes the day off the front of a timestamp", () => {
    expect(parseDate("2026-07-15T22:30:00.000Z")).toEqual(new Date(2026, 6, 15));
  });

  it("reads anything that isn't a day as no date at all", () => {
    for (const text of ["", "today", "15/07/2026", undefined, null]) {
      expect(parseDate(text)).toBeNull();
    }
  });

  it("refuses a day the calendar doesn't have, rather than rolling it over", () => {
    // 2026 is not a leap year, so the 29th is February's rollover too.
    for (const text of ["2026-02-31", "2026-02-29", "2026-13-01", "2026-04-31", "2026-00-10"]) {
      expect(parseDate(text)).toBeNull();
    }
  });

  it("keeps the leap day of a year that has one", () => {
    expect(parseDate("2028-02-29")).toEqual(new Date(2028, 1, 29));
  });
});

describe("formatDate", () => {
  it("writes the local calendar day, not the UTC one", () => {
    // 00:30 local on the 15th is still the 14th in UTC for a positive offset.
    expect(formatDate(new Date(2026, 6, 15, 0, 30))).toBe("2026-07-15");
  });

  it("round-trips a parsed day", () => {
    expect(formatDate(parseDate("2026-01-05")!)).toBe("2026-01-05");
  });
});

describe("parseTimestamp / formatTimestamp", () => {
  it("round-trips an ISO instant unchanged", () => {
    const text = "2026-07-15T13:45:12.000Z";
    expect(formatTimestamp(parseTimestamp(text)!)).toBe(text);
  });

  it("tolerates a bare day where a timestamp is expected", () => {
    expect(parseTimestamp("2026-07-15")).not.toBeNull();
  });

  it("reads an unparseable value as absent", () => {
    expect(parseTimestamp("not a date")).toBeNull();
  });

  it("reads a missing value as absent, rather than as the epoch", () => {
    // `new Date(null)` is 1970, so the field has to be checked before it is parsed.
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });
});

describe("timestampDay", () => {
  it("gives the UTC calendar day the timestamp records, as a day", () => {
    expect(timestampDay(new Date("2026-07-15T13:45:00.000Z"))).toEqual(new Date(2026, 6, 15));
  });

  it("keeps the recorded day when the local one has already moved on", () => {
    // 23:30 UTC is the next day's small hours anywhere east of UTC+1 — but the field says
    // the 15th, and that is the day the plugin shows.
    expect(timestampDay(new Date("2026-07-15T23:30:00.000Z"))).toEqual(new Date(2026, 6, 15));
    // And the previous evening anywhere west of it.
    expect(timestampDay(new Date("2026-07-15T00:30:00.000Z"))).toEqual(new Date(2026, 6, 15));
  });

  it("round-trips a bare day read as a timestamp", () => {
    expect(timestampDay(parseTimestamp("2026-07-15")!)).toEqual(new Date(2026, 6, 15));
  });
});

describe("diffDays", () => {
  it("counts whole days forward and back", () => {
    expect(diffDays(new Date(2026, 6, 15), new Date(2026, 6, 18))).toBe(3);
    expect(diffDays(new Date(2026, 6, 18), new Date(2026, 6, 15))).toBe(-3);
  });

  it("ignores the time of day, so a timestamp compares against a day", () => {
    expect(diffDays(new Date(2026, 6, 15), new Date(2026, 6, 15, 23, 59))).toBe(0);
    expect(diffDays(new Date(2026, 6, 15, 23, 59), new Date(2026, 6, 16, 0, 1))).toBe(1);
  });

  it("counts one day across a DST boundary, whichever way the clock moved", () => {
    // Europe/Paris springs forward on 29 Mar 2026 and back on 25 Oct 2026.
    expect(diffDays(new Date(2026, 2, 28), new Date(2026, 2, 29))).toBe(1);
    expect(diffDays(new Date(2026, 9, 24), new Date(2026, 9, 25))).toBe(1);
  });

  it("spans a year end", () => {
    expect(diffDays(new Date(2026, 11, 31), new Date(2027, 0, 1))).toBe(1);
  });
});

describe("sameDay", () => {
  it("is true across times of the same day and false across midnight", () => {
    expect(sameDay(new Date(2026, 6, 15, 1), new Date(2026, 6, 15, 22))).toBe(true);
    expect(sameDay(new Date(2026, 6, 15, 23, 59), new Date(2026, 6, 16, 0, 1))).toBe(false);
  });
});

describe("compareDays", () => {
  it("orders the earlier day first", () => {
    const [a, b] = [new Date(2026, 6, 15), new Date(2026, 6, 20)];
    expect(compareDays(a, b)).toBeLessThan(0);
    expect(compareDays(b, a)).toBeGreaterThan(0);
    expect(compareDays(a, new Date(2026, 6, 15, 18))).toBe(0);
  });
});

describe("addDays", () => {
  it("shifts to midnight of the day asked for, over a month end", () => {
    expect(addDays(new Date(2026, 6, 30, 14), 3)).toEqual(new Date(2026, 7, 2));
    expect(addDays(new Date(2026, 7, 2), -3)).toEqual(new Date(2026, 6, 30));
  });

  it("leaves the date it was given untouched", () => {
    const original = new Date(2026, 6, 15);
    addDays(original, 5);
    expect(original).toEqual(new Date(2026, 6, 15));
  });
});

describe("startOfDay", () => {
  it("drops the time", () => {
    expect(startOfDay(new Date(2026, 6, 15, 18, 30, 5))).toEqual(new Date(2026, 6, 15));
  });
});

describe("weekdayIndex", () => {
  it("counts Monday as 0 through Sunday as 6", () => {
    // 2026-06-29 is a Monday.
    const indices = Array.from({ length: 7 }, (_, i) => weekdayIndex(new Date(2026, 5, 29 + i)));
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("startOfIsoWeek", () => {
  it("gives the Monday of the week, and is a no-op on a Monday", () => {
    const monday = new Date(2026, 5, 29);
    expect(startOfIsoWeek(monday)).toEqual(monday);
    expect(startOfIsoWeek(new Date(2026, 6, 5))).toEqual(monday); // that week's Sunday
  });
});

describe("isoWeekNumber", () => {
  it("numbers a week off the Thursday it holds", () => {
    expect(isoWeekNumber(new Date(2026, 6, 1))).toBe(27);
  });

  it("counts every day of one week as the same week", () => {
    const numbers = Array.from({ length: 7 }, (_, i) => isoWeekNumber(new Date(2026, 5, 29 + i)));
    expect(new Set(numbers)).toEqual(new Set([27]));
  });

  it("gives a year's first days the week of the year that week belongs to", () => {
    // 1 Jan 2026 is a Thursday, so its week is 2026's first — including the Dec days before it.
    expect(isoWeekNumber(new Date(2026, 0, 1))).toBe(1);
    expect(isoWeekNumber(new Date(2025, 11, 29))).toBe(1);
    // 2027 opens on a Friday, so 1 Jan falls in the week Monday 28 Dec 2026 started: 53.
    expect(isoWeekNumber(new Date(2027, 0, 1))).toBe(53);
  });
});
