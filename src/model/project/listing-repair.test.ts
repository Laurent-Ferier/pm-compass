import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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
  // Unused here, but the vault helper reaches the date parsing that reads it.
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
  TFile: MockTFile,
  TFolder: MockTFolder,
  normalizePath: (p: string) => p,
  App: class {},
}));

import { makeApp } from "../__testing__/mock-app";
import { repairListings, unlinkDeletedTask } from "./listing-repair";
import { type Project } from "./project";
import { ProjectTask, TaskType } from "./project-task";
import { newProject, newTask, notesOf } from "../__testing__/notes";

const ALPHA = "Projects/Alpha.md";
const FOLDER = "Projects/Alpha_tasks";

const project = (): Project => newProject({ id: "p1", title: "Alpha", filePath: ALPHA });

const task = (fields: Partial<ProjectTask> & { id: string; title: string }): ProjectTask =>
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
    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t1|Do thing]]");
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

  it("writes nothing for a vault already in step", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
    });
    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
    expect(app.vault.process).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });
});

describe("repairListings — a task naming a parent that isn't there", () => {
  const NOW = new Date("2026-08-11T12:00:00.000Z");
  const AN_HOUR_AGO = new Date("2026-08-11T10:30:00.000Z");
  const A_MINUTE_AGO = new Date("2026-08-11T11:59:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  /** A task note carrying a `parentId`, whether or not anything answers to it, and the mark
   *  a pass leaves on one whose parent it couldn't find. */
  const childFile = (id: string, title: string, parentId: string, orphanedAt?: Date) =>
    `---\npm-task: true\nid: "${id}"\nprojectId: "p1"\nparentId: "${parentId}"\ntitle: "${title}"\n`
    + `type: subtask\nstatus: todo\n`
    + (orphanedAt ? `orphanedAt: "${orphanedAt.toISOString()}"\n` : "")
    + `---\nProject: [[Alpha|Alpha]]\n`;

  const orphan = (orphanedAt?: Date) =>
    task({ id: "t1", title: "Do thing", parentId: "ghost", type: TaskType.Subtask, orphanedAt });

  it("marks it on the first sighting, and touches nothing else about it", async () => {
    const app = makeApp({ [ALPHA]: projectNote(""), [`${FOLDER}/t1.md`]: childFile("t1", "Do thing", "ghost") });

    await repairListings(notesOf(app), [project()], [orphan()]);

    const note = app._files.get(`${FOLDER}/t1.md`) as string;
    expect(note).toContain(`orphanedAt: "${NOW.toISOString()}"`);
    expect(note).toContain('parentId: "ghost"');
    expect(note).toContain('type: "subtask"');
  });

  it("lists it as a root of its project all the same, which is what it now is", async () => {
    const app = makeApp({ [ALPHA]: projectNote(""), [`${FOLDER}/t1.md`]: childFile("t1", "Do thing", "ghost") });

    await repairListings(notesOf(app), [project()], [orphan()]);

    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t1|Do thing]]");
    expect(bodyOf(app, `${FOLDER}/t1.md`)).toContain("Project: [[Alpha|Alpha]]");
  });

  it("leaves a mark of its own alone, so the wait doesn't start again at every pass", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: childFile("t1", "Do thing", "ghost", A_MINUTE_AGO),
    });

    await repairListings(notesOf(app), [project()], [orphan(A_MINUTE_AGO)]);

    const note = app._files.get(`${FOLDER}/t1.md`) as string;
    expect(note).toContain(`orphanedAt: "${A_MINUTE_AGO.toISOString()}"`);
    expect(note).toContain('parentId: "ghost"');
  });

  it("attaches it to its project once the mark has stood long enough", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: childFile("t1", "Do thing", "ghost", AN_HOUR_AGO),
    });

    await repairListings(notesOf(app), [project()], [orphan(AN_HOUR_AGO)]);

    const note = app._files.get(`${FOLDER}/t1.md`) as string;
    expect(note).not.toContain("parentId");
    expect(note).not.toContain("orphanedAt");
    expect(note).toContain('type: "task"');
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t1|Do thing]]");
  });

  it("drops the mark, and keeps the parentage, when the parent turns up after all", async () => {
    // What the wait is for: a sync landed the parent note between the two passes.
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Parent"),
      [`${FOLDER}/t2.md`]: childFile("t2", "Child", "t1", AN_HOUR_AGO),
    });
    const tasks = [
      task({ id: "t1", title: "Parent" }),
      task({ id: "t2", title: "Child", parentId: "t1", orphanedAt: AN_HOUR_AGO }),
    ];

    await repairListings(notesOf(app), [project()], tasks);

    const note = app._files.get(`${FOLDER}/t2.md`) as string;
    expect(note).toContain('parentId: "t1"');
    expect(note).not.toContain("orphanedAt");
  });

  it("leaves a parent that does exist alone", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Parent"),
      [`${FOLDER}/t2.md`]: childFile("t2", "Child", "t1"),
    });
    const tasks = [task({ id: "t1", title: "Parent" }), task({ id: "t2", title: "Child", parentId: "t1" })];

    await repairListings(notesOf(app), [project()], tasks);

    const note = app._files.get(`${FOLDER}/t2.md`) as string;
    expect(note).toContain('parentId: "t1"');
    expect(note).not.toContain("orphanedAt");
  });

  it("writes nothing when the note gained a real parent while the pass ran", async () => {
    // The pass read `ghost`; the file already says otherwise — a sync that landed mid-walk.
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: childFile("t1", "Do thing", "t9", AN_HOUR_AGO),
    });

    await repairListings(notesOf(app), [project()], [orphan(AN_HOUR_AGO)]);

    expect(app._files.get(`${FOLDER}/t1.md`)).toContain('parentId: "t9"');
  });

  it("never marks a task that names no parent at all", async () => {
    const app = makeApp({ [ALPHA]: projectNote(""), [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing") });

    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);

    expect(app._files.get(`${FOLDER}/t1.md`)).not.toContain("orphanedAt");
  });
});

describe("repairListings — a task naming a project that isn't there", () => {
  it("leaves its body link alone, the note not saying which project it meant", async () => {
    const app = makeApp({
      [ALPHA]: projectNote(""),
      [`${FOLDER}/t1.md`]: `---\npm-task: true\nid: "t1"\nprojectId: "p9"\ntitle: "Do thing"\nstatus: todo\n---\n`,
    });

    await repairListings(
      notesOf(app), [project()], [task({ id: "t1", title: "Do thing", projectId: "p9" })],
    );

    expect(bodyOf(app, `${FOLDER}/t1.md`)).not.toContain("Project:");
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
    await repairListings(notesOf(app), [project()], [
      task({ id: "t1", title: "Do thing" }),
      task({ id: "t2", title: "Sub thing", parentId: "t1" }),
    ]);
    expect(bodyOf(app, `${FOLDER}/t2.md`)).toContain("Parent: [[t1|Do thing]]");
  });

  it("leaves a prefix that already agrees untouched", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: taskNote("t1", "Do thing"),
    });
    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Do thing" })]);
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
    await repairListings(notesOf(app), [], [task({ id: "t1", title: "Do thing" })]);
    expect(bodyOf(app, `${FOLDER}/t1.md`)).toContain("Project: [[Alpha|Alpha]]");
    expect(app.vault.modify).not.toHaveBeenCalled();
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

    await repairListings(notesOf(app), [project()], tasks);
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

describe("repairListings — how many notes it has open at once", () => {
  it("reads several task notes at a time rather than one after another", async () => {
    const files: Record<string, string> = { [ALPHA]: projectNote("") };
    const tasks = Array.from({ length: 12 }, (_, i) => {
      files[`${FOLDER}/t${i}.md`] = taskNote(`t${i}`, `Task ${i}`);
      return task({ id: `t${i}`, title: `Task ${i}` });
    });
    const app = makeApp(files);

    // Every read held until the batch around it has started, so the high-water mark is
    // what the pass actually had open — a note-at-a-time pass never gets past one.
    let open = 0;
    let mostOpen = 0;
    const readFile = app.vault.cachedRead;
    app.vault.cachedRead = vi.fn(async (file: Parameters<typeof readFile>[0]) => {
      mostOpen = Math.max(mostOpen, ++open);
      await Promise.resolve();
      open--;
      return readFile(file);
    });

    await repairListings(notesOf(app), [project()], tasks);

    expect(mostOpen).toBeGreaterThan(1);
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

    await unlinkDeletedTask(notesOf(app), `${FOLDER}/t1.md`);
    expect(bodyOf(app, ALPHA)).not.toContain("[[t1");
    expect(bodyOf(app, ALPHA)).toContain("[[t2|Other]]");
  });

  it("drops the entry from the parent task that listed it", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [`${FOLDER}/t1.md`]: parentNote("t1", "- [ ] [[t2|Sub]]\n", ["t2"]),
    });
    await app.vault.createFolder(FOLDER);

    await unlinkDeletedTask(notesOf(app), `${FOLDER}/t2.md`);
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

    await unlinkDeletedTask(notesOf(app), `${FOLDER}/t2.md`);
    expect(app._files.get(`${FOLDER}/t1.md`)).toContain('subtaskIds: ["t2"]');

    await repairListings(notesOf(app), [project()], [task({ id: "t1", title: "Parent" })]);
    expect(app._files.get(`${FOLDER}/t1.md`)).toContain("subtaskIds: []");
  });

  it("ignores a file outside a project's tasks folder", async () => {
    const app = makeApp({ [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]) });
    await unlinkDeletedTask(notesOf(app), "Journal/2026-07-29.md");
    expect(bodyOf(app, ALPHA)).toContain("- [ ] [[t1|Do thing]]");
  });

  it("does nothing when no listing named the task", async () => {
    const app = makeApp({ [ALPHA]: projectNote("- [ ] [[t1|Do thing]]\n", ["t1"]) });
    await app.vault.createFolder(FOLDER);
    await unlinkDeletedTask(notesOf(app), `${FOLDER}/never-listed.md`);
    expect(bodyOf(app, ALPHA)).toBe("## Tasks\n- [ ] [[t1|Do thing]]\n");
  });
});

describe("listings with nothing to list", () => {
  it("leaves a project with no root tasks alone", async () => {
    const app = makeApp({ [ALPHA]: projectNote("") });
    await repairListings(notesOf(app), [project()], []);
    expect(bodyOf(app, ALPHA)).toBe("## Tasks\n");
    expect(app.vault.process).not.toHaveBeenCalled();
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
    await unlinkDeletedTask(notesOf(app), `${FOLDER}/t2.md`);
    expect(bodyOf(app, ALPHA)).toBe("## Tasks\n- [ ] [[t1|Do thing]]\n");
  });

  it("passes over an attachment sitting in the tasks folder", async () => {
    const app = makeApp({
      [ALPHA]: projectNote("- [ ] [[t1|Parent]]\n", ["t1"]),
      [`${FOLDER}/diagram.png`]: "binary",
      [`${FOLDER}/t1.md`]: parentNote("t1", "- [ ] [[t2|Sub]]\n", ["t2"]),
    });
    await app.vault.createFolder(FOLDER);

    await unlinkDeletedTask(notesOf(app), `${FOLDER}/t2.md`);
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

    await unlinkDeletedTask(notesOf(app), `${FOLDER}/t2.md`);
    expect(bodyOf(app, `${FOLDER}/t1.md`)).not.toContain("[[t2");
    expect(app._files.get(`${FOLDER}/notes.md`)).toContain("Just notes.");
  });
});
