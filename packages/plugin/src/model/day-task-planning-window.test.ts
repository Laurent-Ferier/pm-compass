import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Minimal moment-like mock with real Monday-based isoWeek math, just enough for
 *  isWithinPlanningWindow's startOf("isoWeek")/add/endOf/isAfter chain. */
function isoWeekStart(d: Date): Date {
  const day = d.getDay();
  const isoWeekday = day === 0 ? 7 : day;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (isoWeekday - 1));
  return start;
}

function makeMomentObj(d: Date) {
  const self = {
    _d: new Date(d),
    startOf(unit: string) {
      if (unit === "isoWeek") return makeMomentObj(isoWeekStart(self._d));
      throw new Error(`unsupported unit ${unit}`);
    },
    add(amount: number, unit: string) {
      if (unit === "weeks") {
        const nd = new Date(self._d);
        nd.setDate(nd.getDate() + amount * 7);
        return makeMomentObj(nd);
      }
      throw new Error(`unsupported unit ${unit}`);
    },
    endOf(unit: string) {
      if (unit === "isoWeek") {
        const start = isoWeekStart(self._d);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);
        return makeMomentObj(end);
      }
      throw new Error(`unsupported unit ${unit}`);
    },
    isAfter(other: { _d: Date }, unit: string) {
      if (unit === "day") {
        const a = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate());
        const b = new Date(other._d.getFullYear(), other._d.getMonth(), other._d.getDate());
        return a.getTime() > b.getTime();
      }
      return self._d.getTime() > other._d.getTime();
    },
    format(fmt: string) {
      return fmt === "MMM D" ? `${self._d.getMonth() + 1}/${self._d.getDate()}` : self._d.toISOString();
    },
  };
  return self;
}

let NOW = new Date("2026-07-08T10:00:00"); // Wednesday

function mockMoment(...args: unknown[]) {
  if (args.length === 0) return makeMomentObj(NOW);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arg = args[0] as any;
  const d = arg?._d instanceof Date ? new Date(arg._d) : new Date(arg as string);
  return makeMomentObj(d);
}

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  moment: mockMoment,
}));

import { isWithinPlanningWindow } from "./day-task-actions";

describe("isWithinPlanningWindow", () => {
  beforeEach(() => {
    NOW = new Date("2026-07-08T10:00:00"); // Wednesday, isoWeek Mon 2026-07-06 .. Sun 2026-07-12
  });
  afterEach(() => vi.restoreAllMocks());

  it("allows a date later this week", () => {
    const date = mockMoment("2026-07-10"); // Friday, this week
    expect(isWithinPlanningWindow(date, 1).valid).toBe(true);
  });

  it("allows the last day of next week when maxWeeksAhead is 1", () => {
    const date = mockMoment("2026-07-19"); // Sunday, end of next week
    expect(isWithinPlanningWindow(date, 1).valid).toBe(true);
  });

  it("rejects a date beyond next week when maxWeeksAhead is 1", () => {
    const date = mockMoment("2026-07-20"); // Monday, week after next
    const result = isWithinPlanningWindow(date, 1);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/1 week ahead/);
  });

  it("pluralizes 'weeks' in the reason when maxWeeksAhead is greater than 1", () => {
    const date = mockMoment("2026-08-01"); // well beyond a 2-week window
    const result = isWithinPlanningWindow(date, 2);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/2 weeks ahead/);
  });

  it("disables the restriction when maxWeeksAhead is 0", () => {
    const date = mockMoment("2027-01-01");
    expect(isWithinPlanningWindow(date, 0).valid).toBe(true);
  });

  it("respects a larger configured window", () => {
    const date = mockMoment("2026-07-20"); // rejected at 1 week ahead, allowed at 2
    expect(isWithinPlanningWindow(date, 2).valid).toBe(true);
  });
});
