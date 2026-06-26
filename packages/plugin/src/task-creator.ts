import { App, Modal, TFile, normalizePath } from "obsidian";
import type { Task, Project } from "@pm-compass/shared";

interface CreateTaskOptions {
  mode: "create";
  projectId: string;
  projectFilePath: string;
  parentId?: string;
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

const STATUSES = ["todo", "in-progress", "blocked", "review", "done", "cancelled"] as const;
const STATUS_LABELS: Record<string, string> = {
  "todo": "To Do",
  "in-progress": "In Progress",
  "blocked": "Blocked",
  "review": "Review",
  "done": "Done",
  "cancelled": "Cancelled",
};
const STATUS_COLORS: Record<string, string> = {
  "todo": "#6b7280",
  "in-progress": "#3b82f6",
  "blocked": "#ef4444",
  "review": "#8b5cf6",
  "done": "#22c55e",
  "cancelled": "#9ca3af",
};

const PRIORITIES = ["", "critical", "high", "medium", "low"] as const;
const PRIORITY_LABELS: Record<string, string> = {
  "": "None",
  "critical": "Critical",
  "high": "High",
  "medium": "Medium",
  "low": "Low",
};
const PRIORITY_COLORS: Record<string, string> = {
  "": "#6b7280",
  "critical": "#ef4444",
  "high": "#f97316",
  "medium": "#eab308",
  "low": "#22c55e",
};

// "subtask" is set automatically when there is a parent — not shown in the UI
const TYPES = ["task", "milestone"] as const;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

async function createTaskFile(
  app: App,
  opts: {
    projectId: string;
    projectFilePath: string;
    parentId?: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    type: string;
    progress: number;
    start: string;
    due: string;
    tags: string[];
    dependencies: string[];
  },
): Promise<void> {
  const tasksFolder = opts.projectFilePath.replace(/\.md$/, "_tasks");
  try {
    await app.vault.createFolder(normalizePath(tasksFolder));
  } catch {
    // folder already exists
  }

  const slug = slugify(opts.title) || "task";
  let filename = normalizePath(`${tasksFolder}/${slug}.md`);
  let counter = 2;
  while (app.vault.getAbstractFileByPath(filename)) {
    filename = normalizePath(`${tasksFolder}/${slug}-${counter}.md`);
    counter++;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const lines = buildFrontmatter({
    id,
    projectId: opts.projectId,
    parentId: opts.parentId,
    title: opts.title,
    status: opts.status,
    priority: opts.priority,
    type: opts.type,
    start: opts.start,
    due: opts.due,
    progress: opts.progress,
    dependencies: opts.dependencies,
    tags: opts.tags,
    createdAt: now,
    updatedAt: now,
  });
  if (opts.description.trim()) lines.push("", opts.description.trim());

  await app.vault.create(filename, lines.join("\n") + "\n");
}

async function updateTaskFile(
  app: App,
  filePath: string,
  data: {
    title: string;
    description: string;
    status: string;
    priority: string;
    type: string;
    progress: number;
    start: string;
    due: string;
    tags: string[];
    dependencies: string[];
  },
): Promise<void> {
  const file = app.vault.getFileByPath(filePath);
  if (!(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);

  const rawBefore = await app.vault.read(file);
  const bodyMatch = rawBefore.match(/^---[\s\S]*?\n---\n?([\s\S]*)$/);
  const currentBody = bodyMatch ? bodyMatch[1].trim() : "";
  const newBody = data.description.trim();

  await app.fileManager.processFrontMatter(file, (fm) => {
    fm["title"] = data.title;
    fm["status"] = data.status;
    if (data.priority) { fm["priority"] = data.priority; } else { delete fm["priority"]; }
    fm["type"] = data.type;
    if (data.start) { fm["start"] = data.start; } else { delete fm["start"]; }
    if (data.due) { fm["due"] = data.due; } else { delete fm["due"]; }
    if (data.progress > 0) { fm["progress"] = data.progress; } else { delete fm["progress"]; }
    fm["dependencies"] = data.dependencies;
    if (data.tags.length > 0) { fm["tags"] = data.tags; } else { delete fm["tags"]; }
    fm["updatedAt"] = new Date().toISOString();
  });

  if (currentBody !== newBody) {
    const rawAfter = await app.vault.read(file);
    const fmBlock = rawAfter.match(/^---[\s\S]*?\n---\n?/);
    if (fmBlock) {
      const body = newBody ? "\n" + newBody + "\n" : "";
      await app.vault.modify(file, fmBlock[0] + body);
    }
  }
}

function buildFrontmatter(fields: {
  id: string;
  projectId: string;
  parentId?: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  start: string;
  due: string;
  progress: number;
  dependencies: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}): string[] {
  const lines = ["---", "pm-task: true", `id: "${fields.id}"`, `title: "${fields.title.replace(/"/g, '\\"')}"`];
  lines.push(`projectId: "${fields.projectId}"`);
  if (fields.parentId) lines.push(`parentId: "${fields.parentId}"`);
  lines.push(`status: ${fields.status}`);
  if (fields.priority) lines.push(`priority: ${fields.priority}`);
  lines.push(`type: ${fields.type}`);
  if (fields.start) lines.push(`start: "${fields.start}"`);
  if (fields.due) lines.push(`due: "${fields.due}"`);
  if (fields.progress > 0) lines.push(`progress: ${fields.progress}`);
  if (fields.dependencies.length > 0) {
    lines.push(`dependencies: [${fields.dependencies.map((d) => `"${d}"`).join(", ")}]`);
  } else {
    lines.push("dependencies: []");
  }
  lines.push("subtaskIds: []");
  if (fields.tags.length > 0) {
    lines.push(`tags: [${fields.tags.map((t) => `"${t}"`).join(", ")}]`);
  }
  lines.push(`createdAt: "${fields.createdAt}"`);
  lines.push(`updatedAt: "${fields.updatedAt}"`);
  lines.push("---");
  return lines;
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
  const file = app.vault.getFileByPath(filePath);
  if (!(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm["title"] = data.title;
    if (data.color) { fm["color"] = data.color; } else { delete fm["color"]; }
    if (data.icon) { fm["icon"] = data.icon; } else { delete fm["icon"]; }
    fm["updatedAt"] = new Date().toISOString();
  });
}

/** Show a small dropdown anchored to `anchor` with generic items. Returns a cleanup fn. */
function openDropdown(
  anchor: HTMLElement,
  items: { label: string; color?: string; onSelect: () => void }[],
): void {
  const picker = createDiv({ cls: "pm-tm-dropdown" });
  for (const item of items) {
    const el = picker.createDiv({ cls: "pm-tm-dropdown-item" });
    if (item.color) {
      const dot = el.createSpan({ cls: "pm-tm-dropdown-dot" });
      dot.style.background = item.color;
    }
    el.createSpan({ text: item.label });
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      item.onSelect();
      picker.remove();
      document.removeEventListener("mousedown", close);
    });
  }
  anchor.after(picker);

  const close = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node)) {
      picker.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  // Delay so the triggering click doesn't immediately close it
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

export class TaskModal extends Modal {
  private readonly opts: TaskModalOptions;
  private readonly hasParent: boolean;
  private status: string;
  private priority: string;
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
      this.priority = t.priority ?? "";
      // Normalize legacy "subtask" type to "task" for the UI selector
      this.type = (t.type === "subtask" || !t.type) ? "task" : t.type;
      this.progress = t.progress ?? 0;
      this.tags = [...(t.tags ?? [])];
      this.dependencies = [...t.dependencies];
    } else {
      this.hasParent = !!opts.parentId;
      this.status = "todo";
      this.priority = "";
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
    this.statusDot.style.background = STATUS_COLORS[this.status];
    const titleInput = titleRow.createEl("input", { cls: "pm-tm-title-input", placeholder: "Task title..." });
    titleInput.type = "text";
    if (isEdit) titleInput.value = this.opts.task.title;
    else titleInput.autofocus = true;

    // ── Description ───────────────────────────────────────────────────────────
    contentEl.createDiv({ cls: "pm-tm-section-label", text: "DESCRIPTION" });
    const descWrap = contentEl.createDiv({ cls: "pm-tm-desc-wrap" });
    const descInput = descWrap.createEl("textarea", { cls: "pm-tm-description", placeholder: "Add a description..." });
    this.attachLinkSuggest(descInput, descWrap);

    if (isEdit) void this.loadDescription(descInput);

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
            onSelect: () => { this.status = s; this.statusDot.style.background = STATUS_COLORS[s]; this.refreshStatusBtn(); },
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
      wrap.style.cursor = "pointer";
      wrap.addEventListener("click", () => {
        openDropdown(
          wrap,
          PRIORITIES.map((p) => ({
            label: PRIORITY_LABELS[p],
            color: PRIORITY_COLORS[p],
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
      if (this.opts.task.start) startInput.value = this.opts.task.start;
      if (this.opts.task.due) dueInput.value = this.opts.task.due;
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
      const addBtn = cell.createEl("button", { cls: "pm-tm-add-chip", text: "+ Add dependency" });
      addBtn.addEventListener("click", () => this.openDepPicker(addBtn));
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: "pm-tm-footer" });
    const submitBtn = footer.createEl("button", {
      cls: "pm-tm-submit mod-cta",
      text: isEdit ? "Save" : "Create task",
    });
    const cancelBtn = footer.createEl("button", { cls: "pm-tm-cancel", text: "Cancel" });

    submitBtn.addEventListener("click", async () => {
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
        start: startInput.value,
        due: dueInput.value,
        tags: this.tags,
        dependencies: this.dependencies,
      };
      try {
        if (this.opts.mode === "edit") {
          await updateTaskFile(this.app, this.opts.task.filePath, formData);
        } else {
          await createTaskFile(this.app, {
            projectId: this.opts.projectId,
            projectFilePath: this.opts.projectFilePath,
            parentId: this.opts.parentId,
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
    });

    cancelBtn.addEventListener("click", () => this.close());
    titleInput.addEventListener("input", () => titleInput.removeClass("pm-tm-error"));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadDescription(textarea: HTMLTextAreaElement): Promise<void> {
    if (this.opts.mode !== "edit") return;
    const file = this.app.vault.getFileByPath(this.opts.task.filePath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n?([\s\S]*)$/);
    if (bodyMatch) textarea.value = bodyMatch[1].trim();
  }

  private attachLinkSuggest(textarea: HTMLTextAreaElement, wrap: HTMLElement): void {
    const suggestEl = wrap.createDiv({ cls: "pm-tm-link-suggest" });
    suggestEl.style.display = "none";

    let suggestions: string[] = [];
    let selectedIdx = 0;

    const hide = () => { suggestEl.style.display = "none"; suggestions = []; selectedIdx = 0; };

    const renderSuggestions = (query: string) => {
      suggestions = this.app.vault
        .getMarkdownFiles()
        .map((f) => f.basename)
        .filter((n) => n.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8);

      if (suggestions.length === 0) { hide(); return; }

      selectedIdx = 0;
      suggestEl.empty();
      suggestEl.style.display = "block";
      suggestions.forEach((name, i) => {
        const item = suggestEl.createDiv({ cls: "pm-tm-link-item" + (i === 0 ? " is-selected" : ""), text: name });
        item.addEventListener("mousedown", (e) => { e.preventDefault(); insert(name); });
      });
    };

    const insert = (name: string) => {
      const cursor = textarea.selectionStart;
      const before = textarea.value.slice(0, cursor).replace(/\[\[([^\[\]]*)$/, "");
      const after = textarea.value.slice(cursor);
      textarea.value = before + `[[${name}]]` + after;
      textarea.selectionStart = textarea.selectionEnd = before.length + name.length + 4;
      hide();
    };

    textarea.addEventListener("input", () => {
      const before = textarea.value.slice(0, textarea.selectionStart);
      const match = before.match(/\[\[([^\[\]]*)$/);
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

    textarea.addEventListener("blur", () => { setTimeout(hide, 150); });
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
    this.statusBtn.style.background = STATUS_COLORS[this.status] + "33";
    this.statusBtn.style.color = STATUS_COLORS[this.status];
    this.statusBtn.setText(STATUS_LABELS[this.status]);
  }

  private refreshPriorityBtn(): void {
    this.priorityDot.style.background = PRIORITY_COLORS[this.priority];
    this.priorityBtn.setText(PRIORITY_LABELS[this.priority]);
  }

  private promptAddTag(anchor: HTMLElement): void {
    const input = createEl("input");
    input.type = "text";
    input.placeholder = "tag name";
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
    const myParentId = this.opts.mode === "edit" ? this.opts.task.parentId : this.opts.parentId;

    // Only tasks at the same level (same parentId)
    const available = this.opts.existingTasks.filter(
      (t) => t.parentId === myParentId && !this.dependencies.includes(t.id) && t.id !== selfId,
    );
    if (available.length === 0) return;

    const picker = createDiv({ cls: "pm-tm-dep-picker" });
    for (const task of available) {
      const item = picker.createDiv({ cls: "pm-tm-dep-item", text: task.title });
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.dependencies.push(task.id);
        this.renderChip(this.depsContainer, task.title, () => { this.dependencies = this.dependencies.filter((d) => d !== task.id); });
        picker.remove();
      });
    }
    anchor.after(picker);
    const close = (e: MouseEvent) => {
      if (!picker.contains(e.target as Node)) { picker.remove(); document.removeEventListener("mousedown", close); }
    };
    document.addEventListener("mousedown", close);
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
    colorDot.style.background = colorValue || "#888888";
    const titleInput = titleRow.createEl("input", { cls: "pm-tm-title-input", placeholder: "Project title..." });
    titleInput.type = "text";
    titleInput.value = project.title;

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
        colorDot.style.background = colorValue;
      });
      const clearBtn = cell.createEl("button", { text: "✕ none" });
      clearBtn.title = "Remove color";
      clearBtn.style.cssText = "background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:11px;padding:2px 4px;";
      clearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        colorValue = "";
        colorDot.style.background = "#888888";
      });
    });

    // Icon
    let iconInput!: HTMLInputElement;
    buildFieldRow(fields, "Icon", (cell) => {
      iconInput = cell.createEl("input", { cls: "pm-tm-date" });
      iconInput.type = "text";
      iconInput.placeholder = "e.g. 🚀 or folder-open";
      if (project.icon) iconInput.value = project.icon;
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: "pm-tm-footer" });
    const submitBtn = footer.createEl("button", { cls: "pm-tm-submit mod-cta", text: "Save" });
    const cancelBtn = footer.createEl("button", { cls: "pm-tm-cancel", text: "Cancel" });

    submitBtn.addEventListener("click", async () => {
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
