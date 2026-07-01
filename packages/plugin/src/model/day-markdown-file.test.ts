import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
}));

import { TFile as TFileMock } from "obsidian";
import { DayMarkdownFile } from "./day-markdown-file";
import { DayTask, parseDate } from "./day-task";
import type { DailyNotesConfig } from "./week-summary";

// ---------------------------------------------------------------------------
// Vault mock
// ---------------------------------------------------------------------------

function makeVaultFile(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = Object.create((TFileMock as any).prototype);
  f.path = path;
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) =>
        store.has(path) ? makeVaultFile(path) : null,
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        store.set(path, content);
        return makeVaultFile(path);
      },
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any;
  return { app, store };
}

function task(line: string, idx = 0): DayTask {
  return DayTask.parse(line, idx)!;
}

// ---------------------------------------------------------------------------
// parseTasks
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.parseTasks", () => {
  it("returns [] for a non-existent file", async () => {
    const { app } = makeApp();
    expect(await new DayMarkdownFile(app, "missing.md").parseTasks()).toEqual([]);
  });

  it("skips non-task lines", async () => {
    const { app } = makeApp({ "f.md": "# Heading\n\nsome text\n- plain bullet" });
    expect(await new DayMarkdownFile(app, "f.md").parseTasks()).toHaveLength(0);
  });

  it("parses tasks and assigns correct lineIndex", async () => {
    const { app } = makeApp({ "f.md": "# Day\n- [ ] Task A\n- [x] Task B ✅ 2026-06-30" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Task A");
    expect(tasks[0].lineIndex).toBe(1);
    expect(tasks[1].lineIndex).toBe(2);
  });

  it("populates subLines for each task from surrounding indented lines", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(tasks[1].subLines).toEqual([]);
  });

  it("does not include sub-lines as separate tasks", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Parent\n  - [ ] Nested" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subLines).toEqual(["  - [ ] Nested"]);
  });

  it("normalizes CRLF so lineIndex and rawLine are consistent", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Task A\r\n- [ ] Task B" });
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks[1].lineIndex).toBe(1);
    expect(tasks[1].rawLine).not.toContain("\r");
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.remove", () => {
  it("returns null when the task is not found", async () => {
    const { app } = makeApp({ "f.md": "- [ ] Other" });
    expect(await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Missing"))).toBeNull();
  });

  it("removes the task and returns it as a DayTask", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma" });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Beta", 1));
    expect(removed).not.toBeNull();
    expect(removed!.title).toBe("Beta");
    expect(removed!.subLines).toEqual([]);
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Gamma");
  });

  it("includes indented sub-lines in the returned DayTask.subLines", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Task A\n  sub 1\n  sub 2\n- [ ] Task B",
    });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub 1", "  sub 2"]);
    expect(store.get("f.md")).toBe("- [ ] Task B");
  });

  it("stops sub-line collection at a blank line", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Task A\n  sub\n\n  unrelated\n- [ ] Task B",
    });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Task A"));
    expect(removed!.subLines).toEqual(["  sub"]);
    expect(store.get("f.md")).toBe("\n  unrelated\n- [ ] Task B");
  });

  it("falls back to rawLine when lineIndex is stale", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Inserted above\n- [ ] Target task" });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Target task", 0));
    expect(removed!.title).toBe("Target task");
    expect(store.get("f.md")).toBe("- [ ] Inserted above");
  });

  it("falls back to title search when rawLine is not present", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Morning run #daily" });
    const removed = await new DayMarkdownFile(app, "f.md").remove(task("- [ ] Morning run", 5));
    expect(removed).not.toBeNull();
    expect(store.get("f.md")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// removeCheckedTasks
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.removeCheckedTasks", () => {
  it("returns all unchecked tasks when nothing is checked", async () => {
    const { app } = makeApp({ "f.md": "- [ ] A\n- [ ] B" });
    const tasks = await new DayMarkdownFile(app, "f.md").removeCheckedTasks();
    expect(tasks).toHaveLength(2);
  });

  it("removes checked tasks and writes back", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Keep\n- [x] Done ✅ 2026-06-30\n- [ ] Also keep" });
    const tasks = await new DayMarkdownFile(app, "f.md").removeCheckedTasks();
    expect(tasks.map((t) => t.title)).toEqual(["Keep", "Also keep"]);
    expect(store.get("f.md")).not.toContain("Done");
  });

  it("also removes sub-lines of checked tasks", async () => {
    const { app, store } = makeApp({
      "f.md": "- [x] Done ✅ 2026-06-30\n  sub-note\n- [ ] Remaining",
    });
    await new DayMarkdownFile(app, "f.md").removeCheckedTasks();
    expect(store.get("f.md")).not.toContain("sub-note");
    expect(store.get("f.md")).toContain("Remaining");
  });

  it("returns [] for a non-existent file", async () => {
    const { app } = makeApp();
    expect(await new DayMarkdownFile(app, "missing.md").removeCheckedTasks()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.createTask", () => {
  it("appends an unchecked task with the given title and creation date", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Existing" });
    await new DayMarkdownFile(app, "f.md").createTask("New task", parseDate("2026-07-01"));
    expect(store.get("f.md")).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01");
  });

  it("creates the file when it does not exist", async () => {
    const { app, store } = makeApp();
    await new DayMarkdownFile(app, "new.md").createTask("First task", parseDate("2026-07-01"));
    expect(store.get("new.md")).toBe("- [ ] First task ➕ 2026-07-01");
  });

  it("embeds the creation date as ➕ in the task line", async () => {
    const { app } = makeApp();
    await new DayMarkdownFile(app, "f.md").createTask("Buy milk", parseDate("2026-06-15"));
    const tasks = await new DayMarkdownFile(app, "f.md").parseTasks();
    expect(tasks[0].createdAt).toEqual(parseDate("2026-06-15"));
  });
});

// ---------------------------------------------------------------------------
// addTask
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.addTask", () => {
  it("appends a task at the end when insertAt is omitted", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("creates the file when it does not exist", async () => {
    const { app, store } = makeApp();
    await new DayMarkdownFile(app, "new.md").addTask(task("- [ ] First"));
    expect(store.get("new.md")).toBe("- [ ] First");
  });

  it("appends task with its subLines (set via withSubLines)", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A" });
    const t = task("- [ ] B").withSubLines(["  sub 1", "  sub 2"]);
    await new DayMarkdownFile(app, "f.md").addTask(t);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n  sub 1\n  sub 2");
  });

  it("to add sub-lines with createTask, build the DayTask with create+withSubLines then call addTask", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Existing" });
    const t = DayTask.create("New task", parseDate("2026-07-01")).withSubLines(["  - note A", "  - note B"]);
    await new DayMarkdownFile(app, "f.md").addTask(t);
    expect(store.get("f.md")).toBe("- [ ] Existing\n- [ ] New task ➕ 2026-07-01\n  - note A\n  - note B");
  });

  it("trims trailing whitespace from existing content before appending", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"));
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });

  it("inserts at the beginning when insertAt is 0", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] A"), 0);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("inserts in the middle when insertAt is given", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"), 1);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B\n- [ ] C");
  });

  it("clamps an out-of-bounds insertAt to the end", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A" });
    await new DayMarkdownFile(app, "f.md").addTask(task("- [ ] B"), 999);
    expect(store.get("f.md")).toBe("- [ ] A\n- [ ] B");
  });
});

// ---------------------------------------------------------------------------
// moveTask
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.moveTask", () => {
  it("moves a task down", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").moveTask(task("- [ ] A"), 2);
    expect(store.get("f.md")).toBe("- [ ] B\n- [ ] A\n- [ ] C");
  });

  it("moves a task up", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await new DayMarkdownFile(app, "f.md").moveTask(task("- [ ] C", 2), 0);
    expect(store.get("f.md")).toBe("- [ ] C\n- [ ] A\n- [ ] B");
  });

  it("moves a task group (with sub-lines) down", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Task A\n  sub-line\n- [ ] Task B" });
    await new DayMarkdownFile(app, "f.md").moveTask(task("- [ ] Task A"), 3);
    expect(store.get("f.md")).toBe("- [ ] Task B\n- [ ] Task A\n  sub-line");
  });

  it("moves a task group (with sub-lines) up", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Task A\n- [ ] Task B\n  sub 1\n  sub 2",
    });
    await new DayMarkdownFile(app, "f.md").moveTask(task("- [ ] Task B", 1), 0);
    expect(store.get("f.md")).toBe("- [ ] Task B\n  sub 1\n  sub 2\n- [ ] Task A");
  });

  it("does nothing when task is not found", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] A" });
    await new DayMarkdownFile(app, "f.md").moveTask(task("- [ ] Missing", 5), 0);
    expect(store.get("f.md")).toBe("- [ ] A");
  });
});

// ---------------------------------------------------------------------------
// checkTask / uncheckTask
// ---------------------------------------------------------------------------

describe("DayMarkdownFile.checkTask", () => {
  it("marks the task as done and appends the date", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Alpha\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").checkTask(task("- [ ] Alpha"), parseDate("2026-07-01"));
    expect(store.get("f.md")).toBe("- [x] Alpha ✅ 2026-07-01\n- [ ] Beta");
  });

  it("does not modify sub-lines", async () => {
    const { app, store } = makeApp({ "f.md": "- [ ] Task\n  sub-note" });
    await new DayMarkdownFile(app, "f.md").checkTask(task("- [ ] Task"), parseDate("2026-07-01"));
    expect(store.get("f.md")).toContain("  sub-note");
  });
});

describe("DayMarkdownFile.uncheckTask", () => {
  it("marks the task as undone and strips the ✅ date", async () => {
    const { app, store } = makeApp({ "f.md": "- [x] Alpha ✅ 2026-06-30\n- [ ] Beta" });
    await new DayMarkdownFile(app, "f.md").uncheckTask(task("- [x] Alpha ✅ 2026-06-30"));
    expect(store.get("f.md")).toBe("- [ ] Alpha\n- [ ] Beta");
  });

  it("falls back to rawLine when lineIndex is stale", async () => {
    const { app, store } = makeApp({
      "f.md": "- [ ] Inserted\n- [x] Done ✅ 2026-06-30",
    });
    await new DayMarkdownFile(app, "f.md").uncheckTask(task("- [x] Done ✅ 2026-06-30", 0));
    expect(store.get("f.md")).toBe("- [ ] Inserted\n- [ ] Done");
  });
});

// ---------------------------------------------------------------------------
// Cross-file move: remove → addTask round-trip
// ---------------------------------------------------------------------------

describe("cross-file move (remove → addTask)", () => {
  it("transfers task + sub-lines from one file to another", async () => {
    const { app, store } = makeApp({
      "source.md": "- [ ] Task\n  sub-line\n- [ ] Other",
      "target.md": "- [ ] Existing",
    });
    const removed = await new DayMarkdownFile(app, "source.md").remove(task("- [ ] Task"));
    await new DayMarkdownFile(app, "target.md").addTask(removed!);
    expect(store.get("source.md")).toBe("- [ ] Other");
    expect(store.get("target.md")).toBe("- [ ] Existing\n- [ ] Task\n  sub-line");
  });

  it("creates the target file if it does not exist", async () => {
    const { app, store } = makeApp({ "source.md": "- [ ] Only task" });
    const removed = await new DayMarkdownFile(app, "source.md").remove(task("- [ ] Only task"));
    await new DayMarkdownFile(app, "target.md").addTask(removed!);
    expect(store.has("target.md")).toBe(true);
    expect(store.get("target.md")).toBe("- [ ] Only task");
  });
});

// ---------------------------------------------------------------------------
// DayTask.withSubLines
// ---------------------------------------------------------------------------

describe("DayTask.withSubLines", () => {
  it("returns a new task with the given sub-lines", () => {
    const t = DayTask.parse("- [ ] Task", 0)!;
    const withSubs = t.withSubLines(["  note 1", "  note 2"]);
    expect(withSubs.subLines).toEqual(["  note 1", "  note 2"]);
  });

  it("preserves all other fields", () => {
    const t = DayTask.parse("- [x] Task ✅ 2026-07-01 #tag", 3)!;
    const withSubs = t.withSubLines(["  note"]);
    expect(withSubs.title).toBe("Task #tag");
    expect(withSubs.checked).toBe(true);
    expect(withSubs.completedAt).toEqual(parseDate("2026-07-01"));
    expect(withSubs.lineIndex).toBe(3);
    expect(withSubs.rawLine).toBe(t.rawLine);
  });

  it("parse() defaults subLines to []", () => {
    expect(DayTask.parse("- [ ] Task", 0)!.subLines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DayMarkdownFile.ensure
// ---------------------------------------------------------------------------

function makeEnsureApp(
  initialFiles: Record<string, string> = {},
  options: {
    dailyNotesConfig?: Partial<DailyNotesConfig>;
    existingFolders?: string[];
    templaterPlugin?: { create_new_note_from_template: (...args: unknown[]) => Promise<unknown> };
  } = {},
) {
  const store = new Map(Object.entries(initialFiles));
  const folders = new Set(options.existingFolders ?? []);
  const configJson = options.dailyNotesConfig
    ? JSON.stringify(options.dailyNotesConfig)
    : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: (path: string) => {
        if (store.has(path)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const f = Object.create((TFileMock as any).prototype);
          f.path = path;
          return f;
        }
        if (folders.has(path)) return { path }; // simulate existing folder
        return null;
      },
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        store.set(path, content);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const f = Object.create((TFileMock as any).prototype);
        f.path = path;
        return f;
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      adapter: {
        read: async (path: string) => {
          if (path === ".obsidian/daily-notes.json" && configJson) return configJson;
          throw new Error(`adapter.read: not found: ${path}`);
        },
      },
    },
    plugins: {
      plugins: options.templaterPlugin
        ? { "templater-obsidian": { templater: options.templaterPlugin } }
        : {},
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any;

  return { app, store, folders };
}

function mockDate(dateStr: string) {
  return { format: () => dateStr };
}

describe("DayMarkdownFile.ensure", () => {
  const cfg = (overrides: Partial<DailyNotesConfig> = {}): DailyNotesConfig => ({
    folder: "",
    format: "YYYY-MM-DD",
    template: "",
    ...overrides,
  });

  it("returns a DayMarkdownFile pointing to an existing note", async () => {
    const { app } = makeEnsureApp({ "2026-07-01.md": "- [ ] Task" });
    const dmf = await DayMarkdownFile.ensure(app, mockDate("2026-07-01"), cfg());
    expect(dmf).not.toBeNull();
    expect(dmf!.filePath).toBe("2026-07-01.md");
  });

  it("creates the file with empty content when it does not exist", async () => {
    const { app, store } = makeEnsureApp();
    const dmf = await DayMarkdownFile.ensure(app, mockDate("2026-07-01"), cfg());
    expect(dmf).not.toBeNull();
    expect(store.get("2026-07-01.md")).toBe("");
  });

  it("places the file in the configured folder", async () => {
    const { app, store } = makeEnsureApp({}, { existingFolders: ["Daily Notes"] });
    const dmf = await DayMarkdownFile.ensure(app, mockDate("2026-07-01"), cfg({ folder: "Daily Notes" }));
    expect(dmf!.filePath).toBe("Daily Notes/2026-07-01.md");
    expect(store.has("Daily Notes/2026-07-01.md")).toBe(true);
  });

  it("creates the folder when it does not exist", async () => {
    const { app, folders } = makeEnsureApp();
    await DayMarkdownFile.ensure(app, mockDate("2026-07-01"), cfg({ folder: "Daily Notes" }));
    expect(folders.has("Daily Notes")).toBe(true);
  });

  it("does not try to create an already-existing folder", async () => {
    const { app } = makeEnsureApp({}, { existingFolders: ["Notes"] });
    // createFolder would throw if called — we verify no error is thrown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).vault.createFolder = () => { throw new Error("should not be called"); };
    await expect(
      DayMarkdownFile.ensure(app, mockDate("2026-07-01"), cfg({ folder: "Notes" })),
    ).resolves.not.toBeNull();
  });

  it("seeds the file with raw template content when no Templater plugin is present", async () => {
    const { app, store } = makeEnsureApp({
      "templates/daily.md": "# Daily Note\n- [ ] Morning check-in",
    });
    const dmf = await DayMarkdownFile.ensure(
      app,
      mockDate("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    expect(store.get(dmf!.filePath)).toBe("# Daily Note\n- [ ] Morning check-in");
  });

  it("appends .md to template path when extension is missing", async () => {
    const { app, store } = makeEnsureApp({ "templates/daily.md": "template content" });
    const dmf = await DayMarkdownFile.ensure(
      app,
      mockDate("2026-07-01"),
      cfg({ template: "templates/daily" }),
    );
    expect(store.get(dmf!.filePath)).toBe("template content");
  });

  it("creates an empty file when the template path does not exist", async () => {
    const { app, store } = makeEnsureApp();
    const dmf = await DayMarkdownFile.ensure(
      app,
      mockDate("2026-07-01"),
      cfg({ template: "missing-template.md" }),
    );
    expect(store.get(dmf!.filePath)).toBe("");
  });

  it("delegates to Templater when the plugin is available", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createdFile = Object.create((TFileMock as any).prototype);
    createdFile.path = "2026-07-01.md";
    const createMock = vi.fn().mockResolvedValue(createdFile);
    const { app } = makeEnsureApp(
      { "templates/daily.md": "" },
      { templaterPlugin: { create_new_note_from_template: createMock } },
    );
    const dmf = await DayMarkdownFile.ensure(
      app,
      mockDate("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    expect(createMock).toHaveBeenCalledOnce();
    expect(dmf!.filePath).toBe("2026-07-01.md");
  });

  it("reads DailyNotesConfig from vault when not provided", async () => {
    const { app, store } = makeEnsureApp(
      {},
      { dailyNotesConfig: { folder: "Journal", format: "YYYY-MM-DD", template: "" } },
    );
    const dmf = await DayMarkdownFile.ensure(app, mockDate("2026-07-01"));
    expect(dmf!.filePath).toBe("Journal/2026-07-01.md");
    expect(store.has("Journal/2026-07-01.md")).toBe(true);
  });

  it("returns a usable DayMarkdownFile (parseTasks works on the created file)", async () => {
    const { app } = makeEnsureApp({ "templates/daily.md": "- [ ] Morning run" });
    const dmf = await DayMarkdownFile.ensure(
      app,
      mockDate("2026-07-01"),
      cfg({ template: "templates/daily.md" }),
    );
    const tasks = await dmf!.parseTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Morning run");
  });
});
