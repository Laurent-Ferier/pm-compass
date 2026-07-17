import { vi, describe, it, expect } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  return { MockTFile };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  normalizePath: (p: string) => p,
  App: class {},
}));

import { makeApp } from "./__testing__/mock-app";
import { addChildLink, removeChildLink, SUBTASK_SECTION } from "./child-links";

const PATH = "Projects/Alpha_tasks/parent.md";

/** A parent task file with the given body (after the frontmatter). */
function parentFile(body: string, subtaskIds: string[] = []): string {
  const ids = subtaskIds.map((s) => `"${s}"`).join(", ");
  return `---\nid: "p1"\ntitle: "Parent"\nsubtaskIds: [${ids}]\n---\n${body}`;
}

const body = (app: ReturnType<typeof makeApp>) =>
  (app._files.get(PATH) as string).replace(/^---\n[\s\S]*?\n---\n/, "");

const add = (app: ReturnType<typeof makeApp>, id: string, title: string, basename: string) =>
  addChildLink(app, PATH, SUBTASK_SECTION, id, title, basename);
const remove = (app: ReturnType<typeof makeApp>, id: string, basename: string) =>
  removeChildLink(app, PATH, SUBTASK_SECTION, id, basename);

describe("addChildLink", () => {
  it("does nothing when the parent file is missing", async () => {
    const app = makeApp();
    await add(app, "kid", "Kid", "kid");
    expect(app._files.has(PATH)).toBe(false);
  });

  it("creates the section at the end when none exists", async () => {
    const app = makeApp({ [PATH]: parentFile("Parent: [[Alpha|Alpha]]\n") });
    await add(app, "kid", "Kid", "kid");
    expect(body(app)).toContain("## Subtasks\n- [ ] [[kid|Kid]]");
    expect(app._files.get(PATH)).toContain('subtaskIds: ["kid"]');
  });

  it("creates the section even when the body is empty", async () => {
    const app = makeApp({ [PATH]: parentFile("") });
    await add(app, "kid", "Kid", "kid");
    // No leading blank line to trim: the section starts the body.
    expect(body(app).trimStart()).toMatch(/^## Subtasks\n- \[ \] \[\[kid\|Kid\]\]/);
  });

  it("appends into an existing section at the end of the file", async () => {
    const app = makeApp({ [PATH]: parentFile("Prefix\n\n## Subtasks\n- [ ] [[one|One]]\n", ["one"]) });
    await add(app, "two", "Two", "two");
    const b = body(app);
    expect(b).toContain("[[one|One]]");
    expect(b).toContain("[[two|Two]]");
    expect(b.indexOf("[[two|Two]]")).toBeGreaterThan(b.indexOf("[[one|One]]"));
  });

  it("appends into a section that has content after it", async () => {
    const app = makeApp({
      [PATH]: parentFile("Prefix\n\n## Subtasks\n- [ ] [[one|One]]\n\n## Notes\nkeep me\n", ["one"]),
    });
    await add(app, "two", "Two", "two");
    const b = body(app);
    // The new entry lands in Subtasks, above the untouched Notes section.
    expect(b.indexOf("[[two|Two]]")).toBeLessThan(b.indexOf("## Notes"));
    expect(b).toContain("keep me");
  });

  it("refreshes a link already present under a stale title, without duplicating", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [ ] [[kid|Old Title]]\n", ["kid"]) });
    await add(app, "kid", "New Title", "kid");
    const b = body(app);
    expect(b).toContain("[[kid|New Title]]");
    expect(b).not.toContain("Old Title");
    expect(b.match(/\[\[kid\|/g)).toHaveLength(1);
  });
});

describe("removeChildLink", () => {
  it("does nothing when the parent file is missing", async () => {
    const app = makeApp();
    await remove(app, "kid", "kid");
    expect(app._files.has(PATH)).toBe(false);
  });

  it("removes an entry and drops it from subtaskIds", async () => {
    const app = makeApp({
      [PATH]: parentFile("## Subtasks\n- [ ] [[one|One]]\n- [ ] [[two|Two]]\n", ["one", "two"]),
    });
    await remove(app, "one", "one");
    const b = body(app);
    expect(b).not.toContain("[[one|One]]");
    expect(b).toContain("[[two|Two]]");
    expect(app._files.get(PATH)).toContain('subtaskIds: ["two"]');
  });

  it("removes the now-empty heading when the last entry goes", async () => {
    const app = makeApp({ [PATH]: parentFile("Prefix\n\n## Subtasks\n- [ ] [[one|One]]\n", ["one"]) });
    await remove(app, "one", "one");
    const b = body(app);
    expect(b).not.toContain("## Subtasks");
    expect(b).toContain("Prefix");
  });

  it("leaves the checklist untouched when the link isn't in the section", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [ ] [[one|One]]\n", ["one"]) });
    await remove(app, "gone", "gone");
    // The body isn't rewritten (the frontmatter id list is filtered regardless,
    // which is harmless when the id was already absent).
    expect(body(app)).toBe("## Subtasks\n- [ ] [[one|One]]\n");
  });

  it("does nothing when there is no section at all", async () => {
    const app = makeApp({ [PATH]: parentFile("Just a description, no section.\n") });
    await remove(app, "kid", "kid");
    expect(body(app)).toBe("Just a description, no section.\n");
  });
});
