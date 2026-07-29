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

import { makeApp } from "../__testing__/mock-app";
import { syncChangedNote } from "./listing-sync";
import { repairListings } from "./listing-repair";
import { ProjectTaskFile } from "./project-task-file";
import { moveTask } from "./task-move";
import { type Project } from "./project";
import { Task } from "./task";
import { Priority } from "../base-task";
import { PatchableField } from "./project-task-file";
import { TaskType } from "./task";

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
  verified: Set<string>;
  /** Drain the queue through the dispatcher; returns how many events it took. */
  drain: () => Promise<number>;
}

function makeLoop(files: Record<string, string>, verified: string[] = []): Loop {
  const app = makeApp(files);
  const queue: string[] = [];
  const notify = (path: string) => { if (!queue.includes(path)) queue.push(path); };

  for (const write of [app.vault.modify, app.vault.process, app.fileManager.processFrontMatter]) {
    const original = write.getMockImplementation()!;
    write.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      notify((args[0] as { path: string }).path);
      return result;
    });
  }

  const set = new Set(verified);
  const drain = async () => {
    let handled = 0;
    while (queue.length > 0) {
      if (++handled > CAP) throw new Error(`the sync never settled: ${handled} events and counting`);
      const path = queue.shift()!;
      await syncChangedNote(app, set, path, app._files.get(path) ?? "");
    }
    return handled;
  };
  return { app, verified: set, drain };
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
  const before = new Map(l.app._files as Map<string, string>);
  const writes = () =>
    l.app.vault.modify.mock.calls.length
    + l.app.vault.process.mock.calls.length
    + l.app.fileManager.processFrontMatter.mock.calls.length;

  const beforeWrites = writes();
  for (const path of before.keys()) {
    await syncChangedNote(l.app, l.verified, path, l.app._files.get(path) ?? "");
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

    await syncChangedNote(l.app, l.verified, ALPHA, l.app._files.get(ALPHA) as string);
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });

  it("after the user unticks a box — the task reopens and stays open", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "done"),
    }, [ALPHA]);

    await syncChangedNote(l.app, l.verified, ALPHA, l.app._files.get(ALPHA) as string);
    await settle(l);

    expect(statusOf(l)).toBe("todo");
    expect(boxOf(l)).toBe(false);
  });

  it("after a task is closed from the modal", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA]);

    await new ProjectTaskFile(l.app, T1).patchField(PatchableField.Status, "done");
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });

  it("after a task is renamed from the modal", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    }, [ALPHA]);

    await new ProjectTaskFile(l.app, T1).patchField(PatchableField.Title, "Do it better");
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
    await syncChangedNote(l.app, l.verified, T1, l.app._files.get(T1) as string);
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });

  it("after a cancelled task's box is ticked — it closes, and is not reopened", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [x] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "cancelled"),
    }, [ALPHA]);

    await syncChangedNote(l.app, l.verified, ALPHA, l.app._files.get(ALPHA) as string);
    await settle(l);

    expect(statusOf(l)).toBe("done");
  });

  it("after a task is created", async () => {
    const l = makeLoop({ [ALPHA]: projectNote("") }, [ALPHA]);

    await ProjectTaskFile.create(l.app, {
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

    const project: Project = { id: "p1", title: "Alpha", filePath: ALPHA, tasks: [] };
    const base = { projectId: "p1", dependencies: [], subtasks: [] };
    const parent = new Task({ ...base, id: "t1", title: "Parent", status: "todo", filePath: T1 });
    // The snapshot still says done; the file says otherwise, having been reopened since.
    const child = new Task({ ...base, id: "t2", title: "Child", status: "done", filePath: `${FOLDER}/t2.md` });

    await moveTask(l.app, child, {
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

    await syncChangedNote(l.app, l.verified, ALPHA, l.app._files.get(ALPHA) as string);
    await settle(l);

    // The tick is not read as an edit — nobody had checked this listing yet.
    expect(statusOf(l)).toBe("todo");
    expect(boxOf(l)).toBe(false);
    expect(l.verified.has(ALPHA)).toBe(true);
  });

  it("reads the next tick as an edit, now that it has been checked", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    });

    await syncChangedNote(l.app, l.verified, ALPHA, l.app._files.get(ALPHA) as string);
    l.app._files.set(ALPHA, projectNote("- [x] [[t1|Do thing]]\n", ["t1"]));
    await syncChangedNote(l.app, l.verified, ALPHA, l.app._files.get(ALPHA) as string);
    await settle(l);

    expect(statusOf(l)).toBe("done");
  });

  it("reads the first tick as an edit when the opening pass has been through", async () => {
    const l = makeLoop({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [T1]: taskNote("t1", "Do thing", "todo"),
    });

    const project: Project = { id: "p1", title: "Alpha", filePath: ALPHA, tasks: [] };
    const task = new Task({
      id: "t1", title: "Do thing", projectId: "p1", status: "todo",
      dependencies: [], subtasks: [], filePath: T1,
    });
    await repairListings(l.app, [project], [task]);
    l.verified.add(ALPHA);
    l.verified.add(T1);
    await l.drain();

    l.app._files.set(ALPHA, projectNote("- [x] [[t1|Do thing]]\n", ["t1"]));
    await syncChangedNote(l.app, l.verified, ALPHA, l.app._files.get(ALPHA) as string);
    await settle(l);

    expect(statusOf(l)).toBe("done");
    expect(boxOf(l)).toBe(true);
  });
});
