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

import { makeApp } from "../__testing__/mock-app";
import { moveTask } from "./task-move";
import { type Project } from "./project";
import { Task } from "./task";
import { TaskType } from "./task";

// ---------------------------------------------------------------------------
// Fixtures
//
// Two projects, Alpha and Beta. Alpha holds a root task "parent" with a child
// "kid" and a grandchild "grand", plus a sibling root task "other".
// ---------------------------------------------------------------------------

const ALPHA = "Projects/Alpha.md";
const BETA = "Projects/Beta.md";

function taskFile(o: {
  id: string;
  title: string;
  projectId?: string;
  parentId?: string;
  type?: string;
  dependencies?: string[];
  subtaskIds?: string[];
  prefix: string;
  description?: string;
  status?: string;
}): string {
  const fm = [
    "---",
    "pm-task: true",
    `id: "${o.id}"`,
    `title: "${o.title}"`,
    `projectId: "${o.projectId ?? "alpha"}"`,
    ...(o.parentId ? [`parentId: "${o.parentId}"`] : []),
    `type: ${o.type ?? "task"}`,
    `status: ${o.status ?? "todo"}`,
    `subtaskIds: [${(o.subtaskIds ?? []).map((s) => `"${s}"`).join(", ")}]`,
    `dependencies: [${(o.dependencies ?? []).map((d) => `"${d}"`).join(", ")}]`,
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "---",
  ].join("\n");
  const body = o.description ? `${o.prefix}\n\n${o.description}` : o.prefix;
  return `${fm}\n\n${body}\n`;
}

function projectFile(o: {
  id: string; title: string; taskIds?: string[];
  /** `[basename, title]` pairs, matching the aliased form obsidian-pm writes. */
  tasks?: [string, string][];
}): string {
  const fm = [
    "---",
    "pm-project: true",
    `id: "${o.id}"`,
    `title: "${o.title}"`,
    `taskIds: [${(o.taskIds ?? []).map((t) => `"${t}"`).join(", ")}]`,
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "---",
  ].join("\n");
  const list = (o.tasks ?? []).map(([b, t]) => `- [ ] [[${b}|${t}]]`).join("\n");
  return `${fm}\n\n# Project\n\n## Tasks\n${list}\n`;
}

const PATHS = {
  parent: "Projects/Alpha_tasks/parent.md",
  kid: "Projects/Alpha_tasks/kid.md",
  grand: "Projects/Alpha_tasks/grand.md",
  other: "Projects/Alpha_tasks/other.md",
};

function tasks(): Record<string, Task> {
  const base = { status: "todo", subtasks: [], dependencies: [] };
  return {
    parent: new Task({ ...base, id: "parent", title: "Parent", projectId: "alpha", type: TaskType.Task, filePath: PATHS.parent }),
    kid: new Task({ ...base, id: "kid", title: "Kid", projectId: "alpha", parentId: "parent", type: TaskType.Subtask, filePath: PATHS.kid }),
    grand: new Task({ ...base, id: "grand", title: "Grand", projectId: "alpha", parentId: "kid", type: TaskType.Subtask, filePath: PATHS.grand }),
    other: new Task({ ...base, id: "other", title: "Other", projectId: "alpha", type: TaskType.Task, filePath: PATHS.other }),
  };
}

function makeVault(overrides: Record<string, string> = {}) {
  return makeApp({
    [ALPHA]: projectFile({
      id: "alpha", title: "Alpha", taskIds: ["parent", "other"],
      tasks: [["parent", "Parent"], ["other", "Other"]],
    }),
    [BETA]: projectFile({ id: "beta", title: "Beta" }),
    [PATHS.parent]: taskFile({
      id: "parent", title: "Parent", prefix: "Project: [[Alpha|Alpha]]", subtaskIds: ["kid"],
    }),
    [PATHS.kid]: taskFile({
      id: "kid", title: "Kid", parentId: "parent", type: TaskType.Subtask,
      prefix: "Parent: [[parent|Parent]]", subtaskIds: ["grand"],
    }),
    [PATHS.grand]: taskFile({
      id: "grand", title: "Grand", parentId: "kid", type: TaskType.Subtask, prefix: "Parent: [[kid|Kid]]",
    }),
    [PATHS.other]: taskFile({ id: "other", title: "Other", prefix: "Project: [[Alpha|Alpha]]" }),
    ...overrides,
  });
}

const ALPHA_DEST = { projectId: "alpha", projectFilePath: ALPHA, projectTitle: "Alpha" };
const BETA_DEST = { projectId: "beta", projectFilePath: BETA, projectTitle: "Beta" };

/** moveTask locates the project a task is leaving from this list. */
const PROJECTS = [
  { id: "alpha", title: "Alpha", tasks: [], filePath: ALPHA },
  { id: "beta", title: "Beta", tasks: [], filePath: BETA },
] as Project[];

const all = () => Object.values(tasks());

// ---------------------------------------------------------------------------

describe("moveTask — same-project reparent", () => {
  it("moves no files: depth is parentId, not folder location", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    expect(app.fileManager.renameFile).not.toHaveBeenCalled();
    expect(app._files.has(PATHS.other)).toBe(true);
  });

  it("sets parentId and flips type task -> subtask", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    const content = app._files.get(PATHS.other) as string;
    expect(content).toContain('parentId: "parent"');
    expect(content).toContain(`type: "${TaskType.Subtask}"`);
  });

  it("rewrites the body prefix Project: -> Parent:", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    const content = app._files.get(PATHS.other) as string;
    expect(content).toContain("Parent: [[parent|Parent]]");
    expect(content).not.toContain("Project: [[Alpha|Alpha]]");
  });

  it("preserves the description under the rewritten prefix", async () => {
    const app = makeVault({
      [PATHS.other]: taskFile({
        id: "other", title: "Other", prefix: "Project: [[Alpha|Alpha]]", description: "Some notes here.",
      }),
    });
    const t = tasks();
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    expect(app._files.get(PATHS.other)).toContain("Some notes here.");
  });

  it("moving to root flips subtask -> task and restores the Project: prefix", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.kid, ALPHA_DEST, all(), PROJECTS);

    const content = app._files.get(PATHS.kid) as string;
    expect(content).toContain(`type: "${TaskType.Task}"`);
    expect(content).not.toContain("parentId");
    expect(content).toContain("Project: [[Alpha|Alpha]]");
  });

  it("keeps milestone type when moving to root", async () => {
    const app = makeVault({
      [PATHS.kid]: taskFile({
        id: "kid", title: "Kid", parentId: "parent", type: TaskType.Milestone, prefix: "Parent: [[parent|Parent]]",
      }),
    });
    const t = tasks();
    await moveTask(app, { ...t.kid, type: TaskType.Milestone } as Task, ALPHA_DEST, all(), PROJECTS);

    expect(app._files.get(PATHS.kid)).toContain(`type: "${TaskType.Milestone}"`);
  });

  it("unlinks from the old parent and links into the new one exactly once", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.grand, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    const oldParent = app._files.get(PATHS.kid) as string;
    expect(oldParent).toContain("subtaskIds: []");
    expect(oldParent).not.toContain("[[grand|");

    const newParent = app._files.get(PATHS.parent) as string;
    expect(newParent.match(/\[\[grand\|/g)).toHaveLength(1);
    expect(newParent).toContain('"grand"');
  });

  it("unlinks a root task from the project's taskIds and ## Tasks", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    const project = app._files.get(ALPHA) as string;
    expect(project).not.toContain('"other"');
    expect(project).not.toContain("[[other|");
  });

  it("unlinks a hand-edited link that carries no |title alias", async () => {
    const app = makeVault({
      [ALPHA]: projectFile({ id: "alpha", title: "Alpha", taskIds: ["parent", "other"] })
        .replace("## Tasks\n", "## Tasks\n- [ ] [[other]]\n"),
    });
    const t = tasks();
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    expect(app._files.get(ALPHA)).not.toContain("[[other]]");
  });

  it("links a task promoted to root into the project's taskIds and ## Tasks", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.kid, ALPHA_DEST, all(), PROJECTS);

    const project = app._files.get(ALPHA) as string;
    expect(project).toContain('"kid"');
    expect(project).toContain("[[kid|Kid]]");
  });
});

describe("moveTask — cross-project", () => {
  it("relocates the task file into the destination project's folder", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.other, BETA_DEST, all(), PROJECTS);

    expect(app._files.has("Projects/Beta_tasks/other.md")).toBe(true);
    expect(app._files.has(PATHS.other)).toBe(false);
  });

  it("relocates the whole subtree and repoints every descendant's projectId", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.parent, BETA_DEST, all(), PROJECTS);

    for (const name of ["parent", "kid", "grand"]) {
      const path = `Projects/Beta_tasks/${name}.md`;
      expect(app._files.has(path), `${name} relocated`).toBe(true);
      expect(app._files.get(path)).toContain('projectId: "beta"');
    }
    expect(app._files.has(PATHS.kid)).toBe(false);
  });

  it("leaves descendants' parentId and Parent: prefixes untouched", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.parent, BETA_DEST, all(), PROJECTS);

    const kid = app._files.get("Projects/Beta_tasks/kid.md") as string;
    expect(kid).toContain('parentId: "parent"');
    expect(kid).toContain("Parent: [[parent|Parent]]");
  });

  it("suffixes a colliding filename and repoints the child's Parent: link at it", async () => {
    const app = makeVault({ "Projects/Beta_tasks/parent.md": taskFile({
      id: "squatter", title: "Squatter", projectId: "beta", prefix: "Project: [[Beta|Beta]]",
    }) });
    const t = tasks();
    await moveTask(app, t.parent, BETA_DEST, all(), PROJECTS);

    expect(app._files.has("Projects/Beta_tasks/parent-2.md")).toBe(true);
    // The child must follow the parent to its new basename, or its link dangles.
    expect(app._files.get("Projects/Beta_tasks/kid.md")).toContain("Parent: [[parent-2|Parent]]");
  });

  it("repoints the parent's ## Subtasks link when a colliding child is renamed", async () => {
    // Beta already holds a `kid.md`, so the moved child is renamed to `kid-2`.
    // The parent's own checklist must follow, without relying on Obsidian's
    // (here unmodelled, and in practice ambiguous) link auto-update.
    const app = makeVault({
      "Projects/Beta_tasks/kid.md": taskFile({
        id: "squatter", title: "Squatter", projectId: "beta", prefix: "Project: [[Beta|Beta]]",
      }),
      [PATHS.parent]: taskFile({
        id: "parent", title: "Parent", prefix: "Project: [[Alpha|Alpha]]", subtaskIds: ["kid"],
        description: "## Subtasks\n- [ ] [[kid|Kid]]",
      }),
    });
    const t = tasks();
    await moveTask(app, t.parent, BETA_DEST, all(), PROJECTS);

    expect(app._files.has("Projects/Beta_tasks/kid-2.md")).toBe(true);
    const parent = app._files.get("Projects/Beta_tasks/parent.md") as string;
    expect(parent).toContain("[[kid-2|Kid]]");
    expect(parent).not.toContain("[[kid|Kid]]");
  });

  it("gives two colliding siblings distinct filenames", async () => {
    const app = makeVault({
      "Projects/Beta_tasks/kid.md": taskFile({ id: "sq1", title: "Sq", projectId: "beta", prefix: "Project: [[Beta|Beta]]" }),
      "Projects/Beta_tasks/grand.md": taskFile({ id: "sq2", title: "Sq", projectId: "beta", prefix: "Project: [[Beta|Beta]]" }),
    });
    const t = tasks();
    await moveTask(app, t.parent, BETA_DEST, all(), PROJECTS);

    expect(app._files.has("Projects/Beta_tasks/kid-2.md")).toBe(true);
    expect(app._files.has("Projects/Beta_tasks/grand-2.md")).toBe(true);
  });
});

describe("moveTask — dependencies", () => {
  it("clears the moved task's own deps: its siblings stay behind", async () => {
    const app = makeVault({
      [PATHS.other]: taskFile({
        id: "other", title: "Other", dependencies: ["parent"], prefix: "Project: [[Alpha|Alpha]]",
      }),
    });
    const t = tasks();
    await moveTask(app, { ...t.other, dependencies: ["parent"] } as Task, BETA_DEST, all(), PROJECTS);

    expect(app._files.get("Projects/Beta_tasks/other.md")).toContain("dependencies: []");
  });

  it("prunes the moved task from outside tasks that depended on it", async () => {
    const app = makeVault({
      [PATHS.other]: taskFile({
        id: "other", title: "Other", dependencies: ["parent"], prefix: "Project: [[Alpha|Alpha]]",
      }),
    });
    const t = tasks();
    const list = all().map((x) => (x.id === "other" ? new Task({ ...x, dependencies: ["parent"] }) : x));
    await moveTask(app, t.parent, BETA_DEST, list, PROJECTS);

    expect(app._files.get(PATHS.other)).toContain("dependencies: []");
  });

  it("preserves dependencies internal to the moving subtree", async () => {
    // grand depends on kid; both move together, so the edge stays valid.
    const app = makeVault({
      [PATHS.grand]: taskFile({
        id: "grand", title: "Grand", parentId: "kid", type: TaskType.Subtask,
        dependencies: ["kid"], prefix: "Parent: [[kid|Kid]]",
      }),
    });
    const t = tasks();
    const list = all().map((x) => (x.id === "grand" ? new Task({ ...x, dependencies: ["kid"] }) : x));
    await moveTask(app, t.parent, BETA_DEST, list, PROJECTS);

    expect(app._files.get("Projects/Beta_tasks/grand.md")).toContain('dependencies: ["kid"]');
  });
});

describe("moveTask — link edits stay inside their section", () => {
  it("ignores a lookalike checklist line in the parent's description", async () => {
    // The description quotes a link to "grand"; the real entry belongs under
    // ## Subtasks, and the quoted prose must survive untouched.
    const app = makeVault({
      [PATHS.parent]: taskFile({
        id: "parent", title: "Parent", prefix: "Project: [[Alpha|Alpha]]",
        description: "Blocked by:\n- [ ] [[grand|Grand]]\n\n## Subtasks\n- [ ] [[kid|Kid]]",
        subtaskIds: ["kid"],
      }),
    });
    const t = tasks();
    await moveTask(app, t.grand, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    const parent = app._files.get(PATHS.parent) as string;
    // Exactly two links to grand would mean the prose got rewritten instead.
    expect(parent).toContain("Blocked by:");
    expect(parent.match(/\[\[grand\|/g)).toHaveLength(2);
    expect(parent.indexOf("## Subtasks")).toBeLessThan(parent.lastIndexOf("[[grand|"));
  });

  it("is not fooled by a '## Subtasks' heading quoted in the description", async () => {
    // A description that contains the literal section heading before the real
    // one must not steal the link edit — the heading is only a section when it
    // stands on its own line, which the quoted `> ## Subtasks` does not.
    const app = makeVault({
      [PATHS.parent]: taskFile({
        id: "parent", title: "Parent", prefix: "Project: [[Alpha|Alpha]]",
        description: "Notes: see `## Subtasks` below.\n\n## Subtasks\n- [ ] [[kid|Kid]]",
        subtaskIds: ["kid"],
      }),
    });
    const t = tasks();
    // Add a second child under parent, forcing an addChildLink into the section.
    const withSecond = [...all(), new Task({
      id: "kid2", title: "Kid2", projectId: "alpha", parentId: "parent",
      type: TaskType.Subtask, status: "todo", subtasks: [], dependencies: [],
      filePath: PATHS.other,
    })];
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, withSecond, PROJECTS);

    const parent = app._files.get(PATHS.parent) as string;
    // The prose mention survives, and the new entry lands in the *real* section
    // (after the heading on its own line), not appended against the quoted one.
    expect(parent).toContain("Notes: see `## Subtasks` below.");
    expect(parent).toContain("[[kid|Kid]]");
    expect(parent.indexOf("[[other|Other]]")).toBeGreaterThan(parent.lastIndexOf("## Subtasks"));
  });
});

describe("moveTask — the box on the new entry", () => {
  it("ticks it for a task the vault says is done", async () => {
    const app = makeVault({
      [PATHS.other]: taskFile({
        id: "other", title: "Other", prefix: "Project: [[Alpha|Alpha]]", status: "done",
      }),
    });
    const t = tasks();
    await moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);
    expect(app._files.get(PATHS.parent)).toContain("- [x] [[other|Other]]");
  });

  it("takes the box from the task file, not from the caller's list", async () => {
    // The list was read before the task was reopened; only the file knows that.
    const app = makeVault();
    const t = tasks();
    const staleDone = new Task({ ...t.other, status: "done" });

    await moveTask(app, staleDone, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS);

    expect(app._files.get(PATHS.parent)).toContain("- [ ] [[other|Other]]");
  });
});

describe("moveTask — guards and idempotency", () => {
  it("does nothing when the destination is where the task already is", async () => {
    const app = makeVault();
    const t = tasks();
    await moveTask(app, t.other, ALPHA_DEST, all(), PROJECTS);

    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(app.fileManager.renameFile).not.toHaveBeenCalled();
  });

  it("refuses to move a task under its own descendant", async () => {
    const app = makeVault();
    const t = tasks();
    await expect(
      moveTask(app, t.parent, { ...ALPHA_DEST, parentTask: t.grand }, all(), PROJECTS),
    ).rejects.toThrow(/own subtask/);
  });

  it("refuses to move a task under itself", async () => {
    const app = makeVault();
    const t = tasks();
    await expect(
      moveTask(app, t.parent, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS),
    ).rejects.toThrow(/under itself/);
  });

  it("throws when the task file is missing", async () => {
    const app = makeVault();
    const t = tasks();
    app._files.delete(PATHS.other);
    await expect(
      moveTask(app, t.other, { ...ALPHA_DEST, parentTask: t.parent }, all(), PROJECTS),
    ).rejects.toThrow(/File not found/);
  });

  it("unlinks the old project even when its folder name does not match it", async () => {
    // Obsidian does not rename `<name>_tasks/` when the project note is renamed,
    // so the old project must be located by id, not derived from the folder.
    const RENAMED = "Projects/Renamed.md";
    const app = makeVault({
      [RENAMED]: projectFile({
        id: "alpha", title: "Renamed", taskIds: ["parent", "other"],
        tasks: [["parent", "Parent"], ["other", "Other"]],
      }),
    });
    app._files.delete(ALPHA);
    const projects = [
      { id: "alpha", title: "Renamed", tasks: [], filePath: RENAMED },
      { id: "beta", title: "Beta", tasks: [], filePath: BETA },
    ] as Project[];
    const t = tasks();

    await moveTask(app, t.other, BETA_DEST, all(), projects);

    expect(app._files.get(RENAMED)).not.toContain('"other"');
    expect(app._files.get(RENAMED)).not.toContain("[[other|");
  });

  it("prunes an outside dependent of a moved descendant", async () => {
    // Nothing on disk enforces the same-level dependency rule, so a dependency
    // on a descendant can exist and would otherwise survive across projects.
    const app = makeVault({
      [PATHS.other]: taskFile({
        id: "other", title: "Other", dependencies: ["grand"], prefix: "Project: [[Alpha|Alpha]]",
      }),
    });
    const t = tasks();
    const list = all().map((x) => (x.id === "other" ? new Task({ ...x, dependencies: ["grand"] }) : x));

    await moveTask(app, t.parent, BETA_DEST, list, PROJECTS);

    expect(app._files.get(PATHS.other)).toContain("dependencies: []");
  });

  it("re-running the same move leaves exactly one parent link", async () => {
    const app = makeVault();
    const t = tasks();
    const dest = { ...ALPHA_DEST, parentTask: t.parent };
    await moveTask(app, t.grand, dest, all(), PROJECTS);
    // Same call again, as if the first had crashed just before finishing.
    await moveTask(app, t.grand, dest, all(), PROJECTS);

    const parent = app._files.get(PATHS.parent) as string;
    expect(parent.match(/\[\[grand\|/g)).toHaveLength(1);
    expect((parent.match(/"grand"/g) ?? []).length).toBe(1);
  });
});

describe("moveTask — a vault that doesn't hold still", () => {
  it("names the file `task` when the title has nothing sluggable in it", async () => {
    const app = makeVault({
      [PATHS.other]: taskFile({ id: "other", title: "!!!", prefix: "Project: [[Alpha|Alpha]]" }),
    });
    const other = new Task({ ...tasks().other, title: "!!!" });
    const list = all().map((x) => (x.id === "other" ? other : x));

    await moveTask(app, other, BETA_DEST, list, PROJECTS);

    expect(app._files.has("Projects/Beta_tasks/task.md")).toBe(true);
  });

  it("throws when the file is gone after the rename", async () => {
    const app = makeVault();
    // A rename that loses the file, as an interrupted move or a sync deleting under us
    // would: the frontmatter commit has nothing left to write to.
    const rename = app.fileManager.renameFile as unknown as Mock<(f: { path: string }) => Promise<void>>;
    rename.mockImplementation(async (file: { path: string }) => { app._files.delete(file.path); });

    await expect(moveTask(app, tasks().other, BETA_DEST, all(), PROJECTS))
      .rejects.toThrow(/File not found after move: Projects\/Beta_tasks\/other\.md/);
  });

  it("fails the move rather than half-applying it when a descendant vanished", async () => {
    // Its rename is skipped and its frontmatter left alone, so nothing lands at the
    // destination — but the body-prefix step still expects the note and gives up there.
    const app = makeVault();
    app._files.delete(PATHS.grand);

    await expect(moveTask(app, tasks().parent, BETA_DEST, all(), PROJECTS))
      .rejects.toThrow(/File not found: Projects\/Beta_tasks\/grand\.md/);
    expect(app._files.has("Projects/Beta_tasks/grand.md")).toBe(false);
  });
});
