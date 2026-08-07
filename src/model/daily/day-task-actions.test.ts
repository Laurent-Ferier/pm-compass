import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { asMoment } from "../__testing__/as-moment";

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function makeMomentObj(d: Date) {
  const self = asMoment({
    _d: new Date(d),
    format: (fmt?: string) => {
      const y = self._d.getFullYear();
      const m = String(self._d.getMonth() + 1).padStart(2, "0");
      const day = String(self._d.getDate()).padStart(2, "0");
      if (!fmt || fmt === "YYYY-MM-DD") return `${y}-${m}-${day}`;
      return fmt.replace("YYYY", String(y)).replace("MM", m).replace("DD", day);
    },
    toDate: () => new Date(self._d),
    isSame: (other: { _d: Date }, unit: string) => {
      if (unit === "day") return sameDay(self._d, other._d);
      return self._d.getTime() === other._d.getTime();
    },
  });
  return self;
}

function mockMoment(...args: unknown[]) {
  if (args.length === 0) return makeMomentObj(new Date());
  // Either one of our own moment stubs (which carries `_d`) or a date string.
  const arg = args[0] as { _d?: Date } | string;
  const d = typeof arg === "object" && arg._d instanceof Date
    ? new Date(arg._d)
    : new Date(arg as string);
  return makeMomentObj(d);
}

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  moment: mockMoment,
}));

import { TFile as TFileMock } from "obsidian";
import {
  reorderChecklistItem,
  moveChecklistItemToInbox,
  closeInboxItem,
  scheduleInboxItem,
  rescheduleChecklistItem,
  dayTakesTasks,
  addTaskToDay,
  sortInboxItems,
  resolveTaskSortDir,
} from "./day-task-actions";
import { Task } from "./task";
import { asApp } from "../__testing__/as-app";
import { noteFilesOf } from "../__testing__/day-vault";
import { bare } from "../__testing__/bare";
import { Priority } from "../base-task";
import { TaskSortKey, TaskSortDir } from "../settings";
import { ScheduleOutcome } from "./day-task-actions";
import { timestamp } from "../__testing__/dates";
import { newTask } from "../__testing__/notes";

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

function makeVaultFile(path: string) {
  const f = bare(TFileMock);
  Object.assign(f, { path });
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();
  // A bag rather than the empty object it starts as: tests put a Templater stub in it.
  const plugins: Record<string, { templater: unknown }> = {};
  const app = asApp({
    vault: {
      configDir: CONFIG_DIR,
      getAbstractFileByPath: (path: string) => {
        if (store.has(path)) return makeVaultFile(path);
        if (folders.has(path)) return { path };
        return null;
      },
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        store.set(path, content);
        return makeVaultFile(path);
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      adapter: {
        read: async (): Promise<string> => {
          throw new Error("no daily-notes.json configured");
        },
        exists: async (): Promise<boolean> => false,
      },
    },
    plugins: { plugins },
    internalPlugins: { getEnabledPluginById: (): unknown => ({}) },
  });
  return { app, store, files: noteFilesOf(app) };
}

function task(rawLine: string, lineIndex = 0): Task {
  return Task.parse(rawLine, lineIndex)!;
}

/** Configures the app so `ensureDayNotePath` returns null: Templater is present but
 *  fails to produce a note, and the note doesn't show up on disk under the fallback path. */
function makeAppWithFailingEnsure(initialFiles: Record<string, string> = {}) {
  const { app, store, files } = makeApp({ "templates/daily.md": "", ...initialFiles });
  app.vault.adapter.read = async () =>
    JSON.stringify({ folder: "", format: "YYYY-MM-DD", template: "templates/daily.md" });
  app.plugins.plugins["templater-obsidian"] = {
    templater: { create_new_note_from_template: async () => null },
  };
  return { app, store, files };
}

describe("sortInboxItems", () => {
  const dated = (title: string, date: string, marker = "") =>
    task(`- [ ] ${title}${marker ? ` ${marker}` : ""} ➕ ${date}`);

  it("sorts by creation date, newest first, by default", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    expect(sortInboxItems(items).map((i) => i.title)).toEqual(["New", "Old"]);
  });

  it("puts undated items after every dated one, in file order", () => {
    const items = [task("- [ ] Undated A"), dated("Dated", "2026-06-01"), task("- [ ] Undated B")];
    expect(sortInboxItems(items).map((i) => i.title)).toEqual(["Dated", "Undated A", "Undated B"]);
  });

  it("sorts by priority, most urgent first, in priority mode", () => {
    const items = [
      dated("Low", "2026-06-20", "🔽"),
      dated("Critical", "2026-06-01", "🔺"),
      dated("Medium", "2026-06-10", "🔼"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["Critical", "Medium", "Low"]);
  });

  it("puts items with no priority last in priority mode, however recent", () => {
    const items = [dated("None", "2026-06-20"), dated("Low", "2026-06-01", "🔽")];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["Low", "None"]);
  });

  it("falls back to newest-first within one priority level", () => {
    const items = [dated("Older", "2026-06-01", "⏫"), dated("Newer", "2026-06-20", "⏫")];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("sorts by deadline, soonest first, in due mode", () => {
    const items = [
      dated("Later", "2026-06-01", "📅 2026-07-10"),
      dated("Sooner", "2026-06-01", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due).map((i) => i.title)).toEqual(["Sooner", "Later"]);
  });

  it("puts items with no deadline last in due mode, however recent", () => {
    const items = [dated("None", "2026-06-20"), dated("Dated", "2026-06-01", "📅 2026-12-31")];
    expect(sortInboxItems(items, TaskSortKey.Due).map((i) => i.title)).toEqual(["Dated", "None"]);
  });

  it("falls back to newest-first within one deadline in due mode", () => {
    const items = [
      dated("Older", "2026-06-01", "📅 2026-06-30"),
      dated("Newer", "2026-06-20", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("sorts by title in title mode, ignoring case and accents", () => {
    const items = [task("- [ ] banana"), task("- [ ] Écrire"), task("- [ ] Apple")];
    expect(sortInboxItems(items, TaskSortKey.Title).map((i) => i.title)).toEqual(["Apple", "banana", "Écrire"]);
  });

  it("keeps the file's own order in file mode", () => {
    const items = [
      Task.parse("- [ ] Zebra ➕ 2026-06-01", 2)!,
      Task.parse("- [ ] Apple ➕ 2026-06-20", 0)!,
      Task.parse("- [ ] Mango 🔺 ➕ 2026-06-10", 1)!,
    ];
    expect(sortInboxItems(items, TaskSortKey.File).map((i) => i.title)).toEqual(["Apple", "Mango", "Zebra"]);
  });

  it("reverses the created order when asked for ascending", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    expect(sortInboxItems(items, TaskSortKey.Created, TaskSortDir.Asc).map((i) => i.title)).toEqual(["Old", "New"]);
  });

  it("keeps undated items last in ascending created order", () => {
    const items = [task("- [ ] Undated"), dated("Dated", "2026-06-01")];
    expect(sortInboxItems(items, TaskSortKey.Created, TaskSortDir.Asc).map((i) => i.title)).toEqual(["Dated", "Undated"]);
  });

  it("reverses the priority order, keeping unset priorities last", () => {
    const items = [
      dated("None", "2026-06-15"),
      dated("High", "2026-06-01", "⏫"),
      dated("Low", "2026-06-10", "🔽"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Priority, TaskSortDir.Asc).map((i) => i.title)).toEqual(["Low", "High", "None"]);
  });

  it("reverses the deadline order, keeping items with no deadline last", () => {
    const items = [
      dated("Sooner", "2026-06-01", "📅 2026-06-30"),
      dated("None", "2026-06-15"),
      dated("Later", "2026-06-10", "📅 2026-07-10"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Later", "Sooner", "None"]);
  });

  it("reverses the title order", () => {
    const items = [task("- [ ] Apple"), task("- [ ] banana"), task("- [ ] Cherry")];
    expect(sortInboxItems(items, TaskSortKey.Title, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Cherry", "banana", "Apple"]);
  });

  it("reverses file order in file mode", () => {
    const items = [
      Task.parse("- [ ] First ➕ 2026-06-01", 0)!,
      Task.parse("- [ ] Second ➕ 2026-06-02", 1)!,
    ];
    expect(sortInboxItems(items, TaskSortKey.File, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Second", "First"]);
  });

  it("still breaks ties newest-first in a reversed mode", () => {
    const items = [
      dated("Older", "2026-06-01", "📅 2026-06-30"),
      dated("Newer", "2026-06-20", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("does not mutate the caller's array", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    sortInboxItems(items, TaskSortKey.Priority);
    expect(items.map((i) => i.title)).toEqual(["Old", "New"]);
  });
});

describe("resolveTaskSortDir", () => {
  it("falls back to each mode's own default direction", () => {
    expect(resolveTaskSortDir(TaskSortKey.Created)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Priority)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Due)).toBe(TaskSortDir.Asc);
    expect(resolveTaskSortDir(TaskSortKey.Title)).toBe(TaskSortDir.Asc);
    expect(resolveTaskSortDir(TaskSortKey.File)).toBe(TaskSortDir.Asc);
  });

  it("prefers the stored direction for that mode only", () => {
    const stored = { [TaskSortKey.Title]: TaskSortDir.Desc };
    expect(resolveTaskSortDir(TaskSortKey.Title, stored)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Created, stored)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Due, stored)).toBe(TaskSortDir.Asc);
  });
});

describe("reorderChecklistItem", () => {
  it("puts the item just before the anchor it was dropped on", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await reorderChecklistItem(files, "day.md", task("- [ ] C"), task("- [ ] B"));
    expect(store.get("day.md")).toBe("- [ ] A\n- [ ] C\n- [ ] B");
  });

  it("puts the item last when it was dropped past the end", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await reorderChecklistItem(files, "day.md", task("- [ ] A"), null);
    expect(store.get("day.md")).toBe("- [ ] B\n- [ ] C\n- [ ] A");
  });

  it("carries the item's indented notes with it", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] A\n\tnote on A\n- [ ] B" });
    await reorderChecklistItem(files, "day.md", task("- [ ] A"), null);
    expect(store.get("day.md")).toBe("- [ ] B\n- [ ] A\n\tnote on A");
  });

  it("does nothing when the item is not in the file", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] B" });
    await reorderChecklistItem(files, "day.md", task("- [ ] A"), null);
    expect(store.get("day.md")).toBe("- [ ] B");
  });

  it("leaves a lone task where it is when dropped past the end", async () => {
    // Nothing left to measure the end against, so the file's own end is the landing spot.
    const { store, files } = makeApp({ "day.md": "## Tasks\n- [ ] A" });
    await reorderChecklistItem(files, "day.md", task("- [ ] A"), null);
    expect(store.get("day.md")).toBe("## Tasks\n- [ ] A");
  });
});

describe("moveChecklistItemToInbox", () => {
  it("removes the item from the source and appends it, unchecked and dated today, to the inbox", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] Buy milk" });
    await moveChecklistItemToInbox(files, "day.md", task("- [ ] Buy milk"), "Inbox.md");
    expect(store.get("day.md")).toBe("");
    expect(store.get("Inbox.md")).toMatch(/^- \[ \] Buy milk ➕ \d{4}-\d{2}-\d{2}$/);
  });

  it("carries the priority marker and other metadata over to the inbox", async () => {
    const line = "- [ ] Buy milk 🔺 ➕ 2026-06-01 📅 2026-06-10";
    const { store, files } = makeApp({ "day.md": line });
    await moveChecklistItemToInbox(files, "day.md", task(line), "Inbox.md");
    expect(store.get("Inbox.md")).toBe(line);
  });

  it("unchecks a completed item on the way back to the inbox", async () => {
    const { store, files } = makeApp({ "day.md": "- [x] Buy milk 🔼 ➕ 2026-06-01 ✅ 2026-06-02" });
    await moveChecklistItemToInbox(files, "day.md", task("- [x] Buy milk 🔼 ➕ 2026-06-01 ✅ 2026-06-02"), "Inbox.md");
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk 🔼 ➕ 2026-06-01");
  });

  it("preserves sub-lines when moving to the inbox", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] Buy milk\n  note about milk" });
    const removedItem = task("- [ ] Buy milk").withSubLines(["  note about milk"]);
    await moveChecklistItemToInbox(files, "day.md", removedItem, "Inbox.md");
    expect(store.get("Inbox.md")).toContain("  note about milk");
  });

  it("does nothing when the item is not found in the source file", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] Something else" });
    await moveChecklistItemToInbox(files, "day.md", task("- [ ] Buy milk"), "Inbox.md");
    expect(store.has("Inbox.md")).toBe(false);
  });
});

describe("closeInboxItem — ensure() fails", () => {
  it("does not touch the inbox when today's note can't be created", async () => {
    const { store, files } = makeAppWithFailingEnsure({ "Inbox.md": "- [ ] Buy milk" });
    await closeInboxItem(files, "Inbox.md", task("- [ ] Buy milk"));
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk");
  });

  // The refusal a vault reaches by configuration rather than by failure: closing an item
  // is the one path that deletes before it writes, so the item stays put instead.
  it("keeps the item when the daily notes core plugin is off", async () => {
    const { app, store, files } = makeApp({ "Inbox.md": "- [ ] Buy milk" });
    app.internalPlugins.getEnabledPluginById = () => null;
    await closeInboxItem(files, "Inbox.md", task("- [ ] Buy milk"));
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk");
  });
});

// Only today's note is created on demand, so ensure() is only ever reached for today.
describe("scheduleInboxItem — ensure() fails", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not touch the inbox when the target note can't be created", async () => {
    const { store, files } = makeAppWithFailingEnsure({ "Inbox.md": "- [ ] Buy milk" });
    const { outcome } = await scheduleInboxItem(files, "Inbox.md", task("- [ ] Buy milk"), TODAY, "# Tasks");
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk");
    expect(outcome).toBe(ScheduleOutcome.Failed);
  });

  // The target note is resolved before the inbox is touched, so it can be created here
  // even though nothing is written to it — the dashboard creates it on sight anyway.
  it("writes nothing when the item is not found in the inbox", async () => {
    const { store, files } = makeApp({ "Inbox.md": "- [ ] Something else" });
    const { outcome } = await scheduleInboxItem(files, "Inbox.md", task("- [ ] Buy milk"), TODAY, "# Tasks");
    expect(store.get("2026-07-01.md") ?? "").toBe("");
    expect(store.get("Inbox.md")).toBe("- [ ] Something else");
    expect(outcome).toBe(ScheduleOutcome.Failed);
  });
});

describe("rescheduleChecklistItem — ensure() fails", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not touch the source file when the target note can't be created", async () => {
    const { store, files } = makeAppWithFailingEnsure({ "day.md": "- [ ] Task" });
    await rescheduleChecklistItem(files, "day.md", "Inbox.md", task("- [ ] Task"), TODAY, "# Tasks");
    expect(store.get("day.md")).toBe("- [ ] Task");
  });
});

describe("dayTakesTasks", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes tasks for today, whose note is created on demand", async () => {
    const { app } = makeApp();
    expect(await dayTakesTasks(app, TODAY)).toBe(true);
  });

  it("takes tasks for a day that already has a note", async () => {
    const { app } = makeApp({ "2026-07-09.md": "" });
    expect(await dayTakesTasks(app, new Date(2026, 6, 9))).toBe(true);
  });

  it("refuses a day with no note, rather than creating one", async () => {
    const { app } = makeApp();
    expect(await dayTakesTasks(app, new Date(2026, 6, 9))).toBe(false);
  });

  it("refuses a past day with no note", async () => {
    const { app } = makeApp();
    expect(await dayTakesTasks(app, new Date(2026, 5, 20))).toBe(false);
  });
});

describe("scheduleInboxItem — target dates", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the item in the inbox with a ⏳ target date when the day has no note", async () => {
    const { store, files } = makeApp({ "Inbox.md": "- [ ] Buy milk ➕ 2026-06-01" });
    const { outcome } = await scheduleInboxItem(files, "Inbox.md", task("- [ ] Buy milk ➕ 2026-06-01"), new Date(2026, 6, 9), "# Tasks",
    );
    expect(outcome).toBe(ScheduleOutcome.Targeted);
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-06-01 ⏳ 2026-07-09");
    expect(store.has("2026-07-09.md")).toBe(false);
  });

  it("replaces an earlier target date rather than adding a second one", async () => {
    const { store, files } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-03" });
    await scheduleInboxItem(files, "Inbox.md", task("- [ ] Buy milk ⏳ 2026-07-03"), new Date(2026, 6, 9), "# Tasks",
    );
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ⏳ 2026-07-09");
  });

  it("reports failure when the item is no longer in the inbox to be targeted", async () => {
    const { store, files } = makeApp({ "Inbox.md": "- [ ] Something else" });
    const { outcome } = await scheduleInboxItem(files, "Inbox.md", task("- [ ] Buy milk"), new Date(2026, 6, 9), "# Tasks",
    );
    expect(outcome).toBe(ScheduleOutcome.Failed);
    expect(store.get("Inbox.md")).toBe("- [ ] Something else");
  });

  it("moves the item into a day that already has a note, dropping the target date", async () => {
    const { store, files } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    const { outcome } = await scheduleInboxItem(files, "Inbox.md", task("- [ ] Buy milk ⏳ 2026-07-09"), new Date(2026, 6, 9), "# Tasks",
    );
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(store.get("Inbox.md")).toBe("");
    expect(store.get("2026-07-09.md")).toBe("\n# Tasks\n- [ ] Buy milk");
  });
});

describe("addTaskToDay", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the task under the day's tasks heading when the day has a note", async () => {
    const { store, files } = makeApp({ "2026-07-09.md": "" });
    const outcome = await addTaskToDay(files, new Date(2026, 6, 9), "Buy milk", "Inbox.md", "# Tasks");
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(store.get("2026-07-09.md")).toBe("\n# Tasks\n- [ ] Buy milk ➕ 2026-07-01");
    expect(store.get("Inbox.md")).toBeUndefined();
  });

  it("creates today's note on demand", async () => {
    const { store, files } = makeApp();
    const outcome = await addTaskToDay(files, TODAY, "Buy milk", "Inbox.md", "# Tasks");
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(store.get("2026-07-01.md")).toContain("- [ ] Buy milk ➕ 2026-07-01");
  });

  it("puts the task in the inbox with a ⏳ target date when the day has no note", async () => {
    const { store, files } = makeApp({ "Inbox.md": "" });
    const outcome = await addTaskToDay(files, new Date(2026, 6, 9), "Buy milk", "Inbox.md", "# Tasks");
    expect(outcome).toBe(ScheduleOutcome.Targeted);
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-07-01 ⏳ 2026-07-09");
    expect(store.has("2026-07-09.md")).toBe(false);
  });

  it("reports failure when the day's note can't be created", async () => {
    const { files } = makeAppWithFailingEnsure();
    const outcome = await addTaskToDay(files, TODAY, "Buy milk", "Inbox.md", "# Tasks");
    expect(outcome).toBe(ScheduleOutcome.Failed);
  });
});

describe("rescheduleChecklistItem — target dates", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports failure, and writes nothing, when the item isn't in the source file", async () => {
    // The target note is created first, so a source that has moved on leaves the day
    // with nothing added rather than with a duplicate.
    const { store, files } = makeApp({ "day.md": "- [ ] Something else", "2026-07-09.md": "" });
    const outcome = await rescheduleChecklistItem(files, "day.md", "Inbox.md", task("- [ ] Task ➕ 2026-06-01"), new Date(2026, 6, 9), "# Tasks",
    );
    expect(outcome).toBe(ScheduleOutcome.Failed);
    expect(store.get("2026-07-09.md")).toBe("");
    expect(store.get("day.md")).toBe("- [ ] Something else");
  });

  it("sends the item back to the inbox with a ⏳ target date when the day has no note", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] Task ➕ 2026-06-01" });
    const outcome = await rescheduleChecklistItem(files, "day.md", "Inbox.md", task("- [ ] Task ➕ 2026-06-01"), new Date(2026, 6, 9), "# Tasks"
    );
    expect(outcome).toBe(ScheduleOutcome.Targeted);
    expect(store.get("day.md")).toBe("");
    expect(store.get("Inbox.md")).toBe("- [ ] Task ➕ 2026-06-01 ⏳ 2026-07-09");
    expect(store.has("2026-07-09.md")).toBe(false);
  });

  it("moves the item into a day that already has a note", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] Task", "2026-07-09.md": "" });
    const outcome = await rescheduleChecklistItem(files, "day.md", "Inbox.md", task("- [ ] Task"), new Date(2026, 6, 9), "# Tasks"
    );
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(store.get("2026-07-09.md")).toBe("\n# Tasks\n- [ ] Task");
    expect(store.has("Inbox.md")).toBe(false);
  });

  it("does nothing when the item is no longer in the source file", async () => {
    const { store, files } = makeApp({ "day.md": "- [ ] Something else" });
    const outcome = await rescheduleChecklistItem(files, "day.md", "Inbox.md", task("- [ ] Task"), new Date(2026, 6, 9), "# Tasks"
    );
    expect(outcome).toBe(ScheduleOutcome.Failed);
    expect(store.has("Inbox.md")).toBe(false);
  });
});

describe("closeInboxItem — planned items", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a planned item on today, dropping the target date it no longer needs", async () => {
    const { store, files } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09" });
    await closeInboxItem(files, "Inbox.md", task("- [ ] Buy milk ⏳ 2026-07-09"));
    expect(store.get("Inbox.md")).toBe("");
    expect(store.get("2026-07-01.md")).toBe("- [x] Buy milk ✅ 2026-07-01");
  });

  it("records it on today even when its target day already has a note", async () => {
    const { store, files } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    await closeInboxItem(files, "Inbox.md", task("- [ ] Buy milk ⏳ 2026-07-09"));
    expect(store.get("2026-07-09.md")).toBe("");
    expect(store.get("2026-07-01.md")).toBe("- [x] Buy milk ✅ 2026-07-01");
  });

  it("still files an unplanned item under today", async () => {
    const { store, files } = makeApp({ "Inbox.md": "- [ ] Buy milk" });
    await closeInboxItem(files, "Inbox.md", task("- [ ] Buy milk"));
    expect(store.get("2026-07-01.md")).toContain("- [x] Buy milk");
  });
});

describe("moveChecklistItemToInbox — target dates", () => {
  it("drops the ⏳ target date, which would otherwise pull the item straight back out", async () => {
    const line = "- [ ] Buy milk ➕ 2026-06-01 ⏳ 2026-07-09";
    const { store, files } = makeApp({ "day.md": line });
    await moveChecklistItemToInbox(files, "day.md", task(line), "Inbox.md");
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-06-01");
  });
});

describe("sortInboxItems — the mode's own key comes first", () => {
  const line = (title: string, marker: string, created: string) =>
    Task.parse(`- [ ] ${title}${marker} ➕ ${created}`, 0)!;

  it("orders by creation date in Created mode, whatever the priorities say", () => {
    const urgentButNew = line("New", " 🔺", "2026-06-20");
    const calmButOld = line("Old", " 🔽", "2026-06-01");
    // Oldest first, ascending: the mode's key wins, and priority only breaks its ties.
    expect(sortInboxItems([urgentButNew, calmButOld], TaskSortKey.Created, TaskSortDir.Asc)[0])
      .toBe(calmButOld);
  });
});

describe("sortInboxItems — ties", () => {
  const line = (title: string, marker: string, created: string) =>
    Task.parse(`- [ ] ${title}${marker} ➕ ${created}`, 0)!;

  it("orders tasks the mode cannot tell apart by priority, most urgent first", () => {
    // Same title key, same creation day: only the priority marker separates them.
    const low = line("Task", " 🔽", "2026-06-01");
    const high = line("Task", " ⏫", "2026-06-01");
    const sorted = sortInboxItems([low, high], TaskSortKey.Title, TaskSortDir.Asc);
    expect(sorted[0]).toBe(high);
  });

  it("keeps priority as the tie-break whichever way the mode reads", () => {
    const low = line("Task", " 🔽", "2026-06-01");
    const high = line("Task", " ⏫", "2026-06-01");
    const sorted = sortInboxItems([low, high], TaskSortKey.Title, TaskSortDir.Desc);
    expect(sorted[0]).toBe(high);
  });

  it("falls back to the newest first once the priorities tie too", () => {
    const older = line("Task", "", "2026-06-01");
    const newer = line("Task", "", "2026-06-20");
    expect(sortInboxItems([older, newer], TaskSortKey.Title, TaskSortDir.Asc)[0]).toBe(newer);
  });
});

describe("sortInboxItems — inherited priority", () => {
  /** A project task reading as `inherited`, whatever it carries itself. `subtree` is the
   *  level it rolls up from itself and its children — its own, unless one is given. */
  const under = (title: string, own: Priority | undefined, inherited: Priority, subtree?: Priority) => {
    const task = newTask({
      id: title, title, projectId: "p", status: "todo", priority: own,
      dependencies: [], filePath: `${title}.md`,
    });
    return { task, inherited, subtree: subtree ?? own ?? Priority.None };
  };

  const sortUnder = (
    rows: ReturnType<typeof under>[],
    dir: TaskSortDir = TaskSortDir.Desc,
  ) => {
    const effectiveValues = new Map(rows.map(({ task, inherited, subtree }) => [task.id, {
      priority: inherited, ancestorPriority: inherited, subtreePriority: subtree, due: undefined,
    }]));
    return sortInboxItems(rows.map((r) => r.task), TaskSortKey.Priority, dir, effectiveValues)
      .map((t) => t.title);
  };

  const rows = [
    under("Unset", undefined, Priority.High),
    under("Medium", Priority.Medium, Priority.High),
    under("High", Priority.High, Priority.High),
  ];

  it("splits tasks of one inherited level by the level each rolls up from below", () => {
    expect(sortUnder(rows)).toEqual(["High", "Medium", "Unset"]);
  });

  it("lifts a task whose children are urgent above a sibling that carries more itself", () => {
    // Both read High under one high parent. `Busy` carries Low but holds High work
    // below it; `Quiet` carries Medium and holds nothing.
    expect(sortUnder([
      under("Quiet", Priority.Medium, Priority.High),
      under("Busy", Priority.Low, Priority.High, Priority.High),
    ])).toEqual(["Busy", "Quiet"]);
  });

  it("reverses that tiebreak with the mode", () => {
    expect(sortUnder(rows, TaskSortDir.Asc)).toEqual(["Unset", "Medium", "High"]);
  });

  it("leaves an inbox line, which inherits nothing, on its own priority alone", () => {
    const items = [
      Task.parse("- [ ] Low 🔽 ➕ 2026-06-01", 0)!,
      Task.parse("- [ ] High ⏫ ➕ 2026-06-02", 1)!,
    ];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["High", "Low"]);
  });
});

describe("sortInboxItems — file order", () => {
  it("settles the rows with no line in the file by creation date, newest first", () => {
    // Two project tasks: neither has a line in the Inbox file, so the file's other fact
    // decides — not their priorities.
    const older = newTask({
      id: "older", title: "Older", projectId: "p", status: "todo", priority: Priority.Critical,
      createdAt: timestamp("2026-06-01T10:00:00.000Z"), dependencies: [], filePath: "older.md",
    });
    const newer = newTask({
      id: "newer", title: "Newer", projectId: "p", status: "todo", priority: Priority.Low,
      createdAt: timestamp("2026-06-20T10:00:00.000Z"), dependencies: [], filePath: "newer.md",
    });
    const sorted = sortInboxItems([older, newer], TaskSortKey.File, TaskSortDir.Asc);
    expect(sorted.map((t) => t.title)).toEqual(["Newer", "Older"]);
  });

  it("keeps the inbox's own lines in the file's order, ahead of tasks with no line", () => {
    const line = Task.parse("- [ ] A line", 3)!;
    const task = newTask({
      id: "t", title: "A task", projectId: "p", status: "todo",
      dependencies: [], filePath: "t.md",
    });
    expect(sortInboxItems([task, line], TaskSortKey.File, TaskSortDir.Asc).map((t) => t.title))
      .toEqual(["A line", "A task"]);
  });

  it("leaves the tasks with no line last when the file is read backwards too", () => {
    // Reversing the file reverses its lines; a row that has none is missing the mode's
    // key, and a missing key stays last either way, as in every other mode.
    const first = Task.parse("- [ ] First", 1)!;
    const second = Task.parse("- [ ] Second", 5)!;
    const task = newTask({
      id: "t", title: "A task", projectId: "p", status: "todo",
      dependencies: [], filePath: "t.md",
    });
    expect(sortInboxItems([task, first, second], TaskSortKey.File, TaskSortDir.Desc).map((t) => t.title))
      .toEqual(["Second", "First", "A task"]);
  });
});
