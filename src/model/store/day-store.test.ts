// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  return { MockTFile };
});

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: MockTFile,
  Notice: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { DayStore } from "./day-store";
import { asApp } from "../__testing__/as-app";
import { day } from "../__testing__/dates";
import type { DailyNotesConfig } from "../daily/week-summary";
import { notesOf } from "../__testing__/notes";
import { ChangeOrigin, StoreEvent } from "./store-events";

const CONFIG: DailyNotesConfig = { folder: "Journal", format: "YYYY-MM-DD", template: "" };
const INBOX = "Inbox.md";

/** A vault of note text, keyed by path. Writing to `files` between reads is how a test
 *  says a note changed under the store. */
function makeVault(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const read = vi.fn((f: { path: string }) => Promise.resolve(files.get(f.path) ?? ""));
  const handlers: Record<string, ((...args: never[]) => void)[]> = {};
  const on = (prefix: string) => (event: string, cb: (...args: never[]) => void) => {
    (handlers[`${prefix}.${event}`] ??= []).push(cb);
    return { event, cb };
  };
  const app = asApp({
    metadataCache: { on: on("metadataCache"), offref: vi.fn() },
    vault: {
      on: on("vault"),
      offref: vi.fn(),
      getAbstractFileByPath: (path: string) => (files.has(path) ? new MockTFile(path) : null),
      read,
      modify: vi.fn((f: { path: string }, text: string) => {
        files.set(f.path, text);
        return Promise.resolve();
      }),
      create: vi.fn((path: string, text: string) => {
        files.set(path, text);
        return Promise.resolve(new MockTFile(path));
      }),
      adapter: { read: () => Promise.reject(new Error("no config")) },
      configDir: ".vault-config",
    },
  });
  const emit = (target: string, event: string, ...args: unknown[]) => {
    for (const cb of handlers[`${target}.${event}`] ?? []) (cb as (...a: unknown[]) => void)(...args);
  };
  return { app, files, read, emit };
}

const store = (vault: ReturnType<typeof makeVault>, dayArrived: (path: string) => void = () => {}) =>
  new DayStore(notesOf(vault.app), CONFIG, INBOX, dayArrived);

describe("DayStore", () => {
  it("reads a day's checklist off the note that day's name points at", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] Water the plants" });

    const entry = await store(vault).day(day("2026-03-17"));

    expect(entry.items.map((i) => i.title)).toEqual(["Water the plants"]);
    expect(entry.path).toBe("Journal/2026-03-17.md");
  });

  it("reads a day with no note as an empty one, rather than making it", async () => {
    const vault = makeVault();

    const entry = await store(vault).day(day("2026-03-17"));

    expect(entry.exists).toBe(false);
    expect(entry.items).toEqual([]);
    expect(vault.app.vault.create).not.toHaveBeenCalled();
  });

  it("keeps the note's own lines, for a reader wanting its own reading of them", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "# Today\n- [ ] One\n\t- [ ] Nested" });

    const entry = await store(vault).day(day("2026-03-17"));

    expect(entry.lines).toEqual(["# Today", "- [ ] One", "\t- [ ] Nested"]);
    // The nested line belongs to the task above it, not beside it.
    expect(entry.items).toHaveLength(1);
  });

  it("reads the same day only once while nothing has changed", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
    const held = store(vault);

    await held.day(day("2026-03-17"));
    vault.read.mockClear();
    await held.day(day("2026-03-17"));

    expect(vault.read).not.toHaveBeenCalled();
  });

  it("re-reads a day the moment it hears the note changed", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
    const held = store(vault);
    await held.day(day("2026-03-17"));

    vault.files.set("Journal/2026-03-17.md", "- [ ] Two");
    held.touch("Journal/2026-03-17.md");

    expect((await held.day(day("2026-03-17"))).items.map((i) => i.title)).toEqual(["Two"]);
  });

  describe("the day it hands out", () => {
    it("is the same one reading after reading", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
      const held = store(vault);

      const first = await held.day(day("2026-03-17"));
      held.touch("Journal/2026-03-17.md");

      expect(await held.day(day("2026-03-17"))).toBe(first);
    });

    it("takes what a changed line now says onto the row already handed out", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
      const held = store(vault);
      const row = (await held.day(day("2026-03-17"))).items[0];

      vault.files.set("Journal/2026-03-17.md", "- [x] One ✅ 2026-03-17");
      held.touch("Journal/2026-03-17.md");
      await held.day(day("2026-03-17"));

      expect(row.checked).toBe(true);
    });

    it("tells a row its line has gone", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One\n- [ ] Two" });
      const held = store(vault);
      const row = (await held.day(day("2026-03-17"))).items[0];

      vault.files.set("Journal/2026-03-17.md", "- [ ] Two");
      held.touch("Journal/2026-03-17.md");
      const entry = await held.day(day("2026-03-17"));

      expect(row.isGone).toBe(true);
      expect(entry.items.map((i) => i.title)).toEqual(["Two"]);
    });
  });

  describe("changing a row", () => {
    const rowOf = async (held: DayStore) => (await held.day(day("2026-03-17"))).items[0];

    it("ticks the line on the file, and the row with it", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
      const held = store(vault);
      const row = await rowOf(held);

      row.setChecked(true);
      await row.flush();

      expect(row.checked).toBe(true);
      expect(vault.files.get("Journal/2026-03-17.md")).toMatch(/^- \[x\] One ✅ \d{4}-\d{2}-\d{2}$/);
    });

    it("rewrites the title, the row keeping its place", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One ➕ 2026-03-01" });
      const held = store(vault);
      const row = await rowOf(held);

      row.setTitle("Two");
      await row.flush();

      expect(row.title).toBe("Two");
      expect(vault.files.get("Journal/2026-03-17.md")).toBe("- [ ] Two ➕ 2026-03-01");
    });

    it("still names the renamed row after a re-read, rather than losing it", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
      const held = store(vault);
      const row = await rowOf(held);

      row.setTitle("Two");
      await row.flush();
      held.touch("Journal/2026-03-17.md");
      const entry = await held.day(day("2026-03-17"));

      expect(row.isGone).toBe(false);
      expect(entry.items[0]).toBe(row);
    });

    it("takes the line out of the note", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One\n- [ ] Two" });
      const held = store(vault);
      const row = await rowOf(held);

      row.remove();
      await row.flush();

      expect(vault.files.get("Journal/2026-03-17.md")).toBe("- [ ] Two");
    });

    it("writes nothing for a value the line already says", async () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
      const held = store(vault);
      const row = await rowOf(held);

      row.setChecked(false);
      await row.flush();

      expect(vault.app.vault.modify).not.toHaveBeenCalled();
    });
  });

  it("leaves the days it wasn't told about alone", async () => {
    const vault = makeVault({
      "Journal/2026-03-17.md": "- [ ] One",
      "Journal/2026-03-18.md": "- [ ] Two",
    });
    const held = store(vault);
    await held.day(day("2026-03-17"));
    await held.day(day("2026-03-18"));

    vault.read.mockClear();
    held.touch("Journal/2026-03-17.md");
    await held.day(day("2026-03-17"));
    await held.day(day("2026-03-18"));

    expect(vault.read.mock.calls.map(([f]) => f.path)).toEqual(["Journal/2026-03-17.md"]);
  });

  it("forgets a day whose note was deleted", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
    const held = store(vault);
    await held.day(day("2026-03-17"));

    vault.files.delete("Journal/2026-03-17.md");
    held.drop("Journal/2026-03-17.md");

    expect((await held.day(day("2026-03-17"))).exists).toBe(false);
  });

  it("holds nothing for a day it hasn't read", () => {
    expect(store(makeVault()).cached(day("2026-03-17"))).toBeNull();
  });

  it("holds nothing for a day whose note has changed since it was read", async () => {
    // What it read is a reading the vault has left behind; handing it over would paint
    // rows that are no longer there, and the fresh read is the caller's to wait for.
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
    const held = store(vault);
    await held.day(day("2026-03-17"));

    held.touch("Journal/2026-03-17.md");

    expect(held.cached(day("2026-03-17"))).toBeNull();
  });

  it("hands back a day it has read without waiting", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
    const held = store(vault);
    await held.day(day("2026-03-17"));

    expect(held.cached(day("2026-03-17"))?.items).toHaveLength(1);
  });

  describe("which paths it owns", () => {
    it("takes a note named as a day under the daily-notes folder", () => {
      expect(store(makeVault()).touch("Journal/2026-03-17.md")).toBe(true);
    });

    it("takes the inbox", () => {
      expect(store(makeVault()).touch(INBOX)).toBe(true);
    });

    it("leaves a note that isn't named as a day alone", () => {
      expect(store(makeVault()).touch("Journal/Notes.md")).toBe(false);
    });

    it("leaves a day-named note outside the folder alone", () => {
      expect(store(makeVault()).touch("Elsewhere/2026-03-17.md")).toBe(false);
    });
  });

  describe("the inbox", () => {
    it("reads its lines", async () => {
      const vault = makeVault({ [INBOX]: "- [ ] Buy milk" });

      expect((await store(vault).inbox()).items.map((i) => i.title)).toEqual(["Buy milk"]);
    });

    it("belongs to no day", async () => {
      expect((await store(makeVault({ [INBOX]: "- [ ] One" })).inbox()).date).toBeNull();
    });

    it("drops the lines ticked off, which have been filed elsewhere already", async () => {
      const vault = makeVault({ [INBOX]: "- [x] Done with this\n- [ ] Still to do" });

      const entry = await store(vault).inbox();

      expect(entry.items.map((i) => i.title)).toEqual(["Still to do"]);
      expect(vault.files.get(INBOX)).toBe("- [ ] Still to do");
    });

    it("writes nothing when there is nothing ticked off", async () => {
      const vault = makeVault({ [INBOX]: "- [ ] Still to do" });

      await store(vault).inbox();

      expect(vault.app.vault.modify).not.toHaveBeenCalled();
    });

    it("writes nothing on the second read, having pruned on the first", async () => {
      const vault = makeVault({ [INBOX]: "- [x] Done\n- [ ] To do" });
      const held = store(vault);
      await held.inbox();
      vi.mocked(vault.app.vault.modify).mockClear();

      await held.inbox();

      expect(vault.app.vault.modify).not.toHaveBeenCalled();
    });
  });

  it("drops what it held once the daily-notes scheme moves", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
    const held = store(vault);
    await held.day(day("2026-03-17"));

    held.retarget({ folder: "Days", format: "YYYY-MM-DD", template: "" }, INBOX);

    expect(held.cached(day("2026-03-17"))).toBeNull();
    expect((await held.day(day("2026-03-17"))).path).toBe("Days/2026-03-17.md");
  });

  it("keeps what it held when the settings land on the same scheme", async () => {
    const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
    const held = store(vault);
    await held.day(day("2026-03-17"));

    held.retarget({ ...CONFIG }, INBOX);

    expect(held.cached(day("2026-03-17"))).not.toBeNull();
  });

  describe("telling the views a day changed", () => {
    const DAY = "Journal/2026-03-17.md";

    /** The window a burst of changes is gathered into, run out. */
    const settle = () => vi.advanceTimersByTime(100);

    /** A store watching the vault, with the tellings it has made so far. */
    const watching = (vault: ReturnType<typeof makeVault>) => {
      const held = store(vault);
      held.start();
      const told: { paths: string[]; origin: ChangeOrigin }[] = [];
      held.on(StoreEvent.DaysChanged, (payload) => told.push(payload));
      return { held, told };
    };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("marks a write of the plugin's own as one the view can draw at once", () => {
      const { held, told } = watching(makeVault({ [DAY]: "- [ ] One" }));

      held.invalidate([DAY]);
      settle();

      expect(told).toEqual([{ paths: [DAY], origin: ChangeOrigin.Plugin }]);
    });

    it("marks an edit from outside the plugin as the vault's", () => {
      const vault = makeVault({ [DAY]: "- [ ] One" });
      const { told } = watching(vault);

      vault.emit("vault", "modify", new MockTFile(DAY));
      settle();

      expect(told).toEqual([{ paths: [DAY], origin: ChangeOrigin.Vault }]);
    });

    it("still calls it its own when its write echoes back as a vault event", () => {
      const vault = makeVault({ [DAY]: "- [ ] One" });
      const { held, told } = watching(vault);

      held.invalidate([DAY]);
      vault.emit("vault", "modify", new MockTFile(DAY));
      vault.emit("metadataCache", "changed", new MockTFile(DAY), "- [x] One");
      settle();

      expect(told).toEqual([{ paths: [DAY], origin: ChangeOrigin.Plugin }]);
    });

    it("takes the vault's word for an edit landing on a note it has read since writing", async () => {
      const vault = makeVault({ [DAY]: "- [ ] One" });
      const { held, told } = watching(vault);

      held.invalidate([DAY]);
      await held.day(day("2026-03-17"));
      vault.emit("vault", "modify", new MockTFile(DAY));
      settle();

      expect(told).toEqual([{ paths: [DAY], origin: ChangeOrigin.Vault }]);
    });

    it("says nothing more once a read has taken the change in", async () => {
      // The re-read is the store catching up to what it has already told the views about;
      // telling them again would ask for a second rebuild of what they are drawing.
      const vault = makeVault({ [DAY]: "- [ ] One" });
      const { held, told } = watching(vault);
      await held.day(day("2026-03-17"));

      vault.files.set(DAY, "- [x] One ✅ 2026-03-17");
      held.invalidate([DAY]);
      settle();
      await held.day(day("2026-03-17"));
      settle();

      expect(told).toHaveLength(1);
    });
  });

  describe("a day note appearing in the vault", () => {
    it("is filed for a pass that puts it back in step", () => {
      const vault = makeVault();
      const arrived = vi.fn();
      store(vault, arrived).start();

      vault.emit("vault", "create", new MockTFile("Journal/2026-03-17.md"));

      expect(arrived).toHaveBeenCalledWith("Journal/2026-03-17.md");
    });

    it("is left alone when it is only edited — a note being typed into is not one to rewrite", () => {
      const vault = makeVault({ "Journal/2026-03-17.md": "- [ ] One" });
      const arrived = vi.fn();
      store(vault, arrived).start();

      vault.emit("vault", "modify", new MockTFile("Journal/2026-03-17.md"));
      vault.emit("metadataCache", "changed", new MockTFile("Journal/2026-03-17.md"), "- [ ] One");

      expect(arrived).not.toHaveBeenCalled();
    });

    it("says nothing about a note that is no day of this store's", () => {
      const vault = makeVault();
      const arrived = vi.fn();
      store(vault, arrived).start();

      vault.emit("vault", "create", new MockTFile("Projects/Alpha.md"));

      expect(arrived).not.toHaveBeenCalled();
    });
  });
});
