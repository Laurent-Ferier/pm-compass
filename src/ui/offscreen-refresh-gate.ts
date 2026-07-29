import type { View } from "obsidian";

/**
 * Debounces a view's refreshes and holds them back entirely while it is off screen,
 * replaying the suppressed one when it comes back. A refresh is a full vault read, and
 * every keystroke in a watched note asks for one.
 */
export class OffscreenRefreshGate {
  private pending = false;
  private timer: number | null = null;

  constructor(
    private readonly view: View,
    private readonly refresh: () => void,
    /** Run on every layout change finding the view on screen, refresh owed or not. A view
     *  laid out while it had no size gets no other chance to notice it has one: swiping a
     *  mobile drawer open fires no workspace event. */
    private readonly onDisplayed?: () => void,
  ) {}

  /** Starts watching for the view coming back on screen. Call from `onOpen`. */
  register(): void {
    const { workspace } = this.view.app;
    this.view.registerEvent(workspace.on("active-leaf-change", () => this.flush()));
    this.view.registerEvent(workspace.on("layout-change", () => this.flush()));

    // The workspace's `resize` misses a sidebar being expanded — on Android, swiping the
    // drawer open fires nothing. The element itself catches every way it regains a size.
    const observer = new ResizeObserver(() => this.flush());
    observer.observe(this.view.containerEl);
    this.view.register(() => observer.disconnect());
  }

  /** True while the view is on screen. */
  get isDisplayed(): boolean {
    // `isShown` is `!!offsetParent`, covering both ways Obsidian parks a view off screen:
    // a background tab keeps it boxless in the tree, a collapsed sidedock detaches it.
    return this.view.containerEl.isShown();
  }

  /** Asks for a refresh in `delayMs`, restarting a wait already running. An off-screen
   *  view is never rebuilt; the refresh is remembered and replayed when it is shown. */
  schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.isDisplayed) {
      this.pending = true;
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      // Through `run`: the view can have been hidden during the wait.
      this.run();
    }, delayMs);
  }

  /** Refreshes if the view is on screen, otherwise just notes that a refresh is due. */
  run(): void {
    if (!this.isDisplayed) {
      this.pending = true;
      return;
    }
    this.pending = false;
    this.refresh();
  }

  /** Replays a refresh that was suppressed while the view was hidden, and lets the view
   *  re-measure itself now that it is on screen. */
  flush(): void {
    if (!this.isDisplayed) return;
    this.onDisplayed?.();
    if (this.pending) this.run();
  }

  /** Drops any refresh still owed, whether waiting on its debounce or suppressed. Call from
   *  `onClose`. */
  cancel(): void {
    this.clearTimer();
    this.pending = false;
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}
