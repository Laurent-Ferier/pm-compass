import { App, Scope } from "obsidian";

/**
 * The shell every picker popup in the plugin is drawn in — the calendar, the icon grid. It
 * hangs off the dialog it was opened from, or off `activeDocument.body` when there is none,
 * so no overflow-clipping ancestor can hide it. It is placed against the anchor and clamped
 * to the viewport, and closes on outside pointerdown, Escape, a scroll outside it, or a
 * resize.
 *
 * Escape goes through a scope pushed onto Obsidian's keymap rather than a listener of the
 * popup's own: a modal's Escape handler is registered when the app starts, so on the same
 * target it runs first and closes the dialog under the popup along with it. The scope is
 * parented to the app's so global hotkeys still answer while a picker is open — except in
 * a dialog, where Obsidian's own modal scope has no parent for the same reason a popup's
 * must not: a hotkey answered there draws its palette on top of the dialog.
 *
 * Inside the dialog rather than beside it because Obsidian's own modal keeps the focus in:
 * a popup hung on the body has its search box emptied of the caret the moment it is given
 * one, and what is typed lands in the field underneath instead.
 *
 * The active document and window, not the app's own: a leaf popped out into a second window
 * has its own, and a popup hung on the wrong one is drawn where nobody is looking and never
 * hears the click that should dismiss it.
 */

const GAP = 4; // px between the anchor and the popup

/** Only one picker may be open at a time. Opening another — or clicking the same anchor
 *  again — closes the one before it rather than stacking a second popup. */
let openPopup: (() => void) | null = null;

export interface AnchoredPopup {
  /** The popup's own element: what the caller fills, and empties to redraw. */
  el: HTMLElement;
  close: () => void;
  /** Places the popup against its anchor. The caller calls this once its content is in —
   *  the popup has to be laid out to be measured — and not again as the content changes,
   *  so a redraw doesn't make the popup jump. */
  position: () => void;
}

/** Opens an empty popup anchored to `anchor`, under the class the caller styles it by. */
export function openAnchoredPopup(app: App, anchor: HTMLElement, cls: string): AnchoredPopup {
  openPopup?.();

  const modal = anchor.closest<HTMLElement>(".modal");
  const el = (modal ?? activeDocument.body).createDiv({ cls });

  const scope = new Scope(modal ? undefined : app.scope);
  // `false` is what tells Obsidian the key is spent, so the dialog underneath never sees it.
  scope.register([], "Escape", () => { close(); return false; });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (openPopup === close) openPopup = null;
    activeDocument.removeEventListener("pointerdown", onOutside, true);
    activeWindow.removeEventListener("resize", close);
    activeWindow.removeEventListener("scroll", onScroll, true);
    app.keymap.popScope(scope);
    el.remove();
  };

  const onOutside = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  // A popup with a list too long for it scrolls inside itself; only the view moving out
  // from under it is reason to close.
  const onScroll = (e: Event): void => {
    if (!el.contains(e.target as Node)) close();
  };

  /** Where the last `place` meant to put the popup, in viewport coordinates. */
  let placedAt = { left: 0, top: 0 };

  /** Below the anchor by default, flipping above and shifting left as needed so it stays
   *  inside the viewport. The offsets are what the pass before it landed off by. */
  const place = (offsetX = 0, offsetY = 0): void => {
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = activeDocument.documentElement.clientWidth;
    const vh = activeDocument.documentElement.clientHeight;

    let top = a.bottom + GAP;
    if (top + h > vh && a.top - GAP - h >= 0) top = a.top - GAP - h;
    top = Math.max(GAP, Math.min(top, vh - h - GAP));

    let left = a.left;
    if (left + w > vw - GAP) left = vw - w - GAP;
    left = Math.max(GAP, left);

    placedAt = { left, top };
    el.style.top = `${Math.round(top - offsetY)}px`;
    el.style.left = `${Math.round(left - offsetX)}px`;
  };

  // Placed twice: these are viewport coordinates, and a fixed element inside a dialog an
  // animation left a transform on is laid out against that dialog instead. The second pass
  // corrects by however far the first one landed off — of nothing, where the two agree.
  // A popup measuring zero was never laid out, and there is nothing to correct against.
  const position = (): void => {
    place();
    const landed = el.getBoundingClientRect();
    if (!landed.width && !landed.height) return;
    place(landed.left - placedAt.left, landed.top - placedAt.top);
  };

  activeDocument.addEventListener("pointerdown", onOutside, true);
  app.keymap.pushScope(scope);
  activeWindow.addEventListener("resize", close);
  activeWindow.addEventListener("scroll", onScroll, true);

  openPopup = close;
  return { el, close, position };
}
