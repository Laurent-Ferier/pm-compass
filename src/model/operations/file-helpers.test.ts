import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import {
  resolveFile,
  splitFrontmatterBody,
  touch,
  basenameOf,
  ensureFolderRecursive,
  ensureNote,
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

describe("ensureNote", () => {
  function fakeApp(existing: Set<string>) {
    return {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => {
          if (!existing.has(path)) return null;
          return Object.assign(new TFile(), { path });
        }),
        createFolder: vi.fn(async (path: string) => existing.add(path)),
        create: vi.fn(async (path: string) => {
          existing.add(path);
          return Object.assign(new TFile(), { path });
        }),
      },
    } as unknown as App;
  }

  it("returns the existing note untouched", async () => {
    const app = fakeApp(new Set(["Daily Notes/Inbox.md"]));
    const file = await ensureNote(app, "Daily Notes/Inbox.md");
    expect(file?.path).toBe("Daily Notes/Inbox.md");
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("creates the note and its folders when it doesn't exist", async () => {
    const app = fakeApp(new Set());
    const file = await ensureNote(app, "Daily Notes/Inbox.md");
    expect(app.vault.createFolder).toHaveBeenCalledWith("Daily Notes");
    expect(app.vault.create).toHaveBeenCalledWith("Daily Notes/Inbox.md", "");
    expect(file?.path).toBe("Daily Notes/Inbox.md");
  });

  it("needs no folder for a note at the vault root", async () => {
    const app = fakeApp(new Set());
    await ensureNote(app, "Inbox.md");
    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(app.vault.create).toHaveBeenCalledWith("Inbox.md", "");
  });

  it("falls back to the note another writer created in the meantime", async () => {
    const existing = new Set<string>();
    const app = fakeApp(existing);
    vi.mocked(app.vault.create).mockImplementation(async (path: string) => {
      existing.add(path);
      throw new Error("File already exists.");
    });
    const file = await ensureNote(app, "Inbox.md");
    expect(file?.path).toBe("Inbox.md");
  });

  it("returns null when creating the note fails", async () => {
    const app = fakeApp(new Set());
    vi.mocked(app.vault.create).mockRejectedValue(new Error("read-only vault"));
    expect(await ensureNote(app, "Inbox.md")).toBeNull();
  });

  it("returns null when creating the folder fails", async () => {
    const app = fakeApp(new Set());
    vi.mocked(app.vault.createFolder).mockRejectedValue(new Error("read-only vault"));
    expect(await ensureNote(app, "Daily Notes/Inbox.md")).toBeNull();
    expect(app.vault.create).not.toHaveBeenCalled();
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
