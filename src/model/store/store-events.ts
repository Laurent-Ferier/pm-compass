import type { DayNoteEntry } from "./day-store";

/** What the stores tell the views about. `ProjectsChanged` is `ProjectNoteStore`'s; the rest
 *  are `DayStore`'s, which `TaskStore` hands on. */
export enum StoreEvent {
  /** One or more project notes were re-read; what the projects folder holds has changed. */
  ProjectsChanged = "projects-changed",
  /** One or more day notes were re-read. */
  DaysChanged = "days-changed",
  /** The inbox note was re-read. */
  InboxChanged = "inbox-changed",
  /** A day the warm-up reached, delivered as it lands so a list can take its rows
   *  without the tree being rebuilt. */
  DayWarmed = "day-warmed",
  /** Every day in the window is held. */
  WarmupFinished = "warmup-finished",
}

/** One day of the window, with where it sits relative to the day on show. */
export interface WarmedDay {
  entry: DayNoteEntry;
  offset: number;
}

export interface StoreEvents {
  [StoreEvent.ProjectsChanged]: { paths: string[] };
  [StoreEvent.DaysChanged]: { paths: string[] };
  [StoreEvent.InboxChanged]: { path: string };
  [StoreEvent.DayWarmed]: WarmedDay;
  [StoreEvent.WarmupFinished]: { days: number };
}

/**
 * A subscriber list per event, typed by a map of event name to payload.
 *
 * Obsidian's own `Events` is string-keyed with `unknown[]` payloads, so every handler
 * would open with a cast. This keeps the payload types, and hands back the unsubscribe
 * rather than an `EventRef` — which is what a view passes to `register()` anyway.
 */
export class TypedEmitter<M> {
  private readonly listeners = new Map<keyof M, Set<(payload: never) => void>>();

  /** Registers `handler`, returning the call that drops it again. */
  on<K extends keyof M>(event: K, handler: (payload: M[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  /** Over a copy of the set, so a handler unsubscribing itself doesn't disturb the pass.
   *  One throwing is reported and stepped over: the others are watching the same change
   *  and have their own trees to keep up to date. */
  emit<K extends keyof M>(event: K, payload: M[K]): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      try {
        (handler as (p: M[K]) => void)(payload);
      } catch (e) {
        console.error(`pm-compass: a "${String(event)}" handler failed`, e);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
