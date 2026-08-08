import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  Notice: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { parseTasksFromLines } from "./task-io";
import { Task } from "../daily/task";
import { day } from "../__testing__/dates";
import { makeDayVault } from "../__testing__/day-vault";
import { Priority } from "../base-task";

const PATH = "Journal/2026-07-01.md";

/**
 * A note over an in-memory vault holding `content` — null for one that isn't there, which
 * reads as no lines at all. `text()` is what the file says now, `wrote` whether the pass
 * wrote at all: a change that changes nothing must leave the file, and the views, alone.
 */
function noteWith(content: string | null, otherFiles: Record<string, string> = {}) {
  const files = content === null ? otherFiles : { [PATH]: content, ...otherFiles };
  const { store, writes, files: notes } = makeDayVault(files);
  return {
    note: notes.file(PATH),
    notes,
    text: (path = PATH) => store.get(path) ?? null,
    wrote: (path = PATH) => writes.includes(path),
  };
}

function task(line: string, idx = 0): Task {
  return Task.parse(line, idx)!;
}

/**
 * A note for the `withLine*` group, which is handed lines and hands lines back without going
 * near the file — so one note serves every case and the lines come from the test itself.
 */
const lineEdits = noteWith(null).note;

/** What such a pass made of a note, written back out — null for lines it left alone. */
function edited(out: string[] | null): string | null {
  return out?.join("\n") ?? null;
}

function linesOf(content: string): string[] {
  return content.split("\n");
}

// ---------------------------------------------------------------------------
// parseTasksFromLines
// ---------------------------------------------------------------------------

describe("parseTasksFromLines", () => {
  const lines = (content: string) => content.split("\n");

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
// removeLine
// ---------------------------------------------------------------------------

describe("TaskIO.removeLine", () => {
  it("writes nothing and reports nothing when the task is not found", async () => {
    const f = noteWith("- [ ] Other");
    expect(await f.note.removeLine(task("- [ ] Missing"))).toBeNull();
    expect(f.wrote()).toBe(false);
  });

  it("drops the task and hands it back", async () => {
    const f = noteWith("- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma");
    const removed = await f.note.removeLine(task("- [ ] Beta", 1));
    expect(removed!.title).toBe("Beta");
    expect(removed!.subLines).toEqual([]);
    expect(f.text()).toBe("- [ ] Alpha\n- [ ] Gamma");
  });

  it("includes indented sub-lines in the task it hands back", async () => {
    const f = noteWith("- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B");
    const removed = await f.note.removeLine(task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(f.text()).toBe("- [ ] Task B");
  });

  it("stops sub-line collection at a blank line", async () => {
    const f = noteWith("- [ ] Task A\n  sub\n\n  unrelated\n- [ ] Task B");
    const removed = await f.note.removeLine(task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub"]);
    expect(f.text()).toBe("\n  unrelated\n- [ ] Task B");
  });

  it("falls back to rawLine when lineIndex is stale", async () => {
    const f = noteWith("- [ ] Inserted above\n- [ ] Target task");
    const removed = await f.note.removeLine(task("- [ ] Target task", 0));
    expect(removed!.title).toBe("Target task");
    expect(f.text()).toBe("- [ ] Inserted above");
  });

  it("refuses to guess by substring when neither lineIndex nor rawLine match", async () => {
    // "- [ ] Morning run" is a substring of the actual line but not an exact match — matching
    // by substring risks deleting an unrelated task (e.g. "- [ ] Morning run at the gym"), so
    // resolveIndex must refuse to guess here rather than fall back to a `.includes()` search.
    const f = noteWith("- [ ] Morning run #daily");
    expect(await f.note.removeLine(task("- [ ] Morning run", 5))).toBeNull();
    expect(f.wrote()).toBe(false);
  });

  it("stamps the task it hands back with the note it came out of", async () => {
    const f = noteWith("- [ ] Alpha");
    expect((await f.note.removeLine(task("- [ ] Alpha")))!.filePath).toBe(PATH);
  });
});

// ---------------------------------------------------------------------------
// pruneChecked
// ---------------------------------------------------------------------------

describe("TaskIO.pruneChecked", () => {
  it("writes nothing and reports every task when none is checked", async () => {
    const f = noteWith("- [ ] A\n- [ ] B");
    expect(await f.note.pruneChecked()).toHaveLength(2);
    expect(f.wrote()).toBe(false);
  });

  it("drops the checked ones and reports what is left in file order", async () => {
    const f = noteWith("- [ ] Keep\n- [x] Done ✅ 2026-06-30\n- [ ] Also keep");
    const left = await f.note.pruneChecked();
    expect(left.map((t) => t.title)).toEqual(["Keep", "Also keep"]);
    expect(f.text()).not.toContain("Done");
  });

  it("also drops the sub-lines of a checked task", async () => {
    const f = noteWith("- [x] Done ✅ 2026-06-30\n  sub-note\n- [ ] Remaining");
    await f.note.pruneChecked();
    expect(f.text()).toBe("- [ ] Remaining");
  });

  it("reports nothing for a note that isn't there", async () => {
    expect(await noteWith(null).note.pruneChecked()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// addLine
// ---------------------------------------------------------------------------

describe("TaskIO.addLine", () => {
  it("appends a task at the end when insertAt is omitted", async () => {
    const f = noteWith("- [ ] A");
    await f.note.addLine(task("- [ ] B"));
    expect(f.text()).toBe("- [ ] A\n- [ ] B");
  });

  it("is the whole note when there are no lines yet", async () => {
    const f = noteWith(null);
    await f.note.addLine(task("- [ ] First"));
    expect(f.text()).toBe("- [ ] First");
  });

  it("appends without a leading blank when the note is empty", async () => {
    const f = noteWith("");
    await f.note.addLine(task("- [ ] First"));
    expect(f.text()).toBe("- [ ] First");
  });

  it("appends the task with its subLines", async () => {
    const f = noteWith("- [ ] A");
    await f.note.addLine(task("- [ ] B").withSubLines(["  sub 1", "  sub 2"]));
    expect(f.text()).toBe("- [ ] A\n- [ ] B\n  sub 1\n  sub 2");
  });

  it("takes a brand-new task built with create + withSubLines", async () => {
    const f = noteWith("- [ ] Existing");
    await f.note.addLine(Task.create("New task", day("2026-07-01")).withSubLines(["  - note A", "  - note B"]));
    expect(f.text()).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01\n  - note A\n  - note B");
  });

  it("appends a created line with its ➕ date", async () => {
    const f = noteWith("- [ ] Existing");
    await f.note.createLine("New task", day("2026-07-01"));
    expect(f.text()).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01");
  });

  it("trims trailing blank lines before appending", async () => {
    const f = noteWith("- [ ] A\n");
    await f.note.addLine(task("- [ ] B"));
    expect(f.text()).toBe("- [ ] A\n- [ ] B");
  });

  it("inserts at the beginning when insertAt is 0", async () => {
    const f = noteWith("- [ ] B\n- [ ] C");
    await f.note.addLine(task("- [ ] A"), 0);
    expect(f.text()).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("inserts in the middle when insertAt is given", async () => {
    const f = noteWith("- [ ] A\n- [ ] C");
    await f.note.addLine(task("- [ ] B"), 1);
    expect(f.text()).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("clamps an out-of-bounds insertAt to the end", async () => {
    const f = noteWith("- [ ] A");
    await f.note.addLine(task("- [ ] B"), 999);
    expect(f.text()).toBe("- [ ] A\n- [ ] B");
  });
});

// ---------------------------------------------------------------------------
// insertUnderHeading
// ---------------------------------------------------------------------------

describe("TaskIO.insertUnderHeading", () => {
  it("inserts the group at the end of the heading's section", async () => {
    const f = noteWith("# Tasks\n- [ ] Existing\n# Notes\nSome note");
    await f.note.insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(f.text()).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n# Notes\nSome note");
  });

  it("inserts a multi-line group (task + subLines) together", async () => {
    const f = noteWith("# Tasks\n- [ ] Existing\n# Notes");
    await f.note.insertUnderHeading(["- [ ] New", "  sub 1", "  sub 2"], "# Tasks");
    expect(f.text()).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n  sub 1\n  sub 2\n# Notes");
  });

  it("appends the heading and the group at EOF when the heading is absent", async () => {
    const f = noteWith("# Notes\nSome note");
    await f.note.insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(f.text()).toBe("# Notes\nSome note\n\n# Tasks\n- [ ] New");
  });

  it("inserts before trailing blank lines within the heading's section", async () => {
    const f = noteWith("# Tasks\n- [ ] Existing\n\n\n# Notes");
    await f.note.insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(f.text()).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n\n\n# Notes");
  });

  it("writes the heading and the group into a note that isn't there", async () => {
    const f = noteWith(null);
    await f.note.insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(f.text()).toBe("\n# Tasks\n- [ ] New");
  });
});

// ---------------------------------------------------------------------------
// moveLineBefore
// ---------------------------------------------------------------------------

describe("TaskIO.moveLineBefore", () => {
  it("moves a task down, in front of the anchor", async () => {
    const f = noteWith("- [ ] A\n- [ ] B\n- [ ] C");
    await f.note.moveLineBefore(task("- [ ] A"), task("- [ ] C", 2));
    expect(f.text()).toBe("- [ ] B\n- [ ] A\n- [ ] C");
  });

  it("moves a task up, in front of the anchor", async () => {
    const f = noteWith("- [ ] A\n- [ ] B\n- [ ] C");
    await f.note.moveLineBefore(task("- [ ] C", 2), task("- [ ] A"));
    expect(f.text()).toBe("- [ ] C\n- [ ] A\n- [ ] B");
  });

  it("moves the whole group, sub-lines included, and lands before the anchor's own group", async () => {
    const f = noteWith("- [ ] A\n\tsub A\n- [ ] B\n\tsub B\n- [ ] C");
    await f.note.moveLineBefore(task("- [ ] C", 4), task("- [ ] B", 2));
    expect(f.text()).toBe("- [ ] A\n\tsub A\n- [ ] C\n- [ ] B\n\tsub B");
  });

  it("appends after the last task when the anchor is null", async () => {
    const f = noteWith("- [ ] A\n- [ ] B\n- [ ] C");
    await f.note.moveLineBefore(task("- [ ] A"), null);
    expect(f.text()).toBe("- [ ] B\n- [ ] C\n- [ ] A");
  });

  it("keeps a null-anchor move above trailing non-task content", async () => {
    const f = noteWith("# Tasks\n- [ ] A\n- [ ] B\n\tsub B\n\n## Notes\nsomething");
    await f.note.moveLineBefore(task("- [ ] A", 1), null);
    expect(f.text()).toBe("# Tasks\n- [ ] B\n\tsub B\n- [ ] A\n\n## Notes\nsomething");
  });

  it("locates the task by its raw line when lineIndex is stale", async () => {
    const f = noteWith("- [ ] A\n- [ ] B\n- [ ] C");
    await f.note.moveLineBefore(task("- [ ] C", 99), task("- [ ] B", 42));
    expect(f.text()).toBe("- [ ] A\n- [ ] C\n- [ ] B");
  });

  // The anchor's index is only meaningful in the file as read: resolving it after the
  // moved group is spliced out would fall back to a rawLine match and pick the first of
  // two same-titled tasks rather than the one actually dropped onto.
  it("anchors on the right one of two tasks sharing a line", async () => {
    const f = noteWith("- [ ] A\n- [ ] X\n\tnote 1\n- [ ] X\n\tnote 2");
    await f.note.moveLineBefore(task("- [ ] A"), task("- [ ] X", 3));
    expect(f.text()).toBe("- [ ] X\n\tnote 1\n- [ ] A\n- [ ] X\n\tnote 2");
  });

  it("writes nothing when the anchor sits inside the moved group", async () => {
    const f = noteWith("- [ ] A\n\t- [ ] sub\n- [ ] B");
    await f.note.moveLineBefore(task("- [ ] A"), task("\t- [ ] sub", 1));
    expect(f.wrote()).toBe(false);
  });

  it("writes nothing when the task is not found", async () => {
    const f = noteWith("- [ ] A\n- [ ] B");
    await f.note.moveLineBefore(task("- [ ] Missing", 5), task("- [ ] A"));
    expect(f.wrote()).toBe(false);
  });

  it("writes nothing when the anchor is not found", async () => {
    const f = noteWith("- [ ] A\n- [ ] B");
    await f.note.moveLineBefore(task("- [ ] B", 1), task("- [ ] Missing", 5));
    expect(f.wrote()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withLineChecked
// ---------------------------------------------------------------------------

describe("TaskIO.withLineChecked", () => {
  it("marks the task as done and appends the date", () => {
    const out = lineEdits.withLineChecked(linesOf("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), day("2026-07-01"));
    expect(edited(out)).toBe("- [x] Alpha ✅ 2026-07-01\n- [ ] Beta");
  });

  it("does not modify sub-lines", () => {
    const out = lineEdits.withLineChecked(linesOf("- [ ] Task\n  sub-note"), task("- [ ] Task"), day("2026-07-01"));
    expect(edited(out)).toContain("  sub-note");
  });

  it("marks the task as undone and strips the ✅ date when given no date", () => {
    const out = lineEdits.withLineChecked(linesOf("- [x] Alpha ✅ 2026-06-30\n- [ ] Beta"), task("- [x] Alpha ✅ 2026-06-30"), null);
    expect(edited(out)).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("falls back to rawLine when lineIndex is stale", () => {
    const out = lineEdits.withLineChecked(linesOf("- [ ] Inserted\n- [x] Done ✅ 2026-06-30"), task("- [x] Done ✅ 2026-06-30", 0), null);
    expect(edited(out)).toBe("- [ ] Inserted\n- [ ] Done");
  });

  it("leaves the lines alone when the task can no longer be found", () => {
    const out = lineEdits.withLineChecked(linesOf("- [ ] Beta"), task("- [ ] Alpha"), day("2026-07-01"));
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withLineTitle
// ---------------------------------------------------------------------------

describe("TaskIO.withLineTitle", () => {
  it("replaces the title, leaving other lines untouched", () => {
    const out = lineEdits.withLineTitle(linesOf("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), "Alpha renamed");
    expect(edited(out)).toBe("- [ ] Alpha renamed\n- [ ] Beta");
  });

  it("preserves trailing metadata and the checked state", () => {
    const out = lineEdits.withLineTitle(linesOf("- [x] Alpha ✅ 2026-06-30"), task("- [x] Alpha ✅ 2026-06-30"), "Alpha renamed");
    expect(edited(out)).toBe("- [x] Alpha renamed ✅ 2026-06-30");
  });

  it("does not modify sub-lines", () => {
    const out = lineEdits.withLineTitle(linesOf("- [ ] Alpha\n  sub-note"), task("- [ ] Alpha"), "Alpha renamed");
    expect(edited(out)).toContain("  sub-note");
  });

  it("leaves the lines alone when the task can't be found", () => {
    const out = lineEdits.withLineTitle(linesOf("- [ ] Alpha"), task("- [ ] Missing"), "New title");
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setLineScheduled
// ---------------------------------------------------------------------------

describe("TaskIO.setLineScheduled", () => {
  const JULY_9 = new Date(2026, 6, 9);

  it("adds a target date, leaving other lines untouched", async () => {
    const f = noteWith("- [ ] Alpha\n- [ ] Beta");
    await f.note.setLineScheduled(task("- [ ] Alpha"), JULY_9);
    expect(f.text()).toBe("- [ ] Alpha ⏳ 2026-07-09\n- [ ] Beta");
  });

  it("clears the target date when given null", async () => {
    const f = noteWith("- [ ] Alpha ⏳ 2026-07-09");
    await f.note.setLineScheduled(task("- [ ] Alpha ⏳ 2026-07-09"), null);
    expect(f.text()).toBe("- [ ] Alpha");
  });

  it("writes nothing when the date is already the one asked for", async () => {
    const f = noteWith("- [ ] Alpha ⏳ 2026-07-09");
    // Nothing to write, but the task is there and carries the date — the caller's ask holds.
    expect(await f.note.setLineScheduled(task("- [ ] Alpha ⏳ 2026-07-09"), JULY_9)).toBe(true);
    expect(f.wrote()).toBe(false);
  });

  it("reports the task as found when it sets the date", async () => {
    const f = noteWith("- [ ] Alpha");
    expect(await f.note.setLineScheduled(task("- [ ] Alpha"), JULY_9)).toBe(true);
  });

  it("reports the task as missing when it can't be found", async () => {
    const f = noteWith("- [ ] Alpha");
    expect(await f.note.setLineScheduled(task("- [ ] Missing"), JULY_9)).toBe(false);
  });

  it("does not modify sub-lines", async () => {
    const f = noteWith("- [ ] Alpha\n\tsub-note");
    await f.note.setLineScheduled(task("- [ ] Alpha"), JULY_9);
    expect(f.text()).toBe("- [ ] Alpha ⏳ 2026-07-09\n\tsub-note");
  });
});

// ---------------------------------------------------------------------------
// withLinePriority
// ---------------------------------------------------------------------------

describe("TaskIO.withLinePriority", () => {
  it("adds a priority marker, leaving other lines untouched", () => {
    const out = lineEdits.withLinePriority(linesOf("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), Priority.High);
    expect(edited(out)).toBe("- [ ] Alpha ⏫\n- [ ] Beta");
  });

  it("replaces an existing marker", () => {
    const out = lineEdits.withLinePriority(linesOf("- [ ] Alpha 🔽 ➕ 2026-06-30"), task("- [ ] Alpha 🔽 ➕ 2026-06-30"), Priority.Critical);
    expect(edited(out)).toBe("- [ ] Alpha 🔺 ➕ 2026-06-30");
  });

  it("clears the marker when given an empty priority", () => {
    const out = lineEdits.withLinePriority(linesOf("- [ ] Alpha ⏫"), task("- [ ] Alpha ⏫"), Priority.None);
    expect(edited(out)).toBe("- [ ] Alpha");
  });

  it("does not modify sub-lines", () => {
    const out = lineEdits.withLinePriority(linesOf("- [ ] Alpha\n\tsub-note"), task("- [ ] Alpha"), Priority.Medium);
    expect(edited(out)).toBe("- [ ] Alpha 🔼\n\tsub-note");
  });

  it("leaves the lines alone when the task can't be found", () => {
    const out = lineEdits.withLinePriority(linesOf("- [ ] Alpha"), task("- [ ] Missing"), Priority.High);
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withLineSubLines
// ---------------------------------------------------------------------------

describe("TaskIO.withLineSubLines", () => {
  it("adds sub-lines to a task that has none", () => {
    const out = lineEdits.withLineSubLines(linesOf("- [ ] Alpha\n- [ ] Beta"), task("- [ ] Alpha"), "note 1\nnote 2");
    expect(edited(out)).toBe("- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta");
  });

  it("replaces existing sub-lines", () => {
    const out = lineEdits.withLineSubLines(linesOf("- [ ] Alpha\n\told note\n- [ ] Beta"), task("- [ ] Alpha"), "new note");
    expect(edited(out)).toBe("- [ ] Alpha\n\tnew note\n- [ ] Beta");
  });

  it("clears all sub-lines when given an empty string", () => {
    const out = lineEdits.withLineSubLines(linesOf("- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta"), task("- [ ] Alpha"), "");
    expect(edited(out)).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("drops a blank line, which the next read would take for the end of the block", () => {
    const out = lineEdits.withLineSubLines(linesOf("- [ ] Alpha"), task("- [ ] Alpha"), "note 1\n\nnote 2");
    expect(edited(out)).toBe("- [ ] Alpha\n\tnote 1\n\tnote 2");
  });

  it("leaves other lines untouched", () => {
    const out = lineEdits.withLineSubLines(linesOf("- [ ] Alpha\n- [ ] Beta\n\tbeta note"), task("- [ ] Alpha"), "alpha note");
    expect(edited(out)).toBe("- [ ] Alpha\n\talpha note\n- [ ] Beta\n\tbeta note");
  });

  it("leaves the lines alone when the task can't be found", () => {
    const out = lineEdits.withLineSubLines(linesOf("- [ ] Alpha"), task("- [ ] Missing"), "note");
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-note move: removeLine → addLine
// ---------------------------------------------------------------------------

describe("cross-note move (removeLine → addLine)", () => {
  const OTHER = "Inbox.md";

  it("transfers task + sub-lines from one note to another", async () => {
    const f = noteWith("- [ ] Task\n  sub-line\n- [ ] Other", { [OTHER]: "- [ ] Existing" });
    const removed = await f.note.removeLine(task("- [ ] Task"));
    expect(f.text()).toBe("- [ ] Other");

    await f.notes.file(OTHER).addLine(removed!);
    expect(f.text(OTHER)).toBe("- [ ] Existing\n- [ ] Task\n  sub-line");
  });

  it("lands in a note that has no lines yet", async () => {
    const f = noteWith("- [ ] Only task");
    const removed = await f.note.removeLine(task("- [ ] Only task"));

    await f.notes.file(OTHER).addLine(removed!);
    expect(f.text(OTHER)).toBe("- [ ] Only task");
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
