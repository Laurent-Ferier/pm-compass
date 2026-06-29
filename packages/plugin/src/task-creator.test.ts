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
  moment: (v?: unknown) => {
    const d = v ? new Date(v as string) : new Date();
    return {
      format: (fmt: string) => d.toISOString().slice(0, fmt === "YYYY-MM-DD" ? 10 : 19),
      isValid: () => !isNaN(d.getTime()),
    };
  },
}));

import { generateId, createTaskFile, deleteTaskFile, addTaskDependency, removeTaskDependency, patchTaskField, openNoteFile } from "./task-creator";
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

// Shared minimal option set reused across createTaskFile edge-case tests.
const baseCreateOpts = {
  projectId: "proj-1",
  projectFilePath: "Projects/My project.md",
  projectTitle: "My project",
  title: "Task",
  description: "",
  status: "todo",
  priority: "",
  type: "task",
  progress: 0,
  start: "",
  due: "",
  tags: [] as string[],
  dependencies: [] as string[],
} as const;

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

  it("removes the deleted task id from dependents' dependencies frontmatter", async () => {
    const dependentContent = [
      "---",
      'pm-task: true',
      'id: "dependentid0001"',
      'title: "Dependent task"',
      'projectId: "proj-1"',
      'subtaskIds: []',
      'dependencies: ["taskid00000001"]',
      "---",
      "",
    ].join("\n");

    const app = makeApp({
      "Projects/Alpha_tasks/do-thing.md": taskContent,
      "Projects/Alpha_tasks/dependent-task.md": dependentContent,
    });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });
    const dependent = makeTask({
      id: "dependentid0001",
      title: "Dependent task",
      filePath: "Projects/Alpha_tasks/dependent-task.md",
      dependencies: ["taskid00000001"],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task, undefined, [task, dependent]);

    const updatedDependent = app._files.get("Projects/Alpha_tasks/dependent-task.md")!;
    expect(updatedDependent).not.toContain("taskid00000001");
  });

  it("removes the deleted task id from multiple dependents", async () => {
    const makeDepContent = (id: string) => [
      "---",
      'pm-task: true',
      `id: "${id}"`,
      `title: "Dep ${id}"`,
      'projectId: "proj-1"',
      'subtaskIds: []',
      'dependencies: ["taskid00000001"]',
      "---",
      "",
    ].join("\n");

    const app = makeApp({
      "Projects/Alpha_tasks/do-thing.md": taskContent,
      "Projects/Alpha_tasks/dep-a.md": makeDepContent("depaaaaaaaaaaa1"),
      "Projects/Alpha_tasks/dep-b.md": makeDepContent("depbbbbbbbbbbb1"),
    });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });
    const depA = makeTask({ id: "depaaaaaaaaaaa1", filePath: "Projects/Alpha_tasks/dep-a.md", dependencies: ["taskid00000001"] });
    const depB = makeTask({ id: "depbbbbbbbbbbb1", filePath: "Projects/Alpha_tasks/dep-b.md", dependencies: ["taskid00000001"] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task, undefined, [task, depA, depB]);

    expect(app._files.get("Projects/Alpha_tasks/dep-a.md")).not.toContain("taskid00000001");
    expect(app._files.get("Projects/Alpha_tasks/dep-b.md")).not.toContain("taskid00000001");
  });

  it("does not touch tasks that do not depend on the deleted task", async () => {
    const unrelatedContent = [
      "---",
      'pm-task: true',
      'id: "unrelatedid0001"',
      'title: "Unrelated task"',
      'projectId: "proj-1"',
      'subtaskIds: []',
      'dependencies: ["otherid000000001"]',
      "---",
      "",
    ].join("\n");

    const app = makeApp({
      "Projects/Alpha_tasks/do-thing.md": taskContent,
      "Projects/Alpha_tasks/unrelated.md": unrelatedContent,
    });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });
    const unrelated = makeTask({ id: "unrelatedid0001", filePath: "Projects/Alpha_tasks/unrelated.md", dependencies: ["otherid000000001"] });

    const processFmCallsBefore = (app.fileManager.processFrontMatter as ReturnType<typeof vi.fn>).mock.calls.length;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task, undefined, [task, unrelated]);

    const processFmCallsAfter = (app.fileManager.processFrontMatter as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(processFmCallsAfter).toBe(processFmCallsBefore);
    expect(app._files.get("Projects/Alpha_tasks/unrelated.md")).toContain("otherid000000001");
  });

  it("recursively deletes subtasks", async () => {
    const childContent = [
      "---",
      'pm-task: true',
      'id: "childid000000001"',
      'title: "Child task"',
      'projectId: "proj-1"',
      'subtaskIds: []',
      'dependencies: []',
      "---",
      "",
    ].join("\n");

    const parentWithChildContent = [
      "---",
      'pm-task: true',
      'id: "taskid00000001"',
      'title: "Do thing"',
      'projectId: "proj-1"',
      'subtaskIds: ["childid000000001"]',
      'dependencies: []',
      "---",
      "",
    ].join("\n");

    const app = makeApp({
      "Projects/Alpha_tasks/do-thing.md": parentWithChildContent,
      "Projects/Alpha_tasks/child-task.md": childContent,
    });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });
    const child = makeTask({ id: "childid000000001", filePath: "Projects/Alpha_tasks/child-task.md", parentId: "taskid00000001" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task, undefined, [task, child]);

    expect(app._files.has("Projects/Alpha_tasks/do-thing.md")).toBe(false);
    expect(app._files.has("Projects/Alpha_tasks/child-task.md")).toBe(false);
    expect(app.vault.delete).toHaveBeenCalledTimes(2);
  });

  it("removes dependency refs from surviving tasks when a subtask is recursively deleted", async () => {
    const childContent = [
      "---",
      'pm-task: true',
      'id: "childid000000001"',
      'title: "Child task"',
      'projectId: "proj-1"',
      'subtaskIds: []',
      'dependencies: []',
      "---",
      "",
    ].join("\n");

    const parentWithChildContent = [
      "---",
      'pm-task: true',
      'id: "taskid00000001"',
      'title: "Do thing"',
      'projectId: "proj-1"',
      'subtaskIds: ["childid000000001"]',
      'dependencies: []',
      "---",
      "",
    ].join("\n");

    const dependentOnChildContent = [
      "---",
      'pm-task: true',
      'id: "dependentid0001"',
      'title: "Depends on child"',
      'projectId: "proj-1"',
      'subtaskIds: []',
      'dependencies: ["childid000000001"]',
      "---",
      "",
    ].join("\n");

    const app = makeApp({
      "Projects/Alpha_tasks/do-thing.md": parentWithChildContent,
      "Projects/Alpha_tasks/child-task.md": childContent,
      "Projects/Alpha_tasks/dependent.md": dependentOnChildContent,
    });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });
    const child = makeTask({ id: "childid000000001", filePath: "Projects/Alpha_tasks/child-task.md", parentId: "taskid00000001" });
    const dependent = makeTask({ id: "dependentid0001", filePath: "Projects/Alpha_tasks/dependent.md", dependencies: ["childid000000001"] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteTaskFile(app as any, task, undefined, [task, child, dependent]);

    expect(app._files.has("Projects/Alpha_tasks/child-task.md")).toBe(false);
    const updatedDependent = app._files.get("Projects/Alpha_tasks/dependent.md")!;
    expect(updatedDependent).not.toContain("childid000000001");
  });
});

// ---------------------------------------------------------------------------
// addTaskDependency
// ---------------------------------------------------------------------------

describe("addTaskDependency", () => {
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
  ].join("\n");

  it("throws when the file does not exist", async () => {
    const app = makeApp();
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/missing.md" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(addTaskDependency(app as any, task, "depid000000001")).rejects.toThrow("File not found");
  });

  it("adds a new dependency id to the frontmatter", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await addTaskDependency(app as any, task, "depid000000001");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain("depid000000001");
  });

  it("is idempotent when the dependency is already present", async () => {
    const contentWithDep = [
      "---",
      'pm-task: true',
      'id: "taskid00000001"',
      'title: "Do thing"',
      'projectId: "proj-1"',
      'subtaskIds: []',
      'dependencies: ["depid000000001"]',
      "---",
      "",
    ].join("\n");
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": contentWithDep });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md", dependencies: ["depid000000001"] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await addTaskDependency(app as any, task, "depid000000001");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    const matches = updated.match(/depid000000001/g);
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeTaskDependency
// ---------------------------------------------------------------------------

describe("removeTaskDependency", () => {
  const taskContent = [
    "---",
    'pm-task: true',
    'id: "taskid00000001"',
    'title: "Do thing"',
    'projectId: "proj-1"',
    'subtaskIds: []',
    'dependencies: ["depid000000001"]',
    "---",
    "",
  ].join("\n");

  it("throws when the file does not exist", async () => {
    const app = makeApp();
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/missing.md" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(removeTaskDependency(app as any, task, "depid000000001")).rejects.toThrow("File not found");
  });

  it("removes an existing dependency id from the frontmatter", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md", dependencies: ["depid000000001"] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await removeTaskDependency(app as any, task, "depid000000001");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).not.toContain("depid000000001");
  });

  it("is a no-op when the dependency is not present", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md", dependencies: ["depid000000001"] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await removeTaskDependency(app as any, task, "otherid0000001");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain("depid000000001");
  });
});

// ---------------------------------------------------------------------------
// patchTaskField
// ---------------------------------------------------------------------------

describe("patchTaskField", () => {
  const taskContent = [
    "---",
    'pm-task: true',
    'id: "taskid00000001"',
    'title: "Do thing"',
    'projectId: "proj-1"',
    'status: "todo"',
    'subtaskIds: []',
    'dependencies: []',
    "---",
    "",
  ].join("\n");

  it("throws when the file does not exist", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(patchTaskField(app as any, "Projects/missing.md", "status", "done")).rejects.toThrow("File not found");
  });

  it("sets the priority field", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await patchTaskField(app as any, "Projects/Alpha_tasks/do-thing.md", "priority", "high");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain('priority: "high"');
  });

  it("removes the priority field when value is empty", async () => {
    const contentWithPriority = [
      "---",
      'pm-task: true',
      'id: "taskid00000001"',
      'title: "Do thing"',
      'projectId: "proj-1"',
      'status: "todo"',
      'priority: "high"',
      'subtaskIds: []',
      'dependencies: []',
      "---",
      "",
    ].join("\n");
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": contentWithPriority });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await patchTaskField(app as any, "Projects/Alpha_tasks/do-thing.md", "priority", "");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).not.toContain("priority");
  });

  it("sets the status field", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await patchTaskField(app as any, "Projects/Alpha_tasks/do-thing.md", "status", "in-progress");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain('status: "in-progress"');
  });

  it("adds a completed date when status is set to done", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await patchTaskField(app as any, "Projects/Alpha_tasks/do-thing.md", "status", "done");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toMatch(/completed: "\d{4}-\d{2}-\d{2}"/);
  });

  it("removes the completed date when status changes away from done", async () => {
    const contentDone = [
      "---",
      'pm-task: true',
      'id: "taskid00000001"',
      'title: "Do thing"',
      'projectId: "proj-1"',
      'status: "done"',
      'completed: "2026-06-01"',
      'subtaskIds: []',
      'dependencies: []',
      "---",
      "",
    ].join("\n");
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": contentDone });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await patchTaskField(app as any, "Projects/Alpha_tasks/do-thing.md", "status", "todo");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).not.toContain("completed");
  });

  it("keeps the completed date when status is set to cancelled", async () => {
    const contentDone = [
      "---",
      'pm-task: true',
      'id: "taskid00000001"',
      'title: "Do thing"',
      'projectId: "proj-1"',
      'status: "done"',
      'completed: "2026-06-01"',
      'subtaskIds: []',
      'dependencies: []',
      "---",
      "",
    ].join("\n");
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": contentDone });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await patchTaskField(app as any, "Projects/Alpha_tasks/do-thing.md", "status", "cancelled");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain("2026-06-01");
  });

  it("does not overwrite the completed date when marking done again", async () => {
    const contentAlreadyDone = [
      "---",
      'pm-task: true',
      'id: "taskid00000001"',
      'title: "Do thing"',
      'projectId: "proj-1"',
      'status: "done"',
      'completed: "2026-06-01"',
      'subtaskIds: []',
      'dependencies: []',
      "---",
      "",
    ].join("\n");
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": contentAlreadyDone });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await patchTaskField(app as any, "Projects/Alpha_tasks/do-thing.md", "status", "done");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain('completed: "2026-06-01"');
  });
});

// ---------------------------------------------------------------------------
// createTaskFile — optional frontmatter fields
// ---------------------------------------------------------------------------

describe("createTaskFile — optional frontmatter fields", () => {
  it("writes priority when set", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, priority: "high" });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain("priority: high");
  });

  it("omits priority when empty", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, priority: "" });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("priority");
  });

  it("writes start date when provided", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, start: "2026-07-01" });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('start: "2026-07-01"');
  });

  it("omits start when empty", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, start: "" });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("start:");
  });

  it("writes due date when provided", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, due: "2026-08-31" });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('due: "2026-08-31"');
  });

  it("omits due when empty", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, due: "" });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("due:");
  });

  it("writes progress when greater than 0", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, progress: 50 });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain("progress: 50");
  });

  it("omits progress when 0", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, progress: 0 });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("progress:");
  });

  it("writes tags array when non-empty", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, tags: ["alpha", "beta"] });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('"alpha"');
    expect(content).toContain('"beta"');
  });

  it("omits tags field when array is empty", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, tags: [] });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("tags:");
  });

  it("writes inline dependencies when non-empty", async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, dependencies: ["dep1111111111111"] });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('"dep1111111111111"');
  });
});

// ---------------------------------------------------------------------------
// createTaskFile — filename collision
// ---------------------------------------------------------------------------

describe("createTaskFile — filename collision", () => {
  it("appends a counter suffix when the slug filename already exists", async () => {
    const app = makeApp({ "Projects/My project_tasks/task.md": "existing" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, title: "Task" });
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/My project_tasks/task-2.md");
  });

  it("increments the counter until a free name is found", async () => {
    const app = makeApp({
      "Projects/My project_tasks/task.md": "existing",
      "Projects/My project_tasks/task-2.md": "existing",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createTaskFile(app as any, { ...baseCreateOpts, title: "Task" });
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/My project_tasks/task-3.md");
  });
});

// ---------------------------------------------------------------------------
// openNoteFile
// ---------------------------------------------------------------------------

describe("openNoteFile", () => {
  function makeAppWithWorkspace(
    initialFiles: Record<string, string> = {},
    workspaceOverrides: Record<string, unknown> = {},
  ) {
    const app = makeApp(initialFiles);
    const workspace = {
      iterateAllLeaves: vi.fn(),
      revealLeaf: vi.fn(),
      getLeaf: vi.fn(() => ({ openFile: vi.fn().mockResolvedValue(undefined) })),
      ...workspaceOverrides,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).workspace = workspace;
    return { app, workspace };
  }

  it("does nothing when the file does not exist in the vault", () => {
    const { app, workspace } = makeAppWithWorkspace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openNoteFile(app as any, "Projects/missing.md");
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("reveals an existing leaf when the file is already open", () => {
    const { app, workspace } = makeAppWithWorkspace({ "Projects/task.md": "content" });
    const existingLeaf = { view: { file: new MockTFile("Projects/task.md") } };
    workspace.iterateAllLeaves = vi.fn((cb: (leaf: typeof existingLeaf) => void) => cb(existingLeaf));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openNoteFile(app as any, "Projects/task.md");
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("opens a new leaf when the file is not currently open", () => {
    const { app, workspace } = makeAppWithWorkspace({ "Projects/task.md": "content" });
    workspace.iterateAllLeaves = vi.fn(); // no leaves call the callback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openNoteFile(app as any, "Projects/task.md");
    expect(workspace.getLeaf).toHaveBeenCalled();
  });
});
