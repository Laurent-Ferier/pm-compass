import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import {
  resolveFile,
  splitFrontmatterBody,
  touch,
  basenameOf,
  ensureFolderRecursive,
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

describe("splitFrontmatterBody", () => {
  it("splits frontmatter from body when present", () => {
    const raw = "---\nfoo: bar\n---\nbody text";
    expect(splitFrontmatterBody(raw)).toEqual({
      frontmatterBlock: "---\nfoo: bar\n---\n",
      body: "body text",
    });
  });

  it("returns empty frontmatterBlock and body when no frontmatter is present", () => {
    const raw = "just body text, no frontmatter";
    expect(splitFrontmatterBody(raw)).toEqual({ frontmatterBlock: "", body: "" });
  });

  it("tolerates a leading BOM or blank line before the opening delimiter", () => {
    const raw = "﻿\n---\nfoo: bar\n---\nbody text";
    const { frontmatterBlock, body } = splitFrontmatterBody(raw);
    // The leading whitespace is kept in the block so `block + body` round-trips.
    expect(frontmatterBlock + body).toBe(raw);
    expect(body).toBe("body text");
  });
});

describe("touch", () => {
  it("stamps updatedAt with an ISO timestamp", () => {
    const fm: Record<string, unknown> = {};
    touch(fm);
    expect(typeof fm["updatedAt"]).toBe("string");
    expect(new Date(fm["updatedAt"] as string).toISOString()).toBe(fm["updatedAt"]);
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
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => (path === "Journal" ? {} : null)),
        createFolder: vi.fn(async () => {}),
      },
    } as unknown as App;

    await ensureFolderRecursive(app, "Journal/Daily");

    expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
    expect(app.vault.createFolder).toHaveBeenCalledWith("Journal/Daily");
  });
});
