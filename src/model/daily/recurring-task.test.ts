import { describe, it, expect } from "vitest";
import {
  ALL_WEEKDAYS,
  isScheduledOn,
  scheduledFor,
  isInSameIsoWeek,
  isTodayOrLaterInWeek,
  renderHabitLines,
  findHeadingSection,
  isOrphanedHabitTask,
  RecurringTaskDefinition,
} from "./recurring-task";
import { Task } from "./task";
import { weekdayIndex } from "../dates";
import { day } from "../__testing__/dates";

const TAG = "daily";

function def(overrides: Partial<RecurringTaskDefinition> = {}): RecurringTaskDefinition {
  return {
    id: "id-1",
    title: "Morning run",
    weekdays: ALL_WEEKDAYS,
    order: 0,
    active: true,
    createdAt: day("2026-01-01"),
    detail: "",
    ...overrides,
  };
}

describe("weekdayIndex", () => {
  it.each([
    ["2026-06-29", 0], // Monday
    ["2026-06-30", 1], // Tuesday
    ["2026-07-01", 2], // Wednesday
    ["2026-07-02", 3], // Thursday
    ["2026-07-03", 4], // Friday
    ["2026-07-04", 5], // Saturday
    ["2026-07-05", 6], // Sunday
  ])("maps %s to weekday index %i", (dateStr, expected) => {
    expect(weekdayIndex(day(dateStr))).toBe(expected);
  });
});

describe("isScheduledOn / scheduledFor", () => {
  it("includes a def scheduled on the given weekday", () => {
    const weekdaysOnly = 0b0011111; // Mon-Fri
    expect(isScheduledOn(def({ weekdays: weekdaysOnly }), 0)).toBe(true);
    expect(isScheduledOn(def({ weekdays: weekdaysOnly }), 6)).toBe(false);
  });

  it("excludes inactive definitions", () => {
    const result = scheduledFor([def({ active: false })], day("2026-06-29"));
    expect(result).toEqual([]);
  });

  it("sorts by order", () => {
    const result = scheduledFor(
      [def({ id: "b", order: 2 }), def({ id: "a", order: 1 })],
      day("2026-06-29"),
    );
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("isInSameIsoWeek", () => {
  it("returns true for two dates within the same Monday-Sunday week", () => {
    expect(isInSameIsoWeek(day("2026-06-29"), day("2026-07-05"))).toBe(true);
  });

  it("returns true for the same date", () => {
    expect(isInSameIsoWeek(day("2026-07-01"), day("2026-07-01"))).toBe(true);
  });

  it("returns false for dates in adjacent weeks", () => {
    expect(isInSameIsoWeek(day("2026-06-28"), day("2026-06-29"))).toBe(false);
    expect(isInSameIsoWeek(day("2026-07-06"), day("2026-07-05"))).toBe(false);
  });

  it("returns false for dates far apart", () => {
    expect(isInSameIsoWeek(day("2026-01-01"), day("2026-07-01"))).toBe(false);
  });
});

describe("isTodayOrLaterInWeek", () => {
  const wednesday = day("2026-07-01");

  it("returns true for the reference date itself", () => {
    expect(isTodayOrLaterInWeek(wednesday, wednesday)).toBe(true);
  });

  it("returns true for later days in the same week", () => {
    expect(isTodayOrLaterInWeek(day("2026-07-03"), wednesday)).toBe(true); // Friday
    expect(isTodayOrLaterInWeek(day("2026-07-05"), wednesday)).toBe(true); // Sunday
  });

  it("returns false for earlier days in the same week, even though they're in the same ISO week", () => {
    expect(isTodayOrLaterInWeek(day("2026-06-29"), wednesday)).toBe(false); // Monday
    expect(isTodayOrLaterInWeek(day("2026-06-30"), wednesday)).toBe(false); // Tuesday
  });

  it("returns false for dates outside the current ISO week entirely", () => {
    expect(isTodayOrLaterInWeek(day("2026-07-06"), wednesday)).toBe(false); // next Monday
    expect(isTodayOrLaterInWeek(day("2026-01-01"), wednesday)).toBe(false);
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

  it("finds the section bounded by a thematic break (---) before the next heading", () => {
    const lines = ["# Routine", "- [ ] A", "- [ ] B", "---", "Some other content", "# Next"];
    expect(findHeadingSection(lines, "# Routine")).toEqual({ headingIdx: 0, end: 3 });
  });

  it("treats *** and ___ as thematic breaks too", () => {
    expect(findHeadingSection(["# Routine", "- [ ] A", "***", "- [ ] C"], "# Routine")).toEqual({
      headingIdx: 0,
      end: 2,
    });
    expect(findHeadingSection(["# Routine", "- [ ] A", "___", "- [ ] C"], "# Routine")).toEqual({
      headingIdx: 0,
      end: 2,
    });
  });
});

describe("isOrphanedHabitTask", () => {
  const monday = day("2026-06-29");

  it("returns false for a task without the habits tag", () => {
    const task = Task.parse("- [ ] Just a task", 0)!;
    expect(isOrphanedHabitTask(task, [def()], monday, TAG)).toBe(false);
  });

  it("returns false when the task matches a currently active+scheduled definition", () => {
    const task = Task.parse("- [ ] Morning run #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def()], monday, TAG)).toBe(false);
  });

  it("returns true when no definition matches the task's title at all (deleted)", () => {
    const task = Task.parse("- [ ] Morning run #daily", 0)!;
    expect(isOrphanedHabitTask(task, [], monday, TAG)).toBe(true);
  });

  it("returns true when the matching definition is inactive", () => {
    const task = Task.parse("- [ ] Morning run #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def({ active: false })], monday, TAG)).toBe(true);
  });

  it("returns true when the matching definition isn't scheduled for that weekday", () => {
    const task = Task.parse("- [ ] Morning run #daily", 0)!;
    const weekdaysMonToFri = 0b0011111;
    expect(
      isOrphanedHabitTask(task, [def({ weekdays: weekdaysMonToFri })], day("2026-07-05"), TAG),
    ).toBe(true);
  });

  it("returns true when the task's title no longer matches after a rename", () => {
    const task = Task.parse("- [ ] Old title #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def({ title: "New title" })], monday, TAG)).toBe(true);
  });

  it("is unaffected by checked state", () => {
    const checkedOrphan = Task.parse("- [x] Old title #daily ✅ 2026-06-29", 0)!;
    expect(isOrphanedHabitTask(checkedOrphan, [], monday, TAG)).toBe(true);
    const checkedCurrent = Task.parse("- [x] Morning run #daily ✅ 2026-06-29", 0)!;
    expect(isOrphanedHabitTask(checkedCurrent, [def()], monday, TAG)).toBe(false);
  });

  it("does not treat a habit whose title contains a '#' as orphaned", () => {
    const task = Task.parse("- [ ] Read #book #daily", 0)!;
    expect(isOrphanedHabitTask(task, [def({ title: "Read #book" })], monday, TAG)).toBe(false);
  });
});
