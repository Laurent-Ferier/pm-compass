// @vitest-environment jsdom
import { vi, describe, it, expect } from "vitest";

vi.mock("obsidian", async () => ({
  TFile: class { path = ""; },
  normalizePath: (p: string) => p,
  moment: (await import("../__testing__/day-moment")).dayMoment,
}));

import { InBox } from "./inbox";
import type { ModelCache } from "../base-model";
import type { IModel } from "../i-model";
import type { ProjectCache } from "../cache/project-cache";
import type { ProjectTask, ProjectTaskFields } from "../project/project-task";
import type { Project } from "../project/project";
import { CacheEvent } from "../cache/cache-events";
import { Priority } from "../base-task";
import { makeDayVault } from "../__testing__/day-vault";
import { newTask, newProject } from "../__testing__/notes";
import { day } from "../__testing__/dates";

const PATH = "Inbox.md";

function cache(): ModelCache & { told: IModel[] } {
  const told: IModel[] = [];
  return { told, changed: (model) => { told.push(model); } };
}

function task(overrides: Partial<ProjectTaskFields> & { id: string }): ProjectTask {
  return newTask({
    title: overrides.id,
    projectId: "p1",
    status: "todo",
    priority: Priority.Medium,
    dependencies: [],
    filePath: `Projects/${overrides.id}.md`,
    ...overrides,
  });
}

/** The projects folder as the inbox reads it: its two lists, and the telling it listens to. */
function folder(tasks: ProjectTask[], projects: Project[] = []) {
  const handlers: ((payload: { paths: string[] }) => void)[] = [];
  const held = {
    tasks,
    projects,
    on: (event: CacheEvent, handler: (payload: { paths: string[] }) => void) => {
      expect(event).toBe(CacheEvent.ProjectsChanged);
      handlers.push(handler);
      return () => { handlers.splice(handlers.indexOf(handler), 1); };
    },
  };
  return {
    held: held as unknown as ProjectCache,
    say: (paths: string[]) => { for (const h of [...handlers]) h({ paths }); },
    listeners: () => handlers.length,
    put: (next: ProjectTask[]) => { held.tasks = next; },
  };
}

async function inbox(projects: ReturnType<typeof folder>, text = "- [ ] Answer the tender") {
  const vault = makeDayVault({ [PATH]: text });
  const file = vault.files.file(PATH);
  const told = cache();
  const note = new InBox(file, told, projects.held);
  file.fill(await file.read());
  return { vault, file, note, told };
}

describe("InBox", () => {
  it("holds its own lines, as any day note does", async () => {
    const { note } = await inbox(folder([]));

    expect(note.items.map((t) => t.title)).toEqual(["Answer the tender"]);
    expect(note.date).toBeNull();
  });

  it("picks the project tasks carrying a priority and no date", async () => {
    const dated = task({ id: "dated", due: day("2026-08-20") });
    const picked = task({ id: "undated" });

    const { note } = await inbox(folder([dated, picked]));

    expect(note.undated.tasks.map((t) => t.id)).toEqual(["undated"]);
  });

  it("leaves out an archived project's tasks, put away rather than undone", async () => {
    const kept = task({ id: "kept", projectId: "p1" });
    const shelved = task({ id: "shelved", projectId: "p2" });
    const projects = [
      newProject({ id: "p1", title: "p1", filePath: "Projects/p1.md", archived: false }),
      newProject({ id: "p2", title: "p2", filePath: "Projects/p2.md", archived: true }),
    ];

    const { note } = await inbox(folder([kept, shelved], projects));

    expect(note.undated.tasks.map((t) => t.id)).toEqual(["kept"]);
  });

  it("picks over the same folder reading only once", async () => {
    const { note } = await inbox(folder([task({ id: "one" })]));

    expect(note.undated).toBe(note.undated);
  });

  it("picks again once the folder hands over another reading", async () => {
    const projects = folder([task({ id: "one" })]);
    const { note } = await inbox(projects);
    const first = note.undated;

    projects.put([task({ id: "one" }), task({ id: "two" })]);

    expect(note.undated).not.toBe(first);
    expect(note.undated.tasks.map((t) => t.id)).toEqual(["one", "two"]);
  });

  it("wakes when the folder's change moved what it shows", async () => {
    const projects = folder([task({ id: "one" })]);
    const { note, told } = await inbox(projects);
    void note.undated;
    told.told.length = 0;

    projects.put([task({ id: "one" }), task({ id: "two" })]);
    projects.say(["Projects/two.md"]);

    expect(told.told).toContain(note);
  });

  it("wakes when a task it holds is the one that changed", async () => {
    const projects = folder([task({ id: "one" })]);
    const { note, told } = await inbox(projects);
    void note.undated;
    told.told.length = 0;

    projects.say(["Projects/one.md"]);

    expect(told.told).toContain(note);
  });

  it("says nothing about a change to a note it shows nothing of", async () => {
    const projects = folder([task({ id: "one" })]);
    const { note, told } = await inbox(projects);
    void note.undated;
    told.told.length = 0;

    projects.say(["Projects/elsewhere.md"]);

    expect(told.told).not.toContain(note);
  });

  it("stops listening to the folder once its note is gone", async () => {
    const projects = folder([task({ id: "one" })]);
    const { note } = await inbox(projects);
    expect(projects.listeners()).toBe(1);

    note.discard();

    expect(projects.listeners()).toBe(0);
    expect(note.isGone).toBe(true);
  });
});
