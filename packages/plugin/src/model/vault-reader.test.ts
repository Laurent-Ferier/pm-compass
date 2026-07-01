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
}));

import { loadVaultData, readObsidianPmSettings } from "./vault-reader";

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

type FrontmatterMap = Map<string, Record<string, unknown>>;

function makeApp({
  folder = null as unknown,
  frontmatters = new Map() as FrontmatterMap,
  adapterRead = (_path: string): Promise<string> =>
    Promise.reject(new Error("ENOENT")),
  configDir = ".obsidian",
} = {}) {
  return {
    vault: {
      getAbstractFileByPath: () => folder,
      adapter: { read: adapterRead },
      configDir,
    },
    metadataCache: {
      getFileCache: (file: unknown) => {
        const fm = frontmatters.get((file as MockTFile).path);
        return fm !== undefined ? { frontmatter: fm } : null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// loadVaultData
// ---------------------------------------------------------------------------

describe("loadVaultData", () => {
  it("returns empty data when projectsFolder does not exist", async () => {
    const app = makeApp({ folder: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadVaultData(app as any, "Projects");
    expect(result).toEqual({ projects: [], tasks: [] });
  });

  it("returns empty data when path resolves to a file, not a folder", async () => {
    const app = makeApp({ folder: makeFile("Projects.md") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadVaultData(app as any, "Projects");
    expect(result).toEqual({ projects: [], tasks: [] });
  });

  it("returns empty data when no pm-marked files exist", async () => {
    const folder = makeFolder([makeFile("Projects/note.md")]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/note.md", { title: "Just a note" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadVaultData(app as any, "Projects");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadVaultData(app as any, "Projects");
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

  it("falls back to file.basename when project title is missing", async () => {
    const file = makeFile("Projects/my-project.md");
    const folder = makeFolder([file]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/my-project.md", { "pm-project": true, id: "p1" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { projects } = await loadVaultData(app as any, "Projects");
    expect(projects[0].title).toBe("my-project");
  });

  it("skips project files with no id", async () => {
    const file = makeFile("Projects/unnamed.md");
    const folder = makeFolder([file]);
    const frontmatters: FrontmatterMap = new Map([
      ["Projects/unnamed.md", { "pm-project": true, title: "Unnamed" }],
    ]);
    const app = makeApp({ folder, frontmatters });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { projects } = await loadVaultData(app as any, "Projects");
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
        },
      ],
    ]);
    const app = makeApp({ folder, frontmatters });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tasks } = await loadVaultData(app as any, "Projects");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "task-1",
      projectId: "proj-1",
      title: "Do thing",
      status: "in-progress",
      priority: "high",
      dependencies: ["task-0"],
      due: "2026-07-01",
      progress: 40,
      filePath: "Projects/alpha_tasks/do-thing.md",
    });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tasks } = await loadVaultData(app as any, "Projects");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tasks } = await loadVaultData(app as any, "Projects");
    expect(tasks[0].dependencies).toEqual([]);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tasks } = await loadVaultData(app as any, "Projects");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tasks } = await loadVaultData(app as any, "Projects");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { projects, tasks } = await loadVaultData(app as any, "Projects");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { projects, tasks } = await loadVaultData(app as any, "Projects");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tasks } = await loadVaultData(app as any, "Projects");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { projects } = await loadVaultData(app as any, "Projects");
    expect(projects).toHaveLength(1);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readObsidianPmSettings(app as any);
    expect(result).toEqual({ projectsFolder: "Work/Projects" });
  });

  it("returns null when data.json has no projectsFolder field", async () => {
    const app = makeApp({
      adapterRead: async () => JSON.stringify({ otherSetting: true }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readObsidianPmSettings(app as any);
    expect(result).toBeNull();
  });

  it("returns null when data.json does not exist (read throws)", async () => {
    const app = makeApp({
      adapterRead: async () => {
        throw new Error("ENOENT");
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readObsidianPmSettings(app as any);
    expect(result).toBeNull();
  });

  it("returns null when data.json contains invalid JSON", async () => {
    const app = makeApp({ adapterRead: async () => "not valid json{{" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readObsidianPmSettings(app as any);
    expect(result).toBeNull();
  });

  it("reads from the correct path using configDir", async () => {
    const readSpy = vi.fn().mockResolvedValue(
      JSON.stringify({ projectsFolder: "MyProjects" }),
    );
    const app = makeApp({ adapterRead: readSpy, configDir: ".myconfig" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readObsidianPmSettings(app as any);
    expect(readSpy).toHaveBeenCalledWith(
      ".myconfig/plugins/obsidian-pm/data.json",
    );
  });
});
