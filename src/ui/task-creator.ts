import { App, TFile, normalizePath, setIcon } from "obsidian";
import { Icon, renderIcon } from "./icons";
import { withAlpha } from "./task-badges";
import { ConfirmStyle, PmModal } from "./pm-modal";
import { formatDate } from "../model/dates";
import { openDatePicker } from "./date-picker";
import { openIconPicker } from "./icon-picker";
import { isValidDependencyTarget, TaskType, type ProjectTask } from "../model/project/project-task";
import { isAncestor } from "../model/project/task-tree";
import type { Project } from "../model/project/project";
import { DescriptionWrite, type VaultData } from "../model/service/vault-data";
import {
  STATUSES, STATUS_COLORS, STATUS_LABELS, PRIORITIES, PRIORITY_LABELS, Priority, Status,
  NEUTRAL_COLOR, getPriorityColor, getStatusColor, statusLabel, toStatus,
} from "../model/base-task";

/** Whether the task modal is filling a new note or editing one that exists. */
export enum TaskModalMode {
  Create = "create",
  Edit = "edit",
}

interface CreateTaskOptions {
  mode: TaskModalMode.Create;
  vault: VaultData;
  projectId: string;
  projectFilePath: string;
  projectTitle: string;
  parentTask?: ProjectTask;
  existingTasks: ProjectTask[];
  onSuccess: () => void;
}

interface EditTaskOptions {
  mode: TaskModalMode.Edit;
  vault: VaultData;
  task: ProjectTask;
  existingTasks: ProjectTask[];
  onSuccess: () => void;
}

type TaskModalOptions = CreateTaskOptions | EditTaskOptions;

/** Whether the project modal is filling a new note or editing one that exists. */
export enum ProjectModalMode {
  Create = "create",
  Edit = "edit",
}

interface CreateProjectOptions {
  mode: ProjectModalMode.Create;
  vault: VaultData;
  onSuccess: () => void;
}

interface EditProjectOptions {
  mode: ProjectModalMode.Edit;
  project: Project;
  vault: VaultData;
  onSuccess: () => void;
}

type ProjectModalOptions = CreateProjectOptions | EditProjectOptions;

/** Swatch colour for a priority, falling back to grey — this modal always shows a dot. */
function priorityDotColor(priority: Priority): string {
  return getPriorityColor(priority) || NEUTRAL_COLOR;
}

// `Subtask` is set automatically when there is a parent — not shown in the UI
const TYPES = [TaskType.Task, TaskType.Milestone] as const;

function buildFieldRow(parent: HTMLElement, label: string, build: (cell: HTMLElement) => void): void {
  const row = parent.createDiv({ cls: "pm-tm-row" });
  row.createDiv({ cls: "pm-tm-row-label", text: label });
  const cell = row.createDiv({ cls: "pm-tm-row-cell" });
  build(cell);
}

/**
 * The document-level listeners that dismiss `popup`: a click outside it, any scroll under
 * `dismissOnScroll`, and `anchor` leaving the document. Returns a `dismiss` so a caller
 * closing the popup itself takes them down too. `delayAttach` defers registration a tick,
 * so the click that opened the popup doesn't close it.
 */
function attachDismissHandlers(
  popup: HTMLElement,
  opts?: { delayAttach?: boolean; dismissOnScroll?: boolean; anchor?: HTMLElement },
): () => void {
  let anchorWatch: MutationObserver | undefined;
  const dismiss = (): void => {
    popup.remove();
    activeDocument.removeEventListener("pointerdown", onPointerDown);
    if (opts?.dismissOnScroll) activeDocument.removeEventListener("scroll", dismiss, true);
    anchorWatch?.disconnect();
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (!popup.contains(e.target as Node)) dismiss();
  };
  const attach = (): void => {
    // `pointerdown`, not `mousedown`: the compatibility `mousedown` a phone fires when
    // the finger lifts would read as a click outside and close the popup at once.
    activeDocument.addEventListener("pointerdown", onPointerDown);
    // Capture phase: the scroll happens inside the view's own scroller and doesn't bubble.
    if (opts?.dismissOnScroll) activeDocument.addEventListener("scroll", dismiss, true);
    // A popup parented to `body` outlives the row it points at, and a refresh from
    // anywhere else would leave it floating, anchored to nothing.
    const anchor = opts?.anchor;
    if (anchor) {
      anchorWatch = new MutationObserver(() => { if (!anchor.isConnected) dismiss(); });
      anchorWatch.observe(activeDocument.body, { childList: true, subtree: true });
    }
  };
  if (opts?.delayAttach) window.setTimeout(attach, 0);
  else attach();
  return dismiss;
}

/**
 * Places `picker` against `anchor` in viewport coordinates: below it, flipped above when
 * there is no room, clamped so it can't run past an edge. It is fixed and lives on `body`
 * because an in-flow popup lands at its flex container's origin, not at the anchor, with
 * nothing keeping it in the window. With neither side fitting it clamps to the top, which
 * stays on screen because the CSS caps it at 60vh and scrolls the overflow.
 */
function positionDropdown(picker: HTMLElement, anchor: HTMLElement): void {
  const margin = 4;
  const a = anchor.getBoundingClientRect();
  const { width, height } = picker.getBoundingClientRect();
  const vw = activeDocument.documentElement.clientWidth;
  const vh = activeDocument.documentElement.clientHeight;

  const below = a.bottom + margin;
  picker.style.top = `${below + height <= vh - margin ? below : Math.max(margin, a.top - height - margin)}px`;
  picker.style.left = `${Math.max(margin, Math.min(a.left, vw - width - margin))}px`;
}

/** One row of a dropdown: what it says, the dot beside it, whether it is the value in
 *  force, and what picking it does. A row with no `color` is drawn without a dot, which
 *  puts its label out of line with the rest — so a value whose colour is "none" wants
 *  `NEUTRAL_COLOR`, not nothing. */
export interface DropdownItem {
  label: string;
  color?: string;
  /** A function is re-read after each pick while the picker stays open. */
  selected?: boolean | (() => boolean);
  disabled?: boolean;
  tooltip?: string;
  onSelect: () => void;
}

/** The priority picker's rows, in the order the vocabulary lists them. */
export function priorityDropdownItems(
  current: Priority | undefined,
  onPick: (priority: Priority) => void,
): DropdownItem[] {
  return PRIORITIES.map((priority) => ({
    label: PRIORITY_LABELS[priority],
    color: priorityDotColor(priority),
    selected: priority === (current || Priority.None),
    onSelect: () => onPick(priority),
  }));
}

/** The status picker's rows, in the order the vocabulary lists them. */
export function statusDropdownItems(
  current: string,
  onPick: (status: Status) => void,
): DropdownItem[] {
  return STATUSES.map((status) => ({
    label: STATUS_LABELS[status],
    color: STATUS_COLORS[status],
    selected: status === toStatus(current),
    onSelect: () => onPick(status),
  }));
}

/**
 * A small dropdown anchored to `anchor`. A `selected` item is the value in force, so the
 * picker says where the task stands as well as where it could go. A `disabled` one is
 * shown but unselectable, since dropping it would deny the option exists; `tooltip` is
 * where its reason goes.
 *
 * `keepOpen` makes it a multiple choice: the picker stays up until a click outside it, so
 * several items can be ticked in a row. Nothing rebuilds it in between, so every `selected`
 * given as a function is asked again after each pick — one item's doing shows on the others.
 *
 * Returns the dismiss, for a caller that has to close the picker itself: staying open, it
 * no longer follows its anchor out of the document.
 */
export function openDropdown(
  anchor: HTMLElement,
  items: DropdownItem[],
  opts: { keepOpen?: boolean } = {},
): () => void {
  const picker = createDiv({ cls: "pm-tm-dropdown" });
  // A multiple choice redraws what it is anchored to on every tick, so watching the anchor
  // would close it on the first one. A click outside is what ends it instead.
  const dismiss = attachDismissHandlers(picker, {
    delayAttach: true,
    dismissOnScroll: true,
    anchor: opts.keepOpen ? undefined : anchor,
  });
  const ticked = (item: { selected?: boolean | (() => boolean) }): boolean =>
    typeof item.selected === "function" ? item.selected() : !!item.selected;
  const rows: { item: (typeof items)[number]; el: HTMLElement }[] = [];
  for (const item of items) {
    const on = ticked(item);
    const el = picker.createDiv({
      cls: `pm-tm-dropdown-item${on ? " pm-tm-dropdown-item--selected" : ""}`
        + `${item.disabled ? " pm-tm-dropdown-item--disabled" : ""}`,
    });
    rows.push({ item, el });
    if (on) el.setAttribute("aria-current", "true");
    if (item.tooltip) el.setAttribute("aria-label", item.tooltip);
    if (item.color) {
      const dot = el.createSpan({ cls: "pm-tm-dropdown-dot" });
      dot.style.setProperty("--pm-dot-color", item.color);
    }
    el.createSpan({ text: item.label });
    if (item.disabled) {
      el.setAttribute("aria-disabled", "true");
      continue;
    }
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      item.onSelect();
      if (!opts.keepOpen) {
        dismiss();
        return;
      }
      for (const row of rows) {
        const now = ticked(row.item);
        row.el.toggleClass("pm-tm-dropdown-item--selected", now);
        if (now) row.el.setAttribute("aria-current", "true");
        else row.el.removeAttribute("aria-current");
      }
    });
  }
  activeDocument.body.appendChild(picker);
  positionDropdown(picker, anchor);
  return dismiss;
}

/** Opens a note, reusing the tab already showing it unless `newLeaf`. */
export function openNoteFile(app: App, filePath: string, newLeaf = false): void {
  const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
  if (!(file instanceof TFile)) return;
  let existing: import("obsidian").WorkspaceLeaf | undefined;
  if (!newLeaf) {
    app.workspace.iterateAllLeaves((leaf) => {
      if (!existing && (leaf.view as { file?: TFile }).file?.path === file.path) {
        existing = leaf;
      }
    });
  }
  if (existing) {
    void app.workspace.revealLeaf(existing);
  } else {
    void app.workspace.getLeaf(newLeaf).openFile(file);
  }
}

/** The confirm button's wording and looks. Deleting is what most confirmations here ask
 *  about, so that is what an omitted one reads as. */
export interface ConfirmCta {
  label: string;
  style: ConfirmStyle;
}

const DELETE_CTA: ConfirmCta = { label: "Delete", style: ConfirmStyle.Warning };

export class ConfirmModal extends PmModal {
  private readonly message: string;
  private readonly onConfirm: () => void;

  protected readonly confirmLabel: string;

  constructor(app: App, message: string, onConfirm: () => void, cta: ConfirmCta = DELETE_CTA) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmLabel = cta.label;
    this.confirmStyle = cta.style;
  }

  protected build(contentEl: HTMLElement): void {
    contentEl.createEl("p", { text: this.message, cls: "pm-confirm-message" });
  }

  protected confirm(): void {
    this.close();
    this.onConfirm();
  }

  onOpen(): void {
    super.onOpen();
    // No field to type in, so nothing here would hold focus and see the keystroke.
    // Cancel is the safe thing for plain Enter to land on.
    this.cancelBtn.focus();
  }
}

/** Asks first when the setting guarding this kind of action is on, and acts straight away
 *  when it is off. */
export function confirmAction(
  app: App,
  required: boolean,
  message: string,
  onConfirm: () => void,
  cta?: ConfirmCta,
): void {
  if (!required) {
    onConfirm();
    return;
  }
  new ConfirmModal(app, message, onConfirm, cta).open();
}

export class TaskModal extends PmModal {
  private readonly opts: TaskModalOptions;
  private readonly hasParent: boolean;
  private status: string;
  private priority: Priority;
  private type: TaskType;
  private progress: number;
  private start: Date | null = null;
  private due: Date | null = null;
  private tags: string[] = [];
  private dependencies: string[] = [];

  // DOM refs
  private statusDot!: HTMLElement;
  private statusBtn!: HTMLElement;
  private priorityDot!: HTMLElement;
  private priorityBtn!: HTMLElement;
  private progressLabel!: HTMLElement;
  private depsContainer!: HTMLElement;
  private tagsContainer!: HTMLElement;
  private titleInput!: HTMLInputElement;
  private descInput!: HTMLTextAreaElement;

  /** Editing fills the description by an async read; saving before it lands would blank
   *  the task's real body, so `confirm` refuses until it has. */
  private descriptionReady: boolean;

  /** The description as that read found it. Saving carries it along, and the note is written
   *  only while it still says the same — otherwise the note was edited underneath. */
  private loadedDescription = "";

  /** Where the dialog says what became of the description it was given. */
  private descBanner!: HTMLElement;

  protected readonly confirmLabel: string;

  constructor(app: App, opts: TaskModalOptions) {
    super(app);
    this.opts = opts;
    this.confirmLabel = opts.mode === TaskModalMode.Edit ? "Save" : "Create task";
    this.descriptionReady = opts.mode !== TaskModalMode.Edit;

    if (opts.mode === TaskModalMode.Edit) {
      const t = opts.task;
      this.hasParent = !!t.parentId;
      this.status = t.status;
      this.priority = t.priority ?? Priority.None;
      // Normalize legacy `Subtask` type to `Task` for the UI selector
      this.type = (t.type === TaskType.Subtask || !t.type) ? TaskType.Task : t.type;
      this.progress = t.progress ?? 0;
      this.start = t.start ?? null;
      this.due = t.due ?? null;
      this.tags = [...(t.tags ?? [])];
      this.dependencies = [...t.dependencies];
    } else {
      this.hasParent = !!opts.parentTask;
      this.status = Status.Todo;
      this.priority = Priority.None;
      this.type = TaskType.Task;
      this.progress = 0;
    }
  }

  protected build(contentEl: HTMLElement): void {
    this.modalEl.addClass("pm-task-modal-wrap");
    contentEl.addClass("pm-task-modal");

    const isEdit = this.opts.mode === TaskModalMode.Edit;

    // ── Title row ─────────────────────────────────────────────────────────────
    const titleRow = contentEl.createDiv({ cls: "pm-tm-title-row" });
    this.statusDot = titleRow.createSpan({ cls: "pm-tm-status-dot" });
    this.statusDot.style.setProperty("--pm-dot-color", getStatusColor(this.status));
    this.titleInput = titleRow.createEl("input", { cls: "pm-tm-title-input", placeholder: "Task title..." });
    this.titleInput.type = "text";
    if (isEdit) this.titleInput.value = this.opts.task.title;
    else this.titleInput.autofocus = true;

    if (isEdit) {
      const gotoBtn = titleRow.createEl("button", { cls: "pm-tm-goto-btn", attr: { "aria-label": "Open note" } });
      setIcon(gotoBtn, Icon.OpenNote);
      gotoBtn.addEventListener("click", () => {
        const filePath = (this.opts as EditTaskOptions).task.filePath;
        openNoteFile(this.app, filePath);
        this.close();
      });
    }

    // ── Description ───────────────────────────────────────────────────────────
    // Above the field it speaks about, and empty until there is something to say — the
    // stylesheet keeps an empty one out of the layout. A dialog left unsavable has to say
    // why for as long as it stands there, which a notice that fades cannot do.
    this.descBanner = contentEl.createDiv({ cls: "pm-tm-banner" });
    contentEl.createDiv({ cls: "pm-tm-section-label", text: "DESCRIPTION" });
    const descWrap = contentEl.createDiv({ cls: "pm-tm-desc-wrap" });
    this.descInput = descWrap.createEl("textarea", { cls: "pm-tm-description", placeholder: "Add a description..." });
    this.attachLinkSuggest(this.descInput, descWrap);

    // Save stays refused until the description loads, so a quick one can't blank the
    // body — and stays refused on a load failure rather than risk that.
    if (isEdit) {
      this.confirmBtn.disabled = true;
      this.loadDescription(this.descInput)
        .then(() => {
          this.descriptionReady = true;
          this.confirmBtn.disabled = false;
        })
        .catch((e) => {
          console.error("pm-compass: failed to load task description", e);
          this.confirmBtn.setText("Couldn't load — reopen");
          this.sayOfDescription(
            "The task's description couldn't be read. Saving would write this empty box over "
            + "it, so this dialog won't save at all. Close it and open the task again.",
          );
        });
    }

    // ── Fields ────────────────────────────────────────────────────────────────
    const fields = contentEl.createDiv({ cls: "pm-tm-fields" });

    // Status — dropdown
    buildFieldRow(fields, "Status", (cell) => {
      this.statusBtn = cell.createEl("button", { cls: "pm-tm-pill" });
      this.refreshStatusBtn();
      this.statusBtn.addEventListener("click", () => {
        openDropdown(this.statusBtn, statusDropdownItems(this.status, (s) => {
          this.status = s;
          this.statusDot.style.setProperty("--pm-dot-color", getStatusColor(s));
          this.refreshStatusBtn();
        }));
      });
    });

    // Priority — dropdown
    buildFieldRow(fields, "Priority", (cell) => {
      const wrap = cell.createSpan({ cls: "pm-tm-priority-wrap" });
      this.priorityDot = wrap.createSpan({ cls: "pm-tm-priority-dot" });
      this.priorityBtn = wrap.createSpan({ cls: "pm-tm-priority-label" });
      this.refreshPriorityBtn();
      wrap.addEventListener("click", () => {
        openDropdown(wrap, priorityDropdownItems(this.priority, (p) => {
          this.priority = p;
          this.refreshPriorityBtn();
        }));
      });
    });

    // Type — only shown for top-level tasks (no parent)
    if (!this.hasParent) {
      buildFieldRow(fields, "Type", (cell) => {
        const seg = cell.createDiv({ cls: "pm-tm-segmented" });
        for (const t of TYPES) {
          const btn = seg.createEl("button", { cls: "pm-tm-seg-btn", text: t.charAt(0).toUpperCase() + t.slice(1) });
          if (t === this.type) btn.addClass("is-active");
          btn.addEventListener("click", () => {
            this.type = t;
            seg.querySelectorAll(".pm-tm-seg-btn").forEach((b) => b.removeClass("is-active"));
            btn.addClass("is-active");
          });
        }
      });
    }

    // Progress
    buildFieldRow(fields, "Progress", (cell) => {
      const wrap = cell.createDiv({ cls: "pm-tm-progress-wrap" });
      const slider = wrap.createEl("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.value = String(this.progress);
      slider.addClass("pm-tm-slider");
      this.progressLabel = wrap.createSpan({ cls: "pm-tm-progress-label", text: `${this.progress}%` });
      slider.addEventListener("input", () => {
        this.progress = Number(slider.value);
        this.progressLabel.setText(`${this.progress}%`);
      });
    });

    // Start / Due
    this.buildDateRow(fields, "Start", () => this.start, (d) => { this.start = d; });
    this.buildDateRow(fields, "Due", () => this.due, (d) => { this.due = d; });

    // Tags
    buildFieldRow(fields, "Tags", (cell) => {
      this.tagsContainer = cell.createDiv({ cls: "pm-tm-chip-row" });
      for (const tag of this.tags) {
        this.renderChip(this.tagsContainer, tag, () => { this.tags = this.tags.filter((t) => t !== tag); });
      }
      const addBtn = cell.createEl("button", { cls: "pm-tm-add-chip", text: "+ tag" });
      addBtn.addEventListener("click", () => this.promptAddTag(addBtn));
    });

    // Depends on — same-level tasks only
    buildFieldRow(fields, "Depends on", (cell) => {
      this.depsContainer = cell.createDiv({ cls: "pm-tm-chip-row" });
      for (const depId of this.dependencies) {
        const title = this.opts.existingTasks.find((t) => t.id === depId)?.title ?? depId;
        this.renderChip(this.depsContainer, title, () => { this.dependencies = this.dependencies.filter((d) => d !== depId); });
      }
      const addBtn = cell.createEl("button", { cls: "pm-tm-add-chip", text: "+ add dependency" });
      addBtn.addEventListener("click", () => this.openDepPicker(addBtn));
    });

    this.titleInput.addEventListener("input", () => this.titleInput.removeClass("pm-tm-error"));
  }

  protected confirm(): void {
    void (async () => {
      // The button is disabled until the load lands; this refuses to commit an
      // unloaded description even were that guard bypassed.
      if (!this.descriptionReady) return;
      const title = this.titleInput.value.trim();
      if (!title) {
        this.titleInput.addClass("pm-tm-error");
        this.titleInput.focus();
        return;
      }
      this.confirmBtn.disabled = true;
      const formData = {
        title,
        description: this.descInput.value,
        status: this.status,
        priority: this.priority,
        type: this.hasParent ? TaskType.Subtask : this.type,
        progress: this.progress,
        start: this.start,
        due: this.due,
        tags: this.tags,
        dependencies: this.dependencies,
      };
      try {
        if (this.opts.mode === TaskModalMode.Edit) {
          const written = await this.opts.vault.projects.updateTask(
            this.opts.task, { ...formData, baseDescription: this.loadedDescription },
          );
          // The fields are on the note; the description is not, and only this dialog still
          // holds it. So it stays open, with the text where the user can take it back. The
          // button stays disabled: this dialog's baseline is spent, and pressing it again
          // could only reach the same answer.
          if (written === DescriptionWrite.Conflict) {
            this.confirmBtn.setText("Description changed on the note");
            this.sayOfDescription(
              "The note's description was edited while this was open, so it was left alone. "
              + "Everything else was saved. Copy your text out and reopen the task.",
            );
            return;
          }
        } else {
          await this.opts.vault.projects.createTask({
            projectId: this.opts.projectId,
            projectFilePath: this.opts.projectFilePath,
            projectTitle: this.opts.projectTitle,
            parentTask: this.opts.parentTask,
            ...formData,
          });
        }
        this.close();
        this.opts.onSuccess();
      } catch (e) {
        this.confirmBtn.disabled = false;
        this.confirmBtn.setText("Error — retry");
        console.error("pm-compass: failed to save task", e);
      }
    })();
  }

  /** Says, in the dialog and for as long as it stands, why the description on the note is
   *  not what this box holds. Both reasons leave the dialog open and unsavable, and a
   *  notice would fade off a screen the user is still looking at. */
  private sayOfDescription(message: string): void {
    this.descBanner.setText(message);
    // The button that was just pressed is at the far end of the dialog, so on a phone the
    // answer to the press can sit off-screen.
    this.descBanner.scrollIntoView({ block: "nearest" });
  }

  private async loadDescription(textarea: HTMLTextAreaElement): Promise<void> {
    if (this.opts.mode !== TaskModalMode.Edit) return;
    this.loadedDescription = await this.opts.vault.projects.readDescription(this.opts.task);
    textarea.value = this.loadedDescription;
  }

  private attachLinkSuggest(textarea: HTMLTextAreaElement, wrap: HTMLElement): void {
    const suggestEl = wrap.createDiv({ cls: "pm-tm-link-suggest" });
    suggestEl.setCssStyles({ display: "none" });

    let suggestions: string[] = [];
    let selectedIdx = 0;
    /** Every note's name, lowercased alongside it. Taken on the first `[[` and kept for the
     *  modal's life, not rebuilt per keystroke: a vault holds thousands of notes, and this
     *  runs while the user types. A note created while the modal is open isn't offered. */
    let names: { name: string; lower: string }[] | null = null;

    const hide = () => { suggestEl.setCssStyles({ display: "none" }); suggestions = []; selectedIdx = 0; };

    const renderSuggestions = (query: string) => {
      names ??= this.app.vault
        .getMarkdownFiles()
        .map((f) => ({ name: f.basename, lower: f.basename.toLowerCase() }));
      const needle = query.toLowerCase();
      suggestions = names
        .filter((n) => n.lower.includes(needle))
        .slice(0, 8)
        .map((n) => n.name);

      if (suggestions.length === 0) { hide(); return; }

      selectedIdx = 0;
      suggestEl.empty();
      suggestEl.setCssStyles({ display: "block" });
      suggestions.forEach((name, i) => {
        const item = suggestEl.createDiv({ cls: "pm-tm-link-item" + (i === 0 ? " is-selected" : ""), text: name });
        item.addEventListener("mousedown", (e) => { e.preventDefault(); insert(name); });
      });
    };

    const insert = (name: string) => {
      const cursor = textarea.selectionStart;
      const before = textarea.value.slice(0, cursor).replace(/\[\[([^[\]]*)$/, "");
      const after = textarea.value.slice(cursor);
      textarea.value = before + `[[${name}]]` + after;
      textarea.selectionStart = textarea.selectionEnd = before.length + name.length + 4;
      hide();
    };

    textarea.addEventListener("input", () => {
      const before = textarea.value.slice(0, textarea.selectionStart);
      const match = before.match(/\[\[([^[\]]*)$/);
      if (match) { renderSuggestions(match[1]); } else { hide(); }
    });

    textarea.addEventListener("keydown", (e) => {
      if (suggestEl.style.display === "none") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % suggestions.length;
        suggestEl.querySelectorAll(".pm-tm-link-item").forEach((el, i) => el.toggleClass("is-selected", i === selectedIdx));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIdx = (selectedIdx - 1 + suggestions.length) % suggestions.length;
        suggestEl.querySelectorAll(".pm-tm-link-item").forEach((el, i) => el.toggleClass("is-selected", i === selectedIdx));
      } else if (e.key === "Enter" && suggestions.length > 0) {
        e.preventDefault();
        insert(suggestions[selectedIdx]);
      } else if (e.key === "Escape") {
        hide();
      }
    });

    textarea.addEventListener("blur", () => { window.setTimeout(hide, 150); });
  }

  /**
   * A date field: a button naming the date it holds, which opens the plugin's own calendar.
   * Not `<input type=date>`, whose picker is the platform's — on a phone a full-screen OS
   * dialog over the modal, in a locale of its own, and nothing like the calendar the
   * dashboard and the day rows open for the same job.
   */
  private buildDateRow(
    parent: HTMLElement,
    label: string,
    get: () => Date | null,
    set: (date: Date | null) => void,
  ): void {
    buildFieldRow(parent, label, (cell) => {
      const btn = cell.createEl("button", { cls: "pm-tm-date" });
      const refresh = (): void => {
        const date = get();
        btn.setText(date ? formatDate(date) : "Set a date");
        btn.toggleClass("pm-tm-date--empty", !date);
      };
      refresh();
      btn.addEventListener("click", () => {
        openDatePicker(this.app, btn, {
          initial: get() ?? undefined,
          onPick: (date) => { set(date); refresh(); },
          // Offered whether or not there is one to clear: a field reading "Set a date" is
          // its own answer, and the footer keeping its shape is worth more than the button.
          onClear: () => { set(null); refresh(); },
        });
      });
    });
  }

  private refreshStatusBtn(): void {
    this.statusBtn.style.setProperty("--pm-pill-bg", withAlpha(getStatusColor(this.status), "33"));
    this.statusBtn.style.setProperty("--pm-pill-color", getStatusColor(this.status));
    this.statusBtn.setText(statusLabel(this.status));
  }

  private refreshPriorityBtn(): void {
    this.priorityDot.style.setProperty("--pm-dot-color", priorityDotColor(this.priority));
    this.priorityBtn.setText(PRIORITY_LABELS[this.priority]);
  }

  private promptAddTag(anchor: HTMLElement): void {
    const input = createEl("input");
    input.type = "text";
    input.placeholder = "Tag name";
    input.addClass("pm-tm-inline-input");
    anchor.before(input);
    input.focus();

    const commit = () => {
      const val = input.value.trim();
      if (val && !this.tags.includes(val)) {
        this.tags.push(val);
        this.renderChip(this.tagsContainer, val, () => { this.tags = this.tags.filter((t) => t !== val); });
      }
      input.remove();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") input.remove();
    });
    input.addEventListener("blur", commit);
  }

  private openDepPicker(anchor: HTMLElement): void {
    const tasks = this.opts.existingTasks;
    const isEdit = this.opts.mode === TaskModalMode.Edit;
    const selfId = isEdit ? this.opts.task.id : undefined;
    const projectId = isEdit ? this.opts.task.projectId : this.opts.projectId;
    // What the graph will let a task be joined to, so the two say the same thing: anywhere
    // in the project bar the task's own line of descent, which no level could draw the link
    // on. `isValidDependencyTarget` says all of that, plus the cycles, for a task that
    // exists. One being created has no dependants yet, so only the line above it is barred.
    const above = new Map(tasks.map((t) => [t.id, t]));
    const parentId = this.opts.mode === TaskModalMode.Create ? this.opts.parentTask?.id : undefined;
    const refused = (t: ProjectTask) => selfId !== undefined
      ? !isValidDependencyTarget(above, t.id, selfId).valid
      : parentId !== undefined && (t.id === parentId || isAncestor(above, t.id, parentId));

    const available = tasks.filter(
      (t) => t.projectId === projectId && t.id !== selfId &&
        !this.dependencies.includes(t.id) && !refused(t),
    );
    if (available.length === 0) return;

    const picker = createDiv({ cls: "pm-tm-dep-picker" });
    const dismiss = attachDismissHandlers(picker);
    for (const task of available) {
      const item = picker.createDiv({ cls: "pm-tm-dep-item", text: task.title });
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.dependencies.push(task.id);
        this.renderChip(this.depsContainer, task.title, () => { this.dependencies = this.dependencies.filter((d) => d !== task.id); });
        dismiss();
      });
    }
    anchor.after(picker);
  }

  private renderChip(container: HTMLElement, label: string, onRemove: () => void): void {
    const chip = container.createSpan({ cls: "pm-tm-chip" });
    chip.createSpan({ text: label });
    const x = chip.createSpan({ cls: "pm-tm-chip-x", text: "×" });
    x.addEventListener("click", () => { chip.remove(); onRemove(); });
  }
}

export class ProjectModal extends PmModal {
  private readonly opts: ProjectModalOptions;

  protected readonly confirmLabel: string;

  /** Empty = no colour set, which is not the same as the grey the swatch falls back to. */
  private colorValue: string;

  /** Empty = no icon, which is what the note carries no key for. */
  private iconValue: string;

  private titleInput!: HTMLInputElement;
  private archivedInput?: HTMLInputElement;

  constructor(app: App, opts: ProjectModalOptions) {
    super(app);
    this.opts = opts;
    this.confirmLabel = opts.mode === ProjectModalMode.Edit ? "Save" : "Create project";
    this.colorValue = opts.mode === ProjectModalMode.Edit ? opts.project.color ?? "" : "";
    this.iconValue = opts.mode === ProjectModalMode.Edit ? opts.project.icon ?? "" : "";
  }

  /** The project being edited, or null while one is being filled in — which is what the
   *  rows about a note that exists go by. */
  private get project(): Project | null {
    return this.opts.mode === ProjectModalMode.Edit ? this.opts.project : null;
  }

  protected build(contentEl: HTMLElement): void {
    this.modalEl.addClass("pm-task-modal-wrap");
    contentEl.addClass("pm-task-modal");

    const project = this.project;

    // ── Title row ─────────────────────────────────────────────────────────────
    const titleRow = contentEl.createDiv({ cls: "pm-tm-title-row" });
    const colorDot = titleRow.createSpan({ cls: "pm-tm-status-dot" });
    colorDot.style.setProperty("--pm-dot-color", this.colorValue || "#888888");
    this.titleInput = titleRow.createEl("input", { cls: "pm-tm-title-input", placeholder: "Project title..." });
    this.titleInput.type = "text";
    this.titleInput.value = project?.title ?? "";
    this.titleInput.addEventListener("input", () => this.titleInput.removeClass("pm-tm-error"));

    if (project) {
      const gotoBtn = titleRow.createEl("button", { cls: "pm-tm-goto-btn", attr: { "aria-label": "Open note" } });
      setIcon(gotoBtn, Icon.OpenNote);
      gotoBtn.addEventListener("click", () => {
        openNoteFile(this.app, project.filePath);
        this.close();
      });
    }

    // ── Fields ────────────────────────────────────────────────────────────────
    const fields = contentEl.createDiv({ cls: "pm-tm-fields" });

    // Color
    buildFieldRow(fields, "Color", (cell) => {
      const colorInput = cell.createEl("input");
      colorInput.type = "color";
      colorInput.value = this.colorValue || "#888888";
      colorInput.addClass("pm-tm-color-input");
      colorInput.addEventListener("input", () => {
        this.colorValue = colorInput.value;
        colorDot.style.setProperty("--pm-dot-color", this.colorValue);
      });
      const clearBtn = cell.createEl("button", { cls: "pm-tm-clear-color-btn", text: "✕ none" });
      clearBtn.setAttribute("aria-label", "None — remove the color");
      clearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.colorValue = "";
        colorInput.value = "#888888";
        colorDot.setCssProps({ "--pm-dot-color": "#888888" });
      });
    });

    // Icon
    buildFieldRow(fields, "Icon", (cell) => {
      const swatch = cell.createEl("button", { cls: "pm-tm-icon-btn" });
      swatch.setAttribute("aria-label", "Choose an icon");
      const drawSwatch = (): void => {
        if (this.iconValue) renderIcon(swatch, this.iconValue);
        else swatch.setText("—");
      };
      drawSwatch();
      swatch.addEventListener("click", (e) => {
        e.preventDefault();
        openIconPicker(this.app, swatch, {
          current: this.iconValue,
          onPick: (icon) => { this.iconValue = icon; drawSwatch(); },
        });
      });

      const clearBtn = cell.createEl("button", { cls: "pm-tm-clear-color-btn", text: "✕ none" });
      clearBtn.setAttribute("aria-label", "None — remove the icon");
      clearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.iconValue = "";
        drawSwatch();
      });
    });

    // Archived — a project being created is one being taken up, never one put away.
    if (project) {
      buildFieldRow(fields, "Archived", (cell) => {
        const archived = cell.createEl("input", { cls: "pm-tm-archived-input" });
        archived.type = "checkbox";
        archived.checked = project.archived === true;
        this.archivedInput = archived;
        cell.createSpan({
          cls: "pm-tm-hint",
          text: "Hidden from the graph, the dashboard and the inbox",
        });
      });
    }
  }

  protected confirm(): void {
    void (async () => {
      const title = this.titleInput.value.trim();
      if (!title) { this.titleInput.addClass("pm-tm-error"); this.titleInput.focus(); return; }
      this.confirmBtn.disabled = true;
      try {
        const icon = this.iconValue || undefined;
        const color = this.colorValue || undefined;
        // Creating writes the note with those in it, rather than making one and editing it.
        if (this.opts.mode === ProjectModalMode.Create) {
          await this.opts.vault.projects.createProject({
            projectsFolder: this.opts.vault.settings().projectsFolder,
            title, icon, color,
          });
        } else {
          const project = this.opts.project;
          project.title = title;
          project.color = color;
          project.icon = icon;
          project.archived = this.archivedInput?.checked === true;
          await project.flush();
        }
        this.close();
        this.opts.onSuccess();
      } catch (e) {
        this.confirmBtn.disabled = false;
        this.confirmBtn.setText("Error — retry");
        console.error("pm-compass: failed to save project", e);
      }
    })();
  }
}
