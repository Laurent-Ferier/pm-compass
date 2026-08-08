// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoist mock TFile so the vi.mock factory can reference it
const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  class MockTFolder {
    constructor(public children: (MockTFile | MockTFolder)[] = []) {}
  }
  return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  TFolder: MockTFolder,
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

import { VaultData } from "./vault-data";
import type { ProjectTaskStore } from "../store/project-task-store";
import type { ProjectService } from "./project-service";
import { DEFAULT_SETTINGS } from "../settings";
import { ProjectTask, type ProjectTaskFields } from "../project/project-task";
import { asApp } from "../__testing__/as-app";
import { Priority } from "../base-task";
import { TaskType } from "../project/project-task";
import type { CreateTaskOpts } from "./vault-data";
import { day } from "../__testing__/dates";
import { newTask, setField } from "../__testing__/notes";

// ---------------------------------------------------------------------------
// App mock helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<ProjectTaskFields> & { id: string; filePath: string }): ProjectTask {
  return newTask({
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    ...overrides,
  });
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
        return `${k}: "${String(v)}"`;
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
    trashFile: vi.fn(async (file: InstanceType<typeof MockTFile>) => {
      files.delete(file.path);
    }),
  };

  // The files are the whole vault here; Obsidian's own reading of them is nobody's business
  // in these tests, and answers with nothing rather than being absent — a store watches
  // whether or not a test is looking, and reads through this when it puts a note back in step.
  const metadataCache = { getFileCache: vi.fn(() => null) };

  return asApp({ vault, fileManager, metadataCache, _files: files });
}

/** The task note store over that vault. `start` is never called: these tests drive the
 *  writes directly, and nothing here turns on the vault's own events. */
function makeTaskNotes(app: ReturnType<typeof makeApp>): ProjectTaskStore {
  return new VaultData(app, () => DEFAULT_SETTINGS).projectTasks;
}

/** The writes that span two notes, which the service above the stores owns. */
function taskWrites(app: ReturnType<typeof makeApp>): ProjectService {
  return new VaultData(app, () => DEFAULT_SETTINGS).projects;
}

// Shared minimal option set reused across the create edge-case tests.
const baseCreateOpts: CreateTaskOpts = {
  projectId: "proj-1",
  projectFilePath: "Projects/My project.md",
  projectTitle: "My project",
  title: "Task",
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
// creating a task — top-level task
// ---------------------------------------------------------------------------

describe("creating a task — top-level task", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
  });

  it("creates a file in <projectName>_tasks/", async () => {
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/My project.md",
      projectTitle: "My project",
      title: "Do the thing",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Task,
      progress: 0,
      start: null,
      due: null,
      tags: [],
      dependencies: [],
    });

    expect(app.vault.create).toHaveBeenCalledOnce();
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/My project_tasks/do-the-thing.md");
  });

  it("uses a 16-char alphanumeric id in frontmatter (not a UUID)", async () => {
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      title: "Task one",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Task,
      progress: 0,
      start: null,
      due: null,
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const idMatch = content.match(/^id: "([^"]+)"/m);
    expect(idMatch).not.toBeNull();
    expect(idMatch![1]).toMatch(/^[a-z0-9]{16}$/);
  });

  it("starts the body with 'Project: [[projectBasename|projectTitle]]'", async () => {
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Test project.md",
      projectTitle: "Test project",
      title: "My task",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Task,
      progress: 0,
      start: null,
      due: null,
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n([\s\S]*)$/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1].trim()).toBe("Project: [[Test project|Test project]]");
  });

  it("appends user description after the Project: line when provided", async () => {
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      title: "Task",
      description: "Some notes here.",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Task,
      progress: 0,
      start: null,
      due: null,
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
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      title: "Top",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Task,
      progress: 0,
      start: null,
      due: null,
      tags: [],
      dependencies: [],
    });

    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// creating a task — subtask
// ---------------------------------------------------------------------------

describe("creating a task — subtask", () => {
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
  let parentTask: ProjectTask;

  beforeEach(() => {
    app = makeApp({ "Projects/Alpha_tasks/parent-task.md": parentContent });
    parentTask = makeTask({
      id: "parentid0000001",
      title: "Parent task",
      filePath: "Projects/Alpha_tasks/parent-task.md",
    });
  });

  it("starts the body with 'Parent: [[parentBasename|parentTitle]]'", async () => {
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Subtask,
      progress: 0,
      start: null,
      due: null,
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n([\s\S]*)$/);
    expect(bodyMatch![1].trim()).toBe("Parent: [[parent-task|Parent task]]");
  });

  it("writes parentId into the subtask frontmatter", async () => {
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Subtask,
      progress: 0,
      start: null,
      due: null,
      tags: [],
      dependencies: [],
    });

    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain(`parentId: "parentid0000001"`);
  });

  it("adds the new subtask id to the parent subtaskIds via processFrontMatter", async () => {
    const newId = await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Subtask,
      progress: 0,
      start: null,
      due: null,
      tags: [],
      dependencies: [],
    });

    expect(app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
    const parentFileContent = app._files.get("Projects/Alpha_tasks/parent-task.md")!;
    expect(parentFileContent).toContain(newId);
  });

  it("appends a subtask link to the parent body ## Subtasks section", async () => {
    await taskWrites(app).createTask( {
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "Sub task",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Subtask,
      progress: 0,
      start: null,
      due: null,
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

    await taskWrites(app2).createTask({
      projectId: "proj-1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask,
      title: "New sub",
      description: "",
      status: "todo",
      priority: Priority.None,
      type: TaskType.Subtask,
      progress: 0,
      start: null,
      due: null,
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
// deleting a task
// ---------------------------------------------------------------------------

describe("deleting a task", () => {
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

    await taskWrites(app).deleteTask(task);

    expect(app.fileManager.trashFile).toHaveBeenCalledOnce();
    expect(app._files.has("Projects/Alpha_tasks/do-thing.md")).toBe(false);
  });

  it("throws when the file does not exist", async () => {
    const app = makeApp();
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/missing.md" });

    await expect(taskWrites(app).deleteTask(task)).rejects.toThrow("File not found");
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

    await taskWrites(app).deleteTask(task, [], parent);

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

    await taskWrites(app).deleteTask(task, [], parent);

    // The body edit goes through `vault.process` — see `removeChildEntry`.
    expect(app.vault.process).toHaveBeenCalledOnce();
    const updatedContent = await (app.vault.process as ReturnType<typeof vi.fn>).mock.results[0].value as string;
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

    await taskWrites(app).deleteTask(task, [task, dependent], undefined);

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

    await taskWrites(app).deleteTask(task, [task, depA, depB], undefined);

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

    await taskWrites(app).deleteTask(task, [task, unrelated], undefined);

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

    await taskWrites(app).deleteTask(task, [task, child], undefined);

    expect(app._files.has("Projects/Alpha_tasks/do-thing.md")).toBe(false);
    expect(app._files.has("Projects/Alpha_tasks/child-task.md")).toBe(false);
    expect(app.fileManager.trashFile).toHaveBeenCalledTimes(2);
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

    await taskWrites(app).deleteTask(task, [task, child, dependent], undefined);

    expect(app._files.has("Projects/Alpha_tasks/child-task.md")).toBe(false);
    const updatedDependent = app._files.get("Projects/Alpha_tasks/dependent.md")!;
    expect(updatedDependent).not.toContain("childid000000001");
  });
});

// ---------------------------------------------------------------------------
// adding a dependency
// ---------------------------------------------------------------------------

describe("adding a dependency", () => {
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
    await expect(makeTaskNotes(app).file(task.filePath).addDependency("depid000000001")).rejects.toThrow("File not found");
  });

  it("adds a new dependency id to the frontmatter", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md" });

    await makeTaskNotes(app).file(task.filePath).addDependency("depid000000001");

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

    await makeTaskNotes(app).file(task.filePath).addDependency("depid000000001");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    const matches = updated.match(/depid000000001/g);
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removing a dependency
// ---------------------------------------------------------------------------

describe("removing a dependency", () => {
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
    await expect(makeTaskNotes(app).file(task.filePath).removeDependency("depid000000001")).rejects.toThrow("File not found");
  });

  it("removes an existing dependency id from the frontmatter", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md", dependencies: ["depid000000001"] });

    await makeTaskNotes(app).file(task.filePath).removeDependency("depid000000001");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).not.toContain("depid000000001");
  });

  it("is a no-op when the dependency is not present", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });
    const task = makeTask({ id: "taskid00000001", filePath: "Projects/Alpha_tasks/do-thing.md", dependencies: ["depid000000001"] });

    await makeTaskNotes(app).file(task.filePath).removeDependency("otherid0000001");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain("depid000000001");
  });
});

// ---------------------------------------------------------------------------
// patching a field
// ---------------------------------------------------------------------------

describe("patching a deadline", () => {
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
  const PATH = "Projects/Alpha_tasks/do-thing.md";

  it("writes the deadline as a plain day", async () => {
    const app = makeApp({ [PATH]: taskContent });
    await setField(makeTaskNotes(app).file(PATH), "due", day("2026-08-04"));
    expect(app._files.get(PATH)).toContain('due: "2026-08-04"');
  });

  it("clears the deadline", async () => {
    const app = makeApp({ [PATH]: taskContent });
    await setField(makeTaskNotes(app).file(PATH), "due", day("2026-08-04"));
    await setField(makeTaskNotes(app).file(PATH), "due", undefined);
    expect(app._files.get(PATH)).not.toContain("due:");
  });

  it("throws when the file does not exist", async () => {
    await expect(setField(makeTaskNotes(makeApp()).file("Projects/missing.md"), "due", undefined))
      .rejects.toThrow("File not found");
  });
});

describe("patching a field", () => {
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
    await expect(setField(makeTaskNotes(app).file("Projects/missing.md"), "status", "done")).rejects.toThrow("File not found");
  });

  it("sets the priority field", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });

    await setField(makeTaskNotes(app).file("Projects/Alpha_tasks/do-thing.md"), "priority", Priority.High);

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

    await setField(makeTaskNotes(app).file("Projects/Alpha_tasks/do-thing.md"), "priority", undefined);

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).not.toContain("priority");
  });

  it("sets the status field", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });

    await setField(makeTaskNotes(app).file("Projects/Alpha_tasks/do-thing.md"), "status", "in-progress");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain('status: "in-progress"');
  });

  it("adds a completed timestamp when status is set to done", async () => {
    const app = makeApp({ "Projects/Alpha_tasks/do-thing.md": taskContent });

    await setField(makeTaskNotes(app).file("Projects/Alpha_tasks/do-thing.md"), "status", "done");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toMatch(/completed: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/);
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

    await setField(makeTaskNotes(app).file("Projects/Alpha_tasks/do-thing.md"), "status", "todo");

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

    await setField(makeTaskNotes(app).file("Projects/Alpha_tasks/do-thing.md"), "status", "cancelled");

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

    await setField(makeTaskNotes(app).file("Projects/Alpha_tasks/do-thing.md"), "status", "done");

    const updated = app._files.get("Projects/Alpha_tasks/do-thing.md")!;
    expect(updated).toContain('completed: "2026-06-01"');
  });
});

// ---------------------------------------------------------------------------
// creating a task — optional frontmatter fields
// ---------------------------------------------------------------------------

describe("creating a task — the store's reading of it", () => {
  // What `adopt` is for: the note as written is the store's reading of it, so a caller has
  // the task before Obsidian has parsed the file and with no vault event to wait on.
  it("holds the new task as written", async () => {
    const app = makeApp();
    const vault = new VaultData(app, () => DEFAULT_SETTINGS);
    const id = await vault.projects.createTask({ ...baseCreateOpts, title: "Do the thing" });
    const held = vault.projectTasks.file("Projects/My project_tasks/do-the-thing.md").snapshot();
    expect(held).toMatchObject({ id, title: "Do the thing", projectId: "proj-1" });
  });

  // The parent's `## Tasks` line is written by the listing, which has no reading to move
  // ahead for a project the folder never read — so it asks for one.
  it("marks the project it listed the task on", async () => {
    const app = makeApp({
      "Projects/My project.md": [
        "---", "pm-project: true", 'id: "proj-1"', 'title: "My project"', "---", "", "## Tasks", "",
      ].join("\n"),
    });
    const vault = new VaultData(app, () => DEFAULT_SETTINGS);
    const marked = vi.spyOn(vault.projectNotes, "invalidate");
    await vault.projects.createTask({ ...baseCreateOpts });
    expect(marked.mock.calls.flat(2)).toContain("Projects/My project.md");
  });
});

describe("creating a task — optional frontmatter fields", () => {
  it("writes priority when set", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, priority: Priority.High });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain("priority: high");
  });

  it("omits priority when empty", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, priority: Priority.None });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("priority");
  });

  it("writes start date when provided", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, start: day("2026-07-01") });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('start: "2026-07-01"');
  });

  it("omits start when empty", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, start: null });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("start:");
  });

  it("writes due date when provided", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, due: day("2026-08-31") });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('due: "2026-08-31"');
  });

  it("omits due when empty", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, due: null });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("due:");
  });

  it("writes progress when greater than 0", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, progress: 50 });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain("progress: 50");
  });

  it("omits progress when 0", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, progress: 0 });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("progress:");
  });

  it("writes tags array when non-empty", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, tags: ["alpha", "beta"] });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('"alpha"');
    expect(content).toContain('"beta"');
  });

  it("omits tags field when array is empty", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, tags: [] });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).not.toContain("tags:");
  });

  it("writes inline dependencies when non-empty", async () => {
    const app = makeApp();
    await taskWrites(app).createTask( { ...baseCreateOpts, dependencies: ["dep1111111111111"] });
    const [, content] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(content).toContain('"dep1111111111111"');
  });
});

// ---------------------------------------------------------------------------
// creating a task — filename collision
// ---------------------------------------------------------------------------

describe("creating a task — filename collision", () => {
  it("appends a counter suffix when the slug filename already exists", async () => {
    const app = makeApp({ "Projects/My project_tasks/task.md": "existing" });
    await taskWrites(app).createTask( { ...baseCreateOpts, title: "Task" });
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/My project_tasks/task-2.md");
  });

  it("increments the counter until a free name is found", async () => {
    const app = makeApp({
      "Projects/My project_tasks/task.md": "existing",
      "Projects/My project_tasks/task-2.md": "existing",
    });
    await taskWrites(app).createTask( { ...baseCreateOpts, title: "Task" });
    const [path] = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(path).toBe("Projects/My project_tasks/task-3.md");
  });
});

