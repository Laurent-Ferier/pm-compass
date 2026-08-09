// @vitest-environment jsdom
import { vi, describe, it, expect, type Mock } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  class MockTFolder {
    constructor(public children: (MockTFile | MockTFolder)[] = []) {}
  }
  return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
  // Unused here, but the vault helper reaches the date parsing that reads it.
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
  TFile: MockTFile,
  TFolder: MockTFolder,
  normalizePath: (p: string) => p,
  App: class {},
}));

import { makeApp } from "../__testing__/mock-app";
import { syncChangedNote } from "./listing-sync";
import { repairListings } from "./listing-repair";
import { ProjectTaskIO } from "../io/project-task-io";
import { moveTask } from "./task-move";
import { Priority } from "../base-task";
import { TaskType } from "./project-task";
import { newProject, newTask, notesOf, setField } from "../__testing__/notes";
import type { VaultData } from "../service/vault-data";

/**
 * The two directions of the box/status sync each write, and each write raises the
 * change event the other one listens for. Nothing in a unit test can show that the
 * pair settles rather than trading events forever — every guard that stops it lives in
 * a different function from the rule that depends on it.
 *
 * So: run the loop. Every write puts its path on a queue, the queue is drained through
 * the real dispatcher, and the test asserts it empties and leaves the vault alone once
 * it does.
 */
const ALPHA = "Projects/Alpha.md";
const FOLDER = "Projects/Alpha_tasks";
const T1 = `${FOLDER}/t1.md`;

/** How many events a settling sync is allowed before we call it a loop. */
const CAP = 40;

interface Loop {
  app: ReturnType<typeof makeApp>;
  /** The folder's caches, held for the whole run: a listing's good standing lives on the
   *  note, so a test that stood one up per event would forget it between them. */
  notes: VaultData;
  /** Takes a listing as checked, the way the opening pass would have left it. */
  markVerified: (path: string) => void;
  /** Drain the queue through the dispatcher; returns how many events it took. */
  drain: () => Promise<number>;
}

function makeLoop(files: Record<string, string>, verified: string[] = []): Loop {
  const app = makeApp(files);
  const queue: string[] = [];
  const notify = (path: string) => { if (!queue.includes(path)) queue.push(path); };

  // The three writers take different arguments; only "first argument is the file" matters here.
  const writers = [app.vault.modify, app.vault.process, app.fileManager.processFrontMatter];
  for (const write of writers as unknown as Mock<(...args: unknown[]) => Promise<unknown>>[]) {
    const original = write.getMockImplementation()!;
    write.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      notify((args[0] as { path: string }).path);
      return result;
    });
  }

  const notes = notesOf(app);
  const markVerified = (path: string) => {
    const isProject = (app._files.get(path) as string).includes("pm-project: true");
    (isProject ? notes.projects.cache : notes.projects.taskCache).file(path).markVerified();
  };
  for (const path of verified) markVerified(path);

  const drain = async () => {
    let handled = 0;
    while (queue.length > 0) {
      if (++handled > CAP) throw new Error(`the sync never settled: ${handled} events and counting`);
      const path = queue.shift()!;
      await syncChangedNote(notes, path);
    }
    return handled;
  };
  return { app, notes, markVerified, drain };
}

const projectNote = (entries: string, ids: string[] = []) =>
  `---\npm-project: true\nid: "p1"\ntitle: "Alpha"\ntaskIds: [${ids.map((i) => `"${i}"`).join(", ")}]\n---\n`
  + `## Tasks\n${entries}`;

const taskNote = (id: string, title: string, status: string, prefix = "Project: [[Alpha|Alpha]]") =>
  `---\npm-task: true\nid: "${id}"\nprojectId: "p1"\ntitle: "${title}"\nstatus: ${status}\n---\n${prefix}\n`;

const statusOf = (l: Loop, path = T1) => /status: "?([\w-]+)/.exec(l.app._files.get(path) as string)?.[1];
const boxOf = (l: Loop, basename = "t1", path = ALPHA) =>
  new RegExp(`- \\[([ x])\\] \\[\\[${basename}`).exec(l.app._files.get(path) as string)?.[1] === "x";

/**
 * Drain, then put every note through the dispatcher once more. That pass must not
 * write at all — not merely leave the content as it found it. A rewrite of identical
 * text still raises an event, and a sync that answers every event with one of those
 * has settled on paper only: it would sit there churning the vault, and on a synced
 * one, churning every other device with it.
 */
async function settle(l: Loop): Promise<void> {
  await l.drain();
  const before = new Map(l.app._files);
  const writes = () =>
    l.app.vault.modify.mock.calls.length
    + l.app.vault.process.mock.calls.length
    + l.app.fileManager.processFrontMatter.mock.calls.length;

  const beforeWrites = writes();
  for (const path of before.keys()) {
    await syncChangedNote(l.notes, path);
  }
  expect([...l.app._files.entries()]).toEqual([...before.entries()]);
  expect(writes() - beforeWrites).toBe(0);
}

describe("the box/status sync settles", () => {
  it("after the user ticks a box — the task closes and stays closed", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [x] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA]);

    await syncChangedNote(l.notes, ALPHA);
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });

  it("after the user unticks a box — the task reopens and stays open", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "done"),
    }, [ALPHA]);

    await syncChangedNote(l.notes, ALPHA);
    await settle(l);

    expect(statusOf(l)).toBe("todo");
    expect(boxOf(l)).toBe(false);
  });

  it("after a task is closed from the modal", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA]);

    await setField(l.notes.projects.taskCache.file(T1), "status", "done");
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });

  it("after a task is renamed from the modal", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA]);

    await setField(l.notes.projects.taskCache.file(T1), "title", "Do it better");
    await settle(l);

    expect(l.app._files.get(ALPHA)).toContain("- [ ] [[t1|Do it better]]");
  });

  it("after a status arrives from outside — the box follows rather than fighting it", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA, T1]);

    // What a sync from another device looks like: the task file, rewritten under us.
    l.app._files.set(T1, taskNote("t1", "Do thing", "done"));
    await syncChangedNote(l.notes, T1);
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });

  it("after a cancelled task's box is ticked — it closes, and is not reopened", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [x] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "cancelled"),
    }, [ALPHA]);

    await syncChangedNote(l.notes, ALPHA);
    await settle(l);

    expect(statusOf(l)).toBe("done");
  });

  it("after a task is created", async () => {
    const l = makeLoop({ [ALPHA]: projectNote("") }, [ALPHA]);

    await ProjectTaskIO.create(l.notes, {
      projectId: "p1", projectFilePath: ALPHA, projectTitle: "Alpha",
      title: "Fresh", description: "", status: "todo", type: TaskType.Task, priority: Priority.None,
      progress: 0, start: null, due: null, tags: [], dependencies: [],
    });
    await settle(l);

    expect(boxOf(l, "fresh")).toBe(false);
    expect(l.app._files.get(ALPHA)).toContain("- [ ] [[fresh|Fresh]]");
  });

  it("after a move, without the destination's box undoing a status changed since", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n- [x] [[t2|Child]]\n", ["t1", "t2"]),
      [T1]: taskNote("t1", "Parent", "todo"),
      [`${FOLDER}/t2.md`]: taskNote("t2", "Child", "todo"),
    }, [ALPHA]);

    const project = newProject({ id: "p1", title: "Alpha", filePath: ALPHA });
    const base = { projectId: "p1", dependencies: [] };
    const parent = newTask({ ...base, id: "t1", title: "Parent", status: "todo", filePath: T1 });
    // The snapshot still says done; the file says otherwise, having been reopened since.
    const child = newTask({ ...base, id: "t2", title: "Child", status: "done", filePath: `${FOLDER}/t2.md` });

    await moveTask(l.notes, child, {
      projectId: "p1", projectFilePath: ALPHA, projectTitle: "Alpha", parentTask: parent,
    }, [parent, child], [project]);
    await settle(l);

    expect(statusOf(l, `${FOLDER}/t2.md`)).toBe("todo");
    expect(boxOf(l, "t2", T1)).toBe(false);
  });
});

describe("an unchecked listing", () => {
  it("has its boxes answered by the statuses, and is checked by having been", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [x] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    });

    await syncChangedNote(l.notes, ALPHA);
    await settle(l);

    // The tick is not read as an edit — nobody had checked this listing yet.
    expect(statusOf(l)).toBe("todo");
    expect(boxOf(l)).toBe(false);
  });

  it("reads the next tick as an edit, now that it has been checked", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    });

    await syncChangedNote(l.notes, ALPHA);
    l.app._files.set(ALPHA, projectNote("- [x] [[t1|Do thing]]\n", ["t1"]));
    await syncChangedNote(l.notes, ALPHA);
    await settle(l);

    expect(statusOf(l)).toBe("done");
  });

  it("reads the first tick as an edit when the opening pass has been through", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    });

    const project = newProject({ id: "p1", title: "Alpha", filePath: ALPHA });
    const task = newTask({
      id: "t1", title: "Do thing", projectId: "p1", status: "todo",
      dependencies: [], filePath: T1,
    });
    await repairListings(l.notes, [project], [task]);
    l.markVerified(ALPHA);
    l.markVerified(T1);
    await l.drain();

    l.app._files.set(ALPHA, projectNote("- [x] [[t1|Do thing]]\n", ["t1"]));
    await syncChangedNote(l.notes, ALPHA);
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });
});

describe("a task note that landed while nothing was watching", () => {
  const T2 = `${FOLDER}/t2.md`;
  const listed = (l: Loop, basename: string, path = ALPHA) =>
    (l.app._files.get(path) as string).includes(`[[${basename}|`);

  it("is listed by the project its body names, and stays in step from then on", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
      [T2]: taskNote("t2", "Landed", "todo"),
    }, [ALPHA, T1]);

    await l.notes.projects.taskCache.file(T2).ensureListed();
    await settle(l);

    expect(l.app._files.get(ALPHA)).toContain("- [ ] [[t2|Landed]]");
    expect(l.app._files.get(ALPHA)).toContain(`taskIds: ["t1", "t2"]`);
  });

  it("arrives ticked when it arrives done, rather than as an open task", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote(""),
      [T2]: taskNote("t2", "Landed", "done"),
    }, [ALPHA]);

    await l.notes.projects.taskCache.file(T2).ensureListed();
    await settle(l);

    expect(boxOf(l, "t2")).toBe(true);
    expect(statusOf(l, T2)).toBe("done");
  });

  it("is listed by the parent task its body names, not by the project", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [T1]: taskNote("t1", "Parent", "todo") + "\n## Subtasks\n",
      [T2]: `---\npm-task: true\nid: "t2"\nprojectId: "p1"\nparentId: "t1"\ntitle: "Landed"\n`
        + `status: todo\n---\nParent: [[t1|Parent]]\n`,
    }, [ALPHA, T1]);

    await l.notes.projects.taskCache.file(T2).ensureListed();
    await settle(l);

    expect(l.app._files.get(T1)).toContain("- [ ] [[t2|Landed]]");
    expect(listed(l, "t2")).toBe(false);
  });

  it("is placed by the folder it sits in when its body names nothing", async () => {
    // A note written by hand: a task's own frontmatter, and no `Project:` link opening it.
    const l = makeLoop({
      [ALPHA]: projectNote(""),
      [T2]: taskNote("t2", "Landed", "todo", ""),
    }, [ALPHA]);

    await l.notes.projects.taskCache.file(T2).ensureListed();
    await settle(l);

    expect(l.app._files.get(ALPHA)).toContain("- [ ] [[t2|Landed]]");
  });

  it("is left to the opening pass when only a `parentId` places it", async () => {
    // Which sibling that id names is not in the note, and the folder doesn't say either.
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [T1]: taskNote("t1", "Parent", "todo"),
      [T2]: `---\npm-task: true\nid: "t2"\nprojectId: "p1"\nparentId: "t1"\ntitle: "Landed"\n`
        + `status: todo\n---\n`,
    }, [ALPHA, T1]);
    const before = new Map(l.app._files);

    await l.notes.projects.taskCache.file(T2).ensureListed();

    expect([...l.app._files.entries()]).toEqual([...before.entries()]);
  });

  it("leaves a listing that already names it alone, down to the write", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [x] [[t2|Landed]]\n", ["t2"]),
      [T2]: taskNote("t2", "Landed", "done"),
    }, [ALPHA]);
    const before = new Map(l.app._files);

    await l.notes.projects.taskCache.file(T2).ensureListed();

    expect(l.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect([...l.app._files.entries()]).toEqual([...before.entries()]);
  });

  it("does nothing for a note that isn't a task", async () => {
    const l = makeLoop({ [ALPHA]: projectNote("") });
    const before = new Map(l.app._files);

    await l.notes.projects.taskCache.file(ALPHA).ensureListed();

    expect([...l.app._files.entries()]).toEqual([...before.entries()]);
  });
});

/**
 * The other half of the same problem. The loop above settles because nothing writes twice;
 * this is what keeps the reconcilers from being *asked* twice — a note takes onto its own
 * reading whatever it just wrote to its listing, so Obsidian handing that text back a moment
 * later is a reading that hasn't moved, and wakes nobody.
 */
describe("a listing the plugin wrote itself", () => {
  it("comes back as a reading that hasn't moved", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA]);
    await l.app.vault.createFolder("Projects");
    const notes = l.notes;
    await notes.projects.cache.load();
    const woke = vi.spyOn(notes.projects.cache, "changed");

    // Closing the task reticks the box on the line that lists it, in the project note.
    await setField(notes.projects.taskCache.file(T1), "status", "done");
    notes.projects.cache.reparseNow(ALPHA);

    expect(boxOf(l)).toBe(true);
    expect(woke).not.toHaveBeenCalled();
  });

  it("still hears a box someone else ticked", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA]);
    await l.app.vault.createFolder("Projects");
    const notes = l.notes;
    await notes.projects.cache.load();
    const woke = vi.spyOn(notes.projects.cache, "changed");

    l.app._files.set(ALPHA, projectNote("- [x] [[t1|Do thing]]\n", ["t1"]));
    notes.projects.cache.reparseNow(ALPHA);

    expect(woke).toHaveBeenCalled();
  });

  it("leaves the reading alone for a pass that wrote nothing", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [x] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "done"),
    }, [ALPHA]);
    await l.app.vault.createFolder("Projects");
    const notes = l.notes;
    await notes.projects.cache.load();
    const woke = vi.spyOn(notes.projects.cache, "changed");

    // The listing already agrees, so the repair writes nothing — and nothing moved.
    await notes.projects.cache.file(ALPHA).repairChildBoxes();
    notes.projects.cache.reparseNow(ALPHA);

    expect(woke).not.toHaveBeenCalled();
  });
});

describe("the dispatcher ignores what it can't sync", () => {
  it("does nothing for a path the vault no longer resolves", async () => {
    const l = makeLoop({ [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]) });
    const before = new Map(l.app._files);

    await syncChangedNote(l.notes, `${FOLDER}/deleted.md`);

    expect([...l.app._files.entries()]).toEqual([...before.entries()]);
  });

  it("does nothing for a note that is neither a task nor a project", async () => {
    const NOTE = "Journal/2026-07-29.md";
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [NOTE]: `---\ntitle: "Thursday"\n---\n- [x] bought milk\n`,
    });
    const before = new Map(l.app._files);

    await syncChangedNote(l.notes, NOTE);

    expect([...l.app._files.entries()]).toEqual([...before.entries()]);
  });
});
