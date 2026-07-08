import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import { resolveFile, splitFrontmatterBody, touch, basenameOf } from "./file-helpers";

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
