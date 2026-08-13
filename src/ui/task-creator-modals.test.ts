// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import { DescriptionWrite } from "../model/io/project-task-io";
import type { CreateTaskOpts, UpdateTaskData } from "../model/io/project-task-io";
import { TaskModalMode } from "./task-creator";
import { TaskType } from "../model/project/project-task";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);

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
    return this.createEl("div", opts);
  };
  htmlProto.createSpan = function (this: HTMLElement, opts?: CreateElOpts) {
    return this.createEl("span", opts);
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
  // jsdom lays nothing out, so it ships no scrolling at all — not Obsidian's, the DOM's own.
  htmlProto.scrollIntoView = function () {};
  bagOf(window).activeDocument = document;
  bagOf(window).activeWindow = window;

  // Global createDiv/createEl used by openDropdown (called as bare functions, not methods)
  bagOf(window).createDiv = function (opts?: CreateElOpts) {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    document.body.appendChild(el);
    return el;
  };
  bagOf(window).createEl = function (tag: string, opts?: CreateElOpts) {
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
  NoticeMock,
  mockPTFCreate,
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
    // `declare`, so this only names what the subclass under test defines — a real field
    // here would be initialised to undefined and shadow the subclass's own method.
    declare onOpen?: () => void;
    declare onClose?: () => void;
    open() { this.onOpen?.(); }
    close() { this.onClose?.(); }
  }
  return {
    MockModal,
    // The default answer is set in `beforeEach`: naming the enum here would read it before
    // this hoisted block's own imports have run.
    mockPTFUpdate: vi.fn<(task: ProjectTask, data: UpdateTaskData) => Promise<DescriptionWrite>>(),
    mockPTFReadDescription: vi.fn<(task: ProjectTask) => Promise<string>>().mockResolvedValue(""),
  /** What the user was told — the only trace a fire-and-forget notice leaves. */
  NoticeMock: vi.fn(),
    mockPTFCreate: vi.fn<(opts: CreateTaskOpts) => Promise<string>>()
      .mockResolvedValue("abcdef1234567890"),
  };
});

vi.mock("obsidian", async () => ({
  // The real one: the modal's date fields open the plugin's calendar, which formats its
  // month heading and weekday initials through it.
  moment: (await import("moment")).default,
  App: class {},
  Modal: MockModal,
  Notice: NoticeMock,
  TFile: class {},
  normalizePath: (p: string) => p,
  setIcon: () => {},
}));

import {
  TaskModal, ProjectModal, ProjectModalMode, ConfirmModal, confirmAction, openDropdown, openNoteFile,
} from "./task-creator";
import { ConfirmStyle } from "./pm-modal";
import { type Project, type ProjectFields } from "../model/project/project";
import { ProjectTask, type ProjectTaskFields } from "../model/project/project-task";
import { day } from "../model/__testing__/dates";
import { bagOf } from "./__testing__/dom-bag";
import { asApp } from "../model/__testing__/as-app";
import type { VaultData } from "../model/service/vault-data";
import { newProject, newTask } from "../model/__testing__/notes";

/** The modal's own members, named rather than reached for through `any`: an edit-mode
 *  loader the tests call directly, and the app it reads the note off. */
interface ModalInternals {
  app: { vault: { getAbstractFileByPath: (path: string) => unknown } };
  loadDescription(textarea: HTMLTextAreaElement): Promise<void>;
}
const internals = (modal: TaskModal | ProjectModal) => modal as unknown as ModalInternals;

function makeTask(overrides: Partial<ProjectTaskFields> & { id: string }): ProjectTask {
  return newTask({
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  });
}

function makeProject(overrides: Partial<ProjectFields> & { id: string }): Project {
  return newProject({
    title: "A project",
    filePath: `projects/${overrides.id}.md`,
    ...overrides,
  });
}

const APP = {} as never;

const mockCreateProject = vi.fn<(opts: { projectsFolder: string; title: string; icon?: string; color?: string }) => Promise<unknown>>()
  .mockResolvedValue(undefined);

/** The slice of the vault the modals write through. */
const VAULT = {
  settings: () => ({ projectsFolder: "Projects" }),
  projects: {
    createTask: mockPTFCreate,
    createProject: mockCreateProject,
    updateTask: mockPTFUpdate,
    readDescription: mockPTFReadDescription,
  },
} as unknown as VaultData;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  mockPTFUpdate.mockResolvedValue(DescriptionWrite.Saved);
  mockPTFReadDescription.mockResolvedValue("");
  NoticeMock.mockClear();
  mockPTFCreate.mockResolvedValue("abcdef1234567890");
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

  it("takes the confirm button's wording and looks from the caller", () => {
    const onConfirm = vi.fn();
    const modal = new ConfirmModal(APP, "Move this?", onConfirm, { label: "Move", style: ConfirmStyle.Cta });
    modal.open();
    const confirmBtn = modal.contentEl.querySelector(".mod-cta") as HTMLElement;
    expect(confirmBtn.textContent).toBe("Move");
    confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// confirmAction
// ---------------------------------------------------------------------------

describe("confirmAction", () => {
  /** The message of the dialog on screen, if the call opened one. */
  const asked = () => document.body.querySelector(".pm-confirm-message")?.textContent;

  it("asks before acting when the confirmation is required", () => {
    const onConfirm = vi.fn();
    confirmAction(APP, true, "Delete this?", onConfirm);
    expect(asked()).toBe("Delete this?");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("runs the action once the dialog it opened is confirmed", () => {
    const onConfirm = vi.fn();
    confirmAction(APP, true, "Delete this?", onConfirm);
    const confirmBtn = document.body.querySelector(".mod-warning") as HTMLElement;
    confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("passes the caller's confirm button through to the dialog", () => {
    confirmAction(APP, true, "Move this?", vi.fn(), { label: "Move", style: ConfirmStyle.Cta });
    expect(document.body.querySelector(".mod-cta")?.textContent).toBe("Move");
  });

  it("acts straight away, asking nothing, when the confirmation is off", () => {
    const onConfirm = vi.fn();
    confirmAction(APP, false, "Delete this?", onConfirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(asked()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TaskModal — create mode
// ---------------------------------------------------------------------------

describe("TaskModal — create mode", () => {
  function makeModal(overrides: Partial<{ parentTask: ProjectTask; existingTasks: ProjectTask[] }> = {}) {
    const onSuccess = vi.fn();
    const modal = new TaskModal(APP, {
      mode: TaskModalMode.Create,
      vault: VAULT,
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
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    expect(titleInput.classList.contains("pm-tm-error")).toBe(true);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mockPTFCreate).not.toHaveBeenCalled();
  });

  it("clears the error class once the user starts typing again", () => {
    const { modal } = makeModal();
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
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
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFCreate).toHaveBeenCalledOnce();
    const callArg = mockPTFCreate.mock.calls[0][0];
    expect(callArg.title).toBe("New task");
    expect(callArg.type).toBe("task");
    expect(closeSpy).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it("carries a date picked through the calendar into the file it writes", async () => {
    const { modal } = makeModal();
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "Dated task";

    const dueBtn = modal.contentEl.querySelectorAll("button.pm-tm-date")[1] as HTMLElement;
    dueBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const day = [...document.body.querySelectorAll(".pm-datepicker-day")]
      .find((d) => d.textContent === "15") as HTMLElement;
    day.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(dueBtn.textContent).toMatch(/-15$/);
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFCreate.mock.calls[0][0].due?.getDate()).toBe(15);
  });

  it("resolves the task type to 'subtask' when there is a parent task", async () => {
    const parent = makeTask({ id: "parent" });
    const { modal } = makeModal({ parentTask: parent });
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "Child task";
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFCreate.mock.calls[0][0].type).toBe("subtask");
    expect(mockPTFCreate.mock.calls[0][0].parentTask).toBe(parent);
  });

  it("shows a retry state and re-enables the button when the save fails", async () => {
    mockPTFCreate.mockRejectedValueOnce(new Error("disk full"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { modal, onSuccess } = makeModal();
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "New task";
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLButtonElement;
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
    const cancelBtn = modal.contentEl.querySelector(".pm-modal-cancel") as HTMLElement;
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
    await internals(modal).loadDescription(textarea);
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

  it("opens a dependency picker over the project, barring the line the subtask is created under", () => {
    // The graph lifts each end to the card standing for it, so depth is no bar — but a task
    // and something above it would land on one card at every level.
    const grandparent = makeTask({ id: "gp1", title: "Grandparent" });
    const parent = makeTask({ id: "parent1", title: "Parent", parentId: "gp1" });
    const siblingSubtask = makeTask({ id: "sub1", title: "Sibling subtask", parentId: "parent1" });
    const unrelated = makeTask({ id: "other1", title: "Unrelated top-level" });
    const elsewhere = makeTask({ id: "far1", title: "Another project", projectId: "proj-2" });
    const { modal } = makeModal({
      parentTask: parent,
      existingTasks: [grandparent, parent, siblingSubtask, unrelated, elsewhere],
    });
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const picker = document.querySelector(".pm-tm-dep-picker")!;
    expect(picker.textContent).toContain("Sibling subtask");
    expect(picker.textContent).toContain("Unrelated top-level");
    expect(picker.textContent).not.toContain("Parent");
    expect(picker.textContent).not.toContain("Grandparent");
    expect(picker.textContent).not.toContain("Another project");
  });
});

// ---------------------------------------------------------------------------
// TaskModal — edit mode
// ---------------------------------------------------------------------------

describe("TaskModal — edit mode", () => {
  function makeModal(taskOverrides: Partial<ProjectTask> & { id: string } = { id: "t1" }, existingTasks: ProjectTask[] = []) {
    const task = makeTask(taskOverrides);
    const onSuccess = vi.fn();
    const modal = new TaskModal(APP, { mode: TaskModalMode.Edit, vault: VAULT, task, existingTasks, onSuccess });
    modal.open();
    return { modal, task, onSuccess };
  }

  it("keeps Save disabled and says so when the description can't be read", async () => {
    // Saving with an empty textarea would blank the task's real body, so a failed read
    // has to leave the modal unusable rather than merely unfilled.
    mockPTFReadDescription.mockRejectedValueOnce(new Error("vault read failed"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { modal } = makeModal({ id: "t1" });
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLButtonElement;

    await vi.waitFor(() => expect(submitBtn.textContent).toBe("Couldn't load — reopen"));

    expect(submitBtn.disabled).toBe(true);
    expect(modal.contentEl.querySelector(".pm-tm-banner")?.textContent)
      .toContain("description couldn't be read");
    expect(NoticeMock).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("enables Save once the description has landed", async () => {
    mockPTFReadDescription.mockResolvedValueOnce("The body");
    const { modal } = makeModal({ id: "t1" });
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    await vi.waitFor(() => expect(submitBtn.disabled).toBe(false));
  });

  it("pre-fills the title from the task", () => {
    const { modal } = makeModal({ id: "t1", title: "Existing title" });
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    expect(titleInput.value).toBe("Existing title");
  });

  it("normalizes a legacy 'subtask' type to 'task' for the type selector", () => {
    const { modal } = makeModal({ id: "t1", type: TaskType.Subtask });
    const activeBtn = modal.contentEl.querySelector(".pm-tm-seg-btn.is-active");
    expect(activeBtn?.textContent).toBe("Task");
  });

  it("defaults an unset type to 'task'", () => {
    const { modal } = makeModal({ id: "t1", type: undefined });
    const activeBtn = modal.contentEl.querySelector(".pm-tm-seg-btn.is-active");
    expect(activeBtn?.textContent).toBe("Task");
  });

  it("shows the milestone type as active when set", () => {
    const { modal } = makeModal({ id: "t1", type: TaskType.Milestone });
    const activeBtn = modal.contentEl.querySelector(".pm-tm-seg-btn.is-active");
    expect(activeBtn?.textContent).toBe("Milestone");
  });

  it("hides the type selector for a task that has a parentId", () => {
    const { modal } = makeModal({ id: "t1", parentId: "p1" });
    expect(modal.contentEl.querySelector(".pm-tm-segmented")).toBeNull();
  });

  it("pre-fills start/due dates when set", () => {
    const { modal } = makeModal({ id: "t1", start: day("2026-07-01"), due: day("2026-07-15") });
    const dateBtns = modal.contentEl.querySelectorAll("button.pm-tm-date");
    expect(dateBtns[0].textContent).toBe("2026-07-01");
    expect(dateBtns[1].textContent).toBe("2026-07-15");
  });

  it("leaves start/due dates empty when unset", () => {
    const { modal } = makeModal({ id: "t1" });
    const dateBtns = modal.contentEl.querySelectorAll("button.pm-tm-date");
    expect(dateBtns[0].textContent).toBe("Set a date");
    expect(dateBtns[0].classList.contains("pm-tm-date--empty")).toBe(true);
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
    internals(modal).app = { vault: { getAbstractFileByPath: () => null } };
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

  it("saves via ProjectTaskIO.update and calls onSuccess on valid submit", async () => {
    const { modal, onSuccess } = makeModal({ id: "t1", filePath: "tasks/t1.md" });
    // Save is held disabled until the async description read lands, so a quick
    // submit can't overwrite the body with an empty textarea — wait for it.
    await Promise.resolve();
    await Promise.resolve();
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFUpdate).toHaveBeenCalledWith(expect.objectContaining({ filePath: "tasks/t1.md" }), expect.objectContaining({ title: "A task" }));
    expect(onSuccess).toHaveBeenCalled();
  });

  it("hands over the description it loaded as the baseline the write is allowed against", async () => {
    mockPTFReadDescription.mockResolvedValueOnce("As the note had it");
    const { modal } = makeModal({ id: "t1", filePath: "tasks/t1.md" });
    await Promise.resolve();
    await Promise.resolve();
    const textarea = modal.contentEl.querySelector(".pm-tm-description") as HTMLTextAreaElement;
    textarea.value = "Typed in the dialog";
    (modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      description: "Typed in the dialog", baseDescription: "As the note had it",
    }));
  });

  it("stays open, and stays unsavable, when the note's description moved underneath", async () => {
    // The baseline this dialog carries is spent: pressing Save again could only reach the
    // same answer, so the text is left where the user can take it back.
    mockPTFUpdate.mockResolvedValueOnce(DescriptionWrite.Conflict);
    const { modal, onSuccess } = makeModal({ id: "t1", filePath: "tasks/t1.md" });
    await Promise.resolve();
    await Promise.resolve();
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLButtonElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(submitBtn.disabled).toBe(true);
    expect(submitBtn.textContent).toBe("Description changed on the note");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("says why in the dialog, where it stays, rather than in a notice that fades", async () => {
    mockPTFUpdate.mockResolvedValueOnce(DescriptionWrite.Conflict);
    const { modal } = makeModal({ id: "t1", filePath: "tasks/t1.md" });
    await Promise.resolve();
    await Promise.resolve();
    const banner = modal.contentEl.querySelector(".pm-tm-banner") as HTMLElement;
    // Empty on the ordinary path: the stylesheet keeps it out of the layout that way.
    expect(banner.textContent).toBe("");

    (modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(banner.textContent).toContain("was edited while this was open");
    expect(NoticeMock).not.toHaveBeenCalled();
  });

  it("holds Save disabled until the description loads, so a quick submit can't blank the body", async () => {
    let resolveRead!: (v: string) => void;
    mockPTFReadDescription.mockReturnValueOnce(new Promise<string>((r) => { resolveRead = r; }));
    const { modal } = makeModal({ id: "t1", filePath: "tasks/t1.md" });
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLButtonElement;

    // Read hasn't resolved: button is disabled and a click is a no-op.
    expect(submitBtn.disabled).toBe(true);
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(mockPTFUpdate).not.toHaveBeenCalled();

    // Once the description lands the button re-enables and submit goes through.
    resolveRead("Existing body");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(submitBtn.disabled).toBe(false);
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPTFUpdate).toHaveBeenCalledWith(expect.objectContaining({ filePath: "tasks/t1.md" }), expect.objectContaining({ description: "Existing body" }));
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

  it("offers a task at another level of the project, but not one on the task's own line", () => {
    const self = makeTask({ id: "t1" });
    const deeper = makeTask({ id: "deep1", title: "Deeper elsewhere", parentId: "other-parent" });
    const ownChild = makeTask({ id: "kid1", title: "Own subtask", parentId: "t1" });
    const { modal } = makeModal({ id: "t1" }, [self, deeper, ownChild]);
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const picker = document.querySelector(".pm-tm-dep-picker")!;
    expect(picker.textContent).toContain("Deeper elsewhere");
    expect(picker.textContent).not.toContain("Own subtask");
  });

  it("offers nothing when every task in the project is on the task's own line", () => {
    const self = makeTask({ id: "t1", parentId: "up1" });
    const parent = makeTask({ id: "up1", title: "Parent" });
    const { modal } = makeModal({ id: "t1", parentId: "up1" }, [self, parent]);
    const depsAddBtn = modal.contentEl.querySelectorAll(".pm-tm-add-chip")[1] as HTMLElement;
    depsAddBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dep-picker")).toBeNull();
  });

  it("leaves out a task in another project", () => {
    const self = makeTask({ id: "t1" });
    const elsewhere = makeTask({ id: "far1", title: "Another project", projectId: "proj-2" });
    const { modal } = makeModal({ id: "t1" }, [self, elsewhere]);
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
      mode: TaskModalMode.Create,
      vault: VAULT,
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
    const modal = new ProjectModal(APP, { mode: ProjectModalMode.Edit, project, vault: VAULT, onSuccess });
    modal.open();
    return { modal, onSuccess };
  }

  it("pre-fills the title, color, and icon", () => {
    const project = makeProject({ id: "p1", title: "Alpha", color: "#ff0000", icon: "🚀" });
    const { modal } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    const colorInput = modal.contentEl.querySelector(".pm-tm-color-input") as HTMLInputElement;
    expect(titleInput.value).toBe("Alpha");
    expect(colorInput.value).toBe("#ff0000");
    expect(modal.contentEl.querySelector(".pm-tm-icon-btn")!.textContent).toBe("🚀");
  });

  it("defaults the color swatch to gray when no color is set", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    const dot = modal.contentEl.querySelector(".pm-tm-status-dot") as HTMLElement;
    expect(dot.style.getPropertyValue("--pm-dot-color")).toBe("#888888");
  });

  it("says an icon-less project has none", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    expect(modal.contentEl.querySelector(".pm-tm-icon-btn")!.textContent).toBe("—");
  });

  it("takes the icon picked and drops it again on ✕ none", () => {
    const project = makeProject({ id: "p1", icon: "🚀" });
    const flush = vi.spyOn(project.persistence, "flush").mockResolvedValue();
    const { modal } = makeModal(project);
    const swatch = modal.contentEl.querySelector(".pm-tm-icon-btn") as HTMLElement;

    swatch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (document.querySelectorAll(".pm-iconpicker-cell")[1] as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const picked = swatch.textContent;
    expect(picked).not.toBe("🚀");
    expect(document.querySelector(".pm-iconpicker")).toBeNull();

    const clearBtn = Array.from(modal.contentEl.querySelectorAll("button")).find((b) => b.title === "Remove icon")!;
    clearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(swatch.textContent).toBe("—");
    expect(flush).not.toHaveBeenCalled();
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
    internals(modal).app = { vault: { getAbstractFileByPath: () => null } };
    const gotoBtn = modal.contentEl.querySelector(".pm-tm-goto-btn") as HTMLElement;
    gotoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
  });

  it("shows an error and refuses to submit when the title is empty", () => {
    const project = makeProject({ id: "p1" });
    const { modal, onSuccess } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "";
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(titleInput.classList.contains("pm-tm-error")).toBe(true);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("sets what was typed on the project and writes it, then calls onSuccess", async () => {
    const project = makeProject({ id: "p1", filePath: "projects/p1.md" });
    const flush = vi.spyOn(project.persistence, "flush").mockResolvedValue();
    const { modal, onSuccess } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "Updated title";
    const closeSpy = vi.spyOn(modal, "close");
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(project.title).toBe("Updated title");
    expect(flush).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it("pre-fills the archived checkbox and saves what it is left at", async () => {
    const project = makeProject({ id: "p1", filePath: "projects/p1.md", archived: true });
    const flush = vi.spyOn(project.persistence, "flush").mockResolvedValue();
    const { modal } = makeModal(project);
    const archived = modal.contentEl.querySelector(".pm-tm-archived-input") as HTMLInputElement;
    expect(archived.checked).toBe(true);
    archived.checked = false;
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
    submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    // Nothing to put away is no key on the file — see `parseProject`.
    expect(project.archived).toBeUndefined();
    expect(flush).toHaveBeenCalled();
  });

  it("shows a retry state and re-enables the button when the save fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProject({ id: "p1" });
    vi.spyOn(project.persistence, "flush").mockRejectedValueOnce(new Error("disk full"));
    const { modal, onSuccess } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "Updated";
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLButtonElement;
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
    const cancelBtn = modal.contentEl.querySelector(".pm-modal-cancel") as HTMLElement;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("clears the title error class on input", () => {
    const project = makeProject({ id: "p1" });
    const { modal } = makeModal(project);
    const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
    titleInput.value = "";
    const submitBtn = modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement;
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

  describe("filling in a new project", () => {
    function makeCreateModal() {
      const onSuccess = vi.fn();
      const modal = new ProjectModal(APP, { mode: ProjectModalMode.Create, vault: VAULT, onSuccess });
      modal.open();
      return { modal, onSuccess };
    }

    it("opens empty, with nothing to open and nothing to put away", () => {
      const { modal } = makeCreateModal();
      const titleInput = modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement;
      expect(titleInput.value).toBe("");
      expect(modal.contentEl.querySelector(".pm-tm-goto-btn")).toBeNull();
      expect(modal.contentEl.querySelector(".pm-tm-archived-input")).toBeNull();
    });

    it("makes the note out of what was typed, then calls onSuccess", async () => {
      const { modal, onSuccess } = makeCreateModal();
      (modal.contentEl.querySelector(".pm-tm-title-input") as HTMLInputElement).value = "Fresh";
      (modal.contentEl.querySelector(".pm-tm-icon-btn") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      (document.querySelector(".pm-iconpicker-cell") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const colorInput = modal.contentEl.querySelector(".pm-tm-color-input") as HTMLInputElement;
      colorInput.value = "#00ff00";
      colorInput.dispatchEvent(new Event("input"));
      const closeSpy = vi.spyOn(modal, "close");

      (modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();

      expect(mockCreateProject).toHaveBeenCalledWith({
        projectsFolder: "Projects", title: "Fresh", icon: "📋", color: "#00ff00",
      });
      expect(closeSpy).toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalled();
    });

    it("refuses a project with no title", () => {
      const { modal, onSuccess } = makeCreateModal();
      (modal.contentEl.querySelector(".pm-modal-confirm") as HTMLElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(mockCreateProject).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    });
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

  it("marks the item in force, and only that one", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    openDropdown(anchor, [
      { label: "A", onSelect: () => {} },
      { label: "B", selected: true, onSelect: () => {} },
      { label: "C", onSelect: () => {} },
    ]);
    const marked = document.querySelectorAll(".pm-tm-dropdown-item--selected");
    expect(marked).toHaveLength(1);
    expect((marked[0] as HTMLElement).innerText ?? marked[0].textContent).toBe("B");
    expect(marked[0].getAttribute("aria-current")).toBe("true");
  });

  it("shows a disabled item, inert and marked as such", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    const onSelect = vi.fn();
    openDropdown(anchor, [
      { label: "A", onSelect: () => {} },
      { label: "B", disabled: true, title: "Nothing to sort on", onSelect },
    ]);
    const items = document.querySelectorAll(".pm-tm-dropdown-item");
    // Listed, not dropped: the list is what says the option exists.
    expect(items).toHaveLength(2);
    const disabled = items[1] as HTMLElement;
    expect(disabled.classList.contains("pm-tm-dropdown-item--disabled")).toBe(true);
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("title")).toBe("Nothing to sort on");
    disabled.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector(".pm-tm-dropdown")).not.toBeNull();
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

  it("stays up on a pick when it is a multiple choice, moving the tick itself", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    let on = false;
    openDropdown(
      anchor,
      [{ label: "A", selected: () => on, onSelect: () => { on = !on; } }],
      { keepOpen: true },
    );
    const item = document.querySelector(".pm-tm-dropdown-item") as HTMLElement;

    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dropdown")).not.toBeNull();
    expect(item.classList.contains("pm-tm-dropdown-item--selected")).toBe(true);
    expect(item.getAttribute("aria-current")).toBe("true");

    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(item.classList.contains("pm-tm-dropdown-item--selected")).toBe(false);
    expect(item.getAttribute("aria-current")).toBeNull();
  });

  // One pick's doing shows on every row, not just the one clicked.
  it("re-reads every row's tick after a pick", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    let picked = "A";
    const row = (label: string) => ({
      label, selected: () => picked === label, onSelect: () => { picked = label; },
    });
    openDropdown(anchor, [row("A"), row("B")], { keepOpen: true });
    const items = [...document.querySelectorAll(".pm-tm-dropdown-item")] as HTMLElement[];

    items[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(items.map((el) => el.classList.contains("pm-tm-dropdown-item--selected")))
      .toEqual([false, true]);
  });

  // Staying open, nothing but a click outside ends it, so its owner needs a way to.
  it("hands back the dismiss", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    const dismiss = openDropdown(anchor, [{ label: "A", onSelect: () => {} }], { keepOpen: true });
    expect(document.querySelector(".pm-tm-dropdown")).not.toBeNull();

    dismiss();
    expect(document.querySelector(".pm-tm-dropdown")).toBeNull();
    // Run twice — the owner can't know whether a click outside got there first.
    expect(() => dismiss()).not.toThrow();
  });

  // The anchor is redrawn on every pick, so watching it would close the picker at once.
  it("outlives its anchor leaving the document when it stays open", () => {
    vi.useFakeTimers();
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    openDropdown(anchor, [{ label: "A", onSelect: () => {} }], { keepOpen: true });
    vi.runAllTimers();
    anchor.remove();
    expect(document.querySelector(".pm-tm-dropdown")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dropdown")).toBeNull();
    vi.useRealTimers();
  });

  it("closes on an outside click after the delayed attach", async () => {
    vi.useFakeTimers();
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    openDropdown(anchor, [{ label: "A", onSelect: () => {} }]);
    vi.runAllTimers();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dropdown")).toBeNull();
    vi.useRealTimers();
  });

  it("survives the compatibility mousedown a phone fires when the opening touch lifts", async () => {
    vi.useFakeTimers();
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    openDropdown(anchor, [{ label: "A", onSelect: () => {} }]);
    vi.runAllTimers();
    anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".pm-tm-dropdown")).not.toBeNull();
    vi.useRealTimers();
  });

  it("closes on a scroll, which the fixed picker can't follow", async () => {
    vi.useFakeTimers();
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    openDropdown(anchor, [{ label: "A", onSelect: () => {} }]);
    vi.runAllTimers();
    anchor.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(document.querySelector(".pm-tm-dropdown")).toBeNull();
    vi.useRealTimers();
  });

  it("closes when the view is rebuilt under it, taking the anchor with it", async () => {
    const row = document.createElement("div");
    const anchor = row.createDiv();
    document.body.appendChild(row);
    openDropdown(anchor, [{ label: "A", onSelect: () => {} }]);
    await new Promise((resolve) => window.setTimeout(resolve, 0)); // the delayed attach
    row.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0)); // the observer's callback
    expect(document.querySelector(".pm-tm-dropdown")).toBeNull();
  });

  describe("placement", () => {
    /** jsdom lays nothing out, so both rects are stubbed: a 400×24 viewport-relative
     *  anchor at `anchorTop`, and a picker of `pickerHeight`. */
    function openAt(anchorTop: number, pickerHeight = 120): HTMLElement {
      vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(800);
      vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(600);

      const anchor = document.createElement("div");
      document.body.appendChild(anchor);
      anchor.getBoundingClientRect = () =>
        ({ top: anchorTop, bottom: anchorTop + 24, left: 40, width: 4, height: 24 }) as DOMRect;

      const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          if (this.classList.contains("pm-tm-dropdown")) {
            return { width: 140, height: pickerHeight } as DOMRect;
          }
          // jsdom has no layout, so everything else measures zero either way.
          return new DOMRect();
        });
      try {
        openDropdown(anchor, [{ label: "A", onSelect: () => {} }]);
      } finally {
        rect.mockRestore();
      }
      return document.querySelector(".pm-tm-dropdown") as HTMLElement;
    }

    it("hangs the picker off the body, out of reach of any ancestor's overflow", () => {
      const picker = openAt(100);
      expect(picker.parentElement).toBe(document.body);
    });

    it("opens below the anchor when there is room", () => {
      const picker = openAt(100);
      expect(picker.style.top).toBe("128px");
      expect(picker.style.left).toBe("40px");
    });

    it("flips above the anchor when the picker would run past the bottom", () => {
      // 500 + 24 + 4 + 120 > 600, so it opens upward instead.
      const picker = openAt(500);
      expect(picker.style.top).toBe("376px");
    });

    it("clamps to the top rather than opening off-screen when neither side fits", () => {
      const picker = openAt(560, 590);
      expect(picker.style.top).toBe("4px");
    });
  });
});

describe("openNoteFile", () => {
  it("does nothing when the path does not resolve to a TFile", () => {
    const app = { vault: { getAbstractFileByPath: () => null }, workspace: { iterateAllLeaves: vi.fn(), getLeaf: vi.fn(), revealLeaf: vi.fn() } };
    openNoteFile(asApp(app), "missing.md");
    expect(app.workspace.iterateAllLeaves).not.toHaveBeenCalled();
  });
});
