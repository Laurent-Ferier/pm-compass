// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Touch, Watcher, type WatchTarget } from "./watcher";
import { asApp } from "../__testing__/as-app";

/** Obsidian's two event sources, each handing back a ref only it can drop. */
function eventApp() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const dropped: { from: string; ref: unknown }[] = [];
  const on = (from: string) => (event: string, handler: (...args: never[]) => void) => {
    handlers.set(`${from}.${event}`, handler);
    return { from, event };
  };
  const app = asApp({
    metadataCache: {
      on: on("metadataCache"),
      offref: (ref: unknown) => dropped.push({ from: "metadataCache", ref }),
    },
    vault: {
      on: on("vault"),
      offref: (ref: unknown) => dropped.push({ from: "vault", ref }),
    },
  });
  const fire = (key: string, ...args: unknown[]) =>
    (handlers.get(key) as ((...a: unknown[]) => void) | undefined)?.(...args);
  return { app, handlers, dropped, fire };
}

function target(): WatchTarget & {
  touched: ReturnType<typeof vi.fn>;
  gone: ReturnType<typeof vi.fn>;
  announce: ReturnType<typeof vi.fn>;
} {
  return { touched: vi.fn(), gone: vi.fn(), announce: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Watcher", () => {
  it("hears nothing until it is started", () => {
    const { handlers } = eventApp();

    expect(handlers.size).toBe(0);
  });

  it("says a note Obsidian reparsed has been touched, its own reading current", () => {
    const { app, fire } = eventApp();
    const to = target();
    new Watcher(app, to).start();

    fire("metadataCache.changed", { path: "a.md" });

    expect(to.touched).toHaveBeenCalledWith("a.md", Touch.Reparsed);
  });

  it("says a written note has been touched, Obsidian's reading a step behind", () => {
    const { app, fire } = eventApp();
    const to = target();
    new Watcher(app, to).start();

    fire("vault.modify", { path: "a.md" });

    expect(to.touched).toHaveBeenCalledWith("a.md", Touch.Written);
  });

  it("says a note the vault didn't hold a moment ago was created", () => {
    const { app, fire } = eventApp();
    const to = target();
    new Watcher(app, to).start();

    fire("vault.create", { path: "a.md" });

    expect(to.touched).toHaveBeenCalledWith("a.md", Touch.Created);
  });

  it("says a deleted note is gone, and names nowhere it went", () => {
    const { app, fire } = eventApp();
    const to = target();
    new Watcher(app, to).start();

    fire("vault.delete", { path: "a.md" });

    expect(to.gone).toHaveBeenCalledWith("a.md");
  });

  it("reads a rename as a note that moved: gone from where it was, written where it now sits", () => {
    const { app, fire } = eventApp();
    const to = target();
    new Watcher(app, to).start();

    fire("vault.rename", { path: "b.md" }, "a.md");

    expect(to.gone).toHaveBeenCalledWith("a.md", "b.md");
    expect(to.touched).toHaveBeenCalledWith("b.md", Touch.Written);
  });

  it("tells the target at the end of the window, a burst of changes reaching it as one", () => {
    const { app } = eventApp();
    const to = target();
    const watcher = new Watcher(app, to);

    watcher.schedule();
    watcher.schedule();
    expect(to.announce).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(to.announce).toHaveBeenCalledOnce();
  });

  it("opens a new window once the one before it has closed", () => {
    const { app } = eventApp();
    const to = target();
    const watcher = new Watcher(app, to);

    watcher.schedule();
    vi.runAllTimers();
    watcher.schedule();
    vi.runAllTimers();

    expect(to.announce).toHaveBeenCalledTimes(2);
  });

  it("gives each ref back to whichever object handed it out", () => {
    const { app, dropped } = eventApp();
    const watcher = new Watcher(app, target());
    watcher.start();

    watcher.dispose();

    expect(dropped).toHaveLength(5);
    expect(dropped.every(({ from, ref }) => (ref as { from: string }).from === from)).toBe(true);
  });

  it("drops the window in flight when it is disposed of", () => {
    const { app } = eventApp();
    const to = target();
    const watcher = new Watcher(app, to);
    watcher.start();
    watcher.schedule();

    watcher.dispose();
    vi.runAllTimers();

    expect(to.announce).not.toHaveBeenCalled();
  });

  it("lets go of the vault only once, however often it is disposed of", () => {
    const { app, dropped } = eventApp();
    const watcher = new Watcher(app, target());
    watcher.start();

    watcher.dispose();
    watcher.dispose();

    expect(dropped).toHaveLength(5);
  });
});
