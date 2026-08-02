import { describe, it, expect } from "vitest";
import { activeProjects, withoutArchivedTasks } from "./archive";
import { Task } from "./task";
import type { Project } from "./project";

function makeProject(id: string, archived?: boolean): Project {
  return { id, title: id, tasks: [], filePath: `Projects/${id}.md`, archived };
}

function makeTask(id: string, projectId: string): Task {
  return new Task({
    id,
    projectId,
    title: id,
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `Projects/${projectId}/tasks/${id}.md`,
  });
}

const LIVE = makeProject("live");
const PUT_AWAY = makeProject("put-away", true);

describe("activeProjects", () => {
  it("drops the archived ones", () => {
    expect(activeProjects([LIVE, PUT_AWAY])).toEqual([LIVE]);
  });

  it("keeps a project whose archived flag is absent", () => {
    expect(activeProjects([LIVE])).toEqual([LIVE]);
  });
});

describe("withoutArchivedTasks", () => {
  it("drops the tasks of an archived project", () => {
    const kept = makeTask("t1", "live");
    const dropped = makeTask("t2", "put-away");
    expect(withoutArchivedTasks([kept, dropped], [LIVE, PUT_AWAY])).toEqual([kept]);
  });

  it("hands back the same array when nothing is archived", () => {
    const tasks = [makeTask("t1", "live")];
    expect(withoutArchivedTasks(tasks, [LIVE])).toBe(tasks);
  });

  it("keeps a task whose project is not in the list at all", () => {
    const orphan = makeTask("t1", "gone");
    expect(withoutArchivedTasks([orphan], [PUT_AWAY])).toEqual([orphan]);
  });
});
