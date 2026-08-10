import { vi, describe, it, expect } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  return { MockTFile };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  TFolder: class {},
  App: class {},
  normalizePath: (p: string) => p,
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
}));

import { makeApp } from "../__testing__/mock-app";
import { notesOf } from "../__testing__/notes";
import { syncChangedNote } from "./listing-sync";

const FOLDER = "Projects";
const PROJECT = "Projects/Alpha.md";
const TASKS = "Projects/Alpha_tasks";

function projectNote(body: string, taskIds: string[] = []): string {
  const ids = taskIds.map((s) => `"${s}"`).join(", ");
  return `---\npm-project: true\nid: "p1"\ntitle: "Alpha"\ntaskIds: [${ids}]\n---\n${body}`;
}

function taskNote(id: string, status: string, body = ""): string {
  return `---\npm-task: true\nid: "${id}"\nprojectId: "p1"\ntitle: "${id.toUpperCase()}"\nstatus: "${status}"\n---\n${body}`;
}

function vaultOf(files: Record<string, string>) {
  const app = makeApp(files);
  return { app, vault: notesOf(app, FOLDER) };
}

const body = (app: ReturnType<typeof makeApp>, path: string) =>
  (app._files.get(path) as string).replace(/^---\n[\s\S]*?\n---\n/, "");

describe("syncChangedNote", () => {
  it("mirrors a task onto the line that lists it", async () => {
    const { app, vault } = vaultOf({
      [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
      [`${TASKS}/t1.md`]: taskNote("t1", "done", `Project: [[Alpha|Alpha]]\n`),
    });

    await syncChangedNote(vault, `${TASKS}/t1.md`);

    expect(body(app, PROJECT)).toContain("- [x] [[t1|T1]]");
  });

  it("repairs a listing's boxes from the tasks it names", async () => {
    const { app, vault } = vaultOf({
      [PROJECT]: projectNote("## Tasks\n- [x] [[t1|T1]]\n", ["t1"]),
      [`${TASKS}/t1.md`]: taskNote("t1", "todo"),
    });

    await syncChangedNote(vault, PROJECT);

    expect(body(app, PROJECT)).toContain("- [ ] [[t1|T1]]");
  });

  it("puts both halves of a task that lists subtasks back in step", async () => {
    const { app, vault } = vaultOf({
      [PROJECT]: projectNote("## Tasks\n- [ ] [[parent|PARENT]]\n", ["parent"]),
      [`${TASKS}/parent.md`]: taskNote(
        "parent", "done",
        "Project: [[Alpha|Alpha]]\n\n## Subtasks\n- [ ] [[kid|KID]]\n",
      ),
      [`${TASKS}/kid.md`]: taskNote("kid", "done"),
    });

    await syncChangedNote(vault, `${TASKS}/parent.md`);

    // Its own line up in the project, and the boxes under it, both.
    expect(body(app, PROJECT)).toContain("- [x] [[parent|PARENT]]");
    expect(body(app, `${TASKS}/parent.md`)).toContain("- [x] [[kid|KID]]");
  });

  it("leaves a note that is neither a task nor a project alone", async () => {
    const { app, vault } = vaultOf({
      [PROJECT]: projectNote("## Tasks\n- [x] [[t1|T1]]\n", ["t1"]),
      "Projects/note.md": "---\ntitle: \"Just a note\"\n---\n",
      [`${TASKS}/t1.md`]: taskNote("t1", "todo"),
    });
    const before = app._files.get(PROJECT);

    await syncChangedNote(vault, "Projects/note.md");

    expect(app._files.get(PROJECT)).toBe(before);
  });

  it("leaves a path the vault holds nothing at alone", async () => {
    const { vault } = vaultOf({});

    await expect(syncChangedNote(vault, "Projects/gone.md")).resolves.toBeUndefined();
  });

  it("writes nothing when the note and its listings already agree", async () => {
    const { app, vault } = vaultOf({
      [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
      [`${TASKS}/t1.md`]: taskNote("t1", "todo", "Project: [[Alpha|Alpha]]\n"),
    });
    app.vault.modify.mockClear();

    await syncChangedNote(vault, `${TASKS}/t1.md`);

    expect(app.vault.modify).not.toHaveBeenCalled();
  });
});
