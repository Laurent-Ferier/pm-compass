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
import { migrateInboxTargets } from "./inbox-migrate";
import { asApp } from "../__testing__/as-app";
import { bare } from "../__testing__/bare";

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
  return { app, store };
}

describe("migrateInboxTargets", () => {
  const TODAY = new Date(2026, 6, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves an item into its target day once that day has a note", async () => {
    const { app, store } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(1);
    expect(store.get("Inbox.md")).toBe("");
    expect(store.get("2026-07-09.md")).toBe("\n# Tasks\n- [ ] Buy milk");
  });

  it("leaves an item whose target day still has no note", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-09" });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(0);
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ⏳ 2026-07-09");
  });

  it("moves an item targeted at today into today's note", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-01" });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(1);
    expect(store.get("2026-07-01.md")).toBe("\n# Tasks\n- [ ] Buy milk");
  });

  it("leaves a past target with no note in the inbox, keeping its date", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-06-20" });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(0);
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ⏳ 2026-06-20");
  });

  it("files a past target under its own day when that day has a note", async () => {
    const { app, store } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-06-20",
      "2026-06-20.md": "",
    });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(1);
    expect(store.get("Inbox.md")).toBe("");
    expect(store.get("2026-06-20.md")).toBe("\n# Tasks\n- [ ] Buy milk");
  });

  it("moves a completed item to today, keeping it checked, whatever day it targeted", async () => {
    const { app, store } = makeApp({
      "Inbox.md": "- [x] Buy milk ⏳ 2026-07-09 ✅ 2026-07-01",
      "2026-07-09.md": "",
    });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(1);
    expect(store.get("Inbox.md")).toBe("");
    expect(store.get("2026-07-09.md")).toBe("");
    expect(store.get("2026-07-01.md")).toBe("\n# Tasks\n- [x] Buy milk ✅ 2026-07-01");
  });

  it("moves a completed item even when its target day has no note", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [x] Buy milk ⏳ 2026-07-09 ✅ 2026-07-01" });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(1);
    expect(store.get("Inbox.md")).toBe("");
    expect(store.get("2026-07-01.md")).toBe("\n# Tasks\n- [x] Buy milk ✅ 2026-07-01");
  });

  it("leaves items with no target date alone", async () => {
    const { app, store } = makeApp({ "Inbox.md": "- [ ] Buy milk ➕ 2026-06-01" });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(0);
    expect(store.get("Inbox.md")).toBe("- [ ] Buy milk ➕ 2026-06-01");
  });

  it("moves several due items, each to its own day", async () => {
    const { app, store } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-01\n- [ ] Stay put ⏳ 2026-07-20\n- [ ] Call bank ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).moved).toBe(2);
    expect(store.get("Inbox.md")).toBe("- [ ] Stay put ⏳ 2026-07-20");
    expect(store.get("2026-07-01.md")).toContain("Buy milk");
    expect(store.get("2026-07-09.md")).toContain("Call bank");
  });

  it("carries an item's sub-lines across with it", async () => {
    const { app, store } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-01\n\tsemi-skimmed",
    });
    await migrateInboxTargets(app, "Inbox.md", "# Tasks");
    expect(store.get("2026-07-01.md")).toContain("\tsemi-skimmed");
  });

  // The paths, not the count, are what the caller invalidates: a day note left unnamed is
  // one the plugin wrote and then went on reading its old copy of.
  it("names the inbox and every day note it wrote", async () => {
    const { app } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-01\n- [ ] Call bank ⏳ 2026-07-09",
      "2026-07-09.md": "",
    });
    const { touched } = await migrateInboxTargets(app, "Inbox.md", "# Tasks");
    expect(touched).toEqual(["Inbox.md", "2026-07-01.md", "2026-07-09.md"]);
  });

  it("names each day note once, however many items land in it", async () => {
    const { app } = makeApp({
      "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-01\n- [ ] Call bank ⏳ 2026-07-01",
    });
    const { moved, touched } = await migrateInboxTargets(app, "Inbox.md", "# Tasks");
    expect(moved).toBe(2);
    expect(touched).toEqual(["Inbox.md", "2026-07-01.md"]);
  });

  it("names nothing when there was nothing to move", async () => {
    const { app } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-20" });
    expect((await migrateInboxTargets(app, "Inbox.md", "# Tasks")).touched).toEqual([]);
  });

  // The item leaves the inbox before it lands, so a pass that breaks off part-way through
  // has still rewritten the inbox.
  it("names the inbox even when the move it started throws", async () => {
    const { app } = makeApp({ "Inbox.md": "- [ ] Buy milk ⏳ 2026-07-01" });
    app.vault.create = async () => { throw new Error("disk full"); };
    const touched: string[] = [];
    await expect(
      migrateInboxTargets(app, "Inbox.md", "# Tasks", undefined, touched),
    ).rejects.toThrow("disk full");
    expect(touched).toEqual(["Inbox.md"]);
  });
});
