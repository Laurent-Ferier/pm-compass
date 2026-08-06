// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from "vitest";

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
  parseYaml: (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

// The two passes have their own tests; here it is which notes they are given, and which
// this store then vouches for.
const mockRepairListings = vi.fn<typeof import("../project/listing-repair").repairListings>()
  .mockResolvedValue({ listingsRewritten: 0, prefixesFixed: 0, danglingParents: 0, parentsCleared: 0, tasksWithNoProject: 0 });
const mockUnlinkDeletedTask = vi.fn<typeof import("../project/listing-repair").unlinkDeletedTask>()
  .mockResolvedValue(undefined);
const mockSyncChangedNote = vi.fn<typeof import("../project/listing-sync").syncChangedNote>()
  .mockResolvedValue(undefined);

vi.mock("../project/listing-repair", () => ({
  repairListings: (...a: Parameters<typeof import("../project/listing-repair").repairListings>) => mockRepairListings(...a),
  unlinkDeletedTask: (...a: Parameters<typeof import("../project/listing-repair").unlinkDeletedTask>) => mockUnlinkDeletedTask(...a),
}));
vi.mock("../project/listing-sync", () => ({
  syncChangedNote: (...a: Parameters<typeof import("../project/listing-sync").syncChangedNote>) => mockSyncChangedNote(...a),
}));

import { VaultData } from "./vault-data";
import { ProjectTaskNote } from "./project-task-note";
import { DEFAULT_SETTINGS, type PMCompassSettings } from "../settings";
import { asApp } from "../__testing__/as-app";

const FOLDER = "Projects";
const ALPHA = "Projects/Alpha.md";
const T1 = "Projects/Alpha_tasks/t1.md";
const OLD = "Projects/Old.md";
const T2 = "Projects/Old_tasks/t2.md";

function file(path: string): InstanceType<typeof MockTFile> {
  const name = path.split("/").pop()!;
  return new MockTFile(path, "md", name.replace(/\.md$/, ""));
}

/** A folder holding one live project with a task, and — when asked — an archived one too. */
function makeVault(withArchived = false) {
  const notes = new Map<string, Record<string, unknown>>([
    [ALPHA, { "pm-project": true, id: "p1", title: "Alpha" }],
    [T1, { "pm-task": true, id: "t1", projectId: "p1", title: "T1" }],
  ]);
  if (withArchived) {
    notes.set(OLD, { "pm-project": true, id: "p2", title: "Old", archived: true });
    notes.set(T2, { "pm-task": true, id: "t2", projectId: "p2", title: "T2" });
  }
  // Writes land back in `notes`, so a stamped note reads as stamped from then on.
  const processFrontMatter = vi.fn((f: { path: string }, mutate: (fm: Record<string, unknown>) => void) => {
    const fm = notes.get(f.path);
    if (fm) mutate(fm);
    return Promise.resolve();
  });
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
      cachedRead: () => Promise.resolve(""),
    },
    metadataCache: {
      on: on("metadataCache"),
      offref: vi.fn(),
      getFileCache: (f: { path: string }) => {
        const fm = notes.get(f.path);
        return fm ? { frontmatter: fm } : null;
      },
    },
    fileManager: { processFrontMatter },
  });
  const emit = (target: string, event: string, ...args: unknown[]) => {
    for (const cb of handlers[`${target}.${event}`] ?? []) (cb as (...a: unknown[]) => void)(...args);
  };
  return { app, notes, emit, processFrontMatter };
}

async function loaded(vault: ReturnType<typeof makeVault>, overrides: Partial<PMCompassSettings> = {}) {
  const settings = { ...DEFAULT_SETTINGS, projectsFolder: FOLDER, ...overrides };
  const data = new VaultData(vault.app, () => settings);
  data.start();
  const notes = await data.load();
  return { data, notes, settings };
}

/** The set of vouched-for paths, as the dispatcher is handed it. */
const verifiedIn = () => mockSyncChangedNote.mock.calls[0][1];

beforeEach(() => {
  vi.clearAllMocks();
  mockRepairListings.mockResolvedValue({ listingsRewritten: 0, prefixesFixed: 0, danglingParents: 0, parentsCleared: 0, tasksWithNoProject: 0 });
  mockUnlinkDeletedTask.mockResolvedValue(undefined);
  mockSyncChangedNote.mockResolvedValue(undefined);
});

describe("the projects folder's listings", () => {
  it("checks every listing in the folder", async () => {
    const vault = makeVault();
    const { data, notes } = await loaded(vault);

    await notes.ensureListingsVerified();

    expect(mockRepairListings).toHaveBeenCalledWith(data, notes.projects, notes.tasks, {});
  });

  it("vouches for every note it checked, so their boxes can speak for the user", async () => {
    const { notes } = await loaded(makeVault());

    await notes.ensureListingsVerified();
    await notes.syncChangedNote(ALPHA, "body");

    expect(verifiedIn().has(ALPHA)).toBe(true);
    expect(verifiedIn().has(T1)).toBe(true);
  });

  it("leaves an archived project and its tasks out, unchecked and unvouched-for", async () => {
    const { notes } = await loaded(makeVault(true));

    await notes.ensureListingsVerified();
    await notes.syncChangedNote(OLD, "body");

    expect(mockRepairListings.mock.calls[0][1].map((p) => p.filePath)).toEqual([ALPHA]);
    expect(verifiedIn().has(OLD)).toBe(false);
    expect(verifiedIn().has(T2)).toBe(false);
  });

  it("counts the projects it leaves alone, for a caller saying what it skipped", async () => {
    const { notes } = await loaded(makeVault(true));
    expect(notes.archivedCount).toBe(1);
  });

  it("runs once a session, however many times the dashboard renders", async () => {
    const { notes } = await loaded(makeVault());

    await notes.ensureListingsVerified();
    await notes.ensureListingsVerified();

    expect(mockRepairListings).toHaveBeenCalledTimes(1);
  });

  it("checks them from the warm-up, whether or not a dashboard is ever opened", async () => {
    const vault = makeVault();
    const settings = { ...DEFAULT_SETTINGS, projectsFolder: FOLDER };
    const data = new VaultData(vault.app, () => settings);
    data.start();

    data.warm();

    await vi.waitFor(() => expect(mockRepairListings).toHaveBeenCalled());
  });

  it("skips the pass when the user has turned it off", async () => {
    const { notes } = await loaded(makeVault(), { verifyListingsOnLoad: false });

    await notes.ensureListingsVerified();

    expect(mockRepairListings).not.toHaveBeenCalled();
  });

  it("vouches for nothing when the pass fails, so the boxes stay conservative", async () => {
    const { notes } = await loaded(makeVault());
    mockRepairListings.mockRejectedValue(new Error("vault read failed"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(notes.ensureListingsVerified()).resolves.toBeUndefined();
    await notes.syncChangedNote(ALPHA, "body");

    expect(verifiedIn().size).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("hands the dispatcher the path and the content it was given", async () => {
    const { data, notes } = await loaded(makeVault());

    await notes.syncChangedNote(ALPHA, "the body");

    expect(mockSyncChangedNote).toHaveBeenCalledWith(data, expect.any(Set), ALPHA, "the body");
  });

  describe("notes calling themselves tasks that nothing can read as one", () => {
    const BROKEN = "Projects/Alpha_tasks/broken.md";

    it("counts one the reader can't place, which is invisible everywhere else", async () => {
      const vault = makeVault();
      // No `id` and no `projectId`: `parseTask` answers null, so no store holds it.
      vault.notes.set(BROKEN, { "pm-task": true, title: "Broken" });
      const { notes } = await loaded(vault);

      expect((await notes.verifyListings()).unreadableTaskNotes).toBe(1);
    });

    it("counts a second note claiming an id the folder already read", async () => {
      const vault = makeVault();
      vault.notes.set(BROKEN, { "pm-task": true, id: "t1", projectId: "p1", title: "Copy of T1" });
      const { notes } = await loaded(vault);

      expect((await notes.verifyListings()).unreadableTaskNotes).toBe(1);
    });

    it("counts nothing in a folder the reader can place whole", async () => {
      const { notes } = await loaded(makeVault());

      expect((await notes.verifyListings()).unreadableTaskNotes).toBe(0);
    });

    it("leaves an archived project's tasks out of the count, the reader having read them", async () => {
      const { notes } = await loaded(makeVault(true));

      expect((await notes.verifyListings()).unreadableTaskNotes).toBe(0);
    });
  });

  describe("a note that leaves its path", () => {
    it("unlinks a task deleted outside the plugin from whatever listed it", async () => {
      const vault = makeVault();
      await loaded(vault);

      vault.emit("vault", "delete", file(T1));

      expect(mockUnlinkDeletedTask).toHaveBeenCalledWith(vault.app, T1);
    });

    it("takes a deleted note's listing out of good standing", async () => {
      const vault = makeVault();
      const { notes } = await loaded(vault);
      await notes.ensureListingsVerified();

      vault.emit("vault", "delete", file(ALPHA));
      await notes.syncChangedNote(ALPHA, "body");

      expect(verifiedIn().has(ALPHA)).toBe(false);
    });

    it("takes a renamed note's listing out of good standing under its old path", async () => {
      // Whatever arrives at that path next is a different note, and unchecked.
      const vault = makeVault();
      const { notes } = await loaded(vault);
      await notes.ensureListingsVerified();

      vault.emit("vault", "rename", file("Projects/Beta.md"), ALPHA);
      await notes.syncChangedNote(ALPHA, "body");

      expect(verifiedIn().has(ALPHA)).toBe(false);
    });

    it("leaves a renamed task listed, it having moved rather than gone", async () => {
      const vault = makeVault();
      await loaded(vault);

      vault.emit("vault", "rename", file("Projects/Alpha_tasks/t9.md"), T1);

      expect(mockUnlinkDeletedTask).not.toHaveBeenCalled();
    });

    it("says so when the unlink fails, rather than letting the rejection escape", async () => {
      const vault = makeVault();
      await loaded(vault);
      mockUnlinkDeletedTask.mockRejectedValueOnce(new Error("vault read failed"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});

      vault.emit("vault", "delete", file(T1));

      await vi.waitFor(() => expect(err).toHaveBeenCalled());
      err.mockRestore();
    });
  });

  // The store hears these itself, so they are answered whether or not a dashboard is open.
  describe("a note the metadata cache reparsed", () => {
    it("puts it back in step with the content the event carried, rather than re-reading it", async () => {
      const vault = makeVault();
      await loaded(vault);

      vault.emit("metadataCache", "changed", file(ALPHA), "---\nid: p1\n---\n## Tasks\n");

      await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalledWith(
        expect.anything(), expect.any(Set), ALPHA, "---\nid: p1\n---\n## Tasks\n",
      ));
    });

    it("leaves a note outside the folder alone", async () => {
      const vault = makeVault();
      await loaded(vault);

      vault.emit("metadataCache", "changed", file("Elsewhere/x.md"), "body");

      expect(mockSyncChangedNote).not.toHaveBeenCalled();
    });

    it("stamps a task closed outside the plugin, and syncs behind the write", async () => {
      const vault = makeVault();
      vault.notes.set(T1, { "pm-task": true, id: "t1", projectId: "p1", title: "T1", status: "done" });
      await loaded(vault);

      vault.emit("metadataCache", "changed", file(T1), "body");

      // Behind the stamp, not instead of it: together they would write this file at once.
      expect(vault.processFrontMatter).toHaveBeenCalled();
      await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
      expect(vault.notes.get(T1)).toHaveProperty("completed");
    });

    it("leaves a task that already carries a completion date alone", async () => {
      const vault = makeVault();
      vault.notes.set(T1, {
        "pm-task": true, id: "t1", projectId: "p1", title: "T1",
        status: "done", completed: "2026-01-01T00:00:00.000Z",
      });
      await loaded(vault);

      vault.emit("metadataCache", "changed", file(T1), "body");

      expect(vault.processFrontMatter).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
    });

    // Nothing listed a note the plugin never saw arrive — `syncChangedNote` mirrors a task
    // onto the line that holds it and adds none.
    describe("one that has just arrived", () => {
      const T3 = "Projects/Alpha_tasks/t3.md";
      const listed = () => vi.spyOn(ProjectTaskNote.prototype, "ensureListed").mockResolvedValue();

      it("is listed by whatever should hold it", async () => {
        const vault = makeVault();
        await loaded(vault);
        const ensure = listed();

        vault.notes.set(T3, { "pm-task": true, id: "t3", projectId: "p1", title: "Landed" });
        vault.emit("metadataCache", "changed", file(T3), "body");

        await vi.waitFor(() => expect(ensure).toHaveBeenCalled());
        ensure.mockRestore();
      });

      it("leaves a note the folder already read alone — its line is there to mirror onto", async () => {
        const vault = makeVault();
        await loaded(vault);
        const ensure = listed();

        vault.emit("metadataCache", "changed", file(T1), "body");

        await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
        expect(ensure).not.toHaveBeenCalled();
        ensure.mockRestore();
      });

      it("leaves one the plugin is part-way through writing alone", async () => {
        // `createTask` and `moveTask` list the note themselves, and a second writer racing
        // them would append the line twice.
        const vault = makeVault();
        const { data } = await loaded(vault);
        const ensure = listed();

        vault.notes.set(T3, { "pm-task": true, id: "t3", projectId: "p1", title: "Landed" });
        data.invalidate([T3]);
        vault.emit("metadataCache", "changed", file(T3), "body");

        await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
        expect(ensure).not.toHaveBeenCalled();
        ensure.mockRestore();
      });

      it("says so when the listing fails, and syncs anyway", async () => {
        const vault = makeVault();
        await loaded(vault);
        const ensure = listed().mockRejectedValue(new Error("vault read failed"));
        const err = vi.spyOn(console, "error").mockImplementation(() => {});

        vault.notes.set(T3, { "pm-task": true, id: "t3", projectId: "p1", title: "Landed" });
        vault.emit("metadataCache", "changed", file(T3), "body");

        await vi.waitFor(() => expect(err).toHaveBeenCalledWith(
          "pm-compass: couldn't list the task that arrived", expect.any(Error)));
        expect(mockSyncChangedNote).toHaveBeenCalled();
        ensure.mockRestore();
        err.mockRestore();
      });
    });

    it("says so when the sync fails, rather than letting the rejection escape", async () => {
      const vault = makeVault();
      await loaded(vault);
      mockSyncChangedNote.mockRejectedValueOnce(new Error("vault read failed"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});

      vault.emit("metadataCache", "changed", file(ALPHA), "body");

      await vi.waitFor(() => expect(err).toHaveBeenCalledWith(
        "pm-compass: couldn't sync the checklist", expect.any(Error)));
      err.mockRestore();
    });
  });
});
