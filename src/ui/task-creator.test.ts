import { vi, describe, it, expect } from "vitest";

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

import { openNoteFile, priorityDropdownItems, statusDropdownItems } from "./task-creator";
import { PRIORITIES, STATUSES, Priority, Status, PRIORITY_LABELS, STATUS_LABELS } from "../model/base-task";
import { asApp } from "../model/__testing__/as-app";

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

  return asApp({ vault, fileManager, _files: files });
}

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
    // Through Object.assign: `workspace` is a stub of the slice these tests exercise,
    // not the whole of Obsidian's.
    Object.assign(app, { workspace });
    return { app, workspace };
  }

  it("does nothing when the file does not exist in the vault", () => {
    const { app, workspace } = makeAppWithWorkspace();
    openNoteFile(app, "Projects/missing.md");
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("reveals an existing leaf when the file is already open", () => {
    const { app, workspace } = makeAppWithWorkspace({ "Projects/task.md": "content" });
    const existingLeaf = { view: { file: new MockTFile("Projects/task.md") } };
    workspace.iterateAllLeaves = vi.fn((cb: (leaf: typeof existingLeaf) => void) => cb(existingLeaf));
    openNoteFile(app, "Projects/task.md");
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("opens a new leaf when the file is not currently open", () => {
    const { app, workspace } = makeAppWithWorkspace({ "Projects/task.md": "content" });
    workspace.iterateAllLeaves = vi.fn(); // no leaves call the callback
    openNoteFile(app, "Projects/task.md");
    expect(workspace.getLeaf).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The pickers' rows
// ---------------------------------------------------------------------------

describe("priorityDropdownItems", () => {
  const items = (current?: Priority) => priorityDropdownItems(current, () => {});

  it("offers the vocabulary, in its order", () => {
    expect(items().map((i) => i.label)).toEqual(PRIORITIES.map((p) => PRIORITY_LABELS[p]));
  });

  // A row with no colour is drawn without a dot, which pulls its label left of every other
  // one. `None` has no colour of its own, so it takes the neutral one and stays in line.
  it("gives every row a dot, None included", () => {
    expect(items().every((i) => !!i.color)).toBe(true);
  });

  it("ticks the priority in force", () => {
    expect(items(Priority.High).filter((i) => i.selected).map((i) => i.label)).toEqual(["High"]);
  });

  it("reads a task carrying no priority as None", () => {
    expect(items(undefined).filter((i) => i.selected).map((i) => i.label)).toEqual(["None"]);
  });

  it("hands the picked priority to the caller", () => {
    const picked: Priority[] = [];
    priorityDropdownItems(Priority.None, (p) => picked.push(p))
      .find((i) => i.label === "Critical")!.onSelect();
    expect(picked).toEqual([Priority.Critical]);
  });
});

describe("statusDropdownItems", () => {
  const items = (current = "") => statusDropdownItems(current, () => {});

  it("offers the vocabulary, in its order", () => {
    expect(items().map((i) => i.label)).toEqual(STATUSES.map((s) => STATUS_LABELS[s]));
  });

  it("gives every row a dot", () => {
    expect(items().every((i) => !!i.color)).toBe(true);
  });

  it("ticks the status in force", () => {
    expect(items(Status.Blocked).filter((i) => i.selected).map((i) => i.label)).toEqual(["Blocked"]);
  });

  it("ticks nothing for a status it does not know", () => {
    expect(items("wat").filter((i) => i.selected)).toEqual([]);
  });

  it("hands the picked status to the caller", () => {
    const picked: Status[] = [];
    statusDropdownItems(Status.Todo, (s) => picked.push(s))
      .find((i) => i.label === "Done")!.onSelect();
    expect(picked).toEqual([Status.Done]);
  });
});
