import { vi, describe, it, expect } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  class MockTFolder {
    constructor(public path: string, public children: MockTFile[] = []) {}
  }
  return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  TFolder: MockTFolder,
  normalizePath: (p: string) => p,
  App: class {},
}));

import { makeApp } from "../__testing__/mock-app";
import { repairListings, unlinkDeletedTask } from "./listing-repair";
import { type Project } from "./project";
import { Task } from "./task";
import { newProject, newTask, notesOf } from "../__testing__/notes";

const ALPHA = "Projects/Alpha.md";
const FOLDER = "Projects/Alpha_tasks";

const project = (): Project => newProject({ id: "p1", title: "Alpha", filePath: ALPHA });

const task = (fields: Partial<Task> & { id: string; title: string }): Task =>
  newTask({
    projectId: "p1",
    status: "todo",
    dependencies: [],
    filePath: `${FOLDER}/${fields.id}.md`,
    ...fields,
  });

/** A project note listing exactly `entries` under `## Tasks`. */
const projectNote = (entries: string, ids: string[] = []) =>
  `---\npm-project: true\nid: "p1"\ntitle: "Alpha"\ntaskIds: [${ids.map((i) => `"${i}"`).join(", ")}]\n---\n`
  + `## Tasks\n${entries}`;

const taskNote = (id: string, title: string, status = "todo", prefix = "Project: [[Alpha|Alpha]]") =>
  `---\npm-task: true\nid: "${id}"\nprojectId: "p1"\ntitle: "${title}"\nstatus: ${status}\n---\n${prefix}\n`;

const bodyOf = (app: ReturnType<typeof makeApp>, path: string) =>
  (app._files.get(path) as string).replace(/^---\n[\s\S]*?\n---\n/, "");

describe("repairListings — a project's own listing", () => {
  it("adds the entry for a task the note never listed", async () => {
    const app = makeApp({ [ALPHA]: projectNote(""), [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing") });
    const { listingsRewritten } = await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t1|Do thing]]");
    expect(listingsRewritten).toBe(1);
  });

  it("refreshes a stale title and a wrong box together", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Old name]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "New name", "done"),
    });
    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "New name", status: "done" })]);
    expect(bodyOf(app, ALPHA)).toContain("- [x] [[t1|New name]]");
  });

  it("drops the entry of a task that no longer exists", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n- [ ] [[gone|Gone]]\n", ["t1", "gone"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
      [`${FOLDER}/gone.md`]: taskNote("gone", "Gone"),
    });
    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
    expect(bodyOf(app, ALPHA)).not.toContain("[[gone");
  });

  it("leaves a link the user wrote where it stands", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n- [ ] [[2026 Q3 review]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
    });
    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[2026 Q3 review]]");
  });

  it("writes nothing, and reports nothing, for a vault already in step", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
    });
    const result = await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
    expect(result).toEqual({ listingsRewritten: 0, prefixesFixed: 0 });
    expect(app.vault.process).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });
});

describe("repairListings — a parent task's subtasks", () => {
  const parentPrefix = "Parent: [[t1|Do thing]]";

  it("lists a subtask under its parent, not under the project", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
      [`${FOLDER}/t2.md`]: taskNote("t2", "Sub thing", "todo", parentPrefix),
    });
    await repairListings(notesOf(app), [project()], [
      task({ id: "t1", title: "Do thing" }),
      task({ id: "t2", title: "Sub thing", parentId: "t1" }),
    ]);
    expect(bodyOf(app, `${FOLDER}/t1.md`)).toContain("- [ ] [[t2|Sub thing]]");
    expect(bodyOf(app, ALPHA)).not.toContain("[[t2");
  });

  it("lists a task at the project root when its parentId names nothing", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t2.md`]: taskNote("t2", "Orphan"),
    });
    await repairListings(notesOf(app), [project()], [task({ id: "t2", title: "Orphan", parentId: "vanished" })]);
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t2|Orphan]]");
  });

  it("lists a task at the root when its parent sits in another project's folder", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t2.md`]: taskNote("t2", "Stray"),
      "Projects/Beta_tasks/t1.md": taskNote("t1", "Elsewhere"),
    });
    await repairListings(notesOf(app), [project()], [
      task({ id: "t1", title: "Elsewhere", filePath: "Projects/Beta_tasks/t1.md" }),
      task({ id: "t2", title: "Stray", parentId: "t1" }),
    ]);
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t2|Stray]]");
  });
});

describe("repairListings — the body's own link back", () => {
  it("repoints a prefix left behind by a half-applied move", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
      // parentId says t1, but the body still names the project it was moved out of.
      [`${FOLDER}/t2.md`]: taskNote("t2", "Sub thing"),
    });
    const { prefixesFixed } = await repairListings(notesOf(app), [project()], [
      task({ id: "t1", title: "Do thing" }),
      task({ id: "t2", title: "Sub thing", parentId: "t1" }),
    ]);
    expect(bodyOf(app, `${FOLDER}/t2.md`)).toContain("Parent: [[t1|Do thing]]");
    expect(prefixesFixed).toBe(1);
  });

  it("leaves a prefix that already agrees untouched", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
    });
    const { prefixesFixed } = await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
    expect(prefixesFixed).toBe(0);
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("keeps the description below the prefix it rewrites", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
      [`${FOLDER}/t2.md`]: taskNote("t2", "Sub", "todo", "Project: [[Alpha|Alpha]]\n\nSome context."),
    });
    await repairListings(notesOf(app), [project()], [
      task({ id: "t1", title: "Do thing" }),
      task({ id: "t2", title: "Sub", parentId: "t1" }),
    ]);
    expect(bodyOf(app, `${FOLDER}/t2.md`)).toContain("Some context.");
  });

  it("leaves a task alone when neither its parent nor its project can be found", async () => {
    const app = makeApp({ [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing") });
    const { prefixesFixed } = await repairListings(notesOf(app), [], [task({ id: "t1", title: "Do thing" })]);
    expect(prefixesFixed).toBe(0);
  });
});

describe("repairListings — run twice", () => {
  it("is a no-op the second time round", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Old name]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "New name", "done"),
      [`${FOLDER}/t2.md`]: taskNote("t2", "Sub thing"),
    });
    const tasks = [
      task({ id: "t1", title: "New name", status: "done" }),
      task({ id: "t2", title: "Sub thing", parentId: "t1" }),
    ];
    await repairListings(notesOf(app), [project()], tasks);

    vi.mocked(app.vault.process).mockClear();
    vi.mocked(app.vault.modify).mockClear();
    vi.mocked(app.fileManager.processFrontMatter).mockClear();

    const second = await repairListings(notesOf(app), [project()], tasks);
    expect(second).toEqual({ listingsRewritten: 0, prefixesFixed: 0 });
    expect(app.vault.process).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });
});

describe("repairListings — a parent task with nothing left under it", () => {
  const parentNote = (entries: string, subtaskIds: string[]) =>
    `---\npm-task: true\nid: "t1"\nprojectId: "p1"\ntitle: "Parent"\nstatus: todo\n`
    + `subtaskIds: [${subtaskIds.map((s) => `"${s}"`).join(", ")}]\n---\n`
    + `Project: [[Alpha|Alpha]]\n\n## Subtasks\n${entries}`;

  it("clears the entry and the id when its last subtask has gone", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: parentNote("- [ ] [[t2|Sub]]\n", ["t2"]),
      [`${FOLDER}/t2.md`]: taskNote("t2", "Sub"),
    });
    // t2's file is still there but no longer a child of t1 — a `parentId` cleared by
    // hand. The pass has to visit t1 even though it now has no children at all.
    await repairListings(notesOf(app), [project()], [
      task({ id: "t1", title: "Parent" }),
      task({ id: "t2", title: "Sub" }),
    ]);

    expect(bodyOf(app, `${FOLDER}/t1.md`)).not.toContain("[[t2");
    expect(app._files.get(`${FOLDER}/t1.md`)).toContain("subtaskIds: []");
    // t2 became a root task, so the project lists it now.
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t2|Sub]]");
  });
});

describe("unlinkDeletedTask", () => {
  /** A parent task listing `entries` under `## Subtasks`. */
  const parentNote = (id: string, entries: string, subtaskIds: string[]) =>
    `---\npm-task: true\nid: "${id}"\nprojectId: "p1"\ntitle: "Parent"\nstatus: todo\n`
    + `subtaskIds: [${subtaskIds.map((s) => `"${s}"`).join(", ")}]\n---\n`
    + `Project: [[Alpha|Alpha]]\n\n## Subtasks\n${entries}`;

  it("drops the entry from the project note", async () => {
    const app = makeApp({ [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n- [ ] [[t2|Other]]\n", ["t1", "t2"]) });
    await app.vault.createFolder(FOLDER);

    await unlinkDeletedTask(app, `${FOLDER}/t1.md`);
    expect(bodyOf(app, ALPHA)).not.toContain("[[t1");
    expect(bodyOf(app, ALPHA)).toContain("[[t2|Other]]");
  });

  it("drops the entry from the parent task that listed it", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: parentNote("t1", "- [ ] [[t2|Sub]]\n", ["t2"]),
    });
    await app.vault.createFolder(FOLDER);

    await unlinkDeletedTask(app, `${FOLDER}/t2.md`);
    expect(bodyOf(app, `${FOLDER}/t1.md`)).not.toContain("[[t2");
    // The project's own listing is left alone — the task was never listed there.
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t1|Parent]]");
  });

  it("leaves the stale id for the next repair pass to drop", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: parentNote("t1", "- [ ] [[t2|Sub]]\n", ["t2"]),
    });
    await app.vault.createFolder(FOLDER);

    await unlinkDeletedTask(app, `${FOLDER}/t2.md`);
    expect(app._files.get(`${FOLDER}/t1.md`)).toContain('subtaskIds: ["t2"]');

    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Parent" })]);
    expect(app._files.get(`${FOLDER}/t1.md`)).toContain("subtaskIds: []");
  });

  it("ignores a file outside a project's tasks folder", async () => {
    const app = makeApp({ [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]) });
    await unlinkDeletedTask(app, "Journal/2026-07-29.md");
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t1|Do thing]]");
  });

  it("does nothing when no listing named the task", async () => {
    const app = makeApp({ [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]) });
    await app.vault.createFolder(FOLDER);
    await unlinkDeletedTask(app, `${FOLDER}/never-listed.md`);
    expect(bodyOf(app, ALPHA)).toBe("## Tasks\n- [ ] [[t1|Do thing]]\n");
  });
});

describe("listings with nothing to list", () => {
  it("leaves a project with no root tasks alone", async () => {
    const app = makeApp({ [ALPHA]: projectNote("") });
    const { listingsRewritten } = await repairListings(notesOf(app), [project()], []);
    expect(listingsRewritten).toBe(0);
    expect(bodyOf(app, ALPHA)).toBe("## Tasks\n");
  });
});

describe("unlinkDeletedTask — folders that hold no candidate", () => {
  /** A parent task listing `entries` under `## Subtasks`. */
  const parentNote = (id: string, entries: string, subtaskIds: string[]) =>
    `---\npm-task: true\nid: "${id}"\nprojectId: "p1"\ntitle: "Parent"\nstatus: todo\n`
    + `subtaskIds: [${subtaskIds.map((s) => `"${s}"`).join(", ")}]\n---\n`
    + `Project: [[Alpha|Alpha]]\n\n## Subtasks\n${entries}`;

  it("does nothing when the tasks folder went with the task", async () => {
    // The folder is never registered, so the vault reports nothing at that path —
    // which is what deleting a project's last task looks like.
    const app = makeApp({ [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]) });
    await unlinkDeletedTask(app, `${FOLDER}/t2.md`);
    expect(bodyOf(app, ALPHA)).toBe("## Tasks\n- [ ] [[t1|Do thing]]\n");
  });

  it("passes over an attachment sitting in the tasks folder", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [`${FOLDER}/diagram.png`]: "binary",
      [`${FOLDER}/t1.md`]: parentNote("t1", "- [ ] [[t2|Sub]]\n", ["t2"]),
    });
    await app.vault.createFolder(FOLDER);

    await unlinkDeletedTask(app, `${FOLDER}/t2.md`);
    expect(bodyOf(app, `${FOLDER}/t1.md`)).not.toContain("[[t2");
  });

  it("passes over siblings that list no subtasks and notes that aren't tasks", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      // A plain note, and a task with an empty `## Subtasks` — neither can be the holder.
      [`${FOLDER}/notes.md`]: `---\ntitle: "Notes"\n---\nJust notes.\n`,
      [`${FOLDER}/t0.md`]: parentNote("t0", "", []),
      [`${FOLDER}/t1.md`]: parentNote("t1", "- [ ] [[t2|Sub]]\n", ["t2"]),
    });
    await app.vault.createFolder(FOLDER);

    await unlinkDeletedTask(app, `${FOLDER}/t2.md`);
    expect(bodyOf(app, `${FOLDER}/t1.md`)).not.toContain("[[t2");
    expect(app._files.get(`${FOLDER}/notes.md`)).toContain("Just notes.");
  });
});
