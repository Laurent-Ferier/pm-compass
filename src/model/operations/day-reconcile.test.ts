import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("obsidian", async () => ({
  App: class {},
  TFile: class {},
  normalizePath: (p: string) => p,
  // Imported inside the factory: this call is hoisted above the file's own imports.
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { TFile as TFileMock } from "obsidian";
import { reconcileDayNote, type DayReconcileOpts } from "./day-reconcile";
import { asApp } from "../__testing__/as-app";
import { noteFilesOf } from "../__testing__/day-vault";
import { bare } from "../__testing__/bare";
import { ALL_WEEKDAYS } from "../daily/recurring-task";

// Wednesday: the week around it runs 2026-06-29 (Monday) to 2026-07-05 (Sunday).
const TODAY = new Date(2026, 6, 1);
const INBOX = "Inbox.md";

const OPTS: DayReconcileOpts = {
  recurringTasks: [{
    id: "h1", title: "Stretch", weekdays: ALL_WEEKDAYS, order: 0, active: true,
    createdAt: new Date(2026, 0, 1), detail: "",
  }],
  recurringTasksHeading: "# Routine",
  dailyHabitsTag: "daily",
  dailyTasksHeading: "# Tasks",
  inboxPath: INBOX,
  dailyNotes: { folder: "", format: "YYYY-MM-DD", template: "" },
};

/** A vault whose day notes exist as given, with the Daily notes plugin on so a note can
 *  be made — the reconcile writes into notes that are already there. */
function makeApp(initialFiles: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialFiles));
  const vaultFile = (path: string) => {
    const f = bare(TFileMock);
    Object.assign(f, { path });
    return f;
  };
  const app = asApp({
    vault: {
      configDir: ".vault-config",
      getAbstractFileByPath: (path: string) => (store.has(path) ? vaultFile(path) : null),
      read: async (file: { path: string }) => store.get(file.path) ?? "",
      modify: async (file: { path: string }, content: string) => {
        store.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        store.set(path, content);
        return vaultFile(path);
      },
      createFolder: async () => {},
      adapter: {
        read: async (): Promise<string> => {
          throw new Error("no daily-notes.json configured");
        },
        exists: async (): Promise<boolean> => false,
      },
    },
    plugins: { plugins: {} },
    internalPlugins: { getEnabledPluginById: (): unknown => ({}) },
  });
  return { app, store, files: noteFilesOf(app) };
}

describe("reconcileDayNote", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── The habit pass ─────────────────────────────────────────────────────────

  it("gives today's note the habits its definitions call for", async () => {
    const { store, files } = makeApp({ "2026-07-01.md": "# Routine" });
    await reconcileDayNote(files, "2026-07-01.md", TODAY, OPTS);
    expect(store.get("2026-07-01.md")).toBe("# Routine\n- [ ] Stretch #daily");
  });

  it("gives a later day this week its habits too", async () => {
    const { store, files } = makeApp({ "2026-07-03.md": "# Routine" });
    await reconcileDayNote(files, "2026-07-03.md", new Date(2026, 6, 3), OPTS);
    expect(store.get("2026-07-03.md")).toBe("# Routine\n- [ ] Stretch #daily");
  });

  // A habit belongs to the day it was for: one added or reconfigured since must not be
  // written into a day already lived.
  it("leaves a day earlier this week alone", async () => {
    const { store, files } = makeApp({ "2026-06-29.md": "# Routine" });
    await reconcileDayNote(files, "2026-06-29.md", new Date(2026, 5, 29), OPTS);
    expect(store.get("2026-06-29.md")).toBe("# Routine");
  });

  it("leaves a day outside this week alone", async () => {
    const { store, files } = makeApp({ "2026-07-08.md": "# Routine" });
    await reconcileDayNote(files, "2026-07-08.md", new Date(2026, 6, 8), OPTS);
    expect(store.get("2026-07-08.md")).toBe("# Routine");
  });

  // ── The inbox migration ────────────────────────────────────────────────────

  it("moves an inbox item aimed at a day that now has a note", async () => {
    const { store, files } = makeApp({
      "2026-07-01.md": "# Routine",
      [INBOX]: "- [ ] Buy milk ⏳ 2026-07-01",
    });
    await reconcileDayNote(files, "2026-07-01.md", TODAY, OPTS);
    expect(store.get(INBOX)).toBe("");
    expect(store.get("2026-07-01.md")).toContain("- [ ] Buy milk");
  });

  // The migration runs whatever the day is: an item aimed at any day that has a note
  // belongs in it, and a note appearing is what makes this pass worth running.
  it("moves inbox items even for a day too old for habits", async () => {
    const { store, files } = makeApp({
      "2026-06-29.md": "# Routine",
      "2026-07-01.md": "",
      [INBOX]: "- [ ] Buy milk ⏳ 2026-07-01",
    });
    await reconcileDayNote(files, "2026-06-29.md", new Date(2026, 5, 29), OPTS);
    expect(store.get(INBOX)).toBe("");
    expect(store.get("2026-07-01.md")).toContain("- [ ] Buy milk");
  });

  // ── What it names ──────────────────────────────────────────────────────────

  // The habits go in as one pass over the note, which owes its own store the re-read; only
  // what is moved line by line is named back to the caller.
  it("names nothing for the note it wrote habits into, that note having marked itself", async () => {
    const { files } = makeApp({ "2026-07-01.md": "# Routine" });
    expect(await reconcileDayNote(files, "2026-07-01.md", TODAY, OPTS)).toEqual([]);
    expect(files.invalidated).toContain("2026-07-01.md");
  });

  it("names the inbox and the day an item landed in", async () => {
    const { files } = makeApp({
      "2026-07-01.md": "# Routine",
      "2026-07-03.md": "",
      [INBOX]: "- [ ] Buy milk ⏳ 2026-07-03",
    });
    const touched = await reconcileDayNote(files, "2026-07-01.md", TODAY, OPTS);
    expect(touched).toEqual([INBOX, "2026-07-03.md"]);
  });

  it("names nothing for a day too old for habits with an inbox holding nothing for it", async () => {
    const { files } = makeApp({ "2026-06-29.md": "# Routine", [INBOX]: "- [ ] Buy milk" });
    expect(await reconcileDayNote(files, "2026-06-29.md", new Date(2026, 5, 29), OPTS)).toEqual([]);
  });

  it("fills the caller's own array, so a pass that throws still names what it wrote", async () => {
    const { app, files } = makeApp({
      "2026-07-01.md": "# Routine",
      [INBOX]: "- [ ] Buy milk ⏳ 2026-07-01",
    });
    app.vault.modify = async (file: { path: string }) => {
      if (file.path === INBOX) throw new Error("disk full");
    };
    const touched: string[] = [];
    await expect(reconcileDayNote(files, "2026-07-01.md", TODAY, OPTS, touched)).rejects.toThrow("disk full");
    expect(touched).toEqual([INBOX]);
  });
});
