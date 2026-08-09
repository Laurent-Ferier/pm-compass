import { describe, it, expect } from "vitest";
import { splitFrontmatterBody, touch } from "./frontmatter";

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
