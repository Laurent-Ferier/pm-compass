import { describe, it, expect } from "vitest";
import { DayTask, parseDate } from "./day-task";

// ---------------------------------------------------------------------------
// DayTask.parse — non-task lines
// ---------------------------------------------------------------------------

describe("DayTask.parse", () => {
  describe("non-task lines", () => {
    it("returns null for a plain text line", () => {
      expect(DayTask.parse("Just a heading", 0)).toBeNull();
    });

    it("returns null for a blank line", () => {
      expect(DayTask.parse("", 0)).toBeNull();
    });

    it("returns null for a bullet without a checkbox", () => {
      expect(DayTask.parse("- plain bullet", 0)).toBeNull();
    });

    it("returns null for a heading line", () => {
      expect(DayTask.parse("## Daily", 0)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // checked / unchecked
  // ---------------------------------------------------------------------------

  describe("checked state", () => {
    it("parses an unchecked task", () => {
      const t = DayTask.parse("- [ ] Buy milk", 0)!;
      expect(t.checked).toBe(false);
    });

    it("parses a lowercase-x checked task", () => {
      const t = DayTask.parse("- [x] Buy milk", 0)!;
      expect(t.checked).toBe(true);
    });

    it("parses an uppercase-X checked task", () => {
      const t = DayTask.parse("- [X] Buy milk", 0)!;
      expect(t.checked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // title — metadata stripping
  // ---------------------------------------------------------------------------

  describe("title", () => {
    it("strips a ✅ completion date", () => {
      const t = DayTask.parse("- [x] Buy milk ✅ 2026-06-29", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips a 📅 due date", () => {
      const t = DayTask.parse("- [ ] Buy milk 📅 2026-07-01", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips a ⏳ scheduled date", () => {
      const t = DayTask.parse("- [ ] Buy milk ⏳ 2026-06-30", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips a 🛫 start date", () => {
      const t = DayTask.parse("- [ ] Buy milk 🛫 2026-06-28", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips a ➕ created date", () => {
      const t = DayTask.parse("- [ ] Buy milk ➕ 2026-06-01", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips a priority emoji without a date", () => {
      const t = DayTask.parse("- [ ] Buy milk ⏫", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips a 🔁 recurrence marker but keeps subsequent text", () => {
      const t = DayTask.parse("- [ ] Morning run 🔁 every day", 0)!;
      expect(t.title).toBe("Morning run every day");
    });

    it("strips a dataview bracket field [key:: value]", () => {
      const t = DayTask.parse("- [ ] Buy milk [project:: Home]", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips a dataview paren field (key:: value)", () => {
      const t = DayTask.parse("- [ ] Buy milk (due:: 2026-07-01)", 0)!;
      expect(t.title).toBe("Buy milk");
    });

    it("strips multiple metadata fields and collapses whitespace", () => {
      const t = DayTask.parse("- [x] Run 🔺 ➕ 2026-06-01 ✅ 2026-06-29", 0)!;
      expect(t.title).toBe("Run");
    });

    it("preserves hashtags in the title", () => {
      const t = DayTask.parse("- [ ] Morning run #daily", 0)!;
      expect(t.title).toBe("Morning run #daily");
    });

    it("preserves indented tasks", () => {
      const t = DayTask.parse("  - [ ] Nested task", 0)!;
      expect(t.title).toBe("Nested task");
    });
  });

  // ---------------------------------------------------------------------------
  // date fields
  // ---------------------------------------------------------------------------

  describe("date fields", () => {
    it("extracts createdAt from ➕", () => {
      expect(DayTask.parse("- [ ] Task ➕ 2026-06-01", 0)!.createdAt).toEqual(parseDate("2026-06-01"));
    });

    it("extracts completedAt from ✅", () => {
      expect(DayTask.parse("- [x] Task ✅ 2026-06-29", 0)!.completedAt).toEqual(parseDate("2026-06-29"));
    });

    it("extracts dueDate from 📅", () => {
      expect(DayTask.parse("- [ ] Task 📅 2026-07-15", 0)!.dueDate).toEqual(parseDate("2026-07-15"));
    });

    it("extracts scheduledDate from ⏳", () => {
      expect(DayTask.parse("- [ ] Task ⏳ 2026-07-10", 0)!.scheduledDate).toEqual(parseDate("2026-07-10"));
    });

    it("extracts startDate from 🛫", () => {
      expect(DayTask.parse("- [ ] Task 🛫 2026-07-05", 0)!.startDate).toEqual(parseDate("2026-07-05"));
    });

    it("returns null for all date fields when absent", () => {
      const t = DayTask.parse("- [ ] Plain task", 0)!;
      expect(t.createdAt).toBeNull();
      expect(t.completedAt).toBeNull();
      expect(t.dueDate).toBeNull();
      expect(t.scheduledDate).toBeNull();
      expect(t.startDate).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // priority
  // ---------------------------------------------------------------------------

  describe("priority", () => {
    it.each([
      ["🔺", "critical"],
      ["⏫", "high"],
      ["🔼", "medium"],
      ["🔽", "low"],
      ["⏬", "lowest"],
    ])("maps %s to %s", (emoji, name) => {
      expect(DayTask.parse(`- [ ] Task ${emoji}`, 0)!.priority).toBe(name);
    });

    it("returns null when no priority emoji is present", () => {
      expect(DayTask.parse("- [ ] Plain task", 0)!.priority).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // tags
  // ---------------------------------------------------------------------------

  describe("tags", () => {
    it("extracts a single hashtag", () => {
      expect(DayTask.parse("- [ ] Morning run #daily", 0)!.tags).toEqual(["#daily"]);
    });

    it("extracts multiple hashtags", () => {
      expect(DayTask.parse("- [ ] Task #daily #health", 0)!.tags).toEqual(["#daily", "#health"]);
    });

    it("returns an empty array when no tags are present", () => {
      expect(DayTask.parse("- [ ] Plain task", 0)!.tags).toEqual([]);
    });

    it("does not extract tags that were part of stripped metadata", () => {
      // The emoji markers are stripped before tag extraction, so no phantom tags.
      const t = DayTask.parse("- [x] Task #daily ✅ 2026-06-29", 0)!;
      expect(t.tags).toEqual(["#daily"]);
    });
  });

  // ---------------------------------------------------------------------------
  // rawLine and lineIndex
  // ---------------------------------------------------------------------------

  describe("rawLine and lineIndex", () => {
    it("preserves the original raw line including metadata", () => {
      const raw = "- [x] Buy milk ✅ 2026-06-29";
      expect(DayTask.parse(raw, 3)!.rawLine).toBe(raw);
    });

    it("stores the provided lineIndex", () => {
      expect(DayTask.parse("- [ ] Task", 7)!.lineIndex).toBe(7);
    });
  });
});

// ---------------------------------------------------------------------------
// DayTask.toUncheckedLine
// ---------------------------------------------------------------------------

describe("DayTask.toUncheckedLine", () => {
  it("converts [x] to [ ]", () => {
    expect(DayTask.toUncheckedLine("- [x] Task")).toBe("- [ ] Task");
  });

  it("converts uppercase [X] to [ ]", () => {
    expect(DayTask.toUncheckedLine("- [X] Task")).toBe("- [ ] Task");
  });

  it("strips a ✅ date appended by the plugin", () => {
    expect(DayTask.toUncheckedLine("- [x] Task ✅ 2026-06-29")).toBe("- [ ] Task");
  });

  it("strips ✅ date including the leading space", () => {
    const result = DayTask.toUncheckedLine("- [x] Task ✅ 2026-06-29");
    expect(result.endsWith(" ")).toBe(false);
  });

  it("handles indented tasks", () => {
    expect(DayTask.toUncheckedLine("  - [x] Task ✅ 2026-06-29")).toBe("  - [ ] Task");
  });

  it("leaves already-unchecked lines unchanged (no ✅)", () => {
    expect(DayTask.toUncheckedLine("- [ ] Task")).toBe("- [ ] Task");
  });
});

// ---------------------------------------------------------------------------
// DayTask.toCheckedLine
// ---------------------------------------------------------------------------

describe("DayTask.toCheckedLine", () => {
  it("converts [ ] to [x]", () => {
    expect(DayTask.toCheckedLine("- [ ] Task", parseDate("2026-06-30"))).toBe("- [x] Task ✅ 2026-06-30");
  });

  it("appends the formatted date", () => {
    expect(DayTask.toCheckedLine("- [ ] Task", parseDate("2099-12-31"))).toContain("✅ 2099-12-31");
  });

  it("handles indented tasks", () => {
    expect(DayTask.toCheckedLine("  - [ ] Task", parseDate("2026-06-30"))).toBe("  - [x] Task ✅ 2026-06-30");
  });

  it("preserves metadata already present in the line", () => {
    const raw = "- [ ] Review PR #work 📅 2026-07-05";
    expect(DayTask.toCheckedLine(raw, parseDate("2026-06-30"))).toBe("- [x] Review PR #work 📅 2026-07-05 ✅ 2026-06-30");
  });
});

// ---------------------------------------------------------------------------
// DayTask.matchAllTags
// ---------------------------------------------------------------------------

describe("DayTask.displayTitle", () => {
  it("strips the habits tag from the title", () => {
    expect(DayTask.parse("- [ ] Morning run #daily", 0)!.displayTitle("daily")).toBe("Morning run");
  });

  it("strips all tags from the title", () => {
    expect(DayTask.parse("- [ ] Task #daily #work", 0)!.displayTitle("daily")).toBe("Task");
  });

  it("strips a prefix-similar tag (#dailyish is still stripped as a tag)", () => {
    expect(DayTask.parse("- [ ] Read 30 min #dailyish", 0)!.displayTitle("daily")).toBe("Read 30 min");
  });

  it("returns title unchanged when habits tag is absent", () => {
    expect(DayTask.parse("- [ ] Plain task", 0)!.displayTitle("daily")).toBe("Plain task");
  });

  it("respects a non-default habits tag", () => {
    expect(DayTask.parse("- [ ] Meditate #habit", 0)!.displayTitle("habit")).toBe("Meditate");
  });

  it("accepts a tag argument with a leading #", () => {
    expect(DayTask.parse("- [ ] Morning run #daily", 0)!.displayTitle("#daily")).toBe("Morning run");
  });
});

describe("DayTask.habitMatchTitle", () => {
  it("strips only the habits tag, unlike displayTitle it leaves other tags in place", () => {
    expect(DayTask.parse("- [ ] Read #book #daily", 0)!.habitMatchTitle("daily")).toBe("Read #book");
  });

  it("returns title unchanged when the habits tag is absent", () => {
    expect(DayTask.parse("- [ ] Plain task", 0)!.habitMatchTitle("daily")).toBe("Plain task");
  });
});

describe("DayTask.create", () => {
  it("creates an unchecked task with the given title and createdAt", () => {
    const d = parseDate("2026-07-01");
    const t = DayTask.create("Buy milk", d);
    expect(t.title).toBe("Buy milk");
    expect(t.checked).toBe(false);
    expect(t.createdAt).toEqual(d);
  });

  it("builds the correct rawLine", () => {
    expect(DayTask.create("Buy milk", parseDate("2026-07-01")).rawLine).toBe("- [ ] Buy milk ➕ 2026-07-01");
  });

  it("extracts tags from the title", () => {
    expect(DayTask.create("Morning run #daily", parseDate("2026-07-01")).tags).toEqual(["#daily"]);
  });

  it("sets all other date and priority fields to null", () => {
    const t = DayTask.create("Task", parseDate("2026-07-01"));
    expect(t.completedAt).toBeNull();
    expect(t.dueDate).toBeNull();
    expect(t.scheduledDate).toBeNull();
    expect(t.startDate).toBeNull();
    expect(t.priority).toBeNull();
  });

  it("defaults subLines to []", () => {
    expect(DayTask.create("Task", parseDate("2026-07-01")).subLines).toEqual([]);
  });
});

describe("DayTask.matchAllTags", () => {
  it("returns an empty array for text with no tags", () => {
    expect(DayTask.matchAllTags("Morning run")).toHaveLength(0);
  });

  it("returns a match for a single tag", () => {
    const matches = DayTask.matchAllTags("Morning run #daily");
    expect(matches).toHaveLength(1);
    expect(matches[0][0]).toBe("#daily");
  });

  it("returns matches for multiple tags", () => {
    const matches = DayTask.matchAllTags("Task #daily #health");
    expect(matches.map((m) => m[0])).toEqual(["#daily", "#health"]);
  });

  it("includes the correct index for each match", () => {
    const text = "fix #bug today";
    const matches = DayTask.matchAllTags(text);
    expect(matches[0].index).toBe(4);
  });

  it("is idempotent — successive calls return the same results", () => {
    const text = "Run #daily";
    const first = DayTask.matchAllTags(text).map((m) => m[0]);
    const second = DayTask.matchAllTags(text).map((m) => m[0]);
    expect(first).toEqual(second);
  });

  it("does not match a lone #", () => {
    expect(DayTask.matchAllTags("hash # alone")).toHaveLength(0);
  });
});
