import { vi, describe, it, expect } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string, public basename = path.split("/").pop()!.replace(/\.md$/, "")) {}
  }
  class MockTFolder {
    constructor(public path: string) {}
  }
  return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
  // Unused here, but the vault helper reaches the date parsing that reads it.
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
  TFile: MockTFile,
  TFolder: MockTFolder,
  App: class {},
  normalizePath: (p: string) => p,
}));

import { asApp } from "../__testing__/as-app";
import { notesOf, setFields } from "../__testing__/notes";

// ---------------------------------------------------------------------------
// App mock
// ---------------------------------------------------------------------------

function makeApp(initialFiles: Record<string, Record<string, unknown>> = {}, folders: string[] = []) {
  const frontmatters = new Map(Object.entries(initialFiles));
  const folderPaths = new Set(folders);

  const vault = {
    getAbstractFileByPath: vi.fn((path: string) =>
      frontmatters.has(path) ? new MockTFile(path)
        : folderPaths.has(path) ? new MockTFolder(path)
          : null,
    ),
  };

  const metadataCache = {
    getFileCache: vi.fn((file: InstanceType<typeof MockTFile>) => {
      const fm = frontmatters.get(file.path);
      return fm !== undefined ? { frontmatter: fm } : null;
    }),
  };

  const trashed: string[] = [];
  const fileManager = {
    trashFile: vi.fn(async (f: { path: string }) => {
      trashed.push(f.path);
      frontmatters.delete(f.path);
      folderPaths.delete(f.path);
    }),
    processFrontMatter: vi.fn(
      async (file: InstanceType<typeof MockTFile>, cb: (fm: Record<string, unknown>) => void) => {
        const fm = { ...(frontmatters.get(file.path) ?? {}) };
        cb(fm);
        frontmatters.set(file.path, fm);
      },
    ),
  };

  return asApp({ vault, metadataCache, fileManager, _frontmatters: frontmatters, _trashed: trashed });
}

const PROJECT_PATH = "Projects/Alpha.md";

function baseProjectFm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "pm-project": true,
    id: "projid00000001",
    title: "Alpha",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("ProjectIO — setting its fields", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "X", color: "", icon: "", archived: false }),
    ).rejects.toThrow("File not found");
  });

  it("updates the title in frontmatter", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Beta", color: "", icon: "", archived: false });
    expect(app._frontmatters.get(PROJECT_PATH)?.title).toBe("Beta");
  });

  it("sets the color when provided", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "#abcdef", icon: "", archived: false });
    expect(app._frontmatters.get(PROJECT_PATH)?.color).toBe("#abcdef");
  });

  it("removes the color field when set to empty string", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm({ color: "#ff0000" }) });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "", icon: "", archived: false });
    expect(app._frontmatters.get(PROJECT_PATH)).not.toHaveProperty("color");
  });

  it("sets the icon when provided", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "", icon: "🚀", archived: false });
    expect(app._frontmatters.get(PROJECT_PATH)?.icon).toBe("🚀");
  });

  it("removes the icon field when set to empty string", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm({ icon: "📁" }) });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "", icon: "", archived: false });
    expect(app._frontmatters.get(PROJECT_PATH)).not.toHaveProperty("icon");
  });

  it("sets the archived flag when on", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "", icon: "", archived: true });
    expect(app._frontmatters.get(PROJECT_PATH)?.archived).toBe(true);
  });

  it("removes the archived field when off", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm({ archived: true }) });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "", icon: "", archived: false });
    expect(app._frontmatters.get(PROJECT_PATH)).not.toHaveProperty("archived");
  });

  it("updates the updatedAt timestamp", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "", icon: "", archived: false });
    const updatedAt = app._frontmatters.get(PROJECT_PATH)?.updatedAt as string;
    expect(updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(updatedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("calls processFrontMatter exactly once", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await setFields(notesOf(app).projects.cache.file(PROJECT_PATH), { title: "Alpha", color: "", icon: "", archived: false });
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("ProjectIO — deleting the project", () => {
  const TASKS_FOLDER = "Projects/Alpha_tasks";

  it("trashes the tasks folder before the note it belongs to", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() }, [TASKS_FOLDER]);
    await notesOf(app).projects.cache.file(PROJECT_PATH).delete();
    expect(app._trashed).toEqual([TASKS_FOLDER, PROJECT_PATH]);
  });

  it("trashes the note alone when the project never made a tasks folder", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await notesOf(app).projects.cache.file(PROJECT_PATH).delete();
    expect(app._trashed).toEqual([PROJECT_PATH]);
  });

  it("throws when the file does not exist, leaving the folder beside it alone", async () => {
    const app = makeApp({}, [TASKS_FOLDER]);
    await expect(notesOf(app).projects.cache.file(PROJECT_PATH).delete()).rejects.toThrow("File not found");
    expect(app._trashed).toEqual([]);
  });
});
