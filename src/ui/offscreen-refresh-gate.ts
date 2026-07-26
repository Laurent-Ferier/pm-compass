import type { View } from "obsidian";

/**
 * Debounces a view's refreshes, and holds them back entirely while it isn't on screen —
 * sitting behind another tab, or inside a collapsed sidebar — replaying the suppressed one
 * as soon as it comes back.
 *
 * Every keystroke in a watched note ends up asking for a refresh, and a refresh is a full
 * vault read; spending that on a display nobody is looking at costs time and battery for
 * nothing.
 */
export class OffscreenRefreshGate {
  private pending = false;
  private timer: number | null = null;

  constructor(
    private readonly view: View,
    private readonly refresh: () => void,
    /** Run on every layout change that finds the view on screen, whether or not a refresh
     *  was owed. A view that laid itself out while it had no size — rendered inside a
     *  closed drawer or a background tab — gets no other chance to notice it has one now:
     *  swiping a mobile drawer open fires no workspace event, and with nothing pending
     *  there is no rebuild to piggyback on. */
    private readonly onDisplayed?: () => void,
  ) {}

  /** Starts watching for the view coming back on screen. Call from `onOpen`. */
  register(): void {
    const { workspace } = this.view.app;
    this.view.registerEvent(workspace.on("active-leaf-change", () => this.flush()));
    this.view.registerEvent(workspace.on("layout-change", () => this.flush()));

    // The workspace's own `resize` event misses a sidebar being expanded — verified on
    // Android, where swiping the drawer open fires no workspace event at all, yet the view
    // is on screen. Watching the element itself catches every way it can regain a size, and
    // always after `isShown` has flipped.
    const observer = new ResizeObserver(() => this.flush());
    observer.observe(this.view.containerEl);
    this.view.register(() => observer.disconnect());
  }

  /** True while the view is on screen. */
  get isDisplayed(): boolean {
    // `isShown` is `!!offsetParent`, so it covers every way Obsidian parks a view off
    // screen: a background tab keeps it in the tree with no box, a collapsed sidedock
    // detaches it outright.
    return this.view.containerEl.isShown();
  }

  /**
   * Asks for a refresh in `delayMs`, restarting the wait if one was already running. An
   * off-screen view isn't rebuilt at all, not even later on a timer: the refresh is
   * remembered and replayed when the view is shown again.
   */
  schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.isDisplayed) {
      this.pending = true;
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      // Through `run`, not straight to the refresh: the view can have been hidden during
      // the wait.
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
