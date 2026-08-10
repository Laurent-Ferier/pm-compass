// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    /** As Obsidian fills it in: the name without folders or extension. Code falling back
     *  to it when frontmatter is missing reads it, so a stub without one hides the bug. */
    readonly basename: string;
    constructor(public path: string) {
      this.basename = path.split("/").pop()!.replace(/\.md$/, "");
    }
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

import { ProjectTaskIO, pruneDependents } from "./project-task-io";
import type { CreateTaskOpts, UpdateTaskData } from "./project-task-io";
import { Priority } from "../base-task";
import { TaskType, type ProjectTaskFields } from "../project/project-task";
import { day } from "../__testing__/dates";
import { asApp } from "../__testing__/as-app";
import { newTask, notesOf, setField } from "../__testing__/notes";

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
      } else if (val.startsWith("{") && val.endsWith("}")) {
        // The flow mapping Obsidian writes a nested value as — `cardLayout` is the one.
        fm[kv[1]] = JSON.parse(val.replace(/(\w+):/g, '"$1":')) as unknown;
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
        if (v && typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
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

  return asApp({ vault, fileManager, metadataCache, _files: files });
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
// readDescription
// ---------------------------------------------------------------------------

describe("ProjectTaskIO.readDescription", () => {
  it("returns empty string when the file does not exist", async () => {
    const app = makeApp();
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readDescription()).toBe("");
  });

  it("returns empty string when there is no body", async () => {
    const content = ["---", 'id: "x"', "---"].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readDescription()).toBe("");
  });

  it("strips the 'Project: [[...]]' prefix line", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readDescription()).toBe("");
  });

  it("strips the 'Parent: [[...]]' prefix line", async () => {
    const content = makeTaskContent({ prefix: "Parent: [[parent-task|Parent task]]" });
    const app = makeApp({ [TASK_PATH]: content });
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readDescription()).toBe("");
  });

  it("returns only the user description when a prefix is present", async () => {
    const content = makeTaskContent({ description: "Some notes here." });
    const app = makeApp({ [TASK_PATH]: content });
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readDescription()).toBe("Some notes here.");
  });

  it("preserves multi-paragraph descriptions", async () => {
    const content = makeTaskContent({ description: "Para 1.\n\nPara 2." });
    const app = makeApp({ [TASK_PATH]: content });
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readDescription()).toBe("Para 1.\n\nPara 2.");
  });

  it("returns the full body when there is no wiki-link prefix", async () => {
    const content = ["---", 'id: "x"', "---", "", "Just a note", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readDescription()).toBe("Just a note");
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("ProjectTaskIO.update", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp({ [TASK_PATH]: makeTaskContent() });
  });

  it("throws when the file does not exist", async () => {
    const app2 = makeApp();
    await expect(
      notesOf(app2).projects.taskCache.file(TASK_PATH).update(BASE_UPDATE),
    ).rejects.toThrow("File not found");
  });

  it("updates the title in frontmatter", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, title: "New title" });
    expect(app._files.get(TASK_PATH)).toContain('"New title"');
  });

  it("updates the status in frontmatter", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, status: "in-progress" });
    expect(app._files.get(TASK_PATH)).toContain('"in-progress"');
  });

  it("stamps a completion date when the status becomes done", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, status: "done" });
    expect(app._files.get(TASK_PATH)).toContain("completed:");
  });

  it("clears the completion date when a done task is reopened", async () => {
    const app2 = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done", completed: "2026-07-10T00:00:00.000Z" }),
    });
    await notesOf(app2).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, status: "todo" });
    expect(app2._files.get(TASK_PATH)).not.toContain("completed:");
  });

  it("keeps the completion date of a task that is cancelled after being done", async () => {
    const app2 = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done", completed: "2026-07-10T00:00:00.000Z" }),
    });
    await notesOf(app2).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, status: "cancelled" });
    expect(app2._files.get(TASK_PATH)).toContain("2026-07-10T00:00:00.000Z");
  });

  it("writes priority when provided", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, priority: Priority.High });
    expect(app._files.get(TASK_PATH)).toContain('"high"');
  });

  it("removes priority field when set to empty", async () => {
    const appWithPriority = makeApp({ [TASK_PATH]: makeTaskContent({ priority: "high" }) });
    await notesOf(appWithPriority).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, priority: Priority.None });
    expect(appWithPriority._files.get(TASK_PATH)).not.toContain("priority");
  });

  it("writes start date when provided", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, start: day("2026-07-01") });
    expect(app._files.get(TASK_PATH)).toContain('"2026-07-01"');
  });

  it("omits start when there is none", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, start: null });
    expect(app._files.get(TASK_PATH)).not.toContain("start:");
  });

  it("writes due date when provided", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, due: day("2026-08-31") });
    expect(app._files.get(TASK_PATH)).toContain('"2026-08-31"');
  });

  it("omits due when there is none", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, due: null });
    expect(app._files.get(TASK_PATH)).not.toContain("due:");
  });

  it("writes progress when greater than 0", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, progress: 75 });
    expect(app._files.get(TASK_PATH)).toContain('"75"');
  });

  it("removes progress when 0", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, progress: 0 });
    expect(app._files.get(TASK_PATH)).not.toContain("progress:");
  });

  it("writes the type", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, type: TaskType.Milestone });
    expect(app._files.get(TASK_PATH)).toContain('"milestone"');
  });

  // Cleared rather than written empty, as setting the field one at a time does: a field the
  // note shouldn't carry is one it shouldn't carry blank either.
  it("removes the type when there is none", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, type: "" });
    expect(app._files.get(TASK_PATH)).not.toContain("type:");
  });

  // An empty title is no title to write: the dialog refuses one, and the field going blank
  // would leave the note with nothing to be called.
  it("keeps the title it had when handed an empty one", async () => {
    const named = makeApp({ [TASK_PATH]: makeTaskContent({ title: "Already named" }) });
    await notesOf(named).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, title: "" });
    expect(named._files.get(TASK_PATH)).toContain('title: "Already named"');
  });

  it("writes tags array when non-empty", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, tags: ["alpha", "beta"] });
    const content = app._files.get(TASK_PATH)!;
    expect(content).toContain('"alpha"');
    expect(content).toContain('"beta"');
  });

  it("removes tags field when empty", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, tags: [] });
    expect(app._files.get(TASK_PATH)).not.toContain("tags:");
  });

  it("updates dependencies list", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, dependencies: ["depid000000001"] });
    expect(app._files.get(TASK_PATH)).toContain('"depid000000001"');
  });

  it("updates the description body when it changes", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, description: "New description." });
    const content = app._files.get(TASK_PATH)!;
    expect(content).toContain("New description.");
  });

  it("preserves the wiki-link prefix when updating description", async () => {
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, description: "Updated notes." });
    const body = app._files.get(TASK_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body).toContain("Project: [[Alpha|Alpha]]");
    expect(body).toContain("Updated notes.");
  });

  it("does not call vault.modify for the body when description is unchanged", async () => {
    const appWithDesc = makeApp({ [TASK_PATH]: makeTaskContent({ description: "Same text." }) });
    await notesOf(appWithDesc).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, description: "Same text." });
    expect(appWithDesc.vault.modify).not.toHaveBeenCalled();
  });

  it("clears the description body when set to empty", async () => {
    const appWithDesc = makeApp({ [TASK_PATH]: makeTaskContent({ description: "Old notes." }) });
    await notesOf(appWithDesc).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, description: "" });
    expect(appWithDesc._files.get(TASK_PATH)).not.toContain("Old notes.");
  });

  it("updates the description when there is no wiki-link prefix in the current body", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "dependencies: []", "---", "", "Just a note", ""].join("\n");
    const appNoPrefix = makeApp({ [TASK_PATH]: content });
    await notesOf(appNoPrefix).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, description: "New note" });
    const body = appNoPrefix._files.get(TASK_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body.trim()).toBe("New note");
  });

  it("clears the body entirely when there is neither a prefix nor a description", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "dependencies: []", "---", "", "Just a note", ""].join("\n");
    const appNoPrefix = makeApp({ [TASK_PATH]: content });
    await notesOf(appNoPrefix).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, description: "" });
    const body = appNoPrefix._files.get(TASK_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// patchField
// ---------------------------------------------------------------------------

describe("ProjectTaskIO.patchField", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "done")).rejects.toThrow("File not found");
  });

  it("updates the status field", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "in-progress");
    expect(app._files.get(TASK_PATH)).toContain('"in-progress"');
  });

  it("sets a completed timestamp when status changes to done", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "done");
    expect(app._files.get(TASK_PATH)).toMatch(/completed: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/);
  });

  it("removes the completed date when status leaves done", async () => {
    const content = makeTaskContent({ status: "done" }).replace("subtaskIds", 'completed: "2026-06-01"\nsubtaskIds');
    const app = makeApp({ [TASK_PATH]: content });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "in-progress");
    expect(app._files.get(TASK_PATH)).not.toContain("completed");
  });

  it("keeps the completed date when status is set to cancelled", async () => {
    const content = makeTaskContent({ status: "done" }).replace("subtaskIds", 'completed: "2026-06-01"\nsubtaskIds');
    const app = makeApp({ [TASK_PATH]: content });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "cancelled");
    expect(app._files.get(TASK_PATH)).toContain("2026-06-01");
  });

  it("sets the priority field", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "priority", Priority.Critical);
    expect(app._files.get(TASK_PATH)).toContain('"critical"');
  });

  it("removes the priority field when set to empty", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ priority: "high" }) });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "priority", undefined);
    expect(app._files.get(TASK_PATH)).not.toContain("priority");
  });

  it("removes the status field when set to empty", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "");
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

describe("ProjectTaskIO — the parent's checklist line", () => {
  it("ticks the project's box when the task is closed", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "done");
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("unticks it when the task reopens", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(true),
    });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "in-progress");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });

  it("leaves it unticked for a cancelled task — closed, but never finished", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "cancelled");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });

  it("ticks the parent task's box for a subtask", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PARENT_TASK_PATH]: parentListing(false),
    });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "done");
    expect(app._files.get(PARENT_TASK_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("follows a full update too, not just a status patch", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, status: "done" });
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("relabels the project's entry when the title is edited in place", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "title", "Do it better");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do it better]]");
  });

  it("relabels a ticked entry without unticking it", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(true),
    });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "title", "Do it better");
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do it better]]");
  });

  it("relabels the parent task's entry for a renamed subtask", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PARENT_TASK_PATH]: parentListing(false),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).update({ ...BASE_UPDATE, title: "Do it better" });
    expect(app._files.get(PARENT_TASK_PATH)).toContain("- [ ] [[do-thing|Do it better]]");
  });

  it("does nothing when the parent file is missing", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await expect(setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "done")).resolves.toBeUndefined();
  });

  it("pushes a status changed elsewhere onto the entry", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toContain("- [x] [[do-thing|Do thing]]");
  });

  it("pushes a title changed elsewhere onto the entry", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ title: "Renamed elsewhere" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Renamed elsewhere]]");
  });

  it("adds no entry for a task the note doesn't list — mid-move, it belongs to neither", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: `---\nid: "proj1"\ntitle: "Alpha"\ntaskIds: []\n---\n## Tasks\n`,
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).not.toContain("[[do-thing");
  });

  it("writes nothing when the entry already says so", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ status: "done" }),
      [PROJECT_PATH]: projectListing(true),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).pushToListing();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("leaves a note that isn't a task alone", async () => {
    const app = makeApp({
      [TASK_PATH]: `---\nid: "t1"\ntitle: "Do thing"\nstatus: done\n---\nProject: [[Alpha|Alpha]]\n`,
      [PROJECT_PATH]: projectListing(false),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });

  it("does nothing for a task file with no Project:/Parent: link to follow", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "done");
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });
});

// ---------------------------------------------------------------------------
// what a task waits on — set on the task, or patched onto the file
// ---------------------------------------------------------------------------

/** A task whose note is that app's, as the folder having been read leaves it — which is
 *  where its fields are kept, and so what a field is set on. */
function taskOver(app: ReturnType<typeof makeApp>, overrides: Partial<ProjectTaskFields> = {}) {
  return notesOf(app).projects.taskCache.make({
    id: "taskid00000001", title: "Do thing", projectId: "p1", status: "todo", dependencies: [],
    filePath: TASK_PATH, ...overrides,
  });
}

/** A task over the usual path, waiting on those. */
function taskWaitingOn(app: ReturnType<typeof makeApp>, dependencies: string[]) {
  return taskOver(app, { dependencies });
}

describe("ProjectTask.addDependency", () => {
  it("throws when the file does not exist", async () => {
    const task = taskWaitingOn(makeApp(), []);
    task.addDependency("depid");
    await expect(task.flush()).rejects.toThrow("File not found");
  });

  it("adds the dependency id to the frontmatter", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const task = taskWaitingOn(app, []);
    task.addDependency("depid000000001");
    await task.flush();
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });

  it("is idempotent when the dependency already exists", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    const task = taskWaitingOn(app, ["depid000000001"]);
    task.addDependency("depid000000001");
    await task.flush();
    const matches = app._files.get(TASK_PATH)!.match(/depid000000001/g);
    expect(matches).toHaveLength(1);
  });

  it("adds the dependency when the dependencies field is absent from frontmatter", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    const task = taskWaitingOn(app, []);
    task.addDependency("depid000000001");
    await task.flush();
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });
});

describe("ProjectTask.removeDependency", () => {
  it("throws when the file does not exist", async () => {
    const task = taskWaitingOn(makeApp(), ["depid"]);
    task.removeDependency("depid");
    await expect(task.flush()).rejects.toThrow("File not found");
  });

  it("removes the dependency id from the frontmatter", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    const task = taskWaitingOn(app, ["depid000000001"]);
    task.removeDependency("depid000000001");
    await task.flush();
    expect(app._files.get(TASK_PATH)).not.toContain("depid000000001");
  });

  it("is a no-op when the dependency is not present", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    const task = taskWaitingOn(app, ["depid000000001"]);
    task.removeDependency("otherid0000000");
    await task.flush();
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });

  it("writes nothing when the task waits on nothing", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    const task = taskWaitingOn(app, []);
    task.removeDependency("depid000000001");
    await expect(task.flush()).resolves.toBeUndefined();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });
});

describe("ProjectTaskIO.addDependency", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(notesOf(app).projects.taskCache.file(TASK_PATH).addDependency("depid")).rejects.toThrow("File not found");
  });

  it("adds the dependency id to the frontmatter, whatever a reading of it says", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["otherid0000000"] }) });
    await notesOf(app).projects.taskCache.file(TASK_PATH).addDependency("depid000000001");
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
    expect(app._files.get(TASK_PATH)).toContain("otherid0000000");
  });

  it("is idempotent when the dependency already exists", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    await notesOf(app).projects.taskCache.file(TASK_PATH).addDependency("depid000000001");
    const matches = app._files.get(TASK_PATH)!.match(/depid000000001/g);
    expect(matches).toHaveLength(1);
  });

  it("adds the dependency when the dependencies field is absent from frontmatter", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    await notesOf(app).projects.taskCache.file(TASK_PATH).addDependency("depid000000001");
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });
});

describe("ProjectTaskIO.removeDependency", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(notesOf(app).projects.taskCache.file(TASK_PATH).removeDependency("depid")).rejects.toThrow("File not found");
  });

  it("removes the dependency id from the frontmatter", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    await notesOf(app).projects.taskCache.file(TASK_PATH).removeDependency("depid000000001");
    expect(app._files.get(TASK_PATH)).not.toContain("depid000000001");
  });

  it("is a no-op when the dependency is not present", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ dependencies: ["depid000000001"] }) });
    await notesOf(app).projects.taskCache.file(TASK_PATH).removeDependency("otherid0000000");
    expect(app._files.get(TASK_PATH)).toContain("depid000000001");
  });

  it("is a no-op when the dependencies field is absent from frontmatter", async () => {
    const content = ["---", 'id: "x"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({ [TASK_PATH]: content });
    await expect(notesOf(app).projects.taskCache.file(TASK_PATH).removeDependency("depid000000001")).resolves.toBeUndefined();
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

describe("ProjectTaskIO.addSubtaskLink", () => {
  it("adds the subtask id to subtaskIds in frontmatter", async () => {
    const app = makeApp({ [PARENT_PATH]: makeParentContent() });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    expect(app._files.get(PARENT_PATH)).toContain("subtaskid000001");
  });

  it("creates a ## Subtasks section when none exists", async () => {
    const app = makeApp({ [PARENT_PATH]: makeParentContent() });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    const content = app._files.get(PARENT_PATH)!;
    expect(content).toContain("## Subtasks");
    expect(content).toContain("[[sub-task|Sub task]]");
  });

  it("appends to an existing ## Subtasks section without creating a duplicate", async () => {
    const withSubtasks = makeParentContent("## Subtasks\n- [ ] [[existing-sub|Existing sub]]");
    const app = makeApp({ [PARENT_PATH]: withSubtasks });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "New sub", "new-sub");
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
    await notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "New sub", "new-sub");
    const content = app._files.get(PARENT_PATH)!;
    expect(content.match(/## Subtasks/g)).toHaveLength(1);
    expect(content).toContain("[[new-sub|New sub]]");
    expect(content.indexOf("[[new-sub|New sub]]")).toBeLessThan(content.indexOf("## Notes"));
    expect(content).toContain("## Notes\nSome notes here.");
  });

  it("does nothing when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("skips the body update when the file has no frontmatter block after processing", async () => {
    // Defensive guard for a concurrent external write racing between processFrontMatter
    // and the follow-up read; simulate it by stubbing vault.read to return frontmatter-less
    // content on this call.
    const app = makeApp({ [PARENT_PATH]: makeParentContent() });
    (app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce("No frontmatter here");
    await expect(
      notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("adds the subtask id when subtaskIds is absent from frontmatter", async () => {
    const content = ["---", 'id: "parentid0000001"', 'projectId: "proj-1"', "---", "", "Project: [[Alpha|Alpha]]", ""].join("\n");
    const app = makeApp({ [PARENT_PATH]: content });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    expect(app._files.get(PARENT_PATH)).toContain("subtaskid000001");
  });

  it("starts a fresh ## Subtasks section without a blank-line separator when the body is empty", async () => {
    const content = ["---", "pm-task: true", 'id: "parentid0000001"', 'projectId: "proj-1"', "subtaskIds: []", "dependencies: []", "---", ""].join("\n");
    const app = makeApp({ [PARENT_PATH]: content });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).addChild("subtaskid000001", "Sub task", "sub-task");
    const body = app._files.get(PARENT_PATH)!.replace(/^---[\s\S]*?\n---\n?/, "");
    expect(body).toBe("## Subtasks\n- [ ] [[sub-task|Sub task]]\n");
  });
});

describe("ProjectTaskIO.removeSubtaskLink", () => {
  it("removes the subtask id from subtaskIds in frontmatter", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]").replace(
      "subtaskIds: []",
      'subtaskIds: ["subtaskid000001"]',
    );
    const app = makeApp({ [PARENT_PATH]: content });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).removeChild("subtaskid000001", "sub-task");
    expect(app._files.get(PARENT_PATH)).not.toContain("subtaskid000001");
  });

  it("removes the wiki-link from the body", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]");
    const app = makeApp({ [PARENT_PATH]: content });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).removeChild("subtaskid000001", "sub-task");
    expect(app._files.get(PARENT_PATH)).not.toContain("[[sub-task|Sub task]]");
  });

  it("removes the ## Subtasks heading when the section becomes empty", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]");
    const app = makeApp({ [PARENT_PATH]: content });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).removeChild("subtaskid000001", "sub-task");
    expect(app._files.get(PARENT_PATH)).not.toContain("## Subtasks");
  });

  it("keeps remaining subtask links when removing one of several", async () => {
    const content = makeParentContent(
      "## Subtasks\n- [ ] [[sub-a|Sub A]]\n- [ ] [[sub-b|Sub B]]",
    );
    const app = makeApp({ [PARENT_PATH]: content });
    await notesOf(app).projects.taskCache.file(PARENT_PATH).removeChild("subtaskid000001", "sub-a");
    const updated = app._files.get(PARENT_PATH)!;
    expect(updated).not.toContain("[[sub-a|Sub A]]");
    expect(updated).toContain("[[sub-b|Sub B]]");
    expect(updated).toContain("## Subtasks");
  });

  it("does nothing when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      notesOf(app).projects.taskCache.file(PARENT_PATH).removeChild("subtaskid000001", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("skips the body update when the file has no frontmatter block after processing", async () => {
    const content = makeParentContent("## Subtasks\n- [ ] [[sub-task|Sub task]]");
    const app = makeApp({ [PARENT_PATH]: content });
    (app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce("No frontmatter here");
    await expect(
      notesOf(app).projects.taskCache.file(PARENT_PATH).removeChild("subtaskid000001", "sub-task"),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the subtaskIds field is absent from frontmatter", async () => {
    const content = ["---", 'id: "parentid0000001"', 'projectId: "proj-1"', "---", "", "## Subtasks\n- [ ] [[sub-task|Sub task]]", ""].join("\n");
    const app = makeApp({ [PARENT_PATH]: content });
    await expect(
      notesOf(app).projects.taskCache.file(PARENT_PATH).removeChild("subtaskid000001", "sub-task"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ProjectTaskIO.create (static)
// ---------------------------------------------------------------------------

describe("ProjectTaskIO.create", () => {
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
    await ProjectTaskIO.create(notesOf(app), BASE_OPTS);
    expect(app.vault.create).toHaveBeenCalledOnce();
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/Alpha_tasks/my-task.md");
  });

  it("lists a root task on its project note", async () => {
    const project = `---\nid: "proj-1"\ntitle: "Alpha"\ntaskIds: []\n---\n## Tasks\n`;
    const app = makeApp({ "Projects/Alpha.md": project });
    await ProjectTaskIO.create(notesOf(app), BASE_OPTS);
    expect(app._files.get("Projects/Alpha.md")).toContain("- [ ] [[my-task|My task]]");
  });

  it("lists a root task created done with its box ticked", async () => {
    const project = `---\nid: "proj-1"\ntitle: "Alpha"\ntaskIds: []\n---\n## Tasks\n`;
    const app = makeApp({ "Projects/Alpha.md": project });
    await ProjectTaskIO.create(notesOf(app), { ...BASE_OPTS, status: "done" });
    expect(app._files.get("Projects/Alpha.md")).toContain("- [x] [[my-task|My task]]");
  });

  it("succeeds even when the tasks folder already exists (createFolder rejects)", async () => {
    const app = makeApp();
    (app.vault.createFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Folder already exists."),
    );
    await expect(ProjectTaskIO.create(notesOf(app), BASE_OPTS)).resolves.toBeDefined();
  });

  it("includes priority, start, due, and progress in frontmatter when given", async () => {
    const app = makeApp();
    await ProjectTaskIO.create(notesOf(app), {
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
    await ProjectTaskIO.create(notesOf(app), { ...BASE_OPTS, title: "!!!" });
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/Alpha_tasks/task.md");
  });

  it("returns a 16-char hex id", async () => {
    const app = makeApp();
    const task = await ProjectTaskIO.create(notesOf(app), BASE_OPTS);
    expect(task.id).toMatch(/^[a-z0-9]{16}$/);
  });

  // The task it hands back is the cache's own, reading as the note was written.
  it("returns the task for the new note, reading as it was written", async () => {
    const app = makeApp();
    const task = await ProjectTaskIO.create(notesOf(app), BASE_OPTS);
    expect(task.filePath).toBe("Projects/Alpha_tasks/my-task.md");
    expect(task.persistence).toBeInstanceOf(ProjectTaskIO);
    expect(task).toMatchObject({ title: BASE_OPTS.title, projectId: BASE_OPTS.projectId });
  });

  it("sets the project wiki-link prefix in the body for top-level tasks", async () => {
    const app = makeApp();
    await ProjectTaskIO.create(notesOf(app), BASE_OPTS);
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const body = content.replace(/^---[\s\S]*?\n---\n/, "");
    expect(body.trim()).toBe("Project: [[Alpha|Alpha]]");
  });

  it("sets the parent wiki-link prefix in the body for subtasks", async () => {
    const parentContent = makeTaskContent({ id: "parentid0000001", title: "Parent" });
    const app = makeApp({ "Projects/Alpha_tasks/parent.md": parentContent });
    await ProjectTaskIO.create(notesOf(app), {
      ...BASE_OPTS,
      parentTask: newTask({
        id: "parentid0000001",
        title: "Parent",
        filePath: "Projects/Alpha_tasks/parent.md",
        projectId: "proj-1",
        status: "todo",
        dependencies: [],
      }),
    });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const body = content.replace(/^---[\s\S]*?\n---\n/, "");
    expect(body.trim()).toBe("Parent: [[parent|Parent]]");
  });

  it("includes dependencies and tags in frontmatter when given", async () => {
    const app = makeApp();
    await ProjectTaskIO.create(notesOf(app), {
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
    await ProjectTaskIO.create(notesOf(app), {
      ...BASE_OPTS,
      parentTask: newTask({
        id: "parentid0000001",
        title: "Parent",
        filePath: "Projects/Alpha_tasks/parent.md",
        projectId: "proj-1",
        status: "todo",
        dependencies: [],
      }),
    });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('parentId: "parentid0000001"');
  });

  it("appends a counter suffix when the slug filename already exists", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/my-task.md": "existing" });
    await ProjectTaskIO.create(notesOf(app), BASE_OPTS);
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/Alpha_tasks/my-task-2.md");
  });

  it("appends the user description after the prefix when provided", async () => {
    const app = makeApp();
    await ProjectTaskIO.create(notesOf(app), { ...BASE_OPTS, description: "Details here." });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const body = content.replace(/^---[\s\S]*?\n---\n/, "");
    expect(body.trim()).toBe("Project: [[Alpha|Alpha]]\n\nDetails here.");
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("ProjectTaskIO.delete", () => {
  it("throws when the file does not exist", async () => {
    const app = makeApp();
    await expect(
      notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001"),
    ).rejects.toThrow("File not found");
  });

  it("deletes the task file", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001");
    expect(app._files.has(TASK_PATH)).toBe(false);
  });

  it("removes the task id from dependent tasks' dependencies", async () => {
    const depContent = makeTaskContent({ id: "dependentid0001", dependencies: ["taskid00000001"] });
    const DEP_PATH = "Projects/Alpha_tasks/dep.md";
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [DEP_PATH]: depContent,
    });
    const dep = taskOver(app, { id: "dependentid0001", filePath: DEP_PATH, title: "Dep", dependencies: ["taskid00000001"] });
    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001", [dep]);
    expect(app._files.get(DEP_PATH)).not.toContain("taskid00000001");
  });

  it("handles a dependent whose frontmatter dependencies field is absent", async () => {
    const DEP_PATH = "Projects/Alpha_tasks/dep.md";
    const depContent = ["---", 'id: "dependentid0001"', 'projectId: "proj-1"', "status: todo", "subtaskIds: []", "---", "", "Body", ""].join("\n");
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [DEP_PATH]: depContent,
    });
    const dep = taskOver(app, { id: "dependentid0001", filePath: DEP_PATH, title: "Dep", dependencies: ["taskid00000001"] });
    await expect(notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001", [dep])).resolves.toBeUndefined();
  });

  it("recursively deletes subtask files", async () => {
    const CHILD_PATH = "Projects/Alpha_tasks/child.md";
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [CHILD_PATH]: makeTaskContent({ id: "childid000000001" }),
    });
    const child = newTask({ id: "childid000000001", filePath: CHILD_PATH, parentId: "taskid00000001", projectId: "proj-1", title: "Child", status: "todo", dependencies: [] });
    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001", [child]);
    expect(app._files.has(CHILD_PATH)).toBe(false);
    expect(app._files.has(TASK_PATH)).toBe(false);
  });

  it("unlinks a root task from the project note that lists it", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001");
    const project = app._files.get(PROJECT_PATH) as string;
    expect(project).not.toContain("[[do-thing|Do thing]]");
    expect(project).not.toContain("taskid00000001");
  });

  it("leaves the project note alone for a subtask, listed by its parent instead", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PROJECT_PATH]: projectListing(false),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001");
    expect(app._files.get(PROJECT_PATH)).toContain("[[do-thing|Do thing]]");
  });

  it("unlinks a subtask from its parent task with no parentTask named, going by the body link", async () => {
    const app = makeApp({
      [TASK_PATH]: makeTaskContent({ prefix: "Parent: [[parent|Parent]]" }),
      [PARENT_TASK_PATH]: parentListing(false),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001");
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
    const child = newTask({ id: "childid000000001", filePath: CHILD_PATH, parentId: "taskid00000001", projectId: "proj-1", title: "Child", status: "todo", dependencies: [] });

    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001", [child]);

    // The body edit goes through `vault.process` — see `removeChildEntry`.
    const written = app.vault.process.mock.calls.map(([file]) => file.path);
    expect(written).toEqual([PROJECT_PATH]);
  });

  it("unlinks the task from its parent when parentTask is given", async () => {
    const parentContent = makeParentContent("## Subtasks\n- [ ] [[do-thing|Do thing]]");
    const app = makeApp({
      [TASK_PATH]: makeTaskContent(),
      [PARENT_PATH]: parentContent,
    });
    const parent = newTask({ id: "parentid0000001", filePath: PARENT_PATH, projectId: "proj-1", title: "Parent", status: "todo", dependencies: [] });
    await notesOf(app).projects.taskCache.file(TASK_PATH).delete("taskid00000001", [], parent);
    expect(app._files.get(PARENT_PATH)).not.toContain("[[do-thing|Do thing]]");
  });
});

// ---------------------------------------------------------------------------
// Notes that vanished, notes that were never ours, and a cache that has fallen
// behind the file it describes
// ---------------------------------------------------------------------------

const PLAIN_PATH = "Notes/loose.md";
const MISSING_PATH = "Projects/Alpha_tasks/never-existed.md";

/** Points the metadata cache at `fm` for `path` however the file itself reads — what a
 *  cache that hasn't caught up with a write, or with a deletion, looks like. */
function staleCache(app: ReturnType<typeof makeApp>, path: string, fm: Record<string, unknown>): void {
  const cache = app.metadataCache.getFileCache as unknown as
    Mock<(f: { path: string }) => { frontmatter: Record<string, unknown> } | null>;
  const real = cache.getMockImplementation()!;
  cache.mockImplementation((file) => (file.path === path ? { frontmatter: fm } : real(file)));
}

describe("ProjectTaskIO — notes that aren't there, or aren't ours", () => {
  it("skips a dependent the reader still lists but the vault has lost", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const ghost = newTask({
      id: "ghost", title: "Ghost", projectId: "proj-1", status: "todo",
      filePath: MISSING_PATH, dependencies: ["taskid00000001"],
    });

    await pruneDependents(notesOf(app), "taskid00000001", [ghost]);

    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it("reads no body prefix from a note that isn't there", async () => {
    expect(await notesOf(makeApp()).projects.taskCache.file(MISSING_PATH).readBodyPrefix()).toBe("");
  });

  it("reads no body prefix from a body that opens with prose", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ prefix: "Just a description." }) });
    expect(await notesOf(app).projects.taskCache.file(TASK_PATH).readBodyPrefix()).toBe("");
  });

  it("won't write a body prefix into a note with no frontmatter", async () => {
    const app = makeApp({ [PLAIN_PATH]: "Just prose.\n" });
    await notesOf(app).projects.taskCache.file(PLAIN_PATH).setBodyPrefix("Project: [[Alpha|Alpha]]");
    expect(app._files.get(PLAIN_PATH)).toBe("Just prose.\n");
  });

  it("wants no completed stamp for a note that isn't there", () => {
    expect(notesOf(makeApp()).projects.taskCache.file(MISSING_PATH).needsCompletedStamp()).toBe(false);
  });

  it("pushes nothing from a note that isn't there", async () => {
    const app = makeApp({ [PROJECT_PATH]: projectListing(false) });
    await notesOf(app).projects.taskCache.file(MISSING_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toBe(projectListing(false));
  });

  it("finds no listing for a task note outside a project's tasks folder", async () => {
    // The body says `Project:`, but the folder isn't `<project>_tasks`, so there is no
    // project note to name — a guess would edit whatever file the name landed on.
    const app = makeApp({ [PLAIN_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    await notesOf(app).projects.taskCache.file(PLAIN_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toBe(projectListing(false));
  });

  it("pushes the file's own name when the note carries no title", async () => {
    const app = makeApp({
      [TASK_PATH]: `---\npm-task: true\nid: "taskid00000001"\nstatus: todo\n---\nProject: [[Alpha|Alpha]]\n`,
      [PROJECT_PATH]: projectListing(false),
    });
    await notesOf(app).projects.taskCache.file(TASK_PATH).pushToListing();
    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|do-thing]]");
  });
});

describe("ProjectTaskIO.applyParentBox — when the cache disagrees with the file", () => {
  it("writes no status into a file the cache wrongly calls a task", async () => {
    const app = makeApp({ [PLAIN_PATH]: "Just prose.\n" });
    staleCache(app, PLAIN_PATH, { "pm-task": true, status: "todo" });

    await notesOf(app).projects.taskCache.file(PLAIN_PATH).applyParentBox(true);

    expect(app._files.get(PLAIN_PATH)).not.toContain("status");
  });

  it("writes nothing when the file already reads the way the box does", async () => {
    // No `status` at all: the on-disk check can't read one, so the decision falls to the
    // frontmatter write itself, which finds the file already saying what the box says.
    const content = `---\npm-task: true\nid: "taskid00000001"\n---\nProject: [[Alpha|Alpha]]\n`;
    const app = makeApp({ [TASK_PATH]: content });
    staleCache(app, TASK_PATH, { "pm-task": true, status: "done" });

    await notesOf(app).projects.taskCache.file(TASK_PATH).applyParentBox(false);

    expect(app._files.get(TASK_PATH)).not.toContain("status");
  });

  it("writes no status when the note is deleted while the box is being applied", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ status: "todo" }) });
    const cache = app.metadataCache.getFileCache as unknown as
      Mock<(f: { path: string }) => { frontmatter: Record<string, unknown> } | null>;
    const real = cache.getMockImplementation()!;
    // The delete event lands between the cache read and the read-back from disk.
    cache.mockImplementation((file) => {
      const result = real(file);
      app._files.delete(TASK_PATH);
      return result;
    });

    await notesOf(app).projects.taskCache.file(TASK_PATH).applyParentBox(true);

    expect(app._files.get(TASK_PATH)).not.toContain("status");
  });

  it("skips the listing push when the field write is the last thing to see the note", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent(), [PROJECT_PATH]: projectListing(false) });
    const write = app.fileManager.processFrontMatter as unknown as
      Mock<(f: { path: string }, cb: (fm: Record<string, unknown>) => void) => Promise<void>>;
    const real = write.getMockImplementation()!;
    write.mockImplementation(async (file, cb) => {
      await real(file, cb);
      app._files.delete(file.path);
    });

    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "title", "Renamed");

    expect(app._files.get(PROJECT_PATH)).toContain("- [ ] [[do-thing|Do thing]]");
  });
});

describe("ProjectTaskIO.patchDue", () => {
  it("writes the deadline as a plain day", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "due", day("2026-08-04"));
    expect(app._files.get(TASK_PATH)).toContain('due: "2026-08-04"');
  });

  it("drops the field entirely when the deadline is cleared", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const note = notesOf(app).projects.taskCache.file(TASK_PATH);
    await setField(note, "due", day("2026-08-04"));
    await setField(note, "due", undefined);
    // Deleted rather than emptied: the reader treats a `due:` with no value as a date.
    expect(app._files.get(TASK_PATH)).not.toContain("due:");
  });

  it("throws for a note that isn't there", async () => {
    await expect(setField(notesOf(makeApp()).projects.taskCache.file(MISSING_PATH), "due", undefined))
      .rejects.toThrow(/File not found/);
  });
});

describe("ProjectTaskIO.writeCard", () => {
  /** The `cardLayout` the note now carries, read back off the file. */
  function layoutIn(app: ReturnType<typeof makeApp>): unknown {
    const written = /^cardLayout: (.*)$/m.exec(app._files.get(TASK_PATH) ?? "");
    return written ? JSON.parse(written[1].replace(/(\w+):/g, '"$1":')) : undefined;
  }

  it("writes the place and size the card was left at", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await notesOf(app).projects.taskCache.file(TASK_PATH).writeCard({ x: 320, y: -48, w: 240, h: 96 });
    expect(layoutIn(app)).toEqual({ x: 320, y: -48, w: 240, h: 96 });
  });

  it("replaces what the note carried rather than merging into it", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const note = notesOf(app).projects.taskCache.file(TASK_PATH);
    await note.writeCard({ x: 1, y: 2, w: 240, h: 96 });
    // A move forgets where the card sat and keeps how big it was — the caller says so by
    // handing over the whole of what the key should now hold.
    await note.writeCard({ w: 240, h: 96 });
    expect(layoutIn(app)).toEqual({ w: 240, h: 96 });
  });

  it.each([
    ["nothing worth storing", {}],
    ["nothing at all", null],
  ])("drops the key for %s", async (_case, card) => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const note = notesOf(app).projects.taskCache.file(TASK_PATH);
    await note.writeCard({ x: 1, y: 2 });
    await note.writeCard(card);
    expect(app._files.get(TASK_PATH)).not.toContain("cardLayout");
  });

  it("leaves updatedAt alone — where a card sits is not an edit of the task", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await notesOf(app).projects.taskCache.file(TASK_PATH).writeCard({ x: 1, y: 2 });
    expect(app._files.get(TASK_PATH)).toContain('updatedAt: "2026-01-01T00:00:00.000Z"');
  });

  it("stamps updatedAt for an edit of the task itself, by way of contrast", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    await setField(notesOf(app).projects.taskCache.file(TASK_PATH), "status", "done");
    expect(app._files.get(TASK_PATH)).not.toContain('updatedAt: "2026-01-01T00:00:00.000Z"');
  });

  it("throws for a note that isn't there", async () => {
    await expect(notesOf(makeApp()).projects.taskCache.file(MISSING_PATH).writeCard(null))
      .rejects.toThrow(/File not found/);
  });
});

// ---------------------------------------------------------------------------
// Setting a field, and the write that follows
// ---------------------------------------------------------------------------

describe("a task's fields, set", () => {
  /** A task over that path, as the folder having been read leaves it — which is where its
   *  fields are kept, and so what a field is set on. */
  function read(app: ReturnType<typeof makeApp>, status = "todo") {
    return notesOf(app).projects.taskCache.make({
      id: "t1", title: "Do thing", projectId: "p1", status, dependencies: [], filePath: TASK_PATH,
    });
  }

  it("writes everything set in one turn in a single pass over the file", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const task = read(app);

    task.status = "in-progress";
    task.priority = Priority.High;
    await task.persistence.flush();

    expect(app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
    expect(app._files.get(TASK_PATH)).toContain('status: "in-progress"');
    expect(app._files.get(TASK_PATH)).toContain('priority: "high"');
  });

  it("writes nothing for a field already saying that", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent({ status: "todo" }) });
    const task = read(app);

    task.status = "todo";
    await task.persistence.flush();

    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it("reads back off the task as what was set, before the write has landed", () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const task = read(app);

    task.status = "done";

    expect(task.status).toBe("done");
    expect(task.persistence.isDirty).toBe(true);
  });

  it("holds what was set while the write is in the air, rather than the file's older answer", async () => {
    const app = makeApp({ [TASK_PATH]: makeTaskContent() });
    const task = read(app);

    task.status = "done";
    // A reparse arriving now would read "todo" off the file the write hasn't reached yet.
    expect(task.persistence.isDirty).toBe(true);
    await task.persistence.flush();
    expect(task.status).toBe("done");
  });

  it("leaves the file's own answer to be taken back when the write fails", async () => {
    const task = read(makeApp());

    task.status = "done";

    await expect(task.persistence.flush()).rejects.toThrow(/File not found/);
    // Nothing is owed any more, so the next read of the folder is what puts it right.
    expect(task.persistence.isDirty).toBe(false);
  });
});
