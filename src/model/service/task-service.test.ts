// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class MockTFile {
    constructor(
      public path: string,
      public extension: string,
      public basename: string,
    ) {}
  }
  class MockTFolder {
    constructor(public children: (MockTFile | MockTFolder)[] = []) {}
  }
  return { MockTFile, MockTFolder };
});

vi.mock("obsidian", async () => ({
  TFile: MockTFile,
  TFolder: MockTFolder,
  normalizePath: (p: string) => p,
  // The fake vault writes a note's frontmatter as JSON, so this reads it straight back.
  parseYaml: (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { TaskService } from "../service/task-service";
import { StoreEvent } from "../store/store-events";
import { DEFAULT_SETTINGS, type PMCompassSettings } from "../settings";
import { asApp } from "../__testing__/as-app";
import { notesOf } from "../__testing__/notes";

const FOLDER = "Projects";
/** Past the store's own coalescing window, and any view debounce on top of it. */
const SETTLED_MS = 200;

function file(path: string): InstanceType<typeof MockTFile> {
  const name = path.split("/").pop()!;
  return new MockTFile(path, "md", name.replace(/\.md$/, ""));
}

/** A vault whose events a test fires by hand; `daysAround` fills in the day notes. */
function makeVault(initial: Record<string, Record<string, unknown>> = {}) {
  const notes = new Map(Object.entries(initial));
  const files = new Map(Object.entries(initial));
  const handlers: Record<string, ((...args: never[]) => void)[]> = {};
  const on = (prefix: string) => (event: string, cb: (...args: never[]) => void) => {
    (handlers[`${prefix}.${event}`] ??= []).push(cb);
    return { event, cb };
  };
  const app = asApp({
    vault: {
      on: on("vault"),
      offref: vi.fn(),
      getAbstractFileByPath: (path: string) => {
        if (notes.has(path)) return file(path);
        if (path !== FOLDER) return null;
        return new MockTFolder([...notes.keys()].map(file));
      },
      cachedRead: (f: { path: string }) =>
        Promise.resolve(`---\n${JSON.stringify(files.get(f.path) ?? {})}\n---\n`),
    },
    // The write itself belongs to `ProjectTaskFile`, tested there; here it only has to
    // return so the marking that follows it can be checked.
    fileManager: { processFrontMatter: () => Promise.resolve() },
    metadataCache: {
      on: on("metadataCache"),
      offref: vi.fn(),
      getFileCache: (f: { path: string }) => {
        const fm = notes.get(f.path);
        return fm ? { frontmatter: fm } : null;
      },
    },
  });
  const emit = (target: string, event: string, ...args: unknown[]) => {
    for (const cb of handlers[`${target}.${event}`] ?? []) (cb as (...a: unknown[]) => void)(...args);
  };
  return { app, notes, files, emit };
}

function makeStore(vault: ReturnType<typeof makeVault>, overrides: Partial<PMCompassSettings> = {}) {
  const settings = { ...DEFAULT_SETTINGS, projectsFolder: FOLDER, ...overrides };
  const store = new TaskService(Object.assign(notesOf(vault.app), { settings: () => settings }));
  store.start();
  return { store, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskService", () => {
  describe("warming the window", () => {
    /** A vault with one note per day either side of `2026-03-17`, each holding one row. */
    function daysAround(before: number, after: number) {
      const notes: Record<string, Record<string, unknown>> = {};
      const vault = makeVault(notes);
      const texts = new Map<string, string>();
      for (let o = -before; o <= after; o++) {
        const d = new Date(2026, 2, 17 + o);
        const path = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.md`;
        texts.set(path, `- [ ] Day ${o}`);
      }
      Object.assign(vault.app.vault, {
        getAbstractFileByPath: (path: string) => (texts.has(path) ? file(path) : null),
        read: (f: { path: string }) => Promise.resolve(texts.get(f.path) ?? ""),
      });
      return vault;
    }

    const CENTRE = new Date(2026, 2, 17);

    it("delivers each day deepest overdue first and farthest ahead last", async () => {
      const { store } = makeStore(daysAround(2, 2));
      const seen: number[] = [];
      store.on(StoreEvent.DayWarmed, ({ offset }) => seen.push(offset));

      store.warmWindow(CENTRE, 2, 2);
      await vi.waitFor(() => expect(seen).toHaveLength(4));

      expect(seen).toEqual([-2, -1, 1, 2]);
    });

    it("leaves the day on show out — its own read covers it", async () => {
      const { store } = makeStore(daysAround(1, 1));
      const seen: number[] = [];
      store.on(StoreEvent.DayWarmed, ({ offset }) => seen.push(offset));

      store.warmWindow(CENTRE, 1, 1);
      await vi.waitFor(() => expect(seen).toHaveLength(2));

      expect(seen).not.toContain(0);
    });

    it("says when the whole window is held", async () => {
      const { store } = makeStore(daysAround(1, 1));
      const finished = vi.fn();
      store.on(StoreEvent.WarmupFinished, finished);

      store.warmWindow(CENTRE, 1, 1);
      await vi.waitFor(() => expect(finished).toHaveBeenCalledWith({ days: 2 }));
    });

    it("stops delivering once a second pass replaces it", async () => {
      const { store } = makeStore(daysAround(2, 2));
      const finished = vi.fn();
      store.on(StoreEvent.WarmupFinished, finished);

      store.warmWindow(CENTRE, 2, 2);
      store.warmWindow(CENTRE, 2, 2);
      await vi.waitFor(() => expect(finished).toHaveBeenCalled());

      expect(finished).toHaveBeenCalledOnce();
    });

    it("holds what it warmed, so the paint that follows needs no read", async () => {
      const { store } = makeStore(daysAround(1, 1));
      const finished = vi.fn();
      store.on(StoreEvent.WarmupFinished, finished);

      store.warmWindow(CENTRE, 1, 1);
      await vi.waitFor(() => expect(finished).toHaveBeenCalled());

      expect(store.daysCached(CENTRE, 1, 1).map((d) => d.offset)).toEqual([-1, 1]);
    });

    it("holds nothing for a window it has not warmed", () => {
      const { store } = makeStore(daysAround(1, 1));
      expect(store.daysCached(CENTRE, 1, 1)).toEqual([]);
    });
  });

  describe("reading a day", () => {
    const TODAY = new Date(2026, 2, 17);

    /** A vault holding whatever notes it is given, recording every file created. */
    function noteVault(initial: Record<string, string> = {}) {
      const texts = new Map(Object.entries(initial));
      const vault = makeVault({});
      const created: string[] = [];
      Object.assign(vault.app.vault, {
        getAbstractFileByPath: (path: string) => (texts.has(path) ? file(path) : null),
        read: (f: { path: string }) => Promise.resolve(texts.get(f.path) ?? ""),
        create: vi.fn((path: string, text: string) => {
          created.push(path);
          texts.set(path, text);
          return Promise.resolve(file(path));
        }),
        createFolder: vi.fn(() => Promise.resolve()),
        adapter: { read: () => Promise.reject(new Error("none")), exists: () => Promise.resolve(false) },
      });
      Object.assign(vault.app, { internalPlugins: { getEnabledPluginById: () => ({}) } });
      return { ...vault, texts, created };
    }

    beforeEach(() => {
      vi.setSystemTime(TODAY);
    });

    it("makes today's note when the vault has none", async () => {
      const vault = noteVault();
      const { store } = makeStore(vault);
      await vi.advanceTimersByTimeAsync(0);

      const day = await store.day(TODAY);

      expect(vault.created).toEqual(["2026-03-17.md"]);
      expect(day.exists).toBe(true);
    });

    // Reading ahead must not litter the vault with empty notes.
    it("leaves another day unmade, reading it only if it has a note", async () => {
      const vault = noteVault();
      const { store } = makeStore(vault);
      await vi.advanceTimersByTimeAsync(0);

      const day = await store.day(new Date(2026, 2, 20));

      expect(vault.created).toEqual([]);
      expect(day.exists).toBe(false);
    });

    // Marking the path on every render would cost a re-read of today's note each time the
    // dashboard paints.
    it("reads today's note once, the ensure leaving a held note alone", async () => {
      const vault = noteVault({ "2026-03-17.md": "- [ ] Something" });
      const reads = vi.fn((f: { path: string }) => Promise.resolve(vault.texts.get(f.path) ?? ""));
      Object.assign(vault.app.vault, { read: reads });
      const { store } = makeStore(vault);
      await vi.advanceTimersByTimeAsync(0);

      await store.day(TODAY);
      await store.day(TODAY);
      await store.day(TODAY);

      expect(reads.mock.calls.filter(([f]) => f.path === "2026-03-17.md")).toHaveLength(1);
    });

    // An edit made outside the plugin owes the note a re-read, not a re-make: the ensure
    // has to see a note that exists, or it invalidates the path it just looked at and the
    // dashboard rebuilds a second time on every external edit.
    it("re-reads today's note after an outside edit, without ensuring it again", async () => {
      const vault = noteVault({ "2026-03-17.md": "- [ ] Something" });
      const { store } = makeStore(vault);
      await vi.advanceTimersByTimeAsync(0);
      await store.day(TODAY);
      const days = (store as unknown as { days: { invalidate: (paths: string[]) => void } }).days;
      const invalidate = vi.spyOn(days, "invalidate");

      vault.texts.set("2026-03-17.md", "- [ ] Something else");
      vault.emit("vault", "modify", file("2026-03-17.md"));
      const day = await store.day(TODAY);

      expect(day.items.map((t) => t.title)).toEqual(["Something else"]);
      expect(invalidate).not.toHaveBeenCalled();
      expect(vault.created).toEqual([]);
    });

    // Templater runs the user's own scripts, so the note can land anywhere; the path
    // `DayNoteService.ensure` hands back is what the read follows.
    it("reads the note Templater made, not the one the naming scheme named", async () => {
      const vault = noteVault({ "templates/daily.md": "" });
      Object.assign(vault.app.vault, {
        adapter: {
          read: () => Promise.resolve(JSON.stringify({ folder: "", format: "YYYY-MM-DD", template: "templates/daily.md" })),
          exists: () => Promise.resolve(true),
        },
      });
      Object.assign(vault.app, {
        plugins: {
          plugins: {
            "templater-obsidian": {
              templater: {
                create_new_note_from_template: () => {
                  vault.texts.set("Journal/elsewhere.md", "- [ ] Landed elsewhere");
                  return Promise.resolve(file("Journal/elsewhere.md"));
                },
              },
            },
          },
        },
      });
      const { store } = makeStore(vault);
      await vi.advanceTimersByTimeAsync(0);

      const day = await store.day(TODAY);

      expect(day.path).toBe("Journal/elsewhere.md");
      expect(day.items.map((t) => t.title)).toEqual(["Landed elsewhere"]);
    });

    it("makes nothing when warming a window that covers today", async () => {
      const vault = noteVault();
      const { store } = makeStore(vault);
      await vi.advanceTimersByTimeAsync(0);
      const finished = vi.fn();
      store.on(StoreEvent.WarmupFinished, finished);

      store.warmWindow(new Date(2026, 2, 20), 5, 1);
      await vi.waitFor(() => expect(finished).toHaveBeenCalled());

      expect(vault.created).toEqual([]);
    });
  });

  describe("putting a day note back in step", () => {
    /** A vault whose day notes exist and can be written, with the writes recorded. */
    function dayVault() {
      const texts = new Map<string, string>([
        ["2026-07-01.md", "- [ ] Something"],
        ["2026-07-03.md", "- [ ] Something"],
        ["2026-06-29.md", "- [ ] Something"],
        ["2026-01-01.md", "- [ ] Something"],
      ]);
      const vault = makeVault();
      const modify = vi.fn((f: { path: string }, text: string) => {
        texts.set(f.path, text);
        return Promise.resolve();
      });
      Object.assign(vault.app.vault, {
        getAbstractFileByPath: (path: string) => (texts.has(path) ? file(path) : null),
        read: (f: { path: string }) => Promise.resolve(texts.get(f.path) ?? ""),
        modify,
      });
      return { ...vault, texts, modify };
    }

    /** One habit, scheduled every day, so a note lacking it is one to put back in step. */
    const HABITS = {
      recurringTasks: [{
        id: "h1", title: "Stretch", weekdays: 0b1111111, order: 0, active: true,
        createdAt: new Date(2026, 0, 1), detail: "",
      }],
      recurringTasksHeading: "# Tasks",
    } as unknown as Partial<PMCompassSettings>;

    async function reconcile(at: Date, note: Date, overrides = HABITS) {
      vi.setSystemTime(at);
      const vault = dayVault();
      const { store } = makeStore(vault, overrides);
      await vi.advanceTimersByTimeAsync(0);
      const path = `${note.getFullYear()}-${String(note.getMonth() + 1).padStart(2, "0")}-${String(note.getDate()).padStart(2, "0")}.md`;
      store.reconcileDay(path);
      await vi.advanceTimersByTimeAsync(2000);
      return { vault, store, path };
    }

    it("puts a note for today back in step", async () => {
      const { vault } = await reconcile(new Date(2026, 6, 1), new Date(2026, 6, 1));
      expect(vault.modify).toHaveBeenCalled();
    });

    it("leaves a later day this week to be put in step too", async () => {
      const { vault } = await reconcile(new Date(2026, 6, 1), new Date(2026, 6, 3));
      expect(vault.modify).toHaveBeenCalled();
    });

    it("leaves a day earlier this week alone, habits belonging to the day they were for", async () => {
      const { vault } = await reconcile(new Date(2026, 6, 1), new Date(2026, 5, 29));
      expect(vault.modify).not.toHaveBeenCalled();
    });

    it("leaves a day outside this week alone", async () => {
      const { vault } = await reconcile(new Date(2026, 6, 1), new Date(2026, 0, 1));
      expect(vault.modify).not.toHaveBeenCalled();
    });

    it("does nothing for a path that names no day", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);

      store.reconcileDay("Not/A/Daily/Note.md");
      await vi.advanceTimersByTimeAsync(2000);

      expect(vault.modify).not.toHaveBeenCalled();
    });

    it("gathers repeated opens of one note into a single pass", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);

      store.reconcileDay("2026-07-01.md");
      store.reconcileDay("2026-07-01.md");
      await vi.advanceTimersByTimeAsync(2000);

      expect(vault.modify).toHaveBeenCalledOnce();
    });

    it("re-reads what a pass wrote before it broke off", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);
      const days = (store as unknown as { days: { invalidate: (paths: string[]) => void } }).days;
      const invalidate = vi.spyOn(days, "invalidate");
      // The habits land, then the inbox half throws: the note is written either way.
      vault.app.vault.read = (f: { path: string }) => (f.path === store.inboxPath
        ? Promise.reject(new Error("no"))
        : Promise.resolve(vault.texts.get(f.path) ?? ""));
      vault.texts.set(store.inboxPath, "- [ ] Waiting ⏳ 2026-07-01");

      store.reconcileDay("2026-07-01.md");
      await vi.advanceTimersByTimeAsync(2000);

      expect(vault.modify).toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining(["2026-07-01.md"]));
    });

    // The migration writes into two notes, each marking its own re-read — so the paths
    // arrive one call apiece rather than as one list the pass carried up.
    it("re-reads the day note an inbox item was moved into", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);
      const days = (store as unknown as { days: { invalidate: (paths: string[]) => void } }).days;
      const invalidate = vi.spyOn(days, "invalidate");
      // Aimed at a day other than the one being reconciled, so the habit pass isn't what
      // names it.
      vault.texts.set(store.inboxPath, "- [ ] Waiting ⏳ 2026-07-03");

      store.reconcileDay("2026-07-01.md");
      await vi.advanceTimersByTimeAsync(2000);

      expect(invalidate.mock.calls.flat(2)).toContain(store.inboxPath);
      expect(invalidate.mock.calls.flat(2)).toContain("2026-07-03.md");
    });

    it("moves an inbox item into the day it was aimed at", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);
      vault.texts.set(store.inboxPath, "- [ ] Buy milk ⏳ 2026-07-03");

      store.reconcileDay("2026-07-01.md");
      await vi.advanceTimersByTimeAsync(2000);

      expect(vault.texts.get(store.inboxPath)).toBe("");
      expect(vault.texts.get("2026-07-03.md")).toContain("- [ ] Buy milk");
    });

    // Which day it is guards the habits alone. An item aimed at any day that has a note
    // belongs in it, and a note appearing is what makes the pass worth running at all.
    it("moves inbox items for a day outside this week, whose habits it leaves alone", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);
      vault.texts.set("2026-07-08.md", "- [ ] Something");
      vault.texts.set(store.inboxPath, "- [ ] Buy milk ⏳ 2026-07-03");

      store.reconcileDay("2026-07-08.md");
      await vi.advanceTimersByTimeAsync(2000);

      expect(vault.texts.get("2026-07-08.md")).toBe("- [ ] Something");
      expect(vault.texts.get("2026-07-03.md")).toContain("- [ ] Buy milk");
    });

    it("marks nothing when there was neither a habit nor an inbox item to write", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);
      vault.texts.set("2026-07-08.md", "- [ ] Something");
      const days = (store as unknown as { days: { invalidate: (paths: string[]) => void } }).days;
      const invalidate = vi.spyOn(days, "invalidate");

      store.reconcileDay("2026-07-08.md");
      await vi.advanceTimersByTimeAsync(2000);

      expect(invalidate).not.toHaveBeenCalled();
    });

    it("drops a pass still waiting once the store is disposed", async () => {
      vi.setSystemTime(new Date(2026, 6, 1));
      const vault = dayVault();
      const { store } = makeStore(vault, HABITS);
      await vi.advanceTimersByTimeAsync(0);

      store.reconcileDay("2026-07-01.md");
      store.dispose();
      await vi.advanceTimersByTimeAsync(2000);

      expect(vault.modify).not.toHaveBeenCalled();
    });
  });

  it("says nothing more once disposed", () => {
    const vault = makeVault();
    const { store } = makeStore(vault);
    const heard = vi.fn();
    store.on(StoreEvent.DaysChanged, heard);

    store.dispose();
    vault.emit("metadataCache", "changed", file("2026-03-17.md"));
    vi.advanceTimersByTime(SETTLED_MS);

    expect(heard).not.toHaveBeenCalled();
  });
});
