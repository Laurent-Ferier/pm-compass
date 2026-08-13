import { getIconIds } from "obsidian";
import { openAnchoredPopup } from "./anchored-popup";
import { matchingEmojiGroups } from "./emoji-catalog";
import { isIconName, renderIcon } from "./icons";

/**
 * The popup a project's icon is chosen from: a grid of emoji under the drawers they belong
 * to, and — behind the other tab — every glyph Obsidian ships. Two tabs because the field
 * takes both: obsidian-pm writes an emoji, which is also what reads correctly in the note's
 * heading, while a lucide name is what the plugin's own iconography is made of.
 *
 * Either tab is searched, each keeping its own words: an emoji answers to what it depicts
 * and what it stands for (see `emoji-catalog.ts`), a glyph to its name.
 *
 * Where the popup is drawn and what dismisses it are `openAnchoredPopup`'s.
 */

/** How many glyphs the icons tab draws at once. Every one is an SVG built on the spot, and
 *  the whole set is well over a thousand; the count under the grid says what is left out. */
const LUCIDE_SHOWN = 120;

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
export function openIconPicker(anchor: HTMLElement, opts: IconPickerOptions): () => void {
  const { el: popup, close, position } = openAnchoredPopup(anchor, "pm-iconpicker");

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
    const btn = grid.createEl("button", { cls: "pm-iconpicker-cell", attr: { "aria-label": label, title: label } });
    if (icon === opts.current) btn.addClass("pm-iconpicker-cell--selected");
    renderIcon(btn, icon);
    btn.addEventListener("click", () => pick(icon));
  };

  const renderEmoji = (body: HTMLElement): void => {
    const groups = matchingEmojiGroups(queries.emoji);
    for (const group of groups) {
      body.createDiv({ cls: "pm-iconpicker-group", text: group.name });
      const grid = body.createDiv({ cls: "pm-iconpicker-grid" });
      for (const { glyph, words } of group.entries) cell(grid, glyph, words[0]);
    }
    if (!groups.length) body.createDiv({ cls: "pm-iconpicker-count", text: "No emoji for that word" });
  };

  const renderNames = (body: HTMLElement): void => {
    const needle = queries.names.trim().toLowerCase();
    const matches = lucideNames().filter((name) => name.includes(needle));
    const grid = body.createDiv({ cls: "pm-iconpicker-grid" });
    for (const name of matches.slice(0, LUCIDE_SHOWN)) cell(grid, name, name);
    body.createDiv({
      cls: "pm-iconpicker-count",
      text: matches.length === 0 ? "No icon of that name"
        : matches.length > LUCIDE_SHOWN ? `${LUCIDE_SHOWN} of ${matches.length} — type to narrow`
          : `${matches.length} icon${matches.length === 1 ? "" : "s"}`,
    });
  };

  const renderBody = (body: HTMLElement): void => {
    body.empty();
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
    tab("Emoji", false);
    tab("Icons", true);

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
    activeWindow.setTimeout(() => search.focus(), 0);

    renderBody(body);
  };

  render();
  position();
  return close;
}
