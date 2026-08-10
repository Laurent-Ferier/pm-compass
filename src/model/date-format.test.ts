import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Only what `daysLabel` asks of moment: a date, formatted in one of its two patterns. */
function mockMoment(input: Date) {
  return {
    format(pattern: string) {
      const md = `${MONTHS[input.getMonth()]} ${input.getDate()}`;
      return pattern === "MMM D, YYYY" ? `${md}, ${input.getFullYear()}` : md;
    },
  };
}

// A locale that starts its week on Sunday, so the ISO rotation is visible rather than a
// no-op — moment hands both lists over Sunday-first whatever the locale.
Object.assign(mockMoment, {
  weekdaysShort: () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  weekdaysMin: () => ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
});

vi.mock("obsidian", () => ({ moment: mockMoment }));

import { daysLabel, isoWeekdaysShort, isoWeekdaysMin } from "./date-format";
import { day } from "./__testing__/dates";

const TODAY = new Date(2026, 6, 1); // Wednesday 2026-07-01

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A day `days` from `TODAY`. */
function offsetDay(days: number): Date {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + days);
  return d;
}

describe("daysLabel", () => {
  it("counts the days an overdue date is past", () => {
    expect(daysLabel(offsetDay(-3))).toEqual({ text: "3 d", overdue: true, daysOverdue: 3 });
  });

  it("labels today", () => {
    expect(daysLabel(offsetDay(0))).toEqual({ text: "today", overdue: false, daysOverdue: 0 });
  });

  it("labels tomorrow as a one-day count", () => {
    expect(daysLabel(offsetDay(1))).toEqual({ text: "in 1d", overdue: false, daysOverdue: 0 });
  });

  it("labels a date more than a week out with the date itself", () => {
    expect(daysLabel(day("2026-12-24"))).toEqual({ text: "Dec 24", overdue: false, daysOverdue: 0 });
  });

  it("names the year of a date in another one, which 'Dec 24' alone would not", () => {
    expect(daysLabel(day("2027-01-05"))).toEqual({ text: "Jan 5, 2027", overdue: false, daysOverdue: 0 });
  });

  it("labels a date within the week as a count", () => {
    expect(daysLabel(offsetDay(5))).toEqual({ text: "in 5d", overdue: false, daysOverdue: 0 });
  });

  it("counts from the given reference day, not from today", () => {
    expect(daysLabel(day("2026-08-12"), day("2026-08-12")))
      .toEqual({ text: "today", overdue: false, daysOverdue: 0 });
    expect(daysLabel(day("2026-08-12"), day("2026-08-11")))
      .toEqual({ text: "in 1d", overdue: false, daysOverdue: 0 });
    expect(daysLabel(day("2026-08-12"), day("2026-08-14")))
      .toEqual({ text: "2 d", overdue: true, daysOverdue: 2 });
  });
});

// ---------------------------------------------------------------------------
// Weekday names on the ISO index
// ---------------------------------------------------------------------------

describe("the weekdays an ISO index names", () => {
  // `weekdayIndex` counts from Monday wherever it is read, so the labels have to as well —
  // moment's own lists start on Sunday, and its locale-sorted ones on whatever the locale
  // starts on, which is neither.
  it("puts Monday first, whatever moment hands over", () => {
    expect(isoWeekdaysShort()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(isoWeekdaysMin()).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
  });

  it("names all seven days once", () => {
    expect(new Set(isoWeekdaysShort()).size).toBe(7);
    expect(new Set(isoWeekdaysMin()).size).toBe(7);
  });
});
