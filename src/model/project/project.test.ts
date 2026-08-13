import { describe, it, expect } from "vitest";
import { ProjectTask, type ProjectTaskFields } from "./project-task";
import { DEFAULT_PROJECT_ICON, isTask } from "./project";
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

// ── chosenIcon ───────────────────────────────────────────────────────────────

describe("the icon that says which project this is", () => {
  const project = (icon?: string) =>
    newProject({ id: "p1", title: "Alpha", filePath: "Projects/p1.md", icon });

  it("is the one the project was given", () => {
    expect(project("🚀").chosenIcon).toBe("🚀");
    expect(project("folder-check").chosenIcon).toBe("folder-check");
  });

  it("is none where the note still carries the default every project is born with", () => {
    const born = project(DEFAULT_PROJECT_ICON);
    expect(born.icon).toBe(DEFAULT_PROJECT_ICON);
    expect(born.chosenIcon).toBeUndefined();
  });

  it("is none where the note carries no icon at all", () => {
    expect(project().chosenIcon).toBeUndefined();
  });
});
