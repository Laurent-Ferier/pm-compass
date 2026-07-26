/**
 * Pointer-event fakes for the drag-to-reorder tests (`src/ui/drag-reorder.ts`).
 *
 * jsdom has no `PointerEvent`, so a `MouseEvent` carrying the two pointer fields the code
 * reads stands in for one. It also reports a zero rect for every element, which means each
 * row's midpoint sits at y=0 and a drag is expressed purely by the sign of the pointer's
 * final Y: positive lands past every other row (last), negative lands in front of all of
 * them (first).
 */
export function pointerEvent(type: string, clientY: number): Event {
  return Object.assign(new MouseEvent(type, { bubbles: true, clientY }), {
    pointerId: 1,
    pointerType: "mouse",
  });
}

/** Press the grip, move to `toY`, release — the whole gesture, synchronously. */
export function dragHandle(handle: HTMLElement, toY: number): void {
  handle.dispatchEvent(pointerEvent("pointerdown", 0));
  document.dispatchEvent(pointerEvent("pointermove", toY));
  document.dispatchEvent(pointerEvent("pointerup", toY));
}
