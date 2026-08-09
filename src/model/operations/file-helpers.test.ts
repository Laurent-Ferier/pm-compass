import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import {
  resolveFile,
  basenameOf,
  ensureFolderRecursive,
  ensureNote,
  generateId,
} from "./file-helpers";

describe("resolveFile", () => {
  it("returns the TFile when the path resolves to one", () => {
    const file = new TFile();
    const app = { vault: { getAbstractFileByPath: vi.fn(() => file) } } as unknown as App;
    expect(resolveFile(app, "foo.md")).toBe(file);
  });

  it("returns null when the path doesn't resolve to a TFile", () => {
    const app = { vault: { getAbstractFileByPath: vi.fn(() => null) } } as unknown as App;
    expect(resolveFile(app, "missing.md")).toBeNull();
  });
});

describe("basenameOf", () => {
  it("strips directory and .md extension", () => {
    expect(basenameOf("foo/bar/baz.md")).toBe("baz");
  });

  it("handles a path with no directory", () => {
    expect(basenameOf("baz.md")).toBe("baz");
  });
});

describe("ensureNote", () => {
  /** The vault, plus the two writers by themselves: an assertion names the mock rather
   *  than reaching back through `app.vault` for it. */
  function fakeApp(existing: Set<string>) {
    const createFolder = vi.fn(async (path: string) => existing.add(path));
    const create = vi.fn(async (path: string) => {
      existing.add(path);
      return Object.assign(new TFile(), { path });
    });
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => {
          if (!existing.has(path)) return null;
          return Object.assign(new TFile(), { path });
        }),
        createFolder,
        create,
      },
    } as unknown as App;
    return { app, create, createFolder };
  }

  it("returns the existing note untouched", async () => {
    const { app, create } = fakeApp(new Set(["Daily Notes/Inbox.md"]));
    const file = await ensureNote(app, "Daily Notes/Inbox.md");
    expect(file?.path).toBe("Daily Notes/Inbox.md");
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the note and its folders when it doesn't exist", async () => {
    const { app, create, createFolder } = fakeApp(new Set());
    const file = await ensureNote(app, "Daily Notes/Inbox.md");
    expect(createFolder).toHaveBeenCalledWith("Daily Notes");
    expect(create).toHaveBeenCalledWith("Daily Notes/Inbox.md", "");
    expect(file?.path).toBe("Daily Notes/Inbox.md");
  });

  it("needs no folder for a note at the vault root", async () => {
    const { app, create, createFolder } = fakeApp(new Set());
    await ensureNote(app, "Inbox.md");
    expect(createFolder).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith("Inbox.md", "");
  });

  it("falls back to the note another writer created in the meantime", async () => {
    const existing = new Set<string>();
    const { app, create } = fakeApp(existing);
    create.mockImplementation(async (path: string) => {
      existing.add(path);
      throw new Error("File already exists.");
    });
    const file = await ensureNote(app, "Inbox.md");
    expect(file?.path).toBe("Inbox.md");
  });

  it("returns null when creating the note fails", async () => {
    const { app, create } = fakeApp(new Set());
    create.mockRejectedValue(new Error("read-only vault"));
    expect(await ensureNote(app, "Inbox.md")).toBeNull();
  });

  it("returns null when creating the folder fails", async () => {
    const { app, create, createFolder } = fakeApp(new Set());
    createFolder.mockRejectedValue(new Error("read-only vault"));
    expect(await ensureNote(app, "Daily Notes/Inbox.md")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("ensureFolderRecursive", () => {
  it("creates each missing ancestor segment individually", async () => {
    const existing = new Set<string>();
    const createFolder = vi.fn(async (path: string) => existing.add(path));
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => (existing.has(path) ? {} : null)),
        createFolder,
      },
    } as unknown as App;

    await ensureFolderRecursive(app, "Journal/Daily");

    expect(createFolder).toHaveBeenNthCalledWith(1, "Journal");
    expect(createFolder).toHaveBeenNthCalledWith(2, "Journal/Daily");
    expect(createFolder).toHaveBeenCalledTimes(2);
  });

  it("skips segments that already exist", async () => {
    const createFolder = vi.fn(async () => {});
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => (path === "Journal" ? {} : null)),
        createFolder,
      },
    } as unknown as App;

    await ensureFolderRecursive(app, "Journal/Daily");

    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(createFolder).toHaveBeenCalledWith("Journal/Daily");
  });
});

describe("generateId", () => {
  it("returns a 16-character string", () => {
    expect(generateId()).toHaveLength(16);
  });

  it("contains only lowercase alphanumeric characters", () => {
    expect(generateId()).toMatch(/^[a-z0-9]{16}$/);
  });

  it("returns unique values on repeated calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });
});
