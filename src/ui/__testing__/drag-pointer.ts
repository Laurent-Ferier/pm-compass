/**
 * Pointer-event fakes for the drag-to-reorder tests. jsdom has no `PointerEvent`, so a
 * `MouseEvent` carrying the two fields the code reads stands in. It also reports a zero
 * rect for every element, so every row's midpoint is y=0 and a drag is expressed by the
 * sign of the pointer's final Y alone: positive lands last, negative first.
 */
export function pointerEvent(
  type: string,
  clientY: number,
  opts: { pointerId?: number; pointerType?: string; button?: number } = {},
): Event {
  return Object.assign(new MouseEvent(type, { bubbles: true, clientY, button: opts.button ?? 0 }), {
    pointerId: opts.pointerId ?? 1,
    pointerType: opts.pointerType ?? "mouse",
  });
}

/** Press the grip, move to `toY`, release — the whole gesture, synchronously. */
export function dragHandle(handle: HTMLElement, toY: number): void {
  handle.dispatchEvent(pointerEvent("pointerdown", 0));
  document.dispatchEvent(pointerEvent("pointermove", toY));
  document.dispatchEvent(pointerEvent("pointerup", toY));
}
