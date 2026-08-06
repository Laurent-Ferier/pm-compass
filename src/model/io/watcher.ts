import { App, EventRef, TAbstractFile, TFile } from "obsidian";

/** How long a burst of vault events is gathered before the views hear about it. */
const COALESCE_MS = 50;

/**
 * A burst of vault events gathered into one telling. A listing repair writes dozens of
 * notes, and they are one change as far as a view is concerned.
 *
 * Only the telling waits: whatever marks a note stale has already done so by the time this
 * is asked to schedule, which is what lets a read taken meanwhile be correct.
 */
export class Coalescer {
  private timer: number | null = null;

  constructor(private readonly ms: number, private readonly flush: () => void) {}

  /** Starts the window, or leaves the one already running to finish. */
  schedule(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.ms);
  }

  /** Drops a window in flight, telling no one. */
  cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}

/** What a watcher hands the vault's changes to — the store holding the notes under it. */
export interface WatchTarget {
  /** A note at that path was created or edited. A path that is not the target's own is
   *  its to ignore. */
  touched(path: string): void;
  /** The note at that path is gone. */
  gone(path: string): void;
  /** Tells the listeners about what has gathered since the last window closed. */
  announce(): void;
}

/**
 * The vault side of a store: Obsidian's own events, and the window a burst of them is
 * gathered into. What a change means is the target's — this is what hears about it.
 */
export class Watcher {
  /** Each ref with the object that handed it out: only that one can drop it. */
  private readonly refs: { off: (ref: EventRef) => void; ref: EventRef }[] = [];
  private readonly coalescer = new Coalescer(COALESCE_MS, () => this.target.announce());

  constructor(private readonly app: App, private readonly target: WatchTarget) {}

  /** Begins watching the vault. Reads no notes — the target's first read does that. */
  start(): void {
    const { metadataCache, vault } = this.app;
    const onMeta = { off: (r: EventRef) => metadataCache.offref(r) };
    const onVault = { off: (r: EventRef) => vault.offref(r) };
    this.refs.push(
      { ...onMeta, ref: metadataCache.on("changed", (file: TFile) => this.target.touched(file.path)) },
      { ...onVault, ref: vault.on("modify", (file: TAbstractFile) => this.target.touched(file.path)) },
      { ...onVault, ref: vault.on("create", (file: TAbstractFile) => this.target.touched(file.path)) },
      { ...onVault, ref: vault.on("delete", (file: TAbstractFile) => this.target.gone(file.path)) },
      {
        ...onVault,
        ref: vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          this.target.gone(oldPath);
          this.target.touched(file.path);
        }),
      },
    );
  }

  /** Stops watching the vault, and drops a window in flight. */
  dispose(): void {
    for (const { off, ref } of this.refs) off(ref);
    this.refs.length = 0;
    this.coalescer.cancel();
  }

  /** Opens the window the next telling goes out at the end of, for a change the vault's
   *  own events never carry — a write of the plugin's own. */
  schedule(): void {
    this.coalescer.schedule();
  }
}
