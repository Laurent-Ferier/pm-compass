import { describe, it, expect, vi, afterEach } from "vitest";
import { TypedEmitter } from "./store-events";

interface Events {
  loaded: { paths: string[] };
  gone: { path: string };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TypedEmitter", () => {
  it("hands each subscriber the payload of its own event", () => {
    const emitter = new TypedEmitter<Events>();
    const loaded = vi.fn();
    const gone = vi.fn();
    emitter.on("loaded", loaded);
    emitter.on("gone", gone);

    emitter.emit("loaded", { paths: ["a.md"] });

    expect(loaded).toHaveBeenCalledWith({ paths: ["a.md"] });
    expect(gone).not.toHaveBeenCalled();
  });

  it("calls every subscriber to one event", () => {
    const emitter = new TypedEmitter<Events>();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on("gone", first);
    emitter.on("gone", second);

    emitter.emit("gone", { path: "a.md" });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("stops calling a handler once its unsubscribe has run", () => {
    const emitter = new TypedEmitter<Events>();
    const handler = vi.fn();
    const off = emitter.on("gone", handler);

    off();
    emitter.emit("gone", { path: "a.md" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("drops only the handler its unsubscribe belongs to", () => {
    const emitter = new TypedEmitter<Events>();
    const kept = vi.fn();
    const off = emitter.on("gone", vi.fn());
    emitter.on("gone", kept);

    off();
    emitter.emit("gone", { path: "a.md" });

    expect(kept).toHaveBeenCalledOnce();
  });

  it("carries on past a handler that throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const emitter = new TypedEmitter<Events>();
    const after = vi.fn();
    emitter.on("gone", () => { throw new Error("nope"); });
    emitter.on("gone", after);

    expect(() => emitter.emit("gone", { path: "a.md" })).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
  });

  it("lets a handler unsubscribe itself mid-emit", () => {
    const emitter = new TypedEmitter<Events>();
    const after = vi.fn();
    const off: () => void = emitter.on("gone", () => off());
    emitter.on("gone", after);

    emitter.emit("gone", { path: "a.md" });

    expect(after).toHaveBeenCalledOnce();
  });

  it("does nothing for an event nobody registered for", () => {
    const emitter = new TypedEmitter<Events>();
    expect(() => emitter.emit("loaded", { paths: [] })).not.toThrow();
  });

  it("drops every subscriber on clear", () => {
    const emitter = new TypedEmitter<Events>();
    const handler = vi.fn();
    emitter.on("gone", handler);

    emitter.clear();
    emitter.emit("gone", { path: "a.md" });

    expect(handler).not.toHaveBeenCalled();
  });
});
