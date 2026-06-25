import { ItemView, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import cytoscapeDagre from "cytoscape-dagre";
import nodeHtmlLabel from "cytoscape-node-html-label";
import type { Task, Project } from "@pm-compass/shared";
import { loadVaultData } from "./vault-reader";

cytoscape.use(cytoscapeDagre as cytoscape.Ext);
cytoscape.use(nodeHtmlLabel as unknown as cytoscape.Ext);

export const TASK_GRAPH_VIEW_TYPE = "pm-compass-task-graph";

interface NodeData {
  id: string;
  label: string;
  status: string;
  statusColor: string;
  due: string;
  filePath: string;
}

interface HtmlLabelOption {
  query: string;
  tpl: (data: NodeData) => string;
}

const STATUS_COLORS: Record<string, string> = {
  "todo": "#6b7280",
  "in-progress": "#3b82f6",
  "blocked": "#ef4444",
  "review": "#8b5cf6",
  "done": "#22c55e",
  "cancelled": "#9ca3af",
};

function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class TaskGraphView extends ItemView {
  private cy: Core | null = null;
  private tasks: Task[] = [];
  private projects: Project[] = [];
  private selectedProjectId: string | null = null;
  private showActiveOnly = true;
  private readonly projectsFolder: string;
  private projectSelectEl!: HTMLSelectElement;
  // Debounce handle: coalesces rapid vault events into a single refresh after 300ms of quiet.
  private refreshTimer: ReturnType<typeof window.setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, projectsFolder: string) {
    super(leaf);
    this.projectsFolder = projectsFolder;
  }

  getViewType(): string {
    return TASK_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Task Graph";
  }

  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    this.buildToolbar();
    await this.refresh();

    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        if (this.isInProjectsFolder(file.path)) this.scheduleRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (this.isInProjectsFolder(file.path)) this.scheduleRefresh();
      }),
    );
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.cy?.destroy();
    this.cy = null;
  }

  private isInProjectsFolder(filePath: string): boolean {
    return filePath.startsWith(this.projectsFolder + "/");
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 300);
  }

  private buildToolbar(): void {
    const toolbar = this.contentEl.createDiv({ cls: "pm-compass-toolbar" });

    this.projectSelectEl = toolbar.createEl("select", {
      cls: "pm-compass-project-select",
    });
    this.projectSelectEl.addEventListener("change", () => {
      this.selectedProjectId = this.projectSelectEl.value || null;
      this.renderGraph();
    });

    const label = toolbar.createEl("label", { cls: "pm-compass-toggle" });
    const checkbox = label.createEl("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.showActiveOnly;
    label.createSpan({ text: " Active only" });
    checkbox.addEventListener("change", () => {
      this.showActiveOnly = checkbox.checked;
      this.renderGraph();
    });

    this.contentEl.createDiv({ cls: "pm-compass-graph-container" });
  }

  private async refresh(): Promise<void> {
    const data = await loadVaultData(this.app, this.projectsFolder);
    this.projects = data.projects;
    this.tasks = data.tasks;

    const current = this.selectedProjectId;
    this.projectSelectEl.empty();

    const placeholder = this.projectSelectEl.createEl("option", {
      text: "— select project —",
      value: "",
    });
    placeholder.selected = !current;

    for (const p of this.projects) {
      const opt = this.projectSelectEl.createEl("option", {
        text: p.title,
        value: p.id,
      });
      if (p.id === current) opt.selected = true;
    }

    if (!current && this.projects.length > 0) {
      this.selectedProjectId = this.projects[0].id;
      (this.projectSelectEl.options[1] as HTMLOptionElement).selected = true;
    }

    this.renderGraph();
  }

  private renderGraph(): void {
    const container = this.contentEl.querySelector<HTMLElement>(
      ".pm-compass-graph-container",
    );
    if (!container) return;

    this.cy?.destroy();
    this.cy = null;
    container.empty();

    const elements = this.buildElements();

    if (elements.length === 0) {
      container.createEl("p", {
        text: this.selectedProjectId
          ? "No tasks found for this project."
          : "Select a project above.",
        cls: "pm-compass-empty",
      });
      return;
    }

    this.cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: "node",
          style: {
            shape: "round-rectangle",
            width: 160,
            height: 60,
            "background-color": "data(statusColor)",
            "border-width": 0,
            label: "",
          },
        },
        {
          selector: "edge",
          style: {
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": "#888",
            "target-arrow-color": "#888",
            width: 1.5,
          },
        },
      ],
      layout: {
        name: "dagre",
        rankDir: "TB",
        nodeSep: 50,
        rankSep: 70,
        padding: 20,
      } as cytoscape.LayoutOptions,
    });

    (
      this.cy as unknown as {
        nodeHtmlLabel: (opts: HtmlLabelOption[]) => void;
      }
    ).nodeHtmlLabel([
      {
        query: "node",
        tpl: (data: NodeData) =>
          `<div class="pm-node-card">
            <div class="pm-node-title">${escapeHtml(data.label)}</div>
            <div class="pm-node-meta">
              <span class="pm-node-status" style="background:${data.statusColor}">${escapeHtml(data.status)}</span>
              ${data.due ? `<span class="pm-node-due">${escapeHtml(data.due)}</span>` : ""}
            </div>
          </div>`,
      },
    ]);

    this.cy.on("tap", "node", (evt) => {
      const filePath = evt.target.data("filePath") as string;
      const file = this.app.vault.getFileByPath(filePath);
      if (file) {
        void this.app.workspace.getLeaf("tab").openFile(file);
      }
    });
  }

  private buildElements(): ElementDefinition[] {
    if (!this.selectedProjectId) return [];

    const activeStatuses = new Set([
      "todo",
      "in-progress",
      "blocked",
      "review",
    ]);

    let projectTasks = this.tasks.filter(
      (t) => t.projectId === this.selectedProjectId,
    );

    if (this.showActiveOnly) {
      projectTasks = projectTasks.filter((t) => activeStatuses.has(t.status));
    }

    const taskIdSet = new Set(projectTasks.map((t) => t.id));

    const nodes: ElementDefinition[] = projectTasks.map((t) => ({
      data: {
        id: t.id,
        label: t.title,
        status: t.status,
        statusColor: getStatusColor(t.status),
        due: t.due ?? "",
        filePath: t.filePath,
      },
    }));

    const edges: ElementDefinition[] = [];
    for (const task of projectTasks) {
      for (const depId of task.dependencies) {
        if (taskIdSet.has(depId)) {
          edges.push({
            data: {
              id: `${depId}->${task.id}`,
              source: depId,
              target: task.id,
            },
          });
        }
      }
    }

    return [...nodes, ...edges];
  }
}
