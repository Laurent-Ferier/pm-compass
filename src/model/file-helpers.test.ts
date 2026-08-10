import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import {
  resolveFile,
  basenameOf,
  ensureFolderRecursive,
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
