import { setIcon } from "obsidian";

/**
 * Drag-to-reorder for the day-task lists (Inbox, dashboard checklist).
 *
 * Built on pointer events rather than HTML5 drag-and-drop, which never fires on
 * Obsidian mobile, and started from a dedicated grip handle rather than the row itself,
 * so a finger dragged anywhere else still scrolls the list. Rows aren't reshuffled
 * during the drag: the dragged row is translated under the pointer and a thin indicator
 * marks where it would land, which keeps every other row's geometry stable — so the drop
 * slot is resolved against row rects measured once, when the drag begins, rather than
 * re-read on every frame.
 *
 * The frame loop is scheduled on `window` (as `prefer-window-timers` wants) rather than on
 * the `activeWindow` the listeners use: a drag inside a popped-out leaf therefore loses its
 * auto-scroll if the main window is hidden behind that popout and Chromium throttles its
 * frame callbacks. The row itself still tracks the pointer, since `pointermove` repaints
 * directly.
 */

/** How far the pointer must travel before a press on the handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How close to the scroll container's edge the pointer must get for the list to
 *  auto-scroll, and how fast it scrolls once the pointer is right at that edge. */
const AUTOSCROLL_EDGE_PX = 56;
const AUTOSCROLL_MAX_PX_PER_FRAME = 14;

/** Where a dragged item landed, expressed as its new neighbours in the rendered list —
 *  `null` at either end. Callers translate that into a file position, which is not the
 *  same thing when the list is shown in reverse. */
export interface ReorderDrop<T> {
  item: T;
  prev: T | null;
  next: T | null;
}

/** Adds a grip handle for `item` as the next child of `parent`. `draggable: false` still
 *  renders the handle's width — so rows that can't be reordered stay aligned with the
 *  ones that can — but leaves it inert. */
export type AddDragHandle<T> = (
  parent: HTMLElement,
  row: HTMLElement,
  item: T,
  draggable?: boolean,
) => void;

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

/**
 * Makes `list` a reorderable list, returning the function that registers each row.
 * `onDrop` fires once per completed drag that actually changes the order; the view is
 * expected to persist the move and re-render, since nothing here mutates the DOM order.
 */
export function createDragReorder<T>(
  list: HTMLElement,
  onDrop: (drop: ReorderDrop<T>) => void,
): AddDragHandle<T> {
  list.classList.add("pm-reorder-list");

  const entries: { row: HTMLElement; item: T }[] = [];

  /** The other rows' geometry, taken once when the drag begins. `mids` are viewport
   *  coordinates (what the pointer is in) and so have to be corrected for any auto-scroll
   *  since; `tops`/`end` are relative to the list, which scrolls with the rows, and so
   *  need no correction. */
  interface RowMetrics {
    mids: number[];
    tops: number[];
    end: number;
    scrollTop: number;
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

  /** The registered rows minus the one being dragged — the list the drop slot indexes into. */
  const otherEntries = (index: number) => entries.filter((_, i) => i !== index);

  /** Repaints the dragged row and the drop indicator for the pointer's current position.
   *  Runs on every frame, so it reads the cached metrics rather than the layout: a rect
   *  per row per frame would force as many reflows on a list that cannot have moved. */
  const update = () => {
    if (!drag?.active || !drag.metrics) return;
    const { mids, tops, end, scrollTop } = drag.metrics;

    // Measured before any auto-scroll, so lift the pointer back into that frame of
    // reference rather than pushing every midpoint down into this one.
    const sinceMeasured = drag.scroller ? drag.scroller.scrollTop - scrollTop : 0;
    let slot = 0;
    while (slot < mids.length && drag.pointerY + sinceMeasured > mids[slot]) slot++;
    drag.slot = slot;

    // Past the last row, the indicator sits at that row's bottom edge instead.
    drag.indicator?.setCssProps({ "--pm-reorder-top": `${Math.round(tops[slot] ?? end)}px` });

    // The row is translated from where it still sits in the layout, so a list that
    // auto-scrolled underneath it has to be compensated for or it drifts off the pointer.
    const scrolled = drag.scroller ? drag.scroller.scrollTop - drag.startScrollTop : 0;
    entries[drag.index].row.setCssProps({
      "--pm-reorder-offset": `${Math.round(drag.pointerY - drag.startY + scrolled)}px`,
    });
  };

  /** Auto-scroll + repaint, on every frame rather than on every pointermove: a finger
   *  held still at the list's edge must keep scrolling, and it emits no move events.
   *  Runs from the press rather than from the first move, so the teardown check below
   *  also covers a press that never travelled far enough to become a drag. */
  const tick = () => {
    if (!drag) return;
    // A refresh or a closed tab mid-gesture detaches the rows this drag is animating: give
    // up rather than keep a frame loop, and the document listeners, alive against dead DOM.
    if (!list.isConnected) {
      finish(false);
      return;
    }
    if (drag.active) {
      const scroller = drag.scroller;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const pastTop = rect.top + AUTOSCROLL_EDGE_PX - drag.pointerY;
        const pastBottom = drag.pointerY - (rect.bottom - AUTOSCROLL_EDGE_PX);
        const overshoot = pastTop > 0 ? -pastTop : pastBottom > 0 ? pastBottom : 0;
        if (overshoot !== 0) {
          const ratio = Math.max(-1, Math.min(1, overshoot / AUTOSCROLL_EDGE_PX));
          scroller.scrollTop += ratio * AUTOSCROLL_MAX_PX_PER_FRAME;
        }
      }
      update();
    }
    drag.frame = window.requestAnimationFrame(tick);
  };

  const begin = () => {
    if (!drag) return;

    // Taken here rather than at the press: the wheel still scrolls the list while the
    // button is held, so `startScrollTop` isn't necessarily what these were measured at.
    const listTop = list.getBoundingClientRect().top;
    const rects = otherEntries(drag.index).map((o) => o.row.getBoundingClientRect());
    drag.metrics = {
      mids: rects.map((r) => r.top + r.height / 2),
      tops: rects.map((r) => r.top - listTop),
      end: rects.length > 0 ? rects[rects.length - 1].bottom - listTop : 0,
      scrollTop: drag.scroller?.scrollTop ?? 0,
    };

    drag.active = true;
    list.classList.add("pm-reorder-list--dragging");
    entries[drag.index].row.classList.add("pm-reorder-row--dragging");
    // Matches the list's own child element, so the indicator stays valid markup whether
    // the rows are `li`s (the dashboard checklist) or plain divs (the Inbox).
    const tag = list.tagName === "UL" || list.tagName === "OL" ? "li" : "div";
    drag.indicator = list.createEl(tag, { cls: "pm-reorder-indicator" });
  };

  /** Tears the drag down and, when `commit` and the slot actually moved, reports the drop. */
  const finish = (commit: boolean) => {
    if (!drag) return;
    const { index, active, slot, frame, indicator, detach } = drag;
    drag = null;

    detach();
    if (frame !== null) window.cancelAnimationFrame(frame);
    indicator?.remove();
    list.classList.remove("pm-reorder-list--dragging");
    // Dropping the class is enough to undo the translation: the transform is declared on
    // it, and only reads the offset property this drag left behind.
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
    const handle = parent.createDiv({
      cls: `pm-reorder-handle${draggable ? "" : " pm-reorder-handle--inert"}`,
      attr: draggable
        ? { "aria-label": "Drag to reorder", title: "Drag to reorder" }
        : { "aria-hidden": "true" },
    });
    setIcon(handle, "grip-vertical");
    if (!draggable) return;

    const index = entries.length;
    entries.push({ row, item });

    // A press on the grip that never travelled far enough to become a drag still ends in
    // a click, which the row would read as `attachActionsTapToggle`'s "open the toolbar"
    // tap. A completed drag needs no such guard: the dragged row is `pointer-events: none`
    // throughout, so press and release land on different elements and the browser fires
    // the click at their common ancestor — the list, which listens for none.
    handle.addEventListener("click", (e) => e.stopPropagation());

    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();

      // Tracked on `activeDocument` rather than the handle: the pointer leaves the handle
      // almost immediately, and pointer capture isn't reliable across Obsidian's mobile
      // WebViews. `touch-action: none` on the handle keeps touch drags from scrolling.
      const onMove = (ev: PointerEvent) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        drag.pointerY = ev.clientY;
        if (!drag.active) {
          if (Math.abs(ev.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
          begin();
        }
        ev.preventDefault();
        update();
      };
      const onUp = (ev: PointerEvent) => { if (drag?.pointerId === ev.pointerId) finish(true); };
      const onCancel = (ev: PointerEvent) => { if (drag?.pointerId === ev.pointerId) finish(false); };
      activeDocument.addEventListener("pointermove", onMove, { passive: false });
      activeDocument.addEventListener("pointerup", onUp);
      activeDocument.addEventListener("pointercancel", onCancel);

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
        },
      };
      drag.frame = window.requestAnimationFrame(tick);
    });
  };
}
