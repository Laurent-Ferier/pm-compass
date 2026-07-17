import { App, Modal, Notice } from "obsidian";
import type { MoveChoice, Project, Task } from "../model/shared";
import { buildChildMap, isValidMoveTarget } from "../model/shared";
import { moveTask } from "../model/task-move";

export type { MoveChoice };

export interface MoveTargetModalOptions {
  heading: string;
  /** Label for the confirm button, e.g. "Move" or "Promote". */
  ctaLabel: string;
  projects: Project[];
  /** Full flat task list; the parent tree is derived per selected project. */
  tasks: Task[];
  allowNewProject?: boolean;
  /** Return a reason to disable a destination, or undefined to allow it. */
  isDisabled?: (choice: MoveChoice) => string | undefined;
  onChoose: (choice: MoveChoice) => void;
}

const NEW_PROJECT_ROW = "__new__";

/**
 * Open the picker for an existing task and perform the move.
 *
 * Lives here rather than on BaseTabView because the graph view has its own
 * context menu and importing BaseTabView from it would close an import cycle.
 */
export function openMoveTaskModal(
  app: App,
  task: Task,
  projects: Project[],
  allTasks: Task[],
  onDone: () => void,
): void {
  new MoveTargetModal(app, {
    heading: `Move "${task.title}"`,
    ctaLabel: "Move",
    projects,
    tasks: allTasks,
    // Moving into a project that doesn't exist yet isn't a thing.
    allowNewProject: false,
    isDisabled: (choice) => {
      if (choice.kind !== "existing") return undefined;
      const check = isValidMoveTarget(allTasks, task.id, {
        projectId: choice.projectId,
        parentTaskId: choice.parentTask?.id,
      });
      return check.valid ? undefined : check.reason;
    },
    onChoose: (choice) => {
      if (choice.kind !== "existing") return;
      moveTask(app, task, {
        projectId: choice.projectId,
        projectFilePath: choice.projectFilePath,
        projectTitle: choice.projectTitle,
        parentTask: choice.parentTask,
      }, allTasks, projects)
        .then(() => {
          new Notice(`Moved "${task.title}"`);
          onDone();
        })
        .catch((e) => {
          console.error("pm-compass: move failed", e);
          new Notice(`Move failed: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
  }).open();
}

/**
 * Picks where a task should land: a project, then optionally a parent task
 * within it. Shared by the inbox-promote flow and the move-existing-task flow,
 * which differ only in whether a brand-new project is on offer and which
 * destinations are legal.
 */
export class MoveTargetModal extends Modal {
  private readonly opts: MoveTargetModalOptions;
  private selectedProject: Project | null = null;
  private selectedParent: Task | undefined;
  /** Set once the user commits to creating a project rather than picking one. */
  private newProjectTitle: string | null = null;
  /** One-shot: focus the project-name input on the render that follows activation. */
  private focusNewProjectInput = false;
  private filter = "";

  private parentPanel!: HTMLElement;
  private projectList!: HTMLElement;
  private ctaBtn!: HTMLButtonElement;

  constructor(app: App, opts: MoveTargetModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("pm-move-target-modal");
    contentEl.createEl("h3", { text: this.opts.heading, cls: "pm-mt-heading" });

    const filterInput = contentEl.createEl("input", {
      type: "text",
      cls: "pm-mt-filter",
      attr: { placeholder: "Filter projects…" },
    });
    filterInput.addEventListener("input", () => {
      this.filter = filterInput.value.trim().toLowerCase();
      this.renderProjects();
    });

    this.projectList = contentEl.createDiv({ cls: "pm-mt-projects" });
    this.parentPanel = contentEl.createDiv({ cls: "pm-mt-parents" });

    const btnRow = contentEl.createDiv({ cls: "pm-mt-buttons" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    this.ctaBtn = btnRow.createEl("button", { text: this.opts.ctaLabel, cls: "mod-cta" });
    this.ctaBtn.addEventListener("click", () => this.commit());

    this.renderProjects();
    this.renderParents();
    this.syncCta();
    filterInput.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** The destination as currently selected, or null when nothing is chosen yet. */
  private currentChoice(): MoveChoice | null {
    if (this.newProjectTitle !== null) {
      return this.newProjectTitle.trim()
        ? { kind: "new-project", title: this.newProjectTitle.trim() }
        : null;
    }
    if (!this.selectedProject) return null;
    return {
      kind: "existing",
      projectId: this.selectedProject.id,
      projectFilePath: this.selectedProject.filePath,
      projectTitle: this.selectedProject.title,
      parentTask: this.selectedParent,
    };
  }

  private disabledReason(choice: MoveChoice): string | undefined {
    return this.opts.isDisabled?.(choice);
  }

  private syncCta(): void {
    const choice = this.currentChoice();
    this.ctaBtn.disabled = !choice || !!this.disabledReason(choice);
  }

  private commit(): void {
    const choice = this.currentChoice();
    if (!choice || this.disabledReason(choice)) return;
    this.close();
    this.opts.onChoose(choice);
  }

  private renderProjects(): void {
    this.projectList.empty();

    const matches = this.opts.projects.filter(
      (p) => !this.filter || p.title.toLowerCase().includes(this.filter),
    );

    if (matches.length === 0 && !this.opts.allowNewProject) {
      this.projectList.createDiv({ cls: "pm-mt-empty", text: "No matching projects" });
      return;
    }

    for (const project of matches) {
      const selected = this.newProjectTitle === null && this.selectedProject?.id === project.id;
      const row = this.projectList.createDiv({
        cls: `pm-mt-row pm-mt-project-row${selected ? " pm-mt-row--selected" : ""}`,
        text: project.title,
      });
      row.addEventListener("click", () => {
        this.selectedProject = project;
        this.selectedParent = undefined;
        this.newProjectTitle = null;
        this.renderProjects();
        this.renderParents();
        this.syncCta();
      });
    }

    if (this.opts.allowNewProject) this.renderNewProjectRow();
  }

  private renderNewProjectRow(): void {
    const active = this.newProjectTitle !== null;
    const row = this.projectList.createDiv({
      cls: `pm-mt-row pm-mt-new-project${active ? " pm-mt-row--selected" : ""}`,
    });

    if (!active) {
      row.setText("+ New project…");
      row.dataset.id = NEW_PROJECT_ROW;
      row.addEventListener("click", () => {
        this.newProjectTitle = "";
        this.focusNewProjectInput = true;
        this.selectedProject = null;
        this.selectedParent = undefined;
        this.renderProjects();
        this.renderParents();
        this.syncCta();
      });
      return;
    }

    const input = row.createEl("input", {
      type: "text",
      cls: "pm-mt-new-project-input",
      attr: { placeholder: "Project name…" },
    });
    input.value = this.newProjectTitle ?? "";
    input.addEventListener("input", () => {
      this.newProjectTitle = input.value;
      this.syncCta();
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); this.commit(); }
    });
    // Only steal focus when the row was just activated. renderProjects() also
    // runs on every filter keystroke, and focusing here would yank the caret
    // out of the filter box mid-word.
    if (this.focusNewProjectInput) {
      this.focusNewProjectInput = false;
      input.focus();
    }
  }

  private renderParents(): void {
    this.parentPanel.empty();
    // A brand-new project has no tasks to nest under.
    if (!this.selectedProject || this.newProjectTitle !== null) return;

    this.parentPanel.createDiv({ cls: "pm-mt-parents-label", text: "Place under" });

    const rootRow = this.addParentRow(this.parentPanel, undefined, "Project root (no parent)", 0);
    rootRow.addClass("pm-mt-root-row");

    const inProject = this.opts.tasks.filter((t) => t.projectId === this.selectedProject!.id);
    const childMap = buildChildMap(inProject);
    this.renderParentLevel(childMap, undefined, 1);
  }

  private renderParentLevel(
    childMap: Map<string | undefined, Task[]>,
    parentId: string | undefined,
    depth: number,
  ): void {
    for (const task of childMap.get(parentId) ?? []) {
      this.addParentRow(this.parentPanel, task, task.title, depth);
      this.renderParentLevel(childMap, task.id, depth + 1);
    }
  }

  private addParentRow(
    container: HTMLElement,
    task: Task | undefined,
    label: string,
    depth: number,
  ): HTMLElement {
    const choice: MoveChoice = {
      kind: "existing",
      projectId: this.selectedProject!.id,
      projectFilePath: this.selectedProject!.filePath,
      projectTitle: this.selectedProject!.title,
      parentTask: task,
    };
    const reason = this.disabledReason(choice);
    const selected = !reason && this.selectedParent?.id === task?.id;

    const row = container.createDiv({
      cls: `pm-mt-row pm-mt-parent-row${reason ? " pm-mt-row--disabled" : ""}${selected ? " pm-mt-row--selected" : ""}`,
      text: label,
    });
    row.style.paddingLeft = `${depth * 1.2 + 0.5}rem`;
    if (task) row.dataset.taskId = task.id;

    if (reason) {
      row.title = reason;
      return row;
    }
    row.addEventListener("click", () => {
      this.selectedParent = task;
      this.renderParents();
      this.syncCta();
    });
    return row;
  }
}
