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
  addTask, checkTask, createTask, insertUnderHeading, moveTaskBefore, parseTasks,
  removeCheckedTasks, removeTask, uncheckTask,
  updatePriority, updateScheduledDate, updateSubLines, updateTitle,
} from "./day-note-lines";
import { Task } from "../daily/task";
import { day } from "../__testing__/dates";
import { makeDayVault } from "../__testing__/day-vault";
import { Priority } from "../base-task";

function task(line: string, idx = 0): Task {
  return Task.parse(line, idx)!;
}

// ---------------------------------------------------------------------------
// parseTasks
// ---------------------------------------------------------------------------

describe("parseTasks", () => {
  it("returns [] for a non-existent file", async () => {
    const { app } = makeDayVault();
    expect(await parseTasks(app, "missing.md")).toEqual([]);
  });

  it("skips non-task lines", async () => {
    const { app } = makeDayVault({ "f.md": "# Heading\n\nsome text\n- plain bullet" });
    expect(await parseTasks(app, "f.md")).toHaveLength(0);
  });

  it("parses tasks and assigns correct lineIndex", async () => {
    const { app } = makeDayVault({ "f.md": "# Day\n- [ ] Task A\n- [x] Task B ✅ 2026-06-30" });
    const tasks = await parseTasks(app, "f.md");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Task A");
    expect(tasks[0].lineIndex).toBe(1);
    expect(tasks[1].lineIndex).toBe(2);
  });

  it("populates subLines for each task from surrounding indented lines", async () => {
    const { app } = makeDayVault({ "f.md": "- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B" });
    const tasks = await parseTasks(app, "f.md");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(tasks[1].subLines).toEqual([]);
  });

  it("does not include sub-lines as separate tasks", async () => {
    const { app } = makeDayVault({ "f.md": "- [ ] Parent\n  - [ ] Nested" });
    const tasks = await parseTasks(app, "f.md");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subLines).toEqual(["  - [ ] Nested"]);
  });

  it("normalizes CRLF so lineIndex and rawLine are consistent", async () => {
    const { app } = makeDayVault({ "f.md": "- [ ] Task A\r\n- [ ] Task B" });
    const tasks = await parseTasks(app, "f.md");
    expect(tasks[1].lineIndex).toBe(1);
    expect(tasks[1].rawLine).not.toContain("\r");
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("removeTask", () => {
  it("returns null when the task is not found", async () => {
    const { app } = makeDayVault({ "f.md": "- [ ] Other" });
    expect(await removeTask(app, "f.md", task("- [ ] Missing"))).toBeNull();
  });

  it("removes the task and returns it as a Task", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma" });
    const removed = await removeTask(app, "f.md", task("- [ ] Beta", 1));
    expect(removed).not.toBeNull();
    expect(removed!.title).toBe("Beta");
    expect(removed!.subLines).toEqual([]);
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Gamma");
  });

  it("includes indented sub-lines in the returned Task.subLines", async () => {
    const { app, store } = makeDayVault({
      "f.md": "- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B",
    });
    const removed = await removeTask(app, "f.md", task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(store.get("f.md")).toBe("- [ ] Task B");
  });

  it("stops sub-line collection at a blank line", async () => {
    const { app, store } = makeDayVault({
      "f.md": "- [ ] Task A\n  sub\n\n  unrelated\n- [ ] Task B",
    });
    const removed = await removeTask(app, "f.md", task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub"]);
    expect(store.get("f.md")).toBe("\n  unrelated\n- [ ] Task B");
  });

  it("falls back to rawLine when lineIndex is stale", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Inserted above\n- [ ] Target task" });
    const removed = await removeTask(app, "f.md", task("- [ ] Target task", 0));
    expect(removed!.title).toBe("Target task");
    expect(store.get("f.md")).toBe("- [ ] Inserted above");
  });

  it("returns null instead of guessing by substring when neither lineIndex nor rawLine match", async () => {
    // "- [ ] Morning run" is a substring of the actual line but not an exact match — matching
    // by substring risks deleting an unrelated task (e.g. "- [ ] Morning run at the gym"), so
    // resolveIndex must refuse to guess here rather than fall back to a `.includes()` search.
    const { app, store } = makeDayVault({ "f.md": "- [ ] Morning run #daily" });
    const removed = await removeTask(app, "f.md", task("- [ ] Morning run", 5));
    expect(removed).toBeNull();
    expect(store.get("f.md")).toBe("- [ ] Morning run #daily");
  });
});

// ---------------------------------------------------------------------------
// removeCheckedTasks
// ---------------------------------------------------------------------------

describe("removeCheckedTasks", () => {
  it("returns all unchecked tasks when nothing is checked", async () => {
    const { app } = makeDayVault({ "f.md": "- [ ] A\n- [ ] B" });
    const tasks = await removeCheckedTasks(app, "f.md");
    expect(tasks).toHaveLength(2);
  });

  it("removes checked tasks and writes back", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Keep\n- [x] Done ✅ 2026-06-30\n- [ ] Also keep" });
    const tasks = await removeCheckedTasks(app, "f.md");
    expect(tasks.map((t) => t.title)).toEqual(["Keep", "Also keep"]);
    expect(store.get("f.md")).not.toContain("Done");
  });

  it("also removes sub-lines of checked tasks", async () => {
    const { app, store } = makeDayVault({
      "f.md": "- [x] Done ✅ 2026-06-30\n  sub-note\n- [ ] Remaining",
    });
    await removeCheckedTasks(app, "f.md");
    expect(store.get("f.md")).not.toContain("sub-note");
    expect(store.get("f.md")).toContain("Remaining");
  });

  it("returns [] for a non-existent file", async () => {
    const { app } = makeDayVault();
    expect(await removeCheckedTasks(app, "missing.md")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe("createTask", () => {
  it("appends an unchecked task with the given title and creation date", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Existing" });
    await createTask(app, "f.md", "New task", day("2026-07-01"));
    expect(store.get("f.md")).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01");
  });

  it("creates the file when it does not exist", async () => {
    const { app, store } = makeDayVault();
    await createTask(app, "new.md", "First task", day("2026-07-01"));
    expect(store.get("new.md")).toBe("- [ ] First task ➕ 2026-07-01");
  });

  it("embeds the creation date as ➕ in the task line", async () => {
    const { app } = makeDayVault();
    await createTask(app, "f.md", "Buy milk", day("2026-06-15"));
    const tasks = await parseTasks(app, "f.md");
    expect(tasks[0].createdAt).toEqual(day("2026-06-15"));
  });
});

// ---------------------------------------------------------------------------
// addTask
// ---------------------------------------------------------------------------

describe("addTask", () => {
  it("appends a task at the end when insertAt is omitted", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A" });
    await addTask(app, "f.md", task("- [ ] B"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("creates the file when it does not exist", async () => {
    const { app, store } = makeDayVault();
    await addTask(app, "new.md", task("- [ ] First"));
    expect(store.get("new.md")).toBe("- [ ] First");
  });

  it("appends without a leading newline when the existing file is empty", async () => {
    const { app, store } = makeDayVault({ "f.md": "" });
    await addTask(app, "f.md", task("- [ ] First"));
    expect(store.get("f.md")).toBe("- [ ] First");
  });

  it("appends task with its subLines (set via withSubLines)", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A" });
    const t = task("- [ ] B").withSubLines(["  sub 1", "  sub 2"]);
    await addTask(app, "f.md", t);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n  sub 1\n  sub 2");
  });

  it("to add sub-lines with createTask, build the Task with create+withSubLines then call addTask", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Existing" });
    const t = Task.create("New task", day("2026-07-01")).withSubLines(["  - note A", "  - note B"]);
    await addTask(app, "f.md", t);
    expect(store.get("f.md")).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01\n  - note A\n  - note B");
  });

  it("trims trailing whitespace from existing content before appending", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n" });
    await addTask(app, "f.md", task("- [ ] B"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("inserts at the beginning when insertAt is 0", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] B\n- [ ] C" });
    await addTask(app, "f.md", task("- [ ] A"), 0);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("inserts in the middle when insertAt is given", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n- [ ] C" });
    await addTask(app, "f.md", task("- [ ] B"), 1);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("clamps an out-of-bounds insertAt to the end", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A" });
    await addTask(app, "f.md", task("- [ ] B"), 999);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("creates the file when it does not exist and insertAt is given", async () => {
    const { app, store } = makeDayVault();
    await addTask(app, "new.md", task("- [ ] First"), 0);
    expect(store.get("new.md")).toBe("- [ ] First");
  });
});

// ---------------------------------------------------------------------------
// insertUnderHeading
// ---------------------------------------------------------------------------

describe("insertUnderHeading", () => {
  it("inserts the group at the end of the heading's section", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Tasks\n- [ ] Existing\n# Notes\nSome note" });
    await insertUnderHeading(app, "f.md", ["- [ ] New"], "# Tasks");
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n# Notes\nSome note");
  });

  it("inserts a multi-line group (task + subLines) together", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Tasks\n- [ ] Existing\n# Notes" });
    await insertUnderHeading(app, "f.md", ["- [ ] New", "  sub 1", "  sub 2"], "# Tasks");
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n  sub 1\n  sub 2\n# Notes");
  });

  it("appends the heading and the group at EOF when the heading is absent", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Notes\nSome note" });
    await insertUnderHeading(app, "f.md", ["- [ ] New"], "# Tasks");
    expect(store.get("f.md")).toBe("# Notes\nSome note\n\n# Tasks\n- [ ] New");
  });

  it("inserts before trailing blank lines within the heading's section", async () => {
    const { app, store } = makeDayVault({ "f.md": "# Tasks\n- [ ] Existing\n\n\n# Notes" });
    await insertUnderHeading(app, "f.md", ["- [ ] New"], "# Tasks");
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n\n\n# Notes");
  });

  it("creates the file with the heading and group when it does not exist", async () => {
    const { app, store } = makeDayVault();
    await insertUnderHeading(app, "new.md", ["- [ ] New"], "# Tasks");
    expect(store.get("new.md")).toBe("\n# Tasks\n- [ ] New");
  });
});

// ---------------------------------------------------------------------------
// moveTaskBefore
// ---------------------------------------------------------------------------

describe("moveTaskBefore", () => {
  it("moves a task down, in front of the anchor", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await moveTaskBefore(app, "f.md", task("- [ ] A"), task("- [ ] C", 2));
    expect(store.get("f.md")).toBe("- [ ] B\n- [ ] A\n- [ ] C");
  });

  it("moves a task up, in front of the anchor", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await moveTaskBefore(app, "f.md", task("- [ ] C", 2), task("- [ ] A"));
    expect(store.get("f.md")).toBe("- [ ] C\n- [ ] A\n- [ ] B");
  });

  it("moves the whole group, sub-lines included, and lands before the anchor's own group", async () => {
    const { app, store } = makeDayVault({
      "f.md": "- [ ] A\n\tsub A\n- [ ] B\n\tsub B\n- [ ] C",
    });
    await moveTaskBefore(app, "f.md", task("- [ ] C", 4), task("- [ ] B", 2));
    expect(store.get("f.md")).toBe("- [ ] A\n\tsub A\n- [ ] C\n- [ ] B\n\tsub B");
  });

  it("appends after the last task when the anchor is null", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await moveTaskBefore(app, "f.md", task("- [ ] A"), null);
    expect(store.get("f.md")).toBe("- [ ] B\n- [ ] C\n- [ ] A");
  });

  it("keeps a null-anchor move above trailing non-task content", async () => {
    const { app, store } = makeDayVault({
      "f.md": "# Tasks\n- [ ] A\n- [ ] B\n\tsub B\n\n## Notes\nsomething",
    });
    await moveTaskBefore(app, "f.md", task("- [ ] A", 1), null);
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] B\n\tsub B\n- [ ] A\n\n## Notes\nsomething");
  });

  it("locates the task by its raw line when lineIndex is stale", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await moveTaskBefore(app, "f.md", task("- [ ] C", 99), task("- [ ] B", 42));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] C\n- [ ] B");
  });

  // The anchor's index is only meaningful in the file as read: resolving it after the
  // moved group is spliced out would fall back to a rawLine match and pick the first of
  // two same-titled tasks rather than the one actually dropped onto.
  it("anchors on the right one of two tasks sharing a line", async () => {
    const { app, store } = makeDayVault({
      "f.md": "- [ ] A\n- [ ] X\n\tnote 1\n- [ ] X\n\tnote 2",
    });
    await moveTaskBefore(app, "f.md", task("- [ ] A"), task("- [ ] X", 3));
    expect(store.get("f.md")).toBe("- [ ] X\n\tnote 1\n- [ ] A\n- [ ] X\n\tnote 2");
  });

  it("does nothing when the anchor sits inside the moved group", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n\t- [ ] sub\n- [ ] B" });
    await moveTaskBefore(app, "f.md", task("- [ ] A"), task("\t- [ ] sub", 1));
    expect(store.get("f.md")).toBe("- [ ] A\n\t- [ ] sub\n- [ ] B");
  });

  it("does nothing when the task is not found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n- [ ] B" });
    await moveTaskBefore(app, "f.md", task("- [ ] Missing", 5), task("- [ ] A"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("does nothing when the anchor is not found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] A\n- [ ] B" });
    await moveTaskBefore(app, "f.md", task("- [ ] B", 1), task("- [ ] Missing", 5));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });
});

// ---------------------------------------------------------------------------
// checkTask / uncheckTask
// ---------------------------------------------------------------------------

describe("checkTask", () => {
  it("marks the task as done and appends the date", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await checkTask(app, "f.md", task("- [ ] Alpha"), day("2026-07-01"));
    expect(store.get("f.md")).toBe("- [x] Alpha ✅ 2026-07-01\n- [ ] Beta");
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Task\n  sub-note" });
    await checkTask(app, "f.md", task("- [ ] Task"), day("2026-07-01"));
    expect(store.get("f.md")).toContain("  sub-note");
  });

  it("does nothing when the item can no longer be found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Beta" });
    await checkTask(app, "f.md", task("- [ ] Alpha"), day("2026-07-01"));
    expect(store.get("f.md")).toBe("- [ ] Beta");
  });
});

describe("uncheckTask", () => {
  it("marks the task as undone and strips the ✅ date", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [x] Alpha ✅ 2026-06-30\n- [ ] Beta" });
    await uncheckTask(app, "f.md", task("- [x] Alpha ✅ 2026-06-30"));
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("falls back to rawLine when lineIndex is stale", async () => {
    const { app, store } = makeDayVault({
      "f.md": "- [ ] Inserted\n- [x] Done ✅ 2026-06-30",
    });
    await uncheckTask(app, "f.md", task("- [x] Done ✅ 2026-06-30", 0));
    expect(store.get("f.md")).toBe("- [ ] Inserted\n- [ ] Done");
  });

  it("does nothing when the item can no longer be found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Beta" });
    await uncheckTask(app, "f.md", task("- [x] Alpha ✅ 2026-06-30"));
    expect(store.get("f.md")).toBe("- [ ] Beta");
  });
});

describe("updateTitle", () => {
  it("replaces the title, leaving other lines untouched", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await updateTitle(app, "f.md", task("- [ ] Alpha"), "Alpha renamed");
    expect(store.get("f.md")).toBe("- [ ] Alpha renamed\n- [ ] Beta");
  });

  it("preserves trailing metadata and the checked state", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [x] Alpha ✅ 2026-06-30" });
    await updateTitle(app, "f.md", task("- [x] Alpha ✅ 2026-06-30"), "Alpha renamed");
    expect(store.get("f.md")).toBe("- [x] Alpha renamed ✅ 2026-06-30");
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n  sub-note" });
    await updateTitle(app, "f.md", task("- [ ] Alpha"), "Alpha renamed");
    expect(store.get("f.md")).toContain("  sub-note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha" });
    await updateTitle(app, "f.md", task("- [ ] Missing"), "New title");
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

describe("updateScheduledDate", () => {
  const JULY_9 = new Date(2026, 6, 9);

  it("adds a target date, leaving other lines untouched", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await updateScheduledDate(app, "f.md", task("- [ ] Alpha"), JULY_9);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09\n- [ ] Beta");
  });

  it("clears the target date when given null", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha ⏳ 2026-07-09" });
    await updateScheduledDate(app, "f.md", task("- [ ] Alpha ⏳ 2026-07-09"), null);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });

  it("does not rewrite the file when the date is already the one asked for", async () => {
    const { app, store, writes } = makeDayVault({ "f.md": "- [ ] Alpha ⏳ 2026-07-09" });
    const before = writes.length;
    const found = await updateScheduledDate(app, "f.md", task("- [ ] Alpha ⏳ 2026-07-09"), JULY_9);
    expect(writes.length).toBe(before);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09");
    // Nothing to write, but the task is there and carries the date — the caller's ask holds.
    expect(found).toBe(true);
  });

  it("reports the task as found when it sets the date", async () => {
    const { app } = makeDayVault({ "f.md": "- [ ] Alpha" });
    expect(await updateScheduledDate(app, "f.md", task("- [ ] Alpha"), JULY_9)).toBe(true);
  });

  it("reports the task as missing when it can't be found", async () => {
    const { app } = makeDayVault({ "f.md": "- [ ] Alpha" });
    expect(await updateScheduledDate(app, "f.md", task("- [ ] Missing"), JULY_9)).toBe(false);
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n\tsub-note" });
    await updateScheduledDate(app, "f.md", task("- [ ] Alpha"), JULY_9);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09\n\tsub-note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha" });
    await updateScheduledDate(app, "f.md", task("- [ ] Missing"), JULY_9);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

describe("updatePriority", () => {
  it("adds a priority marker, leaving other lines untouched", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await updatePriority(app, "f.md", task("- [ ] Alpha"), Priority.High);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏫\n- [ ] Beta");
  });

  it("replaces an existing marker", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha 🔽 ➕ 2026-06-30" });
    await updatePriority(app, "f.md", task("- [ ] Alpha 🔽 ➕ 2026-06-30"), Priority.Critical);
    expect(store.get("f.md")).toBe("- [ ] Alpha 🔺 ➕ 2026-06-30");
  });

  it("clears the marker when given an empty priority", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha ⏫" });
    await updatePriority(app, "f.md", task("- [ ] Alpha ⏫"), Priority.None);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n\tsub-note" });
    await updatePriority(app, "f.md", task("- [ ] Alpha"), Priority.Medium);
    expect(store.get("f.md")).toBe("- [ ] Alpha 🔼\n\tsub-note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha" });
    await updatePriority(app, "f.md", task("- [ ] Missing"), Priority.High);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

describe("updateSubLines", () => {
  it("adds sub-lines to a task that has none", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await updateSubLines(app, "f.md", task("- [ ] Alpha"), "note 1\nnote 2");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta");
  });

  it("replaces existing sub-lines", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n\told note\n- [ ] Beta" });
    await updateSubLines(app, "f.md", task("- [ ] Alpha"), "new note");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n\tnew note\n- [ ] Beta");
  });

  it("clears all sub-lines when given an empty string", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta" });
    await updateSubLines(app, "f.md", task("- [ ] Alpha"), "");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("leaves other lines untouched", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta\n\tbeta note" });
    await updateSubLines(app, "f.md", task("- [ ] Alpha"), "alpha note");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n\talpha note\n- [ ] Beta\n\tbeta note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Alpha" });
    await updateSubLines(app, "f.md", task("- [ ] Missing"), "note");
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

// ---------------------------------------------------------------------------
// Cross-file move: remove → addTask round-trip
// ---------------------------------------------------------------------------

describe("cross-file move (remove → addTask)", () => {
  it("transfers task + sub-lines from one file to another", async () => {
    const { app, store } = makeDayVault({
      "source.md": "- [ ] Task\n  sub-line\n- [ ] Other",
      "target.md": "- [ ] Existing",
    });
    const removed = await removeTask(app, "source.md", task("- [ ] Task"));
    await addTask(app, "target.md", removed!);
    expect(store.get("source.md")).toBe("- [ ] Other");
    expect(store.get("target.md")).toBe("- [ ] Existing\n- [ ] Task\n  sub-line");
  });

  it("creates the target file if it does not exist", async () => {
    const { app, store } = makeDayVault({ "source.md": "- [ ] Only task" });
    const removed = await removeTask(app, "source.md", task("- [ ] Only task"));
    await addTask(app, "target.md", removed!);
    expect(store.has("target.md")).toBe(true);
    expect(store.get("target.md")).toBe("- [ ] Only task");
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

describe("concurrent line writes", () => {
  it("serializes concurrent mutations to the same file so they don't clobber each other", async () => {
    const { app, store } = makeDayVault({ "f.md": "- [ ] Task A\n- [ ] Task B" });
    const tasks = await parseTasks(app, "f.md");
    // Two separate instances, like two independent call sites in the plugin would create.
    await Promise.all([
      checkTask(app, "f.md", tasks[0], day("2026-06-29")),
      checkTask(app, "f.md", tasks[1], day("2026-06-29")),
    ]);
    expect(store.get("f.md")).toBe(
      "- [x] Task A ✅ 2026-06-29\n- [x] Task B ✅ 2026-06-29",
    );
  });
});
