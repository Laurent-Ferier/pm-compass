// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { MockTFile, MockTFolder } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string, public extension: string, public basename: string) {}
  }
  class MockTFolder {
    constructor(public children: (MockTFile | MockTFolder)[] = []) {}
  }
  return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  TFolder: MockTFolder,
  normalizePath: (p: string) => p.replace(/\/+$/, ""),
}));

import type { App } from "obsidian";
import { FileCache, folderNoteFiles, isFolderNotePath } from "./file-cache";
import { CacheEvent, ChangeOrigin, type CacheEvents } from "./cache-events";
import { asApp } from "../__testing__/as-app";
import type { IModel } from "../i-model";

const FOLDER = "Notes";

function file(path: string): InstanceType<typeof MockTFile> {
  const name = path.split("/").pop()!;
  return new MockTFile(path, name.endsWith(".md") ? "md" : "png", name.replace(/\.[^.]+$/, ""));
}

describe("folderNoteFiles", () => {
  /** A vault holding one folder tree at `FOLDER` and nothing else. */
  function vaultOf(tree: InstanceType<typeof MockTFolder>): App {
    return asApp({
      vault: { getAbstractFileByPath: (p: string) => (p === FOLDER ? tree : null) },
    });
  }

  it("reads every note under the folder, however deep", () => {
    const app = vaultOf(new MockTFolder([
      file("Notes/a.md"),
      new MockTFolder([file("Notes/sub/b.md"), new MockTFolder([file("Notes/sub/deep/c.md")])]),
    ]));

    expect(folderNoteFiles(app, FOLDER).map((f) => f.path))
      .toEqual(["Notes/a.md", "Notes/sub/b.md", "Notes/sub/deep/c.md"]);
  });

  it("leaves out what isn't a note", () => {
    const app = vaultOf(new MockTFolder([file("Notes/a.md"), file("Notes/picture.png")]));

    expect(folderNoteFiles(app, FOLDER).map((f) => f.path)).toEqual(["Notes/a.md"]);
  });

  it("leaves out the copies a syncing tool left beside a note", () => {
    const app = vaultOf(new MockTFolder([
      file("Notes/a.md"),
      file("Notes/a.sync-conflict-20260809-142131-E3KD4S5.md"),
      file("Notes/b (conflicted copy 2026-08-09).md"),
    ]));

    expect(folderNoteFiles(app, FOLDER).map((f) => f.path)).toEqual(["Notes/a.md"]);
  });

  it("reads nothing out of a folder the vault doesn't hold", () => {
    expect(folderNoteFiles(vaultOf(new MockTFolder()), "Elsewhere")).toEqual([]);
  });

  it("reads nothing out of a path that is a note rather than a folder", () => {
    const app = asApp({ vault: { getAbstractFileByPath: () => file("Notes.md") } });

    expect(folderNoteFiles(app, FOLDER)).toEqual([]);
  });
});

describe("isFolderNotePath", () => {
  it("holds a note under the folder", () => {
    expect(isFolderNotePath("Notes/a.md", FOLDER)).toBe(true);
    expect(isFolderNotePath("Notes/sub/a.md", FOLDER)).toBe(true);
  });

  it("holds nothing that isn't a note", () => {
    expect(isFolderNotePath("Notes/picture.png", FOLDER)).toBe(false);
  });

  it("holds nothing outside the folder, the folder note itself included", () => {
    expect(isFolderNotePath("Other/a.md", FOLDER)).toBe(false);
    expect(isFolderNotePath("Notes.md", FOLDER)).toBe(false);
  });

  it("holds no copy a syncing tool left behind", () => {
    expect(isFolderNotePath("Notes/a.sync-conflict-20260809-142131-X.md", FOLDER)).toBe(false);
    expect(isFolderNotePath("Notes/a (conflicted copy 2026-08-09).md", FOLDER)).toBe(false);
  });

  it("reads a trailing slash on the folder as no slash at all", () => {
    expect(isFolderNotePath("Notes/a.md", "Notes/")).toBe(true);
  });
});

/** The vault's events, held so a test can fire one. */
function eventVault() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const off = vi.fn();
  const on = (event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(event, handler);
    return { event };
  };
  const app = asApp({
    vault: { on, offref: off },
    metadataCache: { on, offref: off },
  });
  return { app, handlers, off, fire: (e: string, ...args: unknown[]) => handlers.get(e)?.(...args) };
}

/** A cache over `Notes/`, with what the base keeps to itself opened up to the test. */
class TestCache extends FileCache<string> {
  announced = 0;
  readonly createdPaths: string[] = [];
  readonly reparsedPaths: string[] = [];
  readonly deletedPaths: string[] = [];
  invalidations = 0;
  reads = false;

  owns(path: string): boolean {
    return isFolderNotePath(path, FOLDER);
  }

  protected announce(): void {
    this.announced += 1;
  }

  protected override get readsOnTouch(): boolean {
    return this.reads;
  }

  protected override created(path: string): void { this.createdPaths.push(path); }
  protected override reparsed(path: string): void { this.reparsedPaths.push(path); }
  protected override deleted(path: string): void { this.deletedPaths.push(path); }
  protected override invalidated(): void { this.invalidations += 1; }

  // What the tests read the base's own state through.
  filed(): [string, ChangeOrigin][] { return [...this.takePending()]; }
  entry(path: string): string | undefined { return this.held(path); }
  paths(): string[] { return this.heldPaths(); }
  put(path: string, entry: string): void { this.keep(path, entry); }
  drop1(path: string): void { this.forget(path); }
  dropAll(): void { this.forgetAll(); }
  owedFromTheFile(path: string): boolean { return this.owedFromFile(path); }
  owed(path: string): boolean { return this.isStale(path); }
  takeOwed(): [string, boolean][] { return this.takeStale(); }
  forgetOwed(): void { this.clearStale(); }
  unstalePath(path: string): void { this.unstale(path); }
  openWindow(): void { this.schedule(); }
  say(path: string, origin: ChangeOrigin): void { this.mark(path, origin); }
  tell(payload: CacheEvents[CacheEvent.ProjectsChanged]): void { this.emit(CacheEvent.ProjectsChanged, payload); }
}

function model(filePath: string | null): IModel {
  return { id: "m", filePath, refresh: vi.fn(), discard: vi.fn() };
}

describe("FileCache", () => {
  let vault: ReturnType<typeof eventVault>;
  let cache: TestCache;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = eventVault();
    cache = new TestCache(vault.app);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the notes it holds", () => {
    it("keeps an entry per path, and hands back what it last parsed", () => {
      cache.put("Notes/a.md", "A");

      expect(cache.entry("Notes/a.md")).toBe("A");
      expect(cache.holds("Notes/a.md")).toBe(true);
      expect(cache.paths()).toEqual(["Notes/a.md"]);
    });

    it("holds nothing for a path it never read", () => {
      expect(cache.entry("Notes/a.md")).toBeUndefined();
      expect(cache.holds("Notes/a.md")).toBe(false);
    });

    it("forgets one note, and forgets them all", () => {
      cache.put("Notes/a.md", "A");
      cache.put("Notes/b.md", "B");

      cache.drop1("Notes/a.md");
      expect(cache.paths()).toEqual(["Notes/b.md"]);

      cache.dropAll();
      expect(cache.paths()).toEqual([]);
    });

    it("says what it holds may have moved whenever a mark changes", () => {
      cache.touch("Notes/a.md");
      cache.drop("Notes/a.md");
      cache.clear();

      expect(cache.invalidations).toBe(3);
    });

    it("says nothing about a path that isn't its own", () => {
      expect(cache.touch("Other/a.md")).toBe(false);
      expect(cache.drop("Other/a.md")).toBe(false);
      expect(cache.invalidations).toBe(0);
    });
  });

  describe("the notes it is owed a read of", () => {
    it("marks a touched note for re-reading, off the metadata cache", () => {
      expect(cache.touch("Notes/a.md")).toBe(true);

      expect(cache.hasStale()).toBe(true);
      expect(cache.owed("Notes/a.md")).toBe(true);
      expect(cache.owedFromTheFile("Notes/a.md")).toBe(false);
    });

    it("marks a note the plugin wrote for re-reading off the file", () => {
      cache.invalidate("Notes/a.md");

      expect(cache.owedFromTheFile("Notes/a.md")).toBe(true);
      expect(cache.filed()).toEqual([["Notes/a.md", ChangeOrigin.Plugin]]);
    });

    it("keeps a note owed off the file owed off the file when the vault touches it too", () => {
      cache.invalidate("Notes/a.md");
      cache.touch("Notes/a.md");

      expect(cache.owedFromTheFile("Notes/a.md")).toBe(true);
    });

    it("says nothing about a write to a path that isn't its own", () => {
      cache.invalidate("Other/a.md");

      expect(cache.hasStale()).toBe(false);
      expect(cache.filed()).toEqual([]);
    });

    it("hands the owed reads over once, cleared as they are taken", () => {
      cache.touch("Notes/a.md");
      cache.invalidate("Notes/b.md");

      expect(cache.takeOwed()).toEqual([["Notes/a.md", false], ["Notes/b.md", true]]);
      expect(cache.hasStale()).toBe(false);
    });

    it("takes one path off the owed list, and drops the lot", () => {
      cache.touch("Notes/a.md");
      cache.touch("Notes/b.md");

      cache.unstalePath("Notes/a.md");
      expect(cache.owed("Notes/a.md")).toBe(false);

      cache.forgetOwed();
      expect(cache.hasStale()).toBe(false);
    });

    it("forgets what a dropped note was owed, and clearing forgets every mark", () => {
      cache.touch("Notes/a.md");
      cache.drop("Notes/a.md");
      expect(cache.hasStale()).toBe(false);

      cache.touch("Notes/b.md");
      cache.clear();
      expect(cache.hasStale()).toBe(false);
    });
  });

  describe("what it files for the next telling", () => {
    it("files a model's own path, under a write of the plugin's own", () => {
      cache.changed(model("Notes/a.md"));

      expect(cache.filed()).toEqual([["Notes/a.md", ChangeOrigin.Plugin]]);
    });

    it("files nothing for a model over no note", () => {
      cache.changed(model(null));

      expect(cache.filed()).toEqual([]);
    });

    it("lets a vault edit outweigh a write of the plugin's own on the same path", () => {
      cache.say("Notes/a.md", ChangeOrigin.Plugin);
      cache.say("Notes/a.md", ChangeOrigin.Vault);
      cache.say("Notes/a.md", ChangeOrigin.Plugin);

      expect(cache.filed()).toEqual([["Notes/a.md", ChangeOrigin.Vault]]);
    });

    it("hands the gathered paths over once", () => {
      cache.say("Notes/a.md", ChangeOrigin.Vault);

      expect(cache.filed()).toHaveLength(1);
      expect(cache.filed()).toEqual([]);
    });

    it("tells the views at the end of the window, however many changes it gathered", () => {
      cache.start();
      cache.say("Notes/a.md", ChangeOrigin.Vault);
      cache.say("Notes/b.md", ChangeOrigin.Vault);
      cache.openWindow();

      expect(cache.announced).toBe(0);
      vi.runAllTimers();

      expect(cache.announced).toBe(1);
    });
  });

  describe("what the vault tells it", () => {
    beforeEach(() => {
      cache.start();
    });

    it("marks a note the vault reparsed, and says the change came from outside", () => {
      vault.fire("changed", { path: "Notes/a.md" });

      expect(cache.owed("Notes/a.md")).toBe(true);
      expect(cache.reparsedPaths).toEqual(["Notes/a.md"]);
      expect(cache.filed()).toEqual([["Notes/a.md", ChangeOrigin.Vault]]);
    });

    it("reads an event on a note it is still owed a read of as its own write echoing back", () => {
      cache.invalidate("Notes/a.md");
      cache.filed();

      vault.fire("modify", { path: "Notes/a.md" });

      expect(cache.filed()).toEqual([["Notes/a.md", ChangeOrigin.Plugin]]);
    });

    it("hands a created note to the cache as a creation", () => {
      vault.fire("create", { path: "Notes/a.md" });

      expect(cache.createdPaths).toEqual(["Notes/a.md"]);
      expect(cache.reparsedPaths).toEqual([]);
    });

    it("ignores an event about a note that isn't its own", () => {
      vault.fire("create", { path: "Other/a.md" });

      expect(cache.createdPaths).toEqual([]);
      expect(cache.filed()).toEqual([]);
    });

    it("says nothing itself when it takes its re-reading from the event", () => {
      cache.reads = true;

      vault.fire("changed", { path: "Notes/a.md" });

      expect(cache.reparsedPaths).toEqual(["Notes/a.md"]);
      expect(cache.filed()).toEqual([]);
    });

    it("forgets a deleted note, files it, and says what it cost the notes around it", () => {
      cache.put("Notes/a.md", "A");

      vault.fire("delete", { path: "Notes/a.md" });

      expect(cache.holds("Notes/a.md")).toBe(false);
      expect(cache.deletedPaths).toEqual(["Notes/a.md"]);
      expect(cache.filed()).toEqual([["Notes/a.md", ChangeOrigin.Vault]]);
    });

    it("files both ends of a rename, and treats neither as a deletion", () => {
      cache.put("Notes/a.md", "A");

      vault.fire("rename", { path: "Notes/b.md" }, "Notes/a.md");

      expect(cache.deletedPaths).toEqual([]);
      expect(cache.owed("Notes/b.md")).toBe(true);
      expect(cache.filed()).toEqual([
        ["Notes/a.md", ChangeOrigin.Vault],
        ["Notes/b.md", ChangeOrigin.Vault],
      ]);
    });

    it("files nothing for a note renamed into the folder from outside it", () => {
      vault.fire("rename", { path: "Notes/b.md" }, "Other/a.md");

      expect(cache.filed()).toEqual([["Notes/b.md", ChangeOrigin.Vault]]);
    });
  });

  describe("its listeners", () => {
    it("hands a subscriber the payload of the event it asked for", () => {
      const heard = vi.fn();
      cache.on(CacheEvent.ProjectsChanged, heard);

      cache.tell({ paths: ["Notes/a.md"], origin: ChangeOrigin.Vault });

      expect(heard).toHaveBeenCalledWith({ paths: ["Notes/a.md"], origin: ChangeOrigin.Vault });
    });

    it("stops calling a subscriber that unsubscribed", () => {
      const heard = vi.fn();
      const off = cache.on(CacheEvent.ProjectsChanged, heard);

      off();
      cache.tell({ paths: [], origin: ChangeOrigin.Vault });

      expect(heard).not.toHaveBeenCalled();
    });

    it("drops the window in flight, and lets go of the vault, when it is disposed of", () => {
      cache.start();
      cache.say("Notes/a.md", ChangeOrigin.Vault);

      cache.dispose();
      vi.runAllTimers();

      expect(vault.off).toHaveBeenCalledTimes(5);
      expect(cache.announced).toBe(0);
    });

    it("tells no subscriber anything more once it is disposed of", () => {
      const heard = vi.fn();
      cache.on(CacheEvent.ProjectsChanged, heard);

      cache.dispose();
      cache.tell({ paths: ["Notes/a.md"], origin: ChangeOrigin.Vault });

      expect(heard).not.toHaveBeenCalled();
    });
  });
});
