// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills (same shape as the other *-rendering tests)
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;

  type CreateElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
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
  htmlProto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  htmlProto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  htmlProto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
}

beforeAll(() => { installObsidianDOMPolyfills(); });

// ---------------------------------------------------------------------------

const { moveTaskMock } = vi.hoisted(() => ({ moveTaskMock: vi.fn() }));

vi.mock("obsidian", () => ({
  App: class {},
  Notice: class {},
  Modal: class {
    contentEl: HTMLElement = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public app: any) {}
    open() {
      // Real modals render into the document; tests locate them the same way.
      document.body.appendChild(this.contentEl);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).onOpen?.();
    }
    close() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).onClose?.();
      this.contentEl.remove();
    }
  },
}));

vi.mock("../model/task-move", () => ({ moveTask: moveTaskMock }));

import { MoveTargetModal, openMoveTaskModal, type MoveChoice } from "./move-target-modal";
import type { Project, Task } from "../model/shared";

// ---------------------------------------------------------------------------
// Fixtures: Alpha holds parent -> kid; Beta is empty.
// ---------------------------------------------------------------------------

function makeProject(id: string, title: string): Project {
  return { id, title, tasks: [], filePath: `Projects/${title}.md` };
}

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: "alpha", status: "todo", dependencies: [], subtasks: [],
    filePath: `Projects/Alpha_tasks/${o.id}.md`, ...o,
  } as Task;
}

const PROJECTS = [makeProject("alpha", "Alpha"), makeProject("beta", "Beta")];
const TASKS = [
  makeTask({ id: "parent", title: "Parent" }),
  makeTask({ id: "kid", title: "Kid", parentId: "parent" }),
  makeTask({ id: "far", title: "Far", projectId: "beta" }),
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const APP = {} as any;

function open(opts: Partial<Parameters<typeof MoveTargetModal.prototype.constructor>[1]> = {}) {
  const onChoose = vi.fn();
  const modal = new MoveTargetModal(APP, {
    heading: "Move", ctaLabel: "Move", projects: PROJECTS, tasks: TASKS, onChoose,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(opts as any),
  });
  modal.open();
  return { modal, el: modal.contentEl, onChoose };
}

const rows = (el: HTMLElement, sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];
const rowText = (el: HTMLElement, sel: string) => rows(el, sel).map((r) => r.textContent);
const cta = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button.mod-cta")!;

beforeEach(() => {
  moveTaskMock.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

/** The DOM of the most recently opened modal. */
const openedModal = () => document.body.lastElementChild as HTMLElement;

// ---------------------------------------------------------------------------

describe("MoveTargetModal — project selection", () => {
  it("lists every project", () => {
    const { el } = open();
    expect(rowText(el, ".pm-mt-project-row")).toEqual(["Alpha", "Beta"]);
  });

  it("filters the project list as you type", () => {
    const { el } = open();
    const input = el.querySelector<HTMLInputElement>(".pm-mt-filter")!;
    input.value = "bet";
    input.dispatchEvent(new Event("input"));

    expect(rowText(el, ".pm-mt-project-row")).toEqual(["Beta"]);
  });

  it("shows no parent options until a project is chosen", () => {
    const { el } = open();
    expect(rows(el, ".pm-mt-parent-row")).toHaveLength(0);
  });

  it("renders the project's task tree once selected, with a root option first", () => {
    const { el } = open();
    rows(el, ".pm-mt-project-row")[0].click();

    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Project root (no parent)", "Parent", "Kid"]);
  });

  it("only offers tasks belonging to the selected project", () => {
    const { el } = open();
    rows(el, ".pm-mt-project-row")[1].click(); // Beta

    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Project root (no parent)", "Far"]);
  });

  it("indents a subtask deeper than its parent", () => {
    const { el } = open();
    rows(el, ".pm-mt-project-row")[0].click();
    const [, parent, kid] = rows(el, ".pm-mt-parent-row");

    expect(parseFloat(kid.style.paddingLeft)).toBeGreaterThan(parseFloat(parent.style.paddingLeft));
  });

  it("resets the chosen parent when the project changes", () => {
    const { el, onChoose } = open();
    rows(el, ".pm-mt-project-row")[0].click();
    rows(el, ".pm-mt-parent-row")[1].click(); // Parent
    rows(el, ".pm-mt-project-row")[1].click(); // switch to Beta
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "beta", parentTask: undefined }),
    );
  });
});

describe("MoveTargetModal — choosing", () => {
  it("disables the confirm button until something is selected", () => {
    const { el } = open();
    expect(cta(el).disabled).toBe(true);
  });

  it("reports a project root choice", () => {
    const { el, onChoose } = open();
    rows(el, ".pm-mt-project-row")[0].click();
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith({
      kind: "existing", projectId: "alpha", projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha", parentTask: undefined,
    });
  });

  it("reports a parent-task choice", () => {
    const { el, onChoose } = open();
    rows(el, ".pm-mt-project-row")[0].click();
    rows(el, ".pm-mt-parent-row")[2].click(); // Kid
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ parentTask: expect.objectContaining({ id: "kid" }) }),
    );
  });
});

describe("MoveTargetModal — disabled destinations", () => {
  const isDisabled = (c: MoveChoice) =>
    c.kind === "existing" && c.parentTask?.id === "kid" ? "Cannot move a task under its own subtask" : undefined;

  it("marks a rejected destination disabled and explains why on hover", () => {
    const { el } = open({ isDisabled });
    rows(el, ".pm-mt-project-row")[0].click();
    const kid = rows(el, ".pm-mt-parent-row")[2];

    expect(kid.classList.contains("pm-mt-row--disabled")).toBe(true);
    expect(kid.title).toBe("Cannot move a task under its own subtask");
  });

  it("ignores clicks on a disabled destination", () => {
    const { el, onChoose } = open({ isDisabled });
    rows(el, ".pm-mt-project-row")[0].click();
    rows(el, ".pm-mt-parent-row")[2].click(); // Kid — disabled
    cta(el).click();

    // Still on the project root, which is allowed.
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ parentTask: undefined }));
  });

  it("leaves an allowed sibling clickable", () => {
    const { el } = open({ isDisabled });
    rows(el, ".pm-mt-project-row")[0].click();

    expect(rows(el, ".pm-mt-parent-row")[1].classList.contains("pm-mt-row--disabled")).toBe(false);
  });
});

describe("MoveTargetModal — new project", () => {
  it("is not offered unless the caller opts in", () => {
    const { el } = open();
    expect(rows(el, ".pm-mt-new-project")).toHaveLength(0);
  });

  it("swaps in a name input when chosen", () => {
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();

    expect(el.querySelector(".pm-mt-new-project-input")).not.toBeNull();
  });

  it("reports the typed title", () => {
    const { el, onChoose } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();
    const input = el.querySelector<HTMLInputElement>(".pm-mt-new-project-input")!;
    input.value = "Languages";
    input.dispatchEvent(new Event("input"));
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith({ kind: "new-project", title: "Languages" });
  });

  it("does not steal focus from the filter box while typing", () => {
    // renderProjects() runs on every filter keystroke; re-focusing the project
    // name input there would yank the caret out mid-word.
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();

    const filter = el.querySelector<HTMLInputElement>(".pm-mt-filter")!;
    filter.focus();
    filter.value = "a";
    filter.dispatchEvent(new Event("input"));

    expect(document.activeElement).toBe(filter);
  });

  it("focuses the name input when the row is first activated", () => {
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();

    expect(document.activeElement).toBe(el.querySelector(".pm-mt-new-project-input"));
  });

  it("stays disabled while the name is blank", () => {
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();

    expect(cta(el).disabled).toBe(true);
  });

  it("offers no parent picker: a new project has no tasks to nest under", () => {
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-project-row")[0].click();
    rows(el, ".pm-mt-new-project")[0].click();

    expect(rows(el, ".pm-mt-parent-row")).toHaveLength(0);
  });
});

describe("openMoveTaskModal", () => {
  it("moves the task to the chosen destination", async () => {
    const task = TASKS[1]; // Kid
    const onDone = vi.fn();
    openMoveTaskModal(APP, task, PROJECTS, TASKS, onDone);
    const el = openedModal();

    const projectRows = rows(el, ".pm-mt-project-row");
    projectRows[1].click(); // Beta
    cta(el).click();
    await vi.waitFor(() => expect(moveTaskMock).toHaveBeenCalled());

    expect(moveTaskMock).toHaveBeenCalledWith(
      APP, task,
      expect.objectContaining({ projectId: "beta", parentTask: undefined }),
      TASKS,
      // moveTask needs the project list to find the file the task is leaving.
      PROJECTS,
    );
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("does not offer creating a new project", () => {
    openMoveTaskModal(APP, TASKS[1], PROJECTS, TASKS, vi.fn());
    const el = openedModal();
    expect(rows(el, ".pm-mt-new-project")).toHaveLength(0);
  });

  it("greys out the task's own subtree as a destination", () => {
    // Moving "parent" under its own child "kid" must be refused.
    openMoveTaskModal(APP, TASKS[0], PROJECTS, TASKS, vi.fn());
    const el = openedModal();
    rows(el, ".pm-mt-project-row")[0].click();

    const kid = rows(el, ".pm-mt-parent-row").find((r) => r.dataset.taskId === "kid")!;
    expect(kid.classList.contains("pm-mt-row--disabled")).toBe(true);
    expect(kid.title).toMatch(/own subtask/i);
  });

  it("surfaces a failed move instead of silently swallowing it", async () => {
    const err = new Error("disk full");
    moveTaskMock.mockRejectedValueOnce(err);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onDone = vi.fn();

    openMoveTaskModal(APP, TASKS[1], PROJECTS, TASKS, onDone);
    const el = openedModal();
    rows(el, ".pm-mt-project-row")[1].click();
    cta(el).click();

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
