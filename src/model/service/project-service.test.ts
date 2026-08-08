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
import { ProjectTaskIO } from "../io/project-task-io";
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
      // The file itself, which is what a note owed a read off it is read from — the
      // fake vault spells frontmatter as JSON, and the `parseYaml` above reads it back.
      cachedRead: (f: { path: string }) =>
        Promise.resolve(`---\n${JSON.stringify(notes.get(f.path) ?? {})}\n---\n`),
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
  return { data, notes, projects: data.projects, settings };
}

/** Past the window a burst of vault events is gathered into — what a test asserting that
 *  nothing was reconciled has to wait out. */
const settled = () => new Promise((r) => window.setTimeout(r, 80));

beforeEach(() => {
  vi.clearAllMocks();
  mockRepairListings.mockResolvedValue({ listingsRewritten: 0, prefixesFixed: 0, danglingParents: 0, parentsCleared: 0, tasksWithNoProject: 0 });
  mockUnlinkDeletedTask.mockResolvedValue(undefined);
  mockSyncChangedNote.mockResolvedValue(undefined);
});

describe("the projects folder's listings", () => {
  it("checks every listing in the folder", async () => {
    const vault = makeVault();
    const { data, notes, projects } = await loaded(vault);

    await projects.ensureListingsVerified();

    expect(mockRepairListings).toHaveBeenCalledWith(data, notes.projects, notes.tasks, {});
  });

  it("leaves an archived project and its tasks out of the check", async () => {
    const { projects } = await loaded(makeVault(true));

    await projects.ensureListingsVerified();

    expect(mockRepairListings.mock.calls[0][1].map((p) => p.filePath)).toEqual([ALPHA]);
  });

  it("counts the projects it leaves alone, for a caller saying what it skipped", async () => {
    const { projects } = await loaded(makeVault(true));
    expect(projects.archivedCount).toBe(1);
  });

  it("runs once a session, however many times the dashboard renders", async () => {
    const { projects } = await loaded(makeVault());

    await projects.ensureListingsVerified();
    await projects.ensureListingsVerified();

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
    const { projects } = await loaded(makeVault(), { verifyListingsOnLoad: false });

    await projects.ensureListingsVerified();

    expect(mockRepairListings).not.toHaveBeenCalled();
  });

  it("says so when the pass fails, rather than letting the rejection escape", async () => {
    const { projects } = await loaded(makeVault());
    mockRepairListings.mockRejectedValue(new Error("vault read failed"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(projects.ensureListingsVerified()).resolves.toBeUndefined();

    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("hands the dispatcher the path and the notes it is to read through", async () => {
    const { data, projects } = await loaded(makeVault());

    await projects.syncChangedNote(ALPHA);

    expect(mockSyncChangedNote).toHaveBeenCalledWith(data, ALPHA);
  });

  describe("notes calling themselves tasks that nothing can read as one", () => {
    const BROKEN = "Projects/Alpha_tasks/broken.md";

    it("counts one the reader can't place, which is invisible everywhere else", async () => {
      const vault = makeVault();
      // No `id` and no `projectId`: `parseTask` answers null, so no store holds it.
      vault.notes.set(BROKEN, { "pm-task": true, title: "Broken" });
      const { projects } = await loaded(vault);

      expect((await projects.verifyListings()).unreadableTaskNotes).toBe(1);
    });

    it("counts a second note claiming an id the folder already read", async () => {
      const vault = makeVault();
      vault.notes.set(BROKEN, { "pm-task": true, id: "t1", projectId: "p1", title: "Copy of T1" });
      const { projects } = await loaded(vault);

      expect((await projects.verifyListings()).unreadableTaskNotes).toBe(1);
    });

    it("counts nothing in a folder the reader can place whole", async () => {
      const { projects } = await loaded(makeVault());

      expect((await projects.verifyListings()).unreadableTaskNotes).toBe(0);
    });

    it("leaves an archived project's tasks out of the count, the reader having read them", async () => {
      const { projects } = await loaded(makeVault(true));

      expect((await projects.verifyListings()).unreadableTaskNotes).toBe(0);
    });
  });

  describe("a note that leaves its path", () => {
    it("unlinks a task deleted outside the plugin from whatever listed it", async () => {
      const vault = makeVault();
      await loaded(vault);

      vault.emit("vault", "delete", file(T1));

      expect(mockUnlinkDeletedTask).toHaveBeenCalledWith(expect.anything(), T1);
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

  // The store hears these itself, so they are answered whether or not a dashboard is open —
  // and it answers the notes whose reading moved, not every path Obsidian reparsed.
  describe("a note that changed under the store", () => {
    /** That note's frontmatter, saying something it didn't say before. */
    const edit = (vault: ReturnType<typeof makeVault>, path: string, fm: Record<string, unknown>) => {
      vault.notes.set(path, fm);
      vault.emit("metadataCache", "changed", file(path));
    };

    it("puts it back in step, off the path alone", async () => {
      const vault = makeVault();
      await loaded(vault);

      edit(vault, ALPHA, { "pm-project": true, id: "p1", title: "Alpha renamed" });

      await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalledWith(
        expect.anything(), ALPHA,
      ));
    });

    it("leaves alone one Obsidian reparsed to what it already said", async () => {
      const vault = makeVault();
      await loaded(vault);

      // The same frontmatter, read again: a write of the plugin's own coming back, or
      // Obsidian repeating itself. Nothing moved, so there is nothing to put back in step.
      vault.emit("metadataCache", "changed", file(ALPHA));

      await settled();
      expect(mockSyncChangedNote).not.toHaveBeenCalled();
    });

    it("leaves a note outside the folder alone", async () => {
      const vault = makeVault();
      await loaded(vault);

      vault.emit("metadataCache", "changed", file("Elsewhere/x.md"));

      await settled();
      expect(mockSyncChangedNote).not.toHaveBeenCalled();
    });

    it("stamps a task closed outside the plugin, and syncs behind the write", async () => {
      const vault = makeVault();
      await loaded(vault);

      edit(vault, T1, { "pm-task": true, id: "t1", projectId: "p1", title: "T1", status: "done" });

      // Behind the stamp, not instead of it: together they would write this file at once.
      await vi.waitFor(() => expect(vault.processFrontMatter).toHaveBeenCalled());
      await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
      expect(vault.notes.get(T1)).toHaveProperty("completed");
    });

    it("leaves a task that already carries a completion date alone", async () => {
      const vault = makeVault();
      await loaded(vault);

      edit(vault, T1, {
        "pm-task": true, id: "t1", projectId: "p1", title: "T1",
        status: "done", completed: "2026-01-01T00:00:00.000Z",
      });

      await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
      expect(vault.processFrontMatter).not.toHaveBeenCalled();
    });

    // Nothing listed a note the plugin never saw arrive — `syncChangedNote` mirrors a task
    // onto the line that holds it and adds none.
    describe("one that has just arrived", () => {
      const T3 = "Projects/Alpha_tasks/t3.md";
      const listed = () => vi.spyOn(ProjectTaskIO.prototype, "ensureListed").mockResolvedValue();

      it("is listed by whatever should hold it", async () => {
        const vault = makeVault();
        await loaded(vault);
        const ensure = listed();

        edit(vault, T3, { "pm-task": true, id: "t3", projectId: "p1", title: "Landed" });

        await vi.waitFor(() => expect(ensure).toHaveBeenCalled());
        ensure.mockRestore();
      });

      it("leaves a note the folder already read alone — its line is there to mirror onto", async () => {
        const vault = makeVault();
        await loaded(vault);
        const ensure = listed();

        edit(vault, T1, { "pm-task": true, id: "t1", projectId: "p1", title: "Renamed" });

        await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
        expect(ensure).not.toHaveBeenCalled();
        ensure.mockRestore();
      });

      it("leaves one the plugin is part-way through writing alone", async () => {
        // `createTask` and `moveTask` list the note themselves, and a second writer racing
        // them would append the line twice. The lazy read that follows the write picks the
        // note up as any other, by which time it is no longer an arrival.
        const vault = makeVault();
        const { data } = await loaded(vault);
        const ensure = listed();

        vault.notes.set(T3, { "pm-task": true, id: "t3", projectId: "p1", title: "Landed" });
        data.projects.notes.invalidate(T3);
        vault.emit("metadataCache", "changed", file(T3));
        // A second note that did move, so the window this one is not reconciled in closes.
        edit(vault, ALPHA, { "pm-project": true, id: "p1", title: "Alpha renamed" });

        await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalled());
        expect(ensure).not.toHaveBeenCalled();
        ensure.mockRestore();
      });

      it("says so when the listing fails, and syncs anyway", async () => {
        const vault = makeVault();
        await loaded(vault);
        const ensure = listed().mockRejectedValue(new Error("vault read failed"));
        const err = vi.spyOn(console, "error").mockImplementation(() => {});

        edit(vault, T3, { "pm-task": true, id: "t3", projectId: "p1", title: "Landed" });

        await vi.waitFor(() => expect(err).toHaveBeenCalledWith(
          "pm-compass: couldn't list the task that arrived", expect.any(Error)));
        expect(mockSyncChangedNote).toHaveBeenCalled();
        ensure.mockRestore();
        err.mockRestore();
      });
    });

    it("takes the read a write of its own left owed, with no view open to ask for it", async () => {
      const vault = makeVault();
      const { data } = await loaded(vault);

      // What a write of the plugin's own leaves behind: a note to be read off the file,
      // the metadata cache still holding what it said before. The reparse can't answer it.
      data.projects.notes.invalidate(T1);
      vault.notes.set(T1, { "pm-task": true, id: "t1", projectId: "p1", title: "Renamed" });
      vault.emit("metadataCache", "changed", file(T1));

      await vi.waitFor(() => expect(mockSyncChangedNote).toHaveBeenCalledWith(
        expect.anything(), T1,
      ));
    });

    it("says so when the sync fails, rather than letting the rejection escape", async () => {
      const vault = makeVault();
      await loaded(vault);
      mockSyncChangedNote.mockRejectedValueOnce(new Error("vault read failed"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});

      edit(vault, ALPHA, { "pm-project": true, id: "p1", title: "Alpha renamed" });

      await vi.waitFor(() => expect(err).toHaveBeenCalledWith(
        "pm-compass: couldn't sync the checklist", expect.any(Error)));
      err.mockRestore();
    });
  });
});
