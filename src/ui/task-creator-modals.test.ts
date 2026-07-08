// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;

  type CreateElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string>; placeholder?: string; title?: string };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
    if (opts?.placeholder) (el as HTMLInputElement).placeholder = opts.placeholder;
    if (opts?.title) el.setAttribute("title", opts.title);
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    this.appendChild(el);
    return el;
  }

  htmlProto.createEl = createElOn;
  htmlProto.createDiv = function (this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("div", opts);
  };
  htmlProto.createSpan = function (this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("span", opts);
  };
  htmlProto.addClass = function (this: HTMLElement, cls: string) {
    this.classList.add(cls);
  };
  htmlProto.removeClass = function (this: HTMLElement, cls: string) {
    this.classList.remove(cls);
  };
  htmlProto.toggleClass = function (this: HTMLElement, cls: string, force?: boolean) {
    this.classList.toggle(cls, force);
  };
  htmlProto.setText = function (this: HTMLElement, text: string) {
    this.textContent = text;
  };
  htmlProto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeDocument = document;

  // Global createDiv/createEl used by openDropdown (called as bare functions, not methods)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).createDiv = function (opts?: CreateElOpts) {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    document.body.appendChild(el);
    return el;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).createEl = function (tag: string, opts?: CreateElOpts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    document.body.appendChild(el);
    return el;
  };
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  MockModal,
  mockPTFUpdate,
  mockPTFReadDescription,
  mockPTFCreate,
  mockPFUpdate,
} = vi.hoisted(() => {
  class MockModal {
    app: unknown;
    contentEl: HTMLElement;
    modalEl: HTMLElement;
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement("div");
      this.modalEl = document.createElement("div");
      this.modalEl.appendChild(this.contentEl);
      document.body.appendChild(this.modalEl);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    open() { (this as any).onOpen?.(); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    close() { (this as any).onClose?.(); }
  }
  return {
    MockModal,
    mockPTFUpdate: vi.fn().mockResolvedValue(undefined),
    mockPTFReadDescription: vi.fn().mockResolvedValue(""),
    mockPTFCreate: vi.fn().mockResolvedValue({ id: "abcdef1234567890", file: {} }),
    mockPFUpdate: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("obsidian", () => ({
  App: class {},
  Modal: MockModal,
  TFile: class {},
  normalizePath: (p: string) => p,
  setIcon: () => {},
}));

vi.mock("../model/project-task-file", () => ({
  ProjectTaskFile: class {
    constructor(public app: unknown, public filePath: string) {}
    update(...args: unknown[]) { return mockPTFUpdate(this.filePath, ...args); }
    readDescription() { return mockPTFReadDescription(this.filePath); }
    static create(...args: unknown[]) { return mockPTFCreate(...args); }
  },
  generateId: vi.fn(() => "abcdef1234567890"),
}));

vi.mock("../model/project-file", () => ({
  ProjectFile: class {
    constructor(public app: unknown, public filePath: string) {}
    update(...args: unknown[]) { return mockPFUpdate(this.filePath, ...args); }
  },
}));

import { TaskModal, ProjectModal, ConfirmModal, openDropdown, openNoteFile } from "./task-creator";
import type { Task, Project } from "../model/shared";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    title: "A project",
    filePath: `projects/${overrides.id}.md`,
    tasks: [],
    ...overrides,
  };
}

const APP = {} as never;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  mockPTFUpdate.mockResolvedValue(undefined);
  mockPTFReadDescription.mockResolvedValue("");
  mockPTFCreate.mockResolvedValue({ id: "abcdef1234567890", file: {} });
  mockPFUpdate.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// ConfirmModal
// ---------------------------------------------------------------------------

describe("ConfirmModal", () => {
  it("renders the message and confirm/cancel buttons", () => {
    const modal = new ConfirmModal(APP, "Delete this?", () => {});
    modal.open();
    expect(modal.contentEl.querySelector(".pm-confirm-message")?.textContent).toBe("Delete this?");
    const buttons = modal.contentEl.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
  });

  it("calls onConfirm and closes when Delete is clicked", () => {
    const onConfirm = vi.fn();
    const modal = new ConfirmModal(APP, "Delete this?", onConfirm);
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();
    const confirmBtn = modal.contentEl.querySelector(".mod-warning") as HTMLElement;
    confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalled();
  });

  it("does not call onConfirm when Cancel is clicked", () => {
    const onConfirm = vi.fn();
    const modal = new ConfirmModal(APP, "Delete this?", onConfirm);
    modal.open();
    const cancelBtn = modal.contentEl.querySelector("button") as HTMLElement;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("empties contentEl on close", () => {
    const modal = new ConfirmModal(APP, "Delete this?", () => {});
    modal.open();
    modal.close();
    expect(modal.contentEl.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TaskModal — create mode
// ---------------------------------------------------------------------------

describe("TaskModal — create mode", () => {
  function makeModal(overrides: Partial<{ parentTask: Task; existingTasks: Task[] }> = {}) {
    const onSuccess = vi.fn();
    const modal = new TaskModal(APP, {
      mode: "create",
      projectId: "proj-1",
      projectFilePath: "projects/proj-1.md",
      projectTitle: "Alpha",
      existingTasks: overrides.existingTasks ?? [],
      parentTask: overrides.parentTask,
      onSuccess,
    });
    modal.open();
    return { modal, onSuccess };
  }

  it("shows the type selector for a top-level task (no parent)", () => {
    const { modal } = makeModal();
    expect(modal.contentEl.querySelector(".pm-tm-segmented")).not.toBeNull();
  });

  it("omits the type selector when there is a parent task", () => {
    const { modal } = makeModal({ parentTask: makeTask({ id: "parent" }) });
    expect(modal.contentEl.querySelector(".pm-tm-segmented")).toBeNull();
  });

  it("does not render the 'Open note' button in create mode", () => {
    const { modal } = makeModal();
    expect(modal.contentEl.querySelector(".pm-tm-goto-btn")).toBeNull();
  });

  it("does not attempt to load a description", () => {
    makeModal();
    expect(mockPTFReadDescription).not.toHaveBeenCalled();
  });

  it("shows an error and refuses to submit when the title is empty", async () => {
    const { modal, onSuccess } = makeModal();
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    expect(titleInput.classList.contains("pm-tm-error")).toBe(true);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mockPTFCreate).not.toHaveBeenCalled();
  });

  it("clears the error class once the user starts typing again", () => {
    const { modal } = makeModal();
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    expect(titleInput.classList.contains("pm-tm-error")).toBe(true);
    titleInput.dispatchEvent(new Event("input"));
    expect(titleInput.classList.contains("pm-tm-error")).toBe(false);
  });

  it("creates the task file and calls onSuccess on valid submit", async () => {
    const { modal, onSuccess } = makeModal();
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "New task";
    const closeSpy = vi.spyOn(modal, "close");
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFCreate).toHaveBeenCalledOnce();
    const callArg = mockPTFCreate.mock.calls[0][1];
    expect(callArg.title).toBe("New task");
    expect(callArg.type).toBe("task");
    expect(closeSpy).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it("resolves the task type to 'subtask' when there is a parent task", async () => {
    const parent = makeTask({ id: "parent" });
    const { modal } = makeModal({ parentTask: parent });
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "Child task";
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFCreate.mock.calls[0][1].type).toBe("subtask");
    expect(mockPTFCreate.mock.calls[0][1].parentTask).toBe(parent);
  });

  it("shows a retry state and re-enables the button when the save fails", async () => {
    mockPTFCreate.mockRejectedValueOnce(new Error("disk full"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { modal, onSuccess } = makeModal();
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "New task";
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLButtonElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe("Error — retry");
    expect(onSuccess).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("cancels without saving", () => {
    const { modal, onSuccess } = makeModal();
    const closeSpy = vi.spyOn(modal, "close");
    const cancelBtn = modal.contentEl.querySelector(".pm-tm-cancel") as HTMLElement;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mockPTFCreate).not.toHaveBeenCalled();
  });

  it("empties contentEl on close", () => {
    const { modal } = makeModal();
    modal.close();
    expect(modal.contentEl.innerHTML).toBe("");
  });

  it("loadDescription() is a no-op outside edit mode (type-safety guard)", async () => {
    const { modal } = makeModal();
    const textarea = document.createElement("textarea");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (modal as any).loadDescription(textarea);
    expect(textarea.value).toBe("");
    expect(mockPTFReadDescription).not.toHaveBeenCalled();
  });

  it("opens a dependency picker scoped to top-level tasks when there is no parent task", () => {
    const topLevel = makeTask({ id: "top1", title: "Top level" });
    const { modal } = makeModal({ existingTasks: [topLevel] });
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dep-picker")?.textContent).toContain("Top level");
  });

  it("opens a dependency picker scoped to the parent's own children when creating a subtask", () => {
    const parent = makeTask({ id: "parent1" });
    const siblingSubtask = makeTask({ id: "sub1", title: "Sibling subtask", parentId: "parent1" });
    const unrelated = makeTask({ id: "other1", title: "Unrelated top-level" });
    const { modal } = makeModal({ parentTask: parent, existingTasks: [siblingSubtask, unrelated] });
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const picker = document.querySelector(".pm-tm-dep-picker")!;
    expect(picker.textContent).toContain("Sibling subtask");
    expect(picker.textContent).not.toContain("Unrelated top-level");
  });
});

// ---------------------------------------------------------------------------
// TaskModal — edit mode
// ---------------------------------------------------------------------------

describe("TaskModal — edit mode", () => {
  function makeModal(taskOverrides: Partial<Task> & { id: string } = { id: "t1" }, existingTasks: Task[] = []) {
    const task = makeTask(taskOverrides);
    const onSuccess = vi.fn();
    const modal = new TaskModal(APP, { mode: "edit", task, existingTasks, onSuccess });
    modal.open();
    return { modal, task, onSuccess };
  }

  it("pre-fills the title from the task", () => {
    const { modal } = makeModal({ id: "t1", title: "Existing title" });
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    expect(titleInput.value).toBe("Existing title");
  });

  it("normalizes a legacy 'subtask' type to 'task' for the type selector", () => {
    const { modal } = makeModal({ id: "t1", type: "subtask" });
    const activeBtn = modal.contentEl.querySelector(".pm-tm-seg-btn.is-active");
    expect(activeBtn?.textContent).toBe("Task");
  });

  it("defaults an unset type to 'task'", () => {
    const { modal } = makeModal({ id: "t1", type: undefined });
    const activeBtn = modal.contentEl.querySelector(".pm-tm-seg-btn.is-active");
    expect(activeBtn?.textContent).toBe("Task");
  });

  it("shows the milestone type as active when set", () => {
    const { modal } = makeModal({ id: "t1", type: "milestone" });
    const activeBtn = modal.contentEl.querySelector(".pm-tm-seg-btn.is-active");
    expect(activeBtn?.textContent).toBe("Milestone");
  });

  it("hides the type selector for a task that has a parentId", () => {
    const { modal } = makeModal({ id: "t1", parentId: "p1" });
    expect(modal.contentEl.querySelector(".pm-tm-segmented")).toBeNull();
  });

  it("pre-fills start/due dates when set", () => {
    const { modal } = makeModal({ id: "t1", start: "2026-07-01", due: "2026-07-15" });
    const dateInputs = modal.contentEl.querySelectorAll("input[type='date']");
    expect((dateInputs[0] as HTMLInputElement).value).toBe("2026-07-01");
    expect((dateInputs[1] as HTMLInputElement).value).toBe("2026-07-15");
  });

  it("leaves start/due dates empty when unset", () => {
    const { modal } = makeModal({ id: "t1" });
    const dateInputs = modal.contentEl.querySelectorAll("input[type='date']");
    expect((dateInputs[0] as HTMLInputElement).value).toBe("");
  });

  it("renders a chip for each existing tag", () => {
    const { modal } = makeModal({ id: "t1", tags: ["alpha", "beta"] });
    const chips = modal.contentEl.querySelectorAll(".pm-tm-chip");
    expect(chips).toHaveLength(2);
  });

  it("renders a dependency chip using the dependent task's title", () => {
    const dep = makeTask({ id: "dep1", title: "Dependency task" });
    const { modal } = makeModal({ id: "t1", dependencies: ["dep1"] }, [dep]);
    expect(modal.contentEl.querySelector(".pm-tm-chip")?.textContent).toContain("Dependency task");
  });

  it("falls back to the raw id for a dependency chip when the task can't be found", () => {
    const { modal } = makeModal({ id: "t1", dependencies: ["missing-id"] }, []);
    expect(modal.contentEl.querySelector(".pm-tm-chip")?.textContent).toContain("missing-id");
  });

  it("removes a tag chip and updates internal state on ×", () => {
    const { modal } = makeModal({ id: "t1", tags: ["alpha"] });
    const chip = modal.contentEl.querySelector(".pm-tm-chip") as HTMLElement;
    (chip.querySelector(".pm-tm-chip-x") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(modal.contentEl.querySelector(".pm-tm-chip")).toBeNull();
  });

  it("shows the 'Open note' button and opens the file, closing the modal", () => {
    const { modal } = makeModal({ id: "t1", filePath: "tasks/t1.md" });
    const closeSpy = vi.spyOn(modal, "close");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (modal as any).app = { vault: { getAbstractFileByPath: () => null } };
    const gotoBtn = modal.contentEl.querySelector(".pm-tm-goto-btn") as HTMLElement;
    gotoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
  });

  it("loads the existing description asynchronously", async () => {
    mockPTFReadDescription.mockResolvedValueOnce("Existing description");
    const { modal } = makeModal({ id: "t1" });
    await Promise.resolve();
    await Promise.resolve();
    const textarea = modal.contentEl.querySelector(".pm-tm-description") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Existing description");
  });

  it("saves via ProjectTaskFile.update and calls onSuccess on valid submit", async () => {
    const { modal, onSuccess } = makeModal({ id: "t1", filePath: "tasks/t1.md" });
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFUpdate).toHaveBeenCalledWith("tasks/t1.md", expect.objectContaining({ title: "A task" }));
    expect(onSuccess).toHaveBeenCalled();
  });

  it("changes status via the status dropdown", () => {
    const { modal } = makeModal({ id: "t1" });
    const statusBtn = modal.contentEl.querySelector(".pm-tm-pill") as HTMLElement;
    statusBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const dropdownItem = document.querySelector(".pm-tm-dropdown-item") as HTMLElement;
    dropdownItem.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(statusBtn.textContent).toBe(dropdownItem.textContent);
  });

  it("changes priority via the priority dropdown", () => {
    const { modal } = makeModal({ id: "t1" });
    const priorityWrap = modal.contentEl.querySelector(".pm-tm-priority-wrap") as HTMLElement;
    priorityWrap.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const items = document.querySelectorAll(".pm-tm-dropdown-item");
    (items[1] as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const priorityLabel = modal.contentEl.querySelector(".pm-tm-priority-label") as HTMLElement;
    expect(priorityLabel.textContent).not.toBe("");
  });

  it("switches the active type button on click", () => {
    const { modal } = makeModal({ id: "t1" });
    const buttons = modal.contentEl.querySelectorAll(".pm-tm-seg-btn");
    (buttons[1] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(buttons[1].classList.contains("is-active")).toBe(true);
    expect(buttons[0].classList.contains("is-active")).toBe(false);
  });

  it("updates the progress label as the slider moves", () => {
    const { modal } = makeModal({ id: "t1", progress: 20 });
    const slider = modal.contentEl.querySelector(".pm-tm-slider") as HTMLInputElement;
    slider.value = "75";
    slider.dispatchEvent(new Event("input"));
    const label = modal.contentEl.querySelector(".pm-tm-progress-label") as HTMLElement;
    expect(label.textContent).toBe("75%");
  });

  it("adds a new tag via the inline input on Enter", () => {
    const { modal } = makeModal({ id: "t1" });
    const addBtn = modal.contentEl.querySelector(".pm-tm-add-chip") as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = modal.contentEl.querySelector(".pm-tm-inline-input") as HTMLInputElement;
    input.value = "new-tag";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(modal.contentEl.textContent).toContain("new-tag");
  });

  it("does not add a duplicate tag", () => {
    const { modal } = makeModal({ id: "t1", tags: ["alpha"] });
    const addBtn = modal.contentEl.querySelector(".pm-tm-add-chip") as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = modal.contentEl.querySelector(".pm-tm-inline-input") as HTMLInputElement;
    input.value = "alpha";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(modal.contentEl.querySelectorAll(".pm-tm-chip")).toHaveLength(1);
  });

  it("does not add a blank tag", () => {
    const { modal } = makeModal({ id: "t1" });
    const addBtn = modal.contentEl.querySelector(".pm-tm-add-chip") as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = modal.contentEl.querySelector(".pm-tm-inline-input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(modal.contentEl.querySelectorAll(".pm-tm-chip")).toHaveLength(0);
  });

  it("cancels the inline tag input on Escape without adding a tag", () => {
    const { modal } = makeModal({ id: "t1" });
    const addBtn = modal.contentEl.querySelector(".pm-tm-add-chip") as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = modal.contentEl.querySelector(".pm-tm-inline-input") as HTMLInputElement;
    input.value = "escaped-tag";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(modal.contentEl.textContent).not.toContain("escaped-tag");
  });

  it("commits the tag on blur", () => {
    const { modal } = makeModal({ id: "t1" });
    const addBtn = modal.contentEl.querySelector(".pm-tm-add-chip") as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = modal.contentEl.querySelector(".pm-tm-inline-input") as HTMLInputElement;
    input.value = "blurred-tag";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(modal.contentEl.textContent).toContain("blurred-tag");
  });

  it("removes a dependency chip and updates internal state on ×", () => {
    const dep = makeTask({ id: "dep1", title: "Dependency task" });
    const { modal } = makeModal({ id: "t1", dependencies: ["dep1"] }, [dep]);
    const chip = modal.contentEl.querySelectorAll(".pm-tm-chip-row")[1].querySelector(".pm-tm-chip") as HTMLElement;
    (chip.querySelector(".pm-tm-chip-x") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(modal.contentEl.querySelectorAll(".pm-tm-chip-row")[1].querySelector(".pm-tm-chip")).toBeNull();
  });

  it("opens a dependency picker listing same-level, non-cyclical, not-yet-added tasks", () => {
    const self = makeTask({ id: "t1" });
    const sibling = makeTask({ id: "sib1", title: "Sibling task" });
    const { modal } = makeModal({ id: "t1" }, [self, sibling]);
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const picker = document.querySelector(".pm-tm-dep-picker");
    expect(picker?.textContent).toContain("Sibling task");
  });

  it("does nothing when the dependency picker has no available candidates", () => {
    const { modal } = makeModal({ id: "t1" }, []);
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dep-picker")).toBeNull();
  });

  it("excludes tasks already listed as dependencies from the picker", () => {
    const self = makeTask({ id: "t1" });
    const dep = makeTask({ id: "dep1", title: "Already added" });
    const other = makeTask({ id: "other1", title: "Available" });
    const { modal } = makeModal({ id: "t1", dependencies: ["dep1"] }, [self, dep, other]);
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const picker = document.querySelector(".pm-tm-dep-picker")!;
    expect(picker.textContent).toContain("Available");
    expect(picker.textContent).not.toContain("Already added");
  });

  it("excludes tasks at a different hierarchy level from the picker", () => {
    const self = makeTask({ id: "t1" });
    const sibling = makeTask({ id: "sib1", title: "Sibling", parentId: "other-parent" });
    const { modal } = makeModal({ id: "t1" }, [self, sibling]);
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dep-picker")).toBeNull();
  });

  it("adds a dependency from the picker", () => {
    const self = makeTask({ id: "t1" });
    const sibling = makeTask({ id: "sib1", title: "Sibling task" });
    const { modal } = makeModal({ id: "t1" }, [self, sibling]);
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const item = document.querySelector(".pm-tm-dep-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dep-picker")).toBeNull();
    expect(modal.contentEl.querySelectorAll(".pm-tm-chip-row")[1].textContent).toContain("Sibling task");
  });
});

// ---------------------------------------------------------------------------
// TaskModal — description link-suggest (wikilink autocomplete)
// ---------------------------------------------------------------------------

describe("TaskModal — description link-suggest", () => {
  function makeModal(markdownFiles: { basename: string }[] = []) {
    const app = { vault: { getMarkdownFiles: () => markdownFiles } };
    const onSuccess = vi.fn();
    const modal = new TaskModal(app as never, {
      mode: "create",
      projectId: "proj-1",
      projectFilePath: "projects/proj-1.md",
      projectTitle: "Alpha",
      existingTasks: [],
      onSuccess,
    });
    modal.open();
    return { modal };
  }

  function textarea(modal: TaskModal): HTMLTextAreaElement {
    return modal.contentEl.querySelector(".pm-tm-description") as HTMLTextAreaElement;
  }

  it("shows matching suggestions when typing after [[", () => {
    const { modal } = makeModal([{ basename: "Alpha Project" }, { basename: "Beta Project" }]);
    const ta = textarea(modal);
    ta.value = "See [[Alpha";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    const items = modal.contentEl.querySelectorAll(".pm-tm-link-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe("Alpha Project");
  });

  it("hides the suggestion list when there is no [[ context", () => {
    const { modal } = makeModal([{ basename: "Alpha Project" }]);
    const ta = textarea(modal);
    ta.value = "no link here";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    const suggestEl = modal.contentEl.querySelector(".pm-tm-link-suggest") as HTMLElement;
    expect(suggestEl.style.display).toBe("none");
  });

  it("hides the suggestion list when nothing matches the query", () => {
    const { modal } = makeModal([{ basename: "Alpha Project" }]);
    const ta = textarea(modal);
    ta.value = "[[zzz";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    const suggestEl = modal.contentEl.querySelector(".pm-tm-link-suggest") as HTMLElement;
    expect(suggestEl.style.display).toBe("none");
  });

  it("inserts the selected suggestion on mousedown, replacing the partial query", () => {
    const { modal } = makeModal([{ basename: "Alpha Project" }]);
    const ta = textarea(modal);
    ta.value = "See [[Alp";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    const item = modal.contentEl.querySelector(".pm-tm-link-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(ta.value).toBe("See [[Alpha Project]]");
  });

  it("navigates the suggestion list with ArrowDown/ArrowUp and wraps around", () => {
    const { modal } = makeModal([{ basename: "Alpha" }, { basename: "Alphabet" }]);
    const ta = textarea(modal);
    ta.value = "[[Alph";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    let items = modal.contentEl.querySelectorAll(".pm-tm-link-item");
    expect(items[1].classList.contains("is-selected")).toBe(true);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    items = modal.contentEl.querySelectorAll(".pm-tm-link-item");
    expect(items[0].classList.contains("is-selected")).toBe(true);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    items = modal.contentEl.querySelectorAll(".pm-tm-link-item");
    expect(items[1].classList.contains("is-selected")).toBe(true);
  });

  it("ignores ArrowDown/ArrowUp/Enter/Escape when the suggestion list is hidden", () => {
    const { modal } = makeModal([{ basename: "Alpha" }]);
    const ta = textarea(modal);
    ta.value = "no link";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    expect(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }))).not.toThrow();
  });

  it("inserts the selected suggestion on Enter", () => {
    const { modal } = makeModal([{ basename: "Alpha" }]);
    const ta = textarea(modal);
    ta.value = "[[Alp";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(ta.value).toBe("[[Alpha]]");
  });

  it("does nothing on Enter when there are no suggestions", () => {
    const { modal } = makeModal([]);
    const ta = textarea(modal);
    ta.value = "[[zzz";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(ta.value).toBe("[[zzz");
  });

  it("hides the suggestion list on Escape", () => {
    const { modal } = makeModal([{ basename: "Alpha" }]);
    const ta = textarea(modal);
    ta.value = "[[Alp";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const suggestEl = modal.contentEl.querySelector(".pm-tm-link-suggest") as HTMLElement;
    expect(suggestEl.style.display).toBe("none");
  });

  it("hides the suggestion list shortly after blur", async () => {
    vi.useFakeTimers();
    const { modal } = makeModal([{ basename: "Alpha" }]);
    const ta = textarea(modal);
    ta.value = "[[Alp";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new FocusEvent("blur"));
    vi.advanceTimersByTime(150);
    const suggestEl = modal.contentEl.querySelector(".pm-tm-link-suggest") as HTMLElement;
    expect(suggestEl.style.display).toBe("none");
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// ProjectModal
// ---------------------------------------------------------------------------

describe("ProjectModal", () => {
  function makeModal(project: Project) {
    const onSuccess = vi.fn();
    const modal = new ProjectModal(APP, { project, onSuccess });
    modal.open();
    return { modal, onSuccess };
  }

  it("pre-fills the title, color, and icon", () => {
    const project = makeProject({ id: "p1", title: "Alpha", color: "#ff0000", icon: "🚀" });
    const { modal } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    const colorInput = modal.contentEl.querySelector(".pm-tm-color-input") as HTMLInputElement;
    const iconInput = modal.contentEl.querySelector("input[type='text'].pm-tm-date") as HTMLInputElement;
    expect(titleInput.value).toBe("Alpha");
    expect(colorInput.value).toBe("#ff0000");
    expect(iconInput.value).toBe("🚀");
  });

  it("defaults the color swatch to gray when no color is set", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    const dot = modal.contentEl.querySelector(".pm-tm-status-dot") as HTMLElement;
    expect(dot.style.getPropertyValue("--pm-dot-color")).toBe("#888888");
  });

  it("leaves the icon input empty when unset", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    const iconInput = modal.contentEl.querySelector("input[type='text'].pm-tm-date") as HTMLInputElement;
    expect(iconInput.value).toBe("");
  });

  it("updates the color dot as the color input changes", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    const colorInput = modal.contentEl.querySelector(".pm-tm-color-input") as HTMLInputElement;
    colorInput.value = "#00ff00";
    colorInput.dispatchEvent(new Event("input"));
    const dot = modal.contentEl.querySelector(".pm-tm-status-dot") as HTMLElement;
    expect(dot.style.getPropertyValue("--pm-dot-color")).toBe("#00ff00");
  });

  it("clears the color on 'none' button click", () => {
    const project = makeProject({ id: "p1", color: "#ff0000" });
    const { modal } = makeModal(project);
    const clearBtn = Array.from(modal.contentEl.querySelectorAll("button")).find((b) => b.textContent === "✕ none")!;
    clearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const colorInput = modal.contentEl.querySelector(".pm-tm-color-input") as HTMLInputElement;
    expect(colorInput.value).toBe("#888888");
  });

  it("opens the note and closes the modal on goto-button click", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    const closeSpy = vi.spyOn(modal, "close");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (modal as any).app = { vault: { getAbstractFileByPath: () => null } };
    const gotoBtn = modal.contentEl.querySelector(".pm-tm-goto-btn") as HTMLElement;
    gotoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
  });

  it("shows an error and refuses to submit when the title is empty", () => {
    const project = makeProject({ id: "p1" });
    const { modal, onSuccess } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "";
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(titleInput.classList.contains("pm-tm-error")).toBe(true);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("saves via ProjectFile.update and calls onSuccess on valid submit", async () => {
    const project = makeProject({ id: "p1", filePath: "projects/p1.md" });
    const { modal, onSuccess } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "Updated title";
    const closeSpy = vi.spyOn(modal, "close");
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPFUpdate).toHaveBeenCalledWith("projects/p1.md", expect.objectContaining({ title: "Updated title" }));
    expect(closeSpy).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows a retry state and re-enables the button when the save fails", async () => {
    mockPFUpdate.mockRejectedValueOnce(new Error("disk full"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProject({ id: "p1" });
    const { modal, onSuccess } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "Updated";
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLButtonElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe("Error — retry");
    expect(onSuccess).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("cancels without saving", () => {
    const project = makeProject({ id: "p1" });
    const { modal, onSuccess } = makeModal(project);
    const closeSpy = vi.spyOn(modal, "close");
    const cancelBtn = modal.contentEl.querySelector(".pm-tm-cancel") as HTMLElement;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("clears the title error class on input", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "";
    const submitBtn = modal.contentEl.querySelector(".pm-tm-submit") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(titleInput.classList.contains("pm-tm-error")).toBe(true);
    titleInput.dispatchEvent(new Event("input"));
    expect(titleInput.classList.contains("pm-tm-error")).toBe(false);
  });

  it("empties contentEl on close", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    modal.close();
    expect(modal.contentEl.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// openDropdown / openNoteFile (top-level helpers)
// ---------------------------------------------------------------------------

describe("openDropdown", () => {
  it("renders each item with its label and optional color dot", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    openDropdown(anchor, [
      { label: "A", color: "#ff0000", onSelect: () => {} },
      { label: "B", onSelect: () => {} },
    ]);
    const items = document.querySelectorAll(".pm-tm-dropdown-item");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".pm-tm-dropdown-dot")).not.toBeNull();
    expect(items[1].querySelector(".pm-tm-dropdown-dot")).toBeNull();
  });

  it("calls onSelect and removes the dropdown on item mousedown", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    const onSelect = vi.fn();
    openDropdown(anchor, [{ label: "A", onSelect }]);
    const item = document.querySelector(".pm-tm-dropdown-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(document.querySelector(".pm-tm-dropdown")).toBeNull();
  });

  it("closes on an outside click after the delayed attach", async () => {
    vi.useFakeTimers();
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    openDropdown(anchor, [{ label: "A", onSelect: () => {} }]);
    vi.runAllTimers();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dropdown")).toBeNull();
    vi.useRealTimers();
  });
});

describe("openNoteFile", () => {
  it("does nothing when the path does not resolve to a TFile", () => {
    const app = { vault: { getAbstractFileByPath: () => null }, workspace: { iterateAllLeaves: vi.fn(), getLeaf: vi.fn(), revealLeaf: vi.fn() } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openNoteFile(app as any, "missing.md");
    expect(app.workspace.iterateAllLeaves).not.toHaveBeenCalled();
  });
});
