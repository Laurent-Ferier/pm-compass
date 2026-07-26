// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills (same as dashboard-view-rendering.test.ts — Obsidian
// extends HTMLElement with createEl/createDiv/etc. that jsdom doesn't provide)
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("div", opts);
  };
  htmlProto.createSpan = function(this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeDocument = document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeWindow = window;
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
      format: (fmt?: string) => (fmt === "MMM D" ? `${self._d.getMonth() + 1}/${self._d.getDate()}` : self._d.toISOString()),
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
  Component: class {},
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

vi.mock("./task-creator", () => ({
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
vi.mock("../model/day-task-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model/day-task-actions")>();
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

import { InboxView } from "./inbox-view";
import { openDropdown } from "./task-creator";
import { DayTask, formatDate } from "../model/day-task";
import type { Project } from "../model/shared";
import { InboxSortBy, InboxSortDir, PRIORITY_COLORS, Priority, ScheduleOutcome } from "../model/task-vocabulary";
import { dragHandle, pointerEvent } from "./__testing__/drag-pointer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeView(
  sortBy: InboxSortBy = InboxSortBy.Created,
  sortDir: Partial<Record<InboxSortBy, InboxSortDir>> = {},
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = Object.create(InboxView.prototype) as any;
  view.app = {};
  view.plugin = plugin;
  view.openNoteKeys = new Set<string>();
  view.allTasks = [];
  view.onRefresh = vi.fn();
  return view;
}

async function renderInbox(
  items: DayTask[],
  staleAfterDays = 0,
  projects: Project[] = [],
  sortBy: InboxSortBy = InboxSortBy.Created,
  sortDir: Partial<Record<InboxSortBy, InboxSortDir>> = {},
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
    expect(container.querySelector(".pm-inbox-daily-icon")).not.toBeNull();
  });

  it("does not show the daily icon for non-habit items", async () => {
    const item = DayTask.parse("- [ ] Call dentist #urgent", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector(".pm-inbox-daily-icon")).toBeNull();
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
  return badges(container).find((b) => /^\d+ d$/.test(b.textContent ?? ""));
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

  it("shows the ⏳ target date of an item waiting for its day", async () => {
    const item = DayTask.parse("- [ ] Task ➕ 2026-06-01 ⏳ 2026-07-20", 0)!;
    const { container } = await renderInbox([item]);
    expect(targetBadge(container)).toBeDefined();
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
    const input = container.querySelector<HTMLInputElement>(".pm-inbox-add-input")!;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(appendInboxItemMock).not.toHaveBeenCalled();
  });

  it("submits the trimmed title on Enter", async () => {
    const { container, view } = await renderInbox([]);
    const input = container.querySelector<HTMLInputElement>(".pm-inbox-add-input")!;
    input.value = "  New task  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(appendInboxItemMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", "New task");
  });

  it("clears and disables the input immediately, before the write resolves", async () => {
    let resolveAppend!: () => void;
    appendInboxItemMock.mockReturnValueOnce(new Promise<void>((resolve) => { resolveAppend = resolve; }));
    const { container } = await renderInbox([]);
    const input = container.querySelector<HTMLInputElement>(".pm-inbox-add-input")!;
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
    const cb = container.querySelector<HTMLInputElement>(".pm-inbox-cb")!;
    cb.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();
    expect(closeInboxItemMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", item);
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("stops propagation on click so the row's tap-toggle doesn't also fire", async () => {
    const item = daysAgoTask("Buy milk", 0);
    const { container } = await renderInbox([item]);
    const cb = container.querySelector<HTMLInputElement>(".pm-inbox-cb")!;
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
    onPick(mockMoment(dateStr));
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
    expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining("once that day's note exists"));
  });

  it("says a past day sends the item to today, since that day will never get a note", async () => {
    scheduleInboxItemMock.mockResolvedValueOnce(ScheduleOutcome.Targeted);
    const item = daysAgoTask("Buy milk", 0);
    const { container } = await renderInbox([item]);
    const past = new Date();
    past.setDate(past.getDate() - 3);
    pickDate(container, formatDate(past));
    await Promise.resolve();
    await Promise.resolve();
    expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining("moves to today"));
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
      [planned(), daysAgoTask("Triage me", 0)], 0, [], InboxSortBy.Created, {}, true,
    );
    const titles = [...container.querySelectorAll(".pm-inbox-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Triage me"]);
  });

  it("says how many are hidden when the filter empties the list", async () => {
    const { container } = await renderInbox([planned()], 0, [], InboxSortBy.Created, {}, true);
    expect(container.querySelector(".pm-dash-empty")?.textContent).toContain("1 planned item");
    expect(container.querySelector(".pm-inbox-sort-bar")).not.toBeNull();
  });

  it("still says the inbox is empty when there is nothing at all", async () => {
    const { container } = await renderInbox([], 0, [], InboxSortBy.Created, {}, true);
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
      [planned(), daysAgoTask("Triage me", 0)], 0, [], InboxSortBy.Created, {}, true,
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
  it("is not rendered when the inbox is empty", async () => {
    const { container } = await renderInbox([]);
    expect(container.querySelector(".pm-inbox-sort-bar")).toBeNull();
  });

  it("labels the current sort mode", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    expect((await renderInbox([item])).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Created");
    expect((await renderInbox([item], 0, [], InboxSortBy.Priority)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Priority");
    expect((await renderInbox([item], 0, [], InboxSortBy.Due)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Deadline");
    expect((await renderInbox([item], 0, [], InboxSortBy.Title)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Title");
    expect((await renderInbox([item], 0, [], InboxSortBy.File)).container.querySelector(".pm-inbox-sort-btn")?.textContent)
      .toBe("Default");
  });

  it("names the current mode in the button's aria-label, not just its text", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item], 0, [], InboxSortBy.Due);
    expect(container.querySelector(".pm-inbox-sort-btn")?.getAttribute("aria-label"))
      .toBe("Change sort order — sorted by Deadline");
  });

  it("falls back to Created when the stored mode isn't one it knows", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item], 0, [], "nonsense" as InboxSortBy);
    expect(container.querySelector(".pm-inbox-sort-btn")?.textContent).toBe("Created");
    expect(container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!.title).toBe("Oldest first");
  });

  it("offers every sort mode in the dropdown", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item]);
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
    expect(view.plugin.settings.inboxSortBy).toBe(InboxSortBy.Title);
    expect(view.plugin.saveSettings).toHaveBeenCalled();
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("does not save or refresh when the current mode is picked again", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item], 0, [], InboxSortBy.Priority);
    container.querySelector<HTMLElement>(".pm-inbox-sort-btn")!.click();
    vi.mocked(openDropdown).mock.calls[0][1].find((o) => o.label === "Priority")!.onSelect();
    await Promise.resolve();
    expect(view.plugin.saveSettings).not.toHaveBeenCalled();
    expect(view.onRefresh).not.toHaveBeenCalled();
  });

  it("shows the direction as an icon only, naming the flip in its tooltip", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const dirBtn = async (sortBy: InboxSortBy, dir?: InboxSortDir) =>
      (await renderInbox([item], 0, [], sortBy, dir ? { [sortBy]: dir } : {}))
        .container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!;
    expect((await dirBtn(InboxSortBy.Created)).textContent).toBe("");
    expect((await dirBtn(InboxSortBy.Created)).title).toBe("Oldest first");
    expect((await dirBtn(InboxSortBy.Created, InboxSortDir.Asc)).title).toBe("Newest first");
    expect((await dirBtn(InboxSortBy.Priority)).title).toBe("Least urgent");
    expect((await dirBtn(InboxSortBy.Due)).title).toBe("Latest");
    expect((await dirBtn(InboxSortBy.Title)).title).toBe("Z → A");
    expect((await dirBtn(InboxSortBy.File, InboxSortDir.Desc)).getAttribute("aria-label")).toBe("File order");
  });

  it("flips the current mode's direction, leaving the other modes untouched", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item], 0, [], InboxSortBy.Title, { [InboxSortBy.Created]: InboxSortDir.Asc });
    container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!.click();
    await Promise.resolve();
    expect(view.plugin.settings.inboxSortDir).toEqual({ [InboxSortBy.Created]: InboxSortDir.Asc, [InboxSortBy.Title]: InboxSortDir.Desc });
    expect(view.plugin.saveSettings).toHaveBeenCalled();
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("flips back to the mode's default direction", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item], 0, [], InboxSortBy.Created, { [InboxSortBy.Created]: InboxSortDir.Asc });
    container.querySelector<HTMLElement>(".pm-inbox-sort-dir-btn")!.click();
    await Promise.resolve();
    expect(view.plugin.settings.inboxSortDir).toEqual({ [InboxSortBy.Created]: InboxSortDir.Desc });
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

  it("offers handles only in the Default (file order) mode", async () => {
    for (const mode of [InboxSortBy.Created, InboxSortBy.Priority, InboxSortBy.Due, InboxSortBy.Title]) {
      const { container } = await renderInbox(items(), 0, [], mode);
      expect(handles(container)).toHaveLength(0);
    }
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
    expect(handles(container)).toHaveLength(3);
  });

  it("offers no handle when there is nothing to reorder against", async () => {
    const { container } = await renderInbox([DayTask.parse("- [ ] A", 0)!], 0, [], InboxSortBy.File);
    expect(handles(container)).toHaveLength(0);
  });

  it("drags an item to the end of the file", async () => {
    const list = items();
    const { container, view } = await renderInbox(list, 0, [], InboxSortBy.File);
    dragHandle(handles(container)[0], 100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[0], null);
    await Promise.resolve();
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("drags an item in front of the one it was dropped above", async () => {
    const list = items();
    const { container } = await renderInbox(list, 0, [], InboxSortBy.File);
    dragHandle(handles(container)[2], -100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[2], list[0]);
  });

  it("anchors against the row above the drop when the list reads reversed", async () => {
    const list = items();
    const { container } = await renderInbox(list, 0, [], InboxSortBy.File, { [InboxSortBy.File]: InboxSortDir.Desc });
    // Dropped below C on screen, so on disk it belongs immediately in front of C.
    dragHandle(handles(container)[0], 100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[0], list[2]);
    reorderChecklistItemMock.mockClear();

    // Dropped at the top on screen, which is the end of the file.
    dragHandle(handles(container)[2], -100);
    expect(reorderChecklistItemMock).toHaveBeenCalledWith({}, "Daily Notes/Inbox.md", list[2], null);
  });

  it("ignores a press that never travels far enough to be a drag", async () => {
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
    dragHandle(handles(container)[0], 2);
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("ignores a drag that ends where it started", async () => {
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
    dragHandle(handles(container)[2], 100);
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("marks the drop position with an element the list can legally contain", async () => {
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
    handles(container)[0].dispatchEvent(pointerEvent("pointerdown", 0));
    document.dispatchEvent(pointerEvent("pointermove", 100));
    expect(container.querySelector(".pm-reorder-indicator")?.tagName).toBe("DIV");
    document.dispatchEvent(pointerEvent("pointerup", 100));
    expect(container.querySelector(".pm-reorder-indicator")).toBeNull();
  });

  it("abandons a drag whose list is torn down mid-gesture", async () => {
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
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
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
    const handle = handles(container)[0];
    handle.dispatchEvent(pointerEvent("pointerdown", 0));
    document.dispatchEvent(pointerEvent("pointermove", 100));
    document.dispatchEvent(pointerEvent("pointercancel", 100));
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("stops listening once the drag is over", async () => {
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
    dragHandle(handles(container)[0], 100);
    reorderChecklistItemMock.mockClear();
    document.dispatchEvent(pointerEvent("pointermove", -100));
    document.dispatchEvent(pointerEvent("pointerup", -100));
    expect(reorderChecklistItemMock).not.toHaveBeenCalled();
  });

  it("keeps the grip from toggling the row's action toolbar", async () => {
    const { container } = await renderInbox(items(), 0, [], InboxSortBy.File);
    handles(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.querySelectorAll(".pm-task-row--open")).toHaveLength(0);
  });
});
