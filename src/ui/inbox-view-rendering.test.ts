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
      format: (fmt?: string) => (fmt === "MMM D" ? `${self._d.getMonth() + 1}/${self._d.getDate()}` : self._d.toISOString()),
    };
    return self;
  }
  function mockMoment(...args: unknown[]) {
    if (args.length === 0) return makeMomentObj(new Date());
    const arg = args[0] as string;
    const [y, m, d] = arg.split("-").map(Number);
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
  setInboxItemPriorityMock,
} = vi.hoisted(() => ({
  appendInboxItemMock: vi.fn().mockResolvedValue(undefined),
  closeInboxItemMock: vi.fn().mockResolvedValue(undefined),
  scheduleInboxItemMock: vi.fn().mockResolvedValue(undefined),
  removeInboxItemMock: vi.fn().mockResolvedValue(undefined),
  setInboxItemPriorityMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../model/day-task-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model/day-task-actions")>();
  return {
    ...actual,
    appendInboxItem: appendInboxItemMock,
    closeInboxItem: closeInboxItemMock,
    scheduleInboxItem: scheduleInboxItemMock,
    removeInboxItem: removeInboxItemMock,
    setInboxItemPriority: setInboxItemPriorityMock,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { InboxView } from "./inbox-view";
import { openDropdown } from "./task-creator";
import { DayTask } from "../model/day-task";
import type { Project } from "../model/shared";
import { InboxSortBy, InboxSortDir, PRIORITY_COLORS, Priority } from "../model/task-vocabulary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeView(sortBy: InboxSortBy = InboxSortBy.Created, sortDir: Partial<Record<InboxSortBy, InboxSortDir>> = {}) {
  const plugin = {
    settings: {
      dailyHabitsTag: "daily", smallTaskMaxWeeksAhead: 1,
      dailyTasksHeading: "# Tasks", projectsFolder: "Projects",
      inboxSortBy: sortBy, inboxSortDir: sortDir,
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
) {
  const container = document.createElement("div");
  const view = makeView(sortBy, sortDir);
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
  setInboxItemPriorityMock.mockClear();
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

describe("InboxView.render — age and staleness", () => {
  it("shows the age in days since creation", async () => {
    const item = daysAgoTask("Task", 5);
    const { container } = await renderInbox([item]);
    expect(container.querySelector(".pm-inbox-age")?.textContent).toBe("5 d");
  });

  it("marks items older than 14 days as old, independent of the stale threshold", async () => {
    const item = daysAgoTask("Task", 15);
    const { container } = await renderInbox([item], 0);
    expect(container.querySelector(".pm-inbox-age--old")).not.toBeNull();
  });

  it("does not mark a 14-day-old item as old", async () => {
    const item = daysAgoTask("Task", 14);
    const { container } = await renderInbox([item], 0);
    expect(container.querySelector(".pm-inbox-age--old")).toBeNull();
  });

  it("shows the stale warning once past the configured threshold", async () => {
    const item = daysAgoTask("Task", 10);
    const { container } = await renderInbox([item], 7);
    expect(container.querySelector(".pm-inbox-stale-warn")).not.toBeNull();
  });

  it("does not show the stale warning below the configured threshold", async () => {
    const item = daysAgoTask("Task", 5);
    const { container } = await renderInbox([item], 7);
    expect(container.querySelector(".pm-inbox-stale-warn")).toBeNull();
  });

  it("never shows the stale warning when the threshold is disabled (0)", async () => {
    const item = daysAgoTask("Task", 999);
    const { container } = await renderInbox([item], 0);
    expect(container.querySelector(".pm-inbox-stale-warn")).toBeNull();
  });

  it("does not show an age badge for items without a creation date", async () => {
    const item = DayTask.parse("- [ ] No date task", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector(".pm-inbox-age")).toBeNull();
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

  it("schedules a non-habit item within the planning window and refreshes", async () => {
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

  it("rejects scheduling a non-habit item beyond the planning window and shows a Notice", async () => {
    const item = daysAgoTask("Buy milk", 0);
    const { container } = await renderInbox([item]);
    pickDate(container, "2026-07-20");
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduleInboxItemMock).not.toHaveBeenCalled();
    expect(NoticeMock).toHaveBeenCalled();
  });

  it("schedules a habit-tagged item regardless of the planning window", async () => {
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

// ---------------------------------------------------------------------------
// Delete button
// ---------------------------------------------------------------------------

describe("InboxView.render — delete button", () => {
  it("removes the item and refreshes after confirming", async () => {
    const item = daysAgoTask("Buy milk", 0);
    const { container, view } = await renderInbox([item]);
    const deleteBtn = container.querySelector<HTMLButtonElement>(".pm-day-task-action-btn--delete")!;
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
    const ribbon = container.querySelector<HTMLElement>(".pm-inbox-ribbon")!;
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe(PRIORITY_COLORS[Priority.High]);
    expect(ribbon.title).toBe("Priority: High");
  });

  it("leaves the ribbon uncoloured for a line with no priority", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item]);
    const ribbon = container.querySelector<HTMLElement>(".pm-inbox-ribbon")!;
    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("");
    expect(ribbon.title).toBe("Priority: None");
  });

  it("names the checklist-only ⏬ level rather than reporting it as unset", async () => {
    const item = DayTask.parse("- [ ] Buy milk ⏬", 0)!;
    const { container } = await renderInbox([item]);
    expect(container.querySelector<HTMLElement>(".pm-inbox-ribbon")!.title).toBe("Priority: Lowest");
  });

  it("opens the priority dropdown on click, writing the pick back to the line", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container, view } = await renderInbox([item]);
    container.querySelector<HTMLElement>(".pm-inbox-ribbon")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(openDropdown).toHaveBeenCalled();
    const options = vi.mocked(openDropdown).mock.calls[0][1];
    expect(options.map((o) => o.label)).toEqual(["None", "Critical", "High", "Medium", "Low"]);

    options.find((o) => o.label === "High")!.onSelect();
    await Promise.resolve();
    await Promise.resolve();
    expect(setInboxItemPriorityMock).toHaveBeenCalledWith(view.app, "Daily Notes/Inbox.md", item, Priority.High);
    expect(view.onRefresh).toHaveBeenCalled();
  });

  it("stops the click from also toggling the row's actions toolbar", async () => {
    const item = DayTask.parse("- [ ] Buy milk", 0)!;
    const { container } = await renderInbox([item]);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");
    container.querySelector<HTMLElement>(".pm-inbox-ribbon")!.dispatchEvent(event);
    expect(stopSpy).toHaveBeenCalled();
  });

  it("shows an inert ribbon for habit items, whose priority would be regenerated away", async () => {
    const item = DayTask.parse("- [ ] Morning routine #daily", 0)!;
    const { container } = await renderInbox([item]);
    const ribbon = container.querySelector<HTMLElement>(".pm-inbox-ribbon")!;
    expect(ribbon.classList.contains("pm-inbox-ribbon--editable")).toBe(false);
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
