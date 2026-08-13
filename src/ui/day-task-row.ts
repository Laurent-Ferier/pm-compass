import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { Task } from "../model/daily/task";
import { confirmAction } from "./task-creator";
import { Icon } from "./icons";
import { openDatePicker } from "./date-picker";
import { wireCommitOnKey } from "./inline-edit";

/**
 * DOM-building blocks for a task row — title (with in-place editing), the floating
 * actions toolbar, and the tap that reveals it. Shared by every kind of row; what
 * differs is passed in rather than branched on (see `TitleEditSpec`). The note panel
 * is day-task-only: a project task's body is a whole document.
 */

/** One of the trailing controls on a row's toolbar. `title` is the hover text where it
 *  says more than the label; `danger` is the destructive tint. */
export interface ActionButtonSpec {
  icon: Icon;
  /** What a screen reader says, and the hover text unless `title` says otherwise. */
  label: string;
  title?: string;
  danger?: boolean;
  onClick: (event: MouseEvent) => void;
}

/**
 * One icon button on a row's actions toolbar, returned so a caller can anchor a popup to
 * it. The click is stopped here: every one of these sits on a row that answers a click of
 * its own, and a press meant for the button is not one for the row underneath.
 */
export function appendActionButton(actions: HTMLElement, spec: ActionButtonSpec): HTMLButtonElement {
  const btn = actions.createEl("button", {
    cls: `pm-task-action-btn${spec.danger ? " pm-task-action-btn--delete" : ""}`,
    attr: { "aria-label": spec.label, title: spec.title ?? spec.label },
  });
  setIcon(btn, spec.icon);
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    spec.onClick(event);
  });
  return btn;
}

function dedentLines(lines: string[]): string {
  const minIndent = lines.reduce((min, l) => {
    const match = l.match(/^(\s*)\S/);
    return match ? Math.min(min, match[1].length) : min;
  }, Infinity);
  const strip = isFinite(minIndent) ? minIndent : 0;
  return lines.map((l) => l.slice(strip)).join("\n");
}

// ── Editable sub-lines (indented notes under a `Task`) ───────────────────────

/** A nested checklist line, which the parser folds into the same opaque `subLines`
 *  block as free text — so "Remove note" warns before deleting one. */
const NESTED_CHECKBOX_RE = /^\s*-\s+\[[ xX]\]/;

/** A task's note-panel state in `BaseTabView.openNoteKeys`. Built from `item.rawLine`,
 *  so an edit to that line must call `migrateNoteKey` before it lands. */
function noteKey(item: Task): string {
  return `${item.filePath}::${item.rawLine}`;
}

/** Carries a task's open-note state across an edit to its own line, which changes the
 *  key `noteKey` computes. */
export function migrateNoteKey(
  openNoteKeys: Set<string>,
  item: Task,
  oldRawLine: string,
  newRawLine: string,
): void {
  if (openNoteKeys.delete(`${item.filePath}::${oldRawLine}`)) {
    openNoteKeys.add(`${item.filePath}::${newRawLine}`);
  }
}

/**
 * Fills `panel` with a textarea over the task's dedented sub-lines: blur commits,
 * Escape rolls back. No commit hotkey — this is a plain `ItemView`, so Obsidian's
 * global hotkeys can swallow a combo before the textarea sees it.
 */
function renderNoteTextarea(
  panel: HTMLElement,
  item: Task,
  onSaved: () => void,
  onCancel: () => void,
): void {
  const textarea = panel.createEl("textarea", {
    cls: "pm-day-task-file-textarea",
    attr: { title: "Click away or tab to save, esc to cancel" },
  });
  textarea.value = dedentLines(item.subLines);
  wireCommitOnKey(
    textarea,
    () => false,
    () => {
      item.setNote(textarea.value.trim());
      void item.flush().then(onSaved);
    },
    onCancel,
  );
  textarea.focus();
}

/** Appends a textarea directly beneath the task's main line, for "Add note" — which
 *  has nothing to view yet, so cancelling removes the panel. */
function openNoteEditPanel(
  row: HTMLElement,
  item: Task,
  onSaved: () => void,
  onCancel: () => void,
): HTMLElement {
  const panel = row.createDiv({ cls: "pm-day-task-file-panel" });
  panel.addEventListener("click", (ev) => ev.stopPropagation());
  renderNoteTextarea(panel, item, onSaved, () => {
    panel.remove();
    onCancel();
  });
  return panel;
}

/** Appends the note read-only as markdown, plus an "Edit" button that swaps it for
 *  the textarea; cancelling that edit comes back here. */
function openNoteViewPanel(
  row: HTMLElement,
  item: Task,
  app: App,
  component: Component,
  onSaved: () => void,
): HTMLElement {
  const panel = row.createDiv({ cls: "pm-day-task-file-panel" });
  panel.addEventListener("click", (ev) => ev.stopPropagation());

  const showReadOnly = () => {
    panel.empty();
    const view = panel.createDiv({ cls: "pm-day-task-file-view" });
    for (const line of dedentLines(item.subLines).split("\n")) {
      void renderInlineMarkdown(view.createDiv({ cls: "pm-day-task-file-line" }), line, app, component);
    }

    const editBtn = panel.createEl("button", {
      cls: "pm-day-task-file-edit-btn",
      attr: { "aria-label": "Edit note", title: "Edit note" },
    });
    setIcon(editBtn, Icon.EditTitle);
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.empty();
      renderNoteTextarea(panel, item, onSaved, showReadOnly);
    });
  };

  showReadOnly();
  return panel;
}

/**
 * The note-expand chevron, appended to `mainLine` right after the title so it reads as
 * part of it and leaves the checkboxes aligned. Only for a task that already has a note;
 * clicking it shows that note read-only. `openNoteKeys` is read on render and written on
 * toggle, so a note left open survives the rebuild `onRefresh()` does.
 */
export function renderNoteChevron(
  mainLine: HTMLElement,
  row: HTMLElement,
  item: Task,
  app: App,
  component: Component,
  openNoteKeys: Set<string>,
  onSaved: () => void,
): void {
  if (item.subLines.length === 0) return;

  const key = noteKey(item);

  const toggle = mainLine.createEl("button", {
    cls: "pm-dash-section-chevron pm-dash-section-chevron--collapsed pm-day-task-comment-toggle",
    attr: { "aria-label": "Toggle note", title: "Toggle note" },
  });
  setIcon(toggle, Icon.ToggleNote);

  let panel: HTMLElement | null = null;

  const open = () => {
    toggle.classList.remove("pm-dash-section-chevron--collapsed");
    panel = openNoteViewPanel(row, item, app, component, onSaved);
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

/** Appends one note-action button: "Add note" when the task has none, "Remove note"
 *  when it has one, which asks for confirmation first unless `confirmRemoval` is off. */
export function appendNoteActionButton(
  actions: HTMLElement,
  row: HTMLElement,
  item: Task,
  app: App,
  openNoteKeys: Set<string>,
  confirmRemoval: boolean,
  onSaved: () => void,
): void {
  if (item.subLines.length === 0) {
    appendActionButton(actions, {
      icon: Icon.AddNote,
      label: "Add note",
      onClick: () => {
        const key = noteKey(item);
        openNoteEditPanel(row, item, onSaved, () => openNoteKeys.delete(key));
        openNoteKeys.add(key);
      },
    });
    return;
  }

  appendActionButton(actions, {
    icon: Icon.RemoveNote,
    label: "Remove note",
    onClick: () => {
      // Nested checklist lines live in the same subLines block, so warn before
      // deleting those along with the note.
      const hasNestedTasks = item.subLines.some((l) => NESTED_CHECKBOX_RE.test(l));
      const message = hasNestedTasks
        ? `Remove note from "${item.title}"? This also deletes nested checklist items underneath it.`
        : `Remove note from "${item.title}"?`;
      confirmAction(app, confirmRemoval, message, () => {
        openNoteKeys.delete(noteKey(item));
        item.setNote("");
        void item.flush().then(onSaved);
      });
    },
  });
}

/**
 * Touch devices have no persistent `:hover` to reveal a row's floating toolbar, so a
 * tap on the row toggles `.pm-task-row--open`, which the CSS treats as `:hover`, and
 * the next tap elsewhere closes it.
 */
export function attachActionsTapToggle(row: HTMLElement): void {
  // Held so re-tapping the row closed unregisters the outside-click listener at once.
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
  /** The picker's "Clear" button — only where the task has a date of its own to drop. */
  onClear?: () => void,
): void {
  const btn = appendActionButton(parent, {
    icon: Icon.Reschedule,
    label: labels.ariaLabel,
    title: labels.title,
    // Seeded with the task's scheduled day, so the picker opens there and not on today.
    onClick: () => openDatePicker(btn, { initial: initialDate, onPick: onDate, onClear }),
  });
}

/**
 * Renders `text` as a single inline run inside `container`. The `<p>` `MarkdownRenderer`
 * wraps it in is on screen until the unwrap below — long enough for a view to be measured
 * a paragraph's margins too tall — so `.pm-inline-md` lays that wrapper out like the run.
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

/** Renders `displayText` into a new span, returned so it can be handed to
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

/** What an in-place title edit needs to know, whichever kind of task it is. Only
 *  `commit` differs: a line in a day note one side, a frontmatter field the other. */
export interface TitleEditSpec {
  /** The raw title to pre-fill, not the display text, which may have tags stripped. */
  current: string;
  /** Class the input mirrors, so it lays out like the span it replaces. */
  cls: string;
  /** Called with a non-empty title that differs from `current`. */
  commit: (newTitle: string) => void;
}

/** The spec for a checklist line: the edit rewrites the line in its day note, and the
 *  open-note state follows the rawLine change. */
export function dayTaskTitleEdit(
  item: Task,
  cls: string,
  openNoteKeys: Set<string>,
  onSaved: () => void,
): TitleEditSpec {
  return {
    current: item.title,
    cls,
    commit: (newTitle) => {
      // Taken before the write: the task moves with the edit, so its line reads as the
      // new one from here on.
      const oldRawLine = item.rawLine;
      migrateNoteKey(openNoteKeys, item, oldRawLine, Task.withUpdatedTitle(oldRawLine, newTitle));
      item.setTitle(newTitle);
      void item.flush().then(onSaved);
    },
  };
}

/** Swaps `span` for a text input pre-filled with `spec.current`: blur or Enter commits,
 *  Escape rolls back. */
function startTitleEdit(container: HTMLElement, span: HTMLElement, spec: TitleEditSpec): void {
  const input = container.createEl("input", {
    type: "text",
    cls: `${spec.cls} pm-task-title-input`,
    attr: { title: "Enter to save, esc to cancel" },
  });
  input.value = spec.current;
  container.insertBefore(input, span);
  span.remove();
  // Gives the input the whole row, hiding checkbox, badges, chevron and toolbar. The
  // container is the span's parent, which is what the hiding rule selects on.
  container.classList.add("pm-task-row--editing");
  // The add-task bar would otherwise sit right under the field being typed in.
  const listRoot = container.closest(".pm-dash-content");
  listRoot?.classList.add("pm-title-editing");
  const releaseAddBar = () => listRoot?.classList.remove("pm-title-editing");
  const restoreSpan = () => {
    input.replaceWith(span);
    container.classList.remove("pm-task-row--editing");
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
      // The row stays the input's until the write's re-render replaces it; only the add
      // bar comes back now, the typing being done.
      releaseAddBar();
      spec.commit(newTitle);
    },
    restoreSpan,
  );
}

/** Appends an "Edit title" button that swaps `titleSpan` for an input. Call sites skip
 *  it for habits, whose title belongs to the shared definition rather than the line. */
export function appendEditTitleButton(
  actions: HTMLElement,
  container: HTMLElement,
  titleSpan: HTMLElement,
  spec: TitleEditSpec,
): void {
  appendActionButton(actions, {
    icon: Icon.EditTitle,
    label: "Edit title",
    onClick: () => startTitleEdit(container, titleSpan, spec),
  });
}
