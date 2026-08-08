import { vi, describe, it, expect } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  return { MockTFile };
});

vi.mock("obsidian", () => ({
  // Unused here, but the vault helper reaches the date parsing that reads it.
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
  TFile: MockTFile,
  normalizePath: (p: string) => p,
  App: class {},
}));

import { makeApp } from "../__testing__/mock-app";
import { notesOf } from "../__testing__/notes";

const PROJECT = "Projects/Alpha.md";
const PARENT = "Projects/Alpha_tasks/parent.md";
const CHILD = "Projects/Alpha_tasks/do-thing.md";

/** A project note listing one task, its box in the given state. */
function projectNote(checked: boolean): string {
  return `---\npm-project: true\nid: "p1"\ntitle: "Alpha"\ntaskIds: ["t1"]\n---\n`
    + `## Tasks\n- [${checked ? "x" : " "}] [[do-thing|Do thing]]\n`;
}

function parentNote(checked: boolean): string {
  return `---\npm-task: true\nid: "par1"\ntitle: "Parent"\nsubtaskIds: ["t1"]\n---\n`
    + `Project: [[Alpha|Alpha]]\n\n## Subtasks\n- [${checked ? "x" : " "}] [[do-thing|Do thing]]\n`;
}

function childFile(status: string): string {
  return `---\npm-task: true\nid: "t1"\nprojectId: "p1"\ntitle: "Do thing"\nstatus: ${status}\n---\n`
    + `Project: [[Alpha|Alpha]]\n`;
}

const statusOf = (app: ReturnType<typeof makeApp>) =>
  /status: "?([\w-]+)/.exec(app._files.get(CHILD) as string)?.[1];
const boxOf = (app: ReturnType<typeof makeApp>, path = PROJECT) =>
  /- \[([ x])\] \[\[do-thing/.exec(app._files.get(path) as string)?.[1] === "x";

const applyBoxes = (app: ReturnType<typeof makeApp>, path = PROJECT) =>
  path === PROJECT
    ? notesOf(app).projects.notes.file(path).applyChildBoxes()
    : notesOf(app).projects.taskNotes.file(path).applyChildBoxes();

const repairBoxes = (app: ReturnType<typeof makeApp>, path = PROJECT) =>
  path === PROJECT
    ? notesOf(app).projects.notes.file(path).repairChildBoxes()
    : notesOf(app).projects.taskNotes.file(path).repairChildBoxes();

/** One note's cached frontmatter replaced, the rest of its cache — the listing the boxes are
 *  read from among it — left as the vault built it. */
function staleFrontmatter(
  app: ReturnType<typeof makeApp>, path: string, frontmatter: Record<string, unknown>,
) {
  const real = app.metadataCache.getFileCache.getMockImplementation()!;
  vi.spyOn(app.metadataCache, "getFileCache").mockImplementation((file) => {
    const cache = real(file);
    return cache && file.path === path ? { ...cache, frontmatter } : cache;
  });
}

describe("BaseIO.applyChildBoxes — the box speaks for the user", () => {
  it("closes a task whose box was ticked", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("todo") });
    await applyBoxes(app);
    expect(statusOf(app)).toBe("done");
    expect(app._files.get(CHILD)).toContain("completed:");
  });

  it("reopens a done task whose box was unticked", async () => {
    const app = makeApp({ [PROJECT]: projectNote(false), [CHILD]: childFile("done") });
    await applyBoxes(app);
    expect(statusOf(app)).toBe("todo");
    expect(app._files.get(CHILD)).not.toContain("completed:");
  });

  it("follows a parent task's own subtask boxes", async () => {
    const app = makeApp({ [PARENT]: parentNote(true), [CHILD]: childFile("in-progress") });
    await applyBoxes(app, PARENT);
    expect(statusOf(app)).toBe("done");
  });

  it("leaves the box as the user flipped it, rather than writing it back", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("todo") });
    await applyBoxes(app);
    expect(boxOf(app)).toBe(true);
  });

  it("trusts the file over a stale cache, so a cancelled task isn't reopened", async () => {
    const app = makeApp({ [PROJECT]: projectNote(false), [CHILD]: childFile("cancelled") });
    // The cache still holds the `done` the task was before it was cancelled — what
    // Obsidian hands us when the project's change event outruns the child's reparse.
    staleFrontmatter(app, CHILD, { "pm-task": true, status: "done" });

    await applyBoxes(app);
    expect(statusOf(app)).toBe("cancelled");
  });

  it("writes nothing when the box already agrees with the status", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("done") });
    await applyBoxes(app);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it("writes nothing when a stale cache disagrees but the file does not", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("done") });
    staleFrontmatter(app, CHILD, { "pm-task": true, status: "todo" });

    await applyBoxes(app);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it("leaves a linked note that isn't a task file as it stands", async () => {
    const app = makeApp({
      [PROJECT]: projectNote(true),
      [CHILD]: `---\nid: "t1"\nstatus: todo\n---\nNot a task.\n`,
    });
    await applyBoxes(app);
    expect(statusOf(app)).toBe("todo");
    expect(boxOf(app)).toBe(true);
  });

  it("skips a box whose task file is gone", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true) });
    await expect(applyBoxes(app)).resolves.toBeUndefined();
    expect(boxOf(app)).toBe(true);
  });
});

describe("BaseIO.repairChildBoxes — the status speaks for an unchecked listing", () => {
  it("ticks the box of a done task", async () => {
    const app = makeApp({ [PROJECT]: projectNote(false), [CHILD]: childFile("done") });
    await repairBoxes(app);
    expect(boxOf(app)).toBe(true);
    expect(statusOf(app)).toBe("done");
  });

  it("unticks the box of a task that is not done", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("in-progress") });
    await repairBoxes(app);
    expect(boxOf(app)).toBe(false);
    expect(statusOf(app)).toBe("in-progress");
  });

  it("unticks a cancelled task's box — closed, but never finished", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("cancelled") });
    await repairBoxes(app);
    expect(boxOf(app)).toBe(false);
    expect(statusOf(app)).toBe("cancelled");
  });

  it("never touches a task's own status — that is the other direction's job", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("todo") });
    await repairBoxes(app);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: CHILD }), expect.anything(),
    );
    expect(statusOf(app)).toBe("todo");
  });

  it("writes nothing when every box already agrees", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("done") });
    await repairBoxes(app);
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("leaves a linked note that isn't a task file as it stands", async () => {
    const app = makeApp({
      [PROJECT]: projectNote(true),
      [CHILD]: `---\nid: "t1"\nstatus: todo\n---\nNot a task.\n`,
    });
    await repairBoxes(app);
    expect(boxOf(app)).toBe(true);
  });

  it("follows a parent task's own subtask boxes", async () => {
    const app = makeApp({ [PARENT]: parentNote(false), [CHILD]: childFile("done") });
    await repairBoxes(app, PARENT);
    expect(boxOf(app, PARENT)).toBe(true);
  });

  it("settles: what it writes, the other direction reads back unchanged", async () => {
    const app = makeApp({ [PROJECT]: projectNote(true), [CHILD]: childFile("todo") });
    await repairBoxes(app);
    vi.mocked(app.fileManager.processFrontMatter).mockClear();

    // The write above raises a change event, which — the listing now being checked —
    // comes back through the other direction. It must find nothing left to do.
    await applyBoxes(app);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(statusOf(app)).toBe("todo");
    expect(boxOf(app)).toBe(false);
  });
});

describe("BaseIO.addChild", () => {
  const emptyProject = `---\npm-project: true\nid: "p1"\ntitle: "Alpha"\ntaskIds: []\n---\n## Tasks\n`;

  it("takes the box from the child's own file, not from the caller", async () => {
    const app = makeApp({ [PROJECT]: emptyProject, [CHILD]: childFile("done") });
    await notesOf(app).projects.notes.file(PROJECT).addChild("t1", "Do thing", "do-thing");
    expect(boxOf(app)).toBe(true);
  });

  it("leaves the box clear for a child that isn't done", async () => {
    const app = makeApp({ [PROJECT]: emptyProject, [CHILD]: childFile("in-progress") });
    await notesOf(app).projects.notes.file(PROJECT).addChild("t1", "Do thing", "do-thing");
    expect(boxOf(app)).toBe(false);
  });

  it("takes the caller's word when given it — for a file too new to have a cache", async () => {
    const app = makeApp({ [PROJECT]: emptyProject });
    await notesOf(app).projects.notes.file(PROJECT).addChild("t1", "Do thing", "do-thing", true);
    expect(boxOf(app)).toBe(true);
  });
});
