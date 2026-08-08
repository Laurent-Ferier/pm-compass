import { describe, it, expect } from "vitest";
import {
  getStatusColor, getPriorityColor, maxPriority, priorityRank, toPriority, Priority, PRIORITIES,
  BaseTask, TaskSortKey, TaskSortDir, Status, STATUSES, type Rollup, type RollupLookup,
  sortInboxItems, resolveTaskSortDir,
} from "./base-task";
import type { ProjectTaskFields } from "./project/project-task";
import { Task } from "./daily/task";
import { day } from "./__testing__/dates";
import { newTask } from "./__testing__/notes";
import { timestamp } from "./__testing__/dates";

// ---------------------------------------------------------------------------
// getStatusColor
// ---------------------------------------------------------------------------

describe("getStatusColor", () => {
  it("returns the correct colour for each known status", () => {
    expect(getStatusColor("todo")).toBe("#6b7280");
    expect(getStatusColor("in-progress")).toBe("#3b82f6");
    expect(getStatusColor("blocked")).toBe("#ef4444");
    expect(getStatusColor("review")).toBe("#8b5cf6");
    expect(getStatusColor("done")).toBe("#22c55e");
    expect(getStatusColor("cancelled")).toBe("#9ca3af");
  });

  it("falls back to the todo grey for an unknown status", () => {
    expect(getStatusColor("unknown")).toBe("#6b7280");
    expect(getStatusColor("")).toBe("#6b7280");
  });
});

// ---------------------------------------------------------------------------
// Priority / toPriority
// ---------------------------------------------------------------------------

describe("Priority", () => {
  it("keeps the stored wire values the vault already holds", () => {
    expect(Object.values(Priority)).toEqual(["", "critical", "high", "medium", "low", "lowest"]);
  });

  it("offers every level but the checklist-only Lowest in the picker list", () => {
    expect(PRIORITIES).toEqual([
      Priority.None, Priority.Critical, Priority.High, Priority.Medium, Priority.Low,
    ]);
  });
});

describe("toPriority", () => {
  it("narrows a known stored value", () => {
    expect(toPriority("high")).toBe(Priority.High);
    expect(toPriority("lowest")).toBe(Priority.Lowest);
    expect(toPriority("")).toBe(Priority.None);
  });

  it("falls back to None for an unrecognised or non-string value", () => {
    expect(toPriority("urgent")).toBe(Priority.None);
    expect(toPriority(undefined)).toBe(Priority.None);
    expect(toPriority(null)).toBe(Priority.None);
    expect(toPriority(3)).toBe(Priority.None);
    expect(toPriority({})).toBe(Priority.None);
  });
});

// ---------------------------------------------------------------------------
// getPriorityColor
// ---------------------------------------------------------------------------

describe("getPriorityColor", () => {
  it("returns the correct colour for each known priority", () => {
    expect(getPriorityColor(Priority.Critical)).toBe("#ef4444");
    expect(getPriorityColor(Priority.High)).toBe("#f97316");
    expect(getPriorityColor(Priority.Medium)).toBe("#eab308");
    expect(getPriorityColor(Priority.Low)).toBe("#22c55e");
  });

  it("returns an empty string for undefined", () => {
    expect(getPriorityColor(undefined)).toBe("");
  });

  it("returns an empty string for an unrecognised priority", () => {
    expect(getPriorityColor("ultra" as Priority)).toBe("");
  });
});

describe("priorityRank", () => {
  it("ranks critical above high above medium above low above lowest", () => {
    const ranks = [Priority.Critical, Priority.High, Priority.Medium, Priority.Low, Priority.Lowest]
      .map(priorityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it("ranks an unset priority below every set one", () => {
    expect(priorityRank(null)).toBe(0);
    expect(priorityRank(Priority.Lowest)).toBeGreaterThan(priorityRank(null));
  });

  it("ranks a value from outside the scale as unset", () => {
    expect(priorityRank("urgent-ish" as Priority)).toBe(0);
  });

  it("ranks lowest between low and unset, so a ⏬ line never ties with an untriaged one", () => {
    expect(priorityRank(Priority.Lowest)).toBeLessThan(priorityRank(Priority.Low));
    expect(priorityRank(Priority.Lowest)).toBeGreaterThan(priorityRank(Priority.None));
  });

  it("leaves room under every level for a tiebreak fraction", () => {
    const gaps = [Priority.Critical, Priority.High, Priority.Medium, Priority.Low, Priority.Lowest]
      .map(priorityRank)
      .map((r, i, all) => r - (all[i + 1] ?? 0));
    // `priorityKey` adds `rank / 1000` under the level in force; the narrowest gap
    // must stay wider than the largest fraction, or a tiebreak could cross a level.
    expect(Math.min(...gaps)).toBeGreaterThan(priorityRank(Priority.Critical) / 1000);
  });
});

describe("maxPriority", () => {
  it("returns the more urgent of two levels", () => {
    expect(maxPriority(Priority.Low, Priority.High)).toBe(Priority.High);
    expect(maxPriority(Priority.High, Priority.Low)).toBe(Priority.High);
  });

  it("treats an unset level as the least urgent", () => {
    expect(maxPriority(undefined, Priority.Lowest)).toBe(Priority.Lowest);
    expect(maxPriority(Priority.Lowest, undefined)).toBe(Priority.Lowest);
  });

  it("returns undefined when neither is set", () => {
    expect(maxPriority(undefined, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The row surface — what a row draws, answered by the task itself
// ---------------------------------------------------------------------------

describe("BaseTask row surface", () => {
  // Typed as `BaseTask`: these tests are about the surface a row renders through,
  // not about either concrete class.
  const projectTask = (fields: Partial<ProjectTaskFields> = {}): BaseTask => newTask({
    id: "t1", title: "Write the spec", projectId: "p", status: Status.Todo,
    dependencies: [], filePath: "t1.md", ...fields,
  });
  const line = (raw: string): BaseTask => Task.parse(raw, 0)!;

  describe("tagNames — bare either way", () => {
    it("passes a project task's tags through, which frontmatter already stores bare", () => {
      expect(projectTask({ tags: ["home", "admin"] }).tagNames).toEqual(["home", "admin"]);
    });

    it("reads an unset tag list as none", () => {
      expect(projectTask().tagNames).toEqual([]);
    });

    it("strips the # a checklist line stores", () => {
      expect(line("- [ ] Water plants #home").tagNames).toEqual(["home"]);
    });

    it("matches a tag given bare, whichever kind holds it", () => {
      expect(projectTask({ tags: ["daily"] }).hasTag("daily")).toBe(true);
      expect(line("- [ ] Stretch #daily").hasTag("daily")).toBe(true);
      expect(line("- [ ] Stretch").hasTag("daily")).toBe(false);
    });
  });

  describe("statusValue and isClosed", () => {
    it("reads a project task's own status", () => {
      expect(projectTask({ status: Status.InProgress }).statusValue).toBe(Status.InProgress);
    });

    it("counts done and cancelled as closed, and nothing else", () => {
      expect(projectTask({ status: Status.Done }).isClosed).toBe(true);
      expect(projectTask({ status: Status.Cancelled }).isClosed).toBe(true);
      expect(projectTask({ status: Status.InProgress }).isClosed).toBe(false);
    });

    it("reads a ticked line as done and an open one as todo", () => {
      expect(line("- [x] Done thing").statusValue).toBe(Status.Done);
      expect(line("- [x] Done thing").isClosed).toBe(true);
      expect(line("- [ ] Open thing").isClosed).toBe(false);
    });

    it("ignores ancestors — a task under a cancelled parent still reads open", () => {
      // The tree-aware answer is `effectiveStatus`, which needs the whole task list.
      expect(projectTask({ parentId: "gone", status: Status.Todo }).isClosed).toBe(false);
    });
  });

  describe("statusScale — what control the row draws", () => {
    it("gives a project task the full picker scale", () => {
      expect(projectTask().statusScale).toEqual(STATUSES);
      expect(projectTask().statusScale.length).toBeGreaterThan(2);
    });

    it("gives a checklist line two rungs, which is what makes a row draw a checkbox", () => {
      expect(line("- [ ] Anything").statusScale).toEqual([Status.Todo, Status.Done]);
    });
  });

  describe("rowTitle", () => {
    it("leaves a project task's title alone", () => {
      expect(projectTask({ title: "Write #docs" }).rowTitle("daily")).toBe("Write #docs");
    });

    it("drops the tag that marks a habit line, keeping any other", () => {
      expect(line("- [ ] Stretch #daily #home").rowTitle("daily")).toBe("Stretch #home");
    });
  });

  describe("closedOn", () => {
    it("is null while a task is open", () => {
      expect(projectTask().closedOn).toBeNull();
      expect(line("- [ ] Open").closedOn).toBeNull();
    });

    it("is the instant a project task closed", () => {
      const at = new Date(2026, 6, 1);
      expect(projectTask({ status: Status.Done, completed: at }).closedOn).toEqual(at);
    });

    it("is the day a line was ticked, when it records one", () => {
      expect(line("- [x] Done ✅ 2026-07-01").closedOn).toEqual(day("2026-07-01"));
    });
  });
});

// ---------------------------------------------------------------------------
// The ordering surface — what a list compares on
// ---------------------------------------------------------------------------

describe("BaseTask ordering surface", () => {
  const projectTask = (fields: Partial<ProjectTaskFields> = {}): BaseTask => newTask({
    id: "t1", title: "Write the spec", projectId: "p", status: Status.Todo,
    dependencies: [], filePath: "t1.md", ...fields,
  });
  const line = (raw: string): BaseTask => Task.parse(raw, 0)!;

  /** A roll-up for `t1` alone, as `computeEffectiveValues` would hand one over. */
  const rollupFor = (r: Rollup): RollupLookup => (id) => (id === "t1" ? r : undefined);

  describe("rollupId — which kind inherits anything", () => {
    it("is a project task's id, which is what a roll-up is keyed on", () => {
      expect(projectTask().rollupId).toBe("t1");
    });

    it("is null for a checklist line, which has no tree above it", () => {
      expect(line("- [ ] Anything").rollupId).toBeNull();
    });
  });

  describe("ownDue", () => {
    it("is a project task's own deadline, ignoring inheritance", () => {
      expect(projectTask({ due: day("2026-07-10") }).ownDue).toEqual(day("2026-07-10"));
      expect(projectTask().ownDue).toBeNull();
    });

    it("prefers a line's 📅 deadline over the ⏳ day it is aimed at", () => {
      expect(line("- [ ] Thing 📅 2026-07-10 ⏳ 2026-07-20").ownDue).toEqual(day("2026-07-10"));
    });

    it("falls back to the ⏳ day when there is no deadline", () => {
      expect(line("- [ ] Thing ⏳ 2026-07-20").ownDue).toEqual(day("2026-07-20"));
    });
  });

  describe("fileLine", () => {
    it("is a line's position in its file", () => {
      expect(Task.parse("- [ ] Thing", 7)!.fileLine).toBe(7);
    });

    it("is null for a project task, which has a file of its own", () => {
      expect(projectTask().fileLine).toBeNull();
    });
  });

  describe("the four priority levels", () => {
    it("reads all four off the roll-up when there is one", () => {
      const rollup = rollupFor({
        priority: Priority.Critical,
        ancestorPriority: Priority.High,
        subtreePriority: Priority.Critical,
        due: day("2026-07-01"),
      });
      const t = projectTask({ priority: Priority.Low, due: day("2026-08-01") });
      expect(t.priorityInForce(rollup)).toBe(Priority.Critical);
      expect(t.priorityFromAbove(rollup)).toBe(Priority.High);
      expect(t.priorityFromBelow(rollup)).toBe(Priority.Critical);
      expect(t.dueInForce(rollup)).toEqual(day("2026-07-01"));
      // The level it carries itself is untouched by any of that — it is the ribbon's fill.
      expect(t.ownPriority).toBe(Priority.Low);
    });

    it("falls back to what the task carries when no roll-up covers it", () => {
      const t = projectTask({ priority: Priority.Medium, due: day("2026-08-01") });
      for (const rollup of [undefined, rollupFor({ priority: Priority.Critical })]) {
        // The second lookup answers for `t1`; give the task another id so it misses.
        const other = newTask({
          id: "elsewhere", title: "x", projectId: "p", status: Status.Todo,
          priority: Priority.Medium, due: day("2026-08-01"),
          dependencies: [], filePath: "x.md",
        });
        const subject = rollup ? other : t;
        expect(subject.priorityInForce(rollup)).toBe(Priority.Medium);
        expect(subject.priorityFromAbove(rollup)).toBe(Priority.Medium);
        expect(subject.priorityFromBelow(rollup)).toBe(Priority.Medium);
        expect(subject.dueInForce(rollup)).toEqual(day("2026-08-01"));
      }
    });

    it("shows a task under an ancestor's sooner deadline, and under its own without one", () => {
      const rollup = rollupFor({ due: day("2026-07-01") });
      const t = projectTask({ due: day("2026-08-01") });
      expect(t.plannedDateInForce(rollup)).toEqual(day("2026-07-01"));
      expect(t.plannedDateInForce()).toEqual(day("2026-08-01"));
    });

    it("shows a checklist line under its note's day, which no roll-up covers", () => {
      // Unlike `dueInForce`, the day a line belongs to is the note it is written in.
      const l = line("- [ ] Thing 📅 2026-07-10");
      expect(l.plannedDateInForce(rollupFor({ due: day("2026-07-01") }))).toEqual(l.plannedDate);
    });

    it("collapses all four onto its own level for a line, which has no tree either way", () => {
      // Even handed a roll-up, a line has no id to look itself up by.
      const rollup = rollupFor({ priority: Priority.Critical, subtreePriority: Priority.Critical });
      const l = line("- [ ] Thing ⏫ 📅 2026-07-10");
      expect(l.priorityInForce(rollup)).toBe(Priority.High);
      expect(l.priorityFromAbove(rollup)).toBe(Priority.High);
      expect(l.priorityFromBelow(rollup)).toBe(Priority.High);
      expect(l.dueInForce(rollup)).toEqual(day("2026-07-10"));
    });
  });
});

// ---------------------------------------------------------------------------
// compareTo — the one order, across both kinds
// ---------------------------------------------------------------------------

describe("BaseTask.compareTo", () => {
  const task = (id: string, fields: Partial<ProjectTaskFields> = {}): BaseTask => newTask({
    id, title: id, projectId: "p", status: Status.Todo,
    dependencies: [], filePath: `${id}.md`, ...fields,
  });
  const line = (raw: string, at = 0): BaseTask => Task.parse(raw, at)!;

  const order = (items: BaseTask[], key: TaskSortKey, dir?: TaskSortDir, rollup?: RollupLookup) =>
    [...items].sort(BaseTask.comparator({ key, dir, rollup })).map((t) => t.title);

  describe("closed work sinks, in every mode", () => {
    const open = task("Open", { priority: Priority.Low });
    const done = task("Done", { status: Status.Done, priority: Priority.Critical });

    it("puts a closed task last however urgent it is", () => {
      for (const key of [TaskSortKey.Priority, TaskSortKey.Due, TaskSortKey.Title, TaskSortKey.Created]) {
        expect(order([done, open], key)).toEqual(["Open", "Done"]);
      }
    });

    it("does not flip with the direction — closed is not a key, it is a band", () => {
      expect(order([done, open], TaskSortKey.Priority, TaskSortDir.Asc)).toEqual(["Open", "Done"]);
    });

    it("counts a cancelled task as closed too", () => {
      const cancelled = task("Cancelled", { status: Status.Cancelled, priority: Priority.Critical });
      expect(order([cancelled, open], TaskSortKey.Priority)).toEqual(["Open", "Cancelled"]);
    });

    it("sinks a ticked checklist line the same way", () => {
      expect(order([line("- [x] Ticked ⏫"), line("- [ ] Untouched 🔽", 1)], TaskSortKey.Priority))
        .toEqual(["Untouched", "Ticked"]);
    });
  });

  describe("a task with no priority at all", () => {
    it("sorts after one that carries a level, whichever side it starts on", () => {
      const rated = task("Rated", { priority: Priority.Low });
      const unrated = task("Unrated");
      expect(order([rated, unrated], TaskSortKey.Priority)).toEqual(["Rated", "Unrated"]);
      expect(order([unrated, rated], TaskSortKey.Priority)).toEqual(["Rated", "Unrated"]);
    });

    it("ties with another that carries none either", () => {
      expect(order([task("B"), task("A")], TaskSortKey.Priority)).toEqual(["B", "A"]);
    });
  });

  describe("the two-level priority rule", () => {
    /** Both read High — under one high parent, say — and differ only below. */
    const rollup: RollupLookup = (id) => ({
      priority: Priority.High,
      ancestorPriority: Priority.High,
      subtreePriority: id === "Busy" ? Priority.High : Priority.Medium,
    });

    it("lifts the task whose children are urgent over one that carries more itself", () => {
      const busy = task("Busy", { priority: Priority.Low });
      const quiet = task("Quiet", { priority: Priority.Medium });
      expect(order([quiet, busy], TaskSortKey.Priority, TaskSortDir.Desc, rollup))
        .toEqual(["Busy", "Quiet"]);
    });

    it("does not let the tiebreak cross a level in force", () => {
      // `Quiet` reads High with a Medium subtree; `Lesser` reads Medium with a Critical
      // one. The level in force decides, and the subtree only splits equals.
      const lesser = task("Lesser", { priority: Priority.Critical });
      const withLesser: RollupLookup = (id) => id === "Lesser"
        ? { priority: Priority.Medium, subtreePriority: Priority.Critical }
        : rollup(id);
      expect(order([lesser, task("Quiet")], TaskSortKey.Priority, TaskSortDir.Desc, withLesser))
        .toEqual(["Quiet", "Lesser"]);
    });
  });

  describe("closedLast on its own — the band every list starts from", () => {
    it("answers in both directions, and ties two tasks in the same band", () => {
      const open = task("Open");
      const closed = task("Closed", { status: Status.Done });
      expect(BaseTask.closedLast(closed, open)).toBe(1);
      expect(BaseTask.closedLast(open, closed)).toBe(-1);
      expect(BaseTask.closedLast(open, task("Other"))).toBe(0);
      expect(BaseTask.closedLast(closed, task("Done too", { status: Status.Done }))).toBe(0);
    });
  });

  describe("mixing the two kinds", () => {
    it("orders a line and a project task on one scale", () => {
      const items = [
        task("Project low", { priority: Priority.Low }),
        line("- [ ] Line high ⏫"),
        task("Project critical", { priority: Priority.Critical }),
        line("- [ ] Line lowest ⏬", 1),
      ];
      expect(order(items, TaskSortKey.Priority)).toEqual([
        "Project critical", "Line high", "Project low", "Line lowest",
      ]);
    });

    it("puts a task with no line last in file order, whichever way it runs", () => {
      const items = [task("Project"), line("- [ ] Second", 1), line("- [ ] First", 0)];
      expect(order(items, TaskSortKey.File, TaskSortDir.Asc)).toEqual(["First", "Second", "Project"]);
      expect(order(items, TaskSortKey.File, TaskSortDir.Desc)).toEqual(["Second", "First", "Project"]);
    });

    it("reads a project task's deadline through the roll-up, a line's off the line", () => {
      const inherited: RollupLookup = () => ({ due: day("2026-07-01") });
      const items = [line("- [ ] Line 📅 2026-07-15"), task("Project", { due: day("2026-08-01") })];
      // The project task's own deadline is later, but the one it is held to is sooner.
      expect(order(items, TaskSortKey.Due, TaskSortDir.Asc, inherited)).toEqual(["Project", "Line"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Ordering a list of them
// ---------------------------------------------------------------------------

/** A checklist line, which is one of the two kinds of task a list holds. */
function task(rawLine: string, lineIndex = 0): Task {
  return Task.parse(rawLine, lineIndex)!;
}

describe("sortInboxItems", () => {
  const dated = (title: string, date: string, marker = "") =>
    task(`- [ ] ${title}${marker ? ` ${marker}` : ""} ➕ ${date}`);

  it("sorts by creation date, newest first, by default", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    expect(sortInboxItems(items).map((i) => i.title)).toEqual(["New", "Old"]);
  });

  it("puts undated items after every dated one, in file order", () => {
    const items = [task("- [ ] Undated A"), dated("Dated", "2026-06-01"), task("- [ ] Undated B")];
    expect(sortInboxItems(items).map((i) => i.title)).toEqual(["Dated", "Undated A", "Undated B"]);
  });

  it("sorts by priority, most urgent first, in priority mode", () => {
    const items = [
      dated("Low", "2026-06-20", "🔽"),
      dated("Critical", "2026-06-01", "🔺"),
      dated("Medium", "2026-06-10", "🔼"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["Critical", "Medium", "Low"]);
  });

  it("puts items with no priority last in priority mode, however recent", () => {
    const items = [dated("None", "2026-06-20"), dated("Low", "2026-06-01", "🔽")];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["Low", "None"]);
  });

  it("falls back to newest-first within one priority level", () => {
    const items = [dated("Older", "2026-06-01", "⏫"), dated("Newer", "2026-06-20", "⏫")];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("sorts by deadline, soonest first, in due mode", () => {
    const items = [
      dated("Later", "2026-06-01", "📅 2026-07-10"),
      dated("Sooner", "2026-06-01", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due).map((i) => i.title)).toEqual(["Sooner", "Later"]);
  });

  it("puts items with no deadline last in due mode, however recent", () => {
    const items = [dated("None", "2026-06-20"), dated("Dated", "2026-06-01", "📅 2026-12-31")];
    expect(sortInboxItems(items, TaskSortKey.Due).map((i) => i.title)).toEqual(["Dated", "None"]);
  });

  it("falls back to newest-first within one deadline in due mode", () => {
    const items = [
      dated("Older", "2026-06-01", "📅 2026-06-30"),
      dated("Newer", "2026-06-20", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("sorts by title in title mode, ignoring case and accents", () => {
    const items = [task("- [ ] banana"), task("- [ ] Écrire"), task("- [ ] Apple")];
    expect(sortInboxItems(items, TaskSortKey.Title).map((i) => i.title)).toEqual(["Apple", "banana", "Écrire"]);
  });

  it("keeps the file's own order in file mode", () => {
    const items = [
      Task.parse("- [ ] Zebra ➕ 2026-06-01", 2)!,
      Task.parse("- [ ] Apple ➕ 2026-06-20", 0)!,
      Task.parse("- [ ] Mango 🔺 ➕ 2026-06-10", 1)!,
    ];
    expect(sortInboxItems(items, TaskSortKey.File).map((i) => i.title)).toEqual(["Apple", "Mango", "Zebra"]);
  });

  it("reverses the created order when asked for ascending", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    expect(sortInboxItems(items, TaskSortKey.Created, TaskSortDir.Asc).map((i) => i.title)).toEqual(["Old", "New"]);
  });

  it("keeps undated items last in ascending created order", () => {
    const items = [task("- [ ] Undated"), dated("Dated", "2026-06-01")];
    expect(sortInboxItems(items, TaskSortKey.Created, TaskSortDir.Asc).map((i) => i.title)).toEqual(["Dated", "Undated"]);
  });

  it("reverses the priority order, keeping unset priorities last", () => {
    const items = [
      dated("None", "2026-06-15"),
      dated("High", "2026-06-01", "⏫"),
      dated("Low", "2026-06-10", "🔽"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Priority, TaskSortDir.Asc).map((i) => i.title)).toEqual(["Low", "High", "None"]);
  });

  it("reverses the deadline order, keeping items with no deadline last", () => {
    const items = [
      dated("Sooner", "2026-06-01", "📅 2026-06-30"),
      dated("None", "2026-06-15"),
      dated("Later", "2026-06-10", "📅 2026-07-10"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Later", "Sooner", "None"]);
  });

  it("reverses the title order", () => {
    const items = [task("- [ ] Apple"), task("- [ ] banana"), task("- [ ] Cherry")];
    expect(sortInboxItems(items, TaskSortKey.Title, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Cherry", "banana", "Apple"]);
  });

  it("reverses file order in file mode", () => {
    const items = [
      Task.parse("- [ ] First ➕ 2026-06-01", 0)!,
      Task.parse("- [ ] Second ➕ 2026-06-02", 1)!,
    ];
    expect(sortInboxItems(items, TaskSortKey.File, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Second", "First"]);
  });

  it("still breaks ties newest-first in a reversed mode", () => {
    const items = [
      dated("Older", "2026-06-01", "📅 2026-06-30"),
      dated("Newer", "2026-06-20", "📅 2026-06-30"),
    ];
    expect(sortInboxItems(items, TaskSortKey.Due, TaskSortDir.Desc).map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("does not mutate the caller's array", () => {
    const items = [dated("Old", "2026-06-01"), dated("New", "2026-06-20")];
    sortInboxItems(items, TaskSortKey.Priority);
    expect(items.map((i) => i.title)).toEqual(["Old", "New"]);
  });
});

describe("resolveTaskSortDir", () => {
  it("falls back to each mode's own default direction", () => {
    expect(resolveTaskSortDir(TaskSortKey.Created)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Priority)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Due)).toBe(TaskSortDir.Asc);
    expect(resolveTaskSortDir(TaskSortKey.Title)).toBe(TaskSortDir.Asc);
    expect(resolveTaskSortDir(TaskSortKey.File)).toBe(TaskSortDir.Asc);
  });

  it("prefers the stored direction for that mode only", () => {
    const stored = { [TaskSortKey.Title]: TaskSortDir.Desc };
    expect(resolveTaskSortDir(TaskSortKey.Title, stored)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Created, stored)).toBe(TaskSortDir.Desc);
    expect(resolveTaskSortDir(TaskSortKey.Due, stored)).toBe(TaskSortDir.Asc);
  });
});

describe("sortInboxItems — the mode's own key comes first", () => {
  const line = (title: string, marker: string, created: string) =>
    Task.parse(`- [ ] ${title}${marker} ➕ ${created}`, 0)!;

  it("orders by creation date in Created mode, whatever the priorities say", () => {
    const urgentButNew = line("New", " 🔺", "2026-06-20");
    const calmButOld = line("Old", " 🔽", "2026-06-01");
    // Oldest first, ascending: the mode's key wins, and priority only breaks its ties.
    expect(sortInboxItems([urgentButNew, calmButOld], TaskSortKey.Created, TaskSortDir.Asc)[0])
      .toBe(calmButOld);
  });
});

describe("sortInboxItems — ties", () => {
  const line = (title: string, marker: string, created: string) =>
    Task.parse(`- [ ] ${title}${marker} ➕ ${created}`, 0)!;

  it("orders tasks the mode cannot tell apart by priority, most urgent first", () => {
    // Same title key, same creation day: only the priority marker separates them.
    const low = line("Task", " 🔽", "2026-06-01");
    const high = line("Task", " ⏫", "2026-06-01");
    const sorted = sortInboxItems([low, high], TaskSortKey.Title, TaskSortDir.Asc);
    expect(sorted[0]).toBe(high);
  });

  it("keeps priority as the tie-break whichever way the mode reads", () => {
    const low = line("Task", " 🔽", "2026-06-01");
    const high = line("Task", " ⏫", "2026-06-01");
    const sorted = sortInboxItems([low, high], TaskSortKey.Title, TaskSortDir.Desc);
    expect(sorted[0]).toBe(high);
  });

  it("falls back to the newest first once the priorities tie too", () => {
    const older = line("Task", "", "2026-06-01");
    const newer = line("Task", "", "2026-06-20");
    expect(sortInboxItems([older, newer], TaskSortKey.Title, TaskSortDir.Asc)[0]).toBe(newer);
  });
});

describe("sortInboxItems — inherited priority", () => {
  /** A project task reading as `inherited`, whatever it carries itself. `subtree` is the
   *  level it rolls up from itself and its children — its own, unless one is given. */
  const under = (title: string, own: Priority | undefined, inherited: Priority, subtree?: Priority) => {
    const task = newTask({
      id: title, title, projectId: "p", status: "todo", priority: own,
      dependencies: [], filePath: `${title}.md`,
    });
    return { task, inherited, subtree: subtree ?? own ?? Priority.None };
  };

  const sortUnder = (
    rows: ReturnType<typeof under>[],
    dir: TaskSortDir = TaskSortDir.Desc,
  ) => {
    const effectiveValues = new Map(rows.map(({ task, inherited, subtree }) => [task.id, {
      priority: inherited, ancestorPriority: inherited, subtreePriority: subtree, due: undefined,
    }]));
    return sortInboxItems(rows.map((r) => r.task), TaskSortKey.Priority, dir, effectiveValues)
      .map((t) => t.title);
  };

  const rows = [
    under("Unset", undefined, Priority.High),
    under("Medium", Priority.Medium, Priority.High),
    under("High", Priority.High, Priority.High),
  ];

  it("splits tasks of one inherited level by the level each rolls up from below", () => {
    expect(sortUnder(rows)).toEqual(["High", "Medium", "Unset"]);
  });

  it("lifts a task whose children are urgent above a sibling that carries more itself", () => {
    // Both read High under one high parent. `Busy` carries Low but holds High work
    // below it; `Quiet` carries Medium and holds nothing.
    expect(sortUnder([
      under("Quiet", Priority.Medium, Priority.High),
      under("Busy", Priority.Low, Priority.High, Priority.High),
    ])).toEqual(["Busy", "Quiet"]);
  });

  it("reverses that tiebreak with the mode", () => {
    expect(sortUnder(rows, TaskSortDir.Asc)).toEqual(["Unset", "Medium", "High"]);
  });

  it("leaves an inbox line, which inherits nothing, on its own priority alone", () => {
    const items = [
      Task.parse("- [ ] Low 🔽 ➕ 2026-06-01", 0)!,
      Task.parse("- [ ] High ⏫ ➕ 2026-06-02", 1)!,
    ];
    expect(sortInboxItems(items, TaskSortKey.Priority).map((i) => i.title)).toEqual(["High", "Low"]);
  });
});

describe("sortInboxItems — file order", () => {
  it("settles the rows with no line in the file by creation date, newest first", () => {
    // Two project tasks: neither has a line in the Inbox file, so the file's other fact
    // decides — not their priorities.
    const older = newTask({
      id: "older", title: "Older", projectId: "p", status: "todo", priority: Priority.Critical,
      createdAt: timestamp("2026-06-01T10:00:00.000Z"), dependencies: [], filePath: "older.md",
    });
    const newer = newTask({
      id: "newer", title: "Newer", projectId: "p", status: "todo", priority: Priority.Low,
      createdAt: timestamp("2026-06-20T10:00:00.000Z"), dependencies: [], filePath: "newer.md",
    });
    const sorted = sortInboxItems([older, newer], TaskSortKey.File, TaskSortDir.Asc);
    expect(sorted.map((t) => t.title)).toEqual(["Newer", "Older"]);
  });

  it("keeps the inbox's own lines in the file's order, ahead of tasks with no line", () => {
    const line = Task.parse("- [ ] A line", 3)!;
    const task = newTask({
      id: "t", title: "A task", projectId: "p", status: "todo",
      dependencies: [], filePath: "t.md",
    });
    expect(sortInboxItems([task, line], TaskSortKey.File, TaskSortDir.Asc).map((t) => t.title))
      .toEqual(["A line", "A task"]);
  });

  it("leaves the tasks with no line last when the file is read backwards too", () => {
    // Reversing the file reverses its lines; a row that has none is missing the mode's
    // key, and a missing key stays last either way, as in every other mode.
    const first = Task.parse("- [ ] First", 1)!;
    const second = Task.parse("- [ ] Second", 5)!;
    const task = newTask({
      id: "t", title: "A task", projectId: "p", status: "todo",
      dependencies: [], filePath: "t.md",
    });
    expect(sortInboxItems([task, first, second], TaskSortKey.File, TaskSortDir.Desc).map((t) => t.title))
      .toEqual(["Second", "First", "A task"]);
  });
});
