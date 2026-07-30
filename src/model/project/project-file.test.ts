import { vi, describe, it, expect } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string, public basename = path.split("/").pop()!.replace(/\.md$/, "")) {}
  }
  return { MockTFile };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  App: class {},
}));

import { ProjectFile } from "./project-file";
import { asApp } from "../__testing__/as-app";

// ---------------------------------------------------------------------------
// App mock
// ---------------------------------------------------------------------------

function makeApp(initialFiles: Record<string, Record<string, unknown>> = {}) {
  const frontmatters = new Map(Object.entries(initialFiles));


  const vault = {
    getAbstractFileByPath: vi.fn((path: string) =>
      frontmatters.has(path) ? new MockTFile(path) : null,
    ),
  };

  const metadataCache = {
    getFileCache: vi.fn((file: InstanceType<typeof MockTFile>) => {
      const fm = frontmatters.get(file.path);
      return fm !== undefined ? { frontmatter: fm } : null;
    }),
  };

  const fileManager = {
    processFrontMatter: vi.fn(
      async (file: InstanceType<typeof MockTFile>, cb: (fm: Record<string, unknown>) => void) => {
        const fm = { ...(frontmatters.get(file.path) ?? {}) };
        cb(fm);
        frontmatters.set(file.path, fm);
      },
    ),
  };

  return asApp({ vault, metadataCache, fileManager, _frontmatters: frontmatters });
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
// readMetadata
// ---------------------------------------------------------------------------

describe("ProjectFile.readMetadata", () => {
  it("returns null when the file does not exist", async () => {
    const app = makeApp();
    expect(await new ProjectFile(app, PROJECT_PATH).readMetadata()).toBeNull();
  });

  it("returns null when pm-project is not true", async () => {
    const app = makeApp({ [PROJECT_PATH]: { "pm-task": true, id: "x", title: "X" } });
    expect(await new ProjectFile(app, PROJECT_PATH).readMetadata()).toBeNull();
  });

  it("returns null when the id field is absent", async () => {
    const app = makeApp({ [PROJECT_PATH]: { "pm-project": true, title: "Alpha" } });
    expect(await new ProjectFile(app, PROJECT_PATH).readMetadata()).toBeNull();
  });

  it("returns id and title", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    const meta = await new ProjectFile(app, PROJECT_PATH).readMetadata();
    expect(meta?.id).toBe("projid00000001");
    expect(meta?.title).toBe("Alpha");
  });

  it("returns color and icon when present", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm({ color: "#ff0000", icon: "🚀" }) });
    const meta = await new ProjectFile(app, PROJECT_PATH).readMetadata();
    expect(meta?.color).toBe("#ff0000");
    expect(meta?.icon).toBe("🚀");
  });

  it("returns undefined color and icon when absent", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    const meta = await new ProjectFile(app, PROJECT_PATH).readMetadata();
    expect(meta?.color).toBeUndefined();
    expect(meta?.icon).toBeUndefined();
  });

  it("falls back to the file basename when title is absent", async () => {
    const app = makeApp({ [PROJECT_PATH]: { "pm-project": true, id: "projid00000001" } });
    const meta = await new ProjectFile(app, PROJECT_PATH).readMetadata();
    expect(meta?.title).toBe("Alpha");
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("ProjectFile.update", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      new ProjectFile(app, PROJECT_PATH).update({ title: "X", color: "", icon: "" }),
    ).rejects.toThrow("File not found");
  });

  it("updates the title in frontmatter", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await new ProjectFile(app, PROJECT_PATH).update({ title: "Beta", color: "", icon: "" });
    expect(app._frontmatters.get(PROJECT_PATH)?.title).toBe("Beta");
  });

  it("sets the color when provided", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await new ProjectFile(app, PROJECT_PATH).update({ title: "Alpha", color: "#abcdef", icon: "" });
    expect(app._frontmatters.get(PROJECT_PATH)?.color).toBe("#abcdef");
  });

  it("removes the color field when set to empty string", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm({ color: "#ff0000" }) });
    await new ProjectFile(app, PROJECT_PATH).update({ title: "Alpha", color: "", icon: "" });
    expect(app._frontmatters.get(PROJECT_PATH)).not.toHaveProperty("color");
  });

  it("sets the icon when provided", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await new ProjectFile(app, PROJECT_PATH).update({ title: "Alpha", color: "", icon: "🚀" });
    expect(app._frontmatters.get(PROJECT_PATH)?.icon).toBe("🚀");
  });

  it("removes the icon field when set to empty string", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm({ icon: "📁" }) });
    await new ProjectFile(app, PROJECT_PATH).update({ title: "Alpha", color: "", icon: "" });
    expect(app._frontmatters.get(PROJECT_PATH)).not.toHaveProperty("icon");
  });

  it("updates the updatedAt timestamp", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await new ProjectFile(app, PROJECT_PATH).update({ title: "Alpha", color: "", icon: "" });
    const updatedAt = app._frontmatters.get(PROJECT_PATH)?.updatedAt as string;
    expect(updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(updatedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("calls processFrontMatter exactly once", async () => {
    const app = makeApp({ [PROJECT_PATH]: baseProjectFm() });
    await new ProjectFile(app, PROJECT_PATH).update({ title: "Alpha", color: "", icon: "" });
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
  });
});
