import { vi, describe, it, expect } from "vitest";

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { TFile as TFileMock } from "obsidian";
import { DayMarkdownFile, matchDailyNotePath, readDailyNotesConfig } from "./day-markdown-file";
import { DayTask } from "../daily/day-task";
import { day } from "../__testing__/dates";
import { asApp } from "../__testing__/as-app";
import { bare } from "../__testing__/bare";
import { Priority } from "../base-task";
import type { DailyNotesConfig } from "../daily/week-summary";
import type { RecurringTaskDefinition } from "../daily/recurring-task";
import { ALL_WEEKDAYS } from "../daily/recurring-task";

// ---------------------------------------------------------------------------
// Vault mock
// ---------------------------------------------------------------------------

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

function makeVaultFile(path: string) {
  const f = bare(TFileMock);
  Object.assign(f, { path });
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  /** Every write that reached the vault — lets a test assert a no-op wrote nothing. */
  const writes: string[] = [];
  const app = asApp({
    vault: {
      getAbstractFileByPath: (path: string) =>
        store.has(path) ? makeVaultFile(path) : null,
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        writes.push(file.path);
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        writes.push(path);
        store.set(path, content);
        return makeVaultFile(path);
      },
    },
  });
  return { app, store, writes };
}

function task(line: string, idx = 0): DayTask {
  return DayTask.parse(line, idx)!;
}

// ---------------------------------------------------------------------------
// parseTasks
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.parseTasks", () => {
  it("returns [] for a non-existent file", async () => {
    const { app } = makeApp();
    expect(await new DayMarkdownFile(app, "missing.md").parseTasks()).toEqual([]);
  });

  it("skips non-task lines", async () => {
    const { app } = makeApp({ "f.md": "# Heading\n\nsome text\n- plain bullet" });
    expect(await new DayMarkdownFile(app, "f.md").parseTasks()).toHaveLength(0);
  });

  it("parses tasks and assigns correct lineIndex", async () => {
    const { app } = makeApp({ "f.md": "# Day\n- [ ] Task A\n- [x] Task B ✅ 2026-06-30" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Task A");
    expect(tasks[0].lineIndex).toBe(1);
    expect(tasks[1].lineIndex).toBe(2);
  });

  it("populates subLines for each task from surrounding indented lines", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(tasks[1].subLines).toEqual([]);
  });

  it("does not include sub-lines as separate tasks", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Parent\n  - [ ] Nested" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subLines).toEqual(["  - [ ] Nested"]);
  });

  it("normalizes CRLF so lineIndex and rawLine are consistent", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Task A\r\n- [ ] Task B" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks[1].lineIndex).toBe(1);
    expect(tasks[1].rawLine).not.toContain("\r");
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.remove", () => {
  it("returns null when the task is not found", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Other" });
    expect(await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Missing"))).toBeNull();
  });

  it("removes the task and returns it as a DayTask", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma" });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Beta", 1));
    expect(removed).not.toBeNull();
    expect(removed!.title).toBe("Beta");
    expect(removed!.subLines).toEqual([]);
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Gamma");
  });

  it("includes indented sub-lines in the returned DayTask.subLines", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B",
    });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(store.get("f.md")).toBe("- [ ] Task B");
  });

  it("stops sub-line collection at a blank line", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Task A\n  sub\n\n  unrelated\n- [ ] Task B",
    });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub"]);
    expect(store.get("f.md")).toBe("\n  unrelated\n- [ ] Task B");
  });

  it("falls back to rawLine when lineIndex is stale", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Inserted above\n- [ ] Target task" });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Target task", 0));
    expect(removed!.title).toBe("Target task");
    expect(store.get("f.md")).toBe("- [ ] Inserted above");
  });

  it("returns null instead of guessing by substring when neither lineIndex nor rawLine match", async () => {
    // "- [ ] Morning run" is a substring of the actual line but not an exact match — matching
    // by substring risks deleting an unrelated task (e.g. "- [ ] Morning run at the gym"), so
    // resolveIndex must refuse to guess here rather than fall back to a `.includes()` search.
    const { app, store } = makeApp({ "f.md": "- [ ] Morning run #daily" });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Morning run", 5));
    expect(removed).toBeNull();
    expect(store.get("f.md")).toBe("- [ ] Morning run #daily");
  });
});

// ---------------------------------------------------------------------------
// removeCheckedTasks
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.removeCheckedTasks", () => {
  it("returns all unchecked tasks when nothing is checked", async () => {
    const { app } = makeApp({ "f.md": "- [ ] A\n- [ ] B" });
    const tasks = await new DayMarkdownFile(app, "f.md").removeCheckedTasks();
    expect(tasks).toHaveLength(2);
  });

  it("removes checked tasks and writes back", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Keep\n- [x] Done ✅ 2026-06-30\n- [ ] Also keep" });
    const tasks = await new DayMarkdownFile(app, "f.md").removeCheckedTasks();
    expect(tasks.map((t) => t.title)).toEqual(["Keep", "Also keep"]);
    expect(store.get("f.md")).not.toContain("Done");
  });

  it("also removes sub-lines of checked tasks", async () => {
    const { app, store } = makeApp({
      "f.md": "- [x] Done ✅ 2026-06-30\n  sub-note\n- [ ] Remaining",
    });
    await new DayMarkdownFile(app, "f.md").removeCheckedTasks();
    expect(store.get("f.md")).not.toContain("sub-note");
    expect(store.get("f.md")).toContain("Remaining");
  });

  it("returns [] for a non-existent file", async () => {
    const { app } = makeApp();
    expect(await new DayMarkdownFile(app, "missing.md").removeCheckedTasks()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.createTask", () => {
  it("appends an unchecked task with the given title and creation date", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Existing" });
    await new DayMarkdownFile(app, "f.md").createTask("New task", day("2026-07-01"));
    expect(store.get("f.md")).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01");
  });

  it("creates the file when it does not exist", async () => {
    const { app, store } = makeApp();
    await new DayMarkdownFile(app, "new.md").createTask("First task", day("2026-07-01"));
    expect(store.get("new.md")).toBe("- [ ] First task ➕ 2026-07-01");
  });

  it("embeds the creation date as ➕ in the task line", async () => {
    const { app } = makeApp();
    await new DayMarkdownFile(app, "f.md").createTask("Buy milk", day("2026-06-15"));
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks[0].createdAt).toEqual(day("2026-06-15"));
  });
});

// ---------------------------------------------------------------------------
// addTask
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.addTask", () => {
  it("appends a task at the end when insertAt is omitted", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("creates the file when it does not exist", async () => {
    const { app, store } = makeApp();
    await new DayMarkdownFile(app, "new.md").addTask(task("- [ ] First"));
    expect(store.get("new.md")).toBe("- [ ] First");
  });

  it("appends without a leading newline when the existing file is empty", async () => {
    const { app, store } = makeApp({ "f.md": "" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] First"));
    expect(store.get("f.md")).toBe("- [ ] First");
  });

  it("appends task with its subLines (set via withSubLines)", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A" });
    const t = task("- [ ] B").withSubLines(["  sub 1", "  sub 2"]);
    await new DayMarkdownFile(app, "f.md").addTask(t);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n  sub 1\n  sub 2");
  });

  it("to add sub-lines with createTask, build the DayTask with create+withSubLines then call addTask", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Existing" });
    const t = DayTask.create("New task", day("2026-07-01")).withSubLines(["  - note A", "  - note B"]);
    await new DayMarkdownFile(app, "f.md").addTask(t);
    expect(store.get("f.md")).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01\n  - note A\n  - note B");
  });

  it("trims trailing whitespace from existing content before appending", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("inserts at the beginning when insertAt is 0", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] A"), 0);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("inserts in the middle when insertAt is given", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"), 1);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("clamps an out-of-bounds insertAt to the end", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"), 999);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("creates the file when it does not exist and insertAt is given", async () => {
    const { app, store } = makeApp();
    await new DayMarkdownFile(app, "new.md").addTask(task("- [ ] First"), 0);
    expect(store.get("new.md")).toBe("- [ ] First");
  });
});

// ---------------------------------------------------------------------------
// insertUnderHeading
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.insertUnderHeading", () => {
  it("inserts the group at the end of the heading's section", async () => {
    const { app, store } = makeApp({ "f.md": "# Tasks\n- [ ] Existing\n# Notes\nSome note" });
    await new DayMarkdownFile(app, "f.md").insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n# Notes\nSome note");
  });

  it("inserts a multi-line group (task + subLines) together", async () => {
    const { app, store } = makeApp({ "f.md": "# Tasks\n- [ ] Existing\n# Notes" });
    await new DayMarkdownFile(app, "f.md").insertUnderHeading(["- [ ] New", "  sub 1", "  sub 2"], "# Tasks");
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n  sub 1\n  sub 2\n# Notes");
  });

  it("appends the heading and the group at EOF when the heading is absent", async () => {
    const { app, store } = makeApp({ "f.md": "# Notes\nSome note" });
    await new DayMarkdownFile(app, "f.md").insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(store.get("f.md")).toBe("# Notes\nSome note\n\n# Tasks\n- [ ] New");
  });

  it("inserts before trailing blank lines within the heading's section", async () => {
    const { app, store } = makeApp({ "f.md": "# Tasks\n- [ ] Existing\n\n\n# Notes" });
    await new DayMarkdownFile(app, "f.md").insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] Existing\n- [ ] New\n\n\n# Notes");
  });

  it("creates the file with the heading and group when it does not exist", async () => {
    const { app, store } = makeApp();
    await new DayMarkdownFile(app, "new.md").insertUnderHeading(["- [ ] New"], "# Tasks");
    expect(store.get("new.md")).toBe("\n# Tasks\n- [ ] New");
  });
});

// ---------------------------------------------------------------------------
// moveTaskBefore
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.moveTaskBefore", () => {
  it("moves a task down, in front of the anchor", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] A"), task("- [ ] C", 2));
    expect(store.get("f.md")).toBe("- [ ] B\n- [ ] A\n- [ ] C");
  });

  it("moves a task up, in front of the anchor", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] C", 2), task("- [ ] A"));
    expect(store.get("f.md")).toBe("- [ ] C\n- [ ] A\n- [ ] B");
  });

  it("moves the whole group, sub-lines included, and lands before the anchor's own group", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] A\n\tsub A\n- [ ] B\n\tsub B\n- [ ] C",
    });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] C", 4), task("- [ ] B", 2));
    expect(store.get("f.md")).toBe("- [ ] A\n\tsub A\n- [ ] C\n- [ ] B\n\tsub B");
  });

  it("appends after the last task when the anchor is null", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] A"), null);
    expect(store.get("f.md")).toBe("- [ ] B\n- [ ] C\n- [ ] A");
  });

  it("keeps a null-anchor move above trailing non-task content", async () => {
    const { app, store } = makeApp({
      "f.md": "# Tasks\n- [ ] A\n- [ ] B\n\tsub B\n\n## Notes\nsomething",
    });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] A", 1), null);
    expect(store.get("f.md")).toBe("# Tasks\n- [ ] B\n\tsub B\n- [ ] A\n\n## Notes\nsomething");
  });

  it("locates the task by its raw line when lineIndex is stale", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] C", 99), task("- [ ] B", 42));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] C\n- [ ] B");
  });

  // The anchor's index is only meaningful in the file as read: resolving it after the
  // moved group is spliced out would fall back to a rawLine match and pick the first of
  // two same-titled tasks rather than the one actually dropped onto.
  it("anchors on the right one of two tasks sharing a line", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] A\n- [ ] X\n\tnote 1\n- [ ] X\n\tnote 2",
    });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] A"), task("- [ ] X", 3));
    expect(store.get("f.md")).toBe("- [ ] X\n\tnote 1\n- [ ] A\n- [ ] X\n\tnote 2");
  });

  it("does nothing when the anchor sits inside the moved group", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n\t- [ ] sub\n- [ ] B" });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] A"), task("\t- [ ] sub", 1));
    expect(store.get("f.md")).toBe("- [ ] A\n\t- [ ] sub\n- [ ] B");
  });

  it("does nothing when the task is not found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B" });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] Missing", 5), task("- [ ] A"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("does nothing when the anchor is not found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B" });
    await new DayMarkdownFile(app, "f.md").moveTaskBefore(task("- [ ] B", 1), task("- [ ] Missing", 5));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });
});

// ---------------------------------------------------------------------------
// checkTask / uncheckTask
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.checkTask", () => {
  it("marks the task as done and appends the date", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").checkTask(task("- [ ] Alpha"), day("2026-07-01"));
    expect(store.get("f.md")).toBe("- [x] Alpha ✅ 2026-07-01\n- [ ] Beta");
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Task\n  sub-note" });
    await new DayMarkdownFile(app, "f.md").checkTask(task("- [ ] Task"), day("2026-07-01"));
    expect(store.get("f.md")).toContain("  sub-note");
  });

  it("does nothing when the item can no longer be found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").checkTask(task("- [ ] Alpha"), day("2026-07-01"));
    expect(store.get("f.md")).toBe("- [ ] Beta");
  });
});

describe("DayMarkdownFile.uncheckTask", () => {
  it("marks the task as undone and strips the ✅ date", async () => {
    const { app, store } = makeApp({ "f.md": "- [x] Alpha ✅ 2026-06-30\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").uncheckTask(task("- [x] Alpha ✅ 2026-06-30"));
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("falls back to rawLine when lineIndex is stale", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Inserted\n- [x] Done ✅ 2026-06-30",
    });
    await new DayMarkdownFile(app, "f.md").uncheckTask(task("- [x] Done ✅ 2026-06-30", 0));
    expect(store.get("f.md")).toBe("- [ ] Inserted\n- [ ] Done");
  });

  it("does nothing when the item can no longer be found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").uncheckTask(task("- [x] Alpha ✅ 2026-06-30"));
    expect(store.get("f.md")).toBe("- [ ] Beta");
  });
});

describe("DayMarkdownFile.updateTitle", () => {
  it("replaces the title, leaving other lines untouched", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").updateTitle(task("- [ ] Alpha"), "Alpha renamed");
    expect(store.get("f.md")).toBe("- [ ] Alpha renamed\n- [ ] Beta");
  });

  it("preserves trailing metadata and the checked state", async () => {
    const { app, store } = makeApp({ "f.md": "- [x] Alpha ✅ 2026-06-30" });
    await new DayMarkdownFile(app, "f.md").updateTitle(task("- [x] Alpha ✅ 2026-06-30"), "Alpha renamed");
    expect(store.get("f.md")).toBe("- [x] Alpha renamed ✅ 2026-06-30");
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n  sub-note" });
    await new DayMarkdownFile(app, "f.md").updateTitle(task("- [ ] Alpha"), "Alpha renamed");
    expect(store.get("f.md")).toContain("  sub-note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha" });
    await new DayMarkdownFile(app, "f.md").updateTitle(task("- [ ] Missing"), "New title");
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

describe("DayMarkdownFile.updateScheduledDate", () => {
  const JULY_9 = new Date(2026, 6, 9);

  it("adds a target date, leaving other lines untouched", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").updateScheduledDate(task("- [ ] Alpha"), JULY_9);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09\n- [ ] Beta");
  });

  it("clears the target date when given null", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha ⏳ 2026-07-09" });
    await new DayMarkdownFile(app, "f.md").updateScheduledDate(task("- [ ] Alpha ⏳ 2026-07-09"), null);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });

  it("does not rewrite the file when the date is already the one asked for", async () => {
    const { app, store, writes } = makeApp({ "f.md": "- [ ] Alpha ⏳ 2026-07-09" });
    const before = writes.length;
    const found = await new DayMarkdownFile(app, "f.md").updateScheduledDate(task("- [ ] Alpha ⏳ 2026-07-09"), JULY_9);
    expect(writes.length).toBe(before);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09");
    // Nothing to write, but the task is there and carries the date — the caller's ask holds.
    expect(found).toBe(true);
  });

  it("reports the task as found when it sets the date", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Alpha" });
    expect(await new DayMarkdownFile(app, "f.md").updateScheduledDate(task("- [ ] Alpha"), JULY_9)).toBe(true);
  });

  it("reports the task as missing when it can't be found", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Alpha" });
    expect(await new DayMarkdownFile(app, "f.md").updateScheduledDate(task("- [ ] Missing"), JULY_9)).toBe(false);
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n\tsub-note" });
    await new DayMarkdownFile(app, "f.md").updateScheduledDate(task("- [ ] Alpha"), JULY_9);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09\n\tsub-note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha" });
    await new DayMarkdownFile(app, "f.md").updateScheduledDate(task("- [ ] Missing"), JULY_9);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

describe("DayMarkdownFile.updatePriority", () => {
  it("adds a priority marker, leaving other lines untouched", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").updatePriority(task("- [ ] Alpha"), Priority.High);
    expect(store.get("f.md")).toBe("- [ ] Alpha ⏫\n- [ ] Beta");
  });

  it("replaces an existing marker", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha 🔽 ➕ 2026-06-30" });
    await new DayMarkdownFile(app, "f.md").updatePriority(task("- [ ] Alpha 🔽 ➕ 2026-06-30"), Priority.Critical);
    expect(store.get("f.md")).toBe("- [ ] Alpha 🔺 ➕ 2026-06-30");
  });

  it("clears the marker when given an empty priority", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha ⏫" });
    await new DayMarkdownFile(app, "f.md").updatePriority(task("- [ ] Alpha ⏫"), Priority.None);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n\tsub-note" });
    await new DayMarkdownFile(app, "f.md").updatePriority(task("- [ ] Alpha"), Priority.Medium);
    expect(store.get("f.md")).toBe("- [ ] Alpha 🔼\n\tsub-note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha" });
    await new DayMarkdownFile(app, "f.md").updatePriority(task("- [ ] Missing"), Priority.High);
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

describe("DayMarkdownFile.updateSubLines", () => {
  it("adds sub-lines to a task that has none", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").updateSubLines(task("- [ ] Alpha"), "note 1\nnote 2");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta");
  });

  it("replaces existing sub-lines", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n\told note\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").updateSubLines(task("- [ ] Alpha"), "new note");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n\tnew note\n- [ ] Beta");
  });

  it("clears all sub-lines when given an empty string", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n\tnote 1\n\tnote 2\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").updateSubLines(task("- [ ] Alpha"), "");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("leaves other lines untouched", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta\n\tbeta note" });
    await new DayMarkdownFile(app, "f.md").updateSubLines(task("- [ ] Alpha"), "alpha note");
    expect(store.get("f.md")).toBe("- [ ] Alpha\n\talpha note\n- [ ] Beta\n\tbeta note");
  });

  it("no-ops when the task can't be found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha" });
    await new DayMarkdownFile(app, "f.md").updateSubLines(task("- [ ] Missing"), "note");
    expect(store.get("f.md")).toBe("- [ ] Alpha");
  });
});

// ---------------------------------------------------------------------------
// Cross-file move: remove → addTask round-trip
// ---------------------------------------------------------------------------

describe("cross-file move (remove → addTask)", () => {
  it("transfers task + sub-lines from one file to another", async () => {
    const { app, store } = makeApp({
      "source.md": "- [ ] Task\n  sub-line\n- [ ] Other",
      "target.md": "- [ ] Existing",
    });
    const removed = await new DayMarkdownFile(app, "source.md").remove(task("- [ ] Task"));
    await new DayMarkdownFile(app, "target.md").addTask(removed!);
    expect(store.get("source.md")).toBe("- [ ] Other");
    expect(store.get("target.md")).toBe("- [ ] Existing\n- [ ] Task\n  sub-line");
  });

  it("creates the target file if it does not exist", async () => {
    const { app, store } = makeApp({ "source.md": "- [ ] Only task" });
    const removed = await new DayMarkdownFile(app, "source.md").remove(task("- [ ] Only task"));
    await new DayMarkdownFile(app, "target.md").addTask(removed!);
    expect(store.has("target.md")).toBe(true);
    expect(store.get("target.md")).toBe("- [ ] Only task");
  });
});

// ---------------------------------------------------------------------------
// DayTask.withSubLines
// ---------------------------------------------------------------------------

describe("DayTask.withSubLines", () => {
  it("returns a new task with the given sub-lines", () => {
    const t = DayTask.parse("- [ ] Task", 0)!;
    const withSubs = t.withSubLines(["  note 1", "  note 2"]);
    expect(withSubs.subLines).toEqual(["  note 1", "  note 2"]);
  });

  it("preserves all other fields", () => {
    const t = DayTask.parse("- [x] Task ✅ 2026-07-01 #tag", 3)!;
    const withSubs = t.withSubLines(["  note"]);
    expect(withSubs.title).toBe("Task #tag");
    expect(withSubs.checked).toBe(true);
    expect(withSubs.completedAt).toEqual(day("2026-07-01"));
    expect(withSubs.lineIndex).toBe(3);
    expect(withSubs.rawLine).toBe(t.rawLine);
  });

  it("parse() defaults subLines to []", () => {
    expect(DayTask.parse("- [ ] Task", 0)!.subLines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DayMarkdownFile.ensure
// ---------------------------------------------------------------------------

function makeEnsureApp(
  initialFiles: Record<string, string> = {},
  options: {
    dailyNotesConfig?: Partial<DailyNotesConfig>;
    existingFolders?: string[];
    templaterPlugin?: { create_new_note_from_template: (...args: unknown[]) => Promise<unknown> };
    /** The Daily notes core plugin, on in a normal vault. */
    dailyNotesEnabled?: boolean;
  } = {},
) {
  const dailyNotesEnabled = options.dailyNotesEnabled ?? true;
  const store = new Map(Object.entries(initialFiles));
  const folders = new Set(options.existingFolders ?? []);
  const configJson = options.dailyNotesConfig
    ? JSON.stringify(options.dailyNotesConfig)
    : null;

  const app = asApp({
    vault: {
      configDir: CONFIG_DIR,
      getAbstractFileByPath: (path: string) => {
        if (store.has(path)) {
          const f = bare(TFileMock);
          Object.assign(f, { path });
          return f;
        }
        if (folders.has(path)) return { path }; // simulate existing folder
        return null;
      },
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        store.set(path, content);
        const f = bare(TFileMock);
        Object.assign(f, { path });
        return f;
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      adapter: {
        read: async (path: string) => {
          if (path === `${CONFIG_DIR}/daily-notes.json` && configJson) return configJson;
          throw new Error(`adapter.read: not found: ${path}`);
        },
        exists: async () => configJson !== null,
      },
    },
    internalPlugins: { getEnabledPluginById: () => (dailyNotesEnabled ? {} : null) },
    plugins: {
      plugins: options.templaterPlugin
        ? { "templater-obsidian": { templater: options.templaterPlugin } }
        : {},
    },
  });

  return { app, store, folders };
}

describe("DayMarkdownFile.ensure", () => {
  const cfg = (overrides: Partial<DailyNotesConfig> = {}): DailyNotesConfig => ({
    folder: "",
    format: "YYYY-MM-DD",
    template: "",
    ...overrides,
  });

  it("returns a DayMarkdownFile pointing to an existing note", async () => {
    const { app } = makeEnsureApp({ "2026-07-01.md": "- [ ] Task" });
    const dmf = await DayMarkdownFile.ensure(app, day("2026-07-01"), cfg());
    expect(dmf).not.toBeNull();
    expect(dmf!.filePath).toBe("2026-07-01.md");
  });

  // In silence: a dashboard render calls this for every day of the week, so a notice here
  // would be a stack of them on every refresh. The caller that asks outright reports it.
  it("refuses to create a note, saying nothing, when the plugin is off and left no config", async () => {
    notices.length = 0;
    const { app, store } = makeEnsureApp({}, { dailyNotesEnabled: false });
    const dmf = await DayMarkdownFile.ensure(app, day("2026-07-01"), cfg());
    expect(dmf).toBeNull();
    expect(store.size).toBe(0);
    expect(notices).toEqual([]);
  });

  it("reads an existing note even with the Daily notes plugin off", async () => {
    const { app } = makeEnsureApp({ "2026-07-01.md": "- [ ] Task" }, { dailyNotesEnabled: false });
    const dmf = await DayMarkdownFile.ensure(app, day("2026-07-01"), cfg());
    expect(dmf!.filePath).toBe("2026-07-01.md");
  });

  it("still creates a note when the plugin is off but its config remains", async () => {
    const { app, store } = makeEnsureApp(
      {},
      { dailyNotesEnabled: false, dailyNotesConfig: { folder: "Daily" } },
    );
    const dmf = await DayMarkdownFile.ensure(app, day("2026-07-01"), cfg({ folder: "Daily" }));
    expect(dmf).not.toBeNull();
    expect(store.get("Daily/2026-07-01.md")).toBe("");
  });

  it("creates the file with empty content when it does not exist", async () => {
    const { app, store } = makeEnsureApp();
    const dmf = await DayMarkdownFile.ensure(app, day("2026-07-01"), cfg());
    expect(dmf).not.toBeNull();
    expect(store.get("2026-07-01.md")).toBe("");
  });

  it("places the file in the configured folder", async () => {
    const { app, store } = makeEnsureApp({}, { existingFolders: ["Daily Notes"] });
    const dmf = await DayMarkdownFile.ensure(app, day("2026-07-01"), cfg({ folder: "Daily Notes" }));
    expect(dmf!.filePath).toBe("Daily Notes/2026-07-01.md");
    expect(store.has("Daily Notes/2026-07-01.md")).toBe(true);
  });

  it("creates the folder when it does not exist", async () => {
    const { app, folders } = makeEnsureApp();
    await DayMarkdownFile.ensure(app, day("2026-07-01"), cfg({ folder: "Daily Notes" }));
    expect(folders.has("Daily Notes")).toBe(true);
  });

  it("does not try to create an already-existing folder", async () => {
    const { app } = makeEnsureApp({}, { existingFolders: ["Notes"] });
    // createFolder would throw if called — we verify no error is thrown
    app.vault.createFolder = () => { throw new Error("should not be called"); };
    await expect(
      DayMarkdownFile.ensure(app, day("2026-07-01"), cfg({ folder: "Notes" })),
    ).resolves.not.toBeNull();
  });

  it("seeds the file with raw template content when no Templater plugin is present", async () => {
    const { app, store } = makeEnsureApp({
      "templates/daily.md": "# Daily Note\n- [ ] Morning check-in",
    });
    const dmf = await DayMarkdownFile.ensure(
      app,
      day("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    expect(store.get(dmf!.filePath)).toBe("# Daily Note\n- [ ] Morning check-in");
  });

  it("appends .md to template path when extension is missing", async () => {
    const { app, store } = makeEnsureApp({ "templates/daily.md": "template content" });
    const dmf = await DayMarkdownFile.ensure(
      app,
      day("2026-07-01"),
      cfg({ template: "templates/daily" }),
    );
    expect(store.get(dmf!.filePath)).toBe("template content");
  });

  it("creates an empty file when the template path does not exist", async () => {
    const { app, store } = makeEnsureApp();
    const dmf = await DayMarkdownFile.ensure(
      app,
      day("2026-07-01"),
      cfg({ template: "missing-template.md" }),
    );
    expect(store.get(dmf!.filePath)).toBe("");
  });

  it("delegates to Templater when the plugin is available", async () => {
    const createdFile = bare(TFileMock);
    Object.assign(createdFile, { path: "2026-07-01.md" });
    const createMock = vi.fn().mockResolvedValue(createdFile);
    const { app } = makeEnsureApp(
      { "templates/daily.md": "" },
      { templaterPlugin: { create_new_note_from_template: createMock } },
    );
    const dmf = await DayMarkdownFile.ensure(
      app,
      day("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    expect(createMock).toHaveBeenCalledOnce();
    expect(dmf!.filePath).toBe("2026-07-01.md");
  });

  it("falls back to the expected path when Templater resolves without a created file, but the note now exists", async () => {
    // The note must not exist yet when ensure() starts (or its top-of-function existence
    // check would short-circuit before ever reaching Templater) — it has to appear as a
    // side effect of the (failing) Templater call, the way a real Templater run would
    // still write the file even if its return value doesn't carry a usable path.
    const { app, store } = makeEnsureApp(
      { "templates/daily.md": "" },
      {
        templaterPlugin: {
          create_new_note_from_template: async () => {
            store.set("2026-07-01.md", "created by templater");
            return null;
          },
        },
      },
    );
    const dmf = await DayMarkdownFile.ensure(
      app,
      day("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    expect(dmf!.filePath).toBe("2026-07-01.md");
  });

  it("returns null when Templater resolves without a created file and the note doesn't exist", async () => {
    const createMock = vi.fn().mockResolvedValue(null);
    const { app } = makeEnsureApp(
      { "templates/daily.md": "" },
      { templaterPlugin: { create_new_note_from_template: createMock } },
    );
    const dmf = await DayMarkdownFile.ensure(
      app,
      day("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    expect(dmf).toBeNull();
  });

  it("reads DailyNotesConfig from vault when not provided", async () => {
    const { app, store } = makeEnsureApp(
      {},
      { dailyNotesConfig: { folder: "Journal", format: "YYYY-MM-DD", template: "" } },
    );
    const dmf = await DayMarkdownFile.ensure(app, day("2026-07-01"));
    expect(dmf!.filePath).toBe("Journal/2026-07-01.md");
    expect(store.has("Journal/2026-07-01.md")).toBe(true);
  });

  it("returns a usable DayMarkdownFile (parseTasks works on the created file)", async () => {
    const { app } = makeEnsureApp({ "templates/daily.md": "- [ ] Morning run" });
    const dmf = await DayMarkdownFile.ensure(
      app,
      day("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    const tasks = await dmf!.parseTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Morning run");
  });
});

// ---------------------------------------------------------------------------
// readDailyNotesConfig
// ---------------------------------------------------------------------------

describe("readDailyNotesConfig", () => {
  function makeConfigApp(configJson: string | null) {
    return asApp({
      vault: {
        configDir: CONFIG_DIR,
        adapter: {
          read: async () => {
            if (configJson === null) throw new Error("not found");
            return configJson;
          },
        },
      },
    });
  }

  it("returns defaults when the config file is missing", async () => {
    const app = makeConfigApp(null);
    expect(await readDailyNotesConfig(app)).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
  });

  it("uses vault config values when all fields are present", async () => {
    const app = makeConfigApp(JSON.stringify({ folder: "Journal", format: "YYYY.MM.DD", template: "tpl" }));
    expect(await readDailyNotesConfig(app)).toEqual({ folder: "Journal", format: "YYYY.MM.DD", template: "tpl" });
  });

  it("falls back to defaults field-by-field for fields missing from the config file", async () => {
    const app = makeConfigApp(JSON.stringify({ folder: "Journal" }));
    expect(await readDailyNotesConfig(app)).toEqual({ folder: "Journal", format: "YYYY-MM-DD", template: "" });
  });

  it("falls back to the default folder when it's missing from the config file", async () => {
    const app = makeConfigApp(JSON.stringify({ format: "YYYY.MM.DD" }));
    expect(await readDailyNotesConfig(app)).toEqual({ folder: "", format: "YYYY.MM.DD", template: "" });
  });
});

// ---------------------------------------------------------------------------
// matchDailyNotePath
// ---------------------------------------------------------------------------

describe("matchDailyNotePath", () => {
  const cfg = (overrides: Partial<DailyNotesConfig> = {}): DailyNotesConfig => ({
    folder: "",
    format: "YYYY-MM-DD",
    template: "",
    ...overrides,
  });

  it("matches a daily note at the vault root", () => {
    const result = matchDailyNotePath("2026-07-03.md", cfg());
    expect(result).toEqual(new Date(2026, 6, 3));
  });

  it("matches a daily note inside the configured folder", () => {
    const result = matchDailyNotePath("Notes/Jour/2026-07-03.md", cfg({ folder: "Notes/Jour" }));
    expect(result).toEqual(new Date(2026, 6, 3));
  });

  it("returns null when the file is outside the configured folder", () => {
    expect(matchDailyNotePath("Other/2026-07-03.md", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });

  it("returns null when the basename doesn't parse as a date", () => {
    expect(matchDailyNotePath("Notes/Jour/not-a-date.md", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });

  it("returns null for non-markdown files", () => {
    expect(matchDailyNotePath("Notes/Jour/2026-07-03.png", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });

  it("returns null for a file nested deeper than the configured folder", () => {
    expect(matchDailyNotePath("Notes/Jour/Sub/2026-07-03.md", cfg({ folder: "Notes/Jour" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcileRecurringHabits
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.reconcileRecurringHabits", () => {
  const TAG = "daily";

  function habitDef(overrides: Partial<RecurringTaskDefinition> = {}): RecurringTaskDefinition {
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

  it("inserts a missing habit under the existing heading", async () => {
    const { app, store } = makeApp({ "f.md": "# Routine\n- [ ] Other habit" });
    const { inserted, removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(inserted).toHaveLength(1);
    expect(removedCount).toBe(0);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n- [ ] Morning run #daily");
  });

  it("does nothing when the habit is already present", async () => {
    const { app, store } = makeApp({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const { inserted, removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(inserted).toEqual([]);
    expect(removedCount).toBe(0);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily");
  });

  it("appends the heading and habit when no heading exists yet", async () => {
    const { app, store } = makeApp({ "f.md": "Some note content" });
    await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("Some note content\n\n# Routine\n- [ ] Morning run #daily");
  });

  it("appends the heading and habit to a completely empty note", async () => {
    const { app, store } = makeApp({ "f.md": "" });
    await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("\n# Routine\n- [ ] Morning run #daily");
  });

  it("includes detail sub-lines when inserting", async () => {
    const { app, store } = makeApp({ "f.md": "# Routine" });
    await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef({ detail: "Prompt A\nPrompt B" })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily\n\tPrompt A\n\tPrompt B");
  });

  it("skips a habit not scheduled for that weekday", async () => {
    const { app, store } = makeApp({ "f.md": "# Routine" });
    const weekdaysMonToFri = 0b0011111;
    const { inserted } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef({ weekdays: weekdaysMonToFri })],
      day("2026-07-05"), // Sunday
      "# Routine",
      TAG,
    );
    expect(inserted).toEqual([]);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line whose definition was deleted entirely", async () => {
    const { app, store } = makeApp({
      "f.md": "# Routine\n- [ ] Morning run #daily\n- [ ] Other habit",
    });
    const { removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [], // Morning run's definition no longer exists
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit");
  });

  it("removes a habit line whose definition was deactivated", async () => {
    const { app, store } = makeApp({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const { removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef({ active: false })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line no longer scheduled for that weekday", async () => {
    const { app, store } = makeApp({ "f.md": "# Routine\n- [ ] Morning run #daily" });
    const weekdaysMonToFri = 0b0011111;
    const { removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef({ weekdays: weekdaysMonToFri })],
      day("2026-07-05"), // Sunday — not in Mon-Fri
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine");
  });

  it("removes a habit line whose title was renamed, along with its sub-lines", async () => {
    const { app, store } = makeApp({
      "f.md": "# Routine\n- [ ] Old title #daily\n\tOld detail\n- [ ] Other habit",
    });
    const { removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef({ title: "New title" })],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n- [ ] New title #daily");
  });

  it("does not remove a checked habit line whose definition still matches", async () => {
    const { app, store } = makeApp({ "f.md": "# Routine\n- [x] Morning run #daily ✅ 2026-06-29" });
    const { removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(0);
    expect(store.get("f.md")).toBe("# Routine\n- [x] Morning run #daily ✅ 2026-06-29");
  });

  it("removes orphaned habit-tagged lines outside the heading section too (backward compatibility)", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Morning run #daily\n# Routine\n- [ ] Other habit",
    });
    const { removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [], // no definitions at all — the stray line above the heading is still orphaned
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit");
  });

  it("inserts a missing habit before a trailing --- divider, not after it", async () => {
    const { app, store } = makeApp({
      "f.md": "# Routine\n- [ ] Other habit\n---\nSome other section",
    });
    const { inserted } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [habitDef()],
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(inserted).toHaveLength(1);
    expect(store.get("f.md")).toBe(
      "# Routine\n- [ ] Other habit\n- [ ] Morning run #daily\n---\nSome other section",
    );
  });

  it("removes orphaned habit-tagged lines past a --- divider too", async () => {
    const { app, store } = makeApp({
      "f.md": "# Routine\n- [ ] Other habit\n---\n- [ ] Morning run #daily",
    });
    const { removedCount } = await new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
      [], // no definitions — the tagged line past the divider is still orphaned
      day("2026-06-29"),
      "# Routine",
      TAG,
    );
    expect(removedCount).toBe(1);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Other habit\n---");
  });

  it("does not duplicate an inserted habit when two instances reconcile the same file concurrently", async () => {
    // Regression test: main.ts's file-open handler and the dashboard's backfill call each
    // create their own DayMarkdownFile instance for the same path. Without serializing
    // mutations per path, both would read the file before either write lands, both decide
    // the habit is missing, and both insert it — leaving a duplicate line.
    const { app, store } = makeApp({ "f.md": "# Routine" });
    await Promise.all([
      new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
        [habitDef()],
        day("2026-06-29"),
        "# Routine",
        TAG,
      ),
      new DayMarkdownFile(app, "f.md").reconcileRecurringHabits(
        [habitDef()],
        day("2026-06-29"),
        "# Routine",
        TAG,
      ),
    ]);
    expect(store.get("f.md")).toBe("# Routine\n- [ ] Morning run #daily");
  });
});

describe("DayMarkdownFile concurrency", () => {
  it("serializes concurrent mutations to the same file so they don't clobber each other", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Task A\n- [ ] Task B" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    // Two separate instances, like two independent call sites in the plugin would create.
    await Promise.all([
      new DayMarkdownFile(app, "f.md").checkTask(tasks[0], day("2026-06-29")),
      new DayMarkdownFile(app, "f.md").checkTask(tasks[1], day("2026-06-29")),
    ]);
    expect(store.get("f.md")).toBe(
      "- [x] Task A ✅ 2026-06-29\n- [x] Task B ✅ 2026-06-29",
    );
  });
});
