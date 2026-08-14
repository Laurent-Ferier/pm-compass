import { App, getIconIds } from "obsidian";
import { openAnchoredPopup } from "./anchored-popup";
import { loadEmojiDrawers, matchingEmojiGroups } from "./emoji-catalog";
import { loadIconWords, matchingIconNames } from "./icon-catalog";
import { isIconName, renderIcon } from "./icons";

/**
 * The popup a project's icon is chosen from: a grid of every glyph Obsidian ships, and —
 * behind the other tab — emoji under the drawers they belong to. Two tabs because the field
 * takes both: obsidian-pm writes an emoji, which is also what reads correctly in the note's
 * heading, while a lucide name is what the plugin's own iconography is made of.
 *
 * Either tab is searched, each keeping its own words: an emoji answers to what it depicts
 * and what it stands for (see `emoji-catalog.ts`), a glyph to its name and to Lucide's
 * words for it (see `icon-catalog.ts`).
 *
 * Where the popup is drawn and what dismisses it are `openAnchoredPopup`'s.
 */

/** How many cells either tab draws at once. Both sets run past a thousand, and a glyph is
 *  an SVG built on the spot; the count under the grid says what is left out. */
const SHOWN = 120;

/** The two tables the tabs are searched over, which together are a fifth of the plugin's
 *  bundle and are read in the first time a picker opens — see `emoji-catalog.ts`. Kept here
 *  once read, so every picker after the first draws its grid in the one pass. */
let tables: Promise<unknown> | undefined;
let read = false;

/** Reads both tables in. Pickers call it as they open; the body waits on what it returns. */
export function loadIconTables(): Promise<unknown> {
  tables ??= Promise.all([loadEmojiDrawers(), loadIconWords()]).then(() => { read = true; });
  return tables;
}

/** What a cell says an emoji is: the label the words open with, which the table carries as
 *  one word so that neither the search nor the drawing has to take the words apart. */
function label(words: string): string {
  const end = words.indexOf(" ");
  return (end < 0 ? words : words.slice(0, end)).replace(/-/g, " ");
}

/** The glyph names on offer: Obsidian's own, without the `lucide-` prefix that would
 *  otherwise be written into the note. The prefix skips Obsidian's legacy aliases, so the
 *  names are stripped only after the set has been narrowed to them. */
function lucideNames(): string[] {
  return getIconIds()
    .filter((id) => id.startsWith("lucide-"))
    .map((id) => id.slice("lucide-".length))
    .sort();
}

export interface IconPickerOptions {
  /** The icon in force when the picker opens, drawn as the picked one. */
  current: string;
  /** Called with the chosen icon; the popup then closes. */
  onPick: (icon: string) => void;
}

/** Opens the icon popup anchored to `anchor`. Returns a `close()` function. */
export function openIconPicker(app: App, anchor: HTMLElement, opts: IconPickerOptions): () => void {
  const { el: popup, close, position } = openAnchoredPopup(app, anchor, "pm-iconpicker");

  // Asked for once the icons tab is drawn, and kept: the set does not change while the popup
  // is open, and every keystroke narrows it afresh.
  let names: string[] | undefined;
  // The tab the picker opens on is the one the icon in force belongs to.
  let onNames = isIconName(opts.current);
  // One needle per tab: what narrows the emoji would find no glyph, and the other way about.
  const queries = { emoji: "", names: "" };

  const pick = (icon: string): void => {
    opts.onPick(icon);
    close();
  };

  /** One cell of either grid: the glyph, and the value it stands for. */
  const cell = (grid: HTMLElement, icon: string, label: string): void => {
    const btn = grid.createEl("button", { cls: "pm-iconpicker-cell", attr: { "aria-label": label } });
    if (icon === opts.current) btn.addClass("pm-iconpicker-cell--selected");
    renderIcon(btn, icon);
    btn.addEventListener("click", () => pick(icon));
  };

  const renderEmoji = (body: HTMLElement): void => {
    const groups = matchingEmojiGroups(queries.emoji);
    const total = groups.reduce((n, group) => n + group.entries.length, 0);
    // Nothing typed: a share of the screenful to each drawer, so every one of them is there
    // to be opened. A word narrows to the drawers that answer, and they take it in turn.
    const share = queries.emoji.trim() ? SHOWN : Math.ceil(SHOWN / groups.length);
    let left = SHOWN;
    for (const group of groups) {
      if (left <= 0) break;
      body.createDiv({ cls: "pm-iconpicker-group", text: group.name });
      const grid = body.createDiv({ cls: "pm-iconpicker-grid" });
      const drawn = group.entries.slice(0, Math.min(share, left));
      for (const [glyph, words] of drawn) cell(grid, glyph, label(words));
      left -= drawn.length;
    }
    body.createDiv({
      cls: "pm-iconpicker-count",
      text: total === 0 ? "No emoji for that word"
        : total > SHOWN ? `${SHOWN} of ${total} — type to narrow`
          : `${total} emoji`,
    });
  };

  const renderNames = (body: HTMLElement): void => {
    names ??= lucideNames();
    const matches = matchingIconNames(names, queries.names);
    const grid = body.createDiv({ cls: "pm-iconpicker-grid" });
    for (const name of matches.slice(0, SHOWN)) cell(grid, name, name);
    body.createDiv({
      cls: "pm-iconpicker-count",
      text: matches.length === 0 ? "No icon for that word"
        : matches.length > SHOWN ? `${SHOWN} of ${matches.length} — type to narrow`
          : `${matches.length} icon${matches.length === 1 ? "" : "s"}`,
    });
  };

  const renderBody = (body: HTMLElement): void => {
    body.empty();
    // Nothing to draw a grid from until the tables are read. They are bundled, so the reading
    // is a microtask and this line stands for less than a frame — and only for the first
    // picker of the session, every one after it finding them read.
    if (!read) {
      body.createDiv({ cls: "pm-iconpicker-count", text: "Loading…" });
      void loadIconTables().then(() => {
        if (body.isConnected) {
          renderBody(body);
          position();
        }
      });
      return;
    }
    if (onNames) renderNames(body);
    else renderEmoji(body);
  };

  const render = (): void => {
    popup.empty();

    const tabs = popup.createDiv({ cls: "pm-iconpicker-tabs" });
    const tab = (label: string, names: boolean): void => {
      const btn = tabs.createEl("button", { cls: "pm-iconpicker-tab", text: label });
      if (onNames === names) btn.addClass("pm-iconpicker-tab--active");
      btn.addEventListener("click", () => { onNames = names; render(); });
    };
    tab("Icons", true);
    tab("Emoji", false);

    const placeholder = onNames ? "Search icons…" : "Search emoji…";
    const search = popup.createEl("input", { cls: "pm-iconpicker-search", attr: { placeholder } });
    const body = popup.createDiv({ cls: "pm-iconpicker-body" });

    search.type = "text";
    search.value = onNames ? queries.names : queries.emoji;
    // Redrawing the body alone keeps this box, and with it the caret, between keystrokes.
    search.addEventListener("input", () => {
      if (onNames) queries.names = search.value;
      else queries.emoji = search.value;
      renderBody(body);
    });
    window.setTimeout(() => search.focus(), 0);

    renderBody(body);
  };

  render();
  position();
  return close;
}
