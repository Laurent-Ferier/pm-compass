// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";

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

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  TFolder: MockTFolder,
  normalizePath: (p: string) => p,
  parseYaml: (): Record<string, unknown> => ({}),
}));

import type { App } from "obsidian";
import { ProjectStore } from "./project-store";
import { ProjectTaskStore } from "./project-task-store";
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

/** The two stores as `VaultData` wires them: the task notes read against the projects. */
function stores(app: App, folder = FOLDER) {
  const notes = notesOf(app, folder);
  const projects = new ProjectStore(notes, folder);
  return { projects, tasks: new ProjectTaskStore(notes, folder, projects) };
}

/** The folder read in the order `VaultData` reads it: the projects first, so a note one of
 *  them claimed is one the tasks pass leaves unopened. */
async function read(s: ReturnType<typeof stores>) {
  const projects = s.projects.data();
  return { projects, tasks: await s.tasks.data() };
}

/** The structural half of a note's cache: one `## ` section holding a checklist of links,
 *  which is what Obsidian builds a listing out of. The lines only have to be consistent. */
function listingCache(heading: string, entries: { basename: string; checked: boolean }[]) {
  const at = (line: number, col: number) => ({ start: { line, col, offset: 0 }, end: { line, col, offset: 0 } });
  return {
    headings: [{ heading, level: 2, position: at(0, 0) }],
    listItems: entries.map((e, i) => ({ task: e.checked ? "x" : " ", parent: -1, position: at(i + 1, 0) })),
    links: entries.map((e, i) => ({ link: e.basename, displayText: e.basename, position: at(i + 1, "- [ ] ".length) })),
  };
}

/**
 * A vault holding one frontmatter blob per path, and — for a note that lists children —
 * what Obsidian read of its checklist. Both maps are live: writing to one between reads is
 * how a test says a note changed under the store.
 */
function makeVault(initial: Record<string, Record<string, unknown>> = {}) {
  const notes = new Map(Object.entries(initial));
  const listings = new Map<string, ReturnType<typeof listingCache>>();
  const getFileCache = vi.fn((f: { path: string }) => {
    const fm = notes.get(f.path);
    return fm ? { frontmatter: fm, ...listings.get(f.path) } : null;
  });
  const app = asApp({
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (notes.has(path)) return file(path);
        if (path !== FOLDER) return null;
        return new MockTFolder([...notes.keys()].map(file));
      },
      cachedRead: () => Promise.resolve(""),
    },
    metadataCache: { getFileCache },
  });
  return { app, notes, listings, getFileCache };
}

describe("FileStore", () => {
  it("reads every note in the folder on the first pass, each store keeping its own kind", async () => {
    const { app } = makeVault({
      "Projects/p1.md": project("p1"),
      "Projects/t1.md": task("t1"),
    });

    const { projects, tasks } = await read(stores(app));

    expect(projects.map((p) => p.id)).toEqual(["p1"]);
    expect(tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("reads a task whose project is nowhere in the folder as a task all the same", async () => {
    const { app } = makeVault({
      "Projects/p1.md": project("p1"),
      "Projects/t1.md": task("t1"),
      "Projects/t2.md": task("t2", "gone"),
    });

    const { tasks } = await read(stores(app));

    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("leaves a note the projects pass claimed unopened on the tasks pass", async () => {
    const { app, getFileCache } = makeVault({
      "Projects/p1.md": project("p1"),
      "Projects/t1.md": task("t1"),
    });

    await read(stores(app));

    expect(getFileCache.mock.calls.filter(([f]) => f.path === "Projects/p1.md")).toHaveLength(1);
  });

  it("reads nothing again while nothing has changed", async () => {
    const { app, getFileCache } = makeVault({ "Projects/t1.md": task("t1") });
    const store = stores(app).tasks;

    await store.data();
    const readsAfterFirstPass = getFileCache.mock.calls.length;
    await store.data();

    expect(getFileCache.mock.calls.length).toBe(readsAfterFirstPass);
  });

  it("hands back the same arrays until something changes, so a consumer can memoize on them", async () => {
    const { app } = makeVault({ "Projects/p1.md": project("p1"), "Projects/t1.md": task("t1") });
    const store = stores(app).tasks;

    const first = await store.data();
    const again = await store.data();

    expect(again).toBe(first);
  });

  it("re-reads only the note that changed", async () => {
    const { app, notes, getFileCache } = makeVault({
      "Projects/t1.md": task("t1"),
      "Projects/t2.md": task("t2"),
      "Projects/t3.md": task("t3"),
    });
    const store = stores(app).tasks;
    await store.data();

    getFileCache.mockClear();
    notes.set("Projects/t2.md", { ...task("t2"), title: "Renamed" });
    store.touch("Projects/t2.md");
    await store.data();

    expect(getFileCache.mock.calls.map(([f]) => f.path)).toEqual(["Projects/t2.md"]);
  });

  it("shows what the changed note now says", async () => {
    const { app, notes } = makeVault({ "Projects/t1.md": task("t1") });
    const store = stores(app).tasks;
    await store.data();

    notes.set("Projects/t1.md", { ...task("t1"), title: "Renamed" });
    store.touch("Projects/t1.md");

    expect((await store.data())[0].title).toBe("Renamed");
  });

  it("builds fresh arrays once a note has changed", async () => {
    const { app } = makeVault({ "Projects/t1.md": task("t1") });
    const store = stores(app).tasks;
    const first = await store.data();

    store.touch("Projects/t1.md");

    expect(await store.data()).not.toBe(first);
  });

  it("forgets a note that has gone", async () => {
    const { app, notes } = makeVault({
      "Projects/t1.md": task("t1"),
      "Projects/t2.md": task("t2"),
    });
    const store = stores(app).tasks;
    await store.data();

    notes.delete("Projects/t1.md");
    store.drop("Projects/t1.md");

    expect((await store.data()).map((t) => t.id)).toEqual(["t2"]);
  });

  it("forgets a note whose frontmatter no longer names a task", async () => {
    const { app, notes } = makeVault({ "Projects/t1.md": task("t1") });
    const store = stores(app).tasks;
    await store.data();

    notes.set("Projects/t1.md", { title: "Just a note now" });
    store.touch("Projects/t1.md");

    expect(await store.data()).toEqual([]);
  });

  it("takes in a note the folder has gained", async () => {
    const { app, notes } = makeVault({ "Projects/t1.md": task("t1") });
    const store = stores(app).tasks;
    await store.data();

    notes.set("Projects/t2.md", task("t2"));
    store.touch("Projects/t2.md");

    expect((await store.data()).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("hands a note edited from a project into a task over to the tasks pass", async () => {
    const { app, notes } = makeVault({ "Projects/n.md": project("p1") });
    const s = stores(app);
    await read(s);

    notes.set("Projects/n.md", task("t1", "p2"));
    s.projects.touch("Projects/n.md");
    s.tasks.touch("Projects/n.md");

    const reading = await read(s);
    expect(reading.projects).toEqual([]);
    expect(reading.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  describe("the project one note holds", () => {
    it("reads it as the folder now has it", async () => {
      const { app, notes } = makeVault({ "Projects/p1.md": project("p1") });
      const { projects } = stores(app);
      projects.data();

      notes.set("Projects/p1.md", { ...project("p1"), title: "Renamed" });
      projects.touch("Projects/p1.md");

      expect((await projects.at("Projects/p1.md"))?.title).toBe("Renamed");
    });

    it("names none for a note that is a task", async () => {
      const { app } = makeVault({ "Projects/t1.md": task("t1") });

      expect(await stores(app).projects.at("Projects/t1.md")).toBeNull();
    });

    it("names none for a path the folder has nothing at", async () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1") });

      expect(await stores(app).projects.at("Projects/gone.md")).toBeNull();
    });
  });

  describe("the live model over a note", () => {
    it("hands back the one project per note, reading after reading", () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1") });
      const { projects } = stores(app);

      const first = projects.data()[0];
      projects.touch("Projects/p1.md");

      expect(projects.data()[0]).toBe(first);
    });

    it("takes what the note now says onto the project already handed out", () => {
      const { app, notes } = makeVault({ "Projects/p1.md": project("p1") });
      const { projects } = stores(app);
      const held = projects.data()[0];

      notes.set("Projects/p1.md", { ...project("p1"), title: "Renamed" });
      projects.touch("Projects/p1.md");
      projects.data();

      expect(held.title).toBe("Renamed");
    });

    it("wakes nothing when a re-read lands what the note already said", () => {
      const { app } = makeVault({ "Projects/p1.md": project("p1") });
      const { projects } = stores(app);
      projects.data();
      const changed = vi.spyOn(projects, "changed");

      projects.touch("Projects/p1.md");
      projects.data();

      expect(changed).not.toHaveBeenCalled();
    });

    it("wakes nothing when a re-read lands the same listing", () => {
      const { app, listings } = makeVault({ "Projects/p1.md": project("p1") });
      listings.set("Projects/p1.md", listingCache("Tasks", [{ basename: "t1", checked: false }]));
      const { projects } = stores(app);
      projects.data();
      const changed = vi.spyOn(projects, "changed");

      projects.touch("Projects/p1.md");
      projects.data();

      expect(changed).not.toHaveBeenCalled();
    });

    it("takes a box ticked by hand as the note having moved, as it takes an edited field", () => {
      const { app, listings } = makeVault({ "Projects/p1.md": project("p1") });
      listings.set("Projects/p1.md", listingCache("Tasks", [{ basename: "t1", checked: false }]));
      const { projects } = stores(app);
      projects.data();
      const changed = vi.spyOn(projects, "changed");

      listings.set("Projects/p1.md", listingCache("Tasks", [{ basename: "t1", checked: true }]));
      projects.touch("Projects/p1.md");
      projects.data();

      expect(changed).toHaveBeenCalled();
    });

    it("takes a listing gaining an entry as the note having moved", () => {
      const { app, listings } = makeVault({ "Projects/p1.md": project("p1") });
      listings.set("Projects/p1.md", listingCache("Tasks", [{ basename: "t1", checked: false }]));
      const { projects } = stores(app);
      projects.data();
      const changed = vi.spyOn(projects, "changed");

      listings.set("Projects/p1.md", listingCache("Tasks", [
        { basename: "t1", checked: false }, { basename: "t2", checked: false },
      ]));
      projects.touch("Projects/p1.md");
      projects.data();

      expect(changed).toHaveBeenCalled();
    });

    it("tells a project its note has gone", () => {
      const { app, notes } = makeVault({ "Projects/p1.md": project("p1") });
      const { projects } = stores(app);
      const held = projects.data()[0];

      notes.delete("Projects/p1.md");
      projects.drop("Projects/p1.md");

      expect(held.isGone).toBe(true);
    });
  });

  describe("which paths it owns", () => {
    it("takes a note under the projects folder", () => {
      expect(stores(makeVault().app).tasks.touch("Projects/t1.md")).toBe(true);
    });

    it("leaves a note somewhere else alone", () => {
      expect(stores(makeVault().app).tasks.touch("Elsewhere/t1.md")).toBe(false);
    });

    it("leaves the folder's own attachments alone", () => {
      expect(stores(makeVault().app).tasks.touch("Projects/shot.png")).toBe(false);
    });

    it("leaves a folder whose name merely starts the same alone", () => {
      expect(stores(makeVault().app).tasks.touch("Projects-old/t1.md")).toBe(false);
    });

    it("leaves a sync tool's conflicted copy alone, its id being the original's", () => {
      const store = stores(makeVault().app).tasks;
      expect(store.touch("Projects/t1.sync-conflict-20260101-123456-ABCDEFG.md")).toBe(false);
    });
  });

  it("reads a duplicated id from the first note by path, whichever changed last", async () => {
    const { app } = makeVault({
      "Projects/b-copy.md": { ...task("t1"), title: "The copy" },
      "Projects/a-original.md": { ...task("t1"), title: "The original" },
    });

    const { tasks } = await read(stores(app));

    expect(tasks.map((t) => t.title)).toEqual(["The original"]);
  });

  it("walks the new folder from scratch once it is re-pointed", async () => {
    const { app } = makeVault({ "Projects/t1.md": task("t1") });
    const { projects, tasks } = stores(app);
    await tasks.data();

    projects.retarget("Elsewhere");
    tasks.retarget("Elsewhere");

    expect(await tasks.data()).toEqual([]);
  });

  it("reads an empty folder as empty rather than failing", async () => {
    const store = stores(makeVault().app, "Missing").tasks;
    expect(await store.data()).toEqual([]);
  });
});
