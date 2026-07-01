import { describe, it, expect } from "vitest";
import {
  ALL_WEEKDAYS,
  weekdayIndexFor,
  isScheduledOn,
  scheduledFor,
  isInSameIsoWeek,
  isTodayOrLaterInWeek,
  renderHabitLines,
  computeMissingHabits,
  findHeadingSection,
  isOrphanedHabitTask,
  RecurringTaskDefinition,
} from "./recurring-task";
import { parseDate, DayTask } from "./day-task";

const TAG = "daily";

function def(overrides: Partial<RecurringTaskDefinition> = {}): RecurringTaskDefinition {
  return {
    id: "id-1",
    title: "Morning run",
    weekdays: ALL_WEEKDAYS,
    order: 0,
    active: true,
    createdAt: "2026-01-01",
    detail: "",
    ...overrides,
  };
}

describe("weekdayIndexFor", () => {
  it.each([
    ["2026-06-29", 0], // Monday
    ["2026-06-30", 1], // Tuesday
    ["2026-07-01", 2], // Wednesday
    ["2026-07-02", 3], // Thursday
    ["2026-07-03", 4], // Friday
    ["2026-07-04", 5], // Saturday
    ["2026-07-05", 6], // Sunday
  ])("maps %s to weekday index %i", (dateStr, expected) => {
    expect(weekdayIndexFor(parseDate(dateStr))).toBe(expected);
  });
});

describe("isScheduledOn / scheduledFor", () => {
  it("includes a def scheduled on the given weekday", () => {
    const weekdaysOnly = 0b0011111; // Mon-Fri
    expect(isScheduledOn(def({ weekdays: weekdaysOnly }), 0)).toBe(true);
    expect(isScheduledOn(def({ weekdays: weekdaysOnly }), 6)).toBe(false);
  });

  it("excludes inactive definitions", () => {
    const result = scheduledFor([def({ active: false })], parseDate("2026-06-29"));
    expect(result).toEqual([]);
  });

  it("sorts by order", () => {
    const result = scheduledFor(
      [def({ id: "b", order: 2 }), def({ id: "a", order: 1 })],
      parseDate("2026-06-29"),
    );
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("isInSameIsoWeek", () => {
  it("returns true for two dates within the same Monday-Sunday week", () => {
    expect(isInSameIsoWeek(parseDate("2026-06-29"), parseDate("2026-07-05"))).toBe(true);
  });

  it("returns true for the same date", () => {
    expect(isInSameIsoWeek(parseDate("2026-07-01"), parseDate("2026-07-01"))).toBe(true);
  });

  it("returns false for dates in adjacent weeks", () => {
    expect(isInSameIsoWeek(parseDate("2026-06-28"), parseDate("2026-06-29"))).toBe(false);
    expect(isInSameIsoWeek(parseDate("2026-07-06"), parseDate("2026-07-05"))).toBe(false);
  });

  it("returns false for dates far apart", () => {
    expect(isInSameIsoWeek(parseDate("2026-01-01"), parseDate("2026-07-01"))).toBe(false);
  });
});

describe("isTodayOrLaterInWeek", () => {
  const wednesday = parseDate("2026-07-01");

  it("returns true for the reference date itself", () => {
    expect(isTodayOrLaterInWeek(wednesday, wednesday)).toBe(true);
  });

  it("returns true for later days in the same week", () => {
    expect(isTodayOrLaterInWeek(parseDate("2026-07-03"), wednesday)).toBe(true); // Friday
    expect(isTodayOrLaterInWeek(parseDate("2026-07-05"), wednesday)).toBe(true); // Sunday
  });

  it("returns false for earlier days in the same week, even though they're in the same ISO week", () => {
    expect(isTodayOrLaterInWeek(parseDate("2026-06-29"), wednesday)).toBe(false); // Monday
    expect(isTodayOrLaterInWeek(parseDate("2026-06-30"), wednesday)).toBe(false); // Tuesday
  });

  it("returns false for dates outside the current ISO week entirely", () => {
    expect(isTodayOrLaterInWeek(parseDate("2026-07-06"), wednesday)).toBe(false); // next Monday
    expect(isTodayOrLaterInWeek(parseDate("2026-01-01"), wednesday)).toBe(false);
  });
});

describe("renderHabitLines", () => {
  it("renders a single line with no detail, tagged with the given habits tag", () => {
    expect(renderHabitLines(def(), TAG)).toEqual(["- [ ] Morning run #daily"]);
  });

  it("renders indented detail sub-lines below the task line", () => {
    const lines = renderHabitLines(def({ detail: "Prompt A\nPrompt B" }), TAG);
    expect(lines).toEqual(["- [ ] Morning run #daily", "\tPrompt A", "\tPrompt B"]);
  });
});

describe("computeMissingHabits", () => {
  const heading = "# Routine";

  it("returns nothing missing and insertAt null when no habits are scheduled", () => {
    const result = computeMissingHabits([], [def({ weekdays: 0 })], parseDate("2026-06-29"), heading, TAG);
    expect(result).toEqual({ missing: [], insertAt: null });
  });

  it("reports all scheduled habits missing with insertAt null when no heading exists", () => {
    const result = computeMissingHabits([], [def()], parseDate("2026-06-29"), heading, TAG);
    expect(result.missing).toHaveLength(1);
    expect(result.insertAt).toBeNull();
  });

  it("returns no missing habits when all are already present (checked or unchecked)", () => {
    const lines = [heading, "- [x] Morning run #daily ✅ 2026-06-29"];
    const result = computeMissingHabits(lines, [def()], parseDate("2026-06-29"), heading, TAG);
    expect(result.missing).toEqual([]);
  });

  it("reports only the missing ones when some habits are already present", () => {
    const lines = [heading, "- [ ] Morning run #daily"];
    const defs = [def(), def({ id: "id-2", title: "Evening stretch" })];
    const result = computeMissingHabits(lines, defs, parseDate("2026-06-29"), heading, TAG);
    expect(result.missing.map((d) => d.id)).toEqual(["id-2"]);
  });

  it("inserts after the last checklist line in the section, before trailing blank lines / next heading", () => {
    const lines = [heading, "- [ ] Existing habit", "", "# Next section"];
    const result = computeMissingHabits(lines, [def()], parseDate("2026-06-29"), heading, TAG);
    expect(result.insertAt).toBe(2);
  });

  it("inserts at end of file when the section has no trailing heading", () => {
    const lines = [heading, "- [ ] Existing habit"];
    const result = computeMissingHabits(lines, [def()], parseDate("2026-06-29"), heading, TAG);
    expect(result.insertAt).toBe(2);
  });

  it("does not treat a habit whose title contains a '#' as still missing after it's inserted", () => {
    // Regression test: matching used to go through displayTitle(), which strips *every*
    // tag-like substring, not just habitsTag — so a title like "Read #book" would render as
    // "- [ ] Read #book #daily", but the round-trip title comparison stripped both tags down
    // to "Read", never matching the original "Read #book" key, causing perpetual re-insertion.
    const lines = [heading, "- [ ] Read #book #daily"];
    const defs = [def({ title: "Read #book" })];
    const result = computeMissingHabits(lines, defs, parseDate("2026-06-29"), heading, TAG);
    expect(result.missing).toEqual([]);
  });

  it("excludes a definition not scheduled for that weekday even if entirely absent", () => {
    const weekdaysMonToFri = 0b0011111;
    const lines = [heading];
    const result = computeMissingHabits(
      lines,
      [def({ weekdays: weekdaysMonToFri })],
      parseDate("2026-07-05"), // Sunday
      heading,
      TAG,
    );
    expect(result.missing).toEqual([]);
  });

  it("is idempotent: running twice on the resulting content reports nothing missing", () => {
    const lines = [heading, "- [ ] Existing habit"];
    const first = computeMissingHabits(lines, [def()], parseDate("2026-06-29"), heading, TAG);
    expect(first.missing).toHaveLength(1);

    const inserted = lines.slice();
    inserted.splice(first.insertAt!, 0, ...first.missing.flatMap(() => ["- [ ] Morning run #daily"]));
    const second = computeMissingHabits(inserted, [def()], parseDate("2026-06-29"), heading, TAG);
    expect(second.missing).toEqual([]);
  });
});

describe("findHeadingSection", () => {
  it("returns null when the heading is absent", () => {
    expect(findHeadingSection(["some content"], "# Routine")).toBeNull();
  });

  it("finds the section bounded by the next heading", () => {
    const lines = ["# Routine", "- [ ] A", "- [ ] B", "# Next"];
    expect(findHeadingSection(lines, "# Routine")).toEqual({ headingIdx: 0, end: 3 });
  });

  it("finds the section bounded by EOF when there's no following heading", () => {
    const lines = ["# Routine", "- [ ] A", "- [ ] B"];
    expect(findHeadingSection(lines, "# Routine")).toEqual({ headingIdx: 0, end: 3 });
  });
});

describe("isOrphanedHabitTask", () => {
  const monday = parseDate("2026-06-29");

  it("returns false for a task without the habits tag", () => {
    const task = DayTask.parse("- [ ] Just a task", 0)!;
    expect(isOrphanedHabitTask(task, [def()], monday, TAG)).toBe(false);
  });

  it("returns false when the task matches a currently active+scheduled definition", () => {
    const task = DayTask.parse("- [ ] Morning run #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def()], monday, TAG)).toBe(false);
  });

  it("returns true when no definition matches the task's title at all (deleted)", () => {
    const task = DayTask.parse("- [ ] Morning run #daily", 0)!;
    expect(isOrphanedHabitTask(task, [], monday, TAG)).toBe(true);
  });

  it("returns true when the matching definition is inactive", () => {
    const task = DayTask.parse("- [ ] Morning run #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def({ active: false })], monday, TAG)).toBe(true);
  });

  it("returns true when the matching definition isn't scheduled for that weekday", () => {
    const task = DayTask.parse("- [ ] Morning run #daily", 0)!;
    const weekdaysMonToFri = 0b0011111;
    expect(
      isOrphanedHabitTask(task, [def({ weekdays: weekdaysMonToFri })], parseDate("2026-07-05"), TAG),
    ).toBe(true);
  });

  it("returns true when the task's title no longer matches after a rename", () => {
    const task = DayTask.parse("- [ ] Old title #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def({ title: "New title" })], monday, TAG)).toBe(true);
  });

  it("is unaffected by checked state", () => {
    const checkedOrphan = DayTask.parse("- [x] Old title #daily ✅ 2026-06-29", 0)!;
    expect(isOrphanedHabitTask(checkedOrphan, [], monday, TAG)).toBe(true);
    const checkedCurrent = DayTask.parse("- [x] Morning run #daily ✅ 2026-06-29", 0)!;
    expect(isOrphanedHabitTask(checkedCurrent, [def()], monday, TAG)).toBe(false);
  });

  it("does not treat a habit whose title contains a '#' as orphaned", () => {
    const task = DayTask.parse("- [ ] Read #book #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def({ title: "Read #book" })], monday, TAG)).toBe(false);
  });
});
