import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoist mock classes so vi.mock factory can reference them
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
  // Enough of a YAML reader for the frontmatter these tests write out by hand. Like
  // Obsidian's own, it throws on a line it can't make sense of.
  parseYaml: (text: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const m = /^(\w[\w-]*): (.*)$/.exec(line);
      if (!m) throw new Error(`bad YAML: ${line}`);
      const raw = m[2].trim();
      out[m[1]] = raw === "true" ? true : raw === "false" ? false : raw.replace(/^"|"$/g, "");
    }
    return out;
  },
}));

import { loadVaultData, readObsidianPmSettings } from "./vault-reader";
import { day } from "../__testing__/dates";
import { asApp } from "../__testing__/as-app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, ext = "md"): InstanceType<typeof MockTFile> {
  const basename = path.split("/").pop()!.replace(`.${ext}`, "");
  return new MockTFile(path, ext, basename);
}

function makeFolder(
  children: (InstanceType<typeof MockTFile> | InstanceType<typeof MockTFolder>)[] = [],
): InstanceType<typeof MockTFolder> {
  return new MockTFolder(children);
}

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

type FrontmatterMap = Map<string, Record<string, unknown>>;

interface MockAppOptions {
  /** Whatever `getAbstractFileByPath` should hand back: a folder, a file, or nothing. */
  folder?: unknown;
  frontmatters?: FrontmatterMap;
  /** A file's raw text, for the cache-miss fallback. Keyed by path. */
  fileText?: Map<string, string>;
  adapterRead?: (path: string) => Promise<string>;
  configDir?: string;
}

function makeApp({
  folder = null,
  frontmatters = new Map() as FrontmatterMap,
  fileText = new Map<string, string>(),
  adapterRead = (_path: string): Promise<string> =>
    Promise.reject(new Error("ENOENT")),
  configDir = CONFIG_DIR,
}: MockAppOptions = {}) {
  return asApp({
    vault: {
      getAbstractFileByPath: () => folder,
      adapter: { read: adapterRead },
      // What the reader falls back to when the cache has no frontmatter for a file.
      cachedRead: (file: unknown) =>
        Promise.resolve(fileText.get((file as InstanceType<typeof MockTFile>).path) ?? ""),
      configDir,
    },
    metadataCache: {
      getFileCache: (file: unknown) => {
        const fm = frontmatters.get((file as InstanceType<typeof MockTFile>).path);
        return fm !== undefined ? { frontmatter: fm } : null;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// loadVaultData
// ---------------------------------------------------------------------------

describe("loadVaultData", () => {
  it("returns empty data when projectsFolder does not exist", async () => {
    const app = makeApp({ folder: null });
    const result = await loadVaultData(app, "Projects");
    expect(result).toEqual({ projects: [], tasks: [] });
  });

  it("returns empty data when path resolves to a file, not a folder", async () => {
    const app = makeApp({ folder: makeFile("Projects.md") });
    const result = await loadVaultData(app, "Projects");
    expect(result).toEqual({ projects: [], tasks: [] });
  });

  it("returns empty data when no pm-marked files exist", async () => {
    const folder = makeFolder([makeFile("Projects/note.md")]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/note.md", { title: "Just a note" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const result = await loadVaultData(app, "Projects");
    expect(result).toEqual({ projects: [], tasks: [] });
  });

  it("parses a project file", async () => {
    const file = makeFile("Projects/alpha.md");
    const folder = makeFolder([file]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/alpha.md",
        {
          "pm-project": true,
          id: "proj-1",
          title: "Alpha",
          color: "#ff0000",
          icon: "🚀",
        },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const result = await loadVaultData(app, "Projects");
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      id: "proj-1",
      title: "Alpha",
      color: "#ff0000",
      icon: "🚀",
      filePath: "Projects/alpha.md",
      tasks: [],
    });
  });

  it.each([
    ["true", true, true],
    ["absent", undefined, undefined],
    ["a string", "yes", undefined],
  ])("reads archived from %s", async (_label, written, expected) => {
    const file = makeFile("Projects/alpha.md");
    const folder = makeFolder([file]);
    const fm: Record<string, unknown> = { "pm-project": true, id: "proj-1", title: "Alpha" };
    if (written !== undefined) fm.archived = written;
    const app = makeApp({ folder, frontmatters: new Map([["Projects/alpha.md", fm]]) });
    const { projects } = await loadVaultData(app, "Projects");
    expect(projects[0].archived).toBe(expected);
  });

  it("parses project createdAt/updatedAt when present", async () => {
    const file = makeFile("Projects/alpha.md");
    const folder = makeFolder([file]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/alpha.md",
        {
          "pm-project": true,
          id: "proj-1",
          title: "Alpha",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { projects } = await loadVaultData(app, "Projects");
    expect(projects[0].createdAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(projects[0].updatedAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
  });

  it("falls back to file.basename when project title is missing", async () => {
    const file = makeFile("Projects/my-project.md");
    const folder = makeFolder([file]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/my-project.md", { "pm-project": true, id: "p1" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { projects } = await loadVaultData(app, "Projects");
    expect(projects[0].title).toBe("my-project");
  });

  it("skips project files with no id", async () => {
    const file = makeFile("Projects/unnamed.md");
    const folder = makeFolder([file]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/unnamed.md", { "pm-project": true, title: "Unnamed" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { projects } = await loadVaultData(app, "Projects");
    expect(projects).toHaveLength(0);
  });

  it("parses a task file with all relevant fields", async () => {
    const projectFile = makeFile("Projects/alpha.md");
    const taskFile = makeFile("Projects/alpha_tasks/do-thing.md");
    const folder = makeFolder([projectFile, makeFolder([taskFile])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/alpha.md",
        { "pm-project": true, id: "proj-1", title: "Alpha" },
      ],
      [
        "Projects/alpha_tasks/do-thing.md",
        {
          "pm-task": true,
          id: "task-1",
          projectId: "proj-1",
          title: "Do thing",
          status: "in-progress",
          priority: "high",
          dependencies: ["task-0"],
          due: "2026-07-01",
          progress: 40,
          cardLayout: { x: 320, y: -48, w: 240, h: 96 },
        },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "task-1",
      projectId: "proj-1",
      title: "Do thing",
      status: "in-progress",
      priority: "high",
      dependencies: ["task-0"],
      due: day("2026-07-01"),
      progress: 40,
      card: { x: 320, y: -48, w: 240, h: 96 },
      filePath: "Projects/alpha_tasks/do-thing.md",
    });
  });

  it("reads no card layout from a task that has never been arranged", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/p_tasks/t.md", { "pm-task": true, id: "t1", projectId: "p1" }],
    ]);
    const { tasks } = await loadVaultData(makeApp({ folder, frontmatters }), "Projects");
    expect(tasks[0].card).toBeUndefined();
  });

  it("drops a priority value that isn't on the scale", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/p_tasks/t.md", { "pm-task": true, id: "t1", projectId: "p1", priority: "urgent" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks[0].priority).toBeUndefined();
  });

  it("defaults dependencies to [] when field is absent", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/p_tasks/t.md",
        { "pm-task": true, id: "t1", projectId: "p1", title: "T" },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks[0].dependencies).toEqual([]);
  });

  it("defaults dependencies to [] when field is not an array", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/p_tasks/t.md",
        {
          "pm-task": true,
          id: "t1",
          projectId: "p1",
          title: "T",
          dependencies: "task-other",
        },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks[0].dependencies).toEqual([]);
  });

  it("reads assignees when present as an array", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/p_tasks/t.md",
        { "pm-task": true, id: "t1", projectId: "p1", title: "T", assignees: ["alice", "bob"] },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks[0].assignees).toEqual(["alice", "bob"]);
  });

  it("reads an unquoted date field YAML already turned into a Date", async () => {
    // obsidian-pm quotes these, but a hand-edited note may not — and then YAML hands
    // over a Date at UTC midnight, whose UTC calendar day is the day that was written.
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/p_tasks/t.md", {
        "pm-task": true, id: "t1", projectId: "p1", title: "T",
        due: new Date("2026-07-15T00:00:00.000Z"),
        completed: new Date("2026-07-10T09:30:00.000Z"),
      }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks[0].due).toEqual(day("2026-07-15"));
    // A timestamp keeps the instant it names, rather than being flattened to a day.
    expect(tasks[0].completed).toEqual(new Date("2026-07-10T09:30:00.000Z"));
  });

  it("reads parentId, type, due, completed, tags, createdAt, and updatedAt when present", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/p_tasks/t.md",
        {
          "pm-task": true,
          id: "t1",
          projectId: "p1",
          title: "T",
          parentId: "parent-1",
          type: "milestone",
          start: "2026-07-01",
          due: "2026-07-15",
          completed: "2026-07-10",
          tags: ["urgent", "backend"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks[0]).toMatchObject({
      parentId: "parent-1",
      type: "milestone",
      start: day("2026-07-01"),
      due: day("2026-07-15"),
      completed: new Date("2026-07-10"),
      tags: ["urgent", "backend"],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
  });

  it("falls back to file.basename when task title is missing", async () => {
    const file = makeFile("Projects/p_tasks/my-task.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/p_tasks/my-task.md", { "pm-task": true, id: "t1", projectId: "p1" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks[0].title).toBe("my-task");
  });

  it("skips files with no frontmatter", async () => {
    const file = makeFile("Projects/p_tasks/no-fm.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map();
    const app = makeApp({ folder, frontmatters });
    const result = await loadVaultData(app, "Projects");
    expect(result).toEqual({ projects: [], tasks: [] });
  });

  describe("when the metadata cache hasn't caught up with a file", () => {
    // Obsidian reparses a file it has just written asynchronously. A read landing in that
    // gap used to lose the task outright, which moved everything the layout hangs off it.
    const RAW = [
      "---",
      "pm-task: true",
      "id: t1",
      "projectId: p1",
      'title: "Clear the table"',
      "status: todo",
      "---",
      "",
      "body",
    ].join("\n");

    it("reads the file itself rather than losing the task", async () => {
      const file = makeFile("Projects/p_tasks/t.md");
      const folder = makeFolder([makeFolder([file])]);
      const app = makeApp({
        folder,
        frontmatters: new Map(),
        fileText: new Map([["Projects/p_tasks/t.md", RAW]]),
      });

      const result = await loadVaultData(app, "Projects");

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe("t1");
      expect(result.tasks[0].title).toBe("Clear the table");
    });

    it("still skips a note that genuinely carries no frontmatter", async () => {
      const file = makeFile("Projects/p_tasks/notes.md");
      const folder = makeFolder([makeFolder([file])]);
      const app = makeApp({
        folder,
        frontmatters: new Map(),
        fileText: new Map([["Projects/p_tasks/notes.md", "Just a note.\n"]]),
      });

      expect(await loadVaultData(app, "Projects")).toEqual({ projects: [], tasks: [] });
    });

    it("skips a note whose frontmatter can't be parsed rather than throwing", async () => {
      const file = makeFile("Projects/p_tasks/broken.md");
      const folder = makeFolder([makeFolder([file])]);
      const app = makeApp({
        folder,
        frontmatters: new Map(),
        fileText: new Map([["Projects/p_tasks/broken.md", "---\n: : :\n---\n"]]),
      });

      await expect(loadVaultData(app, "Projects")).resolves.toEqual({ projects: [], tasks: [] });
    });
  });

  it("skips task files with no id", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/p_tasks/t.md",
        { "pm-task": true, projectId: "p1", title: "No ID" },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(0);
  });

  it("skips task files with no projectId", async () => {
    const file = makeFile("Projects/p_tasks/t.md");
    const folder = makeFolder([makeFolder([file])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/p_tasks/t.md",
        { "pm-task": true, id: "t1", title: "No Project" },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(0);
  });

  it("links tasks to their project via projectId", async () => {
    const projectFile = makeFile("Projects/alpha.md");
    const taskFile = makeFile("Projects/alpha_tasks/t1.md");
    const folder = makeFolder([projectFile, makeFolder([taskFile])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/alpha.md",
        { "pm-project": true, id: "proj-1", title: "Alpha" },
      ],
      [
        "Projects/alpha_tasks/t1.md",
        { "pm-task": true, id: "task-1", projectId: "proj-1", title: "T1" },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { projects, tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(1);
    expect(projects[0].tasks).toHaveLength(1);
    expect(projects[0].tasks[0].id).toBe("task-1");
  });

  it("does not link tasks with an unknown projectId to any project", async () => {
    const taskFile = makeFile("Projects/unknown_tasks/t.md");
    const folder = makeFolder([makeFolder([taskFile])]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/unknown_tasks/t.md",
        {
          "pm-task": true,
          id: "t1",
          projectId: "no-such-project",
          title: "T",
        },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { projects, tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(1);
    expect(projects).toHaveLength(0);
  });

  it("recurses into nested subfolders", async () => {
    const nested = makeFile("Projects/sub/deeper/task.md");
    const folder = makeFolder([
      makeFolder([makeFolder([nested])]),
    ]);
    const frontmatters: FrontmatterMap = new Map([
      [
        "Projects/sub/deeper/task.md",
        { "pm-task": true, id: "t1", projectId: "p1", title: "Deep Task" },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t1");
  });

  it("ignores non-markdown files", async () => {
    const mdFile = makeFile("Projects/p.md");
    const imgFile = makeFile("Projects/img.png", "png");
    const folder = makeFolder([mdFile, imgFile]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/p.md", { "pm-project": true, id: "p1", title: "P" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { projects } = await loadVaultData(app, "Projects");
    expect(projects).toHaveLength(1);
  });

  it("ignores the conflict copies a syncing tool leaves beside a task", async () => {
    const original = makeFile("Projects/task.md");
    const syncthing = makeFile("Projects/task.sync-conflict-20260730-140246-E3KD4S5.md");
    const dropbox = makeFile("Projects/task (conflicted copy 2026-07-30).md");
    const folder = makeFolder([syncthing, original, dropbox]);
    const fm = { "pm-task": true, id: "t1", projectId: "p1", title: "Only once" };
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/task.md", fm],
      ["Projects/task.sync-conflict-20260730-140246-E3KD4S5.md", fm],
      ["Projects/task (conflicted copy 2026-07-30).md", fm],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(1);
    // The original wins, not whichever copy the folder listed first.
    expect(tasks[0].filePath).toBe("Projects/task.md");
  });

  it("keeps only the first task of two files claiming one id", async () => {
    const folder = makeFolder([makeFile("Projects/a.md"), makeFile("Projects/copy of a.md")]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/a.md", { "pm-task": true, id: "t1", projectId: "p1", title: "A" }],
      ["Projects/copy of a.md", { "pm-task": true, id: "t1", projectId: "p1", title: "A" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { tasks } = await loadVaultData(app, "Projects");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].filePath).toBe("Projects/a.md");
  });

  it("keeps only the first project of two files claiming one id", async () => {
    const folder = makeFolder([makeFile("Projects/p.md"), makeFile("Projects/p backup.md")]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/p.md", { "pm-project": true, id: "p1", title: "P" }],
      ["Projects/p backup.md", { "pm-project": true, id: "p1", title: "P" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    const { projects } = await loadVaultData(app, "Projects");
    expect(projects).toHaveLength(1);
    expect(projects[0].filePath).toBe("Projects/p.md");
  });
});

// ---------------------------------------------------------------------------
// readObsidianPmSettings
// ---------------------------------------------------------------------------

describe("readObsidianPmSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns projectsFolder when data.json contains it", async () => {
    const app = makeApp({
      adapterRead: async () =>
        JSON.stringify({ projectsFolder: "Work/Projects" }),
    });
    const result = await readObsidianPmSettings(app);
    expect(result).toEqual({ projectsFolder: "Work/Projects" });
  });

  it("returns null when data.json has no projectsFolder field", async () => {
    const app = makeApp({
      adapterRead: async () => JSON.stringify({ otherSetting: true }),
    });
    const result = await readObsidianPmSettings(app);
    expect(result).toBeNull();
  });

  it("returns null when data.json does not exist (read throws)", async () => {
    const app = makeApp({
      adapterRead: async () => {
        throw new Error("ENOENT");
      },
    });
    const result = await readObsidianPmSettings(app);
    expect(result).toBeNull();
  });

  it("returns null when data.json contains invalid JSON", async () => {
    const app = makeApp({ adapterRead: async () => "not valid json{{" });
    const result = await readObsidianPmSettings(app);
    expect(result).toBeNull();
  });

  it("reads from the correct path using configDir", async () => {
    const readSpy = vi.fn().mockResolvedValue(
      JSON.stringify({ projectsFolder: "MyProjects" }),
    );
    const app = makeApp({ adapterRead: readSpy, configDir: ".myconfig" });
    await readObsidianPmSettings(app);
    expect(readSpy).toHaveBeenCalledWith(
      ".myconfig/plugins/obsidian-pm/data.json",
    );
  });
});
