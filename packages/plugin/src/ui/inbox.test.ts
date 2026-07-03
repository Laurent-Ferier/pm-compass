import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock: obsidian
// ---------------------------------------------------------------------------

function makeDateMoment(d: Date) {
  return {
    format: (fmt: string) => {
      if (fmt === "YYYY-MM-DD") {
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${mo}-${day}`;
      }
      return "";
    },
  };
}

function mockMoment(...args: unknown[]) {
  if (args.length === 0) return makeDateMoment(new Date());
  if (args.length >= 2 && args[1] === "YYYY-MM-DD") {
    const [y, mo, day] = (args[0] as string).split("-").map(Number);
    return makeDateMoment(new Date(y, mo - 1, day));
  }
  return makeDateMoment(new Date(args[0] as string));
}

vi.mock("obsidian", () => ({
  App: class {},
  ItemView: class {
    contentEl = { empty: () => {}, createDiv: () => ({}) };
  },
  Menu: class {},
  Modal: class {},
  TFile: class {},
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  normalizePath: (p: string) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
  setIcon: () => {},
  moment: Object.assign(mockMoment, { isMoment: () => false }),
}));

vi.mock("./task-creator", () => ({
  TaskModal: class {},
  ConfirmModal: class {},
  patchTaskField: vi.fn(),
  deleteTaskFile: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

vi.mock("../model/vault-reader", () => ({ loadVaultData: vi.fn() }));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

import { TFile as TFileMock } from "obsidian";
import {
  resolveInboxPath,
  readInboxItems,
  appendInboxItem,
  removeInboxItem,
  scheduleInboxItem,
  rescheduleChecklistItem,
} from "./dashboard-view";
import { DayTask, parseDate } from "../model/day-task";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVaultFile(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = Object.create((TFileMock as any).prototype);
  f.path = path;
  return f;
}

type FakeFile = ReturnType<typeof makeVaultFile>;

interface FakeApp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vault: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: any;
}

function makeApp(initialFiles: Record<string, string> = {}): { app: FakeApp; files: Map<string, string> } {
  const files = new Map(Object.entries(initialFiles));

  const app: FakeApp = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: (path: string) =>
        files.has(path) ? makeVaultFile(path) : null,
      read: async (file: FakeFile) => files.get(file.path) ?? "",
      modify: async (file: FakeFile, content: string) => {
        files.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        files.set(path, content);
        return makeVaultFile(path);
      },
      createFolder: vi.fn(),
      adapter: {
        // Throws so readDailyNotesConfig falls back to defaults:
        // { folder: "", format: "YYYY-MM-DD", template: "" }
        read: async (_path: string) => {
          throw new Error("no daily-notes config in tests");
        },
      },
    },
    plugins: { plugins: {} },
  };

  return { app, files };
}

// Convenience: build a date moment for scheduleInboxItem / rescheduleChecklistItem
function dateMoment(dateStr: string) {
  const [y, mo, day] = dateStr.split("-").map(Number);
  return makeDateMoment(new Date(y, mo - 1, day));
}

// ---------------------------------------------------------------------------
// resolveInboxPath
// ---------------------------------------------------------------------------

describe("resolveInboxPath", () => {
  const defaultConfig = { folder: "Daily Notes", format: "YYYY-MM-DD", template: "" };

  it("returns the custom path when inboxFilePath is set", () => {
    expect(resolveInboxPath("Custom/Inbox.md", defaultConfig)).toBe("Custom/Inbox.md");
  });

  it("falls back to dailyNotes folder + /Inbox.md when inboxFilePath is empty", () => {
    expect(resolveInboxPath("", defaultConfig)).toBe("Daily Notes/Inbox.md");
  });

  it("falls back to Inbox.md at vault root when both inboxFilePath and folder are empty", () => {
    expect(resolveInboxPath("", { folder: "", format: "YYYY-MM-DD", template: "" })).toBe("Inbox.md");
  });

  it("normalizes slashes in a custom path", () => {
    // normalizePath in mock collapses double slashes
    expect(resolveInboxPath("Daily//Notes//Inbox.md", defaultConfig)).toBe("Daily/Notes/Inbox.md");
  });
});

// ---------------------------------------------------------------------------
// readInboxItems
// ---------------------------------------------------------------------------

describe("readInboxItems", () => {
  it("returns an empty array when the file does not exist", async () => {
    const { app } = makeApp();
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toEqual([]);
  });

  it("returns an empty array for an empty file", async () => {
    const { app } = makeApp({ "Daily Notes/Inbox.md": "" });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toEqual([]);
  });

  it("parses a single item with a creation date", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": "- [ ] Call dentist ➕ 2026-06-28",
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject<Partial<DayTask>>({
      title: "Call dentist",
      createdAt: parseDate("2026-06-28"),
      rawLine: "- [ ] Call dentist ➕ 2026-06-28",
    });
  });

  it("parses an item without a creation date (createdAt is null)", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": "- [ ] Buy groceries",
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject<Partial<DayTask>>({
      title: "Buy groceries",
      createdAt: null,
    });
  });

  it("ignores checked items (- [x]) and does not include them in the result", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": [
        "- [x] Done task",
        "- [ ] Pending task ➕ 2026-06-30",
      ].join("\n"),
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Pending task");
  });

  it("auto-cleans checked items from the file on read", async () => {
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": [
        "- [x] Already done",
        "- [ ] Still pending ➕ 2026-06-30",
      ].join("\n"),
    });
    await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(files.get("Daily Notes/Inbox.md")).not.toContain("Already done");
    expect(files.get("Daily Notes/Inbox.md")).toContain("Still pending");
  });

  it("handles case-insensitive checked marker [X]", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": [
        "- [X] Done with uppercase X",
        "- [ ] Still open",
      ].join("\n"),
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Still open");
  });

  it("sorts items by creation date DESC (most recent first)", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": [
        "- [ ] Old task ➕ 2026-06-20",
        "- [ ] Recent task ➕ 2026-06-30",
        "- [ ] Mid task ➕ 2026-06-25",
      ].join("\n"),
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result.map((i) => i.createdAt)).toEqual([parseDate("2026-06-30"), parseDate("2026-06-25"), parseDate("2026-06-20")]);
  });

  it("places undated items after all dated items", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": [
        "- [ ] No date task",
        "- [ ] Dated task ➕ 2026-06-28",
        "- [ ] Another no date",
      ].join("\n"),
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result[0].createdAt).toEqual(parseDate("2026-06-28"));
    expect(result[1].createdAt).toBeNull();
    expect(result[2].createdAt).toBeNull();
  });

  it("returns items in original order when all are undated", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": [
        "- [ ] Call dentist",
        "- [ ] Buy groceries",
      ].join("\n"),
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result[0].title).toBe("Call dentist");
    expect(result[1].title).toBe("Buy groceries");
  });

  it("ignores non-checklist lines", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": [
        "# Inbox",
        "",
        "- [ ] Real task ➕ 2026-06-30",
        "Some prose line",
      ].join("\n"),
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Real task");
  });
});

// ---------------------------------------------------------------------------
// appendInboxItem
// ---------------------------------------------------------------------------

describe("appendInboxItem", () => {
  const TODAY = "2026-06-30";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the file when it does not exist", async () => {
    const { app, files } = makeApp();
    await appendInboxItem(app, "Daily Notes/Inbox.md", "New task");
    expect(files.has("Daily Notes/Inbox.md")).toBe(true);
  });

  it("writes a line in the standard format with today's date", async () => {
    const { app, files } = makeApp();
    await appendInboxItem(app, "Daily Notes/Inbox.md", "New task");
    expect(files.get("Daily Notes/Inbox.md")).toBe(`- [ ] New task ➕ ${TODAY}`);
  });

  it("appends to an existing file", async () => {
    const existing = "- [ ] Old task ➕ 2026-06-28";
    const { app, files } = makeApp({ "Daily Notes/Inbox.md": existing });
    await appendInboxItem(app, "Daily Notes/Inbox.md", "New task");
    const content = files.get("Daily Notes/Inbox.md")!;
    expect(content).toContain("Old task");
    expect(content).toContain(`- [ ] New task ➕ ${TODAY}`);
  });

  it("separates the new line from existing content with a newline", async () => {
    const { app, files } = makeApp({ "Daily Notes/Inbox.md": "- [ ] Existing ➕ 2026-06-28" });
    await appendInboxItem(app, "Daily Notes/Inbox.md", "Second");
    const content = files.get("Daily Notes/Inbox.md")!;
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
  });

  it("uses today's date from the system clock", async () => {
    vi.setSystemTime(new Date("2026-07-15"));
    const { app, files } = makeApp();
    await appendInboxItem(app, "Daily Notes/Inbox.md", "Task");
    expect(files.get("Daily Notes/Inbox.md")).toContain("➕ 2026-07-15");
  });
});

// ---------------------------------------------------------------------------
// removeInboxItem
// ---------------------------------------------------------------------------

describe("removeInboxItem", () => {
  it("removes the exact raw line from the file", async () => {
    const rawLine = "- [ ] Call dentist ➕ 2026-06-28";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": [rawLine, "- [ ] Other task"].join("\n"),
    });
    await removeInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!);
    expect(files.get("Daily Notes/Inbox.md")).not.toContain("Call dentist");
    expect(files.get("Daily Notes/Inbox.md")).toContain("Other task");
  });

  it("does nothing when the file does not exist", async () => {
    const { app } = makeApp();
    await expect(
      removeInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse("- [ ] Missing", 0)!),
    ).resolves.toBeUndefined();
  });

  it("only removes the first occurrence of a duplicate line", async () => {
    const rawLine = "- [ ] Duplicate task";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": [rawLine, rawLine].join("\n"),
    });
    await removeInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!);
    const remaining = files.get("Daily Notes/Inbox.md")!.split("\n").filter(Boolean);
    expect(remaining).toHaveLength(1);
  });

  it("leaves the file empty when its only line is removed", async () => {
    const rawLine = "- [ ] Only task ➕ 2026-06-30";
    const { app, files } = makeApp({ "Daily Notes/Inbox.md": rawLine });
    await removeInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!);
    const content = files.get("Daily Notes/Inbox.md")!;
    expect(content.split("\n").filter(Boolean)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scheduleInboxItem
// ---------------------------------------------------------------------------

describe("scheduleInboxItem", () => {
  it("removes the item from the inbox", async () => {
    const rawLine = "- [ ] Dentist ➕ 2026-06-28";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await scheduleInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!, dateMoment("2026-07-05"));
    expect(files.get("Daily Notes/Inbox.md")).not.toContain("Dentist");
  });

  it("adds the raw line verbatim (preserving ➕ date) to the target daily note", async () => {
    const rawLine = "- [ ] Dentist ➕ 2026-06-28";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await scheduleInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!, dateMoment("2026-07-05"));
    expect(files.get("2026-07-05.md")).toContain("➕ 2026-06-28");
    expect(files.get("2026-07-05.md")).toContain("Dentist");
  });

  it("creates the daily note when it does not exist", async () => {
    const rawLine = "- [ ] New appointment ➕ 2026-06-30";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await scheduleInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!, dateMoment("2026-07-10"));
    expect(files.has("2026-07-10.md")).toBe(true);
  });

  it("appends to an existing daily note", async () => {
    const rawLine = "- [ ] Extra task ➕ 2026-06-30";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
      "2026-07-05.md": "- [ ] Existing item",
    });
    await scheduleInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!, dateMoment("2026-07-05"));
    const content = files.get("2026-07-05.md")!;
    expect(content).toContain("Existing item");
    expect(content).toContain("Extra task");
  });

  it("does not strip the creation date from the line added to the daily note", async () => {
    const rawLine = "- [ ] Review docs ➕ 2026-05-01";
    const { app, files } = makeApp({ "Daily Notes/Inbox.md": rawLine });
    await scheduleInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!, dateMoment("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe(rawLine);
  });
});

// ---------------------------------------------------------------------------
// rescheduleChecklistItem
// ---------------------------------------------------------------------------

describe("rescheduleChecklistItem", () => {
  it("removes the line at the specified index from the source file", async () => {
    const { app, files } = makeApp({
      "2026-06-29.md": [
        "- [ ] Morning standup",
        "- [ ] Write tests",
        "- [ ] Review PR",
      ].join("\n"),
    });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [ ] Write tests", 1)!, dateMoment("2026-07-01"));
    const lines = files.get("2026-06-29.md")!.split("\n");
    expect(lines).not.toContain("- [ ] Write tests");
    expect(lines).toContain("- [ ] Morning standup");
    expect(lines).toContain("- [ ] Review PR");
  });

  it("adds a fresh unchecked item to the target daily note", async () => {
    const { app, files } = makeApp({
      "2026-06-29.md": "- [ ] Write tests",
    });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [ ] Write tests", 0)!, dateMoment("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe("- [ ] Write tests");
  });

  it("creates the target daily note when it does not exist", async () => {
    const { app, files } = makeApp({
      "2026-06-29.md": "- [ ] Task to move",
    });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [ ] Task to move", 0)!, dateMoment("2026-07-15"));
    expect(files.has("2026-07-15.md")).toBe(true);
  });

  it("appends to an existing target daily note", async () => {
    const { app, files } = makeApp({
      "2026-06-29.md": "- [ ] Task to move",
      "2026-07-01.md": "- [ ] Already there",
    });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [ ] Task to move", 0)!, dateMoment("2026-07-01"));
    const content = files.get("2026-07-01.md")!;
    expect(content).toContain("Already there");
    expect(content).toContain("Task to move");
  });

  it("does nothing when the source file does not exist", async () => {
    const { app } = makeApp();
    await expect(
      rescheduleChecklistItem(app, "ghost.md", DayTask.parse("- [ ] Task", 0)!, dateMoment("2026-07-01")),
    ).resolves.toBeUndefined();
  });

  it("resets the item to unchecked and strips the ✅ date", async () => {
    const { app, files } = makeApp({
      "2026-06-29.md": "- [x] Done task ✅ 2026-06-29",
    });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [x] Done task ✅ 2026-06-29", 0)!, dateMoment("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe("- [ ] Done task");
  });

  it("preserves metadata (tags, due date, priority) in the rescheduled line", async () => {
    const raw = "- [ ] Review PR #work 📅 2026-06-29 ⏫";
    const { app, files } = makeApp({ "2026-06-29.md": raw });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse(raw, 0)!, dateMoment("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe(raw);
  });

  it("does not delete from source when ensureDailyNote fails", async () => {
    const rawSource = "- [ ] Important task";
    const { app, files } = makeApp({ "2026-06-29.md": rawSource });
    // Make vault.create throw so ensureDailyNote returns null-equivalent
    app.vault.create = async () => { throw new Error("disk full"); };
    // ensureDailyNote calls vault.create and re-throws, causing it to propagate
    await expect(
      rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse(rawSource, 0)!, dateMoment("2026-07-01")),
    ).rejects.toThrow();
    // Source must be untouched
    expect(files.get("2026-06-29.md")).toBe(rawSource);
  });

  it("finds the item by rawLine when lineIndex is stale", async () => {
    const { app, files } = makeApp({
      // A line was inserted above the target between render and click
      "2026-06-29.md": [
        "- [ ] New line inserted above",
        "- [ ] Target task",
      ].join("\n"),
    });
    // lineIndex=0 now points to the wrong line; rawLine fallback finds it at index 1
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [ ] Target task", 0)!, dateMoment("2026-07-01"));
    expect(files.get("2026-06-29.md")).toBe("- [ ] New line inserted above");
    expect(files.get("2026-07-01.md")).toBe("- [ ] Target task");
  });
});

// ---------------------------------------------------------------------------
// readInboxItems — lineIndex and CRLF normalization
// ---------------------------------------------------------------------------

describe("readInboxItems — lineIndex", () => {
  it("stores the original file line index on each item", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": [
        "# Inbox",
        "- [ ] First task ➕ 2026-06-28",
        "- [ ] Second task ➕ 2026-06-29",
      ].join("\n"),
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    // Sorted DESC by date: Second (line 2) before First (line 1)
    expect(result[0].title).toBe("Second task");
    expect(result[0].lineIndex).toBe(2);
    expect(result[1].title).toBe("First task");
    expect(result[1].lineIndex).toBe(1);
  });

  it("normalizes CRLF line endings so rawLine never contains \\r", async () => {
    const { app } = makeApp({
      "Daily Notes/Inbox.md": "- [ ] Task one ➕ 2026-06-28\r\n- [ ] Task two",
    });
    const result = await readInboxItems(app, "Daily Notes/Inbox.md");
    expect(result).toHaveLength(2);
    expect(result.every((i) => !i.rawLine.includes("\r"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removeInboxItem — lineIndex disambiguation and spurious-write guard
// ---------------------------------------------------------------------------

describe("removeInboxItem — lineIndex and spurious-write guard", () => {
  it("uses lineIndex to remove the correct item when duplicates exist", async () => {
    const rawLine = "- [ ] Duplicate task";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": [rawLine, rawLine].join("\n"),
    });
    // lineIndex=1 targets the second occurrence
    await removeInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 1)!);
    const remaining = files.get("Daily Notes/Inbox.md")!.split("\n");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(rawLine);
  });

  it("does not write to the file when the item is not found", async () => {
    const { app } = makeApp({ "Daily Notes/Inbox.md": "- [ ] Existing task" });
    let writeCalled = false;
    const origModify = app.vault.modify;
    app.vault.modify = async (...args: unknown[]) => { writeCalled = true; return origModify(...args); };
    await removeInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse("- [ ] Ghost task", 0)!);
    expect(writeCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sub-line handling — indented lines travel with their parent task
// ---------------------------------------------------------------------------

describe("removeInboxItem — sub-lines", () => {
  it("removes indented sub-lines together with the task", async () => {
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": [
        "- [ ] Parent task ➕ 2026-06-28",
        "  - note A",
        "  - note B",
        "- [ ] Other task",
      ].join("\n"),
    });
    await removeInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse("- [ ] Parent task ➕ 2026-06-28", 0)!);
    const content = files.get("Daily Notes/Inbox.md")!;
    expect(content).not.toContain("Parent task");
    expect(content).not.toContain("note A");
    expect(content).not.toContain("note B");
    expect(content).toContain("Other task");
  });
});

describe("scheduleInboxItem — sub-lines", () => {
  it("moves indented sub-lines to the daily note along with the task", async () => {
    const rawLine = "- [ ] Design meeting ➕ 2026-06-28";
    const { app, files } = makeApp({
      "Daily Notes/Inbox.md": [
        rawLine,
        "  - agenda item 1",
        "  - agenda item 2",
        "- [ ] Other task",
      ].join("\n"),
    });
    await scheduleInboxItem(app, "Daily Notes/Inbox.md", DayTask.parse(rawLine, 0)!, dateMoment("2026-07-05"));
    const inbox = files.get("Daily Notes/Inbox.md")!;
    expect(inbox).not.toContain("Design meeting");
    expect(inbox).not.toContain("agenda item");
    expect(inbox).toContain("Other task");
    const daily = files.get("2026-07-05.md")!;
    expect(daily).toContain("Design meeting");
    expect(daily).toContain("agenda item 1");
    expect(daily).toContain("agenda item 2");
  });
});

describe("rescheduleChecklistItem — sub-lines", () => {
  it("moves indented sub-lines to the target daily note", async () => {
    const { app, files } = makeApp({
      "2026-06-29.md": [
        "- [ ] Write report",
        "  - section 1",
        "  - section 2",
        "- [ ] Other task",
      ].join("\n"),
    });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [ ] Write report", 0)!, dateMoment("2026-07-01"));
    const source = files.get("2026-06-29.md")!;
    expect(source).not.toContain("Write report");
    expect(source).not.toContain("section");
    expect(source).toContain("Other task");
    const target = files.get("2026-07-01.md")!;
    expect(target).toContain("Write report");
    expect(target).toContain("section 1");
    expect(target).toContain("section 2");
  });

  it("keeps sub-lines unchecked when the parent was checked", async () => {
    const { app, files } = makeApp({
      "2026-06-29.md": [
        "- [x] Done task ✅ 2026-06-29",
        "  - sub-note",
      ].join("\n"),
    });
    await rescheduleChecklistItem(app, "2026-06-29.md", DayTask.parse("- [x] Done task ✅ 2026-06-29", 0)!, dateMoment("2026-07-01"));
    const target = files.get("2026-07-01.md")!;
    expect(target).toContain("- [ ] Done task");
    expect(target).toContain("  - sub-note");
  });
});
