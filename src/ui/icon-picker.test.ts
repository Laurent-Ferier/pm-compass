// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills — jsdom lacks the createEl/empty/setText helpers that
// Obsidian adds to HTMLElement, which the picker relies on.
// ---------------------------------------------------------------------------
function installObsidianDOMPolyfills() {
  const proto = bagOf(HTMLElement.prototype);
  type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
  proto.createEl = function (this: HTMLElement, tag: string, opts?: Opts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: Opts) { return this.createEl("div", opts); };
  proto.createSpan = function (this: HTMLElement, opts?: Opts) { return this.createEl("span", opts); };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
  proto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  proto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  bagOf(window).activeDocument = document;
  bagOf(window).activeWindow = window;
}

// A handful of names, prefixed as Obsidian's own are, plus one legacy alias the picker is
// expected to leave out.
const ICON_IDS = [
  "lucide-folder", "lucide-folder-open", "lucide-rocket", "lucide-check", "pencil",
];

vi.mock("obsidian", async () => ({
  ...(await vi.importActual<object>("obsidian")),
  getIconIds: () => ICON_IDS,
  // What `setIcon` draws is Obsidian's; that it was asked for the right name is what the
  // tests read, so the name lands on the element.
  setIcon: (el: HTMLElement, name: string) => { el.setAttribute("data-icon", name); },
}));

import { loadIconTables, openIconPicker } from "./icon-picker";
import { emojiGroups } from "./emoji-catalog";
import { keymapApp } from "./__testing__/keymap-app";

beforeAll(async () => {
  installObsidianDOMPolyfills();
  // Every test below opens a picker and reads its grid there and then, which is what a picker
  // draws once the tables are in — the one test of the wait ahead of them reads it unread.
  await loadIconTables();
});

let anchor: HTMLElement;
let close: (() => void) | undefined;

beforeEach(() => {
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
});

afterEach(() => {
  close?.();
  close = undefined;
  document.querySelectorAll(".pm-iconpicker").forEach((p) => p.remove());
  anchor.remove();
});

const popup = () => document.querySelector(".pm-iconpicker") as HTMLElement;
const cells = () => Array.from(popup().querySelectorAll<HTMLElement>(".pm-iconpicker-cell"));
const tab = (label: string) =>
  Array.from(popup().querySelectorAll(".pm-iconpicker-tab")).find((t) => t.textContent === label) as HTMLElement;
const search = () => popup().querySelector(".pm-iconpicker-search") as HTMLInputElement;
const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

describe("openIconPicker", () => {
  it("offers the glyphs first, the emoji behind them", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    const labels = Array.from(popup().querySelectorAll(".pm-iconpicker-tab")).map((t) => t.textContent);
    expect(labels).toEqual(["Icons", "Emoji"]);
  });

  it("opens on the emoji tab, with the icon in force picked out", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "👓", onPick: () => {} });
    expect(tab("Emoji").classList.contains("pm-iconpicker-tab--active")).toBe(true);
    const selected = cells().filter((c) => c.classList.contains("pm-iconpicker-cell--selected"));
    expect(selected.map((c) => c.textContent)).toEqual(["👓"]);
  });

  it("draws the emoji under the drawers they belong to, the first drawer first", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    const groups = Array.from(popup().querySelectorAll(".pm-iconpicker-group"));
    expect(groups[0].textContent).toBe("Objects");
  });

  it("draws a screenful of emoji at a time, and says how many are left", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    expect(cells()).toHaveLength(120);
    expect(popup().querySelector(".pm-iconpicker-count")!.textContent).toMatch(/^120 of \d{4} — type to narrow$/);
  });

  it("spends that screenful over every drawer, so none is out of reach", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    const groups = Array.from(popup().querySelectorAll(".pm-iconpicker-group"));
    expect(groups).toHaveLength(emojiGroups().length);
    expect(groups.map((g) => g.textContent)).toEqual(emojiGroups().map((g) => g.name));
  });

  it("narrows the emoji to the word typed, drawers with nothing in them left out", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    search().value = "stethoscope";
    search().dispatchEvent(new Event("input"));

    expect(cells().map((c) => c.textContent)).toEqual(["🩺"]);
    expect(Array.from(popup().querySelectorAll(".pm-iconpicker-group")).map((g) => g.textContent))
      .toEqual(["Objects"]);
    expect(popup().querySelector(".pm-iconpicker-count")!.textContent).toBe("1 emoji");
  });

  it("says so when no emoji answers to the word", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    search().value = "qqq";
    search().dispatchEvent(new Event("input"));

    expect(cells()).toEqual([]);
    expect(popup().querySelector(".pm-iconpicker-count")!.textContent).toBe("No emoji for that word");
  });

  it("keeps each tab's own search, the one narrowing the other finding nothing", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    search().value = "stethoscope";
    search().dispatchEvent(new Event("input"));

    click(tab("Icons"));
    expect(search().value).toBe("");
    search().value = "folder";
    search().dispatchEvent(new Event("input"));

    click(tab("Emoji"));
    expect(search().value).toBe("stethoscope");
    expect(cells().map((c) => c.textContent)).toEqual(["🩺"]);
  });

  it("opens on the icons tab when that is the kind the project carries", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "rocket", onPick: () => {} });
    expect(tab("Icons").classList.contains("pm-iconpicker-tab--active")).toBe(true);
    expect(search()).not.toBeNull();
  });

  it("calls onPick with the emoji chosen and closes", () => {
    const onPick = vi.fn();
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick });
    click(cells()[0]);
    expect(onPick).toHaveBeenCalledWith("👓");
    expect(popup()).toBeNull();
  });

  it("offers Obsidian's own glyphs by their bare names, legacy aliases left out", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    click(tab("Icons"));
    expect(cells().map((c) => c.getAttribute("data-icon"))).toEqual(["check", "folder", "folder-open", "rocket"]);
  });

  it("narrows the glyphs to what is typed, and says how many are left", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    click(tab("Icons"));
    search().value = "folder";
    search().dispatchEvent(new Event("input"));

    expect(cells().map((c) => c.getAttribute("data-icon"))).toEqual(["folder", "folder-open"]);
    expect(popup().querySelector(".pm-iconpicker-count")!.textContent).toBe("2 icons");
  });

  it("finds a glyph by what it stands for, the ones named it first", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    click(tab("Icons"));
    search().value = "directory"; // Lucide's word for `folder`, and part of no name
    search().dispatchEvent(new Event("input"));

    expect(cells().map((c) => c.getAttribute("data-icon"))).toEqual(["folder", "folder-open"]);
  });

  it("says so when nothing is named that and nothing means it", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    click(tab("Icons"));
    search().value = "zzz";
    search().dispatchEvent(new Event("input"));

    expect(cells()).toEqual([]);
    expect(popup().querySelector(".pm-iconpicker-count")!.textContent).toBe("No icon for that word");
  });

  it("keeps what was typed when the glyph picked is one of the narrowed set", () => {
    const onPick = vi.fn();
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick });
    click(tab("Icons"));
    search().value = "rock";
    search().dispatchEvent(new Event("input"));
    click(cells()[0]);

    expect(onPick).toHaveBeenCalledWith("rocket");
    expect(popup()).toBeNull();
  });

  it("says it is reading the tables in, and draws the grid the moment they are", async () => {
    // A fresh copy of the picker, with the tables unread, which is the first one of a session.
    vi.resetModules();
    const fresh = await import("./icon-picker");
    close = fresh.openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });

    expect(cells()).toEqual([]);
    expect(popup().querySelector(".pm-iconpicker-count")!.textContent).toBe("Loading…");

    await fresh.loadIconTables();
    await vi.waitFor(() => expect(cells()).toHaveLength(120));
  });

  it("closes on an outside pointerdown", () => {
    close = openIconPicker(keymapApp().app, anchor, { current: "", onPick: () => {} });
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(popup()).toBeNull();
  });
});
