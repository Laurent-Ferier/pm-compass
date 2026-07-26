import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { asMoment } from "./__testing__/as-moment";

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
    isSame: (other: { _d: Date }, unit: string) => {
      if (unit === "day") return sameDay(self._d, other._d);
      return self._d.getTime() === other._d.getTime();
    },
  });
  return self;
}

function mockMoment(...args: unknown[]) {
  if (args.length === 0) return makeMomentObj(new Date());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arg = args[0] as any;
  const d = arg?._d instanceof Date ? new Date(arg._d) : new Date(arg as string);
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
  deleteChecklistItem,
  moveChecklistItemToInbox,
  loadDayChecklist,
  toggleChecklistItem,
  closeInboxItem,
  scheduleInboxItem,
  rescheduleChecklistItem,
  readInboxItems,
  setChecklistItemPriority,
  sortInboxItems,
  resolveInboxSortDir,
} from "./day-task-actions";
import { DayTask } from "./day-task";
import { InboxSortBy, InboxSortDir, Priority } from "./task-vocabulary";

function makeVaultFile(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = Object.create((TFileMock as any).prototype);
  f.path = path;
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = {
    vault: {
      configDir: ".obsidian",
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
        read: async () => {
          throw new Error("no daily-notes.json configured");
        },
      },
    },
    plugins: { plugins: {} },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any;
  return { app, store };
}

function task(rawLine: string, lineIndex = 0): DayTask {
  return DayTask.parse(rawLine, lineIndex)!;
}

/** Configures the app so DayMarkdownFile.ensure() returns null: Templater is present but
 *  fails to produce a note, and the note doesn't show up on disk under the fallback path. */
function makeAppWithFailingEnsure(initialFiles: Record<string, string> = {}) {
  const { app, store } = makeApp({ "templates/daily.md": "", ...initialFiles });
  app.vault.adapter.read = async () =>
    JSON.stringify({ folder: "", format: "YYYY-MM-DD", template: "templates/daily.md" });
  app.plugins.plugins["templater-obsidian"] = {
    templater: { create_new_note_from_template: async () => null },
  };
  return { app, store };
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
    expect(sortInboxItems(items, InboxSortBy.Priority).map((i) => i.title)).toEqual(["Critical", "Medium", "Low"]);
  });

  it("puts items with no priority last in priority mode, however recent", () => {
    const items = [dated("None", "2026-06-20"), dated("Low", "2026-06-01", "🔽")];
    expect(sortInboxItems(items, InboxSortBy.Priority).map((i) => i.title)).toEqual(["Low", "None"]);
  });

  it("falls back to newest-first within one priority level", () => {
    const items = [dated("Older", "2026-06-01", "⏫"), dated("Newer", "2026-06-20", "⏫")];
    expect(sortInboxItems(items, InboxSortBy.Priority).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("sorts by deadline, soonest first, in due mode", () => {
    const items = [
      dated("Later", "2026-06-01", "📅 2026-07-10"),
      dated("Sooner", "2026-06-01", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, InboxSortBy.Due).map((i) => i.title)).toEqual(["Sooner", "Later"]);
  });

  it("puts items with no deadline last in due mode, however recent", () => {
    const items = [dated("None", "2026-06-20"), dated("Dated", "2026-06-01", "📅 2026-12-31")];
    expect(sortInboxItems(items, InboxSortBy.Due).map((i) => i.title)).toEqual(["Dated", "None"]);
  });

  it("falls back to newest-first within one deadline in due mode", () => {
    const items = [
      dated("Older", "2026-06-01", "📅 2026-06-30"),
      dated("Newer", "2026-06-20", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, InboxSortBy.Due).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("sorts by title in title mode, ignoring case and accents", () => {
    const items = [task("- [ ] banana"), task("- [ ] Écrire"), task("- [ ] Apple")];
    expect(sortInboxItems(items, InboxSortBy.Title).map((i) => i.title)).toEqual(["Apple", "banana", "Écrire"]);
  });

  it("keeps the file's own order in file mode", () => {
    const items = [
      DayTask.parse("- [ ] Zebra ➕ 2026-06-01", 2)!,
      DayTask.parse("- [ ] Apple ➕ 2026-06-20", 0)!,
      DayTask.parse("- [ ] Mango 🔺 ➕ 2026-06-10", 1)!,
    ];
    expect(sortInboxItems(items, InboxSortBy.File).map((i) => i.title)).toEqual(["Apple", "Mango", "Zebra"]);
  });

  it("reverses the created order when asked for ascending", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    expect(sortInboxItems(items, InboxSortBy.Created, InboxSortDir.Asc).map((i) => i.title)).toEqual(["Old", "New"]);
  });

  it("keeps undated items last in ascending created order", () => {
    const items = [task("- [ ] Undated"), dated("Dated", "2026-06-01")];
    expect(sortInboxItems(items, InboxSortBy.Created, InboxSortDir.Asc).map((i) => i.title)).toEqual(["Dated", "Undated"]);
  });

  it("reverses the priority order, keeping unset priorities last", () => {
    const items = [
      dated("None", "2026-06-15"),
      dated("High", "2026-06-01", "⏫"),
      dated("Low", "2026-06-10", "🔽"),
    ];
    expect(sortInboxItems(items, InboxSortBy.Priority, InboxSortDir.Asc).map((i) => i.title)).toEqual(["Low", "High", "None"]);
  });

  it("reverses the deadline order, keeping items with no deadline last", () => {
    const items = [
      dated("Sooner", "2026-06-01", "📅 2026-06-30"),
      dated("None", "2026-06-15"),
      dated("Later", "2026-06-10", "📅 2026-07-10"),
    ];
    expect(sortInboxItems(items, InboxSortBy.Due, InboxSortDir.Desc).map((i) => i.title)).toEqual(["Later", "Sooner", "None"]);
  });

  it("reverses the title order", () => {
    const items = [task("- [ ] Apple"), task("- [ ] banana"), task("- [ ] Cherry")];
    expect(sortInboxItems(items, InboxSortBy.Title, InboxSortDir.Desc).map((i) => i.title)).toEqual(["Cherry", "banana", "Apple"]);
  });

  it("reverses file order in file mode", () => {
    const items = [
      DayTask.parse("- [ ] First ➕ 2026-06-01", 0)!,
      DayTask.parse("- [ ] Second ➕ 2026-06-02", 1)!,
    ];
    expect(sortInboxItems(items, InboxSortBy.File, InboxSortDir.Desc).map((i) => i.title)).toEqual(["Second", "First"]);
  });

  it("still breaks ties newest-first in a reversed mode", () => {
    const items = [
      dated("Older", "2026-06-01", "📅 2026-06-30"),
      dated("Newer", "2026-06-20", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, InboxSortBy.Due, InboxSortDir.Desc).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("does not mutate the caller's array", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    sortInboxItems(items, InboxSortBy.Priority);
    expect(items.map((i) => i.title)).toEqual(["Old", "New"]);
  });
});

describe("resolveInboxSortDir", () => {
  it("falls back to each mode's own default direction", () => {
    expect(resolveInboxSortDir(InboxSortBy.Created)).toBe(InboxSortDir.Desc);
    expect(resolveInboxSortDir(InboxSortBy.Priority)).toBe(InboxSortDir.Desc);
    expect(resolveInboxSortDir(InboxSortBy.Due)).toBe(InboxSortDir.Asc);
    expect(resolveInboxSortDir(InboxSortBy.Title)).toBe(InboxSortDir.Asc);
    expect(resolveInboxSortDir(InboxSortBy.File)).toBe(InboxSortDir.Asc);
  });

  it("prefers the stored direction for that mode only", () => {
    const stored = { [InboxSortBy.Title]: InboxSortDir.Desc };
    expect(resolveInboxSortDir(InboxSortBy.Title, stored)).toBe(InboxSortDir.Desc);
    expect(resolveInboxSortDir(InboxSortBy.Created, stored)).toBe(InboxSortDir.Desc);
    expect(resolveInboxSortDir(InboxSortBy.Due, stored)).toBe(InboxSortDir.Asc);
  });
});

describe("readInboxItems", () => {
  it("returns unchecked items newest-first by default", async () => {
    const { app } = makeApp({
      "Inbox.md": "- [ ] Old ➕ 2026-06-01\n- [ ] New ➕ 2026-06-20",
    });
    const items = await readInboxItems(app, "Inbox.md");
    expect(items.map((i) => i.title)).toEqual(["New", "Old"]);
  });

  it("orders by priority when asked", async () => {
    const { app } = makeApp({
      "Inbox.md": "- [ ] Plain ➕ 2026-06-20\n- [ ] Urgent 🔺 ➕ 2026-06-01",
    });
    const items = await readInboxItems(app, "Inbox.md", InboxSortBy.Priority);
    expect(items.map((i) => i.title)).toEqual(["Urgent", "Plain"]);
  });
});

describe("setChecklistItemPriority", () => {
  it("writes the priority marker into the line", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [ ] Buy milk ➕ 2026-06-01" });
    await setChecklistItemPriority(app, "Inbox.md", task("- [ ] Buy milk ➕ 2026-06-01"), Priority.High);
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ⏫ ➕ 2026-06-01");
  });

  it("clears the marker when given an empty priority", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [ ] Buy milk 🔺 ➕ 2026-06-01" });
    await setChecklistItemPriority(app, "Inbox.md", task("- [ ] Buy milk 🔺 ➕ 2026-06-01"), Priority.None);
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-06-01");
  });
});

describe("deleteChecklistItem", () => {
  it("removes the item from the source file", async () => {
    const { app, store } = makeApp({ "day.md": "- [ ] A\n- [ ] B" });
    await deleteChecklistItem(app, "day.md", task("- [ ] A"));
    expect(store.get("day.md")).toBe("- [ ] B");
  });

  it("does nothing when the item is not found", async () => {
    const { app, store } = makeApp({ "day.md": "- [ ] B" });
    await deleteChecklistItem(app, "day.md", task("- [ ] A"));
    expect(store.get("day.md")).toBe("- [ ] B");
  });
});

describe("moveChecklistItemToInbox", () => {
  it("removes the item from the source and appends it, unchecked and dated today, to the inbox", async () => {
    const { app, store } = makeApp({ "day.md": "- [ ] Buy milk" });
    await moveChecklistItemToInbox(app, "day.md", task("- [ ] Buy milk"), "Inbox.md");
    expect(store.get("day.md")).toBe("");
    expect(store.get("Inbox.md")).toMatch(/^- \[ \] Buy milk ➕ \d{4}-\d{2}-\d{2}$/);
  });

  it("carries the priority marker and other metadata over to the inbox", async () => {
    const line = "- [ ] Buy milk 🔺 ➕ 2026-06-01 📅 2026-06-10";
    const { app, store } = makeApp({ "day.md": line });
    await moveChecklistItemToInbox(app, "day.md", task(line), "Inbox.md");
    expect(store.get("Inbox.md")).toBe(line);
  });

  it("unchecks a completed item on the way back to the inbox", async () => {
    const { app, store } = makeApp({ "day.md": "- [x] Buy milk 🔼 ➕ 2026-06-01 ✅ 2026-06-02" });
    await moveChecklistItemToInbox(app, "day.md", task("- [x] Buy milk 🔼 ➕ 2026-06-01 ✅ 2026-06-02"), "Inbox.md");
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk 🔼 ➕ 2026-06-01");
  });

  it("preserves sub-lines when moving to the inbox", async () => {
    const { app, store } = makeApp({ "day.md": "- [ ] Buy milk\n  note about milk" });
    const removedItem = task("- [ ] Buy milk").withSubLines(["  note about milk"]);
    await moveChecklistItemToInbox(app, "day.md", removedItem, "Inbox.md");
    expect(store.get("Inbox.md")).toContain("  note about milk");
  });

  it("does nothing when the item is not found in the source file", async () => {
    const { app, store } = makeApp({ "day.md": "- [ ] Something else" });
    await moveChecklistItemToInbox(app, "day.md", task("- [ ] Buy milk"), "Inbox.md");
    expect(store.has("Inbox.md")).toBe(false);
  });
});

describe("closeInboxItem — ensure() fails", () => {
  it("leaves the item deleted from the inbox with nowhere to go when today's note can't be created", async () => {
    const { app, store } = makeAppWithFailingEnsure({ "Inbox.md": "- [ ] Buy milk" });
    await closeInboxItem(app, "Inbox.md", task("- [ ] Buy milk"));
    expect(store.get("Inbox.md")).toBe("");
  });
});

describe("scheduleInboxItem — ensure() fails", () => {
  it("leaves the item deleted from the inbox with nowhere to go when the target note can't be created", async () => {
    const { app, store } = makeAppWithFailingEnsure({ "Inbox.md": "- [ ] Buy milk" });
    await scheduleInboxItem(app, "Inbox.md", task("- [ ] Buy milk"), asMoment({ format: () => "2026-07-05" }), "# Tasks");
    expect(store.get("Inbox.md")).toBe("");
  });

  it("does nothing when the item is not found in the inbox", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [ ] Something else" });
    await scheduleInboxItem(app, "Inbox.md", task("- [ ] Buy milk"), asMoment({ format: () => "2026-07-05" }), "# Tasks");
    expect(store.has("2026-07-05.md")).toBe(false);
  });
});

describe("rescheduleChecklistItem — ensure() fails", () => {
  it("does not touch the source file when the target note can't be created", async () => {
    const { app, store } = makeAppWithFailingEnsure({ "day.md": "- [ ] Task" });
    await rescheduleChecklistItem(app, "day.md", task("- [ ] Task"), asMoment({ format: () => "2026-07-05" }), "# Tasks");
    expect(store.get("day.md")).toBe("- [ ] Task");
  });
});

describe("toggleChecklistItem", () => {
  it("checks an unchecked item and returns the checked rawLine", async () => {
    const { app, store } = makeApp({ "day.md": "- [ ] Task" });
    const result = await toggleChecklistItem(app, "day.md", task("- [ ] Task"));
    expect(result).toMatch(/^- \[x\] Task ✅ \d{4}-\d{2}-\d{2}$/);
    expect(store.get("day.md")).toBe(result);
  });

  it("unchecks a checked item and returns the unchecked rawLine", async () => {
    const { app, store } = makeApp({ "day.md": "- [x] Task ✅ 2026-07-01" });
    const result = await toggleChecklistItem(app, "day.md", task("- [x] Task ✅ 2026-07-01"));
    expect(result).toBe("- [ ] Task");
    expect(store.get("day.md")).toBe("- [ ] Task");
  });
});

describe("loadDayChecklist", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads DailyNotesConfig from vault when not provided", async () => {
    const { app } = makeApp();
    const result = await loadDayChecklist(app, mockMoment(TODAY));
    // adapter.read throws in this mock, so defaults are used: root folder, YYYY-MM-DD.
    expect(result.filePath).toBe("2026-07-01.md");
  });

  it("auto-creates and returns today's note when it does not yet exist", async () => {
    const { app, store } = makeApp();
    const result = await loadDayChecklist(app, mockMoment(TODAY), {
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(result.filePath).toBe("2026-07-01.md");
    expect(result.items).toEqual([]);
    expect(store.has("2026-07-01.md")).toBe(true);
  });

  it("returns today's existing items", async () => {
    const { app } = makeApp({ "2026-07-01.md": "- [ ] Task" });
    const result = await loadDayChecklist(app, mockMoment(TODAY), {
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Task");
  });

  it("returns empty/null for a non-today date whose note does not exist", async () => {
    const { app } = makeApp();
    const yesterday = new Date(2026, 5, 30);
    const result = await loadDayChecklist(app, mockMoment(yesterday), {
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(result).toEqual({ items: [], filePath: null });
  });

  it("reads an existing non-today note without creating it", async () => {
    const { app } = makeApp({ "2026-06-30.md": "- [ ] Yesterday's task" });
    const yesterday = new Date(2026, 5, 30);
    const result = await loadDayChecklist(app, mockMoment(yesterday), {
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(result.filePath).toBe("2026-06-30.md");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Yesterday's task");
  });

  it("places the note under the configured folder", async () => {
    const { app } = makeApp();
    const result = await loadDayChecklist(app, mockMoment(TODAY), {
      folder: "Daily Notes",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(result.filePath).toBe("Daily Notes/2026-07-01.md");
  });

  it("returns empty/null for today when the note can't be created", async () => {
    const { app } = makeAppWithFailingEnsure();
    const result = await loadDayChecklist(app, mockMoment(TODAY), {
      folder: "",
      format: "YYYY-MM-DD",
      template: "templates/daily.md",
    });
    expect(result).toEqual({ items: [], filePath: null });
  });
});
