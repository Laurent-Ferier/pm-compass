// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";

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

import type { App } from "obsidian";
import { ProjectCache } from "./project-cache";
import { ProjectTaskCache } from "./project-task-cache";
import { asApp } from "../__testing__/as-app";
import { notesOf } from "../__testing__/notes";
import { CacheEvent } from "./cache-events";

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

/** A vault holding one frontmatter blob per path. The map is live: writing to it between
 *  reads is how a test says a note changed under the cache. */
function makeVault(initial: Record<string, Record<string, unknown>> = {}) {
  const notes = new Map(Object.entries(initial));
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
    },
    metadataCache: { getFileCache },
  });
  return { app, notes, getFileCache };
}

/** The two halves as `VaultData` wires them. */
function caches(app: App) {
  const vault = notesOf(app, FOLDER);
  const projects = new ProjectCache(vault, () => FOLDER);
  return { vault, projects, tasks: new ProjectTaskCache(vault, () => FOLDER, projects) };
}

describe("ProjectTaskCache", () => {
  it("reads every task note the folder holds", async () => {
    const { app } = makeVault({ "Projects/t1.md": task("t1"), "Projects/t2.md": task("t2") });
    const { tasks } = caches(app);

    expect((await tasks.data()).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("leaves a note the projects half claimed unopened", async () => {
    const { app } = makeVault({ "Projects/p1.md": project("p1"), "Projects/t1.md": task("t1") });
    const s = caches(app);
    s.projects.data();

    expect((await s.tasks.data()).map((t) => t.id)).toEqual(["t1"]);
    expect(s.tasks.holds("Projects/p1.md")).toBe(false);
  });

  it("reads a note the projects half has not claimed yet as a task", async () => {
    const { app } = makeVault({ "Projects/p1.md": project("p1") });
    const { tasks } = caches(app);

    // Read on its own, the project note parses as no task all the same.
    expect(await tasks.data()).toEqual([]);
  });

  it("makes a task over a note of its own, outside the folder's reading", async () => {
    const { app } = makeVault({ "Projects/t1.md": task("t1") });
    const { tasks } = caches(app);
    const held = (await tasks.data())[0];

    const made = tasks.make({ ...held.toFields(), title: "Its own" });

    expect(made).not.toBe(held);
    expect(made.title).toBe("Its own");
    expect((await tasks.data())[0].title).toBe("T1");
  });

  it("files a task's own change on the half that does the telling", async () => {
    const { app } = makeVault({ "Projects/t1.md": task("t1") });
    const s = caches(app);
    const held = (await s.tasks.data())[0];
    const changed = vi.spyOn(s.projects, "changed");

    s.tasks.changed(held);

    expect(changed).toHaveBeenCalledWith(held);
  });

  it("asks the same half for a re-read a write left owed", () => {
    const { app } = makeVault({ "Projects/t1.md": task("t1") });
    const s = caches(app);
    const invalidate = vi.spyOn(s.projects, "invalidate");

    s.tasks.invalidate("Projects/t1.md");

    expect(invalidate).toHaveBeenCalledWith("Projects/t1.md");
  });

  it("gathers nothing of its own to tell, the other half telling for both", async () => {
    const { app } = makeVault({ "Projects/t1.md": task("t1") });
    const s = caches(app);
    const heard = vi.fn();
    s.tasks.on(CacheEvent.ProjectsChanged, heard);
    await s.tasks.data();

    s.tasks.touch("Projects/t1.md");
    await s.tasks.data();

    expect(heard).not.toHaveBeenCalled();
  });
});
