import { vi, describe, it, expect, type Mock } from "vitest";

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

import type { CachedMetadata } from "obsidian";
import { makeApp } from "../__testing__/mock-app";
import type { ChildEntry } from "./child-links";
import {
  addChildLink, listingFromCache, readChildLinkBoxes, removeChildEntry, removeChildLink,
  setChildLinkBoxes, syncChildLinks, updateChildLink, SUBTASK_SECTION,
} from "./child-links";

const PATH = "Projects/Alpha_tasks/parent.md";

/** One line's span, as Obsidian's cache positions everything. */
const at = (line: number, col: number) =>
  ({ start: { line, col, offset: 0 }, end: { line, col, offset: 0 } });

/** A parent task file with the given body (after the frontmatter). */
function parentFile(body: string, subtaskIds: string[] = []): string {
  const ids = subtaskIds.map((s) => `"${s}"`).join(", ");
  return `---\nid: "p1"\ntitle: "Parent"\nsubtaskIds: [${ids}]\n---\n${body}`;
}

const body = (app: ReturnType<typeof makeApp>) =>
  (app._files.get(PATH) as string).replace(/^---\n[\s\S]*?\n---\n/, "");

const add = (app: ReturnType<typeof makeApp>, id: string, title: string, basename: string, checked = false) =>
  addChildLink(app, PATH, SUBTASK_SECTION, id, title, basename, checked);
const update = (
  app: ReturnType<typeof makeApp>, basename: string, changes: { title?: string; checked?: boolean },
) => updateChildLink(app, PATH, SUBTASK_SECTION, basename, changes);
const setChecked = (app: ReturnType<typeof makeApp>, basename: string, checked: boolean) =>
  update(app, basename, { checked });
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

  it("appends rather than flattening an indented line that names the child", async () => {
    const app = makeApp({
      [PATH]: parentFile("## Subtasks\n- [ ] [[one|One]]\n  - [ ] [[two|Two]]\n", ["one"]),
    });
    await add(app, "two", "Two", "two");
    const b = body(app);
    // The user's nested line keeps its indentation; the real entry goes at the end.
    expect(b).toContain("  - [ ] [[two|Two]]");
    expect(b).toMatch(/\n- \[ \] \[\[two\|Two\]\]\n$/);
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

  it("ticks the box for a child that is already done", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n", []) });
    await add(app, "kid", "Kid", "kid", true);
    expect(body(app)).toContain("- [x] [[kid|Kid]]");
  });

  it("refreshes a ticked line rather than duplicating it", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [x] [[kid|Old Title]]\n", ["kid"]) });
    await add(app, "kid", "New Title", "kid", true);
    const b = body(app);
    expect(b).toContain("- [x] [[kid|New Title]]");
    expect(b.match(/\[\[kid\|/g)).toHaveLength(1);
  });
});

describe("updateChildLink", () => {
  const ticked = (checked: boolean) => `## Subtasks\n- [${checked ? "x" : " "}] [[one|One]]\n- [ ] [[two|Two]]\n`;

  it("relabels a child under its new title, keeping its box", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(true), ["one", "two"]) });
    await update(app, "one", { title: "Renamed" });
    const b = body(app);
    expect(b).toContain("- [x] [[one|Renamed]]");
    expect(b).toContain("- [ ] [[two|Two]]");
  });

  it("relabels and reticks in one write", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(false), ["one", "two"]) });
    await update(app, "one", { title: "Renamed", checked: true });
    expect(body(app)).toContain("- [x] [[one|Renamed]]");
  });

  it("leaves a hand-edited bare link bare when only the box changes", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [ ] [[one]]\n", ["one"]) });
    await setChecked(app, "one", true);
    expect(body(app)).toContain("- [x] [[one]]");
  });

  it("gives a bare link the title it is renamed to", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [ ] [[one]]\n", ["one"]) });
    await update(app, "one", { title: "One" });
    expect(body(app)).toContain("- [ ] [[one|One]]");
  });

  it("rewrites nothing when the title already says so", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(false), ["one", "two"]) });
    await update(app, "one", { title: "One" });
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("ticks a child's box, leaving its siblings alone", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(false), ["one", "two"]) });
    await setChecked(app, "one", true);
    const b = body(app);
    expect(b).toContain("- [x] [[one|One]]");
    expect(b).toContain("- [ ] [[two|Two]]");
  });

  it("unticks a child's box when it reopens", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(true), ["one", "two"]) });
    await setChecked(app, "one", false);
    expect(body(app)).toContain("- [ ] [[one|One]]");
  });

  it("leaves the parent's frontmatter untouched — the box is the child's fact, not its own", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(false), ["one", "two"]) });
    await setChecked(app, "one", true);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it("rewrites nothing when the box already says so", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(true), ["one", "two"]) });
    await setChecked(app, "one", true);
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("adds no line for a child that isn't listed", async () => {
    const app = makeApp({ [PATH]: parentFile(ticked(false), ["one", "two"]) });
    await setChecked(app, "gone", true);
    expect(body(app)).toBe(ticked(false));
  });

  it("does nothing when there is no section at all", async () => {
    const app = makeApp({ [PATH]: parentFile("Just a description.\n") });
    await setChecked(app, "one", true);
    expect(body(app)).toBe("Just a description.\n");
  });

  it("leaves an indented line alone — the user's own breakdown, not an entry", async () => {
    const nested = "## Subtasks\n- [ ] [[one|One]]\n  - [ ] [[two|Two]]\n";
    const app = makeApp({ [PATH]: parentFile(nested, ["one"]) });
    await setChecked(app, "two", true);
    expect(body(app)).toBe(nested);
  });
});

describe("setChildLinkBoxes", () => {
  const three = "## Subtasks\n- [ ] [[one|One]]\n- [x] [[two|Two]]\n- [ ] [[three|Three]]\n";
  const set = (app: ReturnType<typeof makeApp>, boxes: Record<string, boolean>) =>
    setChildLinkBoxes(app, PATH, SUBTASK_SECTION, new Map(Object.entries(boxes)));

  it("sets several boxes in a single write", async () => {
    const app = makeApp({ [PATH]: parentFile(three, ["one", "two", "three"]) });
    await set(app, { one: true, two: false });
    const b = body(app);
    expect(b).toContain("- [x] [[one|One]]");
    expect(b).toContain("- [ ] [[two|Two]]");
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
  });

  it("leaves the children it wasn't given alone", async () => {
    const app = makeApp({ [PATH]: parentFile(three, ["one", "two", "three"]) });
    await set(app, { one: true });
    expect(body(app)).toContain("- [ ] [[three|Three]]");
  });

  it("keeps each entry's title", async () => {
    const app = makeApp({ [PATH]: parentFile(three, ["one", "two", "three"]) });
    await set(app, { one: true });
    expect(body(app)).toContain("[[one|One]]");
  });

  it("rewrites nothing when every box already says so", async () => {
    const app = makeApp({ [PATH]: parentFile(three, ["one", "two", "three"]) });
    await set(app, { one: false, two: true });
    expect(app.vault.modify).not.toHaveBeenCalled();
  });
});

describe("syncChildLinks", () => {
  const FOLDER = "Projects/Alpha_tasks";
  const taskNote = (title: string) => `---\npm-task: true\nid: "x"\ntitle: "${title}"\n---\n`;

  const child = (basename: string, title: string, checked = false): ChildEntry =>
    ({ id: basename, title, basename, checked });
  const sync = (app: ReturnType<typeof makeApp>, children: ChildEntry[]) =>
    syncChildLinks(app, PATH, SUBTASK_SECTION, children, FOLDER);

  const listing = (entries: string) => parentFile(`## Subtasks\n${entries}`, ["one"]);

  it("relabels a stale title and corrects a wrong box in one pass", async () => {
    const app = makeApp({ [PATH]: listing("- [ ] [[one|Old name]]\n") });
    await sync(app, [child("one", "New name", true)]);
    expect(body(app)).toContain("- [x] [[one|New name]]");
  });

  it("appends a child that has no entry", async () => {
    const app = makeApp({ [PATH]: listing("- [ ] [[one|One]]\n") });
    await sync(app, [child("one", "One"), child("two", "Two", true)]);
    const b = body(app);
    expect(b).toContain("- [ ] [[one|One]]");
    expect(b).toContain("- [x] [[two|Two]]");
  });

  it("starts the section when the note has none", async () => {
    const app = makeApp({ [PATH]: parentFile("Just a description.\n") });
    await sync(app, [child("one", "One")]);
    const b = body(app);
    expect(b).toContain("## Subtasks");
    expect(b).toContain("- [ ] [[one|One]]");
    expect(b).toContain("Just a description.");
  });

  it("appends several missing children in a single write", async () => {
    const app = makeApp({ [PATH]: listing("- [ ] [[one|One]]\n") });
    await sync(app, [child("one", "One"), child("two", "Two"), child("three", "Three")]);
    expect(app.vault.process).toHaveBeenCalledTimes(1);
  });

  it("drops an entry for a task note it no longer claims", async () => {
    const app = makeApp({
      [PATH]: listing("- [ ] [[one|One]]\n- [ ] [[gone|Gone]]\n"),
      [`${FOLDER}/gone.md`]: taskNote("Gone"),
    });
    await sync(app, [child("one", "One")]);
    const b = body(app);
    expect(b).not.toContain("[[gone");
    expect(b).toContain("- [ ] [[one|One]]");
    // The line goes with the entry, rather than leaving a gap behind.
    expect(b).not.toMatch(/\n\n\n/);
  });

  it("keeps an entry whose target resolves nowhere — a link the user wrote", async () => {
    const app = makeApp({ [PATH]: listing("- [ ] [[one|One]]\n- [ ] [[2026 Q3 review]]\n") });
    await sync(app, [child("one", "One")]);
    expect(body(app)).toContain("- [ ] [[2026 Q3 review]]");
  });

  it("keeps an entry linking a note that isn't a task", async () => {
    const app = makeApp({
      [PATH]: listing("- [ ] [[one|One]]\n- [ ] [[notes|Notes]]\n"),
      [`${FOLDER}/notes.md`]: `---\nid: "n1"\n---\nJust a note.\n`,
    });
    await sync(app, [child("one", "One")]);
    expect(body(app)).toContain("- [ ] [[notes|Notes]]");
  });

  it("leaves an indented line alone — the user's own breakdown, not an entry", async () => {
    const app = makeApp({ [PATH]: listing("- [ ] [[one|One]]\n  - [ ] [[two|Two]]\n") });
    await sync(app, [child("one", "One")]);
    expect(body(app)).toContain("  - [ ] [[two|Two]]");
  });

  it("keeps the surviving ids in the order they were already in", async () => {
    const app = makeApp({
      [PATH]: parentFile("## Subtasks\n- [ ] [[b|B]]\n- [ ] [[a|A]]\n", ["b", "a"]),
    });
    await sync(app, [child("a", "A"), child("b", "B"), child("c", "C")]);
    expect(app._files.get(PATH)).toContain('subtaskIds: ["b", "a", "c"]');
  });

  it("writes nothing at all when the listing already agrees", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [x] [[one|One]]\n", ["one"]) });
    expect(await sync(app, [child("one", "One", true)])).toBeNull();
    expect(app.vault.process).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it("hands back the listing it left, for the note that holds a reading of it", async () => {
    const app = makeApp({ [PATH]: listing("- [ ] [[one|One]]\n") });
    expect(await sync(app, [child("one", "One", true)])).toEqual([{ basename: "one", checked: true }]);
  });

  it("does nothing when the parent file is missing", async () => {
    expect(await sync(makeApp(), [child("one", "One")])).toBeNull();
  });

  it("empties a listing whose tasks have all gone", async () => {
    const app = makeApp({
      [PATH]: listing("- [ ] [[one|One]]\n"),
      [`${FOLDER}/one.md`]: taskNote("One"),
    });
    await sync(app, []);
    expect(body(app)).not.toContain("[[one");
  });
});

describe("readChildLinkBoxes", () => {
  const read = (body: string) => readChildLinkBoxes(body, SUBTASK_SECTION);

  it("reads each entry's basename and box", () => {
    expect(read("## Subtasks\n- [x] [[one|One]]\n- [ ] [[two|Two]]\n")).toEqual([
      { basename: "one", checked: true },
      { basename: "two", checked: false },
    ]);
  });

  it("skips an indented checklist nested under an entry — the user's own breakdown", () => {
    expect(read("## Subtasks\n- [ ] [[one|One]]\n  - [x] [[two|Two]]\n")).toEqual([
      { basename: "one", checked: false },
    ]);
  });

  it("reads nothing from a body with no such section", () => {
    expect(read("Just a description.\n- [x] [[one|One]]\n")).toEqual([]);
  });
});

describe("listingFromCache — the same listing, off Obsidian's reading rather than the text", () => {
  /** Both readings of one note: what the cache says, and what the text says. They are two
   *  ways of answering the same question, so every case asserts they agree. */
  function bothWays(body: string) {
    const app = makeApp({ [PATH]: parentFile(body) });
    const file = app.vault.getFileByPath(PATH)!;
    return {
      fromCache: listingFromCache(app.metadataCache.getFileCache(file), SUBTASK_SECTION),
      fromText: readChildLinkBoxes(body, SUBTASK_SECTION),
    };
  }

  it("reads each entry's basename and box", () => {
    const { fromCache, fromText } = bothWays("## Subtasks\n- [x] [[one|One]]\n- [ ] [[two|Two]]\n");
    expect(fromCache).toEqual([
      { basename: "one", checked: true },
      { basename: "two", checked: false },
    ]);
    expect(fromCache).toEqual(fromText);
  });

  it("reads a bare link, which is what a hand-typed entry looks like", () => {
    const { fromCache, fromText } = bothWays("## Subtasks\n- [ ] [[one]]\n");
    expect(fromCache).toEqual([{ basename: "one", checked: false }]);
    expect(fromCache).toEqual(fromText);
  });

  it("skips an indented checklist nested under an entry — the user's own breakdown", () => {
    const { fromCache, fromText } = bothWays("## Subtasks\n- [ ] [[one|One]]\n  - [x] [[two|Two]]\n");
    expect(fromCache).toEqual([{ basename: "one", checked: false }]);
    expect(fromCache).toEqual(fromText);
  });

  it("stops at the next section, so a link below it lists nobody", () => {
    const { fromCache, fromText } = bothWays("## Subtasks\n- [ ] [[one|One]]\n\n## Notes\n- [x] [[two|Two]]\n");
    expect(fromCache).toEqual([{ basename: "one", checked: false }]);
    expect(fromCache).toEqual(fromText);
  });

  it("reads through a deeper heading, which does not end the section", () => {
    const { fromCache, fromText } = bothWays("## Subtasks\n- [ ] [[one|One]]\n\n### Later\n- [x] [[two|Two]]\n");
    expect(fromCache).toEqual([
      { basename: "one", checked: false },
      { basename: "two", checked: true },
    ]);
    expect(fromCache).toEqual(fromText);
  });

  it("skips a line whose link doesn't follow the box, which is prose that happens to link", () => {
    const { fromCache, fromText } = bothWays("## Subtasks\n- [ ] see [[one|One]]\n");
    expect(fromCache).toEqual([]);
    expect(fromCache).toEqual(fromText);
  });

  it("skips a box Obsidian accepts but this plugin doesn't write", () => {
    const { fromCache, fromText } = bothWays("## Subtasks\n- [-] [[one|One]]\n");
    expect(fromCache).toEqual([]);
    expect(fromCache).toEqual(fromText);
  });

  it("reads nothing from a note with no such section", () => {
    const { fromCache, fromText } = bothWays("Just a description.\n- [x] [[one|One]]\n");
    expect(fromCache).toEqual([]);
    expect(fromCache).toEqual(fromText);
  });

  it("reads nothing from a section Obsidian read no checklist under", () => {
    const cache = { headings: [{ heading: "Subtasks", level: 2, position: at(0, 0) }] };
    expect(listingFromCache(cache as CachedMetadata, SUBTASK_SECTION)).toEqual([]);
  });

  it("reads nothing from a note Obsidian has yet to index", () => {
    expect(listingFromCache(null, SUBTASK_SECTION)).toEqual([]);
  });
});

describe("removeChildLink", () => {
  it("does nothing when the parent file is missing", async () => {
    const app = makeApp();
    await remove(app, "kid", "kid");
    expect(app._files.has(PATH)).toBe(false);
  });

  it("removes a ticked entry too", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [x] [[one|One]]\n- [ ] [[two|Two]]\n", ["one", "two"]) });
    await remove(app, "one", "one");
    const b = body(app);
    expect(b).not.toContain("[[one|One]]");
    expect(b).toContain("[[two|Two]]");
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

  it("leaves an indented line naming the child alone — that is the user's own breakdown", async () => {
    const app = makeApp({
      [PATH]: parentFile("## Subtasks\n- [ ] [[one|One]]\n  - [ ] [[two|Two]]\n", ["one"]),
    });
    await remove(app, "two", "two");
    expect(body(app)).toBe("## Subtasks\n- [ ] [[one|One]]\n  - [ ] [[two|Two]]\n");
  });
});

describe("notes with no frontmatter, and notes that aren't there", () => {
  const FOLDER = "Projects/Alpha_tasks";
  const NO_FRONTMATTER = "## Subtasks\n- [ ] [[one|One]]\n";
  const entry = (title: string): ChildEntry => ({ id: "one", title, basename: "one", checked: false });

  it("won't relabel an entry in a note with no frontmatter", async () => {
    // The section is there, but the note isn't one of ours — a plain markdown file that
    // happens to carry a checklist under the same heading.
    const app = makeApp({ [PATH]: NO_FRONTMATTER });
    await update(app, "one", { title: "Renamed" });
    expect(app._files.get(PATH)).toBe(NO_FRONTMATTER);
  });

  it("won't sync a listing in a note with no frontmatter", async () => {
    const app = makeApp({ [PATH]: NO_FRONTMATTER });
    const changed = await syncChildLinks(app, PATH, SUBTASK_SECTION, [entry("Renamed")], FOLDER);
    expect(changed).toBeNull();
    expect(app._files.get(PATH)).toBe(NO_FRONTMATTER);
  });

  it("leaves the body alone when the frontmatter goes between the two writes", async () => {
    const app = makeApp({ [PATH]: parentFile("## Subtasks\n- [ ] [[one|Old name]]\n", ["one"]) });
    // The id write lands first and the body write reads the file back; another writer
    // can have stripped the frontmatter in between, and then the body isn't ours to move.
    const process = app.vault.process as unknown as
      Mock<(f: { path: string }, fn: (d: string) => string) => Promise<string>>;
    process.mockImplementation(async (file, fn) => {
      const next = fn(NO_FRONTMATTER);
      app._files.set(file.path, next);
      return next;
    });

    await syncChildLinks(app, PATH, SUBTASK_SECTION, [entry("New name")], FOLDER);
    expect(app._files.get(PATH)).toBe(NO_FRONTMATTER);
  });

  it("drops no entry from a note that isn't there", async () => {
    const app = makeApp();
    expect(await removeChildEntry(app, PATH, SUBTASK_SECTION, "one")).toBeNull();
  });

  it("drops no entry from a note with no frontmatter", async () => {
    const app = makeApp({ [PATH]: NO_FRONTMATTER });
    expect(await removeChildEntry(app, PATH, SUBTASK_SECTION, "one")).toBeNull();
    expect(app._files.get(PATH)).toBe(NO_FRONTMATTER);
  });
});
