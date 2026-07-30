// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll } from "vitest";
import { bagOf } from "./__testing__/dom-bag";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills — jsdom lacks the createEl helpers Obsidian adds.
// ---------------------------------------------------------------------------
function installObsidianDOMPolyfills() {
  const proto = bagOf(HTMLElement.prototype);
  type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
  proto.createEl = function (this: HTMLElement, tag: string, opts?: Opts) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, opts?: Opts) { return this.createEl("div", opts); };
  proto.createSpan = function (this: HTMLElement, opts?: Opts) { return this.createEl("span", opts); };
  bagOf(window).activeDocument = document;
}

vi.mock("obsidian", () => ({ setIcon: () => {} }));

import { TaskList } from "./task-list";
import type { DayTask } from "../model/daily/day-task";
import { BaseTask, Status } from "../model/base-task";
import { day } from "../model/__testing__/dates";

/** A stand-in for either kind of task: the list only ever reads these. */
class FakeTask extends BaseTask {
  constructor(
    readonly title: string,
    private readonly date?: Date,
    readonly filePath: string | null = null,
    private readonly closed = false,
  ) { super(); }
  get plannedDate() { return this.date; }
  override get statusValue() { return this.closed ? Status.Done : Status.Todo; }
  get tagNames() { return []; }
  get ownPriority() { return null; }
  get ownDue() { return null; }
  get createdOn() { return null; }
  get fileLine() { return null; }
  get rollupId() { return null; }
  get closedOn() { return null; }
  get statusScale() { return [Status.Todo, Status.Done]; }
  rowTitle() { return this.title; }
}

const labels = (list: HTMLElement) =>
  [...list.querySelectorAll("li")].map((li) => li.textContent);

/** Renders `tasks`, writing each one's title into an `li` of its own. */
function render(tasks: FakeTask[], opts: Parameters<TaskList["render"]>[1] = {}) {
  const list = new TaskList((task, ul, lead) => {
    const li = ul.createEl("li", { text: task.title });
    lead.addDragHandle(li, li, task as unknown as DayTask, lead.movable);
  });
  return list.addAll(tasks).render(document.createElement("div"), opts);
}

/** Titles the fake rows treat as draggable, when a drag is wired at all. */
const movable = new Set<string>();

beforeAll(() => { installObsidianDOMPolyfills(); });

describe("TaskList", () => {
  const task = (title: string, date?: string) => new FakeTask(title, date ? day(date) : undefined);

  it("keeps the order it was given when not sorting", () => {
    expect(labels(render([task("b", "2026-07-02"), task("a", "2026-07-01")]))).toEqual(["b", "a"]);
  });

  it("orders by each task's own date when asked, oldest first", () => {
    const list = render([task("later", "2026-07-05"), task("earlier", "2026-07-01")], { sortByDate: true });
    expect(labels(list)).toEqual(["earlier", "later"]);
  });

  it("interleaves the two kinds of task by date alone", () => {
    const list = render([
      task("day-3", "2026-07-03"), task("day-1", "2026-07-01"),
      task("task-2", "2026-07-02"), task("task-4", "2026-07-04"),
    ], { sortByDate: true });
    expect(labels(list)).toEqual(["day-1", "task-2", "day-3", "task-4"]);
  });

  it("sorts undated tasks last, in the order they were added", () => {
    const list = render(
      [task("undated-first"), task("undated-second"), task("dated", "2026-07-09")],
      { sortByDate: true },
    );
    expect(labels(list)).toEqual(["dated", "undated-first", "undated-second"]);
  });

  it("keeps tasks sharing a date in the order they were added", () => {
    const same = "2026-07-01";
    const list = render([task("a", same), task("b", same), task("c", same)], { sortByDate: true });
    expect(labels(list)).toEqual(["a", "b", "c"]);
  });

  it("takes a date the caller knows better than the task does", () => {
    const list = render([task("own-later", "2026-07-09"), task("own-earlier", "2026-07-01")], {
      sortByDate: true,
      // An inherited deadline, as `computeEffectiveValues` hands the dashboard.
      dateOf: (t) => (t.title === "own-later" ? day("2026-06-30") : t.plannedDate),
    });
    expect(labels(list)).toEqual(["own-later", "own-earlier"]);
  });

  it("gives every row the grip's width, so lists with and without a drag line up", () => {
    const list = render([task("a"), task("b")]);
    const handles = list.querySelectorAll(".pm-reorder-handle");
    expect(handles).toHaveLength(2);
    expect([...handles].every((h) => h.classList.contains("pm-reorder-handle--inert"))).toBe(true);
  });

  it("wires the drag once two tasks can take part in it", () => {
    movable.clear();
    movable.add("a");
    movable.add("b");
    const list = render([task("a"), task("b")], {
      reorder: { canMove: () => true, onDrop: () => {} },
    });
    const handles = [...list.querySelectorAll(".pm-reorder-handle")];
    expect(handles.some((h) => !h.classList.contains("pm-reorder-handle--inert"))).toBe(true);
  });

  it("leaves a lone movable task without a drag — it has nowhere to go", () => {
    movable.clear();
    const list = render([task("a"), task("b")], {
      reorder: { canMove: (t) => t.title === "a", onDrop: () => {} },
    });
    expect([...list.querySelectorAll(".pm-reorder-handle")]
      .every((h) => h.classList.contains("pm-reorder-handle--inert"))).toBe(true);
  });

  it("sinks closed rows below open ones, whatever their day says", () => {
    const closed = new FakeTask("closed-early", day("2026-07-01"), null, true);
    const open = new FakeTask("open-late", day("2026-07-09"));
    // The closed row is dated first, and still goes last: finished work is a record of
    // the day, not a call on what to do in it.
    expect(labels(render([closed, open], { sortByDate: true }))).toEqual(["open-late", "closed-early"]);
  });

  it("still orders the open rows among themselves by date", () => {
    const rows = [
      new FakeTask("closed", day("2026-07-01"), null, true),
      new FakeTask("later", day("2026-07-09")),
      new FakeTask("earlier", day("2026-07-02")),
    ];
    expect(labels(render(rows, { sortByDate: true }))).toEqual(["earlier", "later", "closed"]);
  });

  it("adds the view's own class to the list it builds", () => {
    expect(render([task("a")], { cls: "pm-inbox-list" }).className)
      .toBe("pm-dash-checklist pm-inbox-list");
  });
});
