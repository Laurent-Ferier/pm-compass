import { describe, it, expect } from "vitest";
import { Task, type TaskFields } from "./task";
import { isTask, type Project } from "./project";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
  return new Task({
    title: overrides.id,
    projectId: "proj-1",
    parentId: undefined,
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  });
}

// ── isTask ───────────────────────────────────────────────────────────────────

describe("isTask", () => {
  it("returns true for an object that has projectId (Task)", () => {
    const task = makeTask({ id: "t1" });
    expect(isTask(task)).toBe(true);
  });

  it("returns false for an object that has no projectId (Project)", () => {
    const project: Project = {
      id: "p1",
      title: "My project",
      tasks: [],
      filePath: "Projects/p1.md",
    };
    expect(isTask(project)).toBe(false);
  });
});
