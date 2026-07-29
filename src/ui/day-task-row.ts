import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { DayTask } from "../model/day-task";
import { DayMarkdownFile } from "../model/day-markdown-file";
import { ConfirmModal } from "./task-creator";
import { CALENDAR_SVG, setSvgIcon } from "./icons";
import { openDatePicker } from "./date-picker";
import { wireCommitOnKey } from "./inline-edit";

/**
 * DOM-building blocks for a task row — title (with in-place editing), the floating
 * actions toolbar and the buttons in it, and the tap that reveals it.
 *
 * The generic ones are shared by every kind of row: a day-note checklist line in the
 * Dashboard or the Inbox, and a project task in `BaseTabView.renderTaskRow`. Where a
 * block needs to know *which* kind it is editing, that knowledge is passed in rather
 * than branched on here — see `TitleEditSpec` and its `dayTaskTitleEdit` builder.
 * The sub-line "note" panel stays day-task-only: a project task's body is a whole
 * document, not a handful of indented lines.
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
 * Fills `panel` with an editable textarea — pre-filled with the task's dedented
 * sub-lines. Losing focus commits the current value via `DayMarkdownFile.updateSubLines`;
 * Escape rolls back via `onCancel` without saving. No explicit in-place commit key (e.g.
 * Ctrl/Cmd+Enter) is offered here: Obsidian's global hotkeys (this view is a plain
 * `ItemView`, not a `Modal`, so it doesn't get Obsidian's automatic hotkey shielding)
 * can swallow such combos before they ever reach this textarea — Tab/click away to
 * commit is the reliable path.
 */
function renderNoteTextarea(
  panel: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  onSaved: () => void,
  onCancel: () => void,
): void {
  const textarea = panel.createEl("textarea", {
    cls: "pm-day-task-note-textarea",
    attr: { title: "Click away or tab to save, esc to cancel" },
  });
  textarea.value = dedentLines(item.subLines);
  wireCommitOnKey(
    textarea,
    () => false,
    () => void new DayMarkdownFile(app, filePath).updateSubLines(item, textarea.value.trim()).then(onSaved),
    onCancel,
  );
  textarea.focus();
}

/**
 * Appends an editable textarea as a new child of `row`, directly beneath the
 * task's main line. Used by "Add note", which has nothing to view yet — cancelling
 * removes the panel entirely via `onCancel`.
 */
function openNoteEditPanel(
  row: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  onSaved: () => void,
  onCancel: () => void,
): HTMLElement {
  const panel = row.createDiv({ cls: "pm-day-task-note-panel" });
  panel.addEventListener("click", (ev) => ev.stopPropagation());
  renderNoteTextarea(panel, item, filePath, app, onSaved, () => {
    panel.remove();
    onCancel();
  });
  return panel;
}

/**
 * Appends the note read-only, rendered as markdown (matching how it used to
 * render in the old hover tooltip), plus a small "Edit" button that swaps
 * this view for `renderNoteTextarea`'s textarea on click. Cancelling that edit
 * reverts back to this same read-only view via the `showReadOnly` closure.
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

  const showReadOnly = () => {
    panel.empty();
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
      renderNoteTextarea(panel, item, filePath, app, onSaved, showReadOnly);
    });
  };

  showReadOnly();
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
    cls: "pm-task-action-btn",
    attr:
      item.subLines.length === 0
        ? { "aria-label": "Add note", title: "Add note" }
        : { "aria-label": "Remove note", title: "Remove note" },
  });

  if (item.subLines.length === 0) {
    setIcon(btn, "sticky-note");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = noteKey(filePath, item);
      openNoteEditPanel(row, item, filePath, app, onSaved, () => openNoteKeys.delete(key));
      openNoteKeys.add(key);
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
 * row's floating `.pm-task-actions` toolbar. This makes tapping the row
 * (anywhere outside the toolbar itself) toggle a `.pm-task-row--open`
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
    if ((e.target as HTMLElement).closest(".pm-task-actions")) return;
    const isOpen = row.classList.toggle("pm-task-row--open");
    if (isOpen) {
      close = (ev: MouseEvent) => {
        if (!row.contains(ev.target as Node)) {
          row.classList.remove("pm-task-row--open");
          activeDocument.removeEventListener("click", close!, true);
          close = null;
        }
      };
      activeDocument.addEventListener("click", close, true);
    } else if (close) {
      activeDocument.removeEventListener("click", close, true);
      close = null;
    }
  });
}

export function appendRescheduleButton(
  parent: HTMLElement,
  onDate: (date: Date) => void,
  labels: { ariaLabel: string; title: string } = { ariaLabel: "Reschedule", title: "Reschedule to another day" },
  initialDate?: Date,
  /** Offered as the picker's "Clear" button — only where the task carries a date of
   *  its own to drop (an inbox item waiting on a target day). */
  onClear?: () => void,
): void {
  const btn = parent.createEl("button", {
    cls: "pm-task-action-btn",
    attr: { "aria-label": labels.ariaLabel, title: labels.title },
  });
  setSvgIcon(btn, CALENDAR_SVG);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Seed the picker with the task's current scheduled day (when known) so it
    // opens on that date rather than today.
    openDatePicker(btn, { initial: initialDate, onPick: onDate, onClear });
  });
}

/**
 * Renders `text` as a single inline run inside `container`.
 *
 * `MarkdownRenderer` fills the container synchronously but only resolves a tick later, so
 * the block `<p>` it wraps the text in — and its paragraph margins — are on screen until
 * the unwrap below. That window is long enough for a view to be swapped in and measured:
 * every task row was a paragraph's margins too tall, and the scroll position restored
 * across a refresh landed hundreds of pixels off. `.pm-inline-md` makes the transient
 * wrapper lay out exactly like the unwrapped run, so the height never changes.
 */
export async function renderInlineMarkdown(container: HTMLElement, text: string, app: App, component: Component): Promise<void> {
  container.addClass("pm-inline-md");
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
 * What an in-place title edit needs to know, whichever kind of task is being edited —
 * a checklist line or a project task. Only `commit` differs between the two: one
 * rewrites a line in a day note, the other patches a frontmatter field.
 */
export interface TitleEditSpec {
  /** The raw, untruncated title to pre-fill — not whatever display text the span shows,
   *  which may have had tags stripped. */
  current: string;
  /** Class the input mirrors, so it lays out like the span it replaces. */
  cls: string;
  /** Marked `--editing` while the input is up, to hide everything else on the row.
   *  Must be the element the title span sits directly in — the rule that hides the rest
   *  is a child selector, so a host any further up would take the input with it. */
  editingHost: HTMLElement;
  /** Called with a non-empty title that differs from `current`. */
  commit: (newTitle: string) => void;
}

/** The spec for a checklist line: the edit rewrites the line in its day note, and the
 *  task's open-note bookkeeping has to follow the rawLine change. */
export function dayTaskTitleEdit(
  editingHost: HTMLElement,
  item: DayTask,
  filePath: string,
  app: App,
  cls: string,
  openNoteKeys: Set<string>,
  onSaved: () => void,
): TitleEditSpec {
  return {
    current: item.title,
    cls,
    editingHost,
    commit: (newTitle) => {
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
    },
  };
}

/**
 * Swaps `span` (as rendered by `renderTaskTitle`) for a text input pre-filled with
 * `spec.current`. Losing focus commits the edit (a no-op revert if the value didn't
 * actually change); Enter forces an immediate commit, Escape rolls back without saving.
 */
function startTitleEdit(container: HTMLElement, span: HTMLElement, spec: TitleEditSpec): void {
  const input = container.createEl("input", {
    type: "text",
    cls: `${spec.cls} pm-task-title-input`,
    attr: { title: "Enter to save, esc to cancel" },
  });
  input.value = spec.current;
  container.insertBefore(input, span);
  span.remove();
  // Gives the input the whole row: checkbox, badges, chevron and the floating toolbar are
  // hidden for the duration of the edit.
  spec.editingHost.classList.add("pm-task-row--editing");
  // The sticky add-task bar would otherwise sit right under the field being typed in.
  const listRoot = spec.editingHost.closest(".pm-dash-content");
  listRoot?.classList.add("pm-title-editing");
  const releaseAddBar = () => listRoot?.classList.remove("pm-title-editing");
  const restoreSpan = () => {
    input.replaceWith(span);
    spec.editingHost.classList.remove("pm-task-row--editing");
    releaseAddBar();
  };
  input.focus();
  input.select();
  input.addEventListener("click", (ev) => ev.stopPropagation());

  wireCommitOnKey(
    input,
    (ke) => ke.key === "Enter",
    () => {
      const newTitle = input.value.trim();
      if (!newTitle || newTitle === spec.current) {
        restoreSpan();
        return;
      }
      // The row stays the input's until the write's re-render replaces it: bringing the
      // checkbox, badges and toolbar back around a field that is still there only flashes.
      // The add bar can come back now though — the typing is done.
      releaseAddBar();
      spec.commit(newTitle);
    },
    restoreSpan,
  );
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
  spec: TitleEditSpec,
): void {
  const btn = actions.createEl("button", {
    cls: "pm-task-action-btn",
    attr: { "aria-label": "Edit title", title: "Edit title" },
  });
  setIcon(btn, "pencil");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    startTitleEdit(container, titleSpan, spec);
  });
}
