// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  TFile: class { path = ""; },
  normalizePath: (p: string) => p,
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { DayNote } from "./day-note";
import type { ModelCache } from "../base-model";
import type { IModel } from "../i-model";
import { makeDayVault } from "../__testing__/day-vault";
import { day } from "../__testing__/dates";

const PATH = "Journal/2026-08-09.md";
const DATE = day("2026-08-09");

function cache(): ModelCache & { told: IModel[] } {
  const told: IModel[] = [];
  return { told, changed: (model) => { told.push(model); } };
}

/** A day note over a file holding that text, read once — which is what a cache does before
 *  it hands one out. */
async function dayNote(text: string, date: Date | null = DATE) {
  const vault = makeDayVault({ [PATH]: text });
  const file = vault.files.file(PATH);
  const told = cache();
  const note = new DayNote(file, told, date);
  file.fill(await file.read());
  return { vault, file, note, told };
}

const CHECKLIST = [
  "# Tasks",
  "- [ ] Draft the scoping note",
  "- [ ] Call the garage #daily",
  "- [x] Sort the photos",
].join("\n");

describe("DayNote", () => {
  it("is named by where it sits, a day's lines carrying no id of their own", async () => {
    const { note } = await dayNote(CHECKLIST);

    expect(note.id).toBe(PATH);
    expect(note.path).toBe(PATH);
  });

  it("says its file is there, and says so when it isn't", async () => {
    const { note } = await dayNote(CHECKLIST);
    expect(note.exists).toBe(true);

    const missing = makeDayVault();
    const file = missing.files.file(PATH);
    const absent = new DayNote(file, cache(), DATE);
    file.fill(await file.read());

    expect(absent.exists).toBe(false);
    expect(absent.items).toEqual([]);
  });

  it("hands over its lines as the file reads them", async () => {
    const { note } = await dayNote(CHECKLIST);

    expect(note.lines).toEqual(CHECKLIST.split("\n"));
  });

  it("holds one row per checklist line, in file order", async () => {
    const { note } = await dayNote(CHECKLIST);

    expect(note.items.map((t) => t.title))
      .toEqual(["Draft the scoping note", "Call the garage #daily", "Sort the photos"]);
  });

  it("carries the day it stands for onto its rows", async () => {
    const { note } = await dayNote(CHECKLIST);

    expect(note.items[0].noteDate).toEqual(DATE);
  });

  it("keeps the row standing for a line that was there before", async () => {
    const { vault, file, note } = await dayNote(CHECKLIST);
    const held = note.items[0];

    vault.contents.set(PATH, `${CHECKLIST}\n- [ ] Book the room`);
    file.fill(await file.read());

    expect(note.items[0]).toBe(held);
    expect(note.items).toHaveLength(4);
  });

  it("loses the row of a line that has gone", async () => {
    const { vault, file, note } = await dayNote(CHECKLIST);

    vault.contents.set(PATH, "# Tasks\n- [ ] Sort the photos");
    file.fill(await file.read());

    expect(note.items.map((t) => t.title)).toEqual(["Sort the photos"]);
  });

  it("tells the cache once its rows stand, not as the lines land", async () => {
    const { vault, file, note, told } = await dayNote(CHECKLIST);
    told.told.length = 0;

    vault.contents.set(PATH, "# Tasks\n- [ ] Sort the photos");
    file.fill(await file.read());

    expect(told.told).toContain(note);
  });

  it("says nothing when a re-read lands the lines it already held", async () => {
    const { file, note, told } = await dayNote(CHECKLIST);
    told.told.length = 0;

    file.fill(await file.read());

    expect(told.told).not.toContain(note);
  });

  describe("what the day still has to do", () => {
    it("leaves out what is closed, and the habits it carries every day", async () => {
      const { note } = await dayNote(CHECKLIST);

      expect(note.unclosedItems("daily").map((t) => t.title))
        .toEqual(["Draft the scoping note"]);
    });

    it("keeps a habit whose tag isn't the one asked about", async () => {
      const { note } = await dayNote(CHECKLIST);

      expect(note.unclosedItems("routine").map((t) => t.title))
        .toEqual(["Draft the scoping note", "Call the garage #daily"]);
    });
  });

  it("stands for no day at all when it is given none", async () => {
    const { note } = await dayNote(CHECKLIST, null);

    expect(note.date).toBeNull();
    expect(note.items[0].noteDate).toBeNull();
  });
});
