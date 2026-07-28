import { App, Modal, Notice, TFile, normalizePath, setIcon } from "obsidian";
import { formatDate, parseDate } from "../model/dates";
import { isValidDependencyTarget } from "../model/shared";
import type { Task, Project } from "../model/shared";
import { ProjectTaskFile } from "../model/project-task-file";
import { generateId as _generateId } from "../model/file-helpers";
import { ProjectFile } from "../model/project-file";
import {
  STATUSES, STATUS_LABELS, STATUS_COLORS, PRIORITIES, PRIORITY_LABELS, Priority, getPriorityColor,
} from "../model/task-vocabulary";

interface CreateTaskOptions {
  mode: "create";
  projectId: string;
  projectFilePath: string;
  projectTitle: string;
  parentTask?: Task;
  existingTasks: Task[];
  onSuccess: () => void;
}

interface EditTaskOptions {
  mode: "edit";
  task: Task;
  existingTasks: Task[];
  onSuccess: () => void;
}

type TaskModalOptions = CreateTaskOptions | EditTaskOptions;

/** Swatch color for a priority, falling back to the "no priority" gray (unlike
 *  `getPriorityColor`, this modal always shows a dot, even for "no priority"). */
function priorityDotColor(priority: Priority): string {
  return getPriorityColor(priority) || "#6b7280";
}

// "subtask" is set automatically when there is a parent — not shown in the UI
const TYPES = ["task", "milestone"] as const;

export { _generateId as generateId };

export async function createTaskFile(
  app: App,
  opts: {
    projectId: string;
    projectFilePath: string;
    projectTitle: string;
    parentTask?: Task;
    title: string;
    description: string;
    status: string;
    priority: Priority;
    type: string;
    progress: number;
    start: Date | null;
    due: Date | null;
    tags: string[];
    dependencies: string[];
  },
): Promise<string> {
  const { id } = await ProjectTaskFile.create(app, opts);
  return id;
}

export async function deleteTaskFile(
  app: App,
  task: Task,
  parentTask?: Task,
  allTasks: Task[] = [],
): Promise<void> {
  await new ProjectTaskFile(app, task.filePath).delete(task.id, allTasks, parentTask);
}

/** Idempotently adds depId to task.dependencies and persists the change. */
export async function addTaskDependency(app: App, task: Task, depId: string): Promise<void> {
  await new ProjectTaskFile(app, task.filePath).addDependency(depId);
}

/** Idempotently removes depId from task.dependencies and persists the change. */
export async function removeTaskDependency(app: App, task: Task, depId: string): Promise<void> {
  await new ProjectTaskFile(app, task.filePath).removeDependency(depId);
}

export async function patchTaskField(
  app: App,
  filePath: string,
  field: "status" | "priority" | "title",
  value: string,
): Promise<void> {
  await new ProjectTaskFile(app, filePath).patchField(field, value);
}

/** Sets the deadline, or — `null` — clears it. */
export async function patchTaskDue(app: App, filePath: string, due: Date | null): Promise<void> {
  await new ProjectTaskFile(app, filePath).patchDue(due);
}


function buildFieldRow(parent: HTMLElement, label: string, build: (cell: HTMLElement) => void): void {
  const row = parent.createDiv({ cls: "pm-tm-row" });
  row.createDiv({ cls: "pm-tm-row-label", text: label });
  const cell = row.createDiv({ cls: "pm-tm-row-cell" });
  build(cell);
}

async function updateProjectFile(
  app: App,
  filePath: string,
  data: { title: string; color: string; icon: string },
): Promise<void> {
  await new ProjectFile(app, filePath).update(data);
}

/**
 * Registers the document-level listeners that dismiss `popup`: a click outside it,
 * — when `dismissOnScroll` is set — any scroll, which a viewport-fixed popup can't
 * follow, and — when `anchor` is given — that anchor leaving the document. Returns a
 * `dismiss` so a caller that closes `popup` some other way (selecting an item) takes
 * the listeners down with it. When `delayAttach` is set, registration is deferred to
 * the next tick so the click that opened the popup doesn't immediately close it.
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
    // `pointerdown`, not `mousedown`: a popup a touch opens is still open when the finger
    // lifts, and the compatibility `mousedown` a phone fires then — after `delayAttach`
    // has already registered this — reads as a click outside and closed it right away.
    activeDocument.addEventListener("pointerdown", onPointerDown);
    // Capture phase: the scroll happens inside the view's own scroller and doesn't bubble.
    if (opts?.dismissOnScroll) activeDocument.addEventListener("scroll", dismiss, true);
    // A popup parented to `body` outlives the row it points at: a refresh from any other
    // source (a vault change elsewhere) rebuilds the view underneath it and would leave it
    // floating, anchored to nothing. Watching the whole tree is affordable — the observer
    // only lives as long as the popup, which is a click or two.
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
 * Places `picker` against `anchor` in viewport coordinates: directly below it, flipped
 * above when there isn't room, and clamped so it can never run past an edge.
 *
 * The picker is fixed and lives on `body` rather than beside its anchor, because an
 * in-flow popup is placed at the *flex container's* content origin — not at the anchor —
 * and nothing keeps it inside the window: a row low in a scrolled list opened its
 * dropdown half outside the viewport, with the lower options unclickable.
 *
 * The last resort — neither side fits — clamps to the top, which only stays on screen
 * because the CSS caps the picker at 60vh and scrolls the overflow.
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

/**
 * Show a small dropdown anchored to `anchor` with generic items. An item marked `selected`
 * is the value in force, so the picker also says where the task stands, not only where it
 * could go — a ribbon rolled up over a subtree, or a colour, doesn't tell you that on its own.
 *
 * A `disabled` item is shown and not selectable: an option that can't be taken here still
 * says the option exists, which dropping it from the list would not. `title` is where its
 * reason goes.
 */
export function openDropdown(
  anchor: HTMLElement,
  items: {
    label: string;
    color?: string;
    selected?: boolean;
    disabled?: boolean;
    title?: string;
    onSelect: () => void;
  }[],
): void {
  const picker = createDiv({ cls: "pm-tm-dropdown" });
  const dismiss = attachDismissHandlers(picker, { delayAttach: true, dismissOnScroll: true, anchor });
  for (const item of items) {
    const el = picker.createDiv({
      cls: `pm-tm-dropdown-item${item.selected ? " pm-tm-dropdown-item--selected" : ""}`
        + `${item.disabled ? " pm-tm-dropdown-item--disabled" : ""}`,
    });
    if (item.selected) el.setAttribute("aria-current", "true");
    if (item.title) el.setAttribute("title", item.title);
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
      dismiss();
    });
  }
  activeDocument.body.appendChild(picker);
  positionDropdown(picker, anchor);
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

export class ConfirmModal extends Modal {
  private readonly message: string;
  private readonly onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message, cls: "pm-confirm-message" });
    const btnRow = contentEl.createDiv({ cls: "pm-confirm-buttons" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const confirmBtn = btnRow.createEl("button", { text: "Delete", cls: "mod-warning" });
    confirmBtn.addEventListener("click", () => { this.close(); this.onConfirm(); });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class TaskModal extends Modal {
  private readonly opts: TaskModalOptions;
  private readonly hasParent: boolean;
  private status: string;
  private priority: Priority;
  private type: string;
  private progress: number;
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

  constructor(app: App, opts: TaskModalOptions) {
    super(app);
    this.opts = opts;

    if (opts.mode === "edit") {
      const t = opts.task;
      this.hasParent = !!t.parentId;
      this.status = t.status;
      this.priority = t.priority ?? Priority.None;
      // Normalize legacy "subtask" type to "task" for the UI selector
      this.type = (t.type === "subtask" || !t.type) ? "task" : t.type;
      this.progress = t.progress ?? 0;
      this.tags = [...(t.tags ?? [])];
      this.dependencies = [...t.dependencies];
    } else {
      this.hasParent = !!opts.parentTask;
      this.status = "todo";
      this.priority = Priority.None;
      this.type = "task";
      this.progress = 0;
    }
  }

  onOpen(): void {
    this.modalEl.addClass("pm-task-modal-wrap");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pm-task-modal");

    const isEdit = this.opts.mode === "edit";

    // ── Title row ─────────────────────────────────────────────────────────────
    const titleRow = contentEl.createDiv({ cls: "pm-tm-title-row" });
    this.statusDot = titleRow.createSpan({ cls: "pm-tm-status-dot" });
    this.statusDot.style.setProperty("--pm-dot-color", STATUS_COLORS[this.status]);
    const titleInput = titleRow.createEl("input", { cls: "pm-tm-title-input", placeholder: "Task title..." });
    titleInput.type = "text";
    if (isEdit) titleInput.value = this.opts.task.title;
    else titleInput.autofocus = true;

    if (isEdit) {
      const gotoBtn = titleRow.createEl("button", { cls: "pm-tm-goto-btn", title: "Open note" });
      setIcon(gotoBtn, "arrow-up-right");
      gotoBtn.addEventListener("click", () => {
        const filePath = (this.opts as EditTaskOptions).task.filePath;
        openNoteFile(this.app, filePath);
        this.close();
      });
    }

    // ── Description ───────────────────────────────────────────────────────────
    contentEl.createDiv({ cls: "pm-tm-section-label", text: "DESCRIPTION" });
    const descWrap = contentEl.createDiv({ cls: "pm-tm-desc-wrap" });
    const descInput = descWrap.createEl("textarea", { cls: "pm-tm-description", placeholder: "Add a description..." });
    this.attachLinkSuggest(descInput, descWrap);

    // In edit mode the textarea is filled by an async read. Track whether that
    // read has landed: submitting before it does would send description: "" and
    // blank the task's real body. `descriptionReady` gates the submit below.
    let descriptionReady = !isEdit;
    const descriptionLoad = isEdit
      ? this.loadDescription(descInput).then(() => { descriptionReady = true; })
      : Promise.resolve();

    // ── Fields ────────────────────────────────────────────────────────────────
    const fields = contentEl.createDiv({ cls: "pm-tm-fields" });

    // Status — dropdown
    buildFieldRow(fields, "Status", (cell) => {
      this.statusBtn = cell.createEl("button", { cls: "pm-tm-pill" });
      this.refreshStatusBtn();
      this.statusBtn.addEventListener("click", () => {
        openDropdown(
          this.statusBtn,
          STATUSES.map((s) => ({
            label: STATUS_LABELS[s],
            color: STATUS_COLORS[s],
            selected: s === this.status,
            onSelect: () => { this.status = s; this.statusDot.style.setProperty("--pm-dot-color", STATUS_COLORS[s]); this.refreshStatusBtn(); },
          })),
        );
      });
    });

    // Priority — dropdown
    buildFieldRow(fields, "Priority", (cell) => {
      const wrap = cell.createSpan({ cls: "pm-tm-priority-wrap" });
      this.priorityDot = wrap.createSpan({ cls: "pm-tm-priority-dot" });
      this.priorityBtn = wrap.createSpan({ cls: "pm-tm-priority-label" });
      this.refreshPriorityBtn();
      wrap.addEventListener("click", () => {
        openDropdown(
          wrap,
          PRIORITIES.map((p) => ({
            label: PRIORITY_LABELS[p],
            color: priorityDotColor(p),
            selected: p === (this.priority || Priority.None),
            onSelect: () => { this.priority = p; this.refreshPriorityBtn(); },
          })),
        );
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
    const startInput = this.buildDateRow(fields, "Start");
    const dueInput = this.buildDateRow(fields, "Due");

    if (isEdit) {
      // `<input type=date>` speaks `YYYY-MM-DD` — the one place these dates are text again.
      if (this.opts.task.start) startInput.value = formatDate(this.opts.task.start);
      if (this.opts.task.due) dueInput.value = formatDate(this.opts.task.due);
    }

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

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: "pm-tm-footer" });
    const submitBtn = footer.createEl("button", {
      cls: "pm-tm-submit mod-cta",
      text: isEdit ? "Save" : "Create task",
    });
    const cancelBtn = footer.createEl("button", { cls: "pm-tm-cancel", text: "Cancel" });

    // Hold Save disabled until the description has loaded, so a quick save can't
    // overwrite the existing body with an empty textarea. On a load failure keep
    // it disabled rather than risk that blanking — the note is still openable.
    if (isEdit) {
      submitBtn.disabled = true;
      descriptionLoad
        .then(() => { submitBtn.disabled = false; })
        .catch((e) => {
          console.error("pm-compass: failed to load task description", e);
          submitBtn.setText("Couldn't load — reopen");
          new Notice("Couldn't load the task; reopen it to edit safely.");
        });
    }

    submitBtn.addEventListener("click", () => {
      void (async () => {
        // Belt and braces: the button is disabled until the load lands, but never
        // commit an unloaded description even if that guard were bypassed.
        if (isEdit && !descriptionReady) return;
        const title = titleInput.value.trim();
        if (!title) {
          titleInput.addClass("pm-tm-error");
          titleInput.focus();
          return;
        }
        submitBtn.disabled = true;
        const resolvedType = this.hasParent ? "subtask" : this.type;
        const formData = {
          title,
          description: descInput.value,
          status: this.status,
          priority: this.priority,
          type: resolvedType,
          progress: this.progress,
          start: parseDate(startInput.value),
          due: parseDate(dueInput.value),
          tags: this.tags,
          dependencies: this.dependencies,
        };
        try {
          if (this.opts.mode === "edit") {
            await new ProjectTaskFile(this.app, this.opts.task.filePath).update(formData);
          } else {
            await createTaskFile(this.app, {
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
          submitBtn.disabled = false;
          submitBtn.setText("Error — retry");
          console.error("pm-compass: failed to save task", e);
        }
      })();
    });

    cancelBtn.addEventListener("click", () => this.close());
    titleInput.addEventListener("input", () => titleInput.removeClass("pm-tm-error"));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadDescription(textarea: HTMLTextAreaElement): Promise<void> {
    if (this.opts.mode !== "edit") return;
    textarea.value = await new ProjectTaskFile(this.app, this.opts.task.filePath).readDescription();
  }

  private attachLinkSuggest(textarea: HTMLTextAreaElement, wrap: HTMLElement): void {
    const suggestEl = wrap.createDiv({ cls: "pm-tm-link-suggest" });
    suggestEl.setCssStyles({ display: "none" });

    let suggestions: string[] = [];
    let selectedIdx = 0;

    const hide = () => { suggestEl.setCssStyles({ display: "none" }); suggestions = []; selectedIdx = 0; };

    const renderSuggestions = (query: string) => {
      suggestions = this.app.vault
        .getMarkdownFiles()
        .map((f) => f.basename)
        .filter((n) => n.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8);

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

  private buildDateRow(parent: HTMLElement, label: string): HTMLInputElement {
    let input!: HTMLInputElement;
    buildFieldRow(parent, label, (cell) => {
      input = cell.createEl("input");
      input.type = "date";
      input.addClass("pm-tm-date");
    });
    return input;
  }

  private refreshStatusBtn(): void {
    this.statusBtn.style.setProperty("--pm-pill-bg", STATUS_COLORS[this.status] + "33");
    this.statusBtn.style.setProperty("--pm-pill-color", STATUS_COLORS[this.status]);
    this.statusBtn.setText(STATUS_LABELS[this.status]);
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
    const selfId = this.opts.mode === "edit" ? this.opts.task.id : undefined;
    const myParentId = this.opts.mode === "edit" ? this.opts.task.parentId : this.opts.parentTask?.id;

    // Only tasks at the same level (same parentId) that would not create a cycle
    const available = this.opts.existingTasks.filter(
      (t) => t.parentId === myParentId && !this.dependencies.includes(t.id) && t.id !== selfId &&
        (selfId === undefined || isValidDependencyTarget(this.opts.existingTasks, t.id, selfId).valid),
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

export class ProjectModal extends Modal {
  private readonly opts: { project: Project; onSuccess: () => void };

  constructor(app: App, opts: { project: Project; onSuccess: () => void }) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    this.modalEl.addClass("pm-task-modal-wrap");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pm-task-modal");

    const { project } = this.opts;
    let colorValue = project.color ?? ""; // empty = no color set

    // ── Title row ─────────────────────────────────────────────────────────────
    const titleRow = contentEl.createDiv({ cls: "pm-tm-title-row" });
    const colorDot = titleRow.createSpan({ cls: "pm-tm-status-dot" });
    colorDot.style.setProperty("--pm-dot-color", colorValue || "#888888");
    const titleInput = titleRow.createEl("input", { cls: "pm-tm-title-input", placeholder: "Project title..." });
    titleInput.type = "text";
    titleInput.value = project.title;

    const gotoBtn = titleRow.createEl("button", { cls: "pm-tm-goto-btn", title: "Open note" });
    setIcon(gotoBtn, "arrow-up-right");
    gotoBtn.addEventListener("click", () => {
      openNoteFile(this.app, project.filePath);
      this.close();
    });

    // ── Fields ────────────────────────────────────────────────────────────────
    const fields = contentEl.createDiv({ cls: "pm-tm-fields" });

    // Color
    let colorInput!: HTMLInputElement;
    buildFieldRow(fields, "Color", (cell) => {
      colorInput = cell.createEl("input");
      colorInput.type = "color";
      colorInput.value = colorValue || "#888888";
      colorInput.addClass("pm-tm-color-input");
      colorInput.addEventListener("input", () => {
        colorValue = colorInput.value;
        colorDot.style.setProperty("--pm-dot-color", colorValue);
      });
      const clearBtn = cell.createEl("button", { cls: "pm-tm-clear-color-btn", text: "✕ none" });
      clearBtn.title = "Remove color";
      clearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        colorValue = "";
        colorInput.value = "#888888";
        colorDot.setCssProps({ "--pm-dot-color": "#888888" });
      });
    });

    // Icon
    let iconInput!: HTMLInputElement;
    buildFieldRow(fields, "Icon", (cell) => {
      iconInput = cell.createEl("input", { cls: "pm-tm-date" });
      iconInput.type = "text";
      iconInput.placeholder = "E.g. Folder-open or 🚀";
      if (project.icon) iconInput.value = project.icon;
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: "pm-tm-footer" });
    const submitBtn = footer.createEl("button", { cls: "pm-tm-submit mod-cta", text: "Save" });
    const cancelBtn = footer.createEl("button", { cls: "pm-tm-cancel", text: "Cancel" });

    submitBtn.addEventListener("click", () => {
      void (async () => {
        const title = titleInput.value.trim();
        if (!title) { titleInput.addClass("pm-tm-error"); titleInput.focus(); return; }
        submitBtn.disabled = true;
        try {
          await updateProjectFile(this.app, project.filePath, { title, color: colorValue, icon: iconInput.value.trim() });
          this.close();
          this.opts.onSuccess();
        } catch (e) {
          submitBtn.disabled = false;
          submitBtn.setText("Error — retry");
          console.error("pm-compass: failed to save project", e);
        }
      })();
    });

    cancelBtn.addEventListener("click", () => this.close());
    titleInput.addEventListener("input", () => titleInput.removeClass("pm-tm-error"));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** @deprecated use TaskModal */
export { TaskModal as NewTaskModal };
