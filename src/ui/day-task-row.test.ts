// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills (same pattern as dashboard-view-rendering.test.ts)
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);

  type CreateElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
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
  bagOf(window).activeDocument = document;
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockConfirmAction, mockUpdateSubLines, mockUpdateTitle, mockOpenDatePicker, renderMarkdownMock } = vi.hoisted(() => {
  // Records what was asked without asking: each test either reads the message or runs the
  // confirmed action itself.
  const confirmCalls: Array<{ required: boolean; message: string; onConfirm: () => void }> = [];
  const mockConfirmAction = Object.assign(
    (_app: unknown, required: boolean, message: string, onConfirm: () => void) => {
      confirmCalls.push({ required, message, onConfirm });
    },
    { calls: confirmCalls },
  );
  return {
    mockConfirmAction,
    mockUpdateSubLines: vi.fn<(filePath: string | null, item: Task, detailText: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    mockUpdateTitle: vi.fn<(filePath: string | null, item: Task, newTitle: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    mockOpenDatePicker: vi.fn<typeof import("./date-picker").openDatePicker>(),
    // Obsidian's renderer, standing in for the real markdown pass: the wrapping <p> is what
    // `renderInlineMarkdown` has to take back off.
    renderMarkdownMock: vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
      const p = document.createElement("p");
      p.textContent = markdown;
      el.appendChild(p);
    }),
  };
});

vi.mock("./date-picker", () => ({ openDatePicker: mockOpenDatePicker }));

vi.mock("obsidian", () => ({
  App: class {},
  Component: class { load() {} unload() {} },
  MarkdownRenderer: { render: renderMarkdownMock },
  setIcon: () => {},
  moment: (...args: unknown[]) => ({
    _args: args,
    format: () => "2026-07-01",
  }),
}));

vi.mock("./task-creator", () => ({
  confirmAction: mockConfirmAction,
}));

import { Component } from "obsidian";
import { Task } from "../model/daily/task";
import { asApp } from "../model/__testing__/as-app";
import {
  appendActionButton,
  migrateNoteKey,
  renderInlineMarkdown,
  renderNoteChevron,
  appendNoteActionButton,
  attachActionsTapToggle,
  appendRescheduleButton,
  renderTaskTitle,
  appendEditTitleButton,
  dayTaskTitleEdit,
} from "./day-task-row";
import type { TaskService } from "../model/service/task-service";

function task(rawLine: string, subLines: string[] = []): Task {
  // Sourced: a row's open-note key is its note's path and its line, and every write it
  // makes goes to the note the line says it is in.
  return Task.parse(rawLine, 0)!.withSubLines(subLines).withSource("f.md");
}

const APP = {} as never;

/** The slice of the store a row writes through. */
const STORE = {
  updateChecklistItemNote: (item: Task, text: string) =>
    mockUpdateSubLines(item.filePath, item, text),
  updateChecklistItemTitle: (item: Task, title: string) =>
    mockUpdateTitle(item.filePath, item, title),
} as unknown as TaskService;
const COMPONENT = {} as never;

// ---------------------------------------------------------------------------
// migrateNoteKey
// ---------------------------------------------------------------------------

describe("migrateNoteKey", () => {
  it("moves the key from the old rawLine to the new one when present", () => {
    const keys = new Set(["f.md::- [ ] Old"]);
    migrateNoteKey(keys, task("- [ ] Old"), "- [ ] Old", "- [ ] New");
    expect(keys.has("f.md::- [ ] Old")).toBe(false);
    expect(keys.has("f.md::- [ ] New")).toBe(true);
  });

  it("does nothing when the old key isn't present", () => {
    const keys = new Set<string>();
    migrateNoteKey(keys, task("- [ ] Old"), "- [ ] Old", "- [ ] New");
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderNoteChevron
// ---------------------------------------------------------------------------

describe("renderNoteChevron", () => {
  function setup(item: Task, openNoteKeys = new Set<string>()) {
    const mainLine = document.createElement("div");
    const row = document.createElement("div");
    const onSaved = vi.fn();
    renderNoteChevron(mainLine, row, item, APP, STORE, COMPONENT, openNoteKeys, onSaved);
    return { mainLine, row, onSaved, openNoteKeys };
  }

  it("renders nothing when the task has no sub-lines", () => {
    const { mainLine } = setup(task("- [ ] Task"));
    expect(mainLine.querySelector(".pm-day-task-comment-toggle")).toBeNull();
  });

  it("renders a collapsed toggle when the task has sub-lines and the key isn't open", () => {
    const { mainLine, row } = setup(task("- [ ] Task", ["a note"]));
    const toggle = mainLine.querySelector(".pm-day-task-comment-toggle")!;
    expect(toggle.classList.contains("pm-dash-section-chevron--collapsed")).toBe(true);
    expect(row.querySelector(".pm-day-task-file-panel")).toBeNull();
  });

  it("opens the note panel immediately when the key is already in openNoteKeys", () => {
    const item = task("- [ ] Task", ["a note"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { mainLine, row } = setup(item, keys);
    expect(mainLine.querySelector(".pm-dash-section-chevron--collapsed")).toBeNull();
    expect(row.querySelector(".pm-day-task-file-panel")).not.toBeNull();
  });

  it("toggles the panel open and closed on click, updating openNoteKeys", () => {
    const item = task("- [ ] Task", ["a note"]);
    const { mainLine, row, openNoteKeys } = setup(item);
    const toggle = mainLine.querySelector(".pm-day-task-comment-toggle") as HTMLElement;
    const key = `f.md::${item.rawLine}`;

    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.querySelector(".pm-day-task-file-panel")).not.toBeNull();
    expect(openNoteKeys.has(key)).toBe(true);

    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.querySelector(".pm-day-task-file-panel")).toBeNull();
    expect(openNoteKeys.has(key)).toBe(false);
  });

  it("renders each dedented sub-line as markdown in the view panel", () => {
    const item = task("- [ ] Task", ["  line one", "  line two"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { row } = setup(item, keys);
    const lines = row.querySelectorAll(".pm-day-task-file-line");
    expect(lines).toHaveLength(2);
  });

  it("ignores blank lines when computing the common indent to strip", () => {
    const item = task("- [ ] Task", ["  line one", "", "  line two"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { row } = setup(item, keys);
    const lines = row.querySelectorAll(".pm-day-task-file-line");
    expect(lines).toHaveLength(3);
    expect(lines[0].textContent).toBe("line one");
  });

  it("switches to an editable textarea on Edit-button click, pre-filled with dedented text", () => {
    const item = task("- [ ] Task", ["  hello"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { row } = setup(item, keys);
    const editBtn = row.querySelector(".pm-day-task-file-edit-btn") as HTMLElement;
    editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const textarea = row.querySelector(".pm-day-task-file-textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe("hello");
  });

  it("saves the textarea's trimmed value via updateSubLines when blurred alone", async () => {
    mockUpdateSubLines.mockClear();
    const item = task("- [ ] Task", ["  hello"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { row, onSaved } = setup(item, keys);
    const editBtn = row.querySelector(".pm-day-task-file-edit-btn") as HTMLElement;
    editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const textarea = row.querySelector(".pm-day-task-file-textarea") as HTMLTextAreaElement;
    textarea.value = "  updated text  ";
    textarea.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateSubLines).toHaveBeenCalledWith("f.md", item, "updated text");
    expect(onSaved).toHaveBeenCalled();
  });

  it("does not save on plain Enter (leaves it to insert a newline) or Ctrl/Cmd+Enter (no in-place commit key, to avoid Obsidian hotkey conflicts)", () => {
    mockUpdateSubLines.mockClear();
    const item = task("- [ ] Task", ["  hello"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { row } = setup(item, keys);
    const editBtn = row.querySelector(".pm-day-task-file-edit-btn") as HTMLElement;
    editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const textarea = row.querySelector(".pm-day-task-file-textarea") as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    expect(mockUpdateSubLines).not.toHaveBeenCalled();
  });

  it("reverts without saving on Escape", () => {
    mockUpdateSubLines.mockClear();
    const item = task("- [ ] Task", ["  hello"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { row } = setup(item, keys);
    document.body.appendChild(row); // Escape relies on a real `blur()`, which jsdom only fires for attached, focused elements.
    const editBtn = row.querySelector(".pm-day-task-file-edit-btn") as HTMLElement;
    editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const textarea = row.querySelector(".pm-day-task-file-textarea") as HTMLTextAreaElement;
    textarea.value = "changed";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockUpdateSubLines).not.toHaveBeenCalled();
    expect(row.querySelector(".pm-day-task-file-textarea")).toBeNull();
    row.remove();
  });

  it("stops a click inside the panel from bubbling to the row", () => {
    const item = task("- [ ] Task", ["a note"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { row } = setup(item, keys);
    const rowClickSpy = vi.fn();
    row.addEventListener("click", rowClickSpy);
    const panel = row.querySelector(".pm-day-task-file-panel") as HTMLElement;
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rowClickSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// appendActionButton
// ---------------------------------------------------------------------------

describe("appendActionButton", () => {
  const build = (spec: Partial<Parameters<typeof appendActionButton>[1]> = {}) => {
    const actions = document.createElement("div");
    const btn = appendActionButton(actions, {
      icon: "trash" as never, label: "Delete", onClick: () => {}, ...spec,
    });
    return { actions, btn };
  };

  it("labels the button and titles it the same unless told otherwise", () => {
    const { btn } = build();
    expect(btn.getAttribute("aria-label")).toBe("Delete");
    expect(btn.getAttribute("title")).toBe("Delete");
  });

  it("takes a title saying more than the label", () => {
    const { btn } = build({ label: "Move to inbox", title: "Move to inbox — clears the deadline" });
    expect(btn.getAttribute("aria-label")).toBe("Move to inbox");
    expect(btn.getAttribute("title")).toBe("Move to inbox — clears the deadline");
  });

  it("tints only a destructive action", () => {
    expect(build().btn.className).toBe("pm-task-action-btn");
    expect(build({ danger: true }).btn.className).toContain("pm-task-action-btn--delete");
  });

  // Every one of these sits on a row that answers a click of its own.
  it("stops the click reaching the row under it", () => {
    const row = document.createElement("div");
    const onRow = vi.fn();
    row.addEventListener("click", onRow);
    const onClick = vi.fn();
    const btn = appendActionButton(row.appendChild(document.createElement("div")), {
      icon: "trash" as never, label: "Delete", onClick,
    });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onRow).not.toHaveBeenCalled();
  });

  it("hands the button back, so a caller can anchor a popup to it", () => {
    const { actions, btn } = build();
    expect(btn).toBe(actions.querySelector("button"));
  });
});

// ---------------------------------------------------------------------------
// appendNoteActionButton
// ---------------------------------------------------------------------------

describe("appendNoteActionButton", () => {
  function setup(item: Task, openNoteKeys = new Set<string>(), confirmRemoval = true) {
    const actions = document.createElement("div");
    const row = document.createElement("div");
    const onSaved = vi.fn();
    appendNoteActionButton(actions, row, item, APP, STORE, openNoteKeys, confirmRemoval, onSaved);
    return { actions, row, onSaved, openNoteKeys };
  }

  it("shows 'Add note' for a task with no sub-lines", () => {
    const { actions } = setup(task("- [ ] Task"));
    const btn = actions.querySelector(".pm-task-action-btn")!;
    expect(btn.getAttribute("aria-label")).toBe("Add note");
  });

  it("opens an edit panel and marks the key open when 'Add note' is clicked", () => {
    const item = task("- [ ] Task");
    const { actions, row, openNoteKeys } = setup(item);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.querySelector(".pm-day-task-file-textarea")).not.toBeNull();
    expect(openNoteKeys.has(`f.md::${item.rawLine}`)).toBe(true);
  });

  it("saves the new note when blurred alone", async () => {
    mockUpdateSubLines.mockClear();
    const item = task("- [ ] Task");
    const { actions, row, onSaved } = setup(item);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const textarea = row.querySelector(".pm-day-task-file-textarea") as HTMLTextAreaElement;
    textarea.value = "new note";
    textarea.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateSubLines).toHaveBeenCalledWith("f.md", item, "new note");
    expect(onSaved).toHaveBeenCalled();
  });

  it("removes the panel and the open-key when the new note is cancelled via Escape", () => {
    mockUpdateSubLines.mockClear();
    const item = task("- [ ] Task");
    const { actions, row, openNoteKeys } = setup(item);
    document.body.appendChild(row); // Escape relies on a real `blur()`, which jsdom only fires for attached, focused elements.
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const textarea = row.querySelector(".pm-day-task-file-textarea") as HTMLTextAreaElement;
    textarea.value = "unsaved";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockUpdateSubLines).not.toHaveBeenCalled();
    expect(row.querySelector(".pm-day-task-file-panel")).toBeNull();
    expect(openNoteKeys.has(`f.md::${item.rawLine}`)).toBe(false);
    row.remove();
  });

  it("shows 'Remove note' for a task that already has sub-lines", () => {
    const { actions } = setup(task("- [ ] Task", ["a note"]));
    const btn = actions.querySelector(".pm-task-action-btn")!;
    expect(btn.getAttribute("aria-label")).toBe("Remove note");
  });

  it("warns about nested checklist items when the sub-lines include one", () => {
    const item = task("- [ ] Task", ["- [ ] nested item"]);
    const { actions } = setup(item);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockConfirmAction.calls.at(-1)!.message).toContain("also deletes nested checklist items");
  });

  it("does not warn about nested checklist items for plain text notes", () => {
    const item = task("- [ ] Task", ["just a note"]);
    const { actions } = setup(item);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockConfirmAction.calls.at(-1)!.message).toBe('Remove note from "Task"?');
  });

  it("clears the note and the open-key when the removal is confirmed", async () => {
    mockUpdateSubLines.mockClear();
    const item = task("- [ ] Task", ["a note"]);
    const keys = new Set([`f.md::${item.rawLine}`]);
    const { actions, onSaved, openNoteKeys } = setup(item, keys);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    mockConfirmAction.calls.at(-1)!.onConfirm();
    await Promise.resolve();
    await Promise.resolve();
    expect(openNoteKeys.has(`f.md::${item.rawLine}`)).toBe(false);
    expect(mockUpdateSubLines).toHaveBeenCalledWith("f.md", item, "");
    expect(onSaved).toHaveBeenCalled();
  });

  it("asks nothing when the confirmation is turned off", () => {
    const item = task("- [ ] Task", ["a note"]);
    const { actions } = setup(item, new Set<string>(), false);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockConfirmAction.calls.at(-1)!.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attachActionsTapToggle
// ---------------------------------------------------------------------------

describe("attachActionsTapToggle", () => {
  it("opens the row on tap and registers an outside-click closer", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    attachActionsTapToggle(row);

    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.classList.contains("pm-task-row--open")).toBe(true);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.classList.contains("pm-task-row--open")).toBe(false);

    row.remove();
  });

  it("closes the row again on a second tap without needing an outside click", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    attachActionsTapToggle(row);

    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.classList.contains("pm-task-row--open")).toBe(true);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.classList.contains("pm-task-row--open")).toBe(false);

    row.remove();
  });

  it("ignores taps that land inside the actions toolbar", () => {
    const row = document.createElement("div");
    const actions = document.createElement("div");
    actions.className = "pm-task-actions";
    row.appendChild(actions);
    attachActionsTapToggle(row);

    actions.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(row.classList.contains("pm-task-row--open")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendRescheduleButton
// ---------------------------------------------------------------------------

describe("appendRescheduleButton", () => {
  it("uses default labels when none are given", () => {
    const parent = document.createElement("div");
    appendRescheduleButton(parent, () => {});
    const btn = parent.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("Reschedule");
    expect(btn.getAttribute("title")).toBe("Reschedule to another day");
  });

  it("uses custom labels when given", () => {
    const parent = document.createElement("div");
    appendRescheduleButton(parent, () => {}, { ariaLabel: "Snooze", title: "Snooze to a day" });
    const btn = parent.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("Snooze");
  });

  it("opens the date picker on button click, wired to onDate", () => {
    mockOpenDatePicker.mockClear();
    const parent = document.createElement("div");
    const onDate = vi.fn();
    appendRescheduleButton(parent, onDate);
    const btn = parent.querySelector("button") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker).toHaveBeenCalledOnce();
    const [anchor, opts] = mockOpenDatePicker.mock.calls[0];
    expect(anchor).toBe(btn);
    // The picker forwards the chosen day straight to onDate.
    const picked = new Date("2026-07-01T00:00:00.000Z");
    opts.onPick(picked);
    expect(onDate).toHaveBeenCalledWith(picked);
  });

  it("stops the button click from bubbling to the row", () => {
    mockOpenDatePicker.mockClear();
    const parent = document.createElement("div");
    const rowClick = vi.fn();
    parent.addEventListener("click", rowClick);
    appendRescheduleButton(parent, () => {});
    const btn = parent.querySelector("button") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("seeds the picker with the given initial date", () => {
    mockOpenDatePicker.mockClear();
    const parent = document.createElement("div");
    const initial = { _tag: "moment" };
    appendRescheduleButton(parent, () => {}, undefined, initial as never);
    const btn = parent.querySelector("button") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker.mock.calls[0][1].initial).toBe(initial);
  });

  it("passes no initial date when none is given", () => {
    mockOpenDatePicker.mockClear();
    const parent = document.createElement("div");
    appendRescheduleButton(parent, () => {});
    const btn = parent.querySelector("button") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker.mock.calls[0][1].initial).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// renderTaskTitle / appendEditTitleButton (title editing)
// ---------------------------------------------------------------------------

describe("renderTaskTitle + appendEditTitleButton", () => {
  function setup(item: Task) {
    const container = document.createElement("div");
    const actions = document.createElement("div");
    const openNoteKeys = new Set<string>();
    const onSaved = vi.fn();
    const span = renderTaskTitle(container, "Display text", APP, COMPONENT, "pm-title");
    appendEditTitleButton(
      actions, container, span,
      dayTaskTitleEdit(item, STORE, "pm-title", openNoteKeys, onSaved),
    );
    return { container, actions, span, openNoteKeys, onSaved };
  }

  it("renders the title span with the given class", () => {
    const { span } = setup(task("- [ ] Task"));
    expect(span.classList.contains("pm-title")).toBe(true);
  });

  it("swaps the span for a pre-filled input on Edit-title click", () => {
    const { container, actions } = setup(task("- [ ] Original title"));
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    expect(input.value).toBe("Original title");
  });

  it("reverts to the span without saving when blurred unchanged", () => {
    const { container, actions, span } = setup(task("- [ ] Original title"));
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("blur"));
    expect(container.contains(span)).toBe(true);
    expect(container.querySelector("input.pm-task-title-input")).toBeNull();
  });

  it("reverts to the span without saving when blurred with an empty value", () => {
    const { container, actions } = setup(task("- [ ] Original title"));
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(container.querySelector("input.pm-task-title-input")).toBeNull();
    expect(mockUpdateTitle).not.toHaveBeenCalled();
  });

  it("saves via updateTitle when blurred alone with a changed value (no explicit Enter)", async () => {
    mockUpdateTitle.mockClear();
    const item = task("- [ ] Original title");
    const openNoteKeys = new Set([`f.md::${item.rawLine}`]);
    const container = document.createElement("div");
    const actions = document.createElement("div");
    const onSaved = vi.fn();
    const span = renderTaskTitle(container, "Original title", APP, COMPONENT, "pm-title");
    appendEditTitleButton(
      actions, container, span,
      dayTaskTitleEdit(item, STORE, "pm-title", openNoteKeys, onSaved),
    );
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    input.value = "New title";
    input.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateTitle).toHaveBeenCalledWith("f.md", item, "New title");
    expect(onSaved).toHaveBeenCalled();
  });

  it("saves via updateTitle and migrates the note key when committed with Enter", async () => {
    mockUpdateTitle.mockClear();
    const item = task("- [ ] Original title");
    const openNoteKeys = new Set([`f.md::${item.rawLine}`]);
    const container = document.createElement("div");
    const actions = document.createElement("div");
    const onSaved = vi.fn();
    document.body.appendChild(container); // Enter forces a real `blur()`, which jsdom only fires for attached, focused elements.
    const span = renderTaskTitle(container, "Original title", APP, COMPONENT, "pm-title");
    appendEditTitleButton(
      actions, container, span,
      dayTaskTitleEdit(item, STORE, "pm-title", openNoteKeys, onSaved),
    );
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    const oldRawLine = item.rawLine;
    input.value = "New title";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateTitle).toHaveBeenCalledWith("f.md", item, "New title");
    expect(onSaved).toHaveBeenCalled();
    expect(openNoteKeys.has(`f.md::${oldRawLine}`)).toBe(false);
    container.remove();
  });

  it("stops a click on the input from bubbling", () => {
    const { container, actions } = setup(task("- [ ] Original title"));
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    const containerClickSpy = vi.fn();
    container.addEventListener("click", containerClickSpy);
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(containerClickSpy).not.toHaveBeenCalled();
  });

  it("commits the edit on Enter", () => {
    const { container, actions } = setup(task("- [ ] Original title"));
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    const blurSpy = vi.spyOn(input, "blur");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(blurSpy).toHaveBeenCalledOnce();
  });

  it("reverts to the span without saving on Escape", () => {
    mockUpdateTitle.mockClear();
    const { container, actions, span } = setup(task("- [ ] Original title"));
    document.body.appendChild(container); // Escape relies on a real `blur()`, which jsdom only fires for attached, focused elements.
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    input.value = "Something else";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockUpdateTitle).not.toHaveBeenCalled();
    expect(container.contains(span)).toBe(true);
    expect(container.querySelector("input.pm-task-title-input")).toBeNull();
    container.remove();
  });

  it("hides the actions toolbar while editing so it can't cover the input", () => {
    const { container, actions, span } = setup(task("- [ ] Original title"));
    document.body.appendChild(container);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.classList.contains("pm-task-row--editing")).toBe(true);

    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(container.classList.contains("pm-task-row--editing")).toBe(false);
    expect(container.contains(span)).toBe(true);
    container.remove();
  });

  it("hides the add-task bar for the duration of the edit", () => {
    const listRoot = document.createElement("div");
    listRoot.className = "pm-dash-content";
    document.body.appendChild(listRoot);
    const { container, actions } = setup(task("- [ ] Original title"));
    listRoot.appendChild(container);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(listRoot.classList.contains("pm-title-editing")).toBe(true);

    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(listRoot.classList.contains("pm-title-editing")).toBe(false);
    listRoot.remove();
  });

  it("brings the add-task bar back once the edit is committed", async () => {
    mockUpdateTitle.mockClear();
    const listRoot = document.createElement("div");
    listRoot.className = "pm-dash-content";
    document.body.appendChild(listRoot);
    const { container, actions } = setup(task("- [ ] Original title"));
    listRoot.appendChild(container);
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    input.value = "New title";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await Promise.resolve();
    expect(mockUpdateTitle).toHaveBeenCalled();
    expect(listRoot.classList.contains("pm-title-editing")).toBe(false);
    // The row is still the input's: the re-render that puts the span back only lands
    // with the write.
    expect(container.classList.contains("pm-task-row--editing")).toBe(true);
    listRoot.remove();
  });

  it("ignores other keys", () => {
    const { container, actions } = setup(task("- [ ] Original title"));
    const btn = actions.querySelector(".pm-task-action-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector("input.pm-task-title-input") as HTMLInputElement;
    const blurSpy = vi.spyOn(input, "blur");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(blurSpy).not.toHaveBeenCalled();
  });
});

describe("renderInlineMarkdown", () => {
  async function render(text: string): Promise<HTMLElement> {
    const container = document.createElement("span");
    await renderInlineMarkdown(container, text, asApp({}), new Component());
    return container;
  }

  it("passes the text to MarkdownRenderer.render", async () => {
    await render("hello world");
    expect(renderMarkdownMock).toHaveBeenCalledWith(expect.anything(), "hello world", expect.any(HTMLElement), "", expect.anything());
  });

  it("unwraps the <p> wrapper added by MarkdownRenderer", async () => {
    const el = await render("hello world");
    expect(el.querySelector("p")).toBeNull();
    expect(el.textContent).toBe("hello world");
  });

  it("marks the container before rendering, so the wrapper never adds a paragraph's height", async () => {
    const container = document.createElement("span");
    const pending = renderInlineMarkdown(container, "hello world", asApp({}), new Component());
    expect(container.classList.contains("pm-inline-md")).toBe(true);
    await pending;
    expect(container.classList.contains("pm-inline-md")).toBe(true);
  });
});
