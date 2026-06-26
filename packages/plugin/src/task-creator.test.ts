import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoist mock TFile so the vi.mock factory can reference it
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
  Modal: class {
    constructor() {}
    open() {}
    close() {}
  },
}));

import { generateId, createTaskFile, deleteTaskFile } from "./task-creator";
import type { Task } from "@pm-compass/shared";

// ---------------------------------------------------------------------------
// App mock helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string; filePath: string }): Task {
  return {
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    subtasks: [],
    ...overrides,
  };
}

/**
 * Creates a lightweight in-memory vault mock.
 * `processFrontMatter` does real YAML parsing so callback mutations are visible
 * in subsequent `vault.read` calls.
 */
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
      } else {
        fm[kv[1]] = val.replace(/^"(.*)"$/, "$1");
      }
    }
    return fm;
  }

  function serializeFm(fm: Record<string, unknown>): string {
    return Object.entries(fm)
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          return `${k}: [${v.map((x) => `"${x}"`).join(", ")}]`;
        }
        return `${k}: "${v}"`;
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
    read: vi.fn(async (file: InstanceType<typeof MockTFile>) =>
      files.get(file.path) ?? "",
    ),
    modify: vi.fn(async (file: InstanceType<typeof MockTFile>, content: string) => {
      files.set(file.path, content);
    }),
    delete: vi.fn(async (file: InstanceType<typeof MockTFile>) => {
      files.delete(file.path);
    }),
  };

  const fileManager = {
    processFrontMatter: vi.fn(
      async (
        file: InstanceType<typeof MockTFile>,
        cb: (fm: Record<string, unknown>) => void,
      ) => {
        const content = files.get(file.path) ?? "";
        const fm = parseFm(content);
        cb(fm);
        const rest = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
        files.set(file.path, `---\n${serializeFm(fm)}\n---\n${rest}`);
      },
    ),
  };

  return { vault, fileManager, _files: files };
}

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe("generateId", () => {
  it("returns a 16-character string", () => {
    expect(generateId()).toHaveLength(16);
  });

  it("contains only lowercase alphanumeric characters", () => {
    expect(generateId()).toMatch(/^[a-z0-9]{16}$/);
  });

  it("returns unique values on repeated calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// createTaskFile — top-level task
// ---------------------------------------------------------------------------

describe("createTaskFile — top-level task", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
  });

  it("creates a file in <projectName>_tasks/", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/My project.md",
      projectTitle: "My project",
      title: "Do the thing",
      description: "",
      status: "todo",
      priority: "",
      type: "task",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    expect(app.vault.create).toHaveBeenCalledOnce();
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/My project_tasks/do-the-thing.md");
  });

  it("uses a 16-char alphanumeric id in frontmatter (not a UUID)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      title: "Task one",
      description: "",
      status: "todo",
      priority: "",
      type: "task",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const idMatch = content.match(/^id: "([^"]+)"/m);
    expect(idMatch).not.toBeNull();
    expect(idMatch![1]).toMatch(/^[a-z0-9]{16}$/);
  });

  it("starts the body with 'Project: [[projectBasename|projectTitle]]'", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Test project.md",
      projectTitle: "Test project",
      title: "My task",
      description: "",
      status: "todo",
      priority: "",
      type: "task",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n([\s\S]*)$/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1].trim()).toBe("Project: [[Test project|Test project]]");
  });

  it("appends user description after the Project: line when provided", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      title: "Task",
      description: "Some notes here.",
      status: "todo",
      priority: "",
      type: "task",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n([\s\S]*)$/);
    expect(bodyMatch![1].trim()).toBe(
      "Project: [[Alpha|Alpha]]\n\nSome notes here.",
    );
  });

  it("does not touch the parent file when creating a top-level task", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      title: "Top",
      description: "",
      status: "todo",
      priority: "",
      type: "task",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createTaskFile — subtask
// ---------------------------------------------------------------------------

describe("createTaskFile — subtask", () => {
  const parentContent = [
    "---",
    'pm-task: true',
    'id: "parentid0000001"',
    'title: "Parent task"',
    'projectId: "proj-1"',
    'parentId: ""',
    'status: todo',
    'subtaskIds: []',
    'dependencies: []',
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "---",
    "",
    "Project: [[Alpha|Alpha]]",
    "",
  ].join("\n");

  let app: ReturnType<typeof makeApp>;
  let parentTask: Task;

  beforeEach(() => {
    app = makeApp({ "Projects/Alpha_tasks/parent-task.md": parentContent });
    parentTask = makeTask({
      id: "parentid0000001",
      title: "Parent task",
      filePath: "Projects/Alpha_tasks/parent-task.md",
    });
  });

  it("starts the body with 'Parent: [[parentBasename|parentTitle]]'", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: "",
      type: "subtask",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n([\s\S]*)$/);
    expect(bodyMatch![1].trim()).toBe("Parent: [[parent-task|Parent task]]");
  });

  it("writes parentId into the subtask frontmatter", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: "",
      type: "subtask",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain(`parentId: "parentid0000001"`);
  });

  it("adds the new subtask id to the parent subtaskIds via processFrontMatter", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newId = await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: "",
      type: "subtask",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    expect(app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
    const parentFileContent = app._files.get("Projects/Alpha_tasks/parent-task.md")!;
    expect(parentFileContent).toContain(newId);
  });

  it("appends a subtask link to the parent body ## Subtasks section", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: "",
      type: "subtask",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    expect(app.vault.modify).toHaveBeenCalledOnce();
    const [, updatedContent] = (app.vault.modify as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
    expect(updatedContent).toContain("## Subtasks");
    expect(updatedContent).toContain("[[sub-task|Sub task]]");
  });

  it("appends to existing ## Subtasks section rather than creating a duplicate", async () => {
    const parentWithSubtasks = parentContent.trimEnd() +
      "\n\n## Subtasks\n- [ ] [[existing-sub|Existing sub]]\n";
    const app2 = makeApp({ "Projects/Alpha_tasks/parent-task.md": parentWithSubtasks });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app2 as any, {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "New sub",
      description: "",
      status: "todo",
      priority: "",
      type: "subtask",
      progress: 0,
      start: "",
      due: "",
      tags: [],
      dependencies: [],
    });

    const updatedContent = app2._files.get("Projects/Alpha_tasks/parent-task.md")!;
    const subtaskMatches = updatedContent.match(/## Subtasks/g);
    expect(subtaskMatches).toHaveLength(1);
    expect(updatedContent).toContain("[[existing-sub|Existing sub]]");
    expect(updatedContent).toContain("[[new-sub|New sub]]");
  });
});

// ---------------------------------------------------------------------------
// deleteTaskFile
// ---------------------------------------------------------------------------

describe("deleteTaskFile", () => {
  const taskContent = [
    "---",
    'pm-task: true',
    'id: "taskid00000001"',
    'title: "Do thing"',
    'projectId: "proj-1"',
    'subtaskIds: []',
    'dependencies: []',
    "---",
    "",
    "Project: [[Alpha|Alpha]]",
    "",
  ].join("\n");

  const parentContent = [
    "---",
    'pm-task: true',
    'id: "parentid0000001"',
    'title: "Parent task"',
    'projectId: "proj-1"',
    'subtaskIds: ["taskid00000001"]',
    'dependencies: []',
    "---",
    "",
    "Project: [[Alpha|Alpha]]",
    "",
    "## Subtasks",
    "- [ ] [[do-thing|Do thing]]",
    "",
  ].join("\n");

  it("deletes the task file", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task);

    expect(app.vault.delete).toHaveBeenCalledOnce();
    expect(app._files.has("Projects/Alpha_tasks/do-thing.md")).toBe(false);
  });

  it("throws when the file does not exist", async () => {
    const app = makeApp();
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/missing.md" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deleteTaskFile(app as any, task)).rejects.toThrow("File not found");
  });

  it("removes the subtask id from the parent subtaskIds", async () => {
    const app = makeApp({
      "Projects/Alpha_tasks/do-thing.md": taskContent,
      "Projects/Alpha_tasks/parent-task.md": parentContent,
    });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });
    const parent = makeTask({
      id: "parentid0000001",
      title: "Parent task",
      filePath: "Projects/Alpha_tasks/parent-task.md",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task, parent);

    expect(app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
    const updatedParent = app._files.get("Projects/Alpha_tasks/parent-task.md")!;
    expect(updatedParent).not.toContain("taskid00000001");
  });

  it("removes the subtask link from the parent ## Subtasks body section", async () => {
    const app = makeApp({
      "Projects/Alpha_tasks/do-thing.md": taskContent,
      "Projects/Alpha_tasks/parent-task.md": parentContent,
    });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });
    const parent = makeTask({
      id: "parentid0000001",
      title: "Parent task",
      filePath: "Projects/Alpha_tasks/parent-task.md",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task, parent);

    expect(app.vault.modify).toHaveBeenCalledOnce();
    const [, updatedContent] = (app.vault.modify as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string];
    expect(updatedContent).not.toContain("[[do-thing|Do thing]]");
  });
});
