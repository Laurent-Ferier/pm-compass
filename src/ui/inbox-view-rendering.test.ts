// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills (same as dashboard-view-rendering.test.ts — Obsidian
// extends HTMLElement with createEl/createDiv/etc. that jsdom doesn't provide)
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  const htmlProto = HTMLElement.prototype as any;

  type CreateElOpts = {
    cls?: string;
    text?: string;
    type?: string;
    attr?: Record<string, string>;
  };

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
  htmlProto.createDiv = function(this: HTMLElement, opts?: CreateElOpts) {
    return (this as any).createEl("div", opts);
  };
  htmlProto.createSpan = function(this: HTMLElement, opts?: CreateElOpts) {
    return (this as any).createEl("span", opts);
  };
  htmlProto.addClass = function(this: HTMLElement, cls: string) {
    this.classList.add(cls);
  };
  htmlProto.toggleClass = function(this: HTMLElement, cls: string, force?: boolean) {
    this.classList.toggle(cls, force);
  };
  htmlProto.setText = function(this: HTMLElement, text: string) {
    this.textContent = text;
  };
  htmlProto.empty = function(this: HTMLElement) {
    this.innerHTML = "";
  };
  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  (window as any).activeDocument = document;
  (window as any).activeWindow = window;
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Module mocks (must be before the imports that trigger them)
// ---------------------------------------------------------------------------

const { NoticeMock, mockMoment } = vi.hoisted(() => {
  function isoWeekStart(d: Date): Date {
    const day = d.getDay();
    const isoWeekday = day === 0 ? 7 : day;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (isoWeekday - 1));
  }
  function makeMomentObj(d: Date) {
    const self = {
      _d: new Date(d),
      startOf(unit: string) {
        if (unit === "isoWeek") return makeMomentObj(isoWeekStart(self._d));
        if (unit === "day") {
          return makeMomentObj(new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate()));
        }
        throw new Error(`unsupported unit ${unit}`);
      },
      diff(other: { _d: Date }, unit: string) {
        if (unit === "days") return Math.round((self._d.getTime() - other._d.getTime()) / 86_400_000);
        throw new Error(`unsupported unit ${unit}`);
      },
      add(amount: number, unit: string) {
        if (unit === "weeks") {
          const nd = new Date(self._d);
          nd.setDate(nd.getDate() + amount * 7);
          return makeMomentObj(nd);
        }
        throw new Error(`unsupported unit ${unit}`);
      },
      endOf(unit: string) {
        if (unit === "isoWeek") {
          const start = isoWeekStart(self._d);
          return makeMomentObj(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999));
        }
        throw new Error(`unsupported unit ${unit}`);
      },
      isAfter(other: { _d: Date }, unit: string) {
        if (unit === "day") {
          const a = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate());
          const b = new Date(other._d.getFullYear(), other._d.getMonth(), other._d.getDate());
          return a.getTime() > b.getTime();
        }
        return self._d.getTime() > other._d.getTime();
      },
      isBefore(other: { _d: Date }, unit: string) {
        if (unit === "day") {
          const a = new Date(self._d.getFullYear(), self._d.getMonth(), self._d.getDate());
          const b = new Date(other._d.getFullYear(), other._d.getMonth(), other._d.getDate());
          return a.getTime() < b.getTime();
        }
        return self._d.getTime() < other._d.getTime();
      },
      format: (fmt?: string) => {
        if (fmt === "YYYY-MM-DD") return `${self._d.getFullYear()}-${String(self._d.getMonth() + 1).padStart(2, "0")}-${String(self._d.getDate()).padStart(2, "0")}`;
        if (fmt === "MMM D") return `${self._d.getMonth() + 1}/${self._d.getDate()}`;
        if (fmt === "MMM D, YYYY") return `${self._d.getMonth() + 1}/${self._d.getDate()}/${self._d.getFullYear()}`;
        if (fmt === "YYYY") return String(self._d.getFullYear());
        return self._d.toISOString();
      },
    };
    return self;
  }
  function mockMoment(...args: unknown[]) {
    if (args.length === 0) return makeMomentObj(new Date());
    const arg = args[0];
    if (arg instanceof Date) return makeMomentObj(arg);
    const [y, m, d] = (arg as string).split("-").map(Number);
    return makeMomentObj(new Date(y, m - 1, d));
  }
  return { NoticeMock: vi.fn(), mockMoment };
});

vi.mock("obsidian", () => ({
  App: class {},
  Component: class { load() {} unload() {} },
  MarkdownRenderer: {
    render: vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
      const p = document.createElement("p");
      p.textContent = markdown;
      el.appendChild(p);
    }),
  },
  setIcon: () => {},
  Menu: class { addItem() { return this; } showAtMouseEvent() {} },
  // MoveTargetModal (reached via the promote button) extends Modal.
  Modal: class { open() {} close() {} },
  Notice: NoticeMock,
  moment: Object.assign(mockMoment, { isMoment: () => false }),
}));

vi.mock("./task-creator", async (importOriginal) => ({
  // Spread the original so value exports (enums the callers branch on)
  // survive the mock; only the behaviours below are replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  TaskModal: class {},
  ConfirmModal: class {
    constructor(_app: unknown, _msg: string, private onConfirm: () => void) {}
    open() { this.onConfirm(); }
  },
  patchTaskField: vi.fn(),
  deleteTaskFile: vi.fn(),
  openDropdown: vi.fn(),
  openNoteFile: vi.fn(),
}));

const { ensureNoteMock } = vi.hoisted(() => ({ ensureNoteMock: vi.fn() }));
vi.mock("../model/operations/file-helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("../model/operations/file-helpers")>(),
  ensureNote: ensureNoteMock,
}));

vi.mock("./task-graph-view", () => ({
  TASK_GRAPH_VIEW_TYPE: "pm-compass-task-graph",
  TaskGraphView: class {},
}));

const { mockOpenDatePicker } = vi.hoisted(() => ({ mockOpenDatePicker: vi.fn() }));
vi.mock("./date-picker", () => ({
  openDatePicker: (...args: unknown[]) => mockOpenDatePicker(...args),
}));

const {
  appendInboxItemMock, closeInboxItemMock, scheduleInboxItemMock, removeInboxItemMock,
  setChecklistItemPriorityMock, reorderChecklistItemMock, unscheduleInboxItemMock,
} = vi.hoisted(() => ({
  appendInboxItemMock: vi.fn().mockResolvedValue(undefined),
  closeInboxItemMock: vi.fn().mockResolvedValue(undefined),
  scheduleInboxItemMock: vi.fn().mockResolvedValue(undefined),
  removeInboxItemMock: vi.fn().mockResolvedValue(undefined),
  setChecklistItemPriorityMock: vi.fn().mockResolvedValue(undefined),
  reorderChecklistItemMock: vi.fn().mockResolvedValue(undefined),
  unscheduleInboxItemMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../model/daily/day-task-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model/daily/day-task-actions")>();
  return {
    ...actual,
    appendInboxItem: appendInboxItemMock,
    closeInboxItem: closeInboxItemMock,
    scheduleInboxItem: scheduleInboxItemMock,
    removeInboxItem: removeInboxItemMock,
    setChecklistItemPriority: setChecklistItemPriorityMock,
    reorderChecklistItem: reorderChecklistItemMock,
    unscheduleInboxItem: unscheduleInboxItemMock,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Component } from "obsidian";
import { InboxView } from "./inbox-view";
import { openDropdown, openNoteFile } from "./task-creator";
import { DayTask } from "../model/daily/day-task";
import { formatDate } from "../model/dates";
import { day } from "../model/__testing__/dates";
import { type Project } from "../model/project/project";
import { Task, type TaskFields } from "../model/project/task";
import { PRIORITY_COLORS, Priority } from "../model/base-task";
import { TaskSortKey, TaskSortDir } from "../model/settings";
import { ScheduleOutcome } from "../model/daily/day-task-actions";
import { dragHandle, pointerEvent } from "./__testing__/drag-pointer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeView(
  sortBy: TaskSortKey = TaskSortKey.Created,
  sortDir: Partial<Record<TaskSortKey, TaskSortDir>> = {},
  hidePlanned = false,
) {
  const plugin = {
    settings: {
      dailyHabitsTag: "daily",
      dailyTasksHeading: "# Tasks", projectsFolder: "Projects",
      inboxSortBy: sortBy, inboxSortDir: sortDir, inboxHidePlanned: hidePlanned,
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  const view = Object.create(InboxView.prototype);
  view.app = {};
  view.plugin = plugin;
  view.openNoteKeys = new Set<string>();
  // The per-pass markdown owner, a field initializer Object.create skips.
  view.renderHost = new Component();
  view.allTasks = [];
  view.onRefresh = vi.fn();
  view.showDay = vi.fn();
  return view;
}

async function renderInbox(
  items: DayTask[],
  staleAfterDays = 0,
  projects: Project[] = [],
  sortBy: TaskSortKey = TaskSortKey.Created,
  sortDir: Partial<Record<TaskSortKey, TaskSortDir>> = {},
  hidePlanned = false,
) {
  const container = document.createElement("div");
  const view = makeView(sortBy, sortDir, hidePlanned);
  await view.render(container, "Daily Notes/Inbox.md", items, staleAfterDays, projects);
  return { container, view };
}

const promoteButtons = (container: HTMLElement) =>
  [...container.querySelectorAll('[aria-label="Promote to project task"]')];

const TODAY = "2026-06-30";

function daysAgoTask(title: string, daysAgo: number, extraTags = ""): DayTask {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return DayTask.parse(`- [ ] ${title}${extraTags} ➕ ${y}-${m}-${day}`, 0)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TODAY));
  appendInboxItemMock.mockClear();
  closeInboxItemMock.mockClear();
  scheduleInboxItemMock.mockClear();
  removeInboxItemMock.mockClear();
  setChecklistItemPriorityMock.mockClear();
  reorderChecklistItemMock.mockClear();
  unscheduleInboxItemMock.mockClear();
  mockOpenDatePicker.mockClear();
  ensureNoteMock.mockReset().mockResolvedValue({ path: "Daily Notes/Inbox.md" });
  vi.mocked(openNoteFile).mockClear();
  vi.mocked(openDropdown).mockClear();
  NoticeMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("InboxView.render — empty state", () => {
  it("shows an empty-state message when there are no items", async () => {
    const { container } = await renderInbox([]);
    expect(container.textContent).toContain("Inbox is empty");
  });
});

// ---------------------------------------------------------------------------
// Link to the inbox note itself
// ---------------------------------------------------------------------------

describe("InboxView.render — inbox file link", () => {
  const clickLink = async (container: HTMLElement, init: MouseEventInit = {}) => {
    const link = container.querySelector<HTMLElement>(".pm-inbox-file-link")!;
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    await vi.waitFor(() => expect(ensureNoteMock).toHaveBeenCalled());
    await Promise.resolve();
  };

  // The note only exists once something has been added to the inbox.
  it("creates the note, then opens it, and is there even when the inbox is empty", async () => {
    const { container } = await renderInbox([]);
    expect(container.querySelector(".pm-inbox-file-link")!.textContent).toContain("Inbox");
    await clickLink(container);
    expect(ensureNoteMock).toHaveBeenCalledWith(expect.anything(), "Daily Notes/Inbox.md");
    expect(vi.mocked(openNoteFile)).toHaveBeenCalledWith(expect.anything(), "Daily Notes/Inbox.md", false);
  });

  it("gives the note its own tab on a modifier-click", async () => {
    const { container } = await renderInbox([]);
    await clickLink(container, { ctrlKey: true });
    expect(vi.mocked(openNoteFile)).toHaveBeenCalledWith(expect.anything(), "Daily Notes/Inbox.md", true);
  });

  it("warns instead of opening when the note can't be created", async () => {
    ensureNoteMock.mockResolvedValue(null);
    const { container } = await renderInbox([]);
    await clickLink(container);
    expect(vi.mocked(openNoteFile)).not.toHaveBeenCalled();
    expect(NoticeMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tags: rendered inline in the title (via MarkdownRenderer, like in the note);
// only the configured habits tag is stripped, since it's shown as an icon instead.
// ---------------------------------------------------------------------------

describe("InboxView.render — tags", () => {
  it("keeps a non-habits tag inline in the title text", async () => {
    const item = DayTask.parse("- [ ] Call dentist #urgent", 0)!;
    const { container } = await renderInbox([item]);
    const title = container.querySelector(".pm-inbox-title");
    expect(title?.textContent).toBe("Call dentist #urgent");
  });

  it("strips the configured habits tag from the title text", async () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { container } = await renderInbox([item]);
    const title = container.querySelector(".pm-inbox-title");
    expect(title?.textContent).toBe("Morning routine");
  });

  it("shows the daily icon for habit-tagged items", async () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector(".pm-dash-checklist-daily-icon")).not.toBeNull();
  });

  it("does not show the daily icon for non-habit items", async () => {
    const item = DayTask.parse("- [ ] Call dentist #urgent", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector(".pm-dash-checklist-daily-icon")).toBeNull();
  });

  it("strips only the habits tag, keeping other tags inline, when both are present", async () => {
    const item = DayTask.parse("- [ ] Plan trip #daily #travel", 0)!;
    const { container } = await renderInbox([item]);
    const title = container.querySelector(".pm-inbox-title");
    expect(title?.textContent).toBe("Plan trip #travel");
  });

  it("hides the edit-title button for habit-tagged items", async () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector('[aria-label="Edit title"]')).toBeNull();
  });

  it("shows the edit-title button for regular items", async () => {
    const item = DayTask.parse("- [ ] Call dentist", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector('[aria-label="Edit title"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Age badge / stale warning
// ---------------------------------------------------------------------------

/** The chips in a row's trailing metadata band. The target day and the age share one
 *  component now (`renderMetaBadge`), so they are told apart by their content. */
function badges(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".pm-task-badges .pm-task-badge")];
}

function ageBadge(container: HTMLElement): HTMLElement | undefined {
  // "N d" once the day is past, "today" on the day itself — `daysLabel`'s wording, the
  // same one every date badge in the plugin uses.
  return badges(container).find((b) => /^(\d+ d|today)$/.test(b.textContent ?? ""));
}

function targetBadge(container: HTMLElement): HTMLElement | undefined {
  return badges(container).find((b) => b.textContent?.includes("⏳"));
}

describe("InboxView.render — age and staleness", () => {
  it("shows the age in days since creation", async () => {
    const item = daysAgoTask("Task", 5);
    const { container } = await renderInbox([item]);
    expect(ageBadge(container)?.textContent).toBe("5 d");
  });

  it("marks items older than 14 days as old, independent of the stale threshold", async () => {
    const item = daysAgoTask("Task", 15);
    const { container } = await renderInbox([item], 0);
    expect(ageBadge(container)?.classList.contains("pm-task-badge--danger")).toBe(true);
  });

  it("does not mark a 14-day-old item as old", async () => {
    const item = daysAgoTask("Task", 14);
    const { container } = await renderInbox([item], 0);
    expect(ageBadge(container)?.classList.contains("pm-task-badge--danger")).toBe(false);
  });

  it("shows the stale warning once past the configured threshold", async () => {
    const item = daysAgoTask("Task", 10);
    const { container } = await renderInbox([item], 7);
    const badge = ageBadge(container)!;
    expect(badge.querySelector(".pm-task-badge-icon")).not.toBeNull();
    expect(badge.classList.contains("pm-task-badge--warning")).toBe(true);
  });

  it("does not show the stale warning below the configured threshold", async () => {
    const item = daysAgoTask("Task", 5);
    const { container } = await renderInbox([item], 7);
    expect(ageBadge(container)!.querySelector(".pm-task-badge-icon")).toBeNull();
  });

  it("never shows the stale warning when the threshold is disabled (0)", async () => {
    const item = daysAgoTask("Task", 999);
    const { container } = await renderInbox([item], 0);
    expect(ageBadge(container)!.querySelector(".pm-task-badge-icon")).toBeNull();
  });

  it("keeps the age quiet on an item planned for a day, however old it is", async () => {
    const item = DayTask.parse(`- [ ] Task ➕ 2026-06-01 ⏳ 2026-07-20`, 0)!;
    const { container } = await renderInbox([item], 7);
    const badge = ageBadge(container)!;
    expect(badge.querySelector(".pm-task-badge-icon")).toBeNull();
    expect(badge.classList.contains("pm-task-badge--warning")).toBe(false);
    expect(badge.classList.contains("pm-task-badge--danger")).toBe(false);
  });

  it("shows the ⏳ target date of an item waiting for its day", async () => {
    const item = DayTask.parse("- [ ] Task ➕ 2026-06-01 ⏳ 2026-07-20", 0)!;
    const { container } = await renderInbox([item]);
    expect(targetBadge(container)).toBeDefined();
  });

  // The age badge goes quiet on a planned item, so a day that came and went with no note
  // reddens here instead — otherwise nothing on the row would ever say so.
  it("reddens the target badge once its day has gone by", async () => {
    const item = DayTask.parse("- [ ] Task ➕ 2026-06-01 ⏳ 2026-06-20", 0)!;
    const { container } = await renderInbox([item], 7);
    expect(targetBadge(container)!.classList.contains("pm-task-badge--danger")).toBe(true);
  });

  it("leaves the target badge plain while its day is still ahead", async () => {
    const item = DayTask.parse("- [ ] Task ➕ 2026-06-01 ⏳ 2026-07-20", 0)!;
    const { container } = await renderInbox([item], 7);
    expect(targetBadge(container)!.classList.contains("pm-task-badge--danger")).toBe(false);
  });

  it("shows no target badge for an item with no target date", async () => {
    const item = daysAgoTask("Task", 1);
    const { container } = await renderInbox([item]);
    expect(targetBadge(container)).toBeUndefined();
  });

  it("does not show an age badge for items without a creation date", async () => {
    const item = DayTask.parse("- [ ] No date task", 0)!;
    const { container } = await renderInbox([item]);
    expect(ageBadge(container)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Add-task bar
// ---------------------------------------------------------------------------

describe("InboxView.render — add-task bar", () => {
  it("does nothing on Enter with blank input", async () => {
    const { container } = await renderInbox([]);
    const input = container.querySelector<HTMLInputElement>(".pm-add-input")!;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(appendInboxItemMock).not.toHaveBeenCalled();
  });

  it("submits the trimmed title on Enter", async () => {
    const { container, view } = await renderInbox([]);
    const input = container.querySelector<HTMLInputElement>(".pm-add-input")!;
    input.value = "  New task  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(appendInboxItemMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", "New task");
  });

  it("clears and disables the input immediately, before the write resolves", async () => {
    let resolveAppend!: () => void;
    appendInboxItemMock.mockReturnValueOnce(new Promise<void>((resolve) => { resolveAppend = resolve; }));
    const { container } = await renderInbox([]);
    const input = container.querySelector<HTMLInputElement>(".pm-add-input")!;
    input.value = "New task";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    // Guards against double-submit: a second Enter before the write settles must not fire again.
    expect(input.value).toBe("");
    expect(input.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(appendInboxItemMock).toHaveBeenCalledTimes(1);

    resolveAppend();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(input.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Close checkbox
// ---------------------------------------------------------------------------

describe("InboxView.render — close checkbox", () => {
  it("closes the item and refreshes when the checkbox is checked", async () => {
    const item = daysAgoTask("Buy milk", 0);
    const { container, view } = await renderInbox([item]);
    // The same box the dashboard's rows use, so the two lists sit on one grid.
    const cb = container.querySelector<HTMLElement>(".pm-dash-checkbox")!;
    cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(closeInboxItemMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", item);
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("stops propagation on click so the row's tap-toggle doesn't also fire", async () => {
    const item = daysAgoTask("Buy milk", 0);
    const { container } = await renderInbox([item]);
    const cb = container.querySelector<HTMLElement>(".pm-dash-checkbox")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");
    cb.dispatchEvent(event);
    expect(stopSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Schedule (reschedule button)
// ---------------------------------------------------------------------------

describe("InboxView.render — schedule button", () => {
  /** Clicks the Schedule button and feeds the given date to the picker's onPick. */
  function pickDate(container: HTMLElement, dateStr: string): void {
    mockOpenDatePicker.mockClear();
    const btn = container.querySelector<HTMLButtonElement>("[aria-label='Schedule']")!;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const { onPick } = mockOpenDatePicker.mock.calls[0][1];
    onPick(day(dateStr));
  }

  it("schedules a non-habit item and refreshes", async () => {
    const item = daysAgoTask("Buy milk", 0);
    const { container, view } = await renderInbox([item]);
    pickDate(container, "2026-07-05");
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduleInboxItemMock).toHaveBeenCalledWith(
      view.app, "Daily Notes/Inbox.md", item, expect.anything(), "# Tasks",
    );
    expect(view.onRefresh).toHaveBeenCalled();
    expect(NoticeMock).not.toHaveBeenCalled();
  });

  it("tells the user the item is only targeted when the day took no task", async () => {
    scheduleInboxItemMock.mockResolvedValueOnce(ScheduleOutcome.Targeted);
    const item = daysAgoTask("Buy milk", 0);
    const { container } = await renderInbox([item]);
    const future = new Date();
    future.setDate(future.getDate() + 10);
    pickDate(container, formatDate(future));
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduleInboxItemMock).toHaveBeenCalled();
    expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining("once that daily note exists"));
  });

  it("says a past day with no note keeps the item in the inbox", async () => {
    scheduleInboxItemMock.mockResolvedValueOnce(ScheduleOutcome.Targeted);
    const item = daysAgoTask("Buy milk", 0);
    const { container } = await renderInbox([item]);
    const past = new Date();
    past.setDate(past.getDate() - 3);
    pickDate(container, formatDate(past));
    await Promise.resolve();
    await Promise.resolve();
    expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining("stays in the inbox"));
  });

  it("schedules a habit-tagged item like any other", async () => {
    const item = daysAgoTask("Morning routine", 0, " #daily");
    const { container, view } = await renderInbox([item]);
    pickDate(container, "2026-07-20");
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduleInboxItemMock).toHaveBeenCalledWith(
      view.app, "Daily Notes/Inbox.md", item, expect.anything(), "# Tasks",
    );
    expect(NoticeMock).not.toHaveBeenCalled();
  });
});

describe("InboxView.render — clearing a target date", () => {
  const planned = () => DayTask.parse("- [ ] Buy milk ➕ 2026-06-30 ⏳ 2026-07-20", 0)!;

  it("offers Clear in the picker only for an item that has a target date", async () => {
    const { container } = await renderInbox([planned(), daysAgoTask("Unplanned", 0)]);
    const buttons = [...container.querySelectorAll('[aria-label="Schedule"]')] as HTMLElement[];
    buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker.mock.calls[0][1].onClear).toBeTypeOf("function");
    buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker.mock.calls[1][1].onClear).toBeUndefined();
  });

  it("clears the target date and refreshes", async () => {
    const item = planned();
    const { container, view } = await renderInbox([item]);
    (container.querySelector('[aria-label="Schedule"]') as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    mockOpenDatePicker.mock.calls[0][1].onClear();
    await Promise.resolve();
    await Promise.resolve();
    expect(unscheduleInboxItemMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", item);
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("opens the picker on the item's target date", async () => {
    const { container } = await renderInbox([planned()]);
    (container.querySelector('[aria-label="Schedule"]') as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockOpenDatePicker.mock.calls[0][1].initial).toBeTruthy();
  });
});

describe("InboxView.render — hiding planned items", () => {
  const planned = () => DayTask.parse("- [ ] Buy milk ➕ 2026-06-30 ⏳ 2026-07-20", 0)!;

  it("lists every item while the filter is off", async () => {
    const { container } = await renderInbox([planned(), daysAgoTask("Triage me", 0)]);
    expect(container.querySelectorAll(".pm-inbox-row")).toHaveLength(2);
  });

  it("leaves out planned items while the filter is on", async () => {
    const { container } = await renderInbox(
      [planned(), daysAgoTask("Triage me", 0)], 0, [], TaskSortKey.Created, {}, true,
    );
    const titles = [...container.querySelectorAll(".pm-inbox-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Triage me"]);
  });

  it("says how many are hidden when the filter empties the list", async () => {
    const { container } = await renderInbox([planned()], 0, [], TaskSortKey.Created, {}, true);
    expect(container.querySelector(".pm-dash-empty")?.textContent).toContain("1 planned item");
    expect(container.querySelector(".pm-inbox-sort-bar")).not.toBeNull();
  });

  it("still says the inbox is empty when there is nothing at all", async () => {
    const { container } = await renderInbox([], 0, [], TaskSortKey.Created, {}, true);
    expect(container.querySelector(".pm-dash-empty")?.textContent).toBe("Inbox is empty");
  });

  it("turns the filter on and saves it", async () => {
    const { container, view } = await renderInbox([planned()]);
    (container.querySelector(".pm-inbox-filter-btn") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.plugin.settings.inboxHidePlanned).toBe(true);
    expect(view.plugin.saveSettings).toHaveBeenCalled();
  });

  it("turns it back off from the on state", async () => {
    const { container, view } = await renderInbox(
      [planned(), daysAgoTask("Triage me", 0)], 0, [], TaskSortKey.Created, {}, true,
    );
    (container.querySelector(".pm-inbox-filter-btn") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.plugin.settings.inboxHidePlanned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delete button
// ---------------------------------------------------------------------------

describe("InboxView.render — delete button", () => {
  it("removes the item and refreshes after confirming", async () => {
    const item = daysAgoTask("Buy milk", 0);
    const { container, view } = await renderInbox([item]);
    const deleteBtn = container.querySelector<HTMLButtonElement>(".pm-task-action-btn--delete")!;
    deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(removeInboxItemMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", item);
    expect(view.onRefresh).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Promote button
// ---------------------------------------------------------------------------

describe("promote to project task", () => {
  it("offers a promote button on a normal item", async () => {
    const { container } = await renderInbox([daysAgoTask("Write the report", 20)]);
    expect(promoteButtons(container)).toHaveLength(1);
  });

  it("does not offer it for a habit item", async () => {
    // Habits are regenerated from their definition; promoting one would strand it.
    const { container } = await renderInbox([daysAgoTask("Meditate", 3, " #daily")]);
    expect(promoteButtons(container)).toHaveLength(0);
  });

  it("opens the destination picker when clicked", async () => {
    const { container, view } = await renderInbox([daysAgoTask("Write the report", 20)]);
    const spy = vi.spyOn(view, "openPromoteModal" as never);
    (promoteButtons(container)[0] as HTMLElement).click();
    expect(spy).toHaveBeenCalled();
  });

  it("offers one per item", async () => {
    const { container } = await renderInbox([
      daysAgoTask("One", 20),
      daysAgoTask("Two", 5),
      daysAgoTask("Habit", 1, " #daily"),
    ]);
    expect(promoteButtons(container)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Priority ribbon and sort bar
// ---------------------------------------------------------------------------

describe("InboxView.render — priority", () => {
  it("colours the ribbon by the line's priority marker", async () => {
    const item = DayTask.parse("- [ ] Buy milk ⏫", 0)!;
    const { container } = await renderInbox([item]);
    const ribbon = container.querySelector<HTMLElement>(".pm-task-ribbon")!;
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe(PRIORITY_COLORS[Priority.High]);
    expect(ribbon.title).toBe("Priority: High");
  });

  it("leaves the ribbon uncoloured for a line with no priority", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item]);
    const ribbon = container.querySelector<HTMLElement>(".pm-task-ribbon")!;
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("");
    expect(ribbon.title).toBe("Priority: None");
  });

  it("names the checklist-only ⏬ level rather than reporting it as unset", async () => {
    const item = DayTask.parse("- [ ] Buy milk ⏬", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector<HTMLElement>(".pm-task-ribbon")!.title).toBe("Priority: Lowest");
  });

  it("opens the priority dropdown on click, writing the pick back to the line", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item]);
    container.querySelector<HTMLElement>(".pm-task-ribbon")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(openDropdown).toHaveBeenCalled();
    const options = vi.mocked(openDropdown).mock.calls[0][1];
    expect(options.map((o) => o.label)).toEqual(["None", "Critical", "High", "Medium", "Low"]);

    options.find((o) => o.label === "High")!.onSelect();
    await Promise.resolve();
    await Promise.resolve();
    expect(setChecklistItemPriorityMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", item, Priority.High);
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("stops the click from also toggling the row's actions toolbar", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item]);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");
    container.querySelector<HTMLElement>(".pm-task-ribbon")!.dispatchEvent(event);
    expect(stopSpy).toHaveBeenCalled();
  });

  it("shows an inert ribbon for habit items, whose priority would be regenerated away", async () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { container } = await renderInbox([item]);
    const ribbon = container.querySelector<HTMLElement>(".pm-task-ribbon")!;
    expect(ribbon.classList.contains("pm-task-ribbon--editable")).toBe(false);
    ribbon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openDropdown).not.toHaveBeenCalled();
  });
});

describe("InboxView.render — sort bar", () => {
  /** A line the "Deadline" mode has something to order by, which is what puts that mode
   *  on offer at all. */
  const dated = DayTask.parse("- [ ] Buy milk 📅 2026-07-30", 0)!;

  // The bar itself stays — it carries the link to the inbox note.
  it("has no ordering controls when the inbox is empty", async () => {
    const { container } = await renderInbox([]);
    expect(container.querySelector(".pm-inbox-sort-btn")).toBeNull();
    expect(container.querySelector(".pm-inbox-sort-dir-btn")).toBeNull();
    expect(container.querySelector(".pm-inbox-filter-btn")).toBeNull();
  });

  it("labels the current sort mode", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    expect((await renderInbox([item])).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Created");
    expect((await renderInbox([item], 0, [], TaskSortKey.Priority)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Priority");
    expect((await renderInbox([dated], 0, [], TaskSortKey.Due)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Deadline");
    expect((await renderInbox([item], 0, [], TaskSortKey.Title)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Title");
    expect((await renderInbox([item], 0, [], TaskSortKey.File)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Default");
  });

  it("names the current mode in the button's aria-label, not just its text", async () => {
    const { container } = await renderInbox([dated], 0, [], TaskSortKey.Due);
    expect(container.querySelector(".pm-inbox-sort-btn")?.getAttribute("aria-label"))
      .toBe("Change sort order — sorted by Deadline");
  });

  it("disables Deadline, rather than hiding it, when no row carries one", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item]);
    container.querySelector<HTMLElement>(".pm-inbox-sort-btn")!.click();
    const options = vi.mocked(openDropdown).mock.calls[0][1];
    // Still offered — the list is what says the mode exists.
    expect(options.map((o) => o.label)).toEqual(["Created", "Priority", "Deadline", "Title", "Default"]);
    expect(options.filter((o) => o.disabled).map((o) => o.label)).toEqual(["Deadline"]);
    expect(options.find((o) => o.label === "Deadline")!.title)
      .toBe("Nothing in this list carries a deadline");
  });

  it("leaves Deadline selectable once something is dated", async () => {
    const { container } = await renderInbox([dated]);
    container.querySelector<HTMLElement>(".pm-inbox-sort-btn")!.click();
    expect(vi.mocked(openDropdown).mock.calls[0][1].filter((o) => o.disabled)).toEqual([]);
  });

  it("falls back to Created when Deadline is stored but nothing is dated", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item], 0, [], TaskSortKey.Due);
    expect(container.querySelector(".pm-inbox-sort-btn")?.textContent).toBe("Created");
  });

  it("falls back to Created when the stored mode isn't one it knows", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item], 0, [], "nonsense" as TaskSortKey);
    expect(container.querySelector(".pm-inbox-sort-btn")?.textContent).toBe("Created");
    expect(container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!.title)
      .toBe("Newest first — click for Oldest first");
  });

  it("offers every sort mode in the dropdown", async () => {
    const { container } = await renderInbox([dated]);
    container.querySelector<HTMLElement>(".pm-inbox-sort-btn")!.click();
    const labels = vi.mocked(openDropdown).mock.calls[0][1].map((o) => o.label);
    expect(labels).toEqual(["Created", "Priority", "Deadline", "Title", "Default"]);
  });

  it("persists the picked mode and refreshes", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item]);
    container.querySelector<HTMLElement>(".pm-inbox-sort-btn")!.click();
    vi.mocked(openDropdown).mock.calls[0][1].find((o) => o.label === "Title")!.onSelect();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.plugin.settings.inboxSortBy).toBe(TaskSortKey.Title);
    expect(view.plugin.saveSettings).toHaveBeenCalled();
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("does not save or refresh when the current mode is picked again", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item], 0, [], TaskSortKey.Priority);
    container.querySelector<HTMLElement>(".pm-inbox-sort-btn")!.click();
    vi.mocked(openDropdown).mock.calls[0][1].find((o) => o.label === "Priority")!.onSelect();
    await Promise.resolve();
    expect(view.plugin.saveSettings).not.toHaveBeenCalled();
    expect(view.onRefresh).not.toHaveBeenCalled();
  });

  it("shows the direction as an icon, naming the order in effect and the one a click gives", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const dirBtn = async (sortBy: TaskSortKey, dir?: TaskSortDir) =>
      (await renderInbox([item], 0, [], sortBy, dir ? { [sortBy]: dir } : {}))
        .container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!;
    // Deadline is only on offer where something carries one.
    const dueDirBtn = async () =>
      (await renderInbox([dated], 0, [], TaskSortKey.Due))
        .container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!;
    expect((await dirBtn(TaskSortKey.Created)).textContent).toBe("");
    // The arrow shows the direction in effect, and so does the tooltip: the two halves of
    // one control have to agree.
    expect((await dirBtn(TaskSortKey.Created)).title).toBe("Newest first — click for Oldest first");
    expect((await dirBtn(TaskSortKey.Created, TaskSortDir.Asc)).title).toBe("Oldest first — click for Newest first");
    expect((await dirBtn(TaskSortKey.Priority)).title).toBe("Most urgent — click for Least urgent");
    expect((await dueDirBtn()).title).toBe("Soonest — click for Latest");
    expect((await dirBtn(TaskSortKey.Title)).title).toBe("A → Z — click for Z → A");
    expect((await dirBtn(TaskSortKey.File, TaskSortDir.Desc)).getAttribute("aria-label"))
      .toBe("Reversed — click for File order");
  });

  it("flips the current mode's direction, leaving the other modes untouched", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item], 0, [], TaskSortKey.Title, { [TaskSortKey.Created]: TaskSortDir.Asc });
    container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!.click();
    await Promise.resolve();
    expect(view.plugin.settings.inboxSortDir).toEqual({ [TaskSortKey.Created]: TaskSortDir.Asc, [TaskSortKey.Title]: TaskSortDir.Desc });
    expect(view.plugin.saveSettings).toHaveBeenCalled();
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("flips back to the mode's default direction", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item], 0, [], TaskSortKey.Created, { [TaskSortKey.Created]: TaskSortDir.Asc });
    container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!.click();
    await Promise.resolve();
    expect(view.plugin.settings.inboxSortDir).toEqual({ [TaskSortKey.Created]: TaskSortDir.Desc });
  });
});

// ---------------------------------------------------------------------------
// Drag to reorder
// ---------------------------------------------------------------------------

describe("InboxView.render — drag to reorder", () => {
  const items = () => [
    DayTask.parse("- [ ] A", 0)!,
    DayTask.parse("- [ ] B", 1)!,
    DayTask.parse("- [ ] C", 2)!,
  ];
  const handles = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>(".pm-reorder-handle")];

  /** The grip's width is on every row, for alignment; only file order makes one live. */
  const liveHandles = (container: HTMLElement) =>
    handles(container).filter((h) => !h.classList.contains("pm-reorder-handle--inert"));

  it("offers live handles only in the Default (file order) mode", async () => {
    for (const mode of [TaskSortKey.Created, TaskSortKey.Priority, TaskSortKey.Due, TaskSortKey.Title]) {
      const { container } = await renderInbox(items(), 0, [], mode);
      expect(liveHandles(container)).toHaveLength(0);
    }
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    expect(liveHandles(container)).toHaveLength(3);
  });

  it("offers no live handle when there is nothing to reorder against", async () => {
    const { container } = await renderInbox([DayTask.parse("- [ ] A", 0)!], 0, [], TaskSortKey.File);
    expect(liveHandles(container)).toHaveLength(0);
  });

  it("drags an item to the end of the file", async () => {
    const list = items();
    const { container, view } = await renderInbox(list, 0, [], TaskSortKey.File);
    dragHandle(handles(container)[0], 100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[0], null);
    await Promise.resolve();
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("drags an item in front of the one it was dropped above", async () => {
    const list = items();
    const { container } = await renderInbox(list, 0, [], TaskSortKey.File);
    dragHandle(handles(container)[2], -100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[2], list[0]);
  });

  it("anchors against the row above the drop when the list reads reversed", async () => {
    const list = items();
    const { container } = await renderInbox(list, 0, [], TaskSortKey.File, { [TaskSortKey.File]: TaskSortDir.Desc });
    // Reversed, the file's last line leads the list: the rows read C, B, A.
    // C dropped at the bottom on screen, which is the front of the file — so on disk it
    // belongs immediately in front of the row shown above the drop, A.
    dragHandle(handles(container)[0], 100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[2], list[0]);
    reorderChecklistItemMock.mockClear();

    // A dropped at the top on screen, which is the end of the file.
    dragHandle(handles(container)[2], -100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[0], null);
  });

  it("ignores a press that never travels far enough to be a drag", async () => {
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    dragHandle(handles(container)[0], 2);
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("ignores a drag that ends where it started", async () => {
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    dragHandle(handles(container)[2], 100);
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("marks the drop position with an element the list can legally contain", async () => {
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    handles(container)[0].dispatchEvent(pointerEvent("pointerdown", 0));
    document.dispatchEvent(pointerEvent("pointermove", 100));
    // The inbox's rows are `li`s of a `ul` now, as every other task list's are.
    expect(container.querySelector(".pm-reorder-indicator")?.tagName).toBe("LI");
    document.dispatchEvent(pointerEvent("pointerup", 100));
    expect(container.querySelector(".pm-reorder-indicator")).toBeNull();
  });

  it("abandons a drag whose list is torn down mid-gesture", async () => {
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    document.body.appendChild(container);
    handles(container)[0].dispatchEvent(pointerEvent("pointerdown", 0));
    document.dispatchEvent(pointerEvent("pointermove", 100));
    container.remove();
    // The frame loop is what notices: a refresh emits no pointer event of its own.
    vi.advanceTimersByTime(50);
    document.dispatchEvent(pointerEvent("pointerup", 100));
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("ignores a cancelled drag", async () => {
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    const handle = handles(container)[0];
    handle.dispatchEvent(pointerEvent("pointerdown", 0));
    document.dispatchEvent(pointerEvent("pointermove", 100));
    document.dispatchEvent(pointerEvent("pointercancel", 100));
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("stops listening once the drag is over", async () => {
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    dragHandle(handles(container)[0], 100);
    reorderChecklistItemMock.mockClear();
    document.dispatchEvent(pointerEvent("pointermove", -100));
    document.dispatchEvent(pointerEvent("pointerup", -100));
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("keeps the grip from toggling the row's action toolbar", async () => {
    const { container } = await renderInbox(items(), 0, [], TaskSortKey.File);
    handles(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.querySelectorAll(".pm-task-row--open")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Undated project tasks (merged dashboard only)
// ---------------------------------------------------------------------------

describe("undated project tasks", () => {
  function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
    // A real `Task`, not an object cast to one: the list reads it through `BaseTask`'s
    // methods, which a bare literal does not carry.
    return new Task({
      title: overrides.id,
      projectId: "proj1",
      status: "todo",
      dependencies: [],
      subtasks: [],
      filePath: `${overrides.id}.md`,
      ...overrides,
    });
  }

  async function renderWith(tasks: Task[], merged = true) {
    const container = document.createElement("div");
    const view = makeView();
    view.plugin.settings.mergeDailyAndProjectTasks = merged;
    view.plugin.settings.dashboardCollapsed = {};
    view.allTasks = tasks;
    await view.render(container, "Daily Notes/Inbox.md", [], 0, []);
    return container;
  }

  const sectionTitles = (container: HTMLElement) =>
    [...container.querySelectorAll(".pm-dash-section-title")].map((el) => el.textContent);

  it("lists a prioritized task that nothing dates, merged into the one list", async () => {
    const container = await renderWith([makeTask({ id: "t1", title: "Plan it", priority: Priority.High })]);
    expect(container.querySelectorAll(".pm-dash-task-row")).toHaveLength(1);
    expect(container.textContent).toContain("Plan it");
    // Merged, the two kinds share a list, and a single list needs no heading.
    expect(sectionTitles(container)).toEqual([]);
    expect(container.querySelectorAll(".pm-dash-checklist")).toHaveLength(1);
  });

  it("splits them into two named lists when the dashboard keeps the two kinds apart", async () => {
    const container = await renderWith(
      [makeTask({ id: "t1", title: "Plan it", priority: Priority.High })], false,
    );
    expect(sectionTitles(container)).toEqual(["Inbox items", "Project tasks with no deadline"]);
  });

  it("leaves out a task that already has a deadline", async () => {
    const container = await renderWith([makeTask({ id: "t1", priority: Priority.High, due: day("2026-07-01") })]);
    expect(container.querySelectorAll(".pm-dash-task-row")).toHaveLength(0);
  });

  it("leaves out a task with no priority — nothing has judged it yet", async () => {
    const container = await renderWith([makeTask({ id: "t1" })]);
    expect(container.querySelectorAll(".pm-dash-task-row")).toHaveLength(0);
  });

  it("shows no heading when there is no second list to tell apart from", async () => {
    const container = await renderWith([makeTask({ id: "t1", due: day("2026-07-01") })], false);
    expect(container.querySelector(".pm-dash-section-title")).toBeNull();
  });

  it("keeps quiet about the empty inbox when the one list names nothing", async () => {
    const container = await renderWith([makeTask({ id: "t1", title: "Plan it", priority: Priority.High })]);
    // Unnamed, the note would read as a claim about the rows under it.
    expect(container.querySelector(".pm-dash-empty")).toBeNull();
    expect(container.textContent).toContain("Plan it");
  });

  it("says so in the inbox's own list when the two are kept apart", async () => {
    const container = await renderWith(
      [makeTask({ id: "t1", title: "Plan it", priority: Priority.High })], false,
    );
    expect(container.querySelector(".pm-dash-empty")?.textContent).toBe("Inbox is empty");
  });

  /** The creation-date badges on a row, told from the other date badges by their tooltip. */
  const createdBadges = (container: HTMLElement) =>
    badges(container).filter((b) => b.title.startsWith("Created on"));

  it("dates one by when it was written — in the inbox, age is what it is triaged on", async () => {
    const container = await renderWith([makeTask({
      id: "t1", title: "Plan it", priority: Priority.High, createdAt: new Date("2026-06-23T09:15:00.000Z"),
    })]);
    expect(createdBadges(container).map((b) => b.textContent)).toEqual(["7 d"]);
  });

  it("dates them in their own list too, where the two kinds are kept apart", async () => {
    const container = await renderWith([makeTask({
      id: "t1", title: "Plan it", priority: Priority.High, createdAt: new Date("2026-06-23T09:15:00.000Z"),
    })], false);
    expect(createdBadges(container).map((b) => b.textContent)).toEqual(["7 d"]);
  });

  it("orders them most urgent first", async () => {
    const container = await renderWith([
      makeTask({ id: "low", title: "Low one", priority: Priority.Low }),
      makeTask({ id: "crit", title: "Critical one", priority: Priority.Critical }),
    ]);
    expect([...container.querySelectorAll(".pm-dash-task-title")].map((el) => el.textContent))
      .toEqual(["Critical one", "Low one"]);
  });
});

// ---------------------------------------------------------------------------
// The age badge opens its day
// ---------------------------------------------------------------------------

describe("InboxView.render — age badge", () => {
  it("shows the day an item was created on", async () => {
    const { container, view } = await renderInbox([daysAgoTask("Buy milk", 7)]);
    const badge = container.querySelector(".pm-task-badge") as HTMLElement;
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.showDay).toHaveBeenCalledWith(day("2026-06-23"));
  });

  it("shows the day an item is planned for, as every other date badge does", async () => {
    const item = DayTask.parse("- [ ] Buy milk ➕ 2026-06-01 ⏳ 2026-07-20", 0)!;
    const { container, view } = await renderInbox([item]);
    targetBadge(container)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.showDay).toHaveBeenCalledWith(day("2026-07-20"));
  });
});

// ---------------------------------------------------------------------------
// The leading slot
// ---------------------------------------------------------------------------

describe("InboxView.render — leading slot", () => {
  const lead = (container: HTMLElement) =>
    container.querySelector(".pm-day-task-row-main")!.firstElementChild!.className;

  it("marks a line no day holds yet with the inbox it waits in", async () => {
    const { container } = await renderInbox([daysAgoTask("Buy milk", 1)]);
    expect(lead(container)).toBe("pm-day-task-lead pm-day-task-inbox-icon");
  });

  it("marks a line already targeted at a day with that day, which it shows", async () => {
    const item = DayTask.parse("- [ ] Buy milk ⏳ 2026-07-03", 0)!;
    const { container, view } = await renderInbox([item]);
    expect(lead(container)).toBe("pm-day-task-lead pm-day-task-note-icon");
    (container.querySelector(".pm-day-task-note-icon") as HTMLElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.showDay).toHaveBeenCalledWith(day("2026-07-03"));
  });

  it("gives the grip to the rows the file order can move", async () => {
    const movable = [DayTask.parse("- [ ] A", 0)!, DayTask.parse("- [ ] B", 1)!];
    const { container } = await renderInbox(movable, 0, [], TaskSortKey.File);
    expect(lead(container)).toBe("pm-reorder-handle");
  });
});

// ---------------------------------------------------------------------------
// One list, one order
// ---------------------------------------------------------------------------

describe("InboxView.render — the two kinds share the sort", () => {
  function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
    return new Task({
      title: overrides.id, projectId: "proj1", status: "todo",
      dependencies: [], subtasks: [], filePath: `${overrides.id}.md`, ...overrides,
    });
  }

  async function renderMixed(sortBy: TaskSortKey, sortDir: Partial<Record<TaskSortKey, TaskSortDir>> = {}) {
    const container = document.createElement("div");
    const view = makeView(sortBy, sortDir);
    view.plugin.settings.mergeDailyAndProjectTasks = true;
    view.plugin.settings.dashboardCollapsed = {};
    view.allTasks = [
      makeTask({ id: "proj-critical", title: "Project critical", priority: Priority.Critical }),
      makeTask({ id: "proj-low", title: "Project low", priority: Priority.Low }),
    ];
    const items = [
      DayTask.parse("- [ ] Inbox high ⏫", 0)!,
      DayTask.parse("- [ ] Inbox lowest ⏬", 1)!,
    ];
    await view.render(container, "Daily Notes/Inbox.md", items, 0, []);
    return [...container.querySelectorAll(".pm-inbox-title, .pm-dash-task-title")]
      .map((el) => el.textContent);
  }

  it("interleaves the project tasks among the inbox items by priority", async () => {
    expect(await renderMixed(TaskSortKey.Priority))
      .toEqual(["Project critical", "Inbox high", "Project low", "Inbox lowest"]);
  });

  it("orders them all by title when that is the mode", async () => {
    expect(await renderMixed(TaskSortKey.Title))
      .toEqual(["Inbox high", "Inbox lowest", "Project critical", "Project low"]);
  });

  it("puts the project tasks last in file order — they have no line in the inbox file", async () => {
    expect(await renderMixed(TaskSortKey.File))
      .toEqual(["Inbox high", "Inbox lowest", "Project critical", "Project low"]);
  });
});

describe("InboxView.render — the age badge reads as every other date does", () => {
  it("says 'today' for an item created today, not '0 d'", async () => {
    const { container } = await renderInbox([daysAgoTask("Buy milk", 0)]);
    expect(ageBadge(container)?.textContent).toBe("today");
  });
});

// ---------------------------------------------------------------------------
// The deadline the "Deadline" sort reads
// ---------------------------------------------------------------------------

describe("InboxView.render — deadline", () => {
  it("shows an item's own deadline, the key that sort orders by", async () => {
    const { container } = await renderInbox([DayTask.parse("- [ ] Buy milk 📅 2026-07-03", 0)!]);
    const badge = badges(container).find((b) => b.title.startsWith("Deadline:"));
    expect(badge?.textContent).toBe("in 3d");
  });

  it("takes the day to that deadline when clicked", async () => {
    const { container, view } = await renderInbox([DayTask.parse("- [ ] Buy milk 📅 2026-07-03", 0)!]);
    const badge = badges(container).find((b) => b.title.startsWith("Deadline:"))!;
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.showDay).toHaveBeenCalledWith(day("2026-07-03"));
  });

  it("orders by the deadline shown, an item with none sorting after one with", async () => {
    const dated = DayTask.parse("- [ ] Dated 📅 2026-07-03 ➕ 2026-06-01", 0)!;
    const undated = DayTask.parse("- [ ] Undated ➕ 2026-06-29", 1)!;
    const { container } = await renderInbox([undated, dated], 0, [], TaskSortKey.Due);
    expect([...container.querySelectorAll(".pm-inbox-title")].map((el) => el.textContent))
      .toEqual(["Dated", "Undated"]);
  });

  it("falls back to the ⏳ day it is aimed at, which is the date it shows", async () => {
    const targeted = DayTask.parse("- [ ] Targeted ⏳ 2026-07-02 ➕ 2026-06-01", 0)!;
    const later = DayTask.parse("- [ ] Later 📅 2026-07-09 ➕ 2026-06-29", 1)!;
    const { container } = await renderInbox([later, targeted], 0, [], TaskSortKey.Due);
    expect([...container.querySelectorAll(".pm-inbox-title")].map((el) => el.textContent))
      .toEqual(["Targeted", "Later"]);
  });
});

describe("InboxView.render — a project task sorts by what its row shows", () => {
  it("ranks an inherited priority as the row reads it, not as its own empty field", async () => {
    const container = document.createElement("div");
    const view = makeView(TaskSortKey.Priority);
    view.plugin.settings.mergeDailyAndProjectTasks = true;
    view.plugin.settings.dashboardCollapsed = {};
    // The subtask carries no priority of its own; the critical parent above it is what
    // its ribbon shows, and so is what it must sort by.
    view.allTasks = [
      new Task({
        id: "parent", title: "Parent", projectId: "p", status: "todo",
        priority: Priority.Critical, dependencies: [], subtasks: [], filePath: "parent.md",
      }),
      new Task({
        id: "child", title: "Inherits critical", projectId: "p", parentId: "parent",
        status: "todo", dependencies: [], subtasks: [], filePath: "child.md",
      }),
    ];
    await view.render(container, "Daily Notes/Inbox.md", [DayTask.parse("- [ ] Low line 🔽", 0)!], 0, []);
    expect([...container.querySelectorAll(".pm-inbox-title, .pm-dash-task-title")].map((el) => el.textContent))
      .toEqual(["Inherits critical", "Low line"]);
  });
});

describe("InboxView.render — the mode button says what it orders by", () => {
  const chain = async (sortBy: TaskSortKey) =>
    (await renderInbox([DayTask.parse("- [ ] A", 0)!], 0, [], sortBy))
      .container.querySelector<HTMLElement>(".pm-inbox-sort-btn")!.title;

  it("names the mode's key and what settles its ties", async () => {
    expect(await chain(TaskSortKey.File)).toBe("File order, then creation date");
    expect(await chain(TaskSortKey.Created)).toBe("Creation date, then priority");
    expect(await chain(TaskSortKey.Title)).toBe("Title, then priority, then creation date");
  });
});
