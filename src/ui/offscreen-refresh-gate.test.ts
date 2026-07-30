// @vitest-environment jsdom
import { vi, describe, it, expect, afterEach } from "vitest";
import { OffscreenRefreshGate } from "./offscreen-refresh-gate";

// jsdom has no ResizeObserver; this stub exposes the observed elements and lets a test fire
// the callback by hand.
const resizeObservers: { observed: unknown[]; cb: () => void; disconnect: () => void }[] = [];
(window as any).ResizeObserver = class {
  observed: unknown[] = [];
  disconnect = vi.fn();
  constructor(private readonly cb: () => void) {
    resizeObservers.push(this as unknown as (typeof resizeObservers)[number]);
  }
  observe(el: unknown) {
    this.observed.push(el);
  }
  fire() {
    this.cb();
  }
};

function makeGate(shown = true) {
  const handlers: Record<string, (() => void)[]> = {};
  const containerEl = {
    isShown: vi.fn(() => shown),
  };
  const view = {
    containerEl,
    app: {
      workspace: {
        on: vi.fn((event: string, cb: () => void) => {
          (handlers[event] ??= []).push(cb);
          return { event };
        }),
      },
    },
    registerEvent: vi.fn(),
    register: vi.fn(),
  };
  const refresh = vi.fn();
  const onDisplayed = vi.fn();
  const gate = new OffscreenRefreshGate(view as any, refresh, onDisplayed);
  const emit = (event: string) => {
    for (const cb of handlers[event] ?? []) cb();
  };
  const setShown = (value: boolean) => containerEl.isShown.mockReturnValue(value);
  const resize = () => (resizeObservers.at(-1) as any).fire();
  return { gate, view, refresh, onDisplayed, emit, setShown, resize, containerEl };
}

afterEach(() => {
  vi.useRealTimers();
  resizeObservers.length = 0;
});

describe("OffscreenRefreshGate", () => {
  it("refreshes right away while the view is displayed", () => {
    const { gate, refresh } = makeGate(true);
    gate.run();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("suppresses the refresh while the view is hidden", () => {
    const { gate, refresh } = makeGate(false);
    gate.run();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("replays a single suppressed refresh once the view is shown again", () => {
    const { gate, refresh, setShown } = makeGate(false);
    gate.run();
    gate.run();
    gate.run();
    setShown(true);
    gate.flush();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the refresh pending when flushed while still hidden", () => {
    const { gate, refresh, setShown } = makeGate(false);
    gate.run();
    gate.flush();
    expect(refresh).not.toHaveBeenCalled();
    setShown(true);
    gate.flush();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("drops a refresh suppressed while hidden when cancelled", () => {
    const { gate, refresh, setShown } = makeGate(false);
    gate.run();
    gate.cancel();
    setShown(true);
    gate.flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does nothing on flush when no refresh was suppressed", () => {
    const { gate, refresh } = makeGate(true);
    gate.flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("flushes on a tab switch and on a layout change", () => {
    const { gate, refresh, emit, setShown, view } = makeGate(false);
    gate.register();
    for (const event of ["active-leaf-change", "layout-change"]) {
      expect(view.app.workspace.on).toHaveBeenCalledWith(event, expect.any(Function));
    }

    gate.run();
    setShown(true);
    emit("active-leaf-change");
    expect(refresh).toHaveBeenCalledOnce();

    gate.run();
    emit("layout-change");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("flushes when the view regains a size, which is all a sidebar being expanded reports", () => {
    const { gate, refresh, setShown, resize, containerEl } = makeGate(false);
    gate.register();
    expect(resizeObservers.at(-1)?.observed).toEqual([containerEl]);

    gate.run();
    resize();
    expect(refresh).not.toHaveBeenCalled();

    setShown(true);
    resize();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("registers its listeners through the view so they're unregistered on close", () => {
    const { gate, view } = makeGate();
    gate.register();
    expect(view.registerEvent).toHaveBeenCalledTimes(2);
    expect(view.register).toHaveBeenCalledOnce();

    // The registered teardown is what disconnects the observer.
    (view.register.mock.calls[0][0] as () => void)();
    expect(resizeObservers.at(-1)?.disconnect).toHaveBeenCalledOnce();
  });

  it("reports whether the view is displayed", () => {
    const { gate, setShown } = makeGate(true);
    expect(gate.isDisplayed).toBe(true);
    setShown(false);
    expect(gate.isDisplayed).toBe(false);
  });
});

describe("OffscreenRefreshGate.schedule", () => {
  it("refreshes once the delay has elapsed", () => {
    vi.useFakeTimers();
    const { gate, refresh } = makeGate(true);
    gate.schedule(300);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("debounces repeated requests into one refresh", () => {
    vi.useFakeTimers();
    const { gate, refresh } = makeGate(true);
    gate.schedule(300);
    vi.advanceTimersByTime(200);
    gate.schedule(300);
    vi.advanceTimersByTime(200);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("arms no timer at all while the view is hidden", () => {
    vi.useFakeTimers();
    const { gate, refresh, setShown } = makeGate(false);
    gate.schedule(300);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(refresh).not.toHaveBeenCalled();

    setShown(true);
    gate.flush();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("suppresses a refresh whose delay was still running when the view got hidden", () => {
    vi.useFakeTimers();
    const { gate, refresh, setShown } = makeGate(true);
    gate.schedule(300);
    setShown(false);
    vi.advanceTimersByTime(300);
    expect(refresh).not.toHaveBeenCalled();

    setShown(true);
    gate.flush();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("drops a refresh still waiting on its delay when cancelled", () => {
    vi.useFakeTimers();
    const { gate, refresh } = makeGate(true);
    gate.schedule(300);
    gate.cancel();
    vi.advanceTimersByTime(300);
    expect(refresh).not.toHaveBeenCalled();
  });

  describe("onDisplayed", () => {
    it("runs on a layout change with nothing pending, so a view laid out with no size can re-measure", () => {
      const { gate, onDisplayed, refresh, resize } = makeGate(true);
      gate.register();
      resize();
      expect(onDisplayed).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();
    });

    it("does not run while the view is still off screen — there is nothing to measure yet", () => {
      const { gate, onDisplayed, resize } = makeGate(false);
      gate.register();
      resize();
      expect(onDisplayed).not.toHaveBeenCalled();
    });

    it("runs before the refresh it replays, so the rebuild lands in a sized container", () => {
      const { gate, onDisplayed, refresh, setShown, resize } = makeGate(false);
      gate.register();
      gate.run();
      setShown(true);
      resize();
      expect(onDisplayed).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledOnce();
      expect(onDisplayed.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
    });
  });
});
