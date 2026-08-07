import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  Notice: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import {
  parseTasksFromLines,
  withChecked,
  withGroupUnderHeading,
  withPrioritySet,
  withScheduledDateSet,
  withSubLinesSet,
  withTaskAdded,
  withTaskMovedBefore,
  withTitleSet,
  withoutCheckedTasks,
  withoutTask,
} from "./day-note-lines";
import { Task } from "../daily/task";
import { day } from "../__testing__/dates";
import { Priority } from "../base-task";

/** A note's content as the lines a pass is handed. A file that isn't there reads as none,
 *  which is what `[]` stands for below. */
function lines(content: string): string[] {
  return content.split("\n");
}

/** What those lines would be written back as. */
function text(written: string[] | null): string | null {
  return written === null ? null : written.join("\n");
}

function task(line: string, idx = 0): Task {
  return Task.parse(line, idx)!;
}

// ---------------------------------------------------------------------------
// parseTasksFromLines
// ---------------------------------------------------------------------------

describe("parseTasksFromLines", () => {
  it("finds nothing in a note with no lines", () => {
    expect(parseTasksFromLines([])).toEqual([]);
  });

  it("skips non-task lines", () => {
    expect(parseTasksFromLines(lines("# Heading\n\nsome text\n- plain bullet"))).toHaveLength(0);
  });

  it("parses tasks and assigns correct lineIndex", () => {
    const tasks = parseTasksFromLines(lines("# Day\n- [ ] Task A\n- [x] Task B ✅ 2026-06-30"));
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Task A");
    expect(tasks[0].lineIndex).toBe(1);
    expect(tasks[1].lineIndex).toBe(2);
  });

  it("populates subLines for each task from surrounding indented lines", () => {
    const tasks = parseTasksFromLines(lines("- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B"));
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(tasks[1].subLines).toEqual([]);
  });

  it("does not include sub-lines as separate tasks", () => {
    const tasks = parseTasksFromLines(lines("- [ ] Parent\n  - [ ] Nested"));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subLines).toEqual(["  - [ ] Nested"]);
  });

  it("stamps each task with the note it was read from", () => {
    const tasks = parseTasksFromLines(lines("- [ ] Task A"), "Journal/2026-07-01.md");
    expect(tasks[0].filePath).toBe("Journal/2026-07-01.md");
  });
});

// ---------------------------------------------------------------------------
// withoutTask
// ---------------------------------------------------------------------------

describe("withoutTask", () => {
  it("writes nothing and reports nothing when the task is not found", () => {
    const pass = withoutTask(lines("- [ ] Other"), task("- [ ] Missing"));
    expect(pass.write).toBeNull();
    expect(pass.result).toBeNull();
  });

  it("drops the task and hands it back", () => {
    const pass = withoutTask(lines("- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma"), task("- [ ] Beta", 1));
    expect(pass.result!.title).toBe("Beta");
    expect(pass.result!.subLines).toEqual([]);
    expect(text(pass.write)).toBe("- [ ] Alpha\n- [ ] Gamma");
  });

  it("includes indented sub-lines in the task it hands back", () => {
    const pass = withoutTask(lines("- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B"), task("- [ ] Task A"));
    expect(pass.result!.subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(text(pass.write)).toBe("- [ ] Task B");
  });

  it("stops sub-line collection at a blank line", () => {
    const pass = withoutTask(lines("- [ ] Task A\n  sub\n\n  unrelated\n- [ ] Task B"), task("- [ ] Task A"));
    expect(pass.result!.subLines).toEqual(["  sub"]);
    expect(text(pass.write)).toBe("\n  unrelated\n- [ ] Task B");
  });

  it("falls back to rawLine when lineIndex is stale", () => {
    const pass = withoutTask(lines("- [ ] Inserted above\n- [ ] Target task"), task("- [ ] Target task", 0));
    expect(pass.result!.title).toBe("Target task");
    expect(text(pass.write)).toBe("- [ ] Inserted above");
  });

  it("refuses to guess by substring when neither lineIndex nor rawLine match", () => {
    // "- [ ] Morning run" is a substring of the actual line but not an exact match — matching
    // by substring risks deleting an unrelated task (e.g. "- [ ] Morning run at the gym"), so
    // resolveIndex must refuse to guess here rather than fall back to a `.includes()` search.
    const pass = withoutTask(lines("- [ ] Morning run #daily"), task("- [ ] Morning run", 5));
    expect(pass.result).toBeNull();
    expect(pass.write).toBeNull();
  });

  it("stamps the task it hands back with the note it came out of", () => {
    const pass = withoutTask(lines("- [ ] Alpha"), task("- [ ] Alpha"), "Inbox.md");
    expect(pass.result!.filePath).toBe("Inbox.md");
  });
});

// ---------------------------------------------------------------------------
// withoutCheckedTasks
// ---------------------------------------------------------------------------

describe("withoutCheckedTasks", () => {
  it("writes nothing and reports every task when none is checked", () => {
    const pass = withoutCheckedTasks(lines("- [ ] A\n- [ ] B"));
    expect(pass.write).toBeNull();
    expect(pass.result).toHaveLength(2);
  });

  it("drops the checked ones and reports what is left in file order", () => {
    const pass = withoutCheckedTasks(lines("- [ ] Keep\n- [x] Done ✅ 2026-06-30\n- [ ] Also keep"));
    expect(pass.result.map((t) => t.title)).toEqual(["Keep", "Also keep"]);
    expect(text(pass.write)).not.toContain("Done");
  });

  it("also drops the sub-lines of a checked task", () => {
    const pass = withoutCheckedTasks(lines("- [x] Done ✅ 2026-06-30\n  sub-note\n- [ ] Remaining"));
    expect(text(pass.write)).toBe("- [ ] Remaining");
  });

  it("reports nothing for a note with no lines", () => {
    expect(withoutCheckedTasks([]).result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// withTaskAdded
// ---------------------------------------------------------------------------

describe("withTaskAdded", () => {
  it("appends a task at the end when insertAt is omitted", () => {
    expect(text(withTaskAdded(lines("- [ ] A"), task("- [ ] B")))).toBe("- [ ] A\n- [ ] B");
  });

  it("is the whole note when there are no lines yet", () => {
    expect(text(withTaskAdded([], task("- [ ] First")))).toBe("- [ ] First");
  });

  it("appends without a leading blank when the note is empty", () => {
    expect(text(withTaskAdded([""], task("- [ ] First")))).toBe("- [ ] First");
  });

  it("appends the task with its subLines", () => {
    const t = task("- [ ] B").withSubLines(["  sub 1", "  sub 2"]);
    expect(text(withTaskAdded(lines("- [ ] A"), t))).toBe("- [ ] A\n- [ ] B\n  sub 1\n  sub 2");
  });

  it("takes a brand-new task built with create + withSubLines", () => {
    const t = Task.create("New task", day("2026-07-01")).withSubLines(["  - note A", "  - note B"]);
    expect(text(withTaskAdded(lines("- [ ] Existing"), t)))
      .toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01\n  - note A\n  - note B");
  });

  it("trims trailing blank lines before appending", () => {
    expect(text(withTaskAdded(lines("- [ ] A\n"), task("- [ ] B")))).toBe("- [ ] A\n- [ ] B");
  });

  it("inserts at the beginning when insertAt is 0", () => {
    expect(text(withTaskAdded(lines("- [ ] B\n- [ ] C"), task("- [ ] A"), 0)))
      .toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("inserts in the middle when insertAt is given", () => {
    expect(text(withTaskAdded(lines("- [ ] A\n- [ ] C"), task("- [ ] B"), 1)))
      .toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("clamps an out-of-bounds insertAt to the end", () => {
    expect(text(withTaskAdded(lines("- [ ] A"), task("- [ ] B"), 999))).toBe("- [ ] A\n- [ ] B");
  });
});

// ---------------------------------------------------------------------------
// withGroupUnderHeading
// ---------------------------------------------------------------------------

describe("withGroupUnderHeading", () => {
  it("inserts the group at the end of the heading's section", () => {
    const written = withGroupUnderHeading(lines("# Tasks\n- [ ] Existing\n# Notes\nSome note"), ["- [ ] New"], "# Tasks");
    expect(text(written)).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n# Notes\nSome note");
  });

  it("inserts a multi-line group (task + subLines) together", () => {
    const written = withGroupUnderHeading(
      lines("# Tasks\n- [ ] Existing\n# Notes"), ["- [ ] New", "  sub 1", "  sub 2"], "# Tasks",
    );
    expect(text(written)).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n  sub 1\n  sub 2\n# Notes");
  });

  it("appends the heading and the group at EOF when the heading is absent", () => {
    const written = withGroupUnderHeading(lines("# Notes\nSome note"), ["- [ ] New"], "# Tasks");
    expect(text(written)).toBe("# Notes\nSome note\n\n# Tasks\n- [ ] New");
  });

  it("inserts before trailing blank lines within the heading's section", () => {
    const written = withGroupUnderHeading(lines("# Tasks\n- [ ] Existing\n\n\n# Notes"), ["- [ ] New"], "# Tasks");
    expect(text(written)).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n\n\n# Notes");
  });

  it("writes the heading and the group into a note with no lines", () => {
    expect(text(withGroupUnderHeading([], ["- [ ] New"], "# Tasks"))).toBe("\n# Tasks\n- [ ] New");
  });
});

// ---------------------------------------------------------------------------
// withTaskMovedBefore
// ---------------------------------------------------------------------------

describe("withTaskMovedBefore", () => {
  it("moves a task down, in front of the anchor", () => {
    const written = withTaskMovedBefore(lines("- [ ] A\n- [ ] B\n- [ ] C"), task("- [ ] A"), task("- [ ] C", 2));
    expect(text(written)).toBe("- [ ] B\n- [ ] A\n- [ ] C");
  });

  it("moves a task up, in front of the anchor", () => {
    const written = withTaskMovedBefore(lines("- [ ] A\n- [ ] B\n- [ ] C"), task("- [ ] C", 2), task("- [ ] A"));
    expect(text(written)).toBe("- [ ] C\n- [ ] A\n- [ ] B");
  });

  it("moves the whole group, sub-lines included, and lands before the anchor's own group", () => {
    const written = withTaskMovedBefore(
      lines("- [ ] A\n\tsub A\n- [ ] B\n\tsub B\n- [ ] C"), task("- [ ] C", 4), task("- [ ] B", 2),
    );
    expect(text(written)).toBe("- [ ] A\n\tsub A\n- [ ] C\n- [ ] B\n\tsub B");
  });

  it("appends after the last task when the anchor is null", () => {
    const written = withTaskMovedBefore(lines("- [ ] A\n- [ ] B\n- [ ] C"), task("- [ ] A"), null);
    expect(text(written)).toBe("- [ ] B\n- [ ] C\n- [ ] A");
  });

  it("keeps a null-anchor move above trailing non-task content", () => {
    const written = withTaskMovedBefore(
      lines("# Tasks\n- [ ] A\n- [ ] B\n\tsub B\n\n## Notes\nsomething"), task("- [ ] A", 1), null,
    );
    expect(text(written)).toBe("# Tasks\n- [ ] B\n\tsub B\n- [ ] A\n\n## Notes\nsomething");
  });

  it("locates the task by its raw line when lineIndex is stale", () => {
    const written = withTaskMovedBefore(lines("- [ ] A\n- [ ] B\n- [ ] C"), task("- [ ] C", 99), task("- [ ] B", 42));
    expect(text(written)).toBe("- [ ] A\n- [ ] C\n- [ ] B");
  });

  // The anchor's index is only meaningful in the file as read: resolving it after the
  // moved group is spliced out would fall back to a rawLine match and pick the first of
  // two same-titled tasks rather than the one actually dropped onto.
  it("anchors on the right one of two tasks sharing a line", () => {
    const written = withTaskMovedBefore(
      lines("- [ ] A\n- [ ] X\n\tnote 1\n- [ ] X\n\tnote 2"), task("- [ ] A"), task("- [ ] X", 3),
    );
    expect(text(written)).toBe("- [ ] X\n\tnote 1\n- [ ] A\n- [ ] X\n\tnote 2");
  });

  it("writes nothing when the anchor sits inside the moved group", () => {
    const written = withTaskMovedBefore(lines("- [ ] A\n\t- [ ] sub\n- [ ] B"), task("- [ ] A"), task("\t- [ ] sub", 1));
    expect(written).toBeNull();
  });

  it("writes nothing when the task is not found", () => {
    expect(withTaskMovedBefore(lines("- [ ] A\n- [ ] B"), task("- [ ] Missing", 5), task("- [ ] A"))).toBeNull();
  });

  it("writes nothing when the anchor is not found", () => {
    expect(withTaskMovedBefore(lines("- [ ] A\n- [ ] B"), task("- [ ] B", 1), task("- [ ] Missing", 5))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withChecked
// ---------------------------------------------------------------------------

describe("withChecked", () => {
  it("marks the task as done and appends the date", () => {
    const pass = withChecked(lines("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), day("2026-07-01"));
    expect(text(pass.write)).toBe("- [x] Alpha ✅ 2026-07-01\n- [ ] Beta");
  });

  it("does not modify sub-lines", () => {
    const pass = withChecked(lines("- [ ] Task\n  sub-note"), task("- [ ] Task"), day("2026-07-01"));
    expect(text(pass.write)).toContain("  sub-note");
  });

  it("marks the task as undone and strips the ✅ date when given no date", () => {
    const pass = withChecked(lines("- [x] Alpha ✅ 2026-06-30\n- [ ] Beta"), task("- [x] Alpha ✅ 2026-06-30"), null);
    expect(text(pass.write)).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("falls back to rawLine when lineIndex is stale", () => {
    const pass = withChecked(
      lines("- [ ] Inserted\n- [x] Done ✅ 2026-06-30"), task("- [x] Done ✅ 2026-06-30", 0), null,
    );
    expect(text(pass.write)).toBe("- [ ] Inserted\n- [ ] Done");
  });

  it("writes nothing and reports the task missing when it can no longer be found", () => {
    const pass = withChecked(lines("- [ ] Beta"), task("- [ ] Alpha"), day("2026-07-01"));
    expect(pass.write).toBeNull();
    expect(pass.result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withTitleSet
// ---------------------------------------------------------------------------

describe("withTitleSet", () => {
  it("replaces the title, leaving other lines untouched", () => {
    const pass = withTitleSet(lines("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), "Alpha renamed");
    expect(text(pass.write)).toBe("- [ ] Alpha renamed\n- [ ] Beta");
  });

  it("preserves trailing metadata and the checked state", () => {
    const pass = withTitleSet(lines("- [x] Alpha ✅ 2026-06-30"), task("- [x] Alpha ✅ 2026-06-30"), "Alpha renamed");
    expect(text(pass.write)).toBe("- [x] Alpha renamed ✅ 2026-06-30");
  });

  it("does not modify sub-lines", () => {
    const pass = withTitleSet(lines("- [ ] Alpha\n  sub-note"), task("- [ ] Alpha"), "Alpha renamed");
    expect(text(pass.write)).toContain("  sub-note");
  });

  it("writes nothing when the task can't be found", () => {
    const pass = withTitleSet(lines("- [ ] Alpha"), task("- [ ] Missing"), "New title");
    expect(pass.write).toBeNull();
    expect(pass.result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withScheduledDateSet
// ---------------------------------------------------------------------------

describe("withScheduledDateSet", () => {
  const JULY_9 = new Date(2026, 6, 9);

  it("adds a target date, leaving other lines untouched", () => {
    const pass = withScheduledDateSet(lines("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), JULY_9);
    expect(text(pass.write)).toBe("- [ ] Alpha ⏳ 2026-07-09\n- [ ] Beta");
  });

  it("clears the target date when given null", () => {
    const pass = withScheduledDateSet(lines("- [ ] Alpha ⏳ 2026-07-09"), task("- [ ] Alpha ⏳ 2026-07-09"), null);
    expect(text(pass.write)).toBe("- [ ] Alpha");
  });

  it("writes nothing when the date is already the one asked for", () => {
    const pass = withScheduledDateSet(lines("- [ ] Alpha ⏳ 2026-07-09"), task("- [ ] Alpha ⏳ 2026-07-09"), JULY_9);
    expect(pass.write).toBeNull();
    // Nothing to write, but the task is there and carries the date — the caller's ask holds.
    expect(pass.result).toBe(true);
  });

  it("reports the task as found when it sets the date", () => {
    expect(withScheduledDateSet(lines("- [ ] Alpha"), task("- [ ] Alpha"), JULY_9).result).toBe(true);
  });

  it("reports the task as missing when it can't be found", () => {
    expect(withScheduledDateSet(lines("- [ ] Alpha"), task("- [ ] Missing"), JULY_9).result).toBe(false);
  });

  it("does not modify sub-lines", () => {
    const pass = withScheduledDateSet(lines("- [ ] Alpha\n\tsub-note"), task("- [ ] Alpha"), JULY_9);
    expect(text(pass.write)).toBe("- [ ] Alpha ⏳ 2026-07-09\n\tsub-note");
  });
});

// ---------------------------------------------------------------------------
// withPrioritySet
// ---------------------------------------------------------------------------

describe("withPrioritySet", () => {
  it("adds a priority marker, leaving other lines untouched", () => {
    const pass = withPrioritySet(lines("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), Priority.High);
    expect(text(pass.write)).toBe("- [ ] Alpha ⏫\n- [ ] Beta");
  });

  it("replaces an existing marker", () => {
    const pass = withPrioritySet(
      lines("- [ ] Alpha 🔽 ➕ 2026-06-30"), task("- [ ] Alpha 🔽 ➕ 2026-06-30"), Priority.Critical,
    );
    expect(text(pass.write)).toBe("- [ ] Alpha 🔺 ➕ 2026-06-30");
  });

  it("clears the marker when given an empty priority", () => {
    const pass = withPrioritySet(lines("- [ ] Alpha ⏫"), task("- [ ] Alpha ⏫"), Priority.None);
    expect(text(pass.write)).toBe("- [ ] Alpha");
  });

  it("does not modify sub-lines", () => {
    const pass = withPrioritySet(lines("- [ ] Alpha\n\tsub-note"), task("- [ ] Alpha"), Priority.Medium);
    expect(text(pass.write)).toBe("- [ ] Alpha 🔼\n\tsub-note");
  });

  it("writes nothing when the task can't be found", () => {
    expect(withPrioritySet(lines("- [ ] Alpha"), task("- [ ] Missing"), Priority.High).write).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withSubLinesSet
// ---------------------------------------------------------------------------

describe("withSubLinesSet", () => {
  it("adds sub-lines to a task that has none", () => {
    const written = withSubLinesSet(lines("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), "note 1\nnote 2");
    expect(text(written)).toBe("- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta");
  });

  it("replaces existing sub-lines", () => {
    const written = withSubLinesSet(lines("- [ ] Alpha\n\told note\n- [ ] Beta"), task("- [ ] Alpha"), "new note");
    expect(text(written)).toBe("- [ ] Alpha\n\tnew note\n- [ ] Beta");
  });

  it("clears all sub-lines when given an empty string", () => {
    const written = withSubLinesSet(lines("- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta"), task("- [ ] Alpha"), "");
    expect(text(written)).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("drops a blank line, which the next read would take for the end of the block", () => {
    const written = withSubLinesSet(lines("- [ ] Alpha"), task("- [ ] Alpha"), "note 1\n\nnote 2");
    expect(text(written)).toBe("- [ ] Alpha\n\tnote 1\n\tnote 2");
  });

  it("leaves other lines untouched", () => {
    const written = withSubLinesSet(lines("- [ ] Alpha\n- [ ] Beta\n\tbeta note"), task("- [ ] Alpha"), "alpha note");
    expect(text(written)).toBe("- [ ] Alpha\n\talpha note\n- [ ] Beta\n\tbeta note");
  });

  it("writes nothing when the task can't be found", () => {
    expect(withSubLinesSet(lines("- [ ] Alpha"), task("- [ ] Missing"), "note")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-note move: withoutTask → withTaskAdded
// ---------------------------------------------------------------------------

describe("cross-note move (withoutTask → withTaskAdded)", () => {
  it("transfers task + sub-lines from one note to another", () => {
    const removal = withoutTask(lines("- [ ] Task\n  sub-line\n- [ ] Other"), task("- [ ] Task"));
    expect(text(removal.write)).toBe("- [ ] Other");
    expect(text(withTaskAdded(lines("- [ ] Existing"), removal.result!)))
      .toBe("- [ ] Existing\n- [ ] Task\n  sub-line");
  });

  it("lands in a note that has no lines yet", () => {
    const removal = withoutTask(lines("- [ ] Only task"), task("- [ ] Only task"));
    expect(text(withTaskAdded([], removal.result!))).toBe("- [ ] Only task");
  });
});

// ---------------------------------------------------------------------------
// Task.withSubLines
// ---------------------------------------------------------------------------

describe("Task.withSubLines", () => {
  it("returns a new task with the given sub-lines", () => {
    const t = Task.parse("- [ ] Task", 0)!;
    const withSubs = t.withSubLines(["  note 1", "  note 2"]);
    expect(withSubs.subLines).toEqual(["  note 1", "  note 2"]);
  });

  it("preserves all other fields", () => {
    const t = Task.parse("- [x] Task ✅ 2026-07-01 #tag", 3)!;
    const withSubs = t.withSubLines(["  note"]);
    expect(withSubs.title).toBe("Task #tag");
    expect(withSubs.checked).toBe(true);
    expect(withSubs.completedAt).toEqual(day("2026-07-01"));
    expect(withSubs.lineIndex).toBe(3);
    expect(withSubs.rawLine).toBe(t.rawLine);
  });

  it("parse() defaults subLines to []", () => {
    expect(Task.parse("- [ ] Task", 0)!.subLines).toEqual([]);
  });
});
