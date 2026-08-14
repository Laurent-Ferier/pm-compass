// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

// jsdom lacks the createEl/empty helpers Obsidian adds to HTMLElement.
function installObsidianDOMPolyfills() {
  const proto = bagOf(HTMLElement.prototype);
  type Opts = { cls?: string };
  proto.createEl = function (this: HTMLElement, tag: string, opts?: Opts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: Opts) { return this.createEl("div", opts); };
  bagOf(window).activeDocument = document;
  bagOf(window).activeWindow = window;
}

import { openAnchoredPopup } from "./anchored-popup";
import { GLOBAL_KEY, keymapApp, type KeymapApp } from "./__testing__/keymap-app";

beforeAll(() => { installObsidianDOMPolyfills(); });

const CLS = "pm-test-popup";
const popups = () => document.querySelectorAll(`.${CLS}`);

let anchor: HTMLElement;
let close: (() => void) | undefined;
let keys: KeymapApp;

beforeEach(() => {
  keys = keymapApp();
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
});

afterEach(() => {
  close?.();
  close = undefined;
  popups().forEach((p) => p.remove());
  anchor.remove();
});

describe("openAnchoredPopup", () => {
  it("hangs an empty popup off the body under the class it was given", () => {
    const { el, close: c } = openAnchoredPopup(keys.app, anchor, CLS);
    close = c;
    expect(popups()).toHaveLength(1);
    expect(el.parentElement).toBe(document.body);
    expect(el.childElementCount).toBe(0);
  });

  it("closes on an outside pointerdown, but not on one inside it or on its anchor", () => {
    const { el, close: c } = openAnchoredPopup(keys.app, anchor, CLS);
    close = c;
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popups()).toHaveLength(1);
    anchor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popups()).toHaveLength(1);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(popups()).toHaveLength(0);
  });

  it("closes when the view scrolls out from under it, but not when it scrolls itself", () => {
    const { el, close: c } = openAnchoredPopup(keys.app, anchor, CLS);
    close = c;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(popups()).toHaveLength(1);
    document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(popups()).toHaveLength(0);
  });

  // Obsidian's modal keeps the focus in: a popup hung outside it has the caret pulled back
  // to the field underneath the moment its own box asks for one.
  it("hangs off the dialog it was opened from, when there is one", () => {
    const modal = document.createElement("div");
    modal.className = "modal";
    document.body.appendChild(modal);
    const inModal = modal.appendChild(document.createElement("button"));
    try {
      const { el, close: c } = openAnchoredPopup(keys.app, inModal, CLS);
      close = c;
      expect(el.parentElement).toBe(modal);
    } finally {
      modal.remove();
    }
  });

  // Through Obsidian's keymap, and spending the key there: a modal registered its own
  // Escape when the app started, so a listener of the popup's own is heard second and the
  // dialog under it closes too.
  it("closes on Escape, leaving the key to nothing under it", () => {
    close = openAnchoredPopup(keys.app, anchor, CLS).close;
    expect(keys.press("Escape")).toBe(true);
    expect(popups()).toHaveLength(0);
  });

  // A picker is not a dialog: what it doesn't answer falls through to the app under it.
  it("leaves the app's hotkeys answering while a popup is open", () => {
    close = openAnchoredPopup(keys.app, anchor, CLS).close;
    expect(keys.press(GLOBAL_KEY)).toBe(true);
  });

  // Obsidian's modal blocks the app's hotkeys, its scope having no parent. A popup inside
  // one must not hand them back, or a hotkey draws its palette on top of the dialog.
  it("blocks the app's hotkeys under a popup opened in a dialog", () => {
    const modal = document.createElement("div");
    modal.className = "modal";
    document.body.appendChild(modal);
    const inModal = modal.appendChild(document.createElement("button"));
    try {
      close = openAnchoredPopup(keys.app, inModal, CLS).close;
      expect(keys.press(GLOBAL_KEY)).toBe(false);
      expect(keys.press("Escape")).toBe(true);
    } finally {
      modal.remove();
    }
  });

  it("closes the popup already open instead of stacking a second one", () => {
    openAnchoredPopup(keys.app, anchor, CLS);
    close = openAnchoredPopup(keys.app, anchor, CLS).close;
    expect(popups()).toHaveLength(1);
  });

  it("takes its listeners and its scope down when closed, so a later outside click is inert", () => {
    const { close: c } = openAnchoredPopup(keys.app, anchor, CLS);
    c();
    c(); // Closing twice is the caller's right — the second is a no-op.
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(keys.scopes).toHaveLength(0);
    expect(keys.press("Escape")).toBe(false);
    expect(popups()).toHaveLength(0);
  });

  // A leaf popped out into a second window has a document of its own, which Obsidian points
  // `activeDocument` at. Hung on the app's instead, the popup is drawn in the window nobody
  // is looking at and never hears the click that should dismiss it.
  it("opens in the document the leaf is in, and is dismissed from there", () => {
    const popped = document.implementation.createHTMLDocument("popped out");
    bagOf(window).activeDocument = popped;
    try {
      const poppedAnchor = popped.createElement("button");
      popped.body.appendChild(poppedAnchor);
      close = openAnchoredPopup(keys.app, poppedAnchor, CLS).close;

      expect(popped.querySelectorAll(`.${CLS}`)).toHaveLength(1);
      expect(popups()).toHaveLength(0);

      popped.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(popped.querySelectorAll(`.${CLS}`)).toHaveLength(0);
    } finally {
      bagOf(window).activeDocument = document;
    }
  });
});

describe("where the popup is placed", () => {
  const POPUP_H = 200;
  const POPUP_W = 260;
  const VIEWPORT_H = 500;
  const VIEWPORT_W = 1000;

  /** jsdom lays nothing out, so the popup's own size and the viewport's are given here. */
  function stubLayout(): () => void {
    const proto = bagOf(HTMLElement.prototype);
    const root = bagOf(document.documentElement);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { value: POPUP_H, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { value: POPUP_W, configurable: true });
    Object.defineProperty(document.documentElement, "clientHeight", { value: VIEWPORT_H, configurable: true });
    Object.defineProperty(document.documentElement, "clientWidth", { value: VIEWPORT_W, configurable: true });
    return () => {
      delete proto.offsetHeight;
      delete proto.offsetWidth;
      delete root.clientHeight;
      delete root.clientWidth;
    };
  }

  /** Puts the anchor at a fixed spot in the viewport. */
  function anchorAt(top: number, height = 24, left = 20): void {
    anchor.getBoundingClientRect = () => ({
      top, bottom: top + height, height, left, right: left + 80, width: 80, x: left, y: top,
      toJSON: () => ({}),
    });
  }

  /** The popup, placed against the anchor as a caller does once its content is in. */
  function placed(): HTMLElement {
    const { el, close: c, position } = openAnchoredPopup(keys.app, anchor, CLS);
    close = c;
    position();
    return el;
  }

  let restore: () => void;
  beforeEach(() => { restore = stubLayout(); });
  afterEach(() => { restore(); });

  it("sits below the anchor when there is room for it there", () => {
    anchorAt(100);
    expect(placed().style.top).toBe("128px"); // 124 bottom + 4 gap
  });

  it("flips above the anchor when the popup would fall off the bottom", () => {
    anchorAt(380);
    // 380 - 4 gap - 200 tall: the whole popup fits between the anchor and the top.
    expect(placed().style.top).toBe("176px");
  });

  it("stays in the viewport when it fits neither above nor below", () => {
    // Too near the top to flip above, too near the bottom to sit below.
    anchorAt(150, 300);
    expect(placed().style.top).toBe(`${VIEWPORT_H - POPUP_H - 4}px`);
  });

  // A dialog Obsidian's opening animation left a transform on is the containing block of
  // anything fixed inside it, so the first pass lands off by wherever that dialog sits.
  it("corrects for a host the viewport's coordinates are not measured from", () => {
    anchorAt(100);
    const { el, close: c, position } = openAnchoredPopup(keys.app, anchor, CLS);
    close = c;
    // Laid out 60px right and 30px down of where it was put — the dialog's own offset.
    el.getBoundingClientRect = () => {
      const left = parseFloat(el.style.left) + 60;
      const top = parseFloat(el.style.top) + 30;
      return {
        top, left, bottom: top + POPUP_H, right: left + POPUP_W, width: POPUP_W, height: POPUP_H,
        x: left, y: top, toJSON: () => ({}),
      };
    };
    position();

    expect(el.style.top).toBe("98px"); // 128 wanted, 30 off
    expect(el.style.left).toBe("-40px"); // 20 wanted, 60 off
  });

  it("lines up with the anchor's leading edge, shifting left to stay on screen", () => {
    anchorAt(100, 24, 40);
    expect(placed().style.left).toBe("40px");
    anchorAt(100, 24, VIEWPORT_W - 100);
    expect(placed().style.left).toBe(`${VIEWPORT_W - POPUP_W - 4}px`);
  });
});
