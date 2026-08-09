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

const FOLDER = "Projects";
const PROJECT = "Projects/Alpha.md";
const TASKS = "Projects/Alpha_tasks";

function projectNote(body: string, taskIds: string[] = []): string {
  const ids = taskIds.map((s) => `"${s}"`).join(", ");
  return `---\npm-project: true\nid: "p1"\ntitle: "Alpha"\ntaskIds: [${ids}]\n---\n${body}`;
}

function taskNote(id: string, status = "todo"): string {
  return `---\npm-task: true\nid: "${id}"\nprojectId: "p1"\ntitle: "${id}"\nstatus: "${status}"\n---\n`;
}

/** The project note's file, over a vault holding those files. */
function listing(files: Record<string, string>) {
  const app = makeApp(files);
  const vault = notesOf(app, FOLDER);
  return { app, vault, note: vault.projects.cache.file(PROJECT) };
}

const body = (app: ReturnType<typeof makeApp>) =>
  (app._files.get(PROJECT) as string).replace(/^---\n[\s\S]*?\n---\n/, "");

describe("ListingIO", () => {
  describe("the boxes it lists", () => {
    it("reads them off Obsidian's own reading of the note", () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n- [x] [[t2|T2]]\n", ["t1", "t2"]),
      });
      const file = app.vault.getAbstractFileByPath(PROJECT)!;

      expect(note.readListing(app.metadataCache.getFileCache(file as never)))
        .toEqual([{ basename: "t1", checked: false }, { basename: "t2", checked: true }]);
    });

    it("says whether one of them names a child", () => {
      const { note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
      });

      expect(note.listsChild("t1")).toBe(true);
      expect(note.listsChild("t2")).toBe(false);
    });

    it("lists nothing for a note the vault doesn't hold", () => {
      const { note } = listing({});

      expect(note.listsChild("t1")).toBe(false);
    });
  });

  describe("adding and removing a child", () => {
    it("writes the id and the line, taking the box from the task's own status", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote(""),
        [`${TASKS}/t1.md`]: taskNote("t1", "done"),
      });

      await note.addChild("t1", "T1", "t1");

      expect(body(app)).toContain("## Tasks\n- [x] [[t1|T1]]");
      expect(app._files.get(PROJECT)).toContain('taskIds: ["t1"]');
    });

    it("takes the box it is given for a child too new to have been read", async () => {
      const { app, note } = listing({ [PROJECT]: projectNote("") });

      await note.addChild("t1", "T1", "t1", true);

      expect(body(app)).toContain("- [x] [[t1|T1]]");
    });

    it("drops the id and the line again", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
      });

      await note.removeChild("t1", "t1");

      expect(body(app)).not.toContain("[[t1|T1]]");
      expect(app._files.get(PROJECT)).toContain("taskIds: []");
    });

    it("rewrites one child's line", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
      });

      await note.updateChild("t1", { title: "Renamed", checked: true });

      expect(body(app)).toContain("- [x] [[t1|Renamed]]");
    });

    it("drops a line without touching the id list, and says whether it held one", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
      });

      expect(await note.dropChildEntry("t1")).toBe(true);
      expect(body(app)).not.toContain("[[t1|T1]]");
      expect(app._files.get(PROJECT)).toContain('taskIds: ["t1"]');

      expect(await note.dropChildEntry("t1")).toBe(false);
    });
  });

  describe("keeping the boxes and the tasks in step", () => {
    it("repairs the boxes from the tasks the first time the listing is seen", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
        [`${TASKS}/t1.md`]: taskNote("t1", "done"),
      });

      await note.syncChildBoxes();

      expect(body(app)).toContain("- [x] [[t1|T1]]");
    });

    it("mirrors the boxes onto the tasks once the listing is known to agree", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [x] [[t1|T1]]\n", ["t1"]),
        [`${TASKS}/t1.md`]: taskNote("t1", "todo"),
      });
      note.markVerified();

      await note.syncChildBoxes();

      expect(app._files.get(`${TASKS}/t1.md`)).toContain('status: "done"');
      expect(body(app)).toContain("- [x] [[t1|T1]]");
    });

    it("takes the listing as agreeing once it has repaired it", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [x] [[t1|T1]]\n", ["t1"]),
        [`${TASKS}/t1.md`]: taskNote("t1", "todo"),
      });

      // First pass repairs the box from the task…
      await note.syncChildBoxes();
      expect(body(app)).toContain("- [ ] [[t1|T1]]");

      // …and the second, the listing now agreeing, pushes a box onto the task.
      await note.updateChild("t1", { checked: true });
      await note.syncChildBoxes();
      expect(app._files.get(`${TASKS}/t1.md`)).toContain('status: "done"');
    });

    it("takes a note whose file has gone as unseen again", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [x] [[t1|T1]]\n", ["t1"]),
        [`${TASKS}/t1.md`]: taskNote("t1", "todo"),
      });
      note.markVerified();

      note.gone();
      await note.syncChildBoxes();

      // Repaired from the task rather than pushed onto it: the standing went with the note.
      expect(body(app)).toContain("- [ ] [[t1|T1]]");
      expect(app._files.get(`${TASKS}/t1.md`)).toContain('status: "todo"');
    });

    it("leaves a box naming anything but a task note alone", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [x] [[a-page|A page]]\n"),
      });

      await note.repairChildBoxes();

      expect(body(app)).toContain("- [x] [[a-page|A page]]");
    });

    it("writes nothing when every box already says what its task does", async () => {
      const { app, note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
        [`${TASKS}/t1.md`]: taskNote("t1", "todo"),
      });
      const before = app._files.get(PROJECT);

      await note.repairChildBoxes();

      expect(app._files.get(PROJECT)).toBe(before);
    });
  });

  describe("making the whole listing agree", () => {
    it("writes the entries it was given, and says it wrote", async () => {
      const { app, note } = listing({ [PROJECT]: projectNote("") });

      const wrote = await note.syncChildListing([
        { id: "t1", title: "T1", basename: "t1", checked: false },
      ]);

      expect(wrote).toBe(true);
      expect(body(app)).toContain("- [ ] [[t1|T1]]");
    });

    it("says it wrote nothing when the listing already reads that way", async () => {
      const { note } = listing({
        [PROJECT]: projectNote("## Tasks\n- [ ] [[t1|T1]]\n", ["t1"]),
      });

      expect(await note.syncChildListing([
        { id: "t1", title: "T1", basename: "t1", checked: false },
      ])).toBe(false);
    });
  });
});
