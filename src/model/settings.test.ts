import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_SETTINGS, readSettings, writeSettings, TaskSortKey, type StoredSettings } from "./settings";
import { startOfDay } from "./dates";

afterEach(() => {
  vi.useRealTimers();
});

/** A habit as `data.json` holds one: its `createdAt` is text. */
function storedHabit(createdAt: string) {
  return { id: "h1", title: "Walk", weekdays: 0b1111111, order: 0, active: true, detail: "", createdAt };
}

describe("readSettings", () => {
  it("parses each habit's date out of the text it is stored as", () => {
    const read = readSettings({ recurringTasks: [storedHabit("2026-03-04")] });

    expect(read.recurringTasks?.[0].createdAt).toEqual(new Date(2026, 2, 4));
  });

  it("keeps everything else as it stands", () => {
    const read = readSettings({ projectsFolder: "Work", inboxSortBy: TaskSortKey.Title });

    expect(read.projectsFolder).toBe("Work");
    expect(read.inboxSortBy).toBe(TaskSortKey.Title);
  });

  it("hands back settings holding no habits untouched", () => {
    const stored: Partial<StoredSettings> = { projectsFolder: "Work" };

    expect(readSettings(stored)).toBe(stored);
  });

  it("dates a habit whose text can't be read as one today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 11, 30));

    const read = readSettings({ recurringTasks: [storedHabit("not a date")] });

    expect(read.recurringTasks?.[0].createdAt).toEqual(startOfDay(new Date(2026, 6, 15)));
  });
});

describe("writeSettings", () => {
  it("writes each habit's date back as text", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      recurringTasks: [{ ...storedHabit("ignored"), createdAt: new Date(2026, 2, 4) }],
    };

    expect(writeSettings(settings).recurringTasks[0].createdAt).toBe("2026-03-04");
  });

  it("leaves the rest of the settings as they are", () => {
    const written = writeSettings({ ...DEFAULT_SETTINGS, projectsFolder: "Work" });

    expect(written.projectsFolder).toBe("Work");
    expect(written.recurringTasks).toEqual([]);
  });

  it("round-trips a habit's date through the store", () => {
    const createdAt = new Date(2026, 11, 31);
    const settings = { ...DEFAULT_SETTINGS, recurringTasks: [{ ...storedHabit("x"), createdAt }] };

    const read = readSettings(writeSettings(settings));

    expect(read.recurringTasks?.[0].createdAt).toEqual(createdAt);
  });
});
