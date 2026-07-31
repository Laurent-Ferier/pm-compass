import { setIcon } from "obsidian";
import { Icon } from "./icons";

/**
 * Drag-to-reorder for the day-task lists. Pointer events rather than HTML5 drag-and-drop,
 * which never fires on Obsidian mobile, and from a grip handle so a finger elsewhere still
 * scrolls. The dragged row is translated under the pointer and an indicator marks the
 * landing slot, leaving every other row's geometry — and so its measured rect — stable.
 *
 * The frame loop is on `window` rather than `activeWindow`, so a drag in a popped-out leaf
 * loses auto-scroll while the main window is throttled. The row still tracks the pointer.
 */

/** How far the pointer must travel before a press on the handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How close to the scroll container's edge the pointer must get for the list to
 *  auto-scroll, and how fast it scrolls once the pointer is right at that edge. */
const AUTOSCROLL_EDGE_PX = 56;
const AUTOSCROLL_MAX_PX_PER_FRAME = 14;

/** Where a dragged item landed, as its new neighbours in the rendered list, `null` at
 *  either end. A reversed list makes that a different thing from a file position. */
export interface ReorderDrop<T> {
  item: T;
  prev: T | null;
  next: T | null;
}

/** Adds a grip handle for `item` to `parent`. `draggable: false` keeps the width, so
 *  unreorderable rows stay aligned, but leaves it inert. */
export type AddDragHandle<T> = (
  parent: HTMLElement,
  row: HTMLElement,
  item: T,
  draggable?: boolean,
) => void;

/** The grip's width and nothing else, for a list with no order to persist whose rows
 *  still have to line up with the lists around them. */
export function renderInertDragHandle(parent: HTMLElement): void {
  const handle = parent.createDiv({
    cls: "pm-reorder-handle pm-reorder-handle--inert",
    attr: { "aria-hidden": "true" },
  });
  setIcon(handle, Icon.DragHandle);
}

/** The nearest ancestor that actually scrolls, so a drag towards the viewport edge can
 *  pull more of the list into view. Null when nothing above the list scrolls. */
function findScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = activeWindow.getComputedStyle(p).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) {
      return p;
    }
  }
  return null;
}

/** Makes `list` reorderable, returning the function that registers each row. `onDrop`
 *  fires per drag that changes the order; nothing here mutates the DOM order. */
export function createDragReorder<T>(
  list: HTMLElement,
  onDrop: (drop: ReorderDrop<T>) => void,
): AddDragHandle<T> {
  list.classList.add("pm-reorder-list");

  const entries: { row: HTMLElement; item: T }[] = [];

  /** The other rows' geometry, taken once when the drag begins. `mids` are viewport
   *  coordinates and need correcting for auto-scroll; `tops`/`end` are relative to the
   *  list, which scrolls with the rows, and don't. */
  interface RowMetrics {
    mids: number[];
    tops: number[];
    end: number;
    scrollTop: number;
    /** The scroller's own edges, which scrolling can't move — measured here so the frame
     *  loop below never has to reflow to find them. Only a resize invalidates them, and
     *  `measure` is re-run on one. */
    scrollerTop: number;
    scrollerBottom: number;
  }

  interface DragState {
    index: number;
    pointerId: number;
    startY: number;
    startScrollTop: number;
    scroller: HTMLElement | null;
    pointerY: number;
    /** False until the pointer passes `DRAG_THRESHOLD_PX` — a tap never starts a drag. */
    active: boolean;
    /** Null until the drag begins, which is the point there is anything to measure. */
    metrics: RowMetrics | null;
    /** Insertion position among the other rows; equals `index` when nothing changed. */
    slot: number;
    indicator: HTMLElement | null;
    frame: number | null;
    detach: () => void;
  }
  let drag: DragState | null = null;

  /** The registered rows minus the dragged one — what the drop slot indexes into. */
  const otherEntries = (index: number) => entries.filter((_, i) => i !== index);

  /**
   * The four below take the drag as an argument rather than reading `drag`, which is
   * nullable and would have each of them re-checking what its caller has already
   * established. Only `tick` still reads it: the frame loop is entered from outside.
   */

  /** Repaints the dragged row and the indicator for the pointer's position. Runs every
   *  frame, so it reads the cached metrics rather than reflowing a list that can't move. */
  const update = (d: DragState) => {
    // The one thing a caller can't establish: `begin` is what takes the first measure,
    // and a drag that hasn't begun has nothing to repaint.
    if (!d.metrics) return;
    const { mids, tops, end, scrollTop } = d.metrics;

    // Measured before any auto-scroll, so the pointer is lifted back into that frame
    // of reference rather than every midpoint pushed into this one.
    const sinceMeasured = d.scroller ? d.scroller.scrollTop - scrollTop : 0;
    let slot = 0;
    while (slot < mids.length && d.pointerY + sinceMeasured > mids[slot]) slot++;
    d.slot = slot;

    // Past the last row, the indicator sits at that row's bottom edge instead.
    d.indicator?.setCssProps({ "--pm-reorder-top": `${Math.round(tops[slot] ?? end)}px` });

    // The row is translated from where it still sits in the layout, so a list that
    // auto-scrolled underneath it is compensated for or it drifts off the pointer.
    const scrolled = d.scroller ? d.scroller.scrollTop - d.startScrollTop : 0;
    entries[d.index].row.setCssProps({
      "--pm-reorder-offset": `${Math.round(d.pointerY - d.startY + scrolled)}px`,
    });
  };

  /** Auto-scroll and repaint, per frame rather than per pointermove: a finger held still
   *  at the list's edge must keep scrolling, and it emits no move events. Started at the
   *  press, so the teardown below covers one that never became a drag. */
  const tick = () => {
    // The frame loop is entered from outside, so this is the one place that has to say
    // whether there is still a drag at all.
    const d = drag;
    if (!d) return;
    // A refresh mid-gesture detaches the rows being animated: give up rather than keep
    // a frame loop and document listeners alive against dead DOM.
    if (!list.isConnected) {
      finish(d, false);
      return;
    }
    if (d.active && d.metrics) {
      const scroller = d.scroller;
      if (scroller) {
        const { scrollerTop, scrollerBottom } = d.metrics;
        const pastTop = scrollerTop + AUTOSCROLL_EDGE_PX - d.pointerY;
        const pastBottom = d.pointerY - (scrollerBottom - AUTOSCROLL_EDGE_PX);
        const overshoot = pastTop > 0 ? -pastTop : pastBottom > 0 ? pastBottom : 0;
        if (overshoot !== 0) {
          const ratio = Math.max(-1, Math.min(1, overshoot / AUTOSCROLL_EDGE_PX));
          scroller.scrollTop += ratio * AUTOSCROLL_MAX_PX_PER_FRAME;
        }
      }
      update(d);
    }
    d.frame = window.requestAnimationFrame(tick);
  };

  /** Reads the geometry the frame loop then works from. Called at the drag's start and
   *  again on a resize, which is the one thing that moves what these describe — on mobile
   *  the keyboard alone resizes the WebView mid-gesture. */
  const measure = (d: DragState) => {
    // Taken here, not at the press: the wheel still scrolls the list while the button
    // is held, so `startScrollTop` isn't what these were measured at.
    const listTop = list.getBoundingClientRect().top;
    const rects = otherEntries(d.index).map((o) => o.row.getBoundingClientRect());
    const scrollerRect = d.scroller?.getBoundingClientRect();
    d.metrics = {
      mids: rects.map((r) => r.top + r.height / 2),
      tops: rects.map((r) => r.top - listTop),
      end: rects.length > 0 ? rects[rects.length - 1].bottom - listTop : 0,
      scrollTop: d.scroller?.scrollTop ?? 0,
      scrollerTop: scrollerRect?.top ?? 0,
      scrollerBottom: scrollerRect?.bottom ?? 0,
    };
  };

  const begin = (d: DragState) => {
    measure(d);
    d.active = true;
    list.classList.add("pm-reorder-list--dragging");
    entries[d.index].row.classList.add("pm-reorder-row--dragging");
    // Matches the list's own child element, so the indicator is valid markup whether
    // the rows are `li`s or plain divs.
    const tag = list.tagName === "UL" || list.tagName === "OL" ? "li" : "div";
    d.indicator = list.createEl(tag, { cls: "pm-reorder-indicator" });
  };

  /** Tears the drag down and, when `commit` and the slot actually moved, reports the drop.
   *  Clears `drag` as well as reading `d`: the two are the same object, and the gesture
   *  being over is the closure's business rather than this state's. */
  const finish = (d: DragState, commit: boolean) => {
    const { index, active, slot, frame, indicator, detach } = d;
    drag = null;

    detach();
    if (frame !== null) window.cancelAnimationFrame(frame);
    indicator?.remove();
    list.classList.remove("pm-reorder-list--dragging");
    // Dropping the class undoes the translation: the transform is declared on it.
    entries[index].row.classList.remove("pm-reorder-row--dragging");

    if (!active || !commit || slot === index) return;
    const others = otherEntries(index);
    onDrop({
      item: entries[index].item,
      prev: others[slot - 1]?.item ?? null,
      next: others[slot]?.item ?? null,
    });
  };

  return (parent, row, item, draggable = true) => {
    if (!draggable) {
      renderInertDragHandle(parent);
      return;
    }
    const handle = parent.createDiv({
      cls: "pm-reorder-handle",
      attr: { "aria-label": "Drag to reorder", title: "Drag to reorder" },
    });
    setIcon(handle, Icon.DragHandle);

    const index = entries.length;
    entries.push({ row, item });

    // A press too short to become a drag still ends in a click, which the row would read
    // as a toolbar tap. A completed drag needs no guard: the row is `pointer-events: none`
    // throughout, so the click fires at the list, which listens for none.
    handle.addEventListener("click", (e) => e.stopPropagation());

    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();

      // Tracked on `activeDocument`: the pointer leaves the handle at once, and pointer
      // capture isn't reliable in Obsidian's mobile WebViews.
      const onMove = (ev: PointerEvent) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        drag.pointerY = ev.clientY;
        if (!drag.active) {
          if (Math.abs(ev.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
          begin(drag);
        }
        ev.preventDefault();
        update(drag);
      };
      const onUp = (ev: PointerEvent) => { if (drag?.pointerId === ev.pointerId) finish(drag, true); };
      const onCancel = (ev: PointerEvent) => { if (drag?.pointerId === ev.pointerId) finish(drag, false); };
      // Nothing to re-read before the drag begins, which is what takes the first measure.
      const onResize = () => { if (drag?.active) measure(drag); };
      activeDocument.addEventListener("pointermove", onMove, { passive: false });
      activeDocument.addEventListener("pointerup", onUp);
      activeDocument.addEventListener("pointercancel", onCancel);
      window.addEventListener("resize", onResize);

      const scroller = findScroller(list);
      drag = {
        index,
        pointerId: e.pointerId,
        startY: e.clientY,
        pointerY: e.clientY,
        startScrollTop: scroller?.scrollTop ?? 0,
        scroller,
        active: false,
        metrics: null,
        slot: index,
        indicator: null,
        frame: null,
        detach: () => {
          activeDocument.removeEventListener("pointermove", onMove);
          activeDocument.removeEventListener("pointerup", onUp);
          activeDocument.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("resize", onResize);
        },
      };
      drag.frame = window.requestAnimationFrame(tick);
    });
  };
}
