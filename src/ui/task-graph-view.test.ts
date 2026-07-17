// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;

  type CreateElOpts = { cls?: string; text?: string; attr?: Record<string, string> };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    this.appendChild(el);
    return el;
  }

  htmlProto.createEl = createElOn;
  htmlProto.createDiv = function (this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("div", opts);
  };
  htmlProto.createSpan = function (this: HTMLElement, opts?: CreateElOpts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).createEl("span", opts);
  };
  htmlProto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CSS = { escape: (s: string) => s };
  if (!("elementFromPoint" in document)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).elementFromPoint = () => null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).activeDocument = document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).createSvg = (tag: string, opts?: CreateElOpts) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (opts?.cls) el.setAttribute("class", opts.cls);
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    return el;
  };
}

/** Event.target is a read-only getter; use this to stub it on a synthetic event. */
function withTarget<E extends Event>(evt: E, target: Element): E {
  Object.defineProperty(evt, "target", { value: target, configurable: true });
  return evt;
}

beforeAll(() => {
  installObsidianDOMPolyfills();
});

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  MockItemView,
  MockMenu,
  MockNotice,
  MockTaskModal,
  MockProjectModal,
  MockConfirmModal,
  mockCytoscape,
  mockAddTaskDependency,
  mockRemoveTaskDependency,
  mockDeleteTaskFile,
  mockPatchTaskField,
  mockOpenDropdown,
  mockOpenNoteFile,
  mockLoadVaultData,
} = vi.hoisted(() => {
  class MockItemView {
    app: unknown;
    contentEl: HTMLElement;
    leaf: unknown;
    constructor(leaf: { app: unknown }) {
      this.app = leaf.app;
      this.leaf = leaf;
      this.contentEl = document.createElement("div");
    }
    registerEvent() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDomEvent(el: EventTarget, type: string, handler: (e: any) => void) {
      el.addEventListener(type, handler);
    }
  }
  class MockMenuItem {
    _onClick: (() => void) | null = null;
    _title = "";
    setTitle(t: string) { this._title = t; return this; }
    setIcon() { return this; }
    onClick(fn: () => void) { this._onClick = fn; return this; }
  }
  class MockMenu {
    static instances: MockMenu[] = [];
    items: MockMenuItem[] = [];
    /** Look an item up by title, so adding a menu item can't silently repoint a test. */
    item(title: string): MockMenuItem {
      const found = this.items.find((i) => i._title === title);
      if (!found) throw new Error(`no menu item titled "${title}"`);
      return found;
    }
    constructor() { MockMenu.instances.push(this); }
    addItem(cb: (item: MockMenuItem) => void) {
      const item = new MockMenuItem();
      cb(item);
      this.items.push(item);
      return this;
    }
    showAtMouseEvent() {}
  }
  class MockNotice {
    static instances: string[] = [];
    constructor(message: string) { MockNotice.instances.push(message); }
  }
  class MockTaskModal {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static instances: MockTaskModal[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public app: unknown, public opts: any) { MockTaskModal.instances.push(this); }
    open() {}
  }
  class MockProjectModal {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static instances: MockProjectModal[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public app: unknown, public opts: any) { MockProjectModal.instances.push(this); }
    open() {}
  }
  class MockConfirmModal {
    static instances: MockConfirmModal[] = [];
    constructor(public app: unknown, public message: string, public onConfirm: () => void) {
      MockConfirmModal.instances.push(this);
    }
    open() {}
  }

  // ---- Minimal cytoscape mock ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class MockNodeEl {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public _def: any, public _pos = { x: 0, y: 0 }) {}
    id() { return this._def.data.id; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data(key?: string): any { return key ? this._def.data[key] : this._def.data; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    position(pos?: any) { if (pos) { this._pos = pos; return this; } return this._pos; }
    renderedPosition() { return this._pos; }
    renderedWidth() { return 160; }
    renderedHeight() { return 72; }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function matchesSelector(def: any, selector: string): boolean {
    if (selector === "[?isContext]") return !!def.data.isContext;
    if (selector === "node") return !def.data.source;
    const m = selector.match(/nodeType='(\w[\w-]*)'/);
    if (m) return def.data.nodeType === m[1];
    return true;
  }

  class MockCyInstance {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any;
    destroyed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: Record<string, ((evt: any) => void)[]> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeHtmlLabelOpts: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(opts: any) {
      this.opts = opts;
      MockCytoscapeRegistry.instances.push(this);
    }
    elements() {
      return {
        unselectify: () => {},
        boundingBox: () => ({ w: 100, h: 80, x1: 0, y1: 0 }),
      };
    }
    nodes(selector?: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allDefs = this.opts.elements as any[];
      const defs = allDefs.filter((e) => !e.data.source);
      const matched = selector ? defs.filter((d) => matchesSelector(d, selector)) : defs;
      // Position by index within the full elements array (not the filtered subset), so
      // e.g. a context node (always pushed first) reliably sorts to a lower x than any
      // task node pushed after it — this is what lets renderSeparators/renderSectionSeparator
      // decide there's a gap between the context column and the task columns.
      const nodeObjs = matched.map((d) => new MockNodeEl(d, { x: allDefs.indexOf(d) * 200, y: 0 }));
      return {
        length: nodeObjs.length,
        toArray: () => nodeObjs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        forEach: (fn: (n: any) => void) => nodeObjs.forEach(fn),
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, selector: string, handler: (evt: any) => void) {
      (this.handlers[`${event}:${selector}`] ??= []).push(handler);
      return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    one(event: string, handler: (evt: any) => void) {
      (this.handlers[`${event}:`] ??= []).push(handler);
      return this;
    }
    layout() {
      return { run: () => this.fire("layoutstop", "", {}) };
    }
    resize() {}
    viewport() {}
    userPanningEnabled() {}
    userZoomingEnabled() {}
    destroy() { this.destroyed = true; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeHtmlLabel(opts: any) { this.nodeHtmlLabelOpts = opts; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fire(event: string, selector: string, evt: any) {
      for (const h of this.handlers[`${event}:${selector}`] ?? []) h(evt);
    }
  }

  const MockCytoscapeRegistry = { instances: [] as MockCyInstance[] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mockCytoscape(opts: any) {
    return new MockCyInstance(opts);
  }
  mockCytoscape.use = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockCytoscape as any)._registry = MockCytoscapeRegistry;

  return {
    MockItemView,
    MockMenu,
    MockNotice,
    MockTaskModal,
    MockProjectModal,
    MockConfirmModal,
    mockCytoscape,
    mockAddTaskDependency: vi.fn().mockResolvedValue(undefined),
    mockRemoveTaskDependency: vi.fn().mockResolvedValue(undefined),
    mockDeleteTaskFile: vi.fn().mockResolvedValue(undefined),
    mockPatchTaskField: vi.fn().mockResolvedValue(undefined),
    mockOpenDropdown: vi.fn(),
    mockOpenNoteFile: vi.fn(),
    mockLoadVaultData: vi.fn().mockResolvedValue({ tasks: [], projects: [] }),
  };
});

vi.mock("obsidian", () => ({
  ItemView: MockItemView,
  Menu: MockMenu,
  // MoveTargetModal (reached via the "Move task…" menu item) extends Modal, and
  // renders task titles as markdown — hence Component/MarkdownRenderer/moment,
  // which its import of day-task-row pulls in.
  Modal: class { open() {} close() {} },
  Component: class { load() {} unload() {} },
  MarkdownRenderer: { render: async () => {} },
  moment: () => ({ format: () => "", isValid: () => true }),
  Notice: MockNotice,
  TFile: class {},
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  setIcon: () => {},
}));

vi.mock("cytoscape", () => ({ default: mockCytoscape }));
vi.mock("cytoscape-dagre", () => ({ default: {} }));
vi.mock("cytoscape-node-html-label", () => ({ default: {} }));

vi.mock("./task-creator", () => ({
  TaskModal: MockTaskModal,
  ProjectModal: MockProjectModal,
  ConfirmModal: MockConfirmModal,
  addTaskDependency: mockAddTaskDependency,
  removeTaskDependency: mockRemoveTaskDependency,
  deleteTaskFile: mockDeleteTaskFile,
  patchTaskField: mockPatchTaskField,
  openDropdown: mockOpenDropdown,
  openNoteFile: mockOpenNoteFile,
}));

vi.mock("../model/vault-reader", () => ({ loadVaultData: mockLoadVaultData }));

// dashboard-view.ts only needed for the DASHBOARD_VIEW_TYPE string constant.
vi.mock("./dashboard-view", () => ({ DASHBOARD_VIEW_TYPE: "pm-compass-dashboard" }));

import { TaskGraphView, TASK_GRAPH_VIEW_TYPE } from "./task-graph-view";
import type { Task, Project } from "../model/shared";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return { title: "A project", filePath: `projects/${overrides.id}.md`, tasks: [], ...overrides };
}

function makeApp() {
  const eventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    metadataCache: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (eventHandlers[`metadataCache.${event}`] ??= []).push(cb);
      }),
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of eventHandlers[`metadataCache.${event}`] ?? []) cb(...args);
      },
    },
    vault: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (eventHandlers[`vault.${event}`] ??= []).push(cb);
      }),
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of eventHandlers[`vault.${event}`] ?? []) cb(...args);
      },
      // Defaults to "file gone" so existing stale-drill-path tests (genuine deletions)
      // still trim; tests for the metadataCache-lag case override this per file path.
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
    },
    workspace: {
      getLeavesOfType: vi.fn().mockReturnValue([]),
    },
  };
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      projectsFolder: "Projects",
      panelConfig: { showActiveOnly: true },
      nodePositions: {},
      ...overrides,
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function makeView(app = makeApp(), plugin = makePlugin()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leaf = { app } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = new TaskGraphView(leaf, plugin as any);
  return { view, app, plugin };
}

function getRegistryInstances() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mockCytoscape as any)._registry.instances as Array<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: Record<string, ((evt: any) => void)[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fire: (event: string, selector: string, evt: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any;
    destroyed: boolean;
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  getRegistryInstances().length = 0;
  MockMenu.instances.length = 0;
  MockNotice.instances.length = 0;
  MockTaskModal.instances.length = 0;
  MockProjectModal.instances.length = 0;
  MockConfirmModal.instances.length = 0;
  mockLoadVaultData.mockResolvedValue({ tasks: [], projects: [] });
});

// ---------------------------------------------------------------------------
// View metadata
// ---------------------------------------------------------------------------

describe("TaskGraphView metadata", () => {
  it("reports the graph view type/display text/icon", () => {
    const { view } = makeView();
    expect(view.getViewType()).toBe(TASK_GRAPH_VIEW_TYPE);
    expect(view.getDisplayText()).toBe("Task graph");
    expect(view.getIcon()).toBe("workflow");
  });

  it("renderGraph() does nothing before onOpen() has set up cyContainer", () => {
    const { view } = makeView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (view as any).renderGraph()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onOpen / refresh — all-projects table (no drill)
// ---------------------------------------------------------------------------

describe("TaskGraphView.onOpen — all-projects view", () => {
  it("shows an empty-state message when there are no projects", async () => {
    const { view } = makeView();
    await view.onOpen();
    expect(view.contentEl.querySelector(".pm-compass-empty")?.textContent).toBe("No projects found.");
  });

  it("renders one section per project, filtered to active top-level tasks by default", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", status: "todo" }),
        makeTask({ id: "t2", projectId: "p1", status: "done" }),
        makeTask({ id: "t3", projectId: "p1", status: "todo", parentId: "t1" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    const sections = view.contentEl.querySelectorAll(".pm-project-section");
    expect(sections).toHaveLength(1);
    const cyInstances = getRegistryInstances();
    const projCy = cyInstances[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskNodes = (projCy.opts.elements as any[]).filter((e) => e.data.nodeType === "task");
    expect(taskNodes.map((n) => n.data.id)).toEqual(["t1"]);
  });

  it("includes done/cancelled and subtasks when 'Active only' is unchecked", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", status: "done" })],
    });
    const { view } = makeView(makeApp(), makePlugin({ panelConfig: { showActiveOnly: false } }));
    await view.onOpen();
    const cyInstances = getRegistryInstances();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskNodes = (cyInstances[0].opts.elements as any[]).filter((e) => e.data.nodeType === "task");
    expect(taskNodes).toHaveLength(1);
  });

  it("includes a real dependency edge between two top-level tasks in the same project section", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1" }),
        makeTask({ id: "t2", projectId: "p1", dependencies: ["t1"] }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realEdges = (cy.opts.elements as any[]).filter((e) => e.data.source && e.data.target && e.data.edgeType !== "virtual");
    expect(realEdges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Breadcrumb / drill navigation
// ---------------------------------------------------------------------------

describe("breadcrumb navigation", () => {
  it("shows 'All' as current when not drilled in", async () => {
    const { view } = makeView();
    await view.onOpen();
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.querySelector(".current")?.textContent).toBe("All");
  });

  it("drills into a project section on card click and updates the breadcrumb", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    cy.fire("tap", "node[nodeType='project']", { target: { data: () => ({}) } });
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.textContent).toContain("Alpha");
  });

  it("navigates back to 'All' via the breadcrumb link", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    cy.fire("tap", "node[nodeType='project']", { target: { data: () => ({}) } });
    const allLink = view.contentEl.querySelector(".pm-breadcrumb-item:not(.current)") as HTMLElement;
    allLink.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.querySelector(".current")?.textContent).toBe("All");
  });

  it("drills two levels deep (project > task) and truncates via a middle breadcrumb link", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "Parent task" }),
        makeTask({ id: "t2", projectId: "p1", title: "Child task", parentId: "t1" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    let cy = getRegistryInstances()[0];
    cy.fire("tap", "node[nodeType='project']", { target: { data: () => ({}) } });

    cy = getRegistryInstances().at(-1)!;
    cy.fire("dbltap", "node[nodeType='task']", { target: { data: (k: string) => (k === "id" ? "t1" : undefined) }, originalEvent: undefined });

    cy = getRegistryInstances().at(-1)!;
    const middleItems = view.contentEl.querySelectorAll(".pm-breadcrumb-item:not(.current)");
    expect(middleItems.length).toBeGreaterThan(0);
    (middleItems[middleItems.length - 1] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.textContent).toContain("Alpha");
  });
});

// ---------------------------------------------------------------------------
// Gear / settings panel
// ---------------------------------------------------------------------------

describe("settings panel", () => {
  it("toggles the panel open/closed on gear click", async () => {
    const { view } = makeView();
    await view.onOpen();
    const gearBtn = view.contentEl.querySelector(".pm-compass-gear-btn") as HTMLElement;
    const panel = view.contentEl.querySelector(".pm-compass-settings-panel") as HTMLElement;
    gearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.style.display).toBe("block");
    gearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.style.display).toBe("none");
  });

  it("closes the panel on an outside document click", async () => {
    const { view } = makeView();
    await view.onOpen();
    const gearBtn = view.contentEl.querySelector(".pm-compass-gear-btn") as HTMLElement;
    gearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const panel = view.contentEl.querySelector(".pm-compass-settings-panel") as HTMLElement;
    expect(panel.style.display).toBe("none");
  });

  it("toggles 'Active only' and re-renders", async () => {
    const { view, plugin } = makeView();
    await view.onOpen();
    const checkbox = view.contentEl.querySelector(".pm-compass-toggle input") as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(plugin.settings.panelConfig.showActiveOnly).toBe(false);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("resets stored node positions and re-renders", async () => {
    const { view, plugin } = makeView(makeApp(), makePlugin({ nodePositions: { t1: { x: 1, y: 2 } } }));
    await view.onOpen();
    const resetBtn = view.contentEl.querySelector(".pm-compass-reset-layout-btn") as HTMLElement;
    resetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(plugin.settings.nodePositions).toEqual({});
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

describe("context menus", () => {
  it("opens the add-task menu for empty space in a project section (all-view)", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    const section = view.contentEl.querySelector(".pm-project-section") as HTMLElement;
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: section, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(1);
  });

  it("does nothing on empty-space right-click when the section can't be matched to a project", async () => {
    const { view } = makeView();
    await view.onOpen();
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(0);
  });

  it("opens a task context menu when right-clicking a task card", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", title: "Card task" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const card = document.createElement("div");
    card.className = "pm-node-card";
    card.dataset.taskId = "t1";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(card);
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: card, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(1);
  });

  it("opens the add-task menu for empty space while drilled one level (project only)", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "t1"); // t1 has no parent, so this drills to [project] only
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(1);
    expect(MockMenu.instances[0].items[0]._onClick).toBeTruthy();
  });

  it("opens the add-subtask menu for empty space while drilled two levels into a task", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).drillPath = [project, parent];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderGraph();
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(1);
    MockMenu.instances[0].items[0]._onClick!();
    expect(MockTaskModal.instances[0].opts.parentTask).toBe(parent);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refreshSpy = vi.spyOn(view as any, "refresh").mockResolvedValue(undefined);
    MockTaskModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
  });

  describe("node tap/dbltap handling (task-drilled section graph, drillPath.length >= 2)", () => {
    const TASK_SELECTOR = "node[nodeType='task'], node[nodeType='context-task']";

    function setupDrilledTwoLevels() {
      const project = makeProject({ id: "p1" });
      const parent = makeTask({ id: "parent", projectId: "p1" });
      const child = makeTask({ id: "child", projectId: "p1", parentId: "parent", title: "Child task", filePath: "child.md" });
      const grandchild = makeTask({ id: "grandchild", projectId: "p1", parentId: "child" });
      mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [parent, child, grandchild] });
      return { project, parent, child, grandchild };
    }

    async function renderDrilledView() {
      const { project, parent, child, grandchild } = setupDrilledTwoLevels();
      const { view } = makeView();
      await view.onOpen();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).drillPath = [project, parent];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (view as any).renderGraph();
      const cy = getRegistryInstances().at(-1)!;
      return { view, cy, project, parent, child, grandchild };
    }

    it("ignores taps on the connect button", async () => {
      const { cy } = await renderDrilledView();
      const connectBtn = document.createElement("div");
      connectBtn.className = "pm-node-connect-btn";
      document.body.appendChild(connectBtn);
      cy.fire("tap", TASK_SELECTOR, { target: { data: () => "child" }, originalEvent: withTarget(new MouseEvent("click"), connectBtn) });
      expect(MockTaskModal.instances).toHaveLength(0);
      connectBtn.remove();
    });

    it("selects the node when the tap target isn't the edit button", async () => {
      const { view } = await renderDrilledView();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selectSpy = vi.spyOn(view as any, "selectGraphNode");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signalSpy = vi.spyOn(view as any, "signalDashboard");
      const cy = getRegistryInstances().at(-1)!;
      const plain = document.createElement("div");
      document.body.appendChild(plain);
      cy.fire("tap", TASK_SELECTOR, { target: { data: (k: string) => (k === "id" ? "child" : undefined) }, originalEvent: withTarget(new MouseEvent("click"), plain) });
      expect(selectSpy).toHaveBeenCalledWith("child");
      expect(signalSpy).toHaveBeenCalledWith("child");
      plain.remove();
    });

    it("edit-button click does nothing when the edit button has no task-id", async () => {
      const { cy } = await renderDrilledView();
      const editBtn = document.createElement("div");
      editBtn.className = "pm-node-edit-btn";
      document.body.appendChild(editBtn);
      cy.fire("tap", TASK_SELECTOR, { target: { data: () => "child" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
      expect(MockTaskModal.instances).toHaveLength(0);
      editBtn.remove();
    });

    it("edit-button click does nothing when the task-id doesn't resolve to a known task", async () => {
      const { cy } = await renderDrilledView();
      const editBtn = document.createElement("div");
      editBtn.className = "pm-node-edit-btn";
      editBtn.dataset.taskId = "missing";
      document.body.appendChild(editBtn);
      cy.fire("tap", TASK_SELECTOR, { target: { data: () => "child" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
      expect(MockTaskModal.instances).toHaveLength(0);
      editBtn.remove();
    });

    it("opens the note directly on ctrl-click of the edit button", async () => {
      const { cy } = await renderDrilledView();
      const editBtn = document.createElement("div");
      editBtn.className = "pm-node-edit-btn";
      editBtn.dataset.taskId = "child";
      document.body.appendChild(editBtn);
      cy.fire("tap", TASK_SELECTOR, { target: { data: () => "child" }, originalEvent: withTarget(new MouseEvent("click", { ctrlKey: true }), editBtn) });
      expect(mockOpenNoteFile).toHaveBeenCalledWith(expect.anything(), "child.md");
      editBtn.remove();
    });

    it("opens an edit-mode TaskModal on plain edit-button click, and refreshes on success", async () => {
      const { view, cy } = await renderDrilledView();
      const editBtn = document.createElement("div");
      editBtn.className = "pm-node-edit-btn";
      editBtn.dataset.taskId = "child";
      document.body.appendChild(editBtn);
      cy.fire("tap", TASK_SELECTOR, { target: { data: () => "child" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
      expect(MockTaskModal.instances).toHaveLength(1);
      expect(MockTaskModal.instances[0].opts.mode).toBe("edit");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const refreshSpy = vi.spyOn(view as any, "refresh").mockResolvedValue(undefined);
      MockTaskModal.instances[0].opts.onSuccess();
      expect(refreshSpy).toHaveBeenCalled();
      editBtn.remove();
    });

    it("project context node: edit-button click does nothing without a proj-id, or an unresolved one", async () => {
      const { cy } = await renderDrilledView();
      const editBtn = document.createElement("div");
      editBtn.className = "pm-node-edit-btn";
      document.body.appendChild(editBtn);

      cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
      expect(MockProjectModal.instances).toHaveLength(0);

      editBtn.dataset.projId = "missing";
      cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
      expect(MockProjectModal.instances).toHaveLength(0);
      editBtn.remove();
    });

    it("project context node: edit-button click opens ProjectModal (refreshing on success); ctrl-click opens the note", async () => {
      const { view, cy } = await renderDrilledView();
      const editBtn = document.createElement("div");
      editBtn.className = "pm-node-edit-btn";
      editBtn.dataset.projId = "p1";
      document.body.appendChild(editBtn);

      cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click", { ctrlKey: true }), editBtn) });
      expect(mockOpenNoteFile).toHaveBeenCalledWith(expect.anything(), "projects/p1.md");

      cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
      expect(MockProjectModal.instances).toHaveLength(1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const refreshSpy = vi.spyOn(view as any, "refresh").mockResolvedValue(undefined);
      MockProjectModal.instances[0].opts.onSuccess();
      expect(refreshSpy).toHaveBeenCalled();
      editBtn.remove();
    });

    it("dbltap ignores clicks on the edit button", async () => {
      const { view, cy } = await renderDrilledView();
      const editBtn = document.createElement("div");
      editBtn.className = "pm-node-edit-btn";
      document.body.appendChild(editBtn);
      cy.fire("dbltap", "node[nodeType='task']", { target: { data: () => "child" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((view as any).drillPath).toHaveLength(2);
      editBtn.remove();
    });

    it("dbltap on an unknown task id does nothing", async () => {
      const { view, cy } = await renderDrilledView();
      cy.fire("dbltap", "node[nodeType='task']", { target: { data: () => "missing" }, originalEvent: undefined });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((view as any).drillPath).toHaveLength(2);
    });

    it("dbltap drills one level further into the tapped task's own children", async () => {
      const { view, cy } = await renderDrilledView();
      cy.fire("dbltap", "node[nodeType='task']", { target: { data: () => "child" }, originalEvent: undefined });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const drillPath = (view as any).drillPath as unknown[];
      expect(drillPath).toHaveLength(3);
      const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
      expect(breadcrumb.querySelector(".current")?.textContent).toBe("Child task");
    });
  });

  it("'Add subtask' from the task context menu opens a create-mode TaskModal", async () => {
    const proj = makeProject({ id: "p1" });
    mockLoadVaultData.mockResolvedValue({ projects: [proj], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).openTaskContextMenu(new MouseEvent("contextmenu"), (view as any).tasks[0]);
    const menu = MockMenu.instances[0];
    menu.items[0]._onClick!();
    expect(MockTaskModal.instances).toHaveLength(1);
    expect(MockTaskModal.instances[0].opts.mode).toBe("create");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refreshSpy = vi.spyOn(view as any, "refresh").mockResolvedValue(undefined);
    MockTaskModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("'Add subtask' does nothing when the task's project can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    const orphanTask = makeTask({ id: "orphan", projectId: "missing" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).openTaskContextMenu(new MouseEvent("contextmenu"), orphanTask);
    const menu = MockMenu.instances[0];
    menu.items[0]._onClick!();
    expect(MockTaskModal.instances).toHaveLength(0);
  });

  it("'Delete task' prompts and deletes on confirm (leaf task, no parent)", async () => {
    const task = makeTask({ id: "t1", title: "Leaf" });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [task];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).openTaskContextMenu(new MouseEvent("contextmenu"), task);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    expect(MockConfirmModal.instances[0].message).toBe('Delete "Leaf"?');
    MockConfirmModal.instances[0].onConfirm();
    await Promise.resolve();
    expect(mockDeleteTaskFile).toHaveBeenCalledWith(expect.anything(), task, undefined, [task]);
  });

  it("'Delete task' pluralizes the subtask count for multiple descendants", async () => {
    const parent = makeTask({ id: "p1", title: "Parent" });
    const child1 = makeTask({ id: "c1", parentId: "p1" });
    const child2 = makeTask({ id: "c2", parentId: "p1" });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [parent, child1, child2];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).openTaskContextMenu(new MouseEvent("contextmenu"), parent);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    expect(MockConfirmModal.instances[0].message).toBe('Delete "Parent" and its 2 subtasks?');
  });

  it("'Delete task' uses the singular 'subtask' for exactly one descendant", async () => {
    const parent = makeTask({ id: "p1", title: "Parent" });
    const child = makeTask({ id: "c1", parentId: "p1" });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [parent, child];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).openTaskContextMenu(new MouseEvent("contextmenu"), parent);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    expect(MockConfirmModal.instances[0].message).toBe('Delete "Parent" and its 1 subtask?');
  });

  it("'Delete task' resolves and passes the parent task when the task has a parentId", async () => {
    const parent = makeTask({ id: "p1", title: "Parent" });
    const child = makeTask({ id: "c1", parentId: "p1", title: "Child" });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [parent, child];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).openTaskContextMenu(new MouseEvent("contextmenu"), child);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    MockConfirmModal.instances[0].onConfirm();
    await Promise.resolve();
    expect(mockDeleteTaskFile).toHaveBeenCalledWith(expect.anything(), child, parent, [parent, child]);
  });
});

// ---------------------------------------------------------------------------
// countDescendants
// ---------------------------------------------------------------------------

describe("countDescendants", () => {
  it("counts nested descendants", async () => {
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [
      makeTask({ id: "p" }),
      makeTask({ id: "c1", parentId: "p" }),
      makeTask({ id: "gc1", parentId: "c1" }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((view as any).countDescendants("p")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Priority / status dropdowns (pointerdown handling)
// ---------------------------------------------------------------------------

describe("priority/status dropdowns via pointerdown", () => {
  it("opens the priority dropdown when the ribbon is pressed", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1" })] });
    const { view } = makeView();
    await view.onOpen();
    const ribbon = document.createElement("div");
    ribbon.className = "pm-node-ribbon";
    ribbon.dataset.taskId = "t1";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(ribbon);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: ribbon, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(mockOpenDropdown).toHaveBeenCalledOnce();
  });

  it("does nothing for a ribbon with no task-id", async () => {
    const { view } = makeView();
    await view.onOpen();
    const ribbon = document.createElement("div");
    ribbon.className = "pm-node-ribbon";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(ribbon);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: ribbon, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(mockOpenDropdown).not.toHaveBeenCalled();
  });

  it("does nothing for a ribbon whose task can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    const ribbon = document.createElement("div");
    ribbon.className = "pm-node-ribbon";
    ribbon.dataset.taskId = "missing";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(ribbon);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: ribbon, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(mockOpenDropdown).not.toHaveBeenCalled();
  });

  it("opens the status dropdown when the status badge is pressed", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1" })] });
    const { view } = makeView();
    await view.onOpen();
    const badge = document.createElement("div");
    badge.className = "pm-node-status";
    badge.dataset.taskId = "t1";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(badge);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: badge, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(mockOpenDropdown).toHaveBeenCalledOnce();
  });

  it("does nothing for a status badge with no task-id", async () => {
    const { view } = makeView();
    await view.onOpen();
    const badge = document.createElement("div");
    badge.className = "pm-node-status";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(badge);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: badge, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(mockOpenDropdown).not.toHaveBeenCalled();
  });

  it("does nothing for a status badge whose task can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    const badge = document.createElement("div");
    badge.className = "pm-node-status";
    badge.dataset.taskId = "missing";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(badge);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: badge, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(mockOpenDropdown).not.toHaveBeenCalled();
  });

  it("ignores pointerdown events that don't hit any interactive element", async () => {
    const { view } = makeView();
    await view.onOpen();
    const plain = document.createElement("div");
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(plain);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: plain, configurable: true });
    expect(() => view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt)).not.toThrow();
  });

  it("selects the priority via the dropdown and patches the field", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1", filePath: "t1.md" })] });
    const { view } = makeView();
    await view.onOpen();
    const ribbon = document.createElement("div");
    ribbon.className = "pm-node-ribbon";
    ribbon.dataset.taskId = "t1";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(ribbon);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: ribbon, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    const options = mockOpenDropdown.mock.calls[0][1];
    await options[1].onSelect(); // "critical"
    expect(mockPatchTaskField).toHaveBeenCalledWith(expect.anything(), "t1.md", "priority", "critical");
  });

  it("selects the status via the dropdown and patches the field", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1", filePath: "t1.md" })] });
    const { view } = makeView();
    await view.onOpen();
    const badge = document.createElement("div");
    badge.className = "pm-node-status";
    badge.dataset.taskId = "t1";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(badge);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: badge, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    const options = mockOpenDropdown.mock.calls[0][1];
    await options[0].onSelect();
    expect(mockPatchTaskField).toHaveBeenCalledWith(expect.anything(), "t1.md", "status", expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Drag-to-connect
// ---------------------------------------------------------------------------

describe("drag-to-connect", () => {
  it("starts a drag gesture when the connect button is pressed", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1" })] });
    const { view } = makeView();
    await view.onOpen();
    const btn = document.createElement("div");
    btn.className = "pm-node-connect-btn";
    btn.dataset.taskId = "t1";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(btn);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10 });
    Object.defineProperty(evt, "target", { value: btn, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (btn as any).releasePointerCapture = vi.fn();
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(document.querySelector(".pm-drag-line-overlay")).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).cancelDragConnect();
  });

  it("anchors the drag line to the source card's bounding rect and highlights/un-highlights it", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1" })] });
    const { view } = makeView();
    await view.onOpen();
    const container = view.contentEl.querySelector(".pm-compass-graph-container")!;
    const card = document.createElement("div");
    card.className = "pm-node-card";
    card.dataset.taskId = "t1";
    container.appendChild(card);
    const btn = document.createElement("div");
    btn.className = "pm-node-connect-btn";
    btn.dataset.taskId = "t1";
    card.appendChild(btn);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10 });
    Object.defineProperty(evt, "target", { value: btn, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (btn as any).releasePointerCapture = vi.fn();
    container.dispatchEvent(evt);
    expect(card.classList.contains("pm-connect-source")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).cancelDragConnect();
    expect(card.classList.contains("pm-connect-source")).toBe(false);
  });

  it("does nothing when the connect button has no task-id", async () => {
    const { view } = makeView();
    await view.onOpen();
    const btn = document.createElement("div");
    btn.className = "pm-node-connect-btn";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(btn);
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: btn, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(document.querySelector(".pm-drag-line-overlay")).toBeNull();
  });

  it("tracks pointermove and highlights a valid drop target, then connects on pointerup", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" }), makeTask({ id: "t2", projectId: "p1" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const container = view.contentEl.querySelector(".pm-compass-graph-container")!;
    const srcBtn = document.createElement("div");
    srcBtn.className = "pm-node-connect-btn";
    srcBtn.dataset.taskId = "t1";
    container.appendChild(srcBtn);
    const targetCard = document.createElement("div");
    targetCard.className = "pm-node-card";
    targetCard.dataset.taskId = "t2";
    container.appendChild(targetCard);

    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 0, clientY: 0 });
    Object.defineProperty(down, "target", { value: srcBtn, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (srcBtn as any).releasePointerCapture = vi.fn();
    container.dispatchEvent(down);

    vi.spyOn(document, "elementFromPoint").mockReturnValue(targetCard);
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5 }));
    expect(targetCard.classList.contains("pm-connect-target")).toBe(true);

    // Move again to a non-card element — should clear the previous target highlight.
    const empty = document.createElement("div");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(empty);
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 6, clientY: 6 }));
    expect(targetCard.classList.contains("pm-connect-target")).toBe(false);

    vi.spyOn(document, "elementFromPoint").mockReturnValue(targetCard);
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 7, clientY: 7 }));
    document.dispatchEvent(new PointerEvent("pointerup"));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockAddTaskDependency).toHaveBeenCalled();
  });

  it("does not add a dependency when the drag ends over empty space", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1" })] });
    const { view } = makeView();
    await view.onOpen();
    const container = view.contentEl.querySelector(".pm-compass-graph-container")!;
    const srcBtn = document.createElement("div");
    srcBtn.className = "pm-node-connect-btn";
    srcBtn.dataset.taskId = "t1";
    container.appendChild(srcBtn);
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 0, clientY: 0 });
    Object.defineProperty(down, "target", { value: srcBtn, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (srcBtn as any).releasePointerCapture = vi.fn();
    container.dispatchEvent(down);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(null);
    document.dispatchEvent(new PointerEvent("pointerup"));
    await Promise.resolve();
    expect(mockAddTaskDependency).not.toHaveBeenCalled();
  });

  it("cancels the drag on pointercancel", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [], tasks: [makeTask({ id: "t1" })] });
    const { view } = makeView();
    await view.onOpen();
    const container = view.contentEl.querySelector(".pm-compass-graph-container")!;
    const srcBtn = document.createElement("div");
    srcBtn.className = "pm-node-connect-btn";
    srcBtn.dataset.taskId = "t1";
    container.appendChild(srcBtn);
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 0, clientY: 0 });
    Object.defineProperty(down, "target", { value: srcBtn, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (srcBtn as any).releasePointerCapture = vi.fn();
    container.dispatchEvent(down);
    document.dispatchEvent(new PointerEvent("pointercancel"));
    expect(document.querySelector(".pm-drag-line-overlay")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addDependency / removeDependency
// ---------------------------------------------------------------------------

describe("addDependency / removeDependency", () => {
  it("does nothing when the target task can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).addDependency("src", "missing-target");
    expect(mockAddTaskDependency).not.toHaveBeenCalled();
  });

  it("shows a Notice and does not add when the dependency would be invalid", async () => {
    const source = makeTask({ id: "src", parentId: "different-parent" });
    const target = makeTask({ id: "tgt" });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [source, target];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).addDependency("src", "tgt");
    expect(MockNotice.instances.length).toBeGreaterThan(0);
    expect(mockAddTaskDependency).not.toHaveBeenCalled();
  });

  it("adds a valid dependency and refreshes", async () => {
    const source = makeTask({ id: "src" });
    const target = makeTask({ id: "tgt" });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [source, target];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).addDependency("src", "tgt");
    expect(mockAddTaskDependency).toHaveBeenCalledWith(expect.anything(), target, "src");
  });

  it("removes a dependency and refreshes", async () => {
    const target = makeTask({ id: "tgt" });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).tasks = [target];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).removeDependency("src", "tgt");
    expect(mockRemoveTaskDependency).toHaveBeenCalledWith(expect.anything(), target, "src");
  });

  it("does nothing removing a dependency when the target can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).removeDependency("src", "missing");
    expect(mockRemoveTaskDependency).not.toHaveBeenCalled();
  });

  it("shows a remove-dependency menu on edge right-click, ignoring virtual edges", async () => {
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).showRemoveDependencyMenu({ target: { data: () => "virtual" }, originalEvent: new MouseEvent("contextmenu") });
    expect(MockMenu.instances).toHaveLength(0);

    const dataMap: Record<string, string> = { edgeType: "real", source: "a", target: "b" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).showRemoveDependencyMenu({
      target: { data: (k: string) => dataMap[k] },
      originalEvent: new MouseEvent("contextmenu"),
    });
    expect(MockMenu.instances).toHaveLength(1);
    MockMenu.instances[0].items[0]._onClick!();
  });

  it("does nothing when the edge is missing a source or target id", async () => {
    const { view } = makeView();
    await view.onOpen();
    const dataMap: Record<string, string | undefined> = { edgeType: "real", source: undefined, target: "b" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).showRemoveDependencyMenu({
      target: { data: (k: string) => dataMap[k] },
      originalEvent: new MouseEvent("contextmenu"),
    });
    expect(MockMenu.instances).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// openTask (external navigation from the dashboard)
// ---------------------------------------------------------------------------

describe("openTask", () => {
  it("drills to [project] when the task has no parent", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "t1");
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.textContent).toContain("Alpha");
  });

  it("builds the full drill path via ancestors when the task has a parent", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "root", projectId: "p1", title: "Root" }),
        makeTask({ id: "mid", projectId: "p1", title: "Mid", parentId: "root" }),
        makeTask({ id: "leaf", projectId: "p1", title: "Leaf", parentId: "mid" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "leaf");
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.textContent).toContain("Alpha");
    expect(breadcrumb.textContent).toContain("Root");
  });

  it("falls back to [project] when the parent can't be found", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", parentId: "missing-parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "t1");
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.querySelector(".current")?.textContent).toBe("Alpha");
  });

  it("does nothing to drillPath when the project or task can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("missing-proj", "missing-task");
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.querySelector(".current")?.textContent).toBe("All");
  });

  it("does not loop forever on a cyclical parent chain", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "a", projectId: "p1", parentId: "b" }),
        makeTask({ id: "b", projectId: "p1", parentId: "a" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    await expect(view.openTask("p1", "a")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectGraphNode
// ---------------------------------------------------------------------------

describe("selectGraphNode", () => {
  it("selects the matching card and clears any previous selection", async () => {
    const { view } = makeView();
    await view.onOpen();
    const container = view.contentEl.querySelector(".pm-compass-graph-container")!;
    const oldCard = document.createElement("div");
    oldCard.className = "pm-node-card pm-node-card--selected";
    oldCard.dataset.taskId = "old";
    container.appendChild(oldCard);
    const newCard = document.createElement("div");
    newCard.className = "pm-node-card";
    newCard.dataset.taskId = "new";
    container.appendChild(newCard);
    view.selectGraphNode("new");
    expect(oldCard.classList.contains("pm-node-card--selected")).toBe(false);
    expect(newCard.classList.contains("pm-node-card--selected")).toBe(true);
  });

  it("does nothing when no card matches", async () => {
    const { view } = makeView();
    await view.onOpen();
    expect(() => view.selectGraphNode("missing")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Node tap: edit / connect / select, ctrl-click open note
// ---------------------------------------------------------------------------

describe("node tap handling (all-projects section graph)", () => {

  it("ignores taps on the connect button", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const connectBtn = document.createElement("div");
    connectBtn.className = "pm-node-connect-btn";
    document.body.appendChild(connectBtn);
    cy.fire("tap", "node[nodeType='task']", { target: { data: () => "t1" }, originalEvent: withTarget(new MouseEvent("click"), connectBtn) });
    expect(MockTaskModal.instances).toHaveLength(0);
    connectBtn.remove();
  });

  it("selects the node when the tap target isn't the edit button", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    cy.fire("tap", "node[nodeType='task']", { target: { data: (k: string) => (k === "id" ? "t1" : undefined) }, originalEvent: withTarget(new MouseEvent("click"), plain) });
    expect(MockTaskModal.instances).toHaveLength(0);
    plain.remove();
  });

  it("does nothing on tap when the resolved task-id can't be found in `tasks`", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    editBtn.dataset.taskId = "missing";
    document.body.appendChild(editBtn);
    cy.fire("tap", "node[nodeType='task']", { target: { data: () => "t1" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
    expect(MockTaskModal.instances).toHaveLength(0);
    editBtn.remove();
  });

  it("opens the note directly on ctrl-click of the edit button", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1", filePath: "t1.md" })] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    editBtn.dataset.taskId = "t1";
    document.body.appendChild(editBtn);
    cy.fire("tap", "node[nodeType='task']", { target: { data: () => "t1" }, originalEvent: withTarget(new MouseEvent("click", { ctrlKey: true }), editBtn) });
    expect(mockOpenNoteFile).toHaveBeenCalledWith(expect.anything(), "t1.md");
    editBtn.remove();
  });

  it("opens an edit-mode TaskModal on plain edit-button click", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    editBtn.dataset.taskId = "t1";
    document.body.appendChild(editBtn);
    cy.fire("tap", "node[nodeType='task']", { target: { data: () => "t1" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
    expect(MockTaskModal.instances).toHaveLength(1);
    expect(MockTaskModal.instances[0].opts.mode).toBe("edit");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refreshSpy = vi.spyOn(view as any, "refresh").mockResolvedValue(undefined);
    MockTaskModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
    editBtn.remove();
  });

  it("project node: edit-button click opens ProjectModal; ctrl-click opens the note", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1", filePath: "p1.md" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    editBtn.dataset.projId = "p1";
    document.body.appendChild(editBtn);

    cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click", { ctrlKey: true }), editBtn) });
    expect(mockOpenNoteFile).toHaveBeenCalledWith(expect.anything(), "p1.md");

    cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
    expect(MockProjectModal.instances).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refreshSpy = vi.spyOn(view as any, "refresh").mockResolvedValue(undefined);
    MockProjectModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
    editBtn.remove();
  });

  it("project node: edit-button click does nothing when the edit button has no proj-id", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    document.body.appendChild(editBtn);
    cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
    expect(MockProjectModal.instances).toHaveLength(0);
    editBtn.remove();
  });

  it("project node: edit-button click does nothing when the proj-id doesn't resolve to a known project", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    editBtn.dataset.projId = "missing";
    document.body.appendChild(editBtn);
    cy.fire("tap", "node[nodeType='project']", { target: {}, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
    expect(MockProjectModal.instances).toHaveLength(0);
    editBtn.remove();
  });

  it("task node: edit-button click does nothing when the edit button has no task-id (section graph)", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    document.body.appendChild(editBtn);
    cy.fire("tap", "node[nodeType='task']", { target: { data: () => "t1" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
    expect(MockTaskModal.instances).toHaveLength(0);
    editBtn.remove();
  });

  it("marks an overdue task in the all-projects section graph", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", due: yesterday, status: "todo" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskEl = (cy.opts.elements as any[]).find((e) => e.data.id === "t1");
    expect(taskEl.data.isOverdue).toBe(true);
  });

  it("removes a dependency edge via cxttap on the section graph", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", dependencies: [] })],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const spy = vi.spyOn(view as never as { showRemoveDependencyMenu: (e: unknown) => void }, "showRemoveDependencyMenu" as never).mockImplementation(() => {});
    cy.fire("cxttap", "edge", { target: { data: () => "real" } });
    expect(spy).toHaveBeenCalled();
  });

  it("double-tap on a task drills into its subtasks (all-view section graph)", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", title: "Parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    cy.fire("dbltap", "node[nodeType='task']", { target: { data: () => "t1" }, originalEvent: undefined });
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.textContent).toContain("Parent");
  });

  it("double-tap ignores clicks on the edit button", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const editBtn = document.createElement("div");
    editBtn.className = "pm-node-edit-btn";
    document.body.appendChild(editBtn);
    cy.fire("dbltap", "node[nodeType='task']", { target: { data: () => "t1" }, originalEvent: withTarget(new MouseEvent("click"), editBtn) });
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.querySelector(".current")?.textContent).toBe("All");
    editBtn.remove();
  });

  it("double-tap on an unknown task id does nothing", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    cy.fire("dbltap", "node[nodeType='task']", { target: { data: () => "missing" }, originalEvent: undefined });
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.querySelector(".current")?.textContent).toBe("All");
  });

  it("saves node position and refits on dragfree", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view, plugin } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    cy.fire("dragfree", "node", { target: { id: () => "t1", position: () => ({ x: 5, y: 6 }) } });
    expect(plugin.settings.nodePositions["t1"]).toEqual({ x: 5, y: 6 });
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drilled task graph (2+ levels): buildElements, empty states, narrow layout
// ---------------------------------------------------------------------------

describe("drilled task graph (buildElements)", () => {
  // Drills directly by setting drillPath = [project, task] and re-rendering, bypassing
  // openTask()'s own contextual navigation semantics (it shows a task among siblings in
  // its *parent's* context, not drilled past the task itself — see the openTask describe
  // block for that behavior).
  function drillTo(view: TaskGraphView, project: Project, task: Task) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).drillPath = [project, task];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderGraph();
  }

  it("shows an empty-state message when a task has no subtasks", async () => {
    const project = makeProject({ id: "p1" });
    const task = makeTask({ id: "t1", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [task] });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, task);
    expect(view.contentEl.querySelector(".pm-compass-empty")?.textContent).toBe("No tasks found.");
  });

  it("renders subtasks and a real (non-virtual) dependency edge between siblings", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [
        parent,
        makeTask({ id: "c1", projectId: "p1", parentId: "parent" }),
        makeTask({ id: "c2", projectId: "p1", parentId: "parent", dependencies: ["c1"] }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, parent);
    const cy = getRegistryInstances().at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realEdges = (cy.opts.elements as any[]).filter((e) => e.data.source && e.data.target && e.data.edgeType !== "virtual");
    expect(realEdges).toHaveLength(1);
  });

  it("filters out a dependency edge whose source isn't in the visible task set", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent", dependencies: ["nonexistent"] })],
    });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, parent);
    const cy = getRegistryInstances().at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realEdges = (cy.opts.elements as any[]).filter((e) => e.data.source && e.data.target && e.data.edgeType !== "virtual");
    expect(realEdges).toHaveLength(0);
  });

  it("marks an overdue subtask", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent", due: yesterday, status: "todo" })],
    });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, parent);
    const cy = getRegistryInstances().at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskEl = (cy.opts.elements as any[]).find((e) => e.data.id === "c1");
    expect(taskEl.data.isOverdue).toBe(true);
  });

  it("does not mark a done overdue subtask as overdue", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent", due: yesterday, status: "done" })],
    });
    const { view } = makeView(makeApp(), makePlugin({ panelConfig: { showActiveOnly: false } }));
    await view.onOpen();
    drillTo(view, project, parent);
    const cy = getRegistryInstances().at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskEl = (cy.opts.elements as any[]).find((e) => e.data.id === "c1");
    expect(taskEl.data.isOverdue).toBe(false);
  });

  it("filters subtasks by active status when 'Active only' is set", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [
        parent,
        makeTask({ id: "c1", projectId: "p1", parentId: "parent", status: "todo" }),
        makeTask({ id: "c2", projectId: "p1", parentId: "parent", status: "done" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, parent);
    const cy = getRegistryInstances().at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskNodes = (cy.opts.elements as any[]).filter((e) => e.data.nodeType === "task");
    expect(taskNodes.map((n) => n.data.id)).toEqual(["c1"]);
  });

  it("drops context/virtual elements on a narrow container", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const container = view.contentEl.querySelector(".pm-compass-graph-container") as HTMLElement;
    Object.defineProperty(container, "clientWidth", { value: 300, configurable: true });
    drillTo(view, project, parent);
    const cy = getRegistryInstances().at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasContext = (cy.opts.elements as any[]).some((e) => e.data.isContext);
    expect(hasContext).toBe(false);
  });

  it("selects the pending task after layoutstop when navigated via openTask", async () => {
    vi.useFakeTimers();
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "parent", projectId: "p1" }),
        makeTask({ id: "c1", projectId: "p1", parentId: "parent" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "c1"); // c1 has a parent, so this drills to [project, parent]
    vi.advanceTimersByTime(0);
    vi.useRealTimers();
  });

  it("fits the graph and toggles panning/zooming off after layoutstop", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, parent);
    const container = view.contentEl.querySelector(".pm-compass-graph-container") as HTMLElement;
    expect(container.style.width).not.toBe("");
  });

  it("marks the context task itself as overdue when its own due date has passed", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1", due: yesterday, status: "todo" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, parent);
    const cy = getRegistryInstances().at(-1)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxEl = (cy.opts.elements as any[]).find((e) => e.data.isContext);
    expect(ctxEl.data.isOverdue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refresh(): drill-path reset/trim on stale data
// ---------------------------------------------------------------------------

describe("refresh() drill-path maintenance", () => {
  it("resets the drill path when the pinned project no longer exists", async () => {
    mockLoadVaultData.mockResolvedValueOnce({ projects: [makeProject({ id: "p1", title: "Alpha" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    cy.fire("tap", "node[nodeType='project']", { target: { data: () => ({}) } });
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.textContent).toContain("Alpha");

    mockLoadVaultData.mockResolvedValueOnce({ projects: [], tasks: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).refresh();
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.querySelector(".current")?.textContent).toBe("All");
  });

  it("trims the drill path at the first stale task", async () => {
    const project = makeProject({ id: "p1", title: "Alpha" });
    const t1 = makeTask({ id: "t1", projectId: "p1", title: "T1" });
    const t2 = makeTask({ id: "t2", projectId: "p1", title: "T2", parentId: "t1" });
    mockLoadVaultData.mockResolvedValueOnce({ projects: [project], tasks: [t1, t2] });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).drillPath = [project, t1, t2];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderGraph();
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.textContent).toContain("T2");

    mockLoadVaultData.mockResolvedValueOnce({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", title: "T1" })],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).refresh();
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.textContent).not.toContain("T2");
    expect(breadcrumb.textContent).toContain("T1");
  });

  it("does not trim a drilled task missing from the parsed list if its file still exists (metadataCache lag)", async () => {
    const project = makeProject({ id: "p1", title: "Alpha" });
    const t1 = makeTask({ id: "t1", projectId: "p1", title: "T1" });
    const t2 = makeTask({ id: "t2", projectId: "p1", title: "T2", parentId: "t1" });
    mockLoadVaultData.mockResolvedValueOnce({ projects: [project], tasks: [t1, t2] });
    const { view, app } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).drillPath = [project, t1, t2];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderGraph();

    // t2 (the drilled-in "context" task) is momentarily absent from the freshly parsed task
    // list — as if its own file was just written and metadataCache hasn't reparsed it yet —
    // but its file is still on disk.
    mockLoadVaultData.mockResolvedValueOnce({ projects: [project], tasks: [t1] });
    app.vault.getAbstractFileByPath.mockImplementation((path: string) => (path === t2.filePath ? {} : null));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (view as any).refresh();
    const breadcrumb = view.contentEl.querySelector(".pm-breadcrumb-items")!;
    expect(breadcrumb.textContent).toContain("T2");
  });
});

// ---------------------------------------------------------------------------
// onOpen event registration (metadataCache/vault)
// ---------------------------------------------------------------------------

describe("TaskGraphView.onOpen event registration", () => {
  it("schedules a refresh on a metadata change inside the projects folder", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined as never);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores a metadata change outside the projects folder", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined as never);
    app.metadataCache._emit("changed", { path: "Elsewhere/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("schedules a refresh on delete inside the projects folder, debouncing repeated calls", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined as never);
    app.vault._emit("delete", { path: "Projects/x.md" });
    app.vault._emit("delete", { path: "Projects/y.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("ignores delete outside the projects folder", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined as never);
    app.vault._emit("delete", { path: "Elsewhere/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// onClose
// ---------------------------------------------------------------------------

describe("TaskGraphView.onClose", () => {
  it("destroys cy instances and clears timers/drag state", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    await view.onClose();
    for (const cy of getRegistryInstances()) expect(cy.destroyed).toBe(true);
  });

  it("destroys the main drilled graph's own cy instance", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).drillPath = [project, parent];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderGraph();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mainCy = (view as any).cy;
    expect(mainCy).not.toBeNull();
    await view.onClose();
    expect(mainCy.destroyed).toBe(true);
  });

  it("does nothing extra when nothing was ever rendered", async () => {
    const { view } = makeView();
    await expect(view.onClose()).resolves.toBeUndefined();
  });

  it("clears a pending scheduled-refresh timer", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    app.metadataCache._emit("changed", { path: "Projects/x.md" }); // schedules a refresh timer, doesn't fire yet
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    await view.onClose();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// signalDashboard (via node tap selecting a task)
// ---------------------------------------------------------------------------

describe("signalDashboard", () => {
  it("does nothing when no dashboard leaf is open", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view, app } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    cy.fire("tap", "node[nodeType='task']", { target: { data: (k: string) => (k === "id" ? "t1" : undefined) }, originalEvent: withTarget(new MouseEvent("click"), plain) });
    expect(app.workspace.getLeavesOfType).toHaveBeenCalledWith("pm-compass-dashboard");
    plain.remove();
  });

  it("calls selectTask on the dashboard leaf's view when one is open", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const selectTask = vi.fn().mockReturnValue(true);
    const app = makeApp();
    app.workspace.getLeavesOfType.mockReturnValue([{ view: { selectTask } }]);
    const { view } = makeView(app);
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    cy.fire("tap", "node[nodeType='task']", { target: { data: (k: string) => (k === "id" ? "t1" : undefined) }, originalEvent: withTarget(new MouseEvent("click"), plain) });
    expect(selectTask).toHaveBeenCalledWith("t1");
    plain.remove();
  });
});

// ---------------------------------------------------------------------------
// pruneStalePositions
// ---------------------------------------------------------------------------

describe("pruneStalePositions", () => {
  it("removes positions for ids no longer present and saves settings", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view, plugin } = makeView(makeApp(), makePlugin({
      nodePositions: { "t1": { x: 1, y: 1 }, "stale-id": { x: 2, y: 2 }, "proj-p1": { x: 3, y: 3 } },
    }));
    await view.onOpen();
    expect(plugin.settings.nodePositions).toEqual({ "t1": { x: 1, y: 1 }, "proj-p1": { x: 3, y: 3 } });
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("does not call saveSettings when nothing was pruned", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view, plugin } = makeView(makeApp(), makePlugin({
      nodePositions: { "t1": { x: 1, y: 1 } },
    }));
    await view.onOpen();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("keeps context-task positions for entries in the current drill path", async () => {
    const project = makeProject({ id: "p1" });
    const task = makeTask({ id: "t1", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [task] });
    const { view, plugin } = makeView();
    await view.onOpen();
    // The initial onOpen()->refresh() already pruned with an empty drillPath, so set the
    // context position back and drill in before pruning again.
    plugin.settings.nodePositions["t1-ctx"] = { x: 1, y: 1 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).drillPath = [project, task];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).pruneStalePositions();
    expect(plugin.settings.nodePositions["t1-ctx"]).toEqual({ x: 1, y: 1 });
  });
});

// ---------------------------------------------------------------------------
// Node templates (taskNodeTemplate / projectNodeTemplate) — pure string builders
// ---------------------------------------------------------------------------

describe("node templates", () => {
  function callTemplate(view: TaskGraphView, name: "taskNodeTemplate" | "projectNodeTemplate", data: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (view as any)[name](data) as string;
  }

  it("taskNodeTemplate shows the due label and overdue styling when set", () => {
    const { view } = makeView();
    const html = callTemplate(view, "taskNodeTemplate", {
      id: "t1", label: "Title", status: "todo", statusColor: "#000", priorityColor: "#f00",
      due: "2026-01-01", isOverdue: true, childCount: 2,
    });
    expect(html).toContain("pm-node-due");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("2 subtasks");
  });

  it("taskNodeTemplate omits the due label when unset and uses singular 'subtask'", () => {
    const { view } = makeView();
    const html = callTemplate(view, "taskNodeTemplate", {
      id: "t1", label: "Title", status: "todo", statusColor: "#000", priorityColor: "",
      due: "", isOverdue: false, childCount: 1,
    });
    expect(html).not.toContain("pm-node-due");
    expect(html).toContain("1 subtask<");
  });

  it("taskNodeTemplate shows a due label without overdue styling when not overdue", () => {
    const { view } = makeView();
    const html = callTemplate(view, "taskNodeTemplate", {
      id: "t1", label: "Title", status: "todo", statusColor: "#000", priorityColor: "",
      due: "2026-12-31", isOverdue: false, childCount: 0,
    });
    expect(html).toContain("pm-node-due");
    expect(html).not.toContain("color:#ef4444");
  });

  it("taskNodeTemplate omits the subtask row when childCount is 0 and uses taskId over id when present", () => {
    const { view } = makeView();
    const html = callTemplate(view, "taskNodeTemplate", {
      id: "internal-id", taskId: "t1", label: "Title", status: "todo", statusColor: "#000",
      priorityColor: "", due: "", isOverdue: false, childCount: 0,
    });
    expect(html).not.toContain("pm-node-subtask-row");
    expect(html).toContain('data-task-id="t1"');
  });

  it("projectNodeTemplate renders the project id and color", () => {
    const { view } = makeView();
    const html = callTemplate(view, "projectNodeTemplate", { projId: "p1", label: "Alpha", color: "#123456" });
    expect(html).toContain('data-proj-id="p1"');
    expect(html).toContain("#123456");
  });

  it("projectNodeTemplate handles a missing projId gracefully", () => {
    const { view } = makeView();
    const html = callTemplate(view, "projectNodeTemplate", { label: "Alpha", color: "#123456" });
    expect(html).toContain('data-proj-id=""');
  });
});

// ---------------------------------------------------------------------------
// Separators (renderSeparators / renderSectionSeparator)
// ---------------------------------------------------------------------------

describe("separators", () => {
  it("draws a vertical separator between context and task columns when there's a gap", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "parent", projectId: "p1" }),
        makeTask({ id: "c1", projectId: "p1", parentId: "parent" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "parent");
    const container = view.contentEl.querySelector(".pm-compass-graph-container") as HTMLElement;
    expect(container.querySelector(".pm-sep-svg")).not.toBeNull();
  });

  it("draws a separator in a project section graph too", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const section = view.contentEl.querySelector(".pm-project-section") as HTMLElement;
    expect(section.querySelector(".pm-sep-svg")).not.toBeNull();
  });

  it("clears previously-drawn separator lines on a second render (section graph)", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const cy = getRegistryInstances()[0];
    const section = view.contentEl.querySelector(".pm-project-section") as HTMLElement;
    const before = section.querySelectorAll(".pm-sep-line").length;
    // dragfree re-invokes renderSectionSeparator, which must clear the old line(s) first.
    cy.fire("dragfree", "node", { target: { id: () => "t1", position: () => ({ x: 5, y: 6 }) } });
    const after = section.querySelectorAll(".pm-sep-line").length;
    expect(after).toBe(before);
  });

  it("clears previously-drawn separator lines on a second render (main drilled graph)", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).drillPath = [project, parent];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view as any).renderGraph();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mainCy = (view as any).cy;
    const container = view.contentEl.querySelector(".pm-compass-graph-container") as HTMLElement;
    const before = container.querySelectorAll(".pm-sep-line").length;
    mainCy.fire("dragfree", "node", { target: { id: () => "c1", position: () => ({ x: 5, y: 6 }) } });
    const after = container.querySelectorAll(".pm-sep-line").length;
    expect(after).toBe(before);
  });
});
