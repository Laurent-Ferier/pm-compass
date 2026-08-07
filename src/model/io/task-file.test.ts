// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { TaskFile, keyTasks, type TaskFileFields } from "./task-file";
import type { DayStore } from "../store/day-store";
import type { IModel } from "../i-model";
import { parseTasksFromLines } from "../operations/day-note-lines";
import { notesOf } from "../__testing__/notes";
import { emptyApp } from "../__testing__/as-app";

const PATH = "Journal/2026-03-17.md";

/** A note over nothing: these tests fill it by hand rather than off a file. */
function makeFile(): TaskFile {
  const store = { invalidate: vi.fn() } as unknown as DayStore;
  return new TaskFile(store, notesOf(emptyApp()), PATH);
}

function fields(...lines: string[]): TaskFileFields {
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

describe("TaskFile", () => {
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
        run: () => Promise.resolve(),
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
        run: () => Promise.resolve(),
      });
      note.fill(fields("- [ ] Water the plants"));

      expect(held.discarded).toBe(1);
    });
  });
});
