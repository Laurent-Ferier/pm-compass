// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock: obsidian
// ---------------------------------------------------------------------------

function makeDateMoment(d: Date) {
  return {
    toDate: () => new Date(d),
    isValid: () => !Number.isNaN(d.getTime()),
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
    // The strict parse a day note's name goes through: anything else is no day, which is
    // how the store tells its own paths from the rest.
    const [, y, mo, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args[0] as string) ?? [];
    return makeDateMoment(y ? new Date(Number(y), Number(mo) - 1, Number(day)) : new Date(NaN));
  }
  return makeDateMoment(args[0] instanceof Date ? new Date(args[0]) : new Date(args[0] as string));
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

vi.mock("./task-creator", async (importOriginal) => ({
  // Spread the original so value exports (enums the callers branch on)
  // survive the mock; only the behaviours below are replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  TaskModal: class {},
  ConfirmModal: class {},
  patchTaskField: vi.fn(),
  deleteTaskFile: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

import { TFile as TFileMock } from "obsidian";
import { ScheduleOutcome } from "./task-service";
import { Task } from "../daily/task";
import { bare } from "../__testing__/bare";
import { day } from "../__testing__/dates";
import { asApp } from "../__testing__/as-app";
import { serviceOver } from "../__testing__/task-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";
const INBOX = "Daily Notes/Inbox.md";
/** The day note the reschedule tests read their line out of. */
const SOURCE = "2026-06-29.md";
const HEADING = "# Tasks";

function makeVaultFile(path: string) {
  const f = bare(TFileMock);
  Object.assign(f, { path });
  return f;
}

type FakeFile = ReturnType<typeof makeVaultFile>;

// The fake implements only the slice of `App` these tests exercise, so it is widened to
// `App` once here rather than at each of the ~50 call sites that pass it on.
function makeApp(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));

  const app = asApp({
    vault: {
      configDir: CONFIG_DIR,
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
        exists: async () => false,
      },
    },
    plugins: { plugins: {} },
    internalPlugins: { getEnabledPluginById: () => ({}) },
  });

  return {
    app,
    files,
    tasks: serviceOver(app, { inboxFilePath: INBOX, dailyTasksHeading: HEADING }),
  };
}

// ---------------------------------------------------------------------------
// resolveInboxPath
// ---------------------------------------------------------------------------

describe("where the inbox note lives", () => {
  /** The service over a vault whose Daily notes plugin keeps its notes in `folder`. */
  async function inboxPathFor(inboxFilePath: string, folder = "Daily Notes") {
    const { app } = makeApp();
    Object.assign(app.vault.adapter, {
      read: () => Promise.resolve(JSON.stringify({ folder, format: "YYYY-MM-DD", template: "" })),
    });
    const tasks = serviceOver(app, { inboxFilePath });
    await tasks.reconfigure();
    return tasks.inboxPath;
  }

  it("is the custom path when inboxFilePath is set", async () => {
    expect(await inboxPathFor("Custom/Inbox.md")).toBe("Custom/Inbox.md");
  });

  it("falls back to Inbox.md beside the day notes when inboxFilePath is empty", async () => {
    expect(await inboxPathFor("")).toBe("Daily Notes/Inbox.md");
  });

  it("falls back to Inbox.md at the vault root when the day notes have no folder either", async () => {
    expect(await inboxPathFor("", "")).toBe("Inbox.md");
  });

  it("normalizes slashes in a custom path", async () => {
    // normalizePath in mock collapses double slashes
    expect(await inboxPathFor("Daily//Notes//Inbox.md")).toBe("Daily/Notes/Inbox.md");
  });
});

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
    const { files, tasks } = makeApp();
    await tasks.addInboxItem("New task");
    expect(files.has("Daily Notes/Inbox.md")).toBe(true);
  });

  it("writes a line in the standard format with today's date", async () => {
    const { files, tasks } = makeApp();
    await tasks.addInboxItem("New task");
    expect(files.get("Daily Notes/Inbox.md")).toBe(`- [ ] New task ➕ ${TODAY}`);
  });

  it("appends to an existing file", async () => {
    const existing = "- [ ] Old task ➕ 2026-06-28";
    const { files, tasks } = makeApp({ "Daily Notes/Inbox.md": existing });
    await tasks.addInboxItem("New task");
    const content = files.get("Daily Notes/Inbox.md")!;
    expect(content).toContain("Old task");
    expect(content).toContain(`- [ ] New task ➕ ${TODAY}`);
  });

  it("separates the new line from existing content with a newline", async () => {
    const { files, tasks } = makeApp({ "Daily Notes/Inbox.md": "- [ ] Existing ➕ 2026-06-28" });
    await tasks.addInboxItem("Second");
    const content = files.get("Daily Notes/Inbox.md")!;
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
  });

  it("uses today's date from the system clock", async () => {
    vi.setSystemTime(new Date("2026-07-15"));
    const { files, tasks } = makeApp();
    await tasks.addInboxItem("Task");
    expect(files.get("Daily Notes/Inbox.md")).toContain("➕ 2026-07-15");
  });
});

// ---------------------------------------------------------------------------
// scheduleInboxItem
// ---------------------------------------------------------------------------

describe("scheduleInboxItem", () => {
  const TODAY = "2026-06-30";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the item from the inbox", async () => {
    const rawLine = "- [ ] Dentist ➕ 2026-06-28";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
      "2026-07-05.md": "",
    });
    await tasks.scheduleInboxItem(Task.parse(rawLine, 0)!, day("2026-07-05"));
    expect(files.get("Daily Notes/Inbox.md")).not.toContain("Dentist");
  });

  it("adds the raw line verbatim (preserving ➕ date) to the target daily note", async () => {
    const rawLine = "- [ ] Dentist ➕ 2026-06-28";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
      "2026-07-05.md": "",
    });
    await tasks.scheduleInboxItem(Task.parse(rawLine, 0)!, day("2026-07-05"));
    expect(files.get("2026-07-05.md")).toContain("➕ 2026-06-28");
    expect(files.get("2026-07-05.md")).toContain("Dentist");
  });

  it("creates today's note when it does not exist", async () => {
    const rawLine = "- [ ] New appointment ➕ 2026-06-30";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await tasks.scheduleInboxItem(Task.parse(rawLine, 0)!, day(TODAY));
    expect(files.has(`${TODAY}.md`)).toBe(true);
  });

  it("leaves the item in the inbox with a target date when the day has no note", async () => {
    const rawLine = "- [ ] New appointment ➕ 2026-06-30";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await tasks.scheduleInboxItem(Task.parse(rawLine, 0)!, day("2026-07-10"));
    expect(files.has("2026-07-10.md")).toBe(false);
    expect(files.get("Daily Notes/Inbox.md")).toBe(`${rawLine} ⏳ 2026-07-10`);
  });

  it("appends to an existing daily note", async () => {
    const rawLine = "- [ ] Extra task ➕ 2026-06-30";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
      "2026-07-05.md": "- [ ] Existing item",
    });
    await tasks.scheduleInboxItem(Task.parse(rawLine, 0)!, day("2026-07-05"));
    const content = files.get("2026-07-05.md")!;
    expect(content).toContain("Existing item");
    expect(content).toContain("Extra task");
  });

  it("does not strip the creation date from the line added to the daily note", async () => {
    const rawLine = "- [ ] Review docs ➕ 2026-05-01";
    const { files, tasks } = makeApp({ "Daily Notes/Inbox.md": rawLine, "2026-07-01.md": "" });
    await tasks.scheduleInboxItem(Task.parse(rawLine, 0)!, day("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe(`\n# Tasks\n${rawLine}`);
  });
});

// ---------------------------------------------------------------------------
// closeInboxItem
// ---------------------------------------------------------------------------

describe("closeInboxItem", () => {
  const TODAY = "2026-06-30";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the item from the inbox", async () => {
    const rawLine = "- [ ] Dentist ➕ 2026-06-28";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await tasks.closeInboxItem(Task.parse(rawLine, 0)!);
    expect(files.get("Daily Notes/Inbox.md")).not.toContain("Dentist");
  });

  it("adds the item to today's daily note, checked, instead of deleting it", async () => {
    const rawLine = "- [ ] Dentist ➕ 2026-06-28";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await tasks.closeInboxItem(Task.parse(rawLine, 0)!);
    const content = files.get(`${TODAY}.md`);
    expect(content).toContain("Dentist");
    expect(content).toMatch(/^- \[x\]/);
    expect(content).toContain(`✅ ${TODAY}`);
    expect(content).toContain("➕ 2026-06-28");
  });

  it("creates today's daily note when it does not exist", async () => {
    const rawLine = "- [ ] New appointment ➕ 2026-06-30";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
    });
    await tasks.closeInboxItem(Task.parse(rawLine, 0)!);
    expect(files.has(`${TODAY}.md`)).toBe(true);
  });

  it("appends to an existing daily note", async () => {
    const rawLine = "- [ ] Extra task ➕ 2026-06-28";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": rawLine,
      [`${TODAY}.md`]: "- [ ] Existing item",
    });
    await tasks.closeInboxItem(Task.parse(rawLine, 0)!);
    const content = files.get(`${TODAY}.md`)!;
    expect(content).toContain("Existing item");
    expect(content).toContain("Extra task");
  });

  it("preserves sub-lines", async () => {
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": "- [ ] Parent task ➕ 2026-06-28\n\tDetail line",
    });
    await tasks.closeInboxItem(
      Task.parse("- [ ] Parent task ➕ 2026-06-28", 0)!,
    );
    expect(files.get(`${TODAY}.md`)).toContain("Detail line");
  });

  // Today's note is resolved before the inbox is touched, so it can be created here even
  // though nothing is written to it — the dashboard creates it on sight anyway.
  it("writes nothing when the item can no longer be found", async () => {
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": "- [ ] Something else ➕ 2026-06-28",
    });
    await tasks.closeInboxItem(Task.parse("- [ ] Missing", 0)!);
    expect(files.get(`${TODAY}.md`) ?? "").toBe("");
    expect(files.get("Daily Notes/Inbox.md")).toBe("- [ ] Something else ➕ 2026-06-28");
  });
});

// ---------------------------------------------------------------------------
// rescheduleChecklistItem
// ---------------------------------------------------------------------------

describe("rescheduleChecklistItem", () => {
  const TODAY = "2026-06-30";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the line at the specified index from the source file", async () => {
    const { files, tasks } = makeApp({
      "2026-06-29.md": [
        "- [ ] Morning standup",
        "- [ ] Write tests",
        "- [ ] Review PR",
      ].join("\n"),
      "2026-07-01.md": "",
    });
    await tasks.rescheduleChecklistItem(Task.parse("- [ ] Write tests", 1)!.withSource(SOURCE), day("2026-07-01"));
    const lines = files.get("2026-06-29.md")!.split("\n");
    expect(lines).not.toContain("- [ ] Write tests");
    expect(lines).toContain("- [ ] Morning standup");
    expect(lines).toContain("- [ ] Review PR");
  });

  it("adds a fresh unchecked item to the target daily note", async () => {
    const { files, tasks } = makeApp({
      "2026-06-29.md": "- [ ] Write tests",
      "2026-07-01.md": "",
    });
    await tasks.rescheduleChecklistItem(Task.parse("- [ ] Write tests", 0)!.withSource(SOURCE), day("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe("\n# Tasks\n- [ ] Write tests");
  });

  it("sends the item to the inbox with a target date instead of creating a note for the day", async () => {
    const { files, tasks } = makeApp({
      "2026-06-29.md": "- [ ] Task to move ➕ 2026-06-01",
    });
    await tasks.rescheduleChecklistItem(Task.parse("- [ ] Task to move ➕ 2026-06-01", 0)!.withSource(SOURCE), day("2026-07-15"));
    expect(files.has("2026-07-15.md")).toBe(false);
    expect(files.get("Daily Notes/Inbox.md")).toBe("- [ ] Task to move ➕ 2026-06-01 ⏳ 2026-07-15");
  });

  it("creates today's note when rescheduling to today", async () => {
    const { files, tasks } = makeApp({ "2026-06-29.md": "- [ ] Task to move" });
    await tasks.rescheduleChecklistItem(Task.parse("- [ ] Task to move", 0)!.withSource(SOURCE), day(TODAY));
    expect(files.get(`${TODAY}.md`)).toContain("Task to move");
  });

  it("appends to an existing target daily note", async () => {
    const { files, tasks } = makeApp({
      "2026-06-29.md": "- [ ] Task to move",
      "2026-07-01.md": "- [ ] Already there",
    });
    await tasks.rescheduleChecklistItem(Task.parse("- [ ] Task to move", 0)!.withSource(SOURCE), day("2026-07-01"));
    const content = files.get("2026-07-01.md")!;
    expect(content).toContain("Already there");
    expect(content).toContain("Task to move");
  });

  it("does nothing when the source file does not exist", async () => {
    const { tasks } = makeApp();
    await expect(
      tasks.rescheduleChecklistItem(Task.parse("- [ ] Task", 0)!.withSource(SOURCE), day("2026-07-01")),
    ).resolves.toBe(ScheduleOutcome.Failed);
  });

  it("resets the item to unchecked and strips the ✅ date", async () => {
    const { files, tasks } = makeApp({
      "2026-06-29.md": "- [x] Done task ✅ 2026-06-29",
      "2026-07-01.md": "",
    });
    await tasks.rescheduleChecklistItem(Task.parse("- [x] Done task ✅ 2026-06-29", 0)!.withSource(SOURCE), day("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe("\n# Tasks\n- [ ] Done task");
  });

  it("preserves metadata (tags, due date, priority) in the rescheduled line", async () => {
    const raw = "- [ ] Review PR #work 📅 2026-06-29 ⏫";
    const { files, tasks } = makeApp({ "2026-06-29.md": raw, "2026-07-01.md": "" });
    await tasks.rescheduleChecklistItem(Task.parse(raw, 0)!.withSource(SOURCE), day("2026-07-01"));
    expect(files.get("2026-07-01.md")).toBe(`\n# Tasks\n${raw}`);
  });

  it("does not delete from source when ensureDailyNote fails", async () => {
    const rawSource = "- [ ] Important task";
    // Today's note is the only one ensure() is ever asked to create.
    const { app, files, tasks } = makeApp({ "2026-06-29.md": rawSource });
    // Make vault.create throw so ensureDailyNote returns null-equivalent
    app.vault.create = async () => { throw new Error("disk full"); };
    // ensureDailyNote calls vault.create and re-throws, causing it to propagate
    await expect(
      tasks.rescheduleChecklistItem(Task.parse(rawSource, 0)!.withSource(SOURCE), day(TODAY)),
    ).rejects.toThrow();
    // Source must be untouched
    expect(files.get("2026-06-29.md")).toBe(rawSource);
  });

  it("finds the item by rawLine when lineIndex is stale", async () => {
    const { files, tasks } = makeApp({
      // A line was inserted above the target between render and click
      "2026-06-29.md": [
        "- [ ] New line inserted above",
        "- [ ] Target task",
      ].join("\n"),
      "2026-07-01.md": "",
    });
    // lineIndex=0 now points to the wrong line; rawLine fallback finds it at index 1
    await tasks.rescheduleChecklistItem(Task.parse("- [ ] Target task", 0)!.withSource(SOURCE), day("2026-07-01"));
    expect(files.get("2026-06-29.md")).toBe("- [ ] New line inserted above");
    expect(files.get("2026-07-01.md")).toBe("\n# Tasks\n- [ ] Target task");
  });
});

describe("scheduleInboxItem — sub-lines", () => {
  it("moves indented sub-lines to the daily note along with the task", async () => {
    const rawLine = "- [ ] Design meeting ➕ 2026-06-28";
    const { files, tasks } = makeApp({
      "Daily Notes/Inbox.md": [
        rawLine,
        "  - agenda item 1",
        "  - agenda item 2",
        "- [ ] Other task",
      ].join("\n"),
      "2026-07-05.md": "",
    });
    await tasks.scheduleInboxItem(Task.parse(rawLine, 0)!, day("2026-07-05"));
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
    const { files, tasks } = makeApp({
      "2026-06-29.md": [
        "- [ ] Write report",
        "  - section 1",
        "  - section 2",
        "- [ ] Other task",
      ].join("\n"),
      "2026-07-01.md": "",
    });
    await tasks.rescheduleChecklistItem(Task.parse("- [ ] Write report", 0)!.withSource(SOURCE), day("2026-07-01"));
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
    const { files, tasks } = makeApp({
      "2026-06-29.md": [
        "- [x] Done task ✅ 2026-06-29",
        "  - sub-note",
      ].join("\n"),
      "2026-07-01.md": "",
    });
    await tasks.rescheduleChecklistItem(Task.parse("- [x] Done task ✅ 2026-06-29", 0)!.withSource(SOURCE), day("2026-07-01"));
    const target = files.get("2026-07-01.md")!;
    expect(target).toContain("- [ ] Done task");
    expect(target).toContain("  - sub-note");
  });
});
