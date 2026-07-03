import { App, Component, MarkdownRenderer, setIcon, moment as _moment } from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moment = _moment as any;
import { DayTask } from "../model/day-task";
import { DayMarkdownFile } from "../model/day-markdown-file";
import { ConfirmModal } from "./task-creator";
import { CALENDAR_SVG } from "./icons";

/**
 * DOM-building blocks for a single day-task's checklist row — title, editable
 * sub-line "note" panel, and the action buttons that operate on it — shared by
 * the Dashboard and Inbox views.
 */

function dedentLines(lines: string[]): string {
  const minIndent = lines.reduce((min, l) => {
    const match = l.match(/^(\s*)\S/);
    return match ? Math.min(min, match[1].length) : min;
  }, Infinity);
  const strip = isFinite(minIndent) ? minIndent : 0;
  return lines.map((l) => l.slice(strip)).join("\n");
}

// ── Editable sub-lines (indented notes under a DayTask) ───────────────────────

/** Matches a nested `- [ ]`/`- [x]` checklist line, used to warn before "Remove note"
 *  deletes what's actually a nested checklist item rather than free-text notes — the
 *  parser folds both into the same opaque `subLines` block (see `getTaskSlice`). */
const NESTED_CHECKBOX_RE = /^\s*-\s+\[[ xX]\]/;

/** Identifies a task's note-panel open/closed state in a `BaseTabView.openNoteKeys` set.
 *  Built from `item.rawLine`, so any in-place edit to the task's own line (checkbox
 *  toggle, title edit) must migrate the key via `migrateNoteKey` before that edit lands,
 *  or the note will appear to collapse/vanish on the next refresh. */
function noteKey(filePath: string, item: DayTask): string {
  return `${filePath}::${item.rawLine}`;
}

/** Carries a task's open-note bookkeeping across an in-place edit to its own line
 *  (which changes the key `noteKey` computes) — see `noteKey`'s caveat above. */
export function migrateNoteKey(
  openNoteKeys: Set<string>,
  filePath: string,
  oldRawLine: string,
  newRawLine: string,
): void {
  if (openNoteKeys.delete(`${filePath}::${oldRawLine}`)) {
    openNoteKeys.add(`${filePath}::${newRawLine}`);
  }
}

/**
 * Fills `panel` with an editable textarea — pre-filled with the task's
 * dedented sub-lines — wired to save on blur via `DayMarkdownFile.updateSubLines`.
 */
function renderNoteTextarea(
  panel: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  onSaved: () => void,
): void {
  const textarea = panel.createEl("textarea", { cls: "pm-day-task-note-textarea" });
  textarea.value = dedentLines(item.subLines);
  textarea.addEventListener("blur", () => {
    void new DayMarkdownFile(app, filePath).updateSubLines(item, textarea.value.trim()).then(onSaved);
  });
  textarea.focus();
}

/**
 * Appends an editable textarea as a new child of `row`, directly beneath the
 * task's main line. Used by "Add note", which has nothing to view yet.
 */
function openNoteEditPanel(
  row: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  onSaved: () => void,
): HTMLElement {
  const panel = row.createDiv({ cls: "pm-day-task-note-panel" });
  panel.addEventListener("click", (ev) => ev.stopPropagation());
  renderNoteTextarea(panel, item, filePath, app, onSaved);
  return panel;
}

/**
 * Appends the note read-only, rendered as markdown (matching how it used to
 * render in the old hover tooltip), plus a small "Edit" button that swaps
 * this view for `renderNoteTextarea`'s textarea on click.
 */
function openNoteViewPanel(
  row: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  component: Component,
  onSaved: () => void,
): HTMLElement {
  const panel = row.createDiv({ cls: "pm-day-task-note-panel" });
  panel.addEventListener("click", (ev) => ev.stopPropagation());

  const view = panel.createDiv({ cls: "pm-day-task-note-view" });
  for (const line of dedentLines(item.subLines).split("\n")) {
    void renderInlineMarkdown(view.createDiv({ cls: "pm-day-task-note-line" }), line, app, component);
  }

  const editBtn = panel.createEl("button", {
    cls: "pm-day-task-note-edit-btn",
    attr: { "aria-label": "Edit note", title: "Edit note" },
  });
  setIcon(editBtn, "pencil");
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.empty();
    renderNoteTextarea(panel, item, filePath, app, onSaved);
  });

  return panel;
}

/**
 * Renders the note-expand chevron — the same collapse/expand chevron used by
 * the Daily Tasks / Overdue tasks / Upcoming tasks section headers in
 * `createCollapsibleSection` — as the next child appended to `mainLine`, so
 * callers should invoke this right after the title and before the
 * date/duration label. That keeps checkboxes aligned across rows regardless
 * of whether a task has a note (unlike prepending it, which used to shift the
 * checkbox), while still reading as part of the title rather than the
 * trailing metadata. Only rendered when the task already has a note (there's
 * nothing to expand otherwise; use `appendNoteActionButton`'s "Add note"
 * instead). Clicking it expands `row` to show the note read-only; editing
 * only happens once the user clicks the "Edit" button inside that view.
 *
 * `openNoteKeys` (the calling view's `BaseTabView.openNoteKeys`) is checked
 * on render and updated on toggle, so a note left open across a save-induced
 * `onRefresh()` (which tears down and rebuilds the whole view) reopens
 * automatically instead of collapsing back.
 */
export function renderNoteChevron(
  mainLine: HTMLElement,
  row: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  component: Component,
  openNoteKeys: Set<string>,
  onSaved: () => void,
): void {
  if (item.subLines.length === 0) return;

  const key = noteKey(filePath, item);

  const toggle = mainLine.createEl("button", {
    cls: "pm-dash-section-chevron pm-dash-section-chevron--collapsed pm-day-task-comment-toggle",
    attr: { "aria-label": "Toggle note", title: "Toggle note" },
  });
  setIcon(toggle, "chevron-down");

  let panel: HTMLElement | null = null;

  const open = () => {
    toggle.classList.remove("pm-dash-section-chevron--collapsed");
    panel = openNoteViewPanel(row, item, filePath, app, component, onSaved);
    openNoteKeys.add(key);
  };
  const close = () => {
    panel?.remove();
    panel = null;
    toggle.classList.add("pm-dash-section-chevron--collapsed");
    openNoteKeys.delete(key);
  };

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel) close(); else open();
  });

  if (openNoteKeys.has(key)) open();
}

/**
 * Appends a single note-action button to `actions`: "Add note" when the task
 * has none yet (opens the inline panel to start typing one), or "Remove note"
 * when it already has one (asks for confirmation, then clears it).
 */
export function appendNoteActionButton(
  actions: HTMLElement,
  row: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  openNoteKeys: Set<string>,
  onSaved: () => void,
): void {
  const btn = actions.createEl("button", {
    cls: "pm-day-task-action-btn",
    attr:
      item.subLines.length === 0
        ? { "aria-label": "Add note", title: "Add note" }
        : { "aria-label": "Remove note", title: "Remove note" },
  });

  if (item.subLines.length === 0) {
    setIcon(btn, "sticky-note");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openNoteEditPanel(row, item, filePath, app, onSaved);
      openNoteKeys.add(noteKey(filePath, item));
    });
  } else {
    setIcon(btn, "eraser");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // The parser folds nested `- [ ]` checklist lines into this same opaque subLines
      // block, so "Remove note" would silently delete those too — warn when that's the case.
      const hasNestedTasks = item.subLines.some((l) => NESTED_CHECKBOX_RE.test(l));
      const message = hasNestedTasks
        ? `Remove note from "${item.title}"? This also deletes nested checklist items underneath it.`
        : `Remove note from "${item.title}"?`;
      new ConfirmModal(app, message, () => {
        openNoteKeys.delete(noteKey(filePath, item));
        void new DayMarkdownFile(app, filePath).updateSubLines(item, "").then(onSaved);
      }).open();
    });
  }
}

/**
 * Touch devices have no persistent `:hover`, which is what normally reveals a
 * row's floating `.pm-day-task-actions` toolbar. This makes tapping the row
 * (anywhere outside the toolbar itself) toggle a `.pm-day-task-row--open`
 * class that the CSS treats the same as `:hover`, and closes it again on the
 * next tap anywhere else — the same open/close pattern used by the
 * section-info tooltip in `createCollapsibleSection`.
 */
export function attachActionsTapToggle(row: HTMLElement): void {
  // Tracks the currently-registered outside-click listener (if any) so re-tapping the row
  // closed removes it immediately, instead of leaving it registered on `document` until
  // some later, unrelated outside click happens to fire it.
  let close: ((ev: MouseEvent) => void) | null = null;
  row.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".pm-day-task-actions")) return;
    const isOpen = row.classList.toggle("pm-day-task-row--open");
    if (isOpen) {
      close = (ev: MouseEvent) => {
        if (!row.contains(ev.target as Node)) {
          row.classList.remove("pm-day-task-row--open");
          document.removeEventListener("click", close!, true);
          close = null;
        }
      };
      document.addEventListener("click", close, true);
    } else if (close) {
      document.removeEventListener("click", close, true);
      close = null;
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function appendRescheduleButton(parent: HTMLElement, onDate: (date: any) => void): void {
  const btn = parent.createEl("button", {
    cls: "pm-day-task-action-btn",
    attr: { "aria-label": "Reschedule", title: "Reschedule to another day" },
  });
  btn.innerHTML = CALENDAR_SVG;
  const dateInput = parent.createEl("input", { type: "date", cls: "pm-dash-date-picker-input" });
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    onDate(moment(dateInput.value, "YYYY-MM-DD"));
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dateInput as any).showPicker();
    } catch {
      dateInput.click();
    }
  });
}

export async function renderInlineMarkdown(container: HTMLElement, text: string, app: App, component: Component): Promise<void> {
  await MarkdownRenderer.render(app, text, container, "", component);
  const p = container.querySelector(":scope > p");
  if (p) {
    while (p.firstChild) container.insertBefore(p.firstChild, p);
    p.remove();
  }
}

/** Renders `displayText` (via `renderInlineMarkdown`) into a new span appended to
 *  `container`, and returns that span so callers can later hand it to
 *  `appendEditTitleButton` for in-place editing. */
export function renderTaskTitle(
  container: HTMLElement,
  displayText: string,
  app: App,
  component: Component,
  cls: string,
): HTMLElement {
  const span = container.createSpan({ cls });
  void renderInlineMarkdown(span, displayText, app, component);
  return span;
}

/**
 * Swaps `span` (as rendered by `renderTaskTitle`) for a text input pre-filled with
 * `item.title` (the raw, untruncated title — not whatever display text `span` shows,
 * which may have tags stripped), saving via `DayMarkdownFile.updateTitle` on blur/Enter
 * (Escape reverts without saving).
 */
function startTitleEdit(
  container: HTMLElement,
  span: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  cls: string,
  openNoteKeys: Set<string>,
  onSaved: () => void,
): void {
  const input = container.createEl("input", {
    type: "text",
    cls: `${cls} pm-day-task-title-input`,
  });
  input.value = item.title;
  container.insertBefore(input, span);
  span.remove();
  input.focus();
  input.select();
  input.addEventListener("click", (ev) => ev.stopPropagation());

  input.addEventListener("blur", () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== item.title) {
      // Snapshot rawLine before the write so migrateNoteKey/resolveIndex still see the
      // line as it exists on disk right now; item.rawLine only advances once the write
      // (which locates the line via the *old* rawLine) has actually succeeded.
      const oldRawLine = item.rawLine;
      const newRawLine = DayTask.withUpdatedTitle(oldRawLine, newTitle);
      migrateNoteKey(openNoteKeys, filePath, oldRawLine, newRawLine);
      void new DayMarkdownFile(app, filePath).updateTitle(item, newTitle).then(() => {
        item.rawLine = newRawLine;
        onSaved();
      });
    } else {
      input.replaceWith(span);
    }
  });
  input.addEventListener("keydown", (ke) => {
    if (ke.key === "Enter") {
      ke.preventDefault();
      input.blur();
    } else if (ke.key === "Escape") {
      ke.preventDefault();
      input.value = item.title;
      input.blur();
    }
  });
}

/**
 * Appends an "Edit title" button to `actions` that swaps `titleSpan` (as returned by
 * `renderTaskTitle`) for an editable input on click. Not rendered for recurring/habit-
 * tagged tasks — call sites should skip this entirely for those, since the title is the
 * shared definition text rather than something this specific line owns.
 */
export function appendEditTitleButton(
  actions: HTMLElement,
  container: HTMLElement,
  titleSpan: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  cls: string,
  openNoteKeys: Set<string>,
  onSaved: () => void,
): void {
  const btn = actions.createEl("button", {
    cls: "pm-day-task-action-btn",
    attr: { "aria-label": "Edit title", title: "Edit title" },
  });
  setIcon(btn, "pencil");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    startTitleEdit(container, titleSpan, item, filePath, app, cls, openNoteKeys, onSaved);
  });
}
