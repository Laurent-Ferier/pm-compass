// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string, public extension: string, public basename: string) {}
  }
  class MockTFolder {
    constructor(public children: (MockTFile | MockTFolder)[] = []) {}
  }
  return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
  TFile: MockTFile,
  TFolder: MockTFolder,
  normalizePath: (p: string) => p,
  parseYaml: (): Record<string, unknown> => ({}),
}));

import { ProjectCache, type FolderReconcilers } from "./project-cache";
import { CacheEvent, ChangeOrigin } from "./cache-events";
import { asApp } from "../__testing__/as-app";
import { notesOf } from "../__testing__/notes";

const FOLDER = "Projects";

function file(path: string): InstanceType<typeof MockTFile> {
  const name = path.split("/").pop()!;
  return new MockTFile(path, "md", name.replace(/\.md$/, ""));
}

function project(id: string) {
  return { "pm-project": true, id, title: id.toUpperCase() };
}

function task(id: string, projectId = "p1") {
  return { "pm-task": true, id, projectId, title: id.toUpperCase() };
}

/** A vault holding one frontmatter blob per path, with its events held so a test can fire
 *  one. The map is live: writing to it between reads is how a test says a note changed. */
function makeVault(initial: Record<string, Record<string, unknown>> = {}) {
  const notes = new Map(Object.entries(initial));
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const on = (event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(event, handler);
    return { event };
  };
  const getFileCache = vi.fn((f: { path: string }) => {
    const fm = notes.get(f.path);
    return fm ? { frontmatter: fm } : null;
  });
  const app = asApp({
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (notes.has(path)) return file(path);
        if (path !== FOLDER) return null;
        return new MockTFolder([...notes.keys()].map(file));
      },
      cachedRead: () => Promise.resolve(""),
      on,
      offref: () => {},
    },
    metadataCache: { getFileCache, on, offref: () => {} },
  });
  const fire = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args);
  return { app, notes, getFileCache, fire };
}

/** The projects folder, watched as the plugin watches it, with the service above it
 *  standing in for a pair of spies. */
function folder(app: ReturnType<typeof makeVault>["app"], reconcilers?: FolderReconcilers) {
  const at = { folder: FOLDER };
  const vault = notesOf(app, FOLDER);
  const cache = new ProjectCache(vault, () => at.folder, reconcilers);
  return { at, vault, cache };
}

function spies(): FolderReconcilers & { changed: ReturnType<typeof vi.fn>; deleted: ReturnType<typeof vi.fn> } {
  return { changed: vi.fn(), deleted: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProjectCache", () => {
  describe("reading the folder", () => {
    it("fills both halves, the projects first", async () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1"), "Projects/t1.md": task("t1") });
      const { cache } = folder(app);

      await cache.load();

      expect(cache.projects.map((p) => p.id)).toEqual(["p1"]);
      expect(cache.tasks.map((t) => t.id)).toEqual(["t1"]);
    });

    it("hands back itself, so a caller reads the two halves off the load", async () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1") });
      const { cache } = folder(app);

      expect(await cache.load()).toBe(cache);
    });

    it("names the project one note holds, and none for a note holding no project", async () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1"), "Projects/t1.md": task("t1") });
      const { cache } = folder(app);

      expect((await cache.at("Projects/p1.md"))?.id).toBe("p1");
      expect(await cache.at("Projects/t1.md")).toBeNull();
    });

    it("makes a project over a note of its own, outside the folder's reading", async () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1") });
      const { cache } = folder(app);
      const held = cache.data()[0];

      const made = cache.make({ ...held.toFields(), title: "Its own" });

      expect(made).not.toBe(held);
      expect(cache.data()[0].title).toBe("P1");
    });

    it("forgets both halves, and what the last load left behind", async () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1"), "Projects/t1.md": task("t1") });
      const { cache } = folder(app);
      await cache.load();

      cache.clear();

      expect(cache.projects).toEqual([]);
      expect(cache.tasks).toEqual([]);
      expect(cache.holds("Projects/p1.md")).toBe(false);
      expect(cache.projectTasks.holds("Projects/t1.md")).toBe(false);
    });

    it("re-points both halves at another folder", async () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1") });
      const { at, cache } = folder(app);

      at.folder = "Elsewhere";

      expect(cache.owns("Projects/p1.md")).toBe(false);
      expect(cache.projectTasks.owns("Projects/t1.md")).toBe(false);
      expect(cache.owns("Elsewhere/p1.md")).toBe(true);
    });
  });

  describe("marking a note", () => {
    it("marks and drops in both halves at once", async () => {
      const { app, notes } = makeVault({ "Projects/p1.md": project("p1"), "Projects/t1.md": task("t1") });
      const { cache } = folder(app);
      await cache.load();

      expect(cache.touch("Projects/t1.md")).toBe(true);
      expect(cache.drop("Projects/t1.md")).toBe(true);
      notes.delete("Projects/t1.md");

      await cache.load();
      expect(cache.tasks).toEqual([]);
    });

    it("marks nothing for a path outside the folder", () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1") });
      const { cache } = folder(app);

      expect(cache.touch("Elsewhere/p1.md")).toBe(false);
      expect(cache.drop("Elsewhere/p1.md")).toBe(false);
    });
  });

  describe("what it tells the service above it", () => {
    it("hands over the notes that moved in the window, and which of them are new", async () => {
      const { app, notes, fire } = makeVault({ "Projects/p1.md": project("p1") });
      const reconcilers = spies();
      const { cache } = folder(app, reconcilers);
      await cache.load();
      cache.start();

      notes.set("Projects/t1.md", task("t1"));
      fire("changed", file("Projects/t1.md"));
      vi.runOnlyPendingTimers();

      expect(reconcilers.changed).toHaveBeenCalledWith(["Projects/t1.md"], new Set(["Projects/t1.md"]));
    });

    it("counts a note it already held as no arrival", async () => {
      const { app, notes, fire } = makeVault({ "Projects/t1.md": task("t1") });
      const reconcilers = spies();
      const { cache } = folder(app, reconcilers);
      await cache.load();
      cache.start();

      notes.set("Projects/t1.md", { ...task("t1"), title: "Renamed" });
      fire("changed", file("Projects/t1.md"));
      vi.runOnlyPendingTimers();

      expect(reconcilers.changed).toHaveBeenCalledWith(["Projects/t1.md"], new Set());
    });

    it("says a note the vault no longer holds is gone", async () => {
      const { app, notes, fire } = makeVault({ "Projects/t1.md": task("t1") });
      const reconcilers = spies();
      const { cache } = folder(app, reconcilers);
      await cache.load();
      cache.start();

      notes.delete("Projects/t1.md");
      fire("delete", file("Projects/t1.md"));

      expect(reconcilers.deleted).toHaveBeenCalledWith("Projects/t1.md");
    });

    it("says nothing to a service it was given none of", async () => {
      const { app, notes, fire } = makeVault({ "Projects/t1.md": task("t1") });
      const { cache } = folder(app);
      await cache.load();
      cache.start();

      notes.delete("Projects/t1.md");
      expect(() => {
        fire("delete", file("Projects/t1.md"));
        vi.runOnlyPendingTimers();
      }).not.toThrow();
    });
  });

  describe("what it tells the views", () => {
    it("tells them the paths that moved, under where the change came from", async () => {
      const { app, notes, fire } = makeVault({ "Projects/t1.md": task("t1") });
      const { cache } = folder(app);
      const heard = vi.fn();
      cache.on(CacheEvent.ProjectsChanged, heard);
      await cache.load();
      cache.start();

      notes.set("Projects/t1.md", { ...task("t1"), title: "Renamed" });
      fire("changed", file("Projects/t1.md"));
      vi.runOnlyPendingTimers();

      expect(heard).toHaveBeenCalledWith({ paths: ["Projects/t1.md"], origin: ChangeOrigin.Vault });
    });

    it("says nothing about a reparse that landed what the note already said", async () => {
      const { app, fire } = makeVault({ "Projects/t1.md": task("t1") });
      const { cache } = folder(app);
      const heard = vi.fn();
      cache.on(CacheEvent.ProjectsChanged, heard);
      await cache.load();
      cache.start();

      fire("changed", file("Projects/t1.md"));
      vi.runOnlyPendingTimers();

      expect(heard).not.toHaveBeenCalled();
    });

    it("reads a note a write of its own left owed off the file instead of the reparse", async () => {
      const { app, fire } = makeVault({ "Projects/t1.md": task("t1") });
      const { vault, cache } = folder(app);
      await cache.load();
      cache.start();
      const load = vi.spyOn(vault, "load").mockResolvedValue(cache);

      cache.invalidate("Projects/t1.md");
      fire("changed", file("Projects/t1.md"));
      vi.runOnlyPendingTimers();

      expect(load).toHaveBeenCalled();
    });

    it("takes no read when nothing is owed one", async () => {
      const { app, fire } = makeVault({ "Projects/t1.md": task("t1") });
      const { vault, cache } = folder(app);
      await cache.load();
      cache.start();
      const load = vi.spyOn(vault, "load");

      fire("changed", file("Projects/t1.md"));
      vi.runOnlyPendingTimers();

      expect(load).not.toHaveBeenCalled();
    });
  });
});

describe("whether a note has gone", () => {
  it("asks the vault, not its own last reading of the folder", async () => {
    const { app, notes } = makeVault({ "Projects/p1.md": project("p1") });
    const { cache } = folder(app);
    await cache.load();

    expect(cache.isGone("Projects/p1.md")).toBe(false);

    // Absent from the reading but plainly still there: a note written a moment ago.
    cache.clear();
    expect(cache.isGone("Projects/p1.md")).toBe(false);

    notes.delete("Projects/p1.md");
    expect(cache.isGone("Projects/p1.md")).toBe(true);
  });
});
