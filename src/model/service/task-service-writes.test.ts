// @vitest-environment jsdom
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
    isValid: () => !Number.isNaN(self._d.getTime()),
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
  const arg = args[0] as { _d?: Date } | Date | string;
  if (arg instanceof Date) return makeMomentObj(new Date(arg));
  if (typeof arg === "object" && arg._d instanceof Date) return makeMomentObj(new Date(arg._d));
  // The strict parse a day note's name goes through: anything not `YYYY-MM-DD` is no day,
  // which is how the cache tells its own paths from the rest.
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg as string) ?? [];
  return makeMomentObj(y ? new Date(Number(y), Number(m) - 1, Number(d)) : new Date(NaN));
}

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  moment: mockMoment,
}));

import { TFile as TFileMock } from "obsidian";
import { ScheduleOutcome } from "./task-service";
import { Task } from "../daily/task";
import { asApp } from "../__testing__/as-app";
import { serviceOver } from "../__testing__/task-service";
import { bare } from "../__testing__/bare";

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";
const INBOX = "Inbox.md";
const HEADING = "# Tasks";
/** The day note the checklist writes read their line out of. */
const DAY = "day.md";

function makeVaultFile(path: string) {
  const f = bare(TFileMock);
  Object.assign(f, { path });
  return f;
}

function makeApp(initialFiles: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();
  // A bag rather than the empty object it starts as: tests put a Templater stub in it.
  const plugins: Record<string, { templater: unknown }> = {};
  const app = asApp({
    vault: {
      configDir: CONFIG_DIR,
      getAbstractFileByPath: (path: string) => {
        if (contents.has(path)) return makeVaultFile(path);
        if (folders.has(path)) return { path };
        return null;
      },
      read: async (file: { path: string }) => contents.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        contents.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        contents.set(path, content);
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
  return { app, contents, tasks: serviceOver(app, { inboxFilePath: INBOX, dailyTasksHeading: HEADING }) };
}

/** A checklist line as its note holds it — sourced, since which note a line is in is what
 *  the service asks the line for. */
function task(rawLine: string, lineIndex = 0, filePath = DAY): Task {
  return Task.parse(rawLine, lineIndex)!.withSource(filePath);
}

/** Configures the app so `DayNoteService.ensure` returns null: Templater is present but
 *  fails to produce a note, and the note doesn't show up on disk under the fallback path. */
async function makeAppWithFailingEnsure(initialFiles: Record<string, string> = {}) {
  const { app, contents, tasks } = makeApp({ "templates/daily.md": "", ...initialFiles });
  app.vault.adapter.read = async () =>
    JSON.stringify({ folder: "", format: "YYYY-MM-DD", template: "templates/daily.md" });
  app.plugins.plugins["templater-obsidian"] = {
    templater: { create_new_note_from_template: async () => null },
  };
  // The scheme is read once, as on a real vault; until then the service runs on its guess,
  // which names no template and so would never reach Templater.
  await tasks.reconfigure();
  return { app, contents, tasks };
}

describe("reorderChecklistItem", () => {
  it("puts the item just before the anchor it was dropped on", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await tasks.reorderChecklistItem(task("- [ ] C"), task("- [ ] B"));
    expect(contents.get("day.md")).toBe("- [ ] A\n- [ ] C\n- [ ] B");
  });

  it("puts the item last when it was dropped past the end", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] A\n- [ ] B\n- [ ] C" });
    await tasks.reorderChecklistItem(task("- [ ] A"), null);
    expect(contents.get("day.md")).toBe("- [ ] B\n- [ ] C\n- [ ] A");
  });

  it("carries the item's indented notes with it", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] A\n\tnote on A\n- [ ] B" });
    await tasks.reorderChecklistItem(task("- [ ] A"), null);
    expect(contents.get("day.md")).toBe("- [ ] B\n- [ ] A\n\tnote on A");
  });

  it("does nothing when the item is not in the file", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] B" });
    await tasks.reorderChecklistItem(task("- [ ] A"), null);
    expect(contents.get("day.md")).toBe("- [ ] B");
  });

  it("leaves a lone task where it is when dropped past the end", async () => {
    // Nothing left to measure the end against, so the file's own end is the landing spot.
    const { contents, tasks } = makeApp({ "day.md": "## Tasks\n- [ ] A" });
    await tasks.reorderChecklistItem(task("- [ ] A"), null);
    expect(contents.get("day.md")).toBe("## Tasks\n- [ ] A");
  });
});

describe("moveChecklistItemToInbox", () => {
  it("removes the item from the source and appends it, unchecked and dated today, to the inbox", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] Buy milk" });
    await tasks.moveChecklistItemToInbox(task("- [ ] Buy milk"));
    expect(contents.get("day.md")).toBe("");
    expect(contents.get("Inbox.md")).toMatch(/^- \[ \] Buy milk ➕ \d{4}-\d{2}-\d{2}$/);
  });

  it("carries the priority marker and other metadata over to the inbox", async () => {
    const line = "- [ ] Buy milk 🔺 ➕ 2026-06-01 📅 2026-06-10";
    const { contents, tasks } = makeApp({ "day.md": line });
    await tasks.moveChecklistItemToInbox(task(line));
    expect(contents.get("Inbox.md")).toBe(line);
  });

  it("unchecks a completed item on the way back to the inbox", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [x] Buy milk 🔼 ➕ 2026-06-01 ✅ 2026-06-02" });
    await tasks.moveChecklistItemToInbox(task("- [x] Buy milk 🔼 ➕ 2026-06-01 ✅ 2026-06-02"));
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk 🔼 ➕ 2026-06-01");
  });

  it("preserves sub-lines when moving to the inbox", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] Buy milk\n  note about milk" });
    const removedItem = task("- [ ] Buy milk").withSubLines(["  note about milk"]);
    await tasks.moveChecklistItemToInbox(removedItem);
    expect(contents.get("Inbox.md")).toContain("  note about milk");
  });

  it("does nothing when the item is not found in the source file", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] Something else" });
    await tasks.moveChecklistItemToInbox(task("- [ ] Buy milk"));
    expect(contents.has("Inbox.md")).toBe(false);
  });
});

describe("closeInboxItem — ensure() fails", () => {
  it("does not touch the inbox when today's note can't be created", async () => {
    const { contents, tasks } = await makeAppWithFailingEnsure({ "Inbox.md": "- [ ] Buy milk" });
    await tasks.closeInboxItem(task("- [ ] Buy milk"));
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk");
  });

  // The refusal a vault reaches by configuration rather than by failure: closing an item
  // is the one path that deletes before it writes, so the item stays put instead.
  it("keeps the item when the daily notes core plugin is off", async () => {
    const { app, contents, tasks } = makeApp({ "Inbox.md": "- [ ] Buy milk" });
    app.internalPlugins.getEnabledPluginById = () => null;
    await tasks.closeInboxItem(task("- [ ] Buy milk"));
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk");
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
    const { contents, tasks } = await makeAppWithFailingEnsure({ "Inbox.md": "- [ ] Buy milk" });
    const outcome = await tasks.scheduleInboxItem(task("- [ ] Buy milk"), TODAY);
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk");
    expect(outcome).toBe(ScheduleOutcome.Failed);
  });

  // The source is read before anything is written, so a line that has gone makes no note.
  it("writes nothing when the item is not found in the inbox", async () => {
    const { contents, tasks } = makeApp({ "Inbox.md": "- [ ] Something else" });
    const outcome = await tasks.scheduleInboxItem(task("- [ ] Buy milk"), TODAY);
    expect(contents.get("2026-07-01.md") ?? "").toBe("");
    expect(contents.get("Inbox.md")).toBe("- [ ] Something else");
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
    const { contents, tasks } = await makeAppWithFailingEnsure({ "day.md": "- [ ] Task" });
    await tasks.rescheduleChecklistItem(task("- [ ] Task"), TODAY);
    expect(contents.get("day.md")).toBe("- [ ] Task");
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
    const { tasks } = makeApp();
    expect(await tasks.dayTakesTasks(TODAY)).toBe(true);
  });

  it("takes tasks for a day that already has a note", async () => {
    const { tasks } = makeApp({ "2026-07-09.md": "" });
    expect(await tasks.dayTakesTasks(new Date(2026, 6, 9))).toBe(true);
  });

  it("refuses a day with no note, rather than creating one", async () => {
    const { tasks } = makeApp();
    expect(await tasks.dayTakesTasks(new Date(2026, 6, 9))).toBe(false);
  });

  it("refuses a past day with no note", async () => {
    const { tasks } = makeApp();
    expect(await tasks.dayTakesTasks(new Date(2026, 5, 20))).toBe(false);
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
    const { contents, tasks } = makeApp({ "Inbox.md": "- [ ] Buy milk ➕ 2026-06-01" });
    const outcome = await tasks.scheduleInboxItem(task("- [ ] Buy milk ➕ 2026-06-01"), new Date(2026, 6, 9));
    expect(outcome).toBe(ScheduleOutcome.Targeted);
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-06-01 ⏳ 2026-07-09");
    expect(contents.has("2026-07-09.md")).toBe(false);
  });

  it("replaces an earlier target date rather than adding a second one", async () => {
    const { contents, tasks } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-03" });
    await tasks.scheduleInboxItem(task("- [ ] Buy milk ⏳ 2026-07-03"), new Date(2026, 6, 9));
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk ⏳ 2026-07-09");
  });

  it("reports failure when the item is no longer in the inbox to be targeted", async () => {
    const { contents, tasks } = makeApp({ "Inbox.md": "- [ ] Something else" });
    const outcome = await tasks.scheduleInboxItem(task("- [ ] Buy milk"), new Date(2026, 6, 9));
    expect(outcome).toBe(ScheduleOutcome.Failed);
    expect(contents.get("Inbox.md")).toBe("- [ ] Something else");
  });

  it("moves the item into a day that already has a note, dropping the target date", async () => {
    const { contents, tasks } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    const outcome = await tasks.scheduleInboxItem(task("- [ ] Buy milk ⏳ 2026-07-09"), new Date(2026, 6, 9));
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(contents.get("Inbox.md")).toBe("");
    expect(contents.get("2026-07-09.md")).toBe("\n# Tasks\n- [ ] Buy milk");
  });

  // An unmarked note is one the plugin wrote and goes on reading its old copy of.
  it("has each note it wrote mark itself for re-reading", async () => {
    const target = new Date(2026, 6, 9);
    const { tasks } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    // Read before the write, so the cache holds a copy of each note to go stale.
    const inbox = await tasks.inboxModel();
    const day = await tasks.day(target);

    await tasks.scheduleInboxItem(task("- [ ] Buy milk ⏳ 2026-07-09"), target);

    expect((await tasks.inboxModel()).items).toEqual([]);
    expect((await tasks.day(target)).items.map((t) => t.title)).toEqual(["Buy milk"]);
    // The same two models throughout: each took the new reading rather than being replaced.
    expect(await tasks.inboxModel()).toBe(inbox);
    expect(await tasks.day(target)).toBe(day);
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
    const { contents, tasks } = makeApp({ "2026-07-09.md": "" });
    const outcome = await tasks.addTaskToDay(new Date(2026, 6, 9), "Buy milk");
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(contents.get("2026-07-09.md")).toBe("\n# Tasks\n- [ ] Buy milk ➕ 2026-07-01");
    expect(contents.get("Inbox.md")).toBeUndefined();
  });

  it("creates today's note on demand", async () => {
    const { contents, tasks } = makeApp();
    const outcome = await tasks.addTaskToDay(TODAY, "Buy milk");
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(contents.get("2026-07-01.md")).toContain("- [ ] Buy milk ➕ 2026-07-01");
  });

  it("puts the task in the inbox with a ⏳ target date when the day has no note", async () => {
    const { contents, tasks } = makeApp({ "Inbox.md": "" });
    const outcome = await tasks.addTaskToDay(new Date(2026, 6, 9), "Buy milk");
    expect(outcome).toBe(ScheduleOutcome.Targeted);
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-07-01 ⏳ 2026-07-09");
    expect(contents.has("2026-07-09.md")).toBe(false);
  });

  it("reports failure when the day's note can't be created", async () => {
    const { tasks } = await makeAppWithFailingEnsure();
    const outcome = await tasks.addTaskToDay(TODAY, "Buy milk");
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
    const { contents, tasks } = makeApp({ "day.md": "- [ ] Something else", "2026-07-09.md": "" });
    const outcome = await tasks.rescheduleChecklistItem(task("- [ ] Task ➕ 2026-06-01"), new Date(2026, 6, 9));
    expect(outcome).toBe(ScheduleOutcome.Failed);
    expect(contents.get("2026-07-09.md")).toBe("");
    expect(contents.get("day.md")).toBe("- [ ] Something else");
  });

  it("sends the item back to the inbox with a ⏳ target date when the day has no note", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] Task ➕ 2026-06-01" });
    const outcome = await tasks.rescheduleChecklistItem(task("- [ ] Task ➕ 2026-06-01"), new Date(2026, 6, 9));
    expect(outcome).toBe(ScheduleOutcome.Targeted);
    expect(contents.get("day.md")).toBe("");
    expect(contents.get("Inbox.md")).toBe("- [ ] Task ➕ 2026-06-01 ⏳ 2026-07-09");
    expect(contents.has("2026-07-09.md")).toBe(false);
  });

  it("moves the item into a day that already has a note", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] Task", "2026-07-09.md": "" });
    const outcome = await tasks.rescheduleChecklistItem(task("- [ ] Task"), new Date(2026, 6, 9));
    expect(outcome).toBe(ScheduleOutcome.Moved);
    expect(contents.get("2026-07-09.md")).toBe("\n# Tasks\n- [ ] Task");
    expect(contents.has("Inbox.md")).toBe(false);
  });

  it("does nothing when the item is no longer in the source file", async () => {
    const { contents, tasks } = makeApp({ "day.md": "- [ ] Something else" });
    const outcome = await tasks.rescheduleChecklistItem(task("- [ ] Task"), new Date(2026, 6, 9));
    expect(outcome).toBe(ScheduleOutcome.Failed);
    expect(contents.has("Inbox.md")).toBe(false);
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
    const { contents, tasks } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09" });
    await tasks.closeInboxItem(task("- [ ] Buy milk ⏳ 2026-07-09"));
    expect(contents.get("Inbox.md")).toBe("");
    expect(contents.get("2026-07-01.md")).toBe("- [x] Buy milk ✅ 2026-07-01");
  });

  it("records it on today even when its target day already has a note", async () => {
    const { contents, tasks } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    await tasks.closeInboxItem(task("- [ ] Buy milk ⏳ 2026-07-09"));
    expect(contents.get("2026-07-09.md")).toBe("");
    expect(contents.get("2026-07-01.md")).toBe("- [x] Buy milk ✅ 2026-07-01");
  });

  it("still files an unplanned item under today", async () => {
    const { contents, tasks } = makeApp({ "Inbox.md": "- [ ] Buy milk" });
    await tasks.closeInboxItem(task("- [ ] Buy milk"));
    expect(contents.get("2026-07-01.md")).toContain("- [x] Buy milk");
  });
});

describe("moveChecklistItemToInbox — target dates", () => {
  it("drops the ⏳ target date, which would otherwise pull the item straight back out", async () => {
    const line = "- [ ] Buy milk ➕ 2026-06-01 ⏳ 2026-07-09";
    const { contents, tasks } = makeApp({ "day.md": line });
    await tasks.moveChecklistItemToInbox(task(line));
    expect(contents.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-06-01");
  });
});
