// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { TaskIO, keyTasks, type TaskIOFields } from "./task-io";
import { Task } from "../daily/task";
import type { TaskFileStore } from "../store/task-file-store";
import type { IModel } from "../i-model";
import { parseTasksFromLines } from "./task-io";
import { notesOf } from "../__testing__/notes";
import { emptyApp } from "../__testing__/as-app";
import { makeDayVault } from "../__testing__/day-vault";
import { day } from "../__testing__/dates";

const PATH = "Journal/2026-03-17.md";

/** A note over nothing: these tests fill it by hand rather than off a file. */
function makeFile(): TaskIO {
  const store = { invalidate: vi.fn() } as unknown as TaskFileStore;
  return new TaskIO(store, notesOf(emptyApp()), PATH);
}

function fields(...lines: string[]): TaskIOFields {
  return { lines, exists: true };
}

/** A model over one line, or — keyed on the path — over the note itself. */
function model(id: string): IModel & { refreshed: number; discarded: number } {
  return {
    id,
    filePath: PATH,
    refreshed: 0,
    discarded: 0,
    refresh() { this.refreshed++; },
    discard() { this.discarded++; },
  };
}

describe("keyTasks", () => {
  it("names a line by its title", () => {
    const tasks = parseTasksFromLines(["- [ ] Water the plants"]);
    expect(keyTasks(tasks).map((k) => k.key)).toEqual(["Water the plants"]);
  });

  it("numbers the second line reading the same, a title being nobody's id", () => {
    const tasks = parseTasksFromLines(["- [ ] Stretch", "- [ ] Stretch", "- [ ] Stretch"]);
    expect(keyTasks(tasks).map((k) => k.key)).toEqual(["Stretch", "Stretch#1", "Stretch#2"]);
  });
});

describe("TaskIO", () => {
  it("reads its lines as the tasks they parse to", () => {
    const note = makeFile();

    note.fill(fields("# Day", "- [ ] Water the plants", "- [x] Stretch ✅ 2026-03-17"));

    expect(note.tasks().map((k) => k.key)).toEqual(["Water the plants", "Stretch"]);
    expect(note.taskFor("Stretch")?.checked).toBe(true);
  });

  it("names no task under a key the note doesn't hold", () => {
    const note = makeFile();
    note.fill(fields("- [ ] Water the plants"));

    expect(note.taskFor("Stretch")).toBeNull();
  });

  describe("what a re-read wakes", () => {
    it("wakes the model over a line that has changed", () => {
      const note = makeFile();
      note.fill(fields("- [ ] Stretch"));
      const held = model("Stretch");
      note.attach(held);

      note.fill(fields("- [x] Stretch ✅ 2026-03-17"));

      expect(held.refreshed).toBe(1);
      expect(note.taskFor("Stretch")?.checked).toBe(true);
    });

    it("wakes nobody when the lines land exactly as they were", () => {
      const note = makeFile();
      note.fill(fields("- [ ] Stretch"));
      const held = model("Stretch");
      note.attach(held);

      note.fill(fields("- [ ] Stretch"));

      expect(held.refreshed).toBe(0);
    });

    it("leaves a model whose line is untouched alone", () => {
      const note = makeFile();
      note.fill(fields("- [ ] Stretch", "- [ ] Water the plants"));
      const untouched = model("Stretch");
      note.attach(untouched);

      note.fill(fields("- [ ] Stretch", "- [x] Water the plants ✅ 2026-03-17"));

      expect(untouched.refreshed).toBe(1);
    });

    it("tells a model its line has gone", () => {
      const note = makeFile();
      note.fill(fields("- [ ] Stretch", "- [ ] Water the plants"));
      const held = model("Stretch");
      note.attach(held);

      note.fill(fields("- [ ] Water the plants"));

      expect(held.discarded).toBe(1);
      expect(held.refreshed).toBe(0);
    });

    it("wakes a model over the note itself on every read that moved", () => {
      const note = makeFile();
      note.fill(fields("- [ ] Stretch"));
      const summary = model(PATH);
      note.attach(summary);

      note.fill(fields("- [ ] Stretch", "- [ ] Water the plants"));

      expect(summary.refreshed).toBe(1);
    });
  });

  describe("a line this note renamed", () => {
    it("follows the task rather than reporting it gone and another arrived", () => {
      const note = makeFile();
      note.fill(fields("- [ ] Stretch"));
      const held = model("Stretch");
      note.attach(held);

      note.owePass("Stretch", "title", {
        ahead: (line) => { line.title = "Stretch twice"; },
        renamedTo: "Stretch twice",
        apply: () => null,
      });
      note.fill(fields("- [ ] Stretch twice"));

      expect(held.discarded).toBe(0);
      expect(note.taskFor("Stretch")?.title).toBe("Stretch twice");
    });

    it("still reports it gone when the line goes rather than being renamed", () => {
      const note = makeFile();
      note.fill(fields("- [ ] Stretch"));
      const held = model("Stretch");
      note.attach(held);

      note.owePass("Stretch", "title", {
        ahead: (line) => { line.title = "Stretch twice"; },
        renamedTo: "Stretch twice",
        apply: () => null,
      });
      note.fill(fields("- [ ] Water the plants"));

      expect(held.discarded).toBe(1);
    });
  });

  // The pass reads the file as it stands inside the lock rather than working from what the
  // note last read: a day note is a file a human types into and a sync rewrites.
  describe("one guarded pass over the lines", () => {
    it("reads the file rather than the reading it holds", async () => {
      const { files, store } = makeDayVault({ "f.md": "- [ ] Alpha" });
      const note = files.file("f.md");
      note.fill({ lines: ["- [ ] Stale"], exists: true });

      await note.setLineScheduled(Task.parse("- [ ] Alpha", 0)!, day("2026-07-09"));

      expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09");
    });

    it("writes nothing when the change changes nothing", async () => {
      const { files, store, writes } = makeDayVault({ "f.md": "- [ ] Alpha ⏳ 2026-07-09" });

      const found = await files.file("f.md").setLineScheduled(
        Task.parse("- [ ] Alpha ⏳ 2026-07-09", 0)!, day("2026-07-09"),
      );

      expect(writes).toEqual([]);
      expect(store.get("f.md")).toBe("- [ ] Alpha ⏳ 2026-07-09");
      // Nothing to write, but the line is there and carries the date — the caller's ask holds.
      expect(found).toBe(true);
    });

    it("serializes two passes over one note so they don't clobber each other", async () => {
      const { files, store } = makeDayVault({ "f.md": "- [ ] Task A\n- [ ] Task B" });
      const note = files.file("f.md");
      const [a, b] = await note.parsedTasks();

      await Promise.all([
        note.setLineScheduled(a, day("2026-07-09")),
        note.setLineScheduled(b, day("2026-07-09")),
      ]);

      expect(store.get("f.md")).toBe("- [ ] Task A ⏳ 2026-07-09\n- [ ] Task B ⏳ 2026-07-09");
    });

    // Everything owed at once is one write, not one apiece. Some of what is owed only makes
    // sense whole — the habits a day is due come as lines dropped and a section put back —
    // and a note caught between the two reads as a note that needs putting right.
    it("lands everything owed at once in a single write", async () => {
      const { files, store, writes } = makeDayVault({ "f.md": "# Routine\n- [ ] B\n- [ ] A" });
      const note = files.file("f.md");
      const [b, a] = await note.parsedTasks();

      note.owePass("B", "drop", { ahead: () => undefined, apply: (f, l) => f.withoutLine(l, b) });
      note.owePass("A", "drop", { ahead: () => undefined, apply: (f, l) => f.withoutLine(l, a) });
      note.owePass("# Routine", "group", {
        ahead: () => undefined,
        apply: (f, l) => f.withGroupUnderHeading(l, ["- [ ] A", "- [ ] B"], "# Routine"),
      });
      await note.flush();

      expect(store.get("f.md")).toBe("# Routine\n- [ ] A\n- [ ] B");
      expect(writes).toEqual(["f.md"]);
    });

    it("resolves each owed change against the lines the one before it left", async () => {
      const { files, store, writes } = makeDayVault({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
      const note = files.file("f.md");
      const [alpha, beta] = await note.parsedTasks();

      // Dropping Alpha moves Beta up a line; the second change still has to find it.
      note.owePass("Alpha", "drop", {
        ahead: () => undefined, apply: (f, l) => f.withoutLine(l, alpha),
      });
      note.owePass("Beta", "checked", {
        ahead: () => undefined, apply: (f, l) => f.withLineChecked(l, beta, day("2026-06-29")),
      });
      await note.flush();

      expect(store.get("f.md")).toBe("- [x] Beta ✅ 2026-06-29");
      expect(writes).toEqual(["f.md"]);
    });

    it("creates the note when a write lands on a path the vault doesn't hold", async () => {
      const { files, store } = makeDayVault();

      await files.file("new.md").createLine("First task", day("2026-07-01"));

      expect(store.get("new.md")).toBe("- [ ] First task ➕ 2026-07-01");
    });

    it("parses the lines off the file, each stamped with the note", async () => {
      const { files } = makeDayVault({ "f.md": "- [ ] Task A\r\n- [ ] Task B" });

      const tasks = await files.file("f.md").parsedTasks();

      // CRLF normalized on the way in, so lineIndex and rawLine agree.
      expect(tasks[1].lineIndex).toBe(1);
      expect(tasks[1].rawLine).not.toContain("\r");
      expect(tasks[1].filePath).toBe("f.md");
    });

    it("parses nothing out of a note the vault doesn't hold", async () => {
      const { files } = makeDayVault();
      expect(await files.file("missing.md").parsedTasks()).toEqual([]);
    });
  });
});
