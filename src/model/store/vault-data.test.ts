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

import { VaultData } from "./vault-data";
import { StoreEvent } from "./store-events";
import { DEFAULT_SETTINGS, type PMCompassSettings } from "../settings";
import { asApp } from "../__testing__/as-app";
import { setField } from "../__testing__/notes";
import { Priority } from "../base-task";

const FOLDER = "Projects";
/** Past the coalescing window, and any view debounce on top of it. */
const SETTLED_MS = 200;

function file(path: string): InstanceType<typeof MockTFile> {
  const name = path.split("/").pop()!;
  return new MockTFile(path, "md", name.replace(/\.md$/, ""));
}

function task(id: string) {
  return { "pm-task": true, id, projectId: "p1", title: id.toUpperCase() };
}

function project(id: string) {
  return { "pm-project": true, id, title: id.toUpperCase() };
}

/**
 * A vault whose events a test fires by hand. `notes` is what the metadata cache says and
 * `files` is what the file says — the two are the same until a test moves one, which is
 * how it stands in for Obsidian reparsing a written file on its own schedule.
 */
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
    // The write itself belongs to `ProjectTaskNote`, tested there; here it only has to
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

function makeVaultData(vault: ReturnType<typeof makeVault>, overrides: Partial<PMCompassSettings> = {}) {
  const settings = { ...DEFAULT_SETTINGS, projectsFolder: FOLDER, ...overrides };
  const data = new VaultData(vault.app, () => settings);
  data.start();
  return { data, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VaultData", () => {
  it("answers a read from the vault it watches", async () => {
    const { data } = makeVaultData(makeVault({ "Projects/t1.md": task("t1") }));
    expect((await data.load()).tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("hands each task to the project naming it, the two halves being read apart", async () => {
    const { data } = makeVaultData(makeVault({
      "Projects/p1.md": project("p1"),
      "Projects/t1.md": task("t1"),
    }));

    const store = await data.load();

    expect(store.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(store.tasksOf("p1").map((t) => t.id)).toEqual(["t1"]);
  });

  it("files each task under the one it names as its parent", async () => {
    const { data } = makeVaultData(makeVault({
      "Projects/p1.md": project("p1"),
      "Projects/t1.md": task("t1"),
      "Projects/t2.md": { ...task("t2"), parentId: "t1" },
    }));

    await data.load();

    expect(data.taskNotes.childrenOf(undefined).map((t) => t.id)).toEqual(["t1"]);
    expect(data.taskNotes.childrenOf("t1").map((t) => t.id)).toEqual(["t2"]);
    expect(data.taskNotes.childrenOf("t2")).toEqual([]);
  });

  it("hands back the same reading until something changes, so a consumer can memoize on it", async () => {
    const { data } = makeVaultData(makeVault({
      "Projects/p1.md": project("p1"),
      "Projects/t1.md": task("t1"),
    }));

    const { projects, tasks } = await data.load();
    await data.load();

    expect(data.projectNotes.projects).toBe(projects);
    expect(data.projectNotes.tasks).toBe(tasks);
  });

  it("takes a new task onto the project naming it, the projects handed out standing", async () => {
    const vault = makeVault({
      "Projects/p1.md": project("p1"),
      "Projects/t1.md": task("t1"),
    });
    const { data } = makeVaultData(vault);
    const first = (await data.load()).projects;

    vault.notes.set("Projects/t2.md", task("t2"));
    vault.files.set("Projects/t2.md", task("t2"));
    data.invalidate(["Projects/t2.md"]);
    const second = (await data.load()).projects;

    expect(data.projectNotes.tasksOf("p1").map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(first[0]).toBe(second[0]);
  });

  it("tells the views once a project note has changed", () => {
    const vault = makeVault({ "Projects/t1.md": task("t1") });
    const { data } = makeVaultData(vault);
    const heard = vi.fn();
    data.projectNotes.on(StoreEvent.ProjectsChanged, heard);

    vault.emit("metadataCache", "changed", file("Projects/t1.md"), "");
    vi.advanceTimersByTime(SETTLED_MS);

    expect(heard).toHaveBeenCalledWith({ paths: ["Projects/t1.md"] });
  });

  it("gathers a burst of changes into one telling", () => {
    const vault = makeVault({ "Projects/t1.md": task("t1"), "Projects/t2.md": task("t2") });
    const { data } = makeVaultData(vault);
    const heard = vi.fn();
    data.projectNotes.on(StoreEvent.ProjectsChanged, heard);

    vault.emit("metadataCache", "changed", file("Projects/t1.md"), "");
    vault.emit("metadataCache", "changed", file("Projects/t2.md"), "");
    vi.advanceTimersByTime(SETTLED_MS);

    expect(heard).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenCalledWith({ paths: ["Projects/t1.md", "Projects/t2.md"] });
  });

  it("says nothing about a note outside the projects folder", () => {
    const vault = makeVault();
    const { data } = makeVaultData(vault);
    const heard = vi.fn();
    data.projectNotes.on(StoreEvent.ProjectsChanged, heard);

    vault.emit("metadataCache", "changed", file("Elsewhere/t1.md"), "");
    vi.advanceTimersByTime(SETTLED_MS);

    expect(heard).not.toHaveBeenCalled();
  });

  it("tells the views about a deleted note", () => {
    const vault = makeVault({ "Projects/t1.md": task("t1") });
    const { data } = makeVaultData(vault);
    const heard = vi.fn();
    data.projectNotes.on(StoreEvent.ProjectsChanged, heard);

    vault.emit("vault", "delete", file("Projects/t1.md"));
    vi.advanceTimersByTime(SETTLED_MS);

    expect(heard).toHaveBeenCalledWith({ paths: ["Projects/t1.md"] });
  });

  it("names both ends of a rename", () => {
    const vault = makeVault({ "Projects/t2.md": task("t1") });
    const { data } = makeVaultData(vault);
    const heard = vi.fn();
    data.projectNotes.on(StoreEvent.ProjectsChanged, heard);

    vault.emit("vault", "rename", file("Projects/t2.md"), "Projects/t1.md");
    vi.advanceTimersByTime(SETTLED_MS);

    expect(heard).toHaveBeenCalledWith({ paths: ["Projects/t1.md", "Projects/t2.md"] });
  });

  it("re-reads a note the moment it hears of it, whatever the coalescing is doing", async () => {
    // The rule the whole cache stands on: a read taken straight after a change parses what
    // it is owed rather than waiting for anyone to be told.
    const vault = makeVault({ "Projects/t1.md": task("t1") });
    const { data } = makeVaultData(vault);
    await data.load();

    vault.notes.set("Projects/t1.md", { ...task("t1"), title: "Renamed" });
    vault.emit("metadataCache", "changed", file("Projects/t1.md"), "");

    expect((await data.load()).tasks[0].title).toBe("Renamed");
  });

  it("reads a task note the plugin wrote off the file, the metadata cache still holding the old one", async () => {
    // Obsidian reparses a file it has just written on its own schedule, so the cache can
    // still be a version behind — and a read straight after a write must see the write.
    const vault = makeVault({ "Projects/t1.md": task("t1") });
    const { data } = makeVaultData(vault);
    await data.load();
    vault.files.set("Projects/t1.md", { ...task("t1"), title: "Renamed" });

    data.invalidate(["Projects/t1.md"]);

    expect((await data.load()).tasks[0].title).toBe("Renamed");
  });

  it("shows what a write of its own left behind, no vault event having fired", async () => {
    const vault = makeVault({ "Projects/t1.md": task("t1") });
    const { data } = makeVaultData(vault);
    await data.load();
    // What the write lands as: the note class writes the file, and the metadata cache is
    // the version behind it always is at that moment.
    vault.files.set("Projects/t1.md", { ...task("t1"), priority: "high" });

    await setField(data.taskNotes.note("Projects/t1.md"), "priority", Priority.High);

    expect((await data.load()).tasks[0].priority).toBe("high");
  });

  it("drops what it held once the projects folder setting moves", async () => {
    const vault = makeVault({ "Projects/t1.md": task("t1") });
    const { data, settings } = makeVaultData(vault);
    await data.load();

    settings.projectsFolder = "Elsewhere";
    await data.reconfigure();

    expect((await data.load()).tasks).toEqual([]);
  });

  it("says nothing more once disposed", () => {
    const vault = makeVault({ "Projects/t1.md": task("t1") });
    const { data } = makeVaultData(vault);
    const heard = vi.fn();
    data.projectNotes.on(StoreEvent.ProjectsChanged, heard);

    data.dispose();
    vault.emit("metadataCache", "changed", file("Projects/t1.md"), "");
    vi.advanceTimersByTime(SETTLED_MS);

    expect(heard).not.toHaveBeenCalled();
  });
});
