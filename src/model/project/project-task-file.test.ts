import { vi, describe, it, expect, beforeEach } from "vitest";

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
  moment: (v?: unknown) => {
    const d = v ? new Date(v as string) : new Date("2026-07-01");
    return {
      format: (fmt: string) => d.toISOString().slice(0, fmt === "YYYY-MM-DD" ? 10 : 19),
    };
  },
}));

import { ProjectTaskFile } from "./project-task-file";
import type { CreateTaskOpts, UpdateTaskData } from "./project-task-file";
import { Task } from "./task";
import { Priority } from "../base-task";
import { PatchableField } from "./project-task-file";
import { TaskType } from "./task";
import { day } from "../__testing__/dates";

// ---------------------------------------------------------------------------
// App mock
// ---------------------------------------------------------------------------

function makeApp(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));

  function parseFm(content: string): Record<string, unknown> {
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm: Record<string, unknown> = {};
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      const val = kv[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        const inner = val.slice(1, -1).trim();
        fm[kv[1]] = inner
          ? inner.split(",").map((v) => v.trim().replace(/^"(.*)"$/, "$1"))
          : [];
      } else if (val === "true" || val === "false") {
        // Unquoted, as the real `processFrontMatter` keeps them: `pm-task` is gated
        // on `=== true`, so a mock that stringified it would pass what the vault fails.
        fm[kv[1]] = val === "true";
      } else {
        fm[kv[1]] = val.replace(/^"(.*)"$/, "$1");
      }
    }
    return fm;
  }

  function serializeFm(fm: Record<string, unknown>): string {
    return Object.entries(fm)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${x}"`).join(", ")}]`;
        return `${k}: ${typeof v === "boolean" ? v : `"${String(v)}"`}`;
      })
      .join("\n");
  }

  const vault = {
    createFolder: vi.fn().mockResolvedValue(undefined),
    getAbstractFileByPath: vi.fn((path: string) =>
      files.has(path) ? new MockTFile(path) : null,
    ),
    getFileByPath: vi.fn((path: string) =>
      files.has(path) ? new MockTFile(path) : null,
    ),
    create: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    read: vi.fn(async (file: InstanceType<typeof MockTFile>) => files.get(file.path) ?? ""),
    cachedRead: vi.fn(async (file: InstanceType<typeof MockTFile>) => files.get(file.path) ?? ""),
    modify: vi.fn(async (file: InstanceType<typeof MockTFile>, content: string) => {
      files.set(file.path, content);
    }),
    process: vi.fn(async (file: InstanceType<typeof MockTFile>, fn: (data: string) => string) => {
      const next = fn(files.get(file.path) ?? "");
      files.set(file.path, next);
      return next;
    }),
    delete: vi.fn(async (file: InstanceType<typeof MockTFile>) => {
      files.delete(file.path);
    }),
  };

  const fileManager = {
    processFrontMatter: vi.fn(
      async (file: InstanceType<typeof MockTFile>, cb: (fm: Record<string, unknown>) => void) => {
        const content = files.get(file.path) ?? "";
        const fm = parseFm(content);
        cb(fm);
        const rest = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
        files.set(file.path, `---\n${serializeFm(fm)}\n---\n${rest}`);
      },
    ),
    trashFile: vi.fn(async (file: InstanceType<typeof MockTFile>) => {
      files.delete(file.path);
    }),
  };

  const metadataCache = {
    getFileCache: vi.fn((file: InstanceType<typeof MockTFile>) => {
      const content = files.get(file.path);
      if (!content) return null;
      return { frontmatter: parseFm(content) };
    }),
  };

  return { vault, fileManager, metadataCache, _files: files } as unknown as any;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTaskContent(overrides: {
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
  dependencies?: string[];
  subtaskIds?: string[];
  description?: string;
  prefix?: string;
  completed?: string;
} = {}): string {
  const {
    id = "taskid00000001",
    title = "Do thing",
    status = "todo",
    priority,
    completed,
    dependencies = [],
    subtaskIds = [],
    description,
    prefix = "Project: [[Alpha|Alpha]]",
  } = overrides;

  const fm = [
    "---",
    "pm-task: true",
    `id: "${id}"`,
    `title: "${title}"`,
    `projectId: "proj-1"`,
    `status: ${status}`,
    ...(priority ? [`priority: ${priority}`] : []),
    ...(completed ? [`completed: "${completed}"`] : []),
    `subtaskIds: [${subtaskIds.map((s) => `"${s}"`).join(", ")}]`,
    `dependencies: [${dependencies.map((d) => `"${d}"`).join(", ")}]`,
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "---",
  ].join("\n");

  const body = description ? `${prefix}\n\n${description}` : prefix;
  return `${fm}\n\n${body}\n`;
}

const TASK_PATH = "Projects/Alpha_tasks/do-thing.md";

const BASE_UPDATE: UpdateTaskData = {
  title: "Do thing",
  description: "",
  status: "todo",
  priority: Priority.None,
  type: TaskType.Task,
  progress: 0,
  start: null,
  due: null,
  tags: [] as string[],
  dependencies: [] as string[],
};

// ---------------------------------------------------------------------------
// readSubtaskIds
// ---------------------------------------------------------------------------

describe("ProjectTaskFile.readSubtaskIds", () => {
  it("returns [] when the file does not exist", async () => {
    const app = makeApp();
    expect(await new ProjectTaskFile(app, TASK_PATH).readSubtaskIds()).toEqual([]);
  });

  it("returns [] when subtaskIds is an empty array", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    expect(await new ProjectTaskFile(app, TASK_PATH).readSubtaskIds()).toEqual([]);
  });

  it("returns the list of subtask ids", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ subtaskIds: ["childid000000001", "childid000000002"] }) });
    expect(await new ProjectTaskFile(app, TASK_PATH).readSubtaskIds()).toEqual(["childid000000001", "childid000000002"]);
  });

  it("returns [] when subtaskIds is absent from frontmatter entirely", async () => {
    const content = ["---", 'id: "x"', "---", "", "Body"].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    expect(await new ProjectTaskFile(app, TASK_PATH).readSubtaskIds()).toEqual([]);
  });

  it("reflects ids added via addSubtaskLink", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await new ProjectTaskFile(app, TASK_PATH).addChild("childid000000001", "Child", "child");
    expect(await new ProjectTaskFile(app, TASK_PATH).readSubtaskIds()).toContain("childid000000001");
  });

  it("no longer includes an id removed via removeSubtaskLink", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ subtaskIds: ["childid000000001"] }),
    });
    await new ProjectTaskFile(app, TASK_PATH).removeChild("childid000000001", "child");
    expect(await new ProjectTaskFile(app, TASK_PATH).readSubtaskIds()).not.toContain("childid000000001");
  });
});

// ---------------------------------------------------------------------------
// readDescription
// ---------------------------------------------------------------------------

describe("ProjectTaskFile.readDescription", () => {
  it("returns empty string when the file does not exist", async () => {
    const app = makeApp();
    expect(await new ProjectTaskFile(app, TASK_PATH).readDescription()).toBe("");
  });

  it("returns empty string when there is no body", async () => {
    const content = ["---", 'id: "x"', "---"].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    expect(await new ProjectTaskFile(app, TASK_PATH).readDescription()).toBe("");
  });

  it("strips the 'Project: [[...]]' prefix line", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    expect(await new ProjectTaskFile(app, TASK_PATH).readDescription()).toBe("");
  });

  it("strips the 'Parent: [[...]]' prefix line", async () => {
    const content = makeTaskContent({ prefix: "Parent: [[parent-task|Parent task]]" });
    const app = makeApp({ [TASK_PATH]: content });
    expect(await new ProjectTaskFile(app, TASK_PATH).readDescription()).toBe("");
  });

  it("returns only the user description when a prefix is present", async () => {
    const content = makeTaskContent({ description: "Some notes here." });
    const app = makeApp({ [TASK_PATH]: content });
    expect(await new ProjectTaskFile(app, TASK_PATH).readDescription()).toBe("Some notes here.");
  });

  it("preserves multi-paragraph descriptions", async () => {
    const content = makeTaskContent({ description: "Para 1.\n\nPara 2." });
    const app = makeApp({ [TASK_PATH]: content });
    expect(await new ProjectTaskFile(app, TASK_PATH).readDescription()).toBe("Para 1.\n\nPara 2.");
  });

  it("returns the full body when there is no wiki-link prefix", async () => {
    const content = ["---", 'id: "x"', "---", "", "Just a note", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    expect(await new ProjectTaskFile(app, TASK_PATH).readDescription()).toBe("Just a note");
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("ProjectTaskFile.update", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp({ [TASK_PATH]: makeTaskContent() });
  });

  it("throws when the file does not exist", async () => {
    const app2 = makeApp();
    await expect(
      new ProjectTaskFile(app2, TASK_PATH).update(BASE_UPDATE),
    ).rejects.toThrow("File not found");
  });

  it("updates the title in frontmatter", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, title: "New title" });
    expect(app._files.get(TASK_PATH)).toContain('"New title"');
  });

  it("updates the status in frontmatter", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, status: "in-progress" });
    expect(app._files.get(TASK_PATH)).toContain('"in-progress"');
  });

  it("stamps a completion date when the status becomes done", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, status: "done" });
    expect(app._files.get(TASK_PATH)).toContain("completed:");
  });

  it("clears the completion date when a done task is reopened", async () => {
    const app2 = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done", completed: "2026-07-10T00:00:00.000Z" }),
    });
    await new ProjectTaskFile(app2, TASK_PATH).update({ ...BASE_UPDATE, status: "todo" });
    expect(app2._files.get(TASK_PATH)).not.toContain("completed:");
  });

  it("keeps the completion date of a task that is cancelled after being done", async () => {
    const app2 = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done", completed: "2026-07-10T00:00:00.000Z" }),
    });
    await new ProjectTaskFile(app2, TASK_PATH).update({ ...BASE_UPDATE, status: "cancelled" });
    expect(app2._files.get(TASK_PATH)).toContain("2026-07-10T00:00:00.000Z");
  });

  it("writes priority when provided", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, priority: Priority.High });
    expect(app._files.get(TASK_PATH)).toContain('"high"');
  });

  it("removes priority field when set to empty", async () => {
    const appWithPriority = makeApp({ [TASK_PATH]: makeTaskContent({ priority: "high" }) });
    await new ProjectTaskFile(appWithPriority, TASK_PATH).update({ ...BASE_UPDATE, priority: Priority.None });
    expect(appWithPriority._files.get(TASK_PATH)).not.toContain("priority");
  });

  it("writes start date when provided", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, start: day("2026-07-01") });
    expect(app._files.get(TASK_PATH)).toContain('"2026-07-01"');
  });

  it("omits start when there is none", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, start: null });
    expect(app._files.get(TASK_PATH)).not.toContain("start:");
  });

  it("writes due date when provided", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, due: day("2026-08-31") });
    expect(app._files.get(TASK_PATH)).toContain('"2026-08-31"');
  });

  it("omits due when there is none", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, due: null });
    expect(app._files.get(TASK_PATH)).not.toContain("due:");
  });

  it("writes progress when greater than 0", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, progress: 75 });
    expect(app._files.get(TASK_PATH)).toContain('"75"');
  });

  it("removes progress when 0", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, progress: 0 });
    expect(app._files.get(TASK_PATH)).not.toContain("progress:");
  });

  it("writes tags array when non-empty", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, tags: ["alpha", "beta"] });
    const content = app._files.get(TASK_PATH)!;
    expect(content).toContain('"alpha"');
    expect(content).toContain('"beta"');
  });

  it("removes tags field when empty", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, tags: [] });
    expect(app._files.get(TASK_PATH)).not.toContain("tags:");
  });

  it("updates dependencies list", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, dependencies: ["depid000000001"] });
    expect(app._files.get(TASK_PATH)).toContain('"depid000000001"');
  });

  it("updates the description body when it changes", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, description: "New description." });
    const content = app._files.get(TASK_PATH)!;
    expect(content).toContain("New description.");
  });

  it("preserves the wiki-link prefix when updating description", async () => {
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, description: "Updated notes." });
    const body = app._files.get(TASK_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body).toContain("Project: [[Alpha|Alpha]]");
    expect(body).toContain("Updated notes.");
  });

  it("does not call vault.modify for the body when description is unchanged", async () => {
    const appWithDesc = makeApp({ [TASK_PATH]: makeTaskContent({ description: "Same text." }) });
    await new ProjectTaskFile(appWithDesc, TASK_PATH).update({ ...BASE_UPDATE, description: "Same text." });
    expect(appWithDesc.vault.modify).not.toHaveBeenCalled();
  });

  it("clears the description body when set to empty", async () => {
    const appWithDesc = makeApp({ [TASK_PATH]: makeTaskContent({ description: "Old notes." }) });
    await new ProjectTaskFile(appWithDesc, TASK_PATH).update({ ...BASE_UPDATE, description: "" });
    expect(appWithDesc._files.get(TASK_PATH)).not.toContain("Old notes.");
  });

  it("updates the description when there is no wiki-link prefix in the current body", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "dependencies: []", "---", "", "Just a note", ""].join("\n");
    const appNoPrefix = makeApp({ [TASK_PATH]: content });
    await new ProjectTaskFile(appNoPrefix, TASK_PATH).update({ ...BASE_UPDATE, description: "New note" });
    const body = appNoPrefix._files.get(TASK_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body.trim()).toBe("New note");
  });

  it("clears the body entirely when there is neither a prefix nor a description", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "dependencies: []", "---", "", "Just a note", ""].join("\n");
    const appNoPrefix = makeApp({ [TASK_PATH]: content });
    await new ProjectTaskFile(appNoPrefix, TASK_PATH).update({ ...BASE_UPDATE, description: "" });
    const body = appNoPrefix._files.get(TASK_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// patchField
// ---------------------------------------------------------------------------

describe("ProjectTaskFile.patchField", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "done")).rejects.toThrow("File not found");
  });

  it("updates the status field", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "in-progress");
    expect(app._files.get(TASK_PATH)).toContain('"in-progress"');
  });

  it("sets a completed timestamp when status changes to done", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "done");
    expect(app._files.get(TASK_PATH)).toMatch(/completed: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/);
  });

  it("removes the completed date when status leaves done", async () => {
    const content = makeTaskContent({ status: "done" }).replace("subtaskIds", 'completed: "2026-06-01"\nsubtaskIds');
    const app = makeApp({ [TASK_PATH]: content });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "in-progress");
    expect(app._files.get(TASK_PATH)).not.toContain("completed");
  });

  it("keeps the completed date when status is set to cancelled", async () => {
    const content = makeTaskContent({ status: "done" }).replace("subtaskIds", 'completed: "2026-06-01"\nsubtaskIds');
    const app = makeApp({ [TASK_PATH]: content });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "cancelled");
    expect(app._files.get(TASK_PATH)).toContain("2026-06-01");
  });

  it("sets the priority field", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Priority, "critical");
    expect(app._files.get(TASK_PATH)).toContain('"critical"');
  });

  it("removes the priority field when set to empty", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ priority: "high" }) });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Priority, "");
    expect(app._files.get(TASK_PATH)).not.toContain("priority");
  });

  it("removes the status field when set to empty", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "");
    expect(app._files.get(TASK_PATH)).not.toContain("status:");
  });
});

// ---------------------------------------------------------------------------
// The parent's checklist line, kept in step with the task's status and title
// ---------------------------------------------------------------------------

const PROJECT_PATH = "Projects/Alpha.md";
const PARENT_TASK_PATH = "Projects/Alpha_tasks/parent.md";

/** A project file listing the task under `## Tasks`, its box in the given state. */
function projectListing(checked: boolean): string {
  return `---\nid: "proj1"\ntitle: "Alpha"\ntaskIds: ["taskid00000001"]\n---\n`
    + `## Tasks\n- [${checked ? "x" : " "}] [[do-thing|Do thing]]\n`;
}

/** A parent task file listing the task under `## Subtasks`, its box in the given state. */
function parentListing(checked: boolean): string {
  return `---\nid: "parent1"\ntitle: "Parent"\nsubtaskIds: ["taskid00000001"]\n---\n`
    + `Project: [[Alpha|Alpha]]\n\n## Subtasks\n- [${checked ? "x" : " "}] [[do-thing|Do thing]]\n`;
}

describe("ProjectTaskFile — the parent's checklist line", () => {
  it("ticks the project's box when the task is closed", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "done");
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("unticks it when the task reopens", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(true),
    });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "in-progress");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });

  it("leaves it unticked for a cancelled task — closed, but never finished", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "cancelled");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });

  it("ticks the parent task's box for a subtask", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PARENT_TASK_PATH]: parentListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "done");
    expect(app._files.get(PARENT_TASK_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("follows a full update too, not just a status patch", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, status: "done" });
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("relabels the project's entry when the title is edited in place", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Title, "Do it better");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do it better]]");
  });

  it("relabels a ticked entry without unticking it", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(true),
    });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Title, "Do it better");
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do it better]]");
  });

  it("relabels the parent task's entry for a renamed subtask", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PARENT_TASK_PATH]: parentListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).update({ ...BASE_UPDATE, title: "Do it better" });
    expect(app._files.get(PARENT_TASK_PATH)).toContain("- [ ] [[do-thing|Do it better]]");
  });

  it("does nothing when the parent file is missing", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await expect(new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "done")).resolves.toBeUndefined();
  });

  it("pushes a status changed elsewhere onto the entry", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("pushes a title changed elsewhere onto the entry", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ title: "Renamed elsewhere" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Renamed elsewhere]]");
  });

  it("adds no entry for a task the note doesn't list — mid-move, it belongs to neither", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: `---\nid: "proj1"\ntitle: "Alpha"\ntaskIds: []\n---\n## Tasks\n`,
    });
    await new ProjectTaskFile(app, TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).not.toContain("[[do-thing");
  });

  it("writes nothing when the entry already says so", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(true),
    });
    await new ProjectTaskFile(app, TASK_PATH).pushToListing();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("leaves a note that isn't a task alone", async () => {
    const app = makeApp({
      [TASK_PATH]: `---\nid: "t1"\ntitle: "Do thing"\nstatus: done\n---\nProject: [[Alpha|Alpha]]\n`,
      [PROJECT_PATH]: projectListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });

  it("does nothing for a task file with no Project:/Parent: link to follow", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).patchField(PatchableField.Status, "done");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });
});

// ---------------------------------------------------------------------------
// addDependency / removeDependency
// ---------------------------------------------------------------------------

describe("ProjectTaskFile.addDependency", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(new ProjectTaskFile(app, TASK_PATH).addDependency("depid")).rejects.toThrow("File not found");
  });

  it("adds the dependency id to the frontmatter", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await new ProjectTaskFile(app, TASK_PATH).addDependency("depid000000001");
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });

  it("is idempotent when the dependency already exists", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    await new ProjectTaskFile(app, TASK_PATH).addDependency("depid000000001");
    const matches = app._files.get(TASK_PATH)!.match(/depid000000001/g);
    expect(matches).toHaveLength(1);
  });

  it("adds the dependency when the dependencies field is absent from frontmatter", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    await new ProjectTaskFile(app, TASK_PATH).addDependency("depid000000001");
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });
});

describe("ProjectTaskFile.removeDependency", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(new ProjectTaskFile(app, TASK_PATH).removeDependency("depid")).rejects.toThrow("File not found");
  });

  it("removes the dependency id from the frontmatter", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    await new ProjectTaskFile(app, TASK_PATH).removeDependency("depid000000001");
    expect(app._files.get(TASK_PATH)).not.toContain("depid000000001");
  });

  it("is a no-op when the dependency is not present", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    await new ProjectTaskFile(app, TASK_PATH).removeDependency("otherid0000000");
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });

  it("is a no-op when the dependencies field is absent from frontmatter", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    await expect(new ProjectTaskFile(app, TASK_PATH).removeDependency("depid000000001")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addSubtaskLink / removeSubtaskLink
// ---------------------------------------------------------------------------

const PARENT_PATH = "Projects/Alpha_tasks/parent-task.md";

function makeParentContent(extra = ""): string {
  return [
    "---",
    "pm-task: true",
    'id: "parentid0000001"',
    'title: "Parent task"',
    'projectId: "proj-1"',
    'subtaskIds: []',
    'dependencies: []',
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "---",
    "",
    "Project: [[Alpha|Alpha]]",
    ...(extra ? ["", extra] : []),
    "",
  ].join("\n");
}

describe("ProjectTaskFile.addSubtaskLink", () => {
  it("adds the subtask id to subtaskIds in frontmatter", async () => {
    const app = makeApp({ [PARENT_PATH]: makeParentContent() });
    await new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    expect(app._files.get(PARENT_PATH)).toContain("subtaskid000001");
  });

  it("creates a ## Subtasks section when none exists", async () => {
    const app = makeApp({ [PARENT_PATH]: makeParentContent() });
    await new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    const content = app._files.get(PARENT_PATH)!;
    expect(content).toContain("## Subtasks");
    expect(content).toContain("[[sub-task|Sub task]]");
  });

  it("appends to an existing ## Subtasks section without creating a duplicate", async () => {
    const withSubtasks = makeParentContent("## Subtasks\n- [ ] [[existing-sub|Existing sub]]");
    const app = makeApp({ [PARENT_PATH]: withSubtasks });
    await new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "New sub", "new-sub");
    const content = app._files.get(PARENT_PATH)!;
    expect(content.match(/## Subtasks/g)).toHaveLength(1);
    expect(content).toContain("[[existing-sub|Existing sub]]");
    expect(content).toContain("[[new-sub|New sub]]");
  });

  it("inserts before a section that follows an existing ## Subtasks section", async () => {
    const withSubtasksAndMore = makeParentContent(
      "## Subtasks\n- [ ] [[existing-sub|Existing sub]]\n\n## Notes\nSome notes here.",
    );
    const app = makeApp({ [PARENT_PATH]: withSubtasksAndMore });
    await new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "New sub", "new-sub");
    const content = app._files.get(PARENT_PATH)!;
    expect(content.match(/## Subtasks/g)).toHaveLength(1);
    expect(content).toContain("[[new-sub|New sub]]");
    expect(content.indexOf("[[new-sub|New sub]]")).toBeLessThan(content.indexOf("## Notes"));
    expect(content).toContain("## Notes\nSome notes here.");
  });

  it("does nothing when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("skips the body update when the file has no frontmatter block after processing", async () => {
    // Defensive guard for a concurrent external write racing between processFrontMatter
    // and the follow-up read; simulate it by stubbing vault.read to return frontmatter-less
    // content on this call.
    const app = makeApp({ [PARENT_PATH]: makeParentContent() });
    (app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce("No frontmatter here");
    await expect(
      new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("adds the subtask id when subtaskIds is absent from frontmatter", async () => {
    const content = ["---", 'id: "parentid0000001"', 'projectId: "proj-1"', "---", "", "Project: [[Alpha|Alpha]]", ""].join("\n");
    const app = makeApp({ [PARENT_PATH]: content });
    await new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    expect(app._files.get(PARENT_PATH)).toContain("subtaskid000001");
  });

  it("starts a fresh ## Subtasks section without a blank-line separator when the body is empty", async () => {
    const content = ["---", "pm-task: true", 'id: "parentid0000001"', 'projectId: "proj-1"', "subtaskIds: []", "dependencies: []", "---", ""].join("\n");
    const app = makeApp({ [PARENT_PATH]: content });
    await new ProjectTaskFile(app, PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    const body = app._files.get(PARENT_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body).toBe("## Subtasks\n- [ ] [[sub-task|Sub task]]\n");
  });
});

describe("ProjectTaskFile.removeSubtaskLink", () => {
  it("removes the subtask id from subtaskIds in frontmatter", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]").replace(
      "subtaskIds: []",
      'subtaskIds: ["subtaskid000001"]',
    );
    const app = makeApp({ [PARENT_PATH]: content });
    await new ProjectTaskFile(app, PARENT_PATH).removeChild("subtaskid000001", "sub-task");
    expect(app._files.get(PARENT_PATH)).not.toContain("subtaskid000001");
  });

  it("removes the wiki-link from the body", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]");
    const app = makeApp({ [PARENT_PATH]: content });
    await new ProjectTaskFile(app, PARENT_PATH).removeChild("subtaskid000001", "sub-task");
    expect(app._files.get(PARENT_PATH)).not.toContain("[[sub-task|Sub task]]");
  });

  it("removes the ## Subtasks heading when the section becomes empty", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]");
    const app = makeApp({ [PARENT_PATH]: content });
    await new ProjectTaskFile(app, PARENT_PATH).removeChild("subtaskid000001", "sub-task");
    expect(app._files.get(PARENT_PATH)).not.toContain("## Subtasks");
  });

  it("keeps remaining subtask links when removing one of several", async () => {
    const content = makeParentContent(
      "## Subtasks\n- [ ] [[sub-a|Sub A]]\n- [ ] [[sub-b|Sub B]]",
    );
    const app = makeApp({ [PARENT_PATH]: content });
    await new ProjectTaskFile(app, PARENT_PATH).removeChild("subtaskid000001", "sub-a");
    const updated = app._files.get(PARENT_PATH)!;
    expect(updated).not.toContain("[[sub-a|Sub A]]");
    expect(updated).toContain("[[sub-b|Sub B]]");
    expect(updated).toContain("## Subtasks");
  });

  it("does nothing when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      new ProjectTaskFile(app, PARENT_PATH).removeChild("subtaskid000001", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("skips the body update when the file has no frontmatter block after processing", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]");
    const app = makeApp({ [PARENT_PATH]: content });
    (app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce("No frontmatter here");
    await expect(
      new ProjectTaskFile(app, PARENT_PATH).removeChild("subtaskid000001", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the subtaskIds field is absent from frontmatter", async () => {
    const content = ["---", 'id: "parentid0000001"', 'projectId: "proj-1"', "---", "", "## Subtasks\n- [ ] [[sub-task|Sub task]]", ""].join("\n");
    const app = makeApp({ [PARENT_PATH]: content });
    await expect(
      new ProjectTaskFile(app, PARENT_PATH).removeChild("subtaskid000001", "sub-task"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ProjectTaskFile.create (static)
// ---------------------------------------------------------------------------

describe("ProjectTaskFile.create", () => {
  const BASE_OPTS: CreateTaskOpts = {
    projectId: "proj-1",
    projectFilePath: "Projects/Alpha.md",
    projectTitle: "Alpha",
    title: "My task",
    description: "",
    status: "todo",
    priority: Priority.None,
    type: TaskType.Task,
    progress: 0,
    start: null,
    due: null,
    tags: [] as string[],
    dependencies: [] as string[],
  };

  it("creates the task file in <project>_tasks/", async () => {
    const app = makeApp();
    await ProjectTaskFile.create(app, BASE_OPTS);
    expect(app.vault.create).toHaveBeenCalledOnce();
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/Alpha_tasks/my-task.md");
  });

  it("lists a root task on its project note", async () => {
    const project = `---\nid: "proj-1"\ntitle: "Alpha"\ntaskIds: []\n---\n## Tasks\n`;
    const app = makeApp({ "Projects/Alpha.md": project });
    await ProjectTaskFile.create(app, BASE_OPTS);
    expect(app._files.get("Projects/Alpha.md")).toContain("- [ ] [[my-task|My task]]");
  });

  it("lists a root task created done with its box ticked", async () => {
    const project = `---\nid: "proj-1"\ntitle: "Alpha"\ntaskIds: []\n---\n## Tasks\n`;
    const app = makeApp({ "Projects/Alpha.md": project });
    await ProjectTaskFile.create(app, { ...BASE_OPTS, status: "done" });
    expect(app._files.get("Projects/Alpha.md")).toContain("- [x] [[my-task|My task]]");
  });

  it("succeeds even when the tasks folder already exists (createFolder rejects)", async () => {
    const app = makeApp();
    (app.vault.createFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Folder already exists."),
    );
    await expect(ProjectTaskFile.create(app, BASE_OPTS)).resolves.toBeDefined();
  });

  it("includes priority, start, due, and progress in frontmatter when given", async () => {
    const app = makeApp();
    await ProjectTaskFile.create(app, {
      ...BASE_OPTS,
      priority: Priority.High,
      start: day("2026-07-01"),
      due: day("2026-07-15"),
      progress: 40,
    });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain("priority: high");
    expect(content).toContain('start: "2026-07-01"');
    expect(content).toContain('due: "2026-07-15"');
    expect(content).toContain("progress: 40");
  });

  it("falls back to the filename 'task' when the title has no sluggable characters", async () => {
    const app = makeApp();
    await ProjectTaskFile.create(app, { ...BASE_OPTS, title: "!!!" });
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/Alpha_tasks/task.md");
  });

  it("returns a 16-char hex id", async () => {
    const app = makeApp();
    const { id } = await ProjectTaskFile.create(app, BASE_OPTS);
    expect(id).toMatch(/^[a-z0-9]{16}$/);
  });

  it("returns a ProjectTaskFile pointing to the new file", async () => {
    const app = makeApp();
    const { file } = await ProjectTaskFile.create(app, BASE_OPTS);
    expect(file).toBeInstanceOf(ProjectTaskFile);
    expect(file.filePath).toBe("Projects/Alpha_tasks/my-task.md");
  });

  it("sets the project wiki-link prefix in the body for top-level tasks", async () => {
    const app = makeApp();
    await ProjectTaskFile.create(app, BASE_OPTS);
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const body = content.replace(/^---[\s\S]*?\n---\n/, "");
    expect(body.trim()).toBe("Project: [[Alpha|Alpha]]");
  });

  it("sets the parent wiki-link prefix in the body for subtasks", async () => {
    const parentContent = makeTaskContent({ id: "parentid0000001", title: "Parent" });
    const app = makeApp({ "Projects/Alpha_tasks/parent.md": parentContent });
    await ProjectTaskFile.create(app, {
      ...BASE_OPTS,
      parentTask: new Task({
        id: "parentid0000001",
        title: "Parent",
        filePath: "Projects/Alpha_tasks/parent.md",
        projectId: "proj-1",
        status: "todo",
        dependencies: [],
        subtasks: [],
      }),
    });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const body = content.replace(/^---[\s\S]*?\n---\n/, "");
    expect(body.trim()).toBe("Parent: [[parent|Parent]]");
  });

  it("includes dependencies and tags in frontmatter when given", async () => {
    const app = makeApp();
    await ProjectTaskFile.create(app, {
      ...BASE_OPTS,
      dependencies: ["depid000000001"],
      tags: ["urgent", "backend"],
    });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('dependencies: ["depid000000001"]');
    expect(content).toContain('tags: ["urgent", "backend"]');
  });

  it("includes parentId in frontmatter when a parent task is given", async () => {
    const parentContent = makeTaskContent({ id: "parentid0000001", title: "Parent" });
    const app = makeApp({ "Projects/Alpha_tasks/parent.md": parentContent });
    await ProjectTaskFile.create(app, {
      ...BASE_OPTS,
      parentTask: new Task({
        id: "parentid0000001",
        title: "Parent",
        filePath: "Projects/Alpha_tasks/parent.md",
        projectId: "proj-1",
        status: "todo",
        dependencies: [],
        subtasks: [],
      }),
    });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('parentId: "parentid0000001"');
  });

  it("appends a counter suffix when the slug filename already exists", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/my-task.md": "existing" });
    await ProjectTaskFile.create(app, BASE_OPTS);
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/Alpha_tasks/my-task-2.md");
  });

  it("appends the user description after the prefix when provided", async () => {
    const app = makeApp();
    await ProjectTaskFile.create(app, { ...BASE_OPTS, description: "Details here." });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const body = content.replace(/^---[\s\S]*?\n---\n/, "");
    expect(body.trim()).toBe("Project: [[Alpha|Alpha]]\n\nDetails here.");
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("ProjectTaskFile.delete", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001"),
    ).rejects.toThrow("File not found");
  });

  it("deletes the task file", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001");
    expect(app._files.has(TASK_PATH)).toBe(false);
  });

  it("removes the task id from dependent tasks' dependencies", async () => {
    const depContent = makeTaskContent({ id: "dependentid0001", dependencies: ["taskid00000001"] });
    const DEP_PATH = "Projects/Alpha_tasks/dep.md";
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [DEP_PATH]: depContent,
    });
    const dep = new Task({ id: "dependentid0001", filePath: DEP_PATH, projectId: "proj-1", title: "Dep", status: "todo", dependencies: ["taskid00000001"], subtasks: [] });
    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001", [dep]);
    expect(app._files.get(DEP_PATH)).not.toContain("taskid00000001");
  });

  it("handles a dependent whose frontmatter dependencies field is absent", async () => {
    const DEP_PATH = "Projects/Alpha_tasks/dep.md";
    const depContent = ["---", 'id: "dependentid0001"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [DEP_PATH]: depContent,
    });
    const dep = new Task({ id: "dependentid0001", filePath: DEP_PATH, projectId: "proj-1", title: "Dep", status: "todo", dependencies: ["taskid00000001"], subtasks: [] });
    await expect(new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001", [dep])).resolves.toBeUndefined();
  });

  it("recursively deletes subtask files", async () => {
    const CHILD_PATH = "Projects/Alpha_tasks/child.md";
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [CHILD_PATH]: makeTaskContent({ id: "childid000000001" }),
    });
    const child = new Task({ id: "childid000000001", filePath: CHILD_PATH, parentId: "taskid00000001", projectId: "proj-1", title: "Child", status: "todo", dependencies: [], subtasks: [] });
    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001", [child]);
    expect(app._files.has(CHILD_PATH)).toBe(false);
    expect(app._files.has(TASK_PATH)).toBe(false);
  });

  it("unlinks a root task from the project note that lists it", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001");
    const project = app._files.get(PROJECT_PATH) as string;
    expect(project).not.toContain("[[do-thing|Do thing]]");
    expect(project).not.toContain("taskid00000001");
  });

  it("leaves the project note alone for a subtask, listed by its parent instead", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001");
    expect(app._files.get(PROJECT_PATH)).toContain("[[do-thing|Do thing]]");
  });

  it("unlinks a subtask from its parent task with no parentTask named, going by the body link", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PARENT_TASK_PATH]: parentListing(false),
    });
    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001");
    const parent = app._files.get(PARENT_TASK_PATH) as string;
    expect(parent).not.toContain("[[do-thing|Do thing]]");
    expect(parent).not.toContain("taskid00000001");
  });

  it("rewrites only the listing that survives — not the parent being trashed alongside", async () => {
    const CHILD_PATH = "Projects/Alpha_tasks/child.md";
    const app = makeApp({
      [PROJECT_PATH]: projectListing(false),
      [TASK_PATH]: makeTaskContent({ subtaskIds: ["childid000000001"] })
        + "\n## Subtasks\n- [ ] [[child|Child]]\n",
      [CHILD_PATH]: makeTaskContent({ id: "childid000000001", prefix: "Parent: [[do-thing|Do thing]]" }),
    });
    const child = new Task({ id: "childid000000001", filePath: CHILD_PATH, parentId: "taskid00000001", projectId: "proj-1", title: "Child", status: "todo", dependencies: [], subtasks: [] });

    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001", [child]);

    // The body edit goes through `vault.process` — see `removeChildEntry`.
    const written = (app.vault.process.mock.calls as [{ path: string }][]).map((c) => c[0].path);
    expect(written).toEqual([PROJECT_PATH]);
  });

  it("unlinks the task from its parent when parentTask is given", async () => {
    const parentContent = makeParentContent("## Subtasks\n- [ ] [[do-thing|Do thing]]");
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [PARENT_PATH]: parentContent,
    });
    const parent = new Task({ id: "parentid0000001", filePath: PARENT_PATH, projectId: "proj-1", title: "Parent", status: "todo", dependencies: [], subtasks: [] });
    await new ProjectTaskFile(app, TASK_PATH).delete("taskid00000001", [], parent);
    expect(app._files.get(PARENT_PATH)).not.toContain("[[do-thing|Do thing]]");
  });
});
