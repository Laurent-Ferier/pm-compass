import { App } from "obsidian";
import { openAnchoredPopup } from "./anchored-popup";

/**
 * The popup a project's colour is chosen from: a saturation/brightness square, a hue slider
 * and a hex field. Every colour is still reachable, which is why it is a square and not a
 * palette of swatches.
 *
 * Drawn here rather than by `<input type="color">`, whose dialog is the operating system's
 * own: it carries an eyedropper Obsidian's Electron grants no permission to, so the tool sits
 * there doing nothing, and the dialog opens on the desktop and nowhere else — a project note
 * read on a phone could not be recoloured at all.
 *
 * Where the popup is drawn and what dismisses it are `openAnchoredPopup`'s. It stays open
 * until dismissed: a drag has no one moment that is the pick, so the field it feeds follows
 * the pointer instead.
 */

/** Where the picker opens when the note carries no colour — the grey the dot falls back to. */
const DEFAULT_COLOR = "#888888";

/** Hue in degrees, saturation and value each 0–1. The picker holds its colour this way, not
 *  as a hex: hue survives a drag down to black, which the hex it spells out does not. */
interface Hsv {
  h: number;
  s: number;
  v: number;
}

type Rgb = [number, number, number];

/** The channels `hex` stands for, or null where it is not six digits — a hex field is typed
 *  into a character at a time, and most of what it holds along the way is not a colour. */
function parseHex(hex: string): Rgb | null {
  const digits = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!digits) return null;
  const n = parseInt(digits[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsv([r, g, b]: Rgb): Hsv {
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  let h = 0;
  if (span) {
    if (max === r) h = ((g - b) / span) % 6;
    else if (max === g) h = (b - r) / span + 2;
    else h = (r - g) / span + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? span / max : 0, v: max / 255 };
}

function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const chroma = v * s;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = v - chroma;
  const [r, g, b]: Rgb =
    h < 60 ? [chroma, second, 0]
      : h < 120 ? [second, chroma, 0]
        : h < 180 ? [0, chroma, second]
          : h < 240 ? [0, second, chroma]
            : h < 300 ? [second, 0, chroma]
              : [chroma, 0, second];
  return [(r + base) * 255, (g + base) * 255, (b + base) * 255];
}

function hsvToHex(hsv: Hsv): string {
  return toHex(hsvToRgb(hsv));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Makes `el` draggable: `onMove` is told where in it the pointer is, as a fraction of its
 * width and height, on press and on every move until the finger lifts. The pointer is
 * captured so a drag that leaves the square still steers it, which is what makes the far
 * corners reachable at all.
 */
function onDrag(el: HTMLElement, onMove: (x: number, y: number) => void): void {
  let dragging = false;
  const report = (e: PointerEvent): void => {
    const box = el.getBoundingClientRect();
    onMove(clamp01((e.clientX - box.left) / box.width), clamp01((e.clientY - box.top) / box.height));
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // The primary button, and every touch contact, which is 0 too.
    e.preventDefault();
    dragging = true;
    el.setPointerCapture?.(e.pointerId);
    report(e);
  });
  el.addEventListener("pointermove", (e) => { if (dragging) report(e); });
  const end = (e: PointerEvent): void => {
    dragging = false;
    el.releasePointerCapture?.(e.pointerId);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

export interface ColorPickerOptions {
  /** The colour in force when the picker opens. Empty, or anything not a hex, opens on grey. */
  current: string;
  /** Called with every colour the picker passes through, drag by drag. */
  onChange: (color: string) => void;
}

/** Opens the colour popup anchored to `anchor`. Returns a `close()` function. */
export function openColorPicker(app: App, anchor: HTMLElement, opts: ColorPickerOptions): () => void {
  const { el: popup, close, position } = openAnchoredPopup(app, anchor, "pm-colorpicker");
  const hsv = rgbToHsv(parseHex(opts.current) ?? parseHex(DEFAULT_COLOR)!);

  const area = popup.createDiv({ cls: "pm-colorpicker-area" });
  const areaCursor = area.createDiv({ cls: "pm-colorpicker-cursor" });
  const hue = popup.createDiv({ cls: "pm-colorpicker-hue" });
  const hueCursor = hue.createDiv({ cls: "pm-colorpicker-cursor pm-colorpicker-cursor--hue" });

  const foot = popup.createDiv({ cls: "pm-colorpicker-foot" });
  const preview = foot.createDiv({ cls: "pm-colorpicker-preview" });
  const hexField = foot.createEl("input", { cls: "pm-colorpicker-hex" });
  hexField.type = "text";
  hexField.spellcheck = false;
  hexField.setAttribute("aria-label", "Hex color");

  /** Paints the picker at the colour it holds. The hex field is left alone while it is the
   *  one being typed in, so a half-written value isn't overwritten under the caret. */
  const render = (typed = false): void => {
    const hex = hsvToHex(hsv);
    area.setCssProps({ "--pm-hue-color": hsvToHex({ h: hsv.h, s: 1, v: 1 }) });
    areaCursor.setCssProps({ "--pm-cursor-x": `${hsv.s * 100}%`, "--pm-cursor-y": `${(1 - hsv.v) * 100}%` });
    hueCursor.setCssProps({ "--pm-cursor-x": `${(hsv.h / 360) * 100}%` });
    preview.setCssProps({ "--pm-swatch-color": hex });
    if (!typed) hexField.value = hex;
  };

  const change = (typed = false): void => {
    render(typed);
    opts.onChange(hsvToHex(hsv));
  };

  onDrag(area, (x, y) => {
    hsv.s = x;
    hsv.v = 1 - y;
    change();
  });

  onDrag(hue, (x) => {
    hsv.h = x * 360;
    change();
  });

  hexField.addEventListener("input", () => {
    const rgb = parseHex(hexField.value);
    if (!rgb) return;
    // Straight onto the fields rather than over `hsv`: a hex for black or white says nothing
    // about hue or saturation, and taking it whole would swing the square to a corner.
    const typedHsv = rgbToHsv(rgb);
    hsv.h = typedHsv.s ? typedHsv.h : hsv.h;
    hsv.s = typedHsv.s;
    hsv.v = typedHsv.v;
    change(true);
  });

  render();
  position();
  return close;
}
