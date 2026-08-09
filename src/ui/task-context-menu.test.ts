// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from "vitest";

const { MockMenu, MockTaskModal, mockConfirmAction, mockOpenMoveTaskModal } = vi.hoisted(() => {
  class MockMenuItem {
    title = "";
    icon = "";
    click: (() => void) | null = null;
    setTitle(t: string) { this.title = t; return this; }
    setIcon(i: string) { this.icon = i; return this; }
    onClick(fn: () => void) { this.click = fn; return this; }
  }
  class MockMenu {
    static instances: MockMenu[] = [];
    items: MockMenuItem[] = [];
    shownAt: unknown = null;
    constructor() { MockMenu.instances.push(this); }
    addItem(cb: (item: MockMenuItem) => void) {
      const item = new MockMenuItem();
      cb(item);
      this.items.push(item);
      return this;
    }
    showAtMouseEvent(e: unknown) { this.shownAt = e; }
  }
  class MockTaskModal {
    static instances: MockTaskModal[] = [];
    opened = false;
    constructor(public app: unknown, public opts: Record<string, unknown>) {
      MockTaskModal.instances.push(this);
    }
    open() { this.opened = true; }
  }
  const mockConfirmAction = Object.assign(
    (_app: unknown, required: boolean, message: string, onConfirm: () => void) => {
      mockConfirmAction.calls.push({ required, message, onConfirm });
    },
    { calls: [] as { required: boolean; message: string; onConfirm: () => void }[] },
  );
  const mockOpenMoveTaskModal = vi.fn();
  return { MockMenu, MockTaskModal, mockConfirmAction, mockOpenMoveTaskModal };
});

vi.mock("obsidian", () => ({
  App: class {},
  Menu: MockMenu,
  Modal: class {
    contentEl = document.createElement("div");
    constructor(public app: unknown) {}
    open() {}
    close() {}
  },
  Component: class { load() {} unload() {} },
  Notice: class {},
  TFile: class { path = ""; },
  normalizePath: (p: string) => p,
  setIcon: () => {},
  moment: () => { throw new Error("obsidian.moment is not stubbed in this test"); },
}));

vi.mock("./task-creator", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TaskModal: MockTaskModal,
  confirmAction: mockConfirmAction,
}));

vi.mock("./move-target-modal", () => ({ openMoveTaskModal: mockOpenMoveTaskModal }));

import { addSubtask, deleteTask, moveTask, openTaskContextMenu, type TaskActionsOptions } from "./task-context-menu";
import { TaskModalMode } from "./task-creator";
import { Icon } from "./icons";
import { asApp } from "../model/__testing__/as-app";
import { newProject, newTask } from "../model/__testing__/notes";
import type { ProjectTask, ProjectTaskFields } from "../model/project/project-task";
import type { VaultData } from "../model/service/vault-data";

const APP = asApp({});

function task(overrides: Partial<ProjectTaskFields> & { id: string }): ProjectTask {
  return newTask({
    title: overrides.id.toUpperCase(),
    projectId: "p1",
    status: "todo",
    dependencies: [],
    filePath: `Projects/p1_tasks/${overrides.id}.md`,
    ...overrides,
  });
}

const PROJECT = newProject({ id: "p1", title: "Alpha", filePath: "Projects/Alpha.md" });

function options(overrides: Partial<TaskActionsOptions> = {}): TaskActionsOptions {
  const one = task({ id: "t1" });
  return {
    task: one,
    vault: {} as VaultData,
    projects: [PROJECT],
    allTasks: [one],
    onRefresh: vi.fn(),
    onDelete: vi.fn(),
    confirmDelete: true,
    ...overrides,
  };
}

beforeEach(() => {
  MockMenu.instances.length = 0;
  MockTaskModal.instances.length = 0;
  mockConfirmAction.calls.length = 0;
  mockOpenMoveTaskModal.mockClear();
});

describe("addSubtask", () => {
  it("opens the editor under the task, on the project the task belongs to", () => {
    const opts = options();

    addSubtask(APP, opts);

    const modal = MockTaskModal.instances[0];
    expect(modal.opened).toBe(true);
    expect(modal.opts).toMatchObject({
      mode: TaskModalMode.Create,
      projectId: "p1",
      projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha",
      parentTask: opts.task,
    });
  });

  it("offers the editor only the tasks of that same project", () => {
    const mine = task({ id: "t1" });
    const theirs = task({ id: "t2", projectId: "p2" });

    addSubtask(APP, options({ task: mine, allTasks: [mine, theirs] }));

    expect(MockTaskModal.instances[0].opts.existingTasks).toEqual([mine]);
  });

  it("opens nothing for a task whose project isn't there", () => {
    addSubtask(APP, options({ projects: [] }));

    expect(MockTaskModal.instances).toEqual([]);
  });
});

describe("moveTask", () => {
  it("hands the picker the task, the projects and the whole task list", () => {
    const opts = options();

    moveTask(APP, opts);

    expect(mockOpenMoveTaskModal).toHaveBeenCalledWith(
      APP, opts.vault, opts.task, opts.projects, opts.allTasks, opts.onRefresh,
    );
  });
});

describe("deleteTask", () => {
  it("asks by name, then deletes once the question is answered", () => {
    const opts = options();

    deleteTask(APP, opts);

    expect(mockConfirmAction.calls[0]).toMatchObject({ required: true, message: 'Delete "T1"?' });
    mockConfirmAction.calls[0].onConfirm();
    expect(opts.onDelete).toHaveBeenCalledWith(opts.task, undefined);
  });

  it("counts the subtree the delete takes with it", () => {
    const parent = task({ id: "t1" });
    const kid = task({ id: "t2", parentId: "t1" });
    const grandkid = task({ id: "t3", parentId: "t2" });

    deleteTask(APP, options({ task: parent, allTasks: [parent, kid, grandkid] }));

    expect(mockConfirmAction.calls[0].message).toBe('Delete "T1" and its 2 subtasks?');
  });

  it("counts one subtask in the singular", () => {
    const parent = task({ id: "t1" });
    const kid = task({ id: "t2", parentId: "t1" });

    deleteTask(APP, options({ task: parent, allTasks: [parent, kid] }));

    expect(mockConfirmAction.calls[0].message).toBe('Delete "T1" and its 1 subtask?');
  });

  it("names the parent the delete leaves behind", () => {
    const parent = task({ id: "t1" });
    const kid = task({ id: "t2", parentId: "t1" });
    const opts = options({ task: kid, allTasks: [parent, kid] });

    deleteTask(APP, opts);
    mockConfirmAction.calls[0].onConfirm();

    expect(opts.onDelete).toHaveBeenCalledWith(kid, parent);
  });

  it("leaves the asking to the setting", () => {
    deleteTask(APP, options({ confirmDelete: false }));

    expect(mockConfirmAction.calls[0].required).toBe(false);
  });
});

describe("openTaskContextMenu", () => {
  const event = new MouseEvent("contextmenu");

  it("offers add, move and delete, in that order, at the pointer", () => {
    openTaskContextMenu(APP, event, options());

    const menu = MockMenu.instances[0];
    expect(menu.items.map((i) => i.title)).toEqual(["Add subtask", "Move task…", "Delete task"]);
    expect(menu.items.map((i) => i.icon))
      .toEqual([Icon.AddSubtask, Icon.MoveTask, Icon.DeleteTask]);
    expect(menu.shownAt).toBe(event);
  });

  it("puts what a view has of its own between adding and moving", () => {
    const opts = options();

    openTaskContextMenu(APP, event, {
      ...opts,
      extraItems: (menu, task) => {
        expect(task).toBe(opts.task);
        menu.addItem((item) => item.setTitle("Wait on a task outside…").setIcon(Icon.AddDependency).onClick(() => {}));
      },
    });

    expect(MockMenu.instances[0].items.map((i) => i.title))
      .toEqual(["Add subtask", "Wait on a task outside…", "Move task…", "Delete task"]);
  });

  it("runs the action each entry stands for", () => {
    const opts = options();
    openTaskContextMenu(APP, event, opts);
    const [add, move, remove] = MockMenu.instances[0].items;

    add.click?.();
    expect(MockTaskModal.instances).toHaveLength(1);

    move.click?.();
    expect(mockOpenMoveTaskModal).toHaveBeenCalledOnce();

    remove.click?.();
    expect(mockConfirmAction.calls).toHaveLength(1);
  });
});
