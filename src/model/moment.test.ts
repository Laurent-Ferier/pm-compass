import { describe, it, expect, vi } from "vitest";

/** Only what the facade names: a factory, and the three members moment hangs off it. */
function obsidianMoment(input?: unknown) {
  return { input, format: () => "formatted" };
}

Object.assign(obsidianMoment, {
  localeData: () => ({ firstDayOfWeek: () => 1 }),
  weekdaysMin: (sorted?: boolean) => (sorted ? ["Mo"] : ["Su"]),
  weekdaysShort: (sorted?: boolean) => (sorted ? ["Mon"] : ["Sun"]),
});

vi.mock("obsidian", () => ({ moment: obsidianMoment }));

import { moment } from "./moment";

describe("moment", () => {
  it("is Obsidian's own, so the vault's locale is the one in force", () => {
    expect(moment).toBe(obsidianMoment);
  });

  it("makes a moment of what it is handed", () => {
    expect(moment(new Date(2026, 0, 1)).format()).toBe("formatted");
  });

  it("reaches the locale members the published typings leave off the factory", () => {
    expect(moment.localeData().firstDayOfWeek()).toBe(1);
    expect(moment.weekdaysMin(true)).toEqual(["Mo"]);
    expect(moment.weekdaysShort(true)).toEqual(["Mon"]);
  });
});
