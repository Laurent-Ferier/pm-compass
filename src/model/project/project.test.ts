import { describe, it, expect } from "vitest";
import { ProjectTask, type ProjectTaskFields } from "./project-task";
import { isTask } from "./project";
import { newProject, newTask } from "../__testing__/notes";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ProjectTaskFields> & { id: string }): ProjectTask {
  return newTask({
    title: overrides.id,
    projectId: "proj-1",
    parentId: undefined,
    status: "todo",
    dependencies: [],
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
    const project = newProject({
      id: "p1",
      title: "My project",
      filePath: "Projects/p1.md",
    });
    expect(isTask(project)).toBe(false);
  });
});
