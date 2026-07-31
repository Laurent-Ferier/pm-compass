import { vi, describe, it, expect } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    constructor(public path: string) {}
  }
  return { MockTFile };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  normalizePath: (p: string) => p,
  App: class {},
  // Reached transitively via day-task-actions; promotion never formats a date
  // through it, so a minimal stand-in suffices.
  moment: (v?: unknown) => {
    const d = v ? new Date(v as string) : new Date("2026-07-01");
    return { format: (fmt: string) => d.toISOString().slice(0, fmt === "YYYY-MM-DD" ? 10 : 19) };
  },
}));

import { makeApp } from "../__testing__/mock-app";
import { promoteChecklistItem } from "./checklist-promote";
import { DayTask } from "../daily/day-task";
import { Task } from "../project/task";
import { MoveChoiceKind } from "../project/task";

const INBOX = "Inbox.md";
const ALPHA = "Projects/Alpha.md";

const PROJECT_CONTENT = [
  "---",
  "pm-project: true",
  'id: "alpha"',
  'title: "Alpha"',
  "taskIds: []",
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "---",
  "",
  "# Alpha",
  "",
  "## Tasks",
  "",
].join("\n");

const OPTS = { projectsFolder: "Projects", habitsTag: "daily" };

const EXISTING = {
  kind: MoveChoiceKind.Existing as const,
  projectId: "alpha",
  projectFilePath: ALPHA,
  projectTitle: "Alpha",
};

/** Parses a real inbox line so the metadata translation is exercised end-to-end. */
function inboxItem(line: string): DayTask {
  const item = DayTask.parse(line, 0);
  if (!item) throw new Error(`unparseable fixture: ${line}`);
  return item;
}

function makeVault(inboxLines: string[], extra: Record<string, string> = {}) {
  return makeApp({
    [INBOX]: inboxLines.join("\n") + "\n",
    [ALPHA]: PROJECT_CONTENT,
    ...extra,
  });
}

/**
 * The task file created under Projects/Alpha_tasks/, as [path, content].
 * Pass `taskId` when the fixture also seeds other task files.
 */
function createdTask(app: ReturnType<typeof makeApp>, taskId?: string): [string, string] {
  const entries = [...app._files.entries()]
    .filter(([p]) => p.startsWith("Projects/Alpha_tasks/"));
  const entry = taskId ? entries.find(([, c]) => c.includes(`id: "${taskId}"`)) : entries[0];
  if (!entry) throw new Error("no task file created");
  return entry;
}

// ---------------------------------------------------------------------------

describe("promoteChecklistItem — existing project", () => {
  const LINE = "- [ ] Write the report ➕ 2026-07-01";

  it("creates a task file in the project's tasks folder", async () => {
    const app = makeVault([LINE]);
    const { taskId, projectId } = await promoteChecklistItem(app, INBOX, inboxItem(LINE), EXISTING, OPTS);

    const [path, content] = createdTask(app);
    expect(path).toBe("Projects/Alpha_tasks/write-the-report.md");
    expect(content).toContain(`id: "${taskId}"`);
    expect(content).toContain('projectId: "alpha"');
    expect(content).toContain("status: todo");
    expect(content).toContain("type: task");
    expect(projectId).toBe("alpha");
  });

  it("removes the inbox line", async () => {
    const app = makeVault([LINE, "- [ ] Keep me ➕ 2026-07-02"]);
    await promoteChecklistItem(app, INBOX, inboxItem(LINE), EXISTING, OPTS);

    const inbox = app._files.get(INBOX) as string;
    expect(inbox).not.toContain("Write the report");
    expect(inbox).toContain("Keep me");
  });

  it("registers the new root task on the project (taskIds + ## Tasks)", async () => {
    const app = makeVault([LINE]);
    const { taskId } = await promoteChecklistItem(app, INBOX, inboxItem(LINE), EXISTING, OPTS);

    const project = app._files.get(ALPHA) as string;
    expect(project).toContain(`"${taskId}"`);
    expect(project).toContain("[[write-the-report|Write the report]]");
  });

  it("links a subtask into its parent rather than the project", async () => {
    const parent = new Task({
      id: "parent", title: "Parent", projectId: "alpha", status: "todo",
      dependencies: [], subtasks: [], filePath: "Projects/Alpha_tasks/parent.md",
    });
    const app = makeVault([LINE], {
      "Projects/Alpha_tasks/parent.md": [
        "---", "pm-task: true", 'id: "parent"', 'title: "Parent"',
        'projectId: "alpha"', "subtaskIds: []", "dependencies: []", "---", "",
        "Project: [[Alpha|Alpha]]", "",
      ].join("\n"),
    });

    const { taskId } = await promoteChecklistItem(
      app, INBOX, inboxItem(LINE), { ...EXISTING, parentTask: parent }, OPTS,
    );

    expect(app._files.get("Projects/Alpha_tasks/parent.md")).toContain(`"${taskId}"`);
    expect(app._files.get(ALPHA)).not.toContain(`"${taskId}"`);

    const [, content] = createdTask(app, taskId);
    expect(content).toContain('parentId: "parent"');
    expect(content).toContain("type: subtask");
  });
});

describe("promoteChecklistItem — metadata translation", () => {
  it("promotes a ticked line as an already-done task, closed on the day it was ticked", async () => {
    const line = "- [x] Write the report ➕ 2026-07-01 ✅ 2026-07-10";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    const [, content] = createdTask(app);
    expect(content).toContain("status: done");
    expect(content).toContain('completed: "2026-07-10T00:00:00.000Z"');
    // Progress stays the user's own, as it does for a task closed from the dashboard.
    expect(content).not.toContain("progress:");
  });

  it("lists a ticked line's task in the project with its box already ticked", async () => {
    const line = "- [x] Write the report ✅ 2026-07-10";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    expect(app._files.get(ALPHA)).toMatch(/- \[x\] \[\[[^\]]*\|Write the report\]\]/);
  });

  it("closes a ticked line with no ✅ date on the day its note is for", async () => {
    const line = "- [x] Write the report";
    const app = makeVault([], { "2026-07-15.md": `${line}\n` });
    const item = inboxItem(line).withSource("2026-07-15.md", new Date(2026, 6, 15));
    await promoteChecklistItem(app, "2026-07-15.md", item, EXISTING, OPTS);

    expect(createdTask(app)[1]).toContain('completed: "2026-07-15T00:00:00.000Z"');
  });

  it("closes a ticked inbox line today, the inbox note standing for no day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 9, 30));
    try {
      const line = "- [x] Write the report";
      const app = makeVault([line]);
      await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

      expect(createdTask(app)[1]).toContain('completed: "2026-07-20T');
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an unticked line's task open, with no completion date", async () => {
    const line = "- [ ] Write the report ➕ 2026-07-01";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    const [, content] = createdTask(app);
    expect(content).toContain("status: todo");
    expect(content).not.toContain("completed:");
    expect(content).not.toContain("progress:");
  });

  it("carries start and due dates across", async () => {
    const line = "- [ ] Ship it ➕ 2026-07-01 🛫 2026-07-05 📅 2026-07-20";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    const [, content] = createdTask(app);
    expect(content).toContain('start: "2026-07-05"');
    expect(content).toContain('due: "2026-07-20"');
  });

  it("promotes a planned day into the deadline when there is no 📅 date", async () => {
    const line = "- [ ] Ship it ➕ 2026-07-01 ⏳ 2026-07-15";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    expect(createdTask(app)[1]).toContain('due: "2026-07-15"');
  });

  it("promotes the day note's own day into the deadline when the line carries no date", async () => {
    const line = "- [ ] Ship it ➕ 2026-07-01";
    const app = makeVault([], { "2026-07-15.md": `${line}\n` });
    const item = inboxItem(line).withSource("2026-07-15.md", new Date("2026-07-15"));
    await promoteChecklistItem(app, "2026-07-15.md", item, EXISTING, OPTS);

    expect(createdTask(app)[1]).toContain('due: "2026-07-15"');
  });

  it("keeps the 📅 date as the deadline when the item also has a planned day", async () => {
    const line = "- [ ] Ship it ➕ 2026-07-01 ⏳ 2026-07-15 📅 2026-07-20";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    expect(createdTask(app)[1]).toContain('due: "2026-07-20"');
  });

  it("maps each Tasks-plugin priority emoji onto the task vocabulary", async () => {
    for (const [emoji, expected] of [["🔺", "critical"], ["⏫", "high"], ["🔼", "medium"], ["🔽", "low"]]) {
      const line = `- [ ] Thing ${emoji} ➕ 2026-07-01`;
      const app = makeVault([line]);
      await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);
      expect(createdTask(app)[1]).toContain(`priority: ${expected}`);
    }
  });

  it("folds the emoji-only 'lowest' priority into 'low'", async () => {
    // ⏬ has no counterpart in PRIORITIES; writing it through would produce a
    // value no picker can render.
    const line = "- [ ] Someday thing ⏬ ➕ 2026-07-01";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    expect(createdTask(app)[1]).toContain("priority: low");
  });

  it("defaults an unmarked line to medium priority", async () => {
    // Most inbox lines carry no priority marker; landing them unset would sort
    // them below every task that has one.
    const line = "- [ ] Plain thing ➕ 2026-07-01";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    expect(createdTask(app)[1]).toContain("priority: medium");
  });

  it("moves inline #tags into frontmatter and out of the title", async () => {
    const line = "- [ ] Call the bank #errand ➕ 2026-07-01";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    const [, content] = createdTask(app);
    expect(content).toContain('tags: ["errand"]');
    expect(content).toContain('title: "Call the bank"');
    expect(content).not.toContain("#errand");
  });

  it("falls back to the raw title when stripping tags would leave it empty", async () => {
    // An all-tag line has no prose left after displayTitle strips every #tag;
    // promoting it with a blank title would be worse than keeping the raw text.
    const line = "- [ ] #errand ➕ 2026-07-01";
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, inboxItem(line), EXISTING, OPTS);

    const [, content] = createdTask(app);
    expect(content).toContain('title: "#errand"');
    expect(content).toContain('tags: ["errand"]');
  });

  it("keeps the indented notes under an inbox item as the task description", async () => {
    const line = "- [ ] Research options ➕ 2026-07-01";
    const item = inboxItem(line).withSubLines(["    some context", "    and more"]);
    const app = makeVault([line]);
    await promoteChecklistItem(app, INBOX, item, EXISTING, OPTS);

    const [, content] = createdTask(app);
    expect(content).toContain("some context");
    expect(content).toContain("and more");
  });
});

describe("promoteChecklistItem — new project", () => {
  const LINE = "- [ ] Learn Spanish ➕ 2026-07-01";

  it("creates the project file with obsidian-pm's full schema", async () => {
    const app = makeVault([LINE]);
    const { projectId } = await promoteChecklistItem(
      app, INBOX, inboxItem(LINE), { kind: MoveChoiceKind.NewProject, title: "Languages" }, OPTS,
    );

    const project = app._files.get("Projects/languages.md") as string;
    expect(project).toContain("pm-project: true");
    expect(project).toContain(`id: "${projectId}"`);
    expect(project).toContain('title: "Languages"');
    // Fields this plugin never reads, but obsidian-pm expects to find.
    for (const field of ["customFields: []", "teamMembers: []", "savedViews: []", "taskIds:"]) {
      expect(project, field).toContain(field);
    }
    expect(project).toContain("# 📋 Languages");
    expect(project).toContain("## Tasks");
  });

  it("falls back to a 'project' filename when the title has no sluggable characters", async () => {
    const app = makeVault([LINE]);
    await promoteChecklistItem(
      app, INBOX, inboxItem(LINE), { kind: MoveChoiceKind.NewProject, title: "★★★" }, OPTS,
    );

    // slugify drops non-ASCII, leaving nothing, so the file falls back to "project".
    expect(app._files.has("Projects/project.md")).toBe(true);
    expect(app._files.get("Projects/project.md")).toContain('title: "★★★"');
  });

  it("puts the task in the new project and links it there", async () => {
    const app = makeVault([LINE]);
    const { taskId, projectId } = await promoteChecklistItem(
      app, INBOX, inboxItem(LINE), { kind: MoveChoiceKind.NewProject, title: "Languages" }, OPTS,
    );

    const task = app._files.get("Projects/languages_tasks/learn-spanish.md") as string;
    expect(task).toContain(`projectId: "${projectId}"`);
    expect(app._files.get("Projects/languages.md")).toContain(`"${taskId}"`);
    expect(app._files.get(INBOX)).not.toContain("Learn Spanish");
  });
});

describe("promoteChecklistItem — failure handling", () => {
  it("leaves the inbox line intact when the task file cannot be created", async () => {
    const app = makeVault(["- [ ] Fragile ➕ 2026-07-01"]);
    app.vault.create.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      promoteChecklistItem(app, INBOX, inboxItem("- [ ] Fragile ➕ 2026-07-01"), EXISTING, OPTS),
    ).rejects.toThrow("disk full");

    // Losing the item would be worse than leaving a duplicate behind.
    expect(app._files.get(INBOX)).toContain("Fragile");
  });
});

describe("promoteChecklistItem — day-note source", () => {
  const DAY_NOTE = "Daily Notes/2026-07-01.md";
  const LINE = "- [ ] Draft the proposal ➕ 2026-07-01";

  it("promotes a line out of a day note, not just the inbox", async () => {
    const app = makeApp({
      [DAY_NOTE]: ["# Tasks", "", LINE, "- [ ] Something else"].join("\n") + "\n",
      [ALPHA]: PROJECT_CONTENT,
    });

    await promoteChecklistItem(app, DAY_NOTE, inboxItem(LINE), EXISTING, OPTS);

    expect(createdTask(app)[0]).toBe("Projects/Alpha_tasks/draft-the-proposal.md");
    const dayNote = app._files.get(DAY_NOTE) as string;
    expect(dayNote).not.toContain("Draft the proposal");
    // Neighbouring lines and the heading must be left alone.
    expect(dayNote).toContain("Something else");
    expect(dayNote).toContain("# Tasks");
  });
});
