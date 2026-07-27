import { describe, it, expect } from "vitest";
import {
  ALL_WEEKDAYS,
  isScheduledOn,
  scheduledFor,
  isInSameIsoWeek,
  isTodayOrLaterInWeek,
  renderHabitLines,
  computeMissingHabits,
  findHeadingSection,
  isOrphanedHabitTask,
  reorderScheduledHabits,
  RecurringTaskDefinition,
} from "./recurring-task";
import { DayTask } from "./day-task";
import { weekdayIndex } from "./dates";
import { day } from "./__testing__/dates";

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

describe("computeMissingHabits", () => {
  const heading = "# Routine";

  it("returns nothing missing and insertAt null when no habits are scheduled", () => {
    const result = computeMissingHabits([], [def({ weekdays: 0 })], day("2026-06-29"), heading, TAG);
    expect(result).toEqual({ missing: [], insertAt: null });
  });

  it("reports all scheduled habits missing with insertAt null when no heading exists", () => {
    const result = computeMissingHabits([], [def()], day("2026-06-29"), heading, TAG);
    expect(result.missing).toHaveLength(1);
    expect(result.insertAt).toBeNull();
  });

  it("returns no missing habits when all are already present (checked or unchecked)", () => {
    const lines = [heading, "- [x] Morning run #daily ✅ 2026-06-29"];
    const result = computeMissingHabits(lines, [def()], day("2026-06-29"), heading, TAG);
    expect(result.missing).toEqual([]);
  });

  it("reports only the missing ones when some habits are already present", () => {
    const lines = [heading, "- [ ] Morning run #daily"];
    const defs = [def(), def({ id: "id-2", title: "Evening stretch" })];
    const result = computeMissingHabits(lines, defs, day("2026-06-29"), heading, TAG);
    expect(result.missing.map((d) => d.id)).toEqual(["id-2"]);
  });

  it("inserts after the last checklist line in the section, before trailing blank lines / next heading", () => {
    const lines = [heading, "- [ ] Existing habit", "", "# Next section"];
    const result = computeMissingHabits(lines, [def()], day("2026-06-29"), heading, TAG);
    expect(result.insertAt).toBe(2);
  });

  it("inserts at end of file when the section has no trailing heading", () => {
    const lines = [heading, "- [ ] Existing habit"];
    const result = computeMissingHabits(lines, [def()], day("2026-06-29"), heading, TAG);
    expect(result.insertAt).toBe(2);
  });

  it("does not treat a habit whose title contains a '#' as still missing after it's inserted", () => {
    // Regression test: matching used to go through displayTitle(), which strips *every*
    // tag-like substring, not just habitsTag — so a title like "Read #book" would render as
    // "- [ ] Read #book #daily", but the round-trip title comparison stripped both tags down
    // to "Read", never matching the original "Read #book" key, causing perpetual re-insertion.
    const lines = [heading, "- [ ] Read #book #daily"];
    const defs = [def({ title: "Read #book" })];
    const result = computeMissingHabits(lines, defs, day("2026-06-29"), heading, TAG);
    expect(result.missing).toEqual([]);
  });

  it("excludes a definition not scheduled for that weekday even if entirely absent", () => {
    const weekdaysMonToFri = 0b0011111;
    const lines = [heading];
    const result = computeMissingHabits(
      lines,
      [def({ weekdays: weekdaysMonToFri })],
      day("2026-07-05"), // Sunday
      heading,
      TAG,
    );
    expect(result.missing).toEqual([]);
  });

  it("is idempotent: running twice on the resulting content reports nothing missing", () => {
    const lines = [heading, "- [ ] Existing habit"];
    const first = computeMissingHabits(lines, [def()], day("2026-06-29"), heading, TAG);
    expect(first.missing).toHaveLength(1);

    const inserted = lines.slice();
    inserted.splice(first.insertAt!, 0, ...first.missing.flatMap(() => ["- [ ] Morning run #daily"]));
    const second = computeMissingHabits(inserted, [def()], day("2026-06-29"), heading, TAG);
    expect(second.missing).toEqual([]);
  });
});

describe("reorderScheduledHabits", () => {
  const heading = "# Routine";
  const monday = day("2026-06-29");
  const a = def({ id: "a", title: "A", order: 0 });
  const b = def({ id: "b", title: "B", order: 1 });
  const c = def({ id: "c", title: "C", order: 2 });

  it("returns the same reference when the heading is absent", () => {
    const lines = ["- [ ] B #daily", "- [ ] A #daily"];
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toBe(lines);
  });

  it("returns the same reference when fewer than two habits are present", () => {
    const lines = [heading, "- [ ] A #daily"];
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toBe(lines);
  });

  it("returns the same reference when already in order", () => {
    const lines = [heading, "- [ ] A #daily", "- [ ] B #daily"];
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toBe(lines);
  });

  it("reorders habit lines to match definition order", () => {
    const lines = [heading, "- [ ] B #daily", "- [ ] A #daily"];
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toEqual([
      heading,
      "- [ ] A #daily",
      "- [ ] B #daily",
    ]);
  });

  it("respects order derived from the definitions' order field, not the definitions' array order", () => {
    const lines = [heading, "- [ ] A #daily", "- [ ] B #daily", "- [ ] C #daily"];
    const defs = [
      def({ id: "a", title: "A", order: 2 }),
      def({ id: "b", title: "B", order: 0 }),
      def({ id: "c", title: "C", order: 1 }),
    ];
    expect(reorderScheduledHabits(lines, defs, monday, heading, TAG)).toEqual([
      heading,
      "- [ ] B #daily",
      "- [ ] C #daily",
      "- [ ] A #daily",
    ]);
  });

  it("preserves checked state, dates and detail sub-lines of each moved habit", () => {
    const lines = [
      heading,
      "- [x] B #daily ✅ 2026-06-29",
      "\tnote under B",
      "- [ ] A #daily",
    ];
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toEqual([
      heading,
      "- [ ] A #daily",
      "- [x] B #daily ✅ 2026-06-29",
      "\tnote under B",
    ]);
  });

  it("keeps every habit's own comment sub-lines attached to it, not to a neighbour", () => {
    // Each habit carries its own distinctly-worded comment(s); after reordering, each
    // comment block must travel with its own task — never get left behind or reattached
    // to whichever task now occupies its old slot.
    const lines = [
      heading,
      "- [ ] C #daily",
      "\tcomment for C, line 1",
      "\tcomment for C, line 2",
      "- [ ] A #daily",
      "\tcomment for A",
      "- [ ] B #daily",
      "\tcomment for B",
    ];
    expect(reorderScheduledHabits(lines, [a, b, c], monday, heading, TAG)).toEqual([
      heading,
      "- [ ] A #daily",
      "\tcomment for A",
      "- [ ] B #daily",
      "\tcomment for B",
      "- [ ] C #daily",
      "\tcomment for C, line 1",
      "\tcomment for C, line 2",
    ]);
  });

  it("moves a commented habit and leaves a comment-less habit's slot empty of stray notes", () => {
    // Only B has a comment; after A and B swap, B's comment must follow B and A must
    // remain comment-less — i.e. the sub-line count per task is preserved exactly.
    const lines = [
      heading,
      "- [ ] B #daily",
      "\tremember to stretch first",
      "- [ ] A #daily",
    ];
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toEqual([
      heading,
      "- [ ] A #daily",
      "- [ ] B #daily",
      "\tremember to stretch first",
    ]);
  });

  it("preserves nested/deeper-indented comment lines as part of their habit's block", () => {
    const lines = [
      heading,
      "- [ ] B #daily",
      "\tcomment for B",
      "\t\tnested detail under B",
      "- [ ] A #daily",
      "\tcomment for A",
    ];
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toEqual([
      heading,
      "- [ ] A #daily",
      "\tcomment for A",
      "- [ ] B #daily",
      "\tcomment for B",
      "\t\tnested detail under B",
    ]);
  });

  it("only reorders within the routine section, leaving other content untouched", () => {
    const lines = [
      "- [ ] B #daily",
      heading,
      "- [ ] C #daily",
      "- [ ] A #daily",
      "# Other",
      "- [ ] B #daily",
    ];
    expect(reorderScheduledHabits(lines, [a, c], monday, heading, TAG)).toEqual([
      "- [ ] B #daily",
      heading,
      "- [ ] A #daily",
      "- [ ] C #daily",
      "# Other",
      "- [ ] B #daily",
    ]);
  });

  it("leaves interleaved non-habit lines in their positions, filling only habit slots", () => {
    const lines = [heading, "- [ ] C #daily", "some note", "- [ ] A #daily"];
    expect(reorderScheduledHabits(lines, [a, c], monday, heading, TAG)).toEqual([
      heading,
      "- [ ] A #daily",
      "some note",
      "- [ ] C #daily",
    ]);
  });

  it("ignores lines lacking the habits tag even if their title matches a definition", () => {
    const lines = [heading, "- [ ] B #daily", "- [ ] A"];
    // "- [ ] A" has no #daily tag, so it is a passthrough slot; only B is a habit → no reorder.
    expect(reorderScheduledHabits(lines, [a, b], monday, heading, TAG)).toBe(lines);
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
      isOrphanedHabitTask(task, [def({ weekdays: weekdaysMonToFri })], day("2026-07-05"), TAG),
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
