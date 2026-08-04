// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Icon } from "./icons";
import { bagOf } from "./__testing__/dom-bag";
import type { WorkspaceLeaf } from "obsidian";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills
// ---------------------------------------------------------------------------

/** Stands in for `display: none`: jsdom has no layout, so what hides an element in these
 *  tests is a class the `isShown` stub below reads. */
const HIDDEN = "pm-test-hidden";
const hide = (el: HTMLElement) => el.classList.add(HIDDEN);
const show = (el: HTMLElement) => el.classList.remove(HIDDEN);

function installObsidianDOMPolyfills() {
  const htmlProto = bagOf(HTMLElement.prototype);

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
    return this.createEl("div", opts);
  };
  htmlProto.createSpan = function (this: HTMLElement, opts?: CreateElOpts) {
    return this.createEl("span", opts);
  };
  htmlProto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
  // Obsidian's own `isShown` is `!!offsetParent`, which jsdom can't answer — it has no
  // layout. Standing in with a walk for a `display: none` self or ancestor keeps the
  // distinction the gate depends on: a view hidden by something above it reads as hidden.
  const shown = (el: HTMLElement | null): boolean =>
    !el || (!el.classList.contains(HIDDEN) && shown(el.parentElement));
  htmlProto.isShown = function (this: HTMLElement) {
    return shown(this);
  };
  htmlProto.setCssStyles = function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  // Obsidian's global builder, which makes a detached element — what the cards start from.
  bagOf(window).createDiv = (opts?: CreateElOpts) => {
    const el = document.createElement("div");
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    return el;
  };
  bagOf(window).CSS = { escape: (s: string) => s };
  if (!("elementFromPoint" in document)) {
    bagOf(document).elementFromPoint = () => null;
  }
  // jsdom implements no pointer capture, and `startDragConnect` releases one on
  // every press — without this the drag never gets past its first line.
  htmlProto.releasePointerCapture = () => {};
  bagOf(window).activeDocument = document;
  bagOf(window).createSvg = (tag: string, opts?: CreateElOpts) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (opts?.cls) el.setAttribute("class", opts.cls);
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
    }
    return el;
  };
}

/** jsdom rewrites colours as it stores them, so an expected value goes through the same
 *  door before it's compared. */
function asStyle(prop: string, value: string): string {
  const probe = document.createElement("div");
  probe.style.setProperty(prop, value);
  return probe.style.getPropertyValue(prop);
}

/** Event.target is a read-only getter; use this to stub it on a synthetic event. */
function withTarget<E extends Event>(evt: E, target: Element): E {
  Object.defineProperty(evt, "target", { value: target, configurable: true });
  return evt;
}

// jsdom has no ResizeObserver. Recording the instances lets a test fire one, which is how a
// view regaining a size — a sidebar being expanded — reaches its refresh gate.
const resizeObservers: { fire: () => void }[] = [];
function installResizeObserverStub() {
  bagOf(window).ResizeObserver = class {
    constructor(cb: () => void) {
      resizeObservers.push({ fire: cb });
    }
    observe() {}
    disconnect() {}
  };
}
/** Fires the most recently created observer, i.e. the one belonging to the view under test. */
function fireResize() {
  resizeObservers.at(-1)?.fire();
}

beforeAll(() => {
  installObsidianDOMPolyfills();
  installResizeObserverStub();
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
  mockConfirmAction,
  mockAddTaskDependency,
  mockRemoveTaskDependency,
  mockDeleteTaskFile,
  mockPatchTaskField,
  mockOpenDropdown,
  mockOpenNoteFile,
  mockOpenMoveTaskModal,
  mockApplyTaskMove,
  mockLoadVaultData,
} = vi.hoisted(() => {
  class MockItemView {
    app: unknown;
    contentEl: HTMLElement;
    containerEl: HTMLElement;
    leaf: unknown;
    constructor(leaf: { app: unknown }) {
      this.app = leaf.app;
      this.leaf = leaf;
      this.contentEl = document.createElement("div");
      this.containerEl = document.createElement("div");
    }
    registerEvent() {}
    register() {}
    registerDomEvent(el: EventTarget, type: string, handler: EventListener, options?: boolean | AddEventListenerOptions) {
      el.addEventListener(type, handler, options);
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
    static instances: MockTaskModal[] = [];
    constructor(
      public app: unknown,
      public opts: { onSuccess: () => void; mode?: string; parentTask?: { id: string } },
    ) {
      MockTaskModal.instances.push(this);
    }
    open() {}
  }
  class MockProjectModal {
    static instances: MockProjectModal[] = [];
    constructor(
      public app: unknown,
      public opts: { onSuccess: () => void; mode?: string; parentTask?: { id: string } },
    ) {
      MockProjectModal.instances.push(this);
    }
    open() {}
  }
  // Records what the view asked about instead of opening a dialog; a test that wants the
  // action to go through runs the recorded `onConfirm` itself.
  interface ConfirmCall {
    required: boolean;
    message: string;
    onConfirm: () => void;
    cta?: { label: string; cls: string };
  }
  const mockConfirmAction = Object.assign(
    (
      _app: unknown, required: boolean, message: string, onConfirm: () => void,
      cta?: { label: string; cls: string },
    ) => {
      mockConfirmAction.calls.push({ required, message, onConfirm, cta });
    },
    { calls: [] as ConfirmCall[] },
  );

  return {
    MockItemView,
    MockMenu,
    MockNotice,
    MockTaskModal,
    MockProjectModal,
    mockConfirmAction,
    mockAddTaskDependency: vi.fn().mockResolvedValue(undefined),
    mockRemoveTaskDependency: vi.fn().mockResolvedValue(undefined),
    mockDeleteTaskFile: vi.fn().mockResolvedValue(undefined),
    mockPatchTaskField: vi.fn().mockResolvedValue(undefined),
    mockOpenDropdown: vi.fn<typeof import("./task-creator").openDropdown>(),
    mockOpenNoteFile: vi.fn(),
    mockOpenMoveTaskModal: vi.fn<typeof import("./move-target-modal").openMoveTaskModal>(),
    mockApplyTaskMove: vi.fn<typeof import("./move-target-modal").applyTaskMove>(),
    mockLoadVaultData: vi.fn().mockResolvedValue({ tasks: [], projects: [] }),
  };
});

/** A stand-in for `TFile`, hoisted so `resolveFile`'s `instanceof` sees the same class the
 *  notes below are made of. */
const { MockTFile } = vi.hoisted(() => ({
  MockTFile: class { constructor(public path = "") {} },
}));

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
  TFile: MockTFile,
  TAbstractFile: class {},
  WorkspaceLeaf: class {},
  setIcon: () => {},
  getIcon: (name: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-icon", name);
    return svg;
  },
}));

vi.mock("./task-creator", async (importOriginal) => ({
  // Spread the original so value exports (enums the callers branch on)
  // survive the mock; only the behaviours below are replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  TaskModal: MockTaskModal,
  ProjectModal: MockProjectModal,
  confirmAction: mockConfirmAction,
  addTaskDependency: mockAddTaskDependency,
  removeTaskDependency: mockRemoveTaskDependency,
  deleteTaskFile: mockDeleteTaskFile,
  patchTaskField: mockPatchTaskField,
  openDropdown: mockOpenDropdown,
  openNoteFile: mockOpenNoteFile,
}));

vi.mock("../model/project/vault-reader", () => ({ loadVaultData: mockLoadVaultData }));

vi.mock("./move-target-modal", () => ({
  openMoveTaskModal: mockOpenMoveTaskModal,
  applyTaskMove: mockApplyTaskMove,
}));

// dashboard-view.ts only needed for the DASHBOARD_VIEW_TYPE string constant.
vi.mock("./dashboard-view", () => ({ DASHBOARD_VIEW_TYPE: "pm-compass-dashboard" }));

import { TaskGraphView, TASK_GRAPH_VIEW_TYPE, stripWikiLinks, withAlpha } from "./task-graph-view";
import type { GraphRenderer } from "./graph-renderer";
import { ContainerNode, TaskNode, NODE_HEIGHT, NODE_WIDTH, type GraphNode } from "./graph-node";
import { EdgeEnd, type GraphEdge } from "./graph-edge";
import { type Project } from "../model/project/project";
import { Task, type TaskFields } from "../model/project/task";
import { PRIORITY_COLORS, Priority } from "../model/base-task";
import { ConfirmStyle } from "./pm-modal";
import { MIN_CARD_HEIGHT, MIN_CARD_WIDTH } from "../model/project/card-layout";

function makeTask(overrides: Partial<TaskFields> & { id: string }): Task {
  return new Task({
    projectId: "proj-1",
    title: "A task",
    status: "todo",
    dependencies: [],
    subtasks: [],
    filePath: `tasks/${overrides.id}.md`,
    ...overrides,
  });
}

/** Puts a project's or a task's note in the vault, carrying whatever layout it was built
 *  with, and hands back its frontmatter — where a card write lands and what a test reads. */
function noteFor(app: ReturnType<typeof makeApp>, entry: Project | Task): Record<string, unknown> {
  const fm: Record<string, unknown> = entry.card ? { cardLayout: { ...entry.card } } : {};
  app._notes.set(entry.filePath, fm);
  return fm;
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return { title: "A project", filePath: `projects/${overrides.id}.md`, tasks: [], ...overrides };
}

function makeApp() {
  const eventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const notes = new Map<string, Record<string, unknown>>();
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
      // Only a note `noteFor` put there exists. Everything else is "file gone", which is
      // what the stale-drill-path tests (genuine deletions) want.
      getAbstractFileByPath: vi.fn((path: string) => (notes.has(path) ? new MockTFile(path) : null)),
    },
    fileManager: {
      processFrontMatter: vi.fn(
        async (file: { path: string }, mutate: (fm: Record<string, unknown>) => void) => {
          mutate(notes.get(file.path)!);
        },
      ),
    },
    /** The frontmatter of every note the vault holds, keyed by path — what a write lands in
     *  and what a test reads back. */
    _notes: notes,
    workspace: {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (eventHandlers[`workspace.${event}`] ??= []).push(cb);
      }),
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of eventHandlers[`workspace.${event}`] ?? []) cb(...args);
      },
    },
  };
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      projectsFolder: "Projects",
      panelConfig: { showActiveOnly: true },
      confirmDeletes: true,
      confirmTaskMoves: true,
      confirmDependencyRemoval: true,
      confirmLayoutReset: false,
      ...overrides,
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
}

/** The view's own members, named rather than reached for through `any`: the graph it
 *  builds, where the drill-down stands, and the passes the tests drive by hand. */
interface ViewInternals {
  graph: GraphRenderer | null;
  graphContainer: HTMLElement;
  tasks: Task[];
  projects: Project[];
  drillPath: Array<Project | Task>;
  renderGraph(): void;
  refresh(): Promise<void>;
  cancelDragConnect(): void;
  addDependency(sourceId: string, targetId: string): Promise<void>;
  removeDependency(sourceId: string, targetId: string, isDirect: boolean): void;
  openTaskContextMenu(e: MouseEvent, task: Task): void;
  signalDashboard(taskId: string): void;
  repoint(edge: GraphEdge, end: EdgeEnd, target: GraphNode, evt: PointerEvent): void;
  repointChoices(edge: GraphEdge, end: EdgeEnd, target: GraphNode): unknown[];
}

/** What the renderer was handed, which is what a re-point gesture works on. */
interface RendererInternals {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
const drawn = (view: TaskGraphView) =>
  internals(view).graph as unknown as RendererInternals;
const internals = (view: TaskGraphView) => view as unknown as ViewInternals;

function makeView(app = makeApp(), plugin = makePlugin()) {
  const leaf = { app } as unknown as WorkspaceLeaf;
  const view = new TaskGraphView(leaf, plugin);
  return { view, app, plugin };
}

/** Opens the view onto one project's own tasks, which is one step in from the top: the top
 *  level draws the projects and nothing else. */
async function openProject(view: TaskGraphView, projectId = "p1"): Promise<void> {
  await view.onOpen();
  const proj = internals(view).projects.find((p) => p.id === projectId);
  if (!proj) throw new Error(`no project ${projectId} loaded`);
  internals(view).drillPath = [proj];
  internals(view).renderGraph();
}

// ── driving the rendered graph ────────────────────────────────────────────────

/** One task's card, as the renderer drew it. */
function cardFor(view: TaskGraphView, taskId: string): HTMLElement {
  const card = view.contentEl.querySelector<HTMLElement>(`.pm-node-card[data-task-id="${taskId}"]`);
  if (!card) throw new Error(`no card drawn for task ${taskId}`);
  return card;
}

/** What the frame round the level names, which is where the level being looked at is
 *  written now that the breadcrumb leaves it off. */
function levelTitle(view: TaskGraphView): string | undefined {
  return view.contentEl.querySelector<HTMLElement>(".pm-graph-container-header")?.textContent ?? undefined;
}

/** One project heading's card. */
function projectCardFor(view: TaskGraphView, projId: string): HTMLElement {
  const card = view.contentEl.querySelector<HTMLElement>(`.pm-node-project-card[data-proj-id="${projId}"]`);
  if (!card) throw new Error(`no card drawn for project ${projId}`);
  return card;
}

/** A card's edit button — what a tap has to land on to open the modal. */
function editBtnIn(card: HTMLElement): HTMLElement {
  return card.querySelector<HTMLElement>(".pm-node-edit-btn")!;
}

/** The wide invisible strokes the renderer lays under the dependency edges. */
function edgeHitLines(view: TaskGraphView): SVGLineElement[] {
  return [...view.contentEl.querySelectorAll<SVGLineElement>(".pm-graph-edge-hit")];
}

type PointerInit = PointerEventInit & { at?: number };

/** `at` stamps the event's clock, which is how the renderer tells a double tap from two. */
function pointerEvent(type: string, init: PointerInit): PointerEvent {
  const { at, ...rest } = init;
  const evt = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, ...rest });
  if (at !== undefined) Object.defineProperty(evt, "timeStamp", { value: at, configurable: true });
  return evt;
}

/** The press, which the card's own wrapper listens for. */
function pressOn(target: Element, init: PointerInit = {}): void {
  target.dispatchEvent(pointerEvent("pointerdown", init));
}

/** What follows a press goes to the document, where the renderer tracks the gesture. The
 *  view's `contentEl` is detached here, so nothing dispatched on a card would reach it. */
function documentPointer(target: Element, type: string, init: PointerInit = {}): void {
  document.dispatchEvent(withTarget(pointerEvent(type, init), target));
}

/** A press and release that never travels — what the renderer reads as a tap. */
function tap(target: Element, init: PointerInit = {}): void {
  pressOn(target, init);
  documentPointer(target, "pointerup", init);
}

/** Two taps in quick succession, which is what drills in. */
function doubleTap(target: Element, init: PointerInit = {}): void {
  tap(target, init);
  tap(target, init);
}

/** A press that travels far enough to move the card. */
/** Every pending microtask, however deep the chain: a macrotask runs after all of them.
 *  Real timers only — under fake ones nothing comes along to schedule it. */
function flush(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function drag(target: Element, dx: number, dy: number, init: PointerInit = {}): void {
  pressOn(target, { ...init, clientX: 0, clientY: 0 });
  documentPointer(target, "pointermove", { ...init, clientX: dx, clientY: dy });
  documentPointer(target, "pointerup", { ...init, clientX: dx, clientY: dy });
}

beforeEach(() => {
  vi.clearAllMocks();
  MockMenu.instances.length = 0;
  MockNotice.instances.length = 0;
  MockTaskModal.instances.length = 0;
  MockProjectModal.instances.length = 0;
  mockConfirmAction.calls.length = 0;
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
    expect(view.getIcon()).toBe(Icon.TaskGraphTab);
  });

  it("renderGraph() does nothing before onOpen() has set up the container", () => {
    const { view } = makeView();
    expect(() => internals(view).renderGraph()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onOpen / refresh — all-projects table (no drill)
// ---------------------------------------------------------------------------

describe("TaskGraphView.onOpen — the grid of projects", () => {
  it("shows an empty-state message when there are no projects", async () => {
    const { view } = makeView();
    await view.onOpen();
    expect(view.contentEl.querySelector(".pm-compass-empty")?.textContent).toBe("No projects found.");
  });

  it("draws one card per project, and no task at all", async () => {
    // A project's tasks are one drill in; the top of the trail is the projects themselves.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", status: "todo" }),
        makeTask({ id: "t2", projectId: "p1", status: "done" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    const cards = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-project-card")];
    expect(cards.map((c) => c.dataset.projId)).toEqual(["p1"]);
    expect(view.contentEl.querySelectorAll(".pm-node-card")).toHaveLength(0);
  });

  it("orders the cards by title, whatever order the vault read them in", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [
        makeProject({ id: "p3", title: "Gamma" }),
        makeProject({ id: "p1", title: "Alpha" }),
        makeProject({ id: "p2", title: "Beta" }),
      ],
      tasks: [],
    });
    const { view } = makeView();
    await view.onOpen();
    const cards = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-project-card")];
    expect(cards.map((c) => c.dataset.projId)).toEqual(["p1", "p2", "p3"]);
  });

  it("leaves an archived project out by default", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2", archived: true })],
      tasks: [makeTask({ id: "t1", projectId: "p2", status: "todo" })],
    });
    const { view } = makeView();
    await view.onOpen();
    const cards = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-project-card")];
    expect(cards.map((c) => c.dataset.projId)).toEqual(["p1"]);
  });

  it("draws an archived project faded and pilled with 'Active only' off", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p2", archived: true })],
      tasks: [],
    });
    const { view } = makeView(makeApp(), makePlugin({ panelConfig: { showActiveOnly: false } }));
    await view.onOpen();
    const card = view.contentEl.querySelector(".pm-node-project-card")!;
    expect(card.classList.contains("pm-node-project-card--archived")).toBe(true);
    expect(card.querySelector(".pm-node-project-archived")?.textContent).toBe("Archived");
  });

  it("says so when every project is archived and none are shown", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p2", archived: true })],
      tasks: [],
    });
    const { view } = makeView();
    await view.onOpen();
    expect(view.contentEl.querySelector(".pm-compass-empty")?.textContent).toContain("Every project is archived");
  });

  it("says so inside the frame when a project drilled into holds no task", async () => {
    // Said inside the frame rather than in place of it: an empty box still names where the
    // trail has come to, which nothing else on screen does.
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1", title: "Alpha" })], tasks: [] });
    const { view } = makeView();
    await openProject(view);
    expect(view.contentEl.querySelector(".pm-graph-container-empty")?.textContent).toBe("No tasks here.");
    expect(levelTitle(view)).toBe("Alpha");
  });

  describe("reflowing to the panel's width", () => {
    /** Renders the grid at `width`, then re-reports the container at `next`. */
    async function resizeTo(width: number, next: number) {
      mockLoadVaultData.mockResolvedValue({
        projects: ["p1", "p2", "p3"].map((id) => makeProject({ id })),
        tasks: [],
      });
      const { view } = makeView();
      const container = () => internals(view).graphContainer;
      await view.onOpen();
      Object.defineProperty(container(), "clientWidth", { value: width, configurable: true });
      internals(view).renderGraph();
      const before = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-graph-node")].map((n) => n.style.left);

      Object.defineProperty(container(), "clientWidth", { value: next, configurable: true });
      view.onResize();
      const after = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-graph-node")].map((n) => n.style.left);
      return { view, before, after };
    }

    /** Room for one card, and for three. */
    const NARROW = 200;
    const WIDE = 1000;

    it("lays the cards out across the first width it is given", async () => {
      // Nothing is laid out against a panel with no width — it would file every card into
      // one column, and that is the arrangement the projects would then be stuck with.
      const { after } = await resizeTo(0, WIDE);
      expect(new Set(after).size).toBe(3);
    });

    it("leaves them where they are once they each have a place of their own", async () => {
      // The first sized layout is written onto the projects, so a later width finds cards
      // that are nobody's to arrange but the user's.
      const { before, after } = await resizeTo(NARROW, WIDE);
      expect(new Set(before).size).toBe(1);
      expect(after).toEqual(before);
    });

    it("moves the cards it already drew rather than drawing them again", async () => {
      mockLoadVaultData.mockResolvedValue({
        projects: ["p1", "p2", "p3"].map((id) => makeProject({ id })),
        tasks: [],
      });
      const { view } = makeView();
      const container = () => internals(view).graphContainer;
      await view.onOpen();
      Object.defineProperty(container(), "clientWidth", { value: NARROW, configurable: true });
      internals(view).renderGraph();
      const card = view.contentEl.querySelector(".pm-node-project-card")!;

      Object.defineProperty(container(), "clientWidth", { value: WIDE, configurable: true });
      view.onResize();

      // The same element, moved — a reflow reads no vault and builds no DOM.
      expect(view.contentEl.querySelector(".pm-node-project-card")).toBe(card);
      expect(mockLoadVaultData).toHaveBeenCalledTimes(1);
    });

    it("leaves the drawing alone when the count is unchanged", async () => {
      const { before, after } = await resizeTo(WIDE, WIDE + 20);
      expect(after).toEqual(before);
    });

    it("leaves every level below the top alone, whatever the room", async () => {
      mockLoadVaultData.mockResolvedValue({
        projects: [makeProject({ id: "p1" })],
        tasks: [makeTask({ id: "t1", projectId: "p1" })],
      });
      const { view } = makeView();
      await openProject(view);
      // Below the top of the trail nothing depends on the width at all.
      Object.defineProperty(internals(view).graphContainer, "clientWidth", { value: 50, configurable: true });
      const before = cardFor(view, "t1").parentElement!.style.left;
      view.onResize();
      expect(cardFor(view, "t1").parentElement!.style.left).toBe(before);
    });

    it("counts nothing while the panel has no width to count", async () => {
      mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [] });
      const { view } = makeView();
      await view.onOpen();
      Object.defineProperty(internals(view).graphContainer, "clientWidth", { value: 0, configurable: true });
      expect(() => view.onResize()).not.toThrow();
      expect(view.contentEl.querySelectorAll(".pm-node-project-card")).toHaveLength(1);
    });
  });

  it("draws a cancelled task's children as cancelled, whatever their own status says", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", status: "cancelled" }),
        makeTask({ id: "t2", projectId: "p1", status: "todo", parentId: "t1" }),
      ],
    });
    const { view } = makeView(makeApp(), makePlugin({ panelConfig: { showActiveOnly: false } }));
    await view.onOpen();
    await view.openTask("p1", "t2");
    expect(cardFor(view, "t2").querySelector(".pm-node-status")!.textContent).toContain("cancelled");
  });

  it("hides a cancelled task's children under 'Active only'", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", status: "cancelled" }),
        makeTask({ id: "t2", projectId: "p1", status: "todo", parentId: "t1" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "t2");
    expect(view.contentEl.querySelector('.pm-node-card[data-task-id="t2"]')).toBeNull();
  });

  it("includes done/cancelled and subtasks when 'Active only' is unchecked", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", status: "done" })],
    });
    const { view } = makeView(makeApp(), makePlugin({ panelConfig: { showActiveOnly: false } }));
    await openProject(view);
    expect(view.contentEl.querySelectorAll(".pm-node-card")).toHaveLength(1);
  });

  it("fades a card ribbon to the highest priority in its subtree", async () => {
    // The subtree is only drawn once drilled into, so the ribbon is all the section
    // shows of it.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", priority: Priority.Medium }),
        makeTask({ id: "t2", projectId: "p1", parentId: "t1", priority: Priority.High }),
      ],
    });
    const { view } = makeView();
    await openProject(view);
    const ribbon = cardFor(view, "t1").querySelector<HTMLElement>(".pm-node-ribbon")!;
    expect(ribbon.style.background).toBe(
      asStyle("background", `linear-gradient(to bottom, ${PRIORITY_COLORS[Priority.Medium]!}, ${PRIORITY_COLORS[Priority.High]!})`),
    );
  });

  it("leaves a card's ribbon solid when only closed subtasks outrank it", async () => {
    // A closed subtask has nothing left to signal, so it doesn't pull the ribbon.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", priority: Priority.Medium }),
        makeTask({ id: "t2", projectId: "p1", parentId: "t1", priority: Priority.Critical, status: "done" }),
        makeTask({ id: "t3", projectId: "p1", parentId: "t1", priority: Priority.Critical, status: "cancelled" }),
      ],
    });
    const { view } = makeView();
    await openProject(view);
    const ribbon = cardFor(view, "t1").querySelector<HTMLElement>(".pm-node-ribbon")!;
    expect(ribbon.style.background).toBe(asStyle("background", PRIORITY_COLORS[Priority.Medium]!));
  });

  it("draws a dependency edge between two of a project's root tasks", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1" }),
        makeTask({ id: "t2", projectId: "p1", dependencies: ["t1"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(1);
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

  it("drills into a project on card click, the frame naming the level", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [],
    });
    const { view } = makeView();
    await view.onOpen();
    tap(projectCardFor(view, "p1"));
    // The level is named by the frame it is drawn in; the trail only names the way back.
    expect(levelTitle(view)).toBe("Alpha");
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.textContent).not.toContain("Alpha");
  });

  it("navigates back to 'All' via the breadcrumb link", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [],
    });
    const { view } = makeView();
    await view.onOpen();
    tap(projectCardFor(view, "p1"));
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
    tap(projectCardFor(view, "p1"));

    doubleTap(cardFor(view, "t1"));

    // Two levels in, the trail names the way back: "All" and the project.
    const items = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-breadcrumb-item")];
    expect(items.map((i) => i.textContent)).toEqual(["All", "Alpha"]);
    expect(levelTitle(view)).toBe("Parent task");

    items[items.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(levelTitle(view)).toBe("Alpha");
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

  it("brings the archived projects back when 'Active only' goes off", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2", archived: true })],
      tasks: [],
    });
    const { view } = makeView();
    await view.onOpen();
    expect(view.contentEl.querySelectorAll(".pm-node-project-card")).toHaveLength(1);

    const checkbox = view.contentEl.querySelector(".pm-compass-toggle input") as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    expect(view.contentEl.querySelectorAll(".pm-node-project-card")).toHaveLength(2);
  });

  it("drops out of an archived project when 'Active only' goes on", async () => {
    const archived = makeProject({ id: "p2", archived: true });
    mockLoadVaultData.mockResolvedValue({ projects: [archived], tasks: [] });
    const { view } = makeView(makeApp(), makePlugin({ panelConfig: { showActiveOnly: false } }));
    await view.onOpen();
    internals(view).drillPath = [archived];
    internals(view).renderGraph();
    expect(internals(view).drillPath).toEqual([archived]);

    const checkbox = view.contentEl.querySelector(".pm-compass-toggle input") as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));

    expect(internals(view).drillPath).toEqual([]);
    expect(view.contentEl.querySelector(".pm-compass-empty")?.textContent).toContain("Every project is archived");
  });

  /** Opens the graph on one arranged task and one that has never been touched, and hands
   *  back the arranged one's frontmatter — which is what a reset edits. */
  async function withArrangedTask(card: Record<string, number>) {
    const app = makeApp();
    const arranged = makeTask({ id: "t1", projectId: "p1", card });
    const plain = makeTask({ id: "t2", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [arranged, plain] });
    const { view } = makeView(app);
    const fm = noteFor(app, arranged);
    noteFor(app, plain);
    await view.onOpen();
    return { view, app, fm };
  }

  /** Presses one of the two reset buttons, named as the panel labels it. */
  function pressReset(view: TaskGraphView, label: string): void {
    const btn = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-compass-reset-btn")]
      .find((b) => b.textContent === label);
    if (!btn) throw new Error(`no reset button labelled "${label}"`);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  it("names both resets, the layout first", async () => {
    const { view } = await withArrangedTask({ x: 1, y: 2 });
    const labels = [...view.contentEl.querySelectorAll(".pm-compass-reset-btn")]
      .map((b) => b.textContent);
    expect(labels).toEqual(["Reset layout", "Reset card size"]);
  });

  it("forgets where the cards sat, leaving how big they were made", async () => {
    const { view, app, fm } = await withArrangedTask({ x: 1, y: 2, w: 300, h: 100 });

    pressReset(view, "Reset layout");
    // The question names how many notes it would edit — only the ones carrying a place.
    expect(mockConfirmAction.calls[0].message)
      .toBe("Forget every card position? This edits 1 note.");
    mockConfirmAction.calls[0].onConfirm();
    await Promise.resolve();

    expect(fm.cardLayout).toEqual({ w: 300, h: 100 });
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledOnce();
  });

  it("forgets how big the cards were made, leaving where they sat", async () => {
    const { view, fm } = await withArrangedTask({ x: 1, y: 2, w: 300, h: 100 });

    pressReset(view, "Reset card size");
    expect(mockConfirmAction.calls[0].message).toBe("Forget every card size? This edits 1 note.");
    mockConfirmAction.calls[0].onConfirm();
    await Promise.resolve();

    expect(fm.cardLayout).toEqual({ x: 1, y: 2 });
  });

  it("drops the key when the half it forgot was the only one there", async () => {
    const { view, fm } = await withArrangedTask({ x: 1, y: 2 });

    pressReset(view, "Reset layout");
    mockConfirmAction.calls[0].onConfirm();
    await Promise.resolve();

    expect(fm.cardLayout).toBeUndefined();
  });

  it("redraws and counts the notes it could not reset", async () => {
    const { view, app } = await withArrangedTask({ x: 1, y: 2 });
    // Gone since the read the panel counted against, so the write on it throws.
    app._notes.delete("tasks/t1.md");
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never)
      .mockResolvedValue(undefined);

    pressReset(view, "Reset layout");
    mockConfirmAction.calls[0].onConfirm();
    await flush();

    // One notice for the lot, and the drawing redrawn either way: some of it may have
    // landed, and what the vault holds now is what the graph has to show.
    expect(MockNotice.instances).toEqual(["Could not reset 1 of 1 note."]);
    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it("asks nothing of a reset with nothing to forget", async () => {
    // Every card has been dragged and none resized, so only one of the two has work.
    const { view } = await withArrangedTask({ x: 1, y: 2 });

    pressReset(view, "Reset card size");

    expect(mockConfirmAction.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

describe("context menus", () => {
  it("opens the add-task menu on a right-click of a project's card", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [] });
    const { view } = makeView();
    await view.onOpen();
    const card = view.contentEl.querySelector(".pm-node-project-card") as HTMLElement;
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: card, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(1);
  });

  it("does nothing on a right-click of the room between the cards", async () => {
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
    await openProject(view);
    const card = document.createElement("div");
    card.className = "pm-node-card";
    card.dataset.taskId = "t1";
    view.contentEl.querySelector(".pm-compass-graph-container")!.appendChild(card);
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: card, configurable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(1);
  });

  it("opens no menu on a card standing for a task outside the level", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", dependencies: ["out"] }),
        makeTask({ id: "out", projectId: "p2" }),
      ],
    });
    const { view } = makeView();
    await openProject(view);

    // A card was pressed, so the room's own add-task menu isn't offered either.
    view.contentEl.querySelector(".pm-node-card--external")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(MockMenu.instances).toHaveLength(0);
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
    internals(view).drillPath = [project, parent];
    internals(view).renderGraph();
    const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(MockMenu.instances).toHaveLength(1);
    MockMenu.instances[0].items[0]._onClick!();
    expect(MockTaskModal.instances[0].opts.parentTask).toBe(parent);

    const refreshSpy = vi.spyOn(internals(view), "refresh").mockResolvedValue(undefined);
    MockTaskModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
  });

  describe("node tap/dbltap handling (task-drilled section graph, drillPath.length >= 2)", () => {
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
      internals(view).drillPath = [project, parent];
      internals(view).renderGraph();
      return { view, project, parent, child, grandchild };
    }

  it("ignores taps on the connect button", async () => {
      const { view } = await renderDrilledView();
      tap(cardFor(view, "child").querySelector(".pm-node-connect-btn")!);
      expect(MockTaskModal.instances).toHaveLength(0);
    });

  it("selects the node when the tap target isn't the edit button", async () => {
      const { view } = await renderDrilledView();
      const selectSpy = vi.spyOn(view, "selectGraphNode");
      const signalSpy = vi.spyOn(internals(view), "signalDashboard");
      tap(cardFor(view, "child").querySelector(".pm-node-title")!);
      expect(selectSpy).toHaveBeenCalledWith("child");
      expect(signalSpy).toHaveBeenCalledWith("child");
    });

  it("edit-button click does nothing when the card's task is no longer known", async () => {
      const { view } = await renderDrilledView();
      internals(view).tasks = [];
      tap(editBtnIn(cardFor(view, "child")));
      expect(MockTaskModal.instances).toHaveLength(0);
    });

  it("opens the note directly on ctrl-click of the edit button", async () => {
      const { view } = await renderDrilledView();
      tap(editBtnIn(cardFor(view, "child")), { ctrlKey: true });
      expect(mockOpenNoteFile).toHaveBeenCalledWith(expect.anything(), "child.md");
    });

  it("opens an edit-mode TaskModal on plain edit-button click, and refreshes on success", async () => {
      const { view } = await renderDrilledView();
      tap(editBtnIn(cardFor(view, "child")));
      expect(MockTaskModal.instances).toHaveLength(1);
      expect(MockTaskModal.instances[0].opts.mode).toBe("edit");

      const refreshSpy = vi.spyOn(internals(view), "refresh").mockResolvedValue(undefined);
      MockTaskModal.instances[0].opts.onSuccess();
      expect(refreshSpy).toHaveBeenCalled();
    });

  it("dbltap ignores clicks on the edit button", async () => {
      const { view } = await renderDrilledView();
      doubleTap(editBtnIn(cardFor(view, "child")));
      expect(internals(view).drillPath).toHaveLength(2);
    });

  it("dbltap drills one level further into the tapped task's own children", async () => {
      const { view } = await renderDrilledView();
      doubleTap(cardFor(view, "child").querySelector(".pm-node-title")!);
      const drillPath = internals(view).drillPath as unknown[];
      expect(drillPath).toHaveLength(3);
      expect(levelTitle(view)).toBe("Child task");
    });

  it("two taps far apart in time stay two taps", async () => {
      const { view } = await renderDrilledView();
      const title = cardFor(view, "child").querySelector(".pm-node-title")!;
      tap(title, { at: 0 });
      tap(title, { at: 5000 });
      expect(internals(view).drillPath).toHaveLength(2);
    });
  });

  it("'Add subtask' from the task context menu opens a create-mode TaskModal", async () => {
    const proj = makeProject({ id: "p1" });
    mockLoadVaultData.mockResolvedValue({ projects: [proj], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const { view } = makeView();
    await view.onOpen();
    internals(view).openTaskContextMenu(new MouseEvent("contextmenu"), internals(view).tasks[0]);
    const menu = MockMenu.instances[0];
    menu.items[0]._onClick!();
    expect(MockTaskModal.instances).toHaveLength(1);
    expect(MockTaskModal.instances[0].opts.mode).toBe("create");

    const refreshSpy = vi.spyOn(internals(view), "refresh").mockResolvedValue(undefined);
    MockTaskModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("'Move task…' offers the live projects only, archived being nowhere to move to", async () => {
    const proj = makeProject({ id: "p1" });
    const archived = makeProject({ id: "p2", archived: true });
    mockLoadVaultData.mockResolvedValue({
      projects: [proj, archived],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await view.onOpen();
    internals(view).openTaskContextMenu(new MouseEvent("contextmenu"), internals(view).tasks[0]);
    MockMenu.instances[0].item("Move task…")._onClick!();
    expect(mockOpenMoveTaskModal.mock.calls[0][2]).toEqual([proj]);
  });

  it("'Add subtask' does nothing when the task's project can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    const orphanTask = makeTask({ id: "orphan", projectId: "missing" });
    internals(view).openTaskContextMenu(new MouseEvent("contextmenu"), orphanTask);
    const menu = MockMenu.instances[0];
    menu.items[0]._onClick!();
    expect(MockTaskModal.instances).toHaveLength(0);
  });

  it("'Delete task' prompts and deletes on confirm (leaf task, no parent)", async () => {
    const task = makeTask({ id: "t1", title: "Leaf" });
    const { view } = makeView();
    await view.onOpen();
    internals(view).tasks = [task];
    internals(view).openTaskContextMenu(new MouseEvent("contextmenu"), task);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    expect(mockConfirmAction.calls[0].message).toBe('Delete "Leaf"?');
    mockConfirmAction.calls[0].onConfirm();
    await Promise.resolve();
    expect(mockDeleteTaskFile).toHaveBeenCalledWith(expect.anything(), task, undefined, [task]);
  });

  it("'Delete task' pluralizes the subtask count for multiple descendants", async () => {
    const parent = makeTask({ id: "p1", title: "Parent" });
    const child1 = makeTask({ id: "c1", parentId: "p1" });
    const child2 = makeTask({ id: "c2", parentId: "p1" });
    const { view } = makeView();
    await view.onOpen();
    internals(view).tasks = [parent, child1, child2];
    internals(view).openTaskContextMenu(new MouseEvent("contextmenu"), parent);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    expect(mockConfirmAction.calls[0].message).toBe('Delete "Parent" and its 2 subtasks?');
  });

  it("'Delete task' uses the singular 'subtask' for exactly one descendant", async () => {
    const parent = makeTask({ id: "p1", title: "Parent" });
    const child = makeTask({ id: "c1", parentId: "p1" });
    const { view } = makeView();
    await view.onOpen();
    internals(view).tasks = [parent, child];
    internals(view).openTaskContextMenu(new MouseEvent("contextmenu"), parent);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    expect(mockConfirmAction.calls[0].message).toBe('Delete "Parent" and its 1 subtask?');
  });

  it("'Delete task' resolves and passes the parent task when the task has a parentId", async () => {
    const parent = makeTask({ id: "p1", title: "Parent" });
    const child = makeTask({ id: "c1", parentId: "p1", title: "Child" });
    const { view } = makeView();
    await view.onOpen();
    internals(view).tasks = [parent, child];
    internals(view).openTaskContextMenu(new MouseEvent("contextmenu"), child);
    const menu = MockMenu.instances[0];
    menu.item("Delete task")._onClick!();
    mockConfirmAction.calls[0].onConfirm();
    await Promise.resolve();
    expect(mockDeleteTaskFile).toHaveBeenCalledWith(expect.anything(), child, parent, [parent, child]);
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

  it("gives a finger a card's worth of slack before a tap becomes a drag", async () => {
    const app = makeApp();
    const task = makeTask({ id: "t1", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [task] });
    const { view } = makeView(app);
    const fm = noteFor(app, task);
    await openProject(view);
    const title = cardFor(view, "t1").querySelector(".pm-node-title")!;

    drag(title, 20, 0, { pointerType: "touch", at: 0 });
    await Promise.resolve();
    expect(fm.cardLayout).toBeUndefined();

    drag(title, 30, 0, { pointerType: "touch", at: 5000 });
    await Promise.resolve();
    expect(fm.cardLayout).toBeDefined();
  });

  it("keeps a press on a card's own controls from dragging the card", async () => {
    const app = makeApp();
    const task = makeTask({ id: "t1", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [task] });
    const { view } = makeView(app);
    const fm = noteFor(app, task);
    await openProject(view);
    const card = cardFor(view, "t1");
    // Spaced out in time, since two presses in a row on one card would read as a double tap.
    const controls = ["pm-node-ribbon", "pm-node-status", "pm-node-connect-btn", "pm-node-edit-btn"];
    controls.forEach((cls, i) => drag(card.querySelector(`.${cls}`)!, 200, 200, { at: i * 1000 }));
    await Promise.resolve();
    expect(fm.cardLayout).toBeUndefined();

    // The card's plain body still drags it.
    drag(card.querySelector(".pm-node-title")!, 200, 200, { at: 9000 });
    await Promise.resolve();
    expect(fm.cardLayout).toBeDefined();
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
    options[1].onSelect(); // "critical"
    await Promise.resolve();
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
    options[0].onSelect();
    await Promise.resolve();
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
    bagOf(btn).releasePointerCapture = vi.fn();
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);
    expect(document.querySelector(".pm-drag-line-overlay")).not.toBeNull();
    internals(view).cancelDragConnect();
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
    bagOf(btn).releasePointerCapture = vi.fn();
    container.dispatchEvent(evt);
    expect(card.classList.contains("pm-connect-source")).toBe(true);
    internals(view).cancelDragConnect();
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
    await openProject(view);
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
    bagOf(srcBtn).releasePointerCapture = vi.fn();
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
    bagOf(srcBtn).releasePointerCapture = vi.fn();
    container.dispatchEvent(down);
    document.dispatchEvent(new PointerEvent("pointercancel"));
    expect(document.querySelector(".pm-drag-line-overlay")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drag onto another card to move a task
// ---------------------------------------------------------------------------

describe("drag to move", () => {
  /** The node one task's card was drawn as. Reached through the renderer's own list, which
   *  is where the positions a drop is judged against live. */
  function nodeFor(view: TaskGraphView, taskId: string): GraphNode {
    const nodes = bagOf(internals(view).graph!).nodes as GraphNode[];
    const node = nodes.find((n) => n instanceof TaskNode && !n.isExternal && n.taskId === taskId);
    if (!node) throw new Error(`no node drawn for task ${taskId}`);
    return node;
  }

  /** Drags one card until its centre sits on another's, which is what asks for a move. */
  function dropCardOn(view: TaskGraphView, fromId: string, toId: string): void {
    const from = nodeFor(view, fromId).position;
    const to = nodeFor(view, toId).position;
    drag(cardFor(view, fromId).querySelector(".pm-node-title")!, to.x - from.x, to.y - from.y);
  }

  async function twoRootTasks() {
    const project = makeProject({ id: "p1" });
    const a = makeTask({ id: "a", projectId: "p1", title: "A" });
    const b = makeTask({ id: "b", projectId: "p1", title: "B" });
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [a, b] });
    const app = makeApp();
    const { view, plugin } = makeView(app);
    const notes = new Map([a, b].map((t) => [t.id, noteFor(app, t)]));
    await openProject(view);
    return { view, plugin, project, a, b, notes };
  }

  it("asks before moving a task dropped on another card", async () => {
    const { view, project, a, b } = await twoRootTasks();
    dropCardOn(view, "a", "b");

    const confirm = mockConfirmAction.calls.at(-1)!;
    expect(confirm.message).toBe('Move "A" under "B"?');
    expect(confirm.cta).toEqual({ label: "Move", style: ConfirmStyle.Cta });
    expect(mockApplyTaskMove).not.toHaveBeenCalled();

    confirm.onConfirm();
    expect(mockApplyTaskMove).toHaveBeenCalledWith(
      expect.anything(),
      a,
      {
        projectId: project.id,
        projectFilePath: project.filePath,
        projectTitle: project.title,
        parentTask: b,
      },
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("leaves the card where it was rather than saving the travel as a place", async () => {
    const { view, notes } = await twoRootTasks();
    const before = nodeFor(view, "a").position;
    dropCardOn(view, "a", "b");
    expect(notes.get("a")!.cardLayout).toBeUndefined();
    expect(nodeFor(view, "a").position).toEqual(before);
  });

  describe("dropped on a breadcrumb entry", () => {
    /** The trail above the graph, laid out where a drag can reach it. jsdom measures
     *  nothing, so each entry's box has to be spelled out. */
    function placeBreadcrumb(view: TaskGraphView): HTMLElement[] {
      const items = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-breadcrumb-item")];
      items.forEach((item, i) => {
        const left = i * 100;
        item.getBoundingClientRect = () => ({
          left, right: left + 80, top: -40, bottom: -20,
          width: 80, height: 20, x: left, y: -40, toJSON: () => ({}),
        });
      });
      return items;
    }

    async function drilledTwoDeep() {
      const project = makeProject({ id: "p1", title: "Project" });
      const gp = makeTask({ id: "gp", projectId: "p1", title: "Grandparent" });
      const parent = makeTask({ id: "parent", projectId: "p1", parentId: "gp", title: "Parent" });
      const child = makeTask({ id: "child", projectId: "p1", parentId: "parent", title: "Child" });
      mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [gp, parent, child] });
      const app = makeApp();
      const { view, plugin } = makeView(app);
      await view.onOpen();
      internals(view).drillPath = [project, gp, parent];
      internals(view).renderGraph();
      return { view, plugin, app, project, gp, parent, child };
    }

    /** Drags a card up onto the trail, the one direction covering a card can't express. */
    function dropOnBreadcrumb(view: TaskGraphView, taskId: string, entry: HTMLElement): void {
      const box = entry.getBoundingClientRect();
      drag(cardFor(view, taskId).querySelector(".pm-node-title")!, box.left + 10, box.top + 10);
    }

  it("moves the task under the task an entry names", async () => {
      const { view, project } = await drilledTwoDeep();
      const [, , gpItem] = placeBreadcrumb(view);

      dropOnBreadcrumb(view, "child", gpItem);

      const confirm = mockConfirmAction.calls.at(-1)!;
      expect(confirm.message).toBe('Move "Child" under "Grandparent"?');
      confirm.onConfirm();
      const [, moved, destination] = mockApplyTaskMove.mock.calls[0];
      expect(moved.id).toBe("child");
      expect(destination.parentTask?.id).toBe("gp");
      expect(destination.projectId).toBe(project.id);
    });

  it("moves it to the project's root when the entry is the project", async () => {
      const { view, project, child } = await drilledTwoDeep();
      const [, projectItem] = placeBreadcrumb(view);

      dropOnBreadcrumb(view, "child", projectItem);

      const confirm = mockConfirmAction.calls.at(-1)!;
      expect(confirm.message).toBe('Move "Child" to the root of "Project"?');
      confirm.onConfirm();
      expect(mockApplyTaskMove).toHaveBeenCalledWith(
        expect.anything(),
        child,
        expect.objectContaining({ projectId: project.id, parentTask: undefined }),
        expect.anything(),
        expect.anything(),
        expect.any(Function),
      );
    });

  it("leaves the level being looked at out of the trail entirely", async () => {
      // It is named by the frame the cards are drawn in, and a drop on it would only ever
      // be refused: the task is already there.
      const { view } = await drilledTwoDeep();
      const items = placeBreadcrumb(view);

      expect(items.map((i) => i.textContent)).toEqual(["All", "Project", "Grandparent"]);
      expect(levelTitle(view)).toBe("Parent");
    });

  it("takes no drop on 'All', which names no destination", async () => {
      const { view } = await drilledTwoDeep();
      const [allItem] = placeBreadcrumb(view);
      expect(allItem.dataset.drillIndex).toBeUndefined();

      dropOnBreadcrumb(view, "child", allItem);

      expect(mockConfirmAction.calls).toHaveLength(0);
    });

  it("marks the entry a drop would land on while the card is over it", async () => {
      const { view } = await drilledTwoDeep();
      const [, , gpItem] = placeBreadcrumb(view);
      const box = gpItem.getBoundingClientRect();
      const title = cardFor(view, "child").querySelector(".pm-node-title")!;

      pressOn(title, { clientX: 0, clientY: 0 });
      documentPointer(title, "pointermove", { clientX: box.left + 10, clientY: box.top + 10 });
      // Its own mark, not the cards' — a dashed card outline round a line of text would
      // read as an accident.
      expect(gpItem.classList.contains("pm-breadcrumb-item--drop")).toBe(true);

      documentPointer(title, "pointerup", { clientX: box.left + 10, clientY: box.top + 10 });
      expect(gpItem.classList.contains("pm-breadcrumb-item--drop")).toBe(false);
    });

  it("leaves the card where it was rather than saving where the gesture ended", async () => {
      const { view, app } = await drilledTwoDeep();
      const [, , gpItem] = placeBreadcrumb(view);

      dropOnBreadcrumb(view, "child", gpItem);

      expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

  it("takes no drop from a card standing for a task outside the level", async () => {
      const project = makeProject({ id: "p1", title: "Project" });
      mockLoadVaultData.mockResolvedValue({
        projects: [project, makeProject({ id: "p2" })],
        tasks: [
          makeTask({ id: "gp", projectId: "p1", title: "Grandparent" }),
          makeTask({ id: "kid", projectId: "p1", parentId: "gp", dependencies: ["out"] }),
          makeTask({ id: "out", projectId: "p2", title: "Outside" }),
        ],
      });
      const { view } = makeView();
      await view.onOpen();
      internals(view).drillPath = [project, makeTask({ id: "gp", projectId: "p1", title: "Grandparent" })];
      internals(view).renderGraph();
      const [, projectItem] = placeBreadcrumb(view);
      const external = view.contentEl.querySelector<HTMLElement>(".pm-node-card--external")!;
      const box = projectItem.getBoundingClientRect();

      drag(external.querySelector(".pm-node-title")!, box.left + 10, box.top + 10);

      expect(mockConfirmAction.calls).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// addDependency / removeDependency
// ---------------------------------------------------------------------------

describe("addDependency / removeDependency", () => {
  it("does nothing when the target task can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    await internals(view).addDependency("src", "missing-target");
    expect(mockAddTaskDependency).not.toHaveBeenCalled();
  });

  it("shows a Notice and does not add when the dependency would be invalid", async () => {
    const source = makeTask({ id: "src" });
    const target = makeTask({ id: "tgt", parentId: "src" });
    const { view } = makeView();
    await view.onOpen();
    internals(view).tasks = [source, target];
    await internals(view).addDependency("src", "tgt");
    expect(MockNotice.instances.length).toBeGreaterThan(0);
    expect(mockAddTaskDependency).not.toHaveBeenCalled();
  });

  it("adds a valid dependency and refreshes", async () => {
    const source = makeTask({ id: "src" });
    const target = makeTask({ id: "tgt" });
    const { view } = makeView();
    await view.onOpen();
    internals(view).tasks = [source, target];
    await internals(view).addDependency("src", "tgt");
    expect(mockAddTaskDependency).toHaveBeenCalledWith(expect.anything(), target, "src");
  });

  it("removes a dependency and refreshes", async () => {
    const target = makeTask({ id: "tgt" });
    const { view } = makeView();
    await view.onOpen();
    internals(view).tasks = [target];
    internals(view).removeDependency("src", "tgt", true);
    mockConfirmAction.calls.at(-1)!.onConfirm();
    expect(mockRemoveTaskDependency).toHaveBeenCalledWith(expect.anything(), target, "src");
  });

  it("does nothing removing a dependency when the target can't be found", async () => {
    const { view } = makeView();
    await view.onOpen();
    internals(view).removeDependency("src", "missing", true);
    expect(mockConfirmAction.calls).toHaveLength(0);
    expect(mockRemoveTaskDependency).not.toHaveBeenCalled();
  });

  it("offers to remove a dependency on right-click of its edge", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1" }),
        makeTask({ id: "t2", projectId: "p1", dependencies: ["t1"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);

    const hits = edgeHitLines(view);
    expect(hits).toHaveLength(1);
    hits[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(MockMenu.instances).toHaveLength(1);
    MockMenu.instances[0].items[0]._onClick!();
    expect(mockConfirmAction.calls.at(-1)!.message).toBe('Remove the dependency on "A task"?');
    mockConfirmAction.calls.at(-1)!.onConfirm();
    await Promise.resolve();
    expect(mockRemoveTaskDependency).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "t2" }), "t1");
  });

  it("removes a dependency without asking when the confirmation is off", async () => {
    const target = makeTask({ id: "tgt" });
    const { view } = makeView(makeApp(), makePlugin({ confirmDependencyRemoval: false }));
    await view.onOpen();
    internals(view).tasks = [target];
    internals(view).removeDependency("src", "tgt", true);
    expect(mockConfirmAction.calls.at(-1)!.required).toBe(false);
  });

  it("keeps the empty-space add-task menu from following an edge right-click", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1" }),
        makeTask({ id: "t2", projectId: "p1", dependencies: ["t1"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);
    edgeHitLines(view)[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(MockMenu.instances).toHaveLength(1);
    expect(MockMenu.instances[0].items[0]._title).toBe("Remove dependency");
  });
});

// ---------------------------------------------------------------------------
// Dependencies held below the level being drawn
// ---------------------------------------------------------------------------

describe("indirect dependencies", () => {
  /** `t1` and `t2` at the root of p1, with a child of `t2` waiting on `t1`. */
  function nestedDependency() {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "One" }),
        makeTask({ id: "t2", projectId: "p1", title: "Two" }),
        makeTask({ id: "kid", projectId: "p1", title: "Kid", parentId: "t2", dependencies: ["t1"] }),
      ],
    });
  }

  it("draws a dashed edge between the cards a buried dependency lifts to", async () => {
    nestedDependency();
    const { view } = makeView();
    await openProject(view);

    const edges = [...view.contentEl.querySelectorAll(".pm-graph-edge")];
    expect(edges).toHaveLength(1);
    expect(edges[0].classList.contains("pm-graph-edge--lifted")).toBe(true);
  });

  it("draws a dependency between two cards of the level solid", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1" }),
        makeTask({ id: "t2", projectId: "p1", dependencies: ["t1"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);

    const edges = [...view.contentEl.querySelectorAll(".pm-graph-edge")];
    expect(edges).toHaveLength(1);
    expect(edges[0].classList.contains("pm-graph-edge--lifted")).toBe(false);
  });

  it("names the real dependency in the menu a lifted edge opens", async () => {
    nestedDependency();
    const { view } = makeView();
    await openProject(view);

    edgeHitLines(view)[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(MockMenu.instances[0].items[0]._title).toBe('Remove: "One" → "Kid"');
  });

  it("removes the buried dependency the lifted edge stands for", async () => {
    nestedDependency();
    const { view } = makeView();
    await openProject(view);

    edgeHitLines(view)[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    MockMenu.instances[0].items[0]._onClick!();
    // Both ends, as the menu entry named them: the lifted edge may stand for several links.
    expect(mockConfirmAction.calls.at(-1)!.message)
      .toBe('Remove the dependency of "Kid" on "One"?');
    mockConfirmAction.calls.at(-1)!.onConfirm();
    await Promise.resolve();

    expect(mockRemoveTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "kid" }), "t1",
    );
  });

  it("offers one item per dependency lifting onto the same pair of cards", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "One" }),
        makeTask({ id: "t2", projectId: "p1", title: "Two" }),
        makeTask({ id: "kidA", projectId: "p1", title: "A", parentId: "t2", dependencies: ["t1"] }),
        makeTask({ id: "kidB", projectId: "p1", title: "B", parentId: "t2", dependencies: ["t1"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);

    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(1);
    edgeHitLines(view)[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(MockMenu.instances[0].items.map((i) => i._title)).toEqual([
      'Remove: "One" → "A"',
      'Remove: "One" → "B"',
    ]);
  });

  it("draws the prerequisite as a card of its own where it isn't on the level", async () => {
    nestedDependency();
    const { view } = makeView();
    await view.onOpen();
    // Drilled into t2: `kid` is drawn, and `t1`, which it waits on, lives elsewhere.
    await view.openTask("p1", "kid");

    expect(cardFor(view, "kid")).toBeTruthy();
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tasks outside the level, at either end of a dependency
// ---------------------------------------------------------------------------

describe("tasks outside the level", () => {
  /** `p1`'s only task waits on a task of `p2` — a dependency reaching out of the level. */
  function crossProjectDependency() {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "Mine", dependencies: ["other"] }),
        makeTask({ id: "other", projectId: "p2", title: "Theirs" }),
      ],
    });
  }

  /** The dotted cards: tasks the level meets through a dependency but doesn't hold. */
  function externalCards(view: TaskGraphView): HTMLElement[] {
    return [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-card--external")];
  }

  it("draws a card for a prerequisite the level doesn't hold", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);

    const cards = externalCards(view);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".pm-node-title")!.textContent).toBe("Theirs");
  });

  it("gives an outside card no action buttons, nothing on it being ours to act on", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);

    const card = externalCards(view)[0];
    expect(card.querySelector(".pm-node-edit-btn")).toBeNull();
    expect(card.querySelector(".pm-node-connect-btn")).toBeNull();
    // The level's own cards still carry both.
    expect(cardFor(view, "t1").querySelector(".pm-node-edit-btn")).not.toBeNull();
    expect(cardFor(view, "t1").querySelector(".pm-node-connect-btn")).not.toBeNull();
  });

  it("draws a prerequisite left of the card waiting on it", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);

    const external = externalCards(view)[0].parentElement!;
    const waiting = cardFor(view, "t1").parentElement!;
    expect(parseFloat(external.style.left)).toBeLessThan(parseFloat(waiting.style.left));
  });

  it("draws a card for a task outside the level waiting on one of its own", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view, "p2");

    const cards = externalCards(view);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".pm-node-title")!.textContent).toBe("Mine");
  });

  it("draws a waiting task right of the card it waits on", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view, "p2");

    const external = externalCards(view)[0].parentElement!;
    const waitedOn = cardFor(view, "other").parentElement!;
    expect(parseFloat(external.style.left)).toBeGreaterThan(parseFloat(waitedOn.style.left));
  });

  it("draws one card for a task the level both waits on and is waited on by", async () => {
    // `out` waits on `a` and `b` waits on `out`: one card, two arrows, one chain.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2" })],
      tasks: [
        makeTask({ id: "a", projectId: "p1" }),
        makeTask({ id: "b", projectId: "p1", dependencies: ["out"] }),
        makeTask({ id: "out", projectId: "p2", dependencies: ["a"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);

    expect(externalCards(view)).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(2);
  });

  it("draws one card however many of the level's tasks wait on it", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", dependencies: ["other"] }),
        makeTask({ id: "t2", projectId: "p1", dependencies: ["other"] }),
        makeTask({ id: "other", projectId: "p2" }),
      ],
    });
    const { view } = makeView();
    await openProject(view);

    expect(externalCards(view)).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(2);
  });

  it("brings one in for a drilled-in graph too", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1" }),
        makeTask({ id: "kid", projectId: "p1", parentId: "t1", dependencies: ["other"] }),
        makeTask({ id: "other", projectId: "p2", title: "Theirs" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "kid");

    const cards = externalCards(view);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".pm-node-title")!.textContent).toBe("Theirs");
  });

  it("leaves the task's own card alone at the level it belongs to", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view, "p2");

    const drawn = [...view.contentEl.querySelectorAll<HTMLElement>('.pm-node-card[data-task-id="other"]')];
    expect(drawn).toHaveLength(1);
    expect(drawn[0].classList.contains("pm-node-card--external")).toBe(false);
  });

  it("draws none for a prerequisite the active-only filter is holding back", async () => {
    // "done1" is a card of this very level, just filtered out: the filter hides it rather
    // than standing it back up as an outsider.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "done1", projectId: "p1", title: "Done", status: "done" }),
        makeTask({ id: "t2", projectId: "p1", title: "Two", dependencies: ["done1"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);

    expect(externalCards(view)).toHaveLength(0);
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(0);
  });

  it("draws none for one the filter is holding back in a drilled-in graph either", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1" }),
        makeTask({ id: "kidA", projectId: "p1", parentId: "t1", status: "done" }),
        makeTask({ id: "kidB", projectId: "p1", parentId: "t1", dependencies: ["kidA"] }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "kidB");

    expect(externalCards(view)).toHaveLength(0);
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(0);
  });

  it("opens no menu on a right-click of one", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);

    externalCards(view)[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(MockMenu.instances).toHaveLength(0);
  });

  it("names no task anywhere on it, which is what leaves it inert", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);

    // Every gesture reaches a task through this attribute; a card carrying none can be
    // pressed anywhere and asks nothing of the vault.
    const card = externalCards(view)[0];
    expect(card.dataset.taskId).toBeUndefined();
    expect(card.querySelectorAll("[data-task-id]")).toHaveLength(0);
  });

  it("opens no picker on a press of its ribbon or its status", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);
    const card = externalCards(view)[0];

    tap(card.querySelector(".pm-node-ribbon")!);
    tap(card.querySelector(".pm-node-status")!);

    expect(mockOpenDropdown).not.toHaveBeenCalled();
  });

  it("selects nothing on a tap: the selection belongs to the card the task lives on", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);
    const selectSpy = vi.spyOn(view, "selectGraphNode");

    tap(externalCards(view)[0].querySelector(".pm-node-title")!);

    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("never takes a connect drag, having no dependency of ours to be given", async () => {
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view);
    const external = externalCards(view)[0];
    const btn = cardFor(view, "t1").querySelector<HTMLElement>(".pm-node-connect-btn")!;
    const down = pointerEvent("pointerdown", { pointerId: 1 });
    Object.defineProperty(down, "target", { value: btn, configurable: true });
    bagOf(btn).releasePointerCapture = vi.fn();
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(down);

    vi.spyOn(document, "elementFromPoint").mockReturnValue(external);
    document.dispatchEvent(pointerEvent("pointermove", { clientX: 5, clientY: 5 }));
    expect(external.classList.contains("pm-connect-target")).toBe(false);

    document.dispatchEvent(pointerEvent("pointerup", { clientX: 5, clientY: 5 }));
    await Promise.resolve();
    expect(mockAddTaskDependency).not.toHaveBeenCalled();
  });

  it("starts a connect drag from the level's own card, not the dotted one", async () => {
    // Only the level's own card names the task, so that is where the line starts.
    crossProjectDependency();
    const { view } = makeView();
    await openProject(view, "p2");
    const own = cardFor(view, "other");

    const btn = own.querySelector<HTMLElement>(".pm-node-connect-btn")!;
    const evt = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 });
    Object.defineProperty(evt, "target", { value: btn, configurable: true });
    bagOf(btn).releasePointerCapture = vi.fn();
    view.contentEl.querySelector(".pm-compass-graph-container")!.dispatchEvent(evt);

    expect(own.classList.contains("pm-connect-source")).toBe(true);
    expect(externalCards(view)[0].classList.contains("pm-connect-source")).toBe(false);
    internals(view).cancelDragConnect();
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
    expect(levelTitle(view)).toBe("Alpha");
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
    expect(levelTitle(view)).toBe("Mid");
  });

  it("falls back to [project] when the parent can't be found", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", parentId: "missing-parent" })],
    });
    const { view } = makeView();
    await view.onOpen();
    await view.openTask("p1", "t1");
    expect(levelTitle(view)).toBe("Alpha");
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
  async function renderSection(tasks = [makeTask({ id: "t1", projectId: "p1" })], project = makeProject({ id: "p1" })) {
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks });
    const app = makeApp();
    const { view, plugin } = makeView(app);
    // Their notes exist, so a gesture that records a card layout has somewhere to write it.
    const notes = new Map(tasks.map((t) => [t.id, noteFor(app, t)]));
    await openProject(view, project.id);
    return { view, plugin, app, notes };
  }

  /** The top of the trail, where a project's own card is drawn. */
  async function renderGrid(project = makeProject({ id: "p1" })) {
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [] });
    const { view, plugin } = makeView();
    await view.onOpen();
    return { view, plugin };
  }

  it("ignores taps on the connect button", async () => {
    const { view } = await renderSection();
    tap(cardFor(view, "t1").querySelector(".pm-node-connect-btn")!);
    expect(MockTaskModal.instances).toHaveLength(0);
  });

  it("selects the node when the tap target isn't the edit button", async () => {
    const { view } = await renderSection();
    const selectSpy = vi.spyOn(view, "selectGraphNode");
    tap(cardFor(view, "t1").querySelector(".pm-node-title")!);
    expect(selectSpy).toHaveBeenCalledWith("t1");
    expect(MockTaskModal.instances).toHaveLength(0);
  });

  it("does nothing on tap when the card's task can't be found in `tasks`", async () => {
    const { view } = await renderSection();
    internals(view).tasks = [];
    tap(editBtnIn(cardFor(view, "t1")));
    expect(MockTaskModal.instances).toHaveLength(0);
  });

  it("opens the note directly on ctrl-click of the edit button", async () => {
    const { view } = await renderSection([makeTask({ id: "t1", projectId: "p1", filePath: "t1.md" })]);
    tap(editBtnIn(cardFor(view, "t1")), { ctrlKey: true });
    expect(mockOpenNoteFile).toHaveBeenCalledWith(expect.anything(), "t1.md");
  });

  it("opens an edit-mode TaskModal on plain edit-button click", async () => {
    const { view } = await renderSection();
    tap(editBtnIn(cardFor(view, "t1")));
    expect(MockTaskModal.instances).toHaveLength(1);
    expect(MockTaskModal.instances[0].opts.mode).toBe("edit");

    const refreshSpy = vi.spyOn(internals(view), "refresh").mockResolvedValue(undefined);
    MockTaskModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("project node: edit-button click opens ProjectModal; ctrl-click opens the note", async () => {
    const { view } = await renderGrid(makeProject({ id: "p1", filePath: "p1.md" }));
    const editBtn = projectCardFor(view, "p1").querySelector<HTMLElement>(".pm-node-edit-btn")!;

    tap(editBtn, { ctrlKey: true, at: 0 });
    expect(mockOpenNoteFile).toHaveBeenCalledWith(expect.anything(), "p1.md");

    tap(editBtn, { at: 5000 });
    expect(MockProjectModal.instances).toHaveLength(1);

    const refreshSpy = vi.spyOn(internals(view), "refresh").mockResolvedValue(undefined);
    MockProjectModal.instances[0].opts.onSuccess();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("project node: edit-button click does nothing when the card's project is no longer known", async () => {
    const { view } = await renderGrid();
    const editBtn = projectCardFor(view, "p1").querySelector<HTMLElement>(".pm-node-edit-btn")!;
    internals(view).projects = [];
    tap(editBtn);
    expect(MockProjectModal.instances).toHaveLength(0);
  });

  it("marks an overdue task in the all-projects section graph", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const { view } = await renderSection([makeTask({ id: "t1", projectId: "p1", due: yesterday, status: "todo" })]);
    expect(cardFor(view, "t1").querySelector<HTMLElement>(".pm-node-due")!.style.color).toBe(asStyle("color", "#ef4444"));
  });

  it("double-tap on a task drills into its subtasks", async () => {
    const { view } = await renderSection([makeTask({ id: "t1", projectId: "p1", title: "Parent" })], makeProject({ id: "p1", title: "Alpha" }));
    doubleTap(cardFor(view, "t1").querySelector(".pm-node-title")!);
    expect(levelTitle(view)).toBe("Parent");
  });

  it("double-tap ignores clicks on the edit button", async () => {
    const { view } = await renderSection();
    const before = view.contentEl.querySelector(".pm-breadcrumb-items")!.textContent;
    doubleTap(editBtnIn(cardFor(view, "t1")));
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.textContent).toBe(before);
  });

  it("writes a card's place onto its own note once a drag ends, and refits around it", async () => {
    const { view, notes } = await renderSection([
      makeTask({ id: "t1", projectId: "p1" }),
      makeTask({ id: "t2", projectId: "p1" }),
    ]);
    const container = internals(view).graphContainer;
    const heightBefore = container.style.height;

    drag(cardFor(view, "t1").querySelector(".pm-node-title")!, 0, 400);
    await Promise.resolve();

    const saved = notes.get("t1")!.cardLayout as { x: number; y: number };
    expect(typeof saved.x).toBe("number");
    expect(typeof saved.y).toBe("number");
    expect(container.style.height).not.toBe(heightBefore);
  });

  it("leaves the note's own fields alone — a card is not an edit of the task", async () => {
    const { view, notes } = await renderSection();
    const fm = notes.get("t1")!;
    fm.updatedAt = "2026-01-01T00:00:00.000Z";

    drag(cardFor(view, "t1").querySelector(".pm-node-title")!, 0, 400);
    await Promise.resolve();

    expect(fm.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("writes a card's size onto its own note once its corner is let go of", async () => {
    const { view, notes } = await renderSection();
    const handle = cardFor(view, "t1").querySelector(".pm-node-resize-handle")!;

    pressOn(handle);
    documentPointer(handle, "pointermove", { clientX: 60, clientY: 30 });
    documentPointer(handle, "pointerup", { clientX: 60, clientY: 30 });
    await Promise.resolve();

    expect(notes.get("t1")!.cardLayout).toEqual({ w: NODE_WIDTH + 60, h: NODE_HEIGHT + 30 });
  });

  it("draws the card at the size the pull has reached, as it is pulled", async () => {
    const { view } = await renderSection();
    const card = cardFor(view, "t1");
    const handle = card.querySelector(".pm-node-resize-handle")!;
    const wrapper = card.closest<HTMLElement>(".pm-graph-node")!;

    pressOn(handle);
    documentPointer(handle, "pointermove", { clientX: 40, clientY: 0 });

    expect(wrapper.style.width).toBe(`${NODE_WIDTH + 40}px`);
    expect(wrapper.classList.contains("pm-graph-node--resizing")).toBe(true);
  });

  it("holds a card between the sizes it may be drawn at", async () => {
    const { view, notes } = await renderSection();
    const handle = cardFor(view, "t1").querySelector(".pm-node-resize-handle")!;

    pressOn(handle);
    documentPointer(handle, "pointermove", { clientX: -900, clientY: -900 });
    documentPointer(handle, "pointerup", { clientX: -900, clientY: -900 });
    await Promise.resolve();

    expect(notes.get("t1")!.cardLayout).toEqual({ w: MIN_CARD_WIDTH, h: MIN_CARD_HEIGHT });
  });

  it("puts a card back at the size the press found it when the pull is cancelled", async () => {
    const { view, notes } = await renderSection();
    const card = cardFor(view, "t1");
    const handle = card.querySelector(".pm-node-resize-handle")!;
    const wrapper = card.closest<HTMLElement>(".pm-graph-node")!;

    pressOn(handle);
    documentPointer(handle, "pointermove", { clientX: 60, clientY: 30 });
    documentPointer(handle, "pointercancel", { clientX: 60, clientY: 30 });
    await Promise.resolve();

    expect(wrapper.style.width).toBe(`${NODE_WIDTH}px`);
    expect(notes.get("t1")!.cardLayout).toBeUndefined();
  });

  it("keeps the place a card already had when only its size changes", async () => {
    const { view, notes } = await renderSection([
      makeTask({ id: "t1", projectId: "p1", card: { x: 500, y: 300 } }),
    ]);
    const handle = cardFor(view, "t1").querySelector(".pm-node-resize-handle")!;

    pressOn(handle);
    documentPointer(handle, "pointermove", { clientX: 40, clientY: 20 });
    documentPointer(handle, "pointerup", { clientX: 40, clientY: 20 });
    await Promise.resolve();

    expect(notes.get("t1")!.cardLayout)
      .toEqual({ x: 500, y: 300, w: NODE_WIDTH + 40, h: NODE_HEIGHT + 20 });
  });

  it("puts a card back where it was when the drag is cancelled", async () => {
    const { view, notes } = await renderSection();
    const title = cardFor(view, "t1").querySelector(".pm-node-title")!;
    const nodeEl = cardFor(view, "t1").closest<HTMLElement>(".pm-graph-node")!;
    const topBefore = nodeEl.style.top;

    pressOn(title);
    documentPointer(title, "pointermove", { clientX: 0, clientY: 400 });
    documentPointer(title, "pointercancel", { clientX: 0, clientY: 400 });

    expect(nodeEl.style.top).toBe(topBefore);
    expect(notes.get("t1")!.cardLayout).toBeUndefined();
  });

  it("starts a card from the place and size its note carries", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", card: { x: 500, y: 300, w: 240, h: 100 } })],
    });
    const { view } = makeView();
    await openProject(view);
    const nodeEl = cardFor(view, "t1").closest<HTMLElement>(".pm-graph-node")!;
    expect(nodeEl.style.left).toBe(`${500 - 120}px`);
    expect(nodeEl.style.top).toBe(`${300 - 50}px`);
    expect(nodeEl.style.width).toBe("240px");
  });
});

describe("drilled task graph (buildElements)", () => {
  // Drills directly by setting drillPath = [project, task] and re-rendering, bypassing
  // openTask()'s own contextual navigation semantics (it shows a task among siblings in
  // its *parent's* context, not drilled past the task itself — see the openTask describe
  // block for that behavior).
  function drillTo(view: TaskGraphView, project: Project, task: Task) {
    internals(view).drillPath = [project, task];
    internals(view).renderGraph();
  }

  it("says so inside the frame when a task has no subtasks", async () => {
    const project = makeProject({ id: "p1" });
    const task = makeTask({ id: "t1", projectId: "p1", title: "Lone task" });
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [task] });
    const { view } = makeView();
    await view.onOpen();
    drillTo(view, project, task);
    expect(view.contentEl.querySelector(".pm-graph-container-empty")?.textContent).toBe("No tasks here.");
    expect(levelTitle(view)).toBe("Lone task");
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
    await openProject(view);
    drillTo(view, project, parent);
    // Virtual edges are never drawn, so what's on screen is the dependency alone.
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(1);
  });

  it("filters out a dependency edge whose source isn't in the visible task set", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent", dependencies: ["nonexistent"] })],
    });
    const { view } = makeView();
    await openProject(view);
    drillTo(view, project, parent);
    expect(view.contentEl.querySelectorAll(".pm-graph-edge")).toHaveLength(0);
  });

  it("marks an overdue subtask", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent", due: yesterday, status: "todo" })],
    });
    const { view } = makeView();
    await openProject(view);
    drillTo(view, project, parent);
    expect(cardFor(view, "c1").querySelector<HTMLElement>(".pm-node-due")!.style.color).toBe(asStyle("color", "#ef4444"));
  });

  it("does not mark a done overdue subtask as overdue", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent", due: yesterday, status: "done" })],
    });
    const { view } = makeView(makeApp(), makePlugin({ panelConfig: { showActiveOnly: false } }));
    await openProject(view);
    drillTo(view, project, parent);
    expect(cardFor(view, "c1").querySelector<HTMLElement>(".pm-node-due")!.style.color).toBe("");
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
    await openProject(view);
    drillTo(view, project, parent);
    // The task drilled into is named in the breadcrumb, not drawn: its subtasks alone.
    const cards = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-card")];
    expect(cards.map((c) => c.dataset.taskId)).toEqual(["c1"]);
  });

  it("draws the same cards however narrow the panel is", async () => {
    // No rule sheds anything on a phone any more; a wide graph scrolls sideways instead.
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const { view } = makeView();
    await openProject(view);
    const container = view.contentEl.querySelector(".pm-compass-graph-container") as HTMLElement;
    Object.defineProperty(container, "clientWidth", { value: 300, configurable: true });
    drillTo(view, project, parent);
    const cards = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-card")];
    expect(cards.map((c) => c.dataset.taskId)).toEqual(["c1"]);
  });

  it("selects the pending task once the graph is up, when navigated via openTask", async () => {
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
    expect(cardFor(view, "c1").classList.contains("pm-node-card--selected")).toBe(true);
  });

  it("fits the graph to the room its cards need", async () => {
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
    expect(container.style.height).not.toBe("");
    expect(container.style.minWidth).not.toBe("");
  });

  it("marks a subtask as overdue when its own due date has passed", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent", due: yesterday, status: "todo" })],
    });
    const { view } = makeView();
    await openProject(view);
    drillTo(view, project, parent);
    expect(cardFor(view, "c1").querySelector<HTMLElement>(".pm-node-due")!.style.color).toBe(asStyle("color", "#ef4444"));
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
    tap(projectCardFor(view, "p1"));
    expect(levelTitle(view)).toBe("Alpha");

    mockLoadVaultData.mockResolvedValueOnce({ projects: [], tasks: [] });
    await internals(view).refresh();
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.querySelector(".current")?.textContent).toBe("All");
  });

  it("trims the drill path at the first stale task", async () => {
    const project = makeProject({ id: "p1", title: "Alpha" });
    const t1 = makeTask({ id: "t1", projectId: "p1", title: "T1" });
    const t2 = makeTask({ id: "t2", projectId: "p1", title: "T2", parentId: "t1" });
    mockLoadVaultData.mockResolvedValueOnce({ projects: [project], tasks: [t1, t2] });
    const { view } = makeView();
    await view.onOpen();
    internals(view).drillPath = [project, t1, t2];
    internals(view).renderGraph();
    expect(levelTitle(view)).toBe("T2");

    mockLoadVaultData.mockResolvedValueOnce({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", title: "T1" })],
    });
    await internals(view).refresh();
    expect(levelTitle(view)).toBe("T1");
    expect(view.contentEl.querySelector(".pm-breadcrumb-items")!.textContent).not.toContain("T2");
  });

  it("does not trim a drilled task missing from the parsed list if its file still exists (metadataCache lag)", async () => {
    const project = makeProject({ id: "p1", title: "Alpha" });
    const t1 = makeTask({ id: "t1", projectId: "p1", title: "T1" });
    const t2 = makeTask({ id: "t2", projectId: "p1", title: "T2", parentId: "t1" });
    mockLoadVaultData.mockResolvedValueOnce({ projects: [project], tasks: [t1, t2] });
    const { view, app } = makeView();
    await view.onOpen();
    internals(view).drillPath = [project, t1, t2];
    internals(view).renderGraph();

    // t2 (the drilled-in "context" task) is momentarily absent from the freshly parsed task
    // list — as if its own file was just written and metadataCache hasn't reparsed it yet —
    // but its file is still on disk.
    mockLoadVaultData.mockResolvedValueOnce({ projects: [project], tasks: [t1] });
    app.vault.getAbstractFileByPath
      .mockImplementation((path: string) => (path === t2.filePath ? new MockTFile(path) : null));

    await internals(view).refresh();
    expect(levelTitle(view)).toBe("T2");
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
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores a metadata change outside the projects folder", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined);
    app.metadataCache._emit("changed", { path: "Elsewhere/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("schedules a refresh on delete inside the projects folder, debouncing repeated calls", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined);
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
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined);
    app.vault._emit("delete", { path: "Elsewhere/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not rebuild the graph while the view is hidden", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined);
    hide(view.containerEl);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rebuilds the graph once the view is shown again", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined);
    hide(view.containerEl);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    app.metadataCache._emit("changed", { path: "Projects/y.md" });
    vi.advanceTimersByTime(300);

    show(view.containerEl);
    app.workspace._emit("active-leaf-change");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("treats a collapsed sidebar hiding an ancestor as hidden, and rebuilds when it expands", async () => {
    vi.useFakeTimers();
    const { view, app } = makeView();
    await view.onOpen();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never).mockResolvedValue(undefined);
    const sidedock = document.createElement("div");
    sidedock.appendChild(view.containerEl);
    hide(sidedock);
    app.metadataCache._emit("changed", { path: "Projects/x.md" });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).not.toHaveBeenCalled();

    show(sidedock);
    fireResize();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// onClose
// ---------------------------------------------------------------------------

describe("TaskGraphView.onClose", () => {
  it("takes the panel's drawing down with it", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" }), makeProject({ id: "p2" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await openProject(view);
    expect(view.contentEl.querySelectorAll(".pm-graph-nodes").length).toBe(1);

    await view.onClose();
    expect(view.contentEl.querySelectorAll(".pm-graph-nodes")).toHaveLength(0);
    expect(internals(view).graph).toBeNull();
  });

  it("takes the drilled-in graph down and stops listening for its drags", async () => {
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    mockLoadVaultData.mockResolvedValue({
      projects: [project],
      tasks: [parent, makeTask({ id: "c1", projectId: "p1", parentId: "parent" })],
    });
    const app = makeApp();
    const { view } = makeView(app);
    await view.onOpen();
    internals(view).drillPath = [project, parent];
    internals(view).renderGraph();
    const card = cardFor(view, "c1").querySelector(".pm-node-title")!;

    await view.onClose();

    expect(internals(view).graph).toBeNull();
    expect(view.contentEl.querySelectorAll(".pm-graph-nodes")).toHaveLength(0);
    // The card is off the page; a stray gesture on it must not still write a card layout.
    drag(card, 0, 400);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
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
    await openProject(view);
    tap(cardFor(view, "t1").querySelector(".pm-node-title")!);
    expect(app.workspace.getLeavesOfType).toHaveBeenCalledWith("pm-compass-dashboard");
  });

  it("calls selectTask on the dashboard leaf's view when one is open", async () => {
    mockLoadVaultData.mockResolvedValue({ projects: [makeProject({ id: "p1" })], tasks: [makeTask({ id: "t1", projectId: "p1" })] });
    const selectTask = vi.fn().mockReturnValue(true);
    const app = makeApp();
    app.workspace.getLeavesOfType.mockReturnValue([{ view: { selectTask } }]);
    const { view } = makeView(app);
    await openProject(view);
    tap(cardFor(view, "t1").querySelector(".pm-node-title")!);
    expect(selectTask).toHaveBeenCalledWith("t1");
  });
});

// ---------------------------------------------------------------------------
// The project grid, once a card of it has been moved by hand
// ---------------------------------------------------------------------------

describe("moving and resizing a project's card", () => {
  /** The grid, drawn wide enough to hold all three across, with every project's note in
   *  the vault so a card can write its layout onto it. */
  async function renderProjects(projects = ["p1", "p2", "p3"].map((id) => makeProject({ id }))) {
    mockLoadVaultData.mockResolvedValue({ projects, tasks: [] });
    const app = makeApp();
    const { view } = makeView(app);
    const notes = new Map(projects.map((p) => [p.id, noteFor(app, p)]));
    await view.onOpen();
    Object.defineProperty(internals(view).graphContainer, "clientWidth", { value: 1000, configurable: true });
    internals(view).renderGraph();
    return { view, app, notes };
  }

  it("writes the moved project's place onto its own note", async () => {
    const { view, notes } = await renderProjects();

    drag(projectCardFor(view, "p1"), 0, 400);
    await Promise.resolve();

    const saved = notes.get("p1")!.cardLayout as { x: number; y: number };
    expect(typeof saved.x).toBe("number");
    expect(typeof saved.y).toBe("number");
  });

  it("gives every project a place of its own the first time the grid draws it", async () => {
    const { notes } = await renderProjects();
    for (const id of ["p1", "p2", "p3"]) {
      const seeded = notes.get(id)!.cardLayout as { x: number; y: number } | undefined;
      expect([typeof seeded?.x, typeof seeded?.y]).toEqual(["number", "number"]);
    }
  });

  it("seeds nothing while the panel has no width to lay out against", async () => {
    // Drawn off screen the grid files every card into one column, which is not an
    // arrangement worth handing anybody.
    const projects = ["p1", "p2"].map((id) => makeProject({ id }));
    mockLoadVaultData.mockResolvedValue({ projects, tasks: [] });
    const app = makeApp();
    const { view } = makeView(app);
    const notes = new Map(projects.map((p) => [p.id, noteFor(app, p)]));
    Object.defineProperty(internals(view).graphContainer ?? {}, "clientWidth", { value: 0, configurable: true });
    await view.onOpen();

    for (const id of ["p1", "p2"]) expect(notes.get(id)!.cardLayout).toBeUndefined();
  });

  it("moves no other card when one project is dragged", async () => {
    const { view, notes } = await renderProjects();
    const others = ["p2", "p3"].map((id) => ({ ...notes.get(id)!.cardLayout as object }));
    const places = ["p2", "p3"].map((id) => projectCardFor(view, id).parentElement!.style.left);

    drag(projectCardFor(view, "p1"), 0, 400);
    await Promise.resolve();

    // Arranging the projects is the user's; nothing rearranges itself around the one moved.
    expect(["p2", "p3"].map((id) => notes.get(id)!.cardLayout)).toEqual(others);
    expect(["p2", "p3"].map((id) => projectCardFor(view, id).parentElement!.style.left)).toEqual(places);
  });

  it("stops rewrapping to the panel's width once the grid has been taken over", async () => {
    const projects = ["p1", "p2", "p3"].map((id) => makeProject({ id, card: { x: 100 * Number(id[1]), y: 40 } }));
    const { view } = await renderProjects(projects);
    const before = ["p1", "p2", "p3"].map((id) => projectCardFor(view, id).parentElement!.style.left);

    Object.defineProperty(internals(view).graphContainer, "clientWidth", { value: 200, configurable: true });
    view.onResize();

    expect(["p1", "p2", "p3"].map((id) => projectCardFor(view, id).parentElement!.style.left)).toEqual(before);
  });

  it("keeps a project the vault has since gained clear of the pinned ones", async () => {
    // Both sitting where the grid's first two cells are, so a third card placed by the grid
    // would land straight on top of one of them.
    const pinned = [
      makeProject({ id: "p1", card: { x: 80, y: 36 } }),
      makeProject({ id: "p2", card: { x: 264, y: 36 } }),
    ];
    const { view } = await renderProjects([...pinned, makeProject({ id: "p3" })]);
    const boxes = ["p1", "p2", "p3"].map((id) => drawn(view).nodes.find((n) => n.id === `proj-${id}`)!.box);

    // The new card is placed by the grid, then moved clear of whatever was put by hand.
    for (const a of boxes) {
      for (const b of boxes) if (a !== b) expect(a.overlaps(b)).toBe(false);
    }
  });

  it("draws a project's card at the size its note carries", async () => {
    const { view } = await renderProjects([makeProject({ id: "p1", card: { w: 260, h: 120 } })]);
    expect(projectCardFor(view, "p1").parentElement!.style.width).toBe("260px");
  });

  it("writes a resized project's size beside the place it already had", async () => {
    const { view, notes } = await renderProjects();
    const before = notes.get("p1")!.cardLayout as { x: number; y: number };
    const handle = projectCardFor(view, "p1").querySelector(".pm-node-resize-handle")!;

    pressOn(handle);
    documentPointer(handle, "pointermove", { clientX: 40, clientY: 20 });
    documentPointer(handle, "pointerup", { clientX: 40, clientY: 20 });
    await Promise.resolve();

    expect(notes.get("p1")!.cardLayout)
      .toEqual({ x: before.x, y: before.y, w: NODE_WIDTH + 40, h: NODE_HEIGHT + 20 });
  });
});

// ---------------------------------------------------------------------------
// Writing a card layout to the vault
// ---------------------------------------------------------------------------

describe("writing a card layout", () => {
  /** The grid on one project, drawn wide enough to place it, its note sitting where the view
   *  watches for changes. It already carries a place, so nothing is seeded over the top.
   *  `held` says whether the vault still has the note the card would be written to. */
  async function withProject(held: boolean) {
    const project = makeProject({ id: "p1", filePath: "Projects/p1.md", card: { x: 80, y: 36 } });
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [] });
    const app = makeApp();
    const { view } = makeView(app);
    if (held) noteFor(app, project);
    await view.onOpen();
    Object.defineProperty(internals(view).graphContainer, "clientWidth", { value: 1000, configurable: true });
    internals(view).renderGraph();
    return { view, app };
  }

  it("says so when the note it would be written to is gone", async () => {
    // Deleted or renamed since the read the drawing was built from — the arrangement on
    // screen is then one the vault doesn't hold, which is worth hearing about.
    const { view } = await withProject(false);

    drag(projectCardFor(view, "p1"), 0, 400);
    await flush();

    expect(MockNotice.instances.some((m) => m.startsWith("Could not save the card layout"))).toBe(true);
  });

  /** Drags the card, lets the write settle, and hands back how many redraws the events named
   *  ask for. The clock is faked only once the write is done with, so nothing here turns on
   *  how many turns it took. */
  async function redrawsAfterDrag(
    { view, app }: { view: TaskGraphView; app: ReturnType<typeof makeApp> },
    events: number,
  ): Promise<number> {
    drag(projectCardFor(view, "p1"), 0, 400);
    await flush();

    vi.useFakeTimers();
    try {
      const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never)
        .mockResolvedValue(undefined);
      for (let i = 0; i < events; i++) app.metadataCache._emit("changed", { path: "Projects/p1.md" });
      vi.advanceTimersByTime(300);
      return refreshSpy.mock.calls.length;
    } finally {
      vi.useRealTimers();
    }
  }

  it("draws nothing again for the change its own write wakes", async () => {
    // The drawing already sits where the write says; rebuilding the level would only cost
    // it its markup, and the selected card its highlight.
    expect(await redrawsAfterDrag(await withProject(true), 1)).toBe(0);
  });

  it("still draws again for the next real change to the same note", async () => {
    // One event is owed and one only: an edit made anywhere else still reaches the drawing.
    expect(await redrawsAfterDrag(await withProject(true), 2)).toBe(1);
  });

  it("owes nothing for a write that never landed", async () => {
    // No event is coming for a write that threw, so one waiting to be swallowed would take
    // the next genuine edit to that note with it.
    expect(await redrawsAfterDrag(await withProject(false), 1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// forgetMovedPlaces
// ---------------------------------------------------------------------------

describe("a moved task's stored place", () => {
  /** Opens on one vault, then refreshes on another — a move made anywhere looks like this.
   *  Every task starts out dragged somewhere and sized, so both halves can be told apart in
   *  what the notes carry afterwards. */
  async function reloadWith(before: Task[], after: Task[], projects = [makeProject({ id: "p1" })]) {
    const app = makeApp();
    for (const task of [...before, ...after]) task.card = { x: 9, y: 9, w: 200, h: 90 };
    mockLoadVaultData.mockResolvedValue({ projects, tasks: before });
    const { view } = makeView(app);
    const notes = new Map(after.map((t) => [t.id, noteFor(app, t)]));
    await view.onOpen();
    mockLoadVaultData.mockResolvedValue({ projects, tasks: after });
    await internals(view).refresh();
    await Promise.resolve();
    return Object.fromEntries([...notes].map(([id, fm]) => [id, fm.cardLayout]));
  }

  it("is dropped once the task hangs off a different parent", async () => {
    const positions = await reloadWith(
      [makeTask({ id: "parent", projectId: "p1" }), makeTask({ id: "t1", projectId: "p1" })],
      [makeTask({ id: "parent", projectId: "p1" }), makeTask({ id: "t1", projectId: "p1", parentId: "parent" })],
    );
    // Placed among its new siblings by the layout, rather than left where it was dragged
    // among the ones it left. How big it is survives: that is the same question anywhere.
    expect(positions.t1).toEqual({ w: 200, h: 90 });
    expect(positions.parent).toEqual({ x: 9, y: 9, w: 200, h: 90 });
  });

  it("is dropped when a root task lands in another project", async () => {
    const projects = [makeProject({ id: "p1" }), makeProject({ id: "p2" })];
    const positions = await reloadWith(
      [makeTask({ id: "t1", projectId: "p1" })],
      [makeTask({ id: "t1", projectId: "p2" })],
      projects,
    );
    expect(positions.t1).toEqual({ w: 200, h: 90 });
  });

  it("survives a move that took the task's whole parent along", async () => {
    const projects = [makeProject({ id: "p1" }), makeProject({ id: "p2" })];
    // The subtree travels together, so a child is drawn among the same siblings as before.
    const positions = await reloadWith(
      [makeTask({ id: "parent", projectId: "p1" }), makeTask({ id: "t1", projectId: "p1", parentId: "parent" })],
      [makeTask({ id: "parent", projectId: "p2" }), makeTask({ id: "t1", projectId: "p2", parentId: "parent" })],
      projects,
    );
    expect(positions.t1).toEqual({ x: 9, y: 9, w: 200, h: 90 });
    expect(positions.parent).toEqual({ w: 200, h: 90 });
  });

  it("is left alone by a refresh that changed nothing about where the task sits", async () => {
    const positions = await reloadWith(
      [makeTask({ id: "t1", projectId: "p1", title: "Before" })],
      [makeTask({ id: "t1", projectId: "p1", title: "After" })],
    );
    expect(positions.t1).toEqual({ x: 9, y: 9, w: 200, h: 90 });
  });
});

// ---------------------------------------------------------------------------
// Node cards (taskNodeCard / projectNodeCard) — pure element builders
// ---------------------------------------------------------------------------

describe("node cards", () => {
  function buildCard(view: TaskGraphView, name: "taskNodeCard" | "projectNodeCard", data: Record<string, unknown>) {
    const builders = view as unknown as Record<typeof name, (data: Record<string, unknown>) => HTMLElement>;
    return builders[name](data);
  }

  function taskCard(data: Record<string, unknown>) {
    return buildCard(makeView().view, "taskNodeCard", {
      id: "t1", label: "Title", status: "todo", ownStatus: "todo", priorityBackground: "",
      dueLabel: "", isOverdue: false, childCount: 0, ...data,
    });
  }

  it("shows the due label and overdue styling when set", () => {
    const card = taskCard({ priorityBackground: "#f00", dueLabel: "2026-01-01", isOverdue: true, childCount: 2 });
    const due = card.querySelector<HTMLElement>(".pm-node-due")!;
    expect(due.textContent).toBe("2026-01-01");
    expect(due.style.color).toBe("rgb(239, 68, 68)");
    expect(card.querySelector(".pm-node-subtask-row")!.textContent).toContain("2 subtasks");
    expect(card.querySelector<HTMLElement>(".pm-node-ribbon")!.style.background).toBe("rgb(255, 0, 0)");
  });

  it("spells out both statuses when a cancelled parent overrides the task's own", () => {
    const card = taskCard({ status: "cancelled", ownStatus: "todo" });
    expect(card.querySelector(".pm-node-status")!.textContent).toBe("todo / cancelled");
  });

  it("omits the due label when unset and uses the singular 'subtask'", () => {
    const card = taskCard({ childCount: 1 });
    expect(card.querySelector(".pm-node-due")).toBeNull();
    expect(card.querySelector(".pm-node-subtask-row")!.textContent).toContain("1 subtask");
  });

  it("leaves a due label unstyled when it hasn't passed", () => {
    const card = taskCard({ dueLabel: "2026-12-31", isOverdue: false });
    expect(card.querySelector<HTMLElement>(".pm-node-due")!.style.color).toBe("");
  });

  it("omits the subtask row at zero, and names the task over the node's own id", () => {
    const card = taskCard({ id: "internal-id", taskId: "t1" });
    expect(card.querySelector(".pm-node-subtask-row")).toBeNull();
    expect(card.dataset.taskId).toBe("t1");
    // The controls carry it too — a tap on one resolves the task through them.
    expect(card.querySelector<HTMLElement>(".pm-node-edit-btn")!.dataset.taskId).toBe("t1");
  });

  it("warns about a completed task with unfinished subtasks", () => {
    const card = taskCard({ status: "done", ownStatus: "done", childCount: 1, warnSubtasks: true });
    expect(card.querySelector(".pm-node-warn")!.getAttribute("title"))
      .toBe("Completed, but has unfinished subtasks");
  });

  it("warns about an open task under a completed parent", () => {
    const card = taskCard({ warnParentDone: true });
    expect(card.querySelector(".pm-node-warn")!.getAttribute("title"))
      .toBe("Still open, but its parent task is completed");
  });

  it("leaves both warnings off a card that has neither problem", () => {
    expect(taskCard({}).querySelector(".pm-node-warn")).toBeNull();
  });

  it("prints a title as text, so a wiki link reads as its display name", () => {
    const card = taskCard({ label: "[[page|Shown]] <b>x</b>" });
    expect(card.querySelector(".pm-node-title")!.textContent).toBe("Shown <b>x</b>");
    expect(card.querySelector("b")).toBeNull();
  });

  it("renders the project id and colour on a project card", () => {
    const card = buildCard(makeView().view, "projectNodeCard", { projId: "p1", label: "Alpha", color: "#123456" });
    expect(card.dataset.projId).toBe("p1");
    expect(card.style.color).toBe("rgb(18, 52, 86)");
    expect(card.querySelector(".pm-node-project-title")!.textContent).toBe("Alpha");
    expect(card.querySelector<HTMLElement>(".pm-node-edit-btn")!.dataset.projId).toBe("p1");
  });

  it("handles a project card with no id gracefully", () => {
    const card = buildCard(makeView().view, "projectNodeCard", { label: "Alpha", color: "#123456" });
    expect(card.dataset.projId).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("the cards each level draws", () => {
  it("draws the project cards at the top, and no task", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", status: "todo" })],
    });
    const { view } = makeView();
    await view.onOpen();

    expect(view.contentEl.querySelectorAll(".pm-node-project-card")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".pm-node-card")).toHaveLength(0);
  });

  it("draws a project's root tasks one step in, and no project card", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", status: "todo" })],
    });
    const { view } = makeView();
    await openProject(view);

    expect(view.contentEl.querySelectorAll(".pm-node-project-card")).toHaveLength(0);
    const cards = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-card")];
    expect(cards.map((c) => c.dataset.taskId)).toEqual(["t1"]);
  });

  it("draws a task's children further in, and not the task itself", async () => {
    // The task drilled into is named in the breadcrumb; a card for it would say it twice.
    const project = makeProject({ id: "p1" });
    const parent = makeTask({ id: "parent", projectId: "p1" });
    const child = makeTask({ id: "child", projectId: "p1", parentId: "parent" });
    mockLoadVaultData.mockResolvedValue({ projects: [project], tasks: [parent, child] });
    const { view } = makeView();
    await view.onOpen();
    internals(view).drillPath = [project, parent];
    internals(view).renderGraph();

    expect(view.contentEl.querySelectorAll(".pm-node-project-card")).toHaveLength(0);
    const cards = [...view.contentEl.querySelectorAll<HTMLElement>(".pm-node-card")];
    expect(cards.map((c) => c.dataset.taskId)).toEqual(["child"]);
  });
});

// ---------------------------------------------------------------------------
describe("stripWikiLinks", () => {
  it("replaces a plain wiki-link with its page name", () => {
    expect(stripWikiLinks("See [[Some Page]] for details")).toBe("See Some Page for details");
  });

  it("replaces a piped wiki-link with its display text", () => {
    expect(stripWikiLinks("See [[some-page|Some Page]] for details")).toBe("See Some Page for details");
  });

  it("trims whitespace around the page/display text", () => {
    expect(stripWikiLinks("[[ some-page | Some Page ]]")).toBe("Some Page");
  });

  it("replaces multiple wiki-links in the same string", () => {
    expect(stripWikiLinks("[[a|Alpha]] and [[b|Beta]]")).toBe("Alpha and Beta");
  });

  it("returns the string unchanged when there are no wiki-links", () => {
    expect(stripWikiLinks("no links here")).toBe("no links here");
  });
});

// ---------------------------------------------------------------------------
// withAlpha
// ---------------------------------------------------------------------------

describe("withAlpha", () => {
  it("appends the alpha hex to a six-digit colour", () => {
    expect(withAlpha("#3b82f6", "22")).toBe("#3b82f622");
  });

  it("expands a three-digit colour before appending alpha", () => {
    expect(withAlpha("#f00", "80")).toBe("#ff000080");
  });

  it("works without a leading '#'", () => {
    expect(withAlpha("3b82f6", "ff")).toBe("#3b82f6ff");
  });

  it("handles a three-digit shorthand without '#'", () => {
    expect(withAlpha("abc", "44")).toBe("#aabbcc44");
  });

  it("handles a fully opaque alpha (ff)", () => {
    expect(withAlpha("#22c55e", "ff")).toBe("#22c55eff");
  });

  it("handles a fully transparent alpha (00)", () => {
    expect(withAlpha("#22c55e", "00")).toBe("#22c55e00");
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The frame the level is drawn in, and carrying an end of a line onto a card
// ---------------------------------------------------------------------------

describe("the frame round a level", () => {
  /** `t1` at the root of Alpha, with a child and a task outside waiting on that child. */
  function withOutsider() {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "Parent" }),
        makeTask({ id: "kid", projectId: "p1", title: "Kid", parentId: "t1" }),
        makeTask({ id: "far", projectId: "p1", title: "Far", dependencies: ["t1"] }),
      ],
    });
  }

  it("draws the frame under the cards it holds", async () => {
    // Absolutely positioned cards, so the order they are drawn in is the order they stack.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1" })],
    });
    const { view } = makeView();
    await openProject(view);

    expect(drawn(view).nodes[0]).toBeInstanceOf(ContainerNode);
    // A layer of its own, under the lines: a line crossing the frame runs over it.
    expect(view.contentEl.querySelector(".pm-graph-backdrop .pm-graph-container")).not.toBeNull();
    expect(view.contentEl.querySelector(".pm-graph-nodes .pm-graph-container")).toBeNull();
  });

  it("draws the level's own dependency against the frame", async () => {
    // Drilled into `t1`: what `t1` waits for is nowhere on this level, so the frame is the
    // only thing the line can point at.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "Parent", dependencies: ["far"] }),
        makeTask({ id: "kid", projectId: "p1", title: "Kid", parentId: "t1" }),
        makeTask({ id: "far", projectId: "p1", title: "Far" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    const [project, parent] = [internals(view).projects[0], internals(view).tasks[0]];
    internals(view).drillPath = [project, parent];
    internals(view).renderGraph();

    const edge = drawn(view).edges[0];
    expect(edge.target).toBeInstanceOf(ContainerNode);
    expect(edge.source.isExternal).toBe(true);
  });

  it("names no task for a project's frame, a project holding no dependency", async () => {
    withOutsider();
    const { view } = makeView();
    await openProject(view);

    const frame = drawn(view).nodes[0] as ContainerNode;
    expect(frame.taskId).toBeUndefined();
  });
});

describe("carrying an end of a dependency onto another card", () => {
  /** `t1` blocking `t2` at the root of Alpha, plus `spare`, all three drawn. */
  async function drawnLevel() {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "One" }),
        makeTask({ id: "t2", projectId: "p1", title: "Two", dependencies: ["t1"] }),
        makeTask({ id: "spare", projectId: "p1", title: "Spare" }),
      ],
    });
    const { view } = makeView();
    await openProject(view);
    return { view, edge: drawn(view).edges[0] };
  }

  function nodeFor(view: TaskGraphView, id: string): GraphNode {
    return drawn(view).nodes.find((n) => n.id === id)!;
  }

  const release = () => new PointerEvent("pointerup");

  it("draws nothing between the two writes, where the link is stored at both ends", async () => {
    // Each write wakes the vault's change events; a refresh landing between them would draw
    // the dependency twice, at its old end and at its new.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "One" }),
        makeTask({ id: "t2", projectId: "p1", title: "Two", dependencies: ["t1"] }),
        makeTask({ id: "spare", projectId: "p1", title: "Spare" }),
      ],
    });
    const app = makeApp();
    const { view } = makeView(app);
    await openProject(view);
    const edge = drawn(view).edges[0];

    vi.useFakeTimers();
    const refreshSpy = vi.spyOn(view as unknown as { refresh: () => Promise<void> }, "refresh" as never)
      .mockResolvedValue(undefined);
    const writeAndNudge = async () => {
      app.metadataCache._emit("changed", { path: "Projects/x.md" });
      vi.advanceTimersByTime(400);
    };
    mockAddTaskDependency.mockImplementation(writeAndNudge);
    mockRemoveTaskDependency.mockImplementation(writeAndNudge);

    internals(view).repoint(edge, EdgeEnd.Target, nodeFor(view, "spare"), release());
    for (let i = 0; i < 20; i++) await Promise.resolve();
    vi.advanceTimersByTime(400);

    // Only the redraw the finished edit asks for, none from the half-written state.
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("writes the new link before dropping the old one", async () => {
    // Two files when the waiting end moves, so a failure between them leaves the link
    // where it was rather than losing it.
    const { view, edge } = await drawnLevel();
    const order: string[] = [];
    mockAddTaskDependency.mockImplementation(async () => { order.push("add"); });
    mockRemoveTaskDependency.mockImplementation(async () => { order.push("remove"); });

    internals(view).repoint(edge, EdgeEnd.Target, nodeFor(view, "spare"), release());
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["add", "remove"]);
    expect(mockAddTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "spare" }), "t1",
    );
    expect(mockRemoveTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "t2" }), "t1",
    );
  });

  it("moves what a task waits on when the other end is carried", async () => {
    const { view, edge } = await drawnLevel();

    internals(view).repoint(edge, EdgeEnd.Source, nodeFor(view, "spare"), release());
    await Promise.resolve();
    await Promise.resolve();

    // "t2" still waits, on "spare" now rather than on "t1".
    expect(mockAddTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "t2" }), "spare",
    );
    expect(mockRemoveTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "t2" }), "t1",
    );
  });

  it("takes no end onto a card the link could not follow", async () => {
    const { view, edge } = await drawnLevel();
    // Onto the card the line already leaves: the task would wait on itself.
    expect(internals(view).repointChoices(edge, EdgeEnd.Target, nodeFor(view, "t1"))).toHaveLength(0);

    internals(view).repoint(edge, EdgeEnd.Target, nodeFor(view, "t1"), release());
    await Promise.resolve();

    expect(mockAddTaskDependency).not.toHaveBeenCalled();
  });

  it("reaches a task beyond the level through the dotted card standing for it", async () => {
    // The very thing the gesture is for: a dependency onto a task this level does not hold,
    // which nothing else here can express.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "host", projectId: "p1", title: "Host" }),
        makeTask({ id: "c1", projectId: "p1", title: "First", parentId: "host" }),
        makeTask({ id: "c2", projectId: "p1", title: "Second", parentId: "host", dependencies: ["c1"] }),
        makeTask({ id: "far", projectId: "p1", title: "Far", dependencies: ["host"] }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    internals(view).drillPath = [internals(view).projects[0], internals(view).tasks[0]];
    internals(view).renderGraph();
    const edge = drawn(view).edges.find((e) => e.target.id === "c2")!;

    internals(view).repoint(edge, EdgeEnd.Target, nodeFor(view, "far-ext"), release());
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAddTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "far" }), "c1",
    );
  });

  it("asks which link is meant when a line stands for more than one", async () => {
    // Two children of `t2` each waiting on `t1`: one dashed line, two stored links.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "t1", projectId: "p1", title: "One" }),
        makeTask({ id: "t2", projectId: "p1", title: "Two" }),
        makeTask({ id: "spare", projectId: "p1", title: "Spare" }),
        makeTask({ id: "kidA", projectId: "p1", title: "Kid A", parentId: "t2", dependencies: ["t1"] }),
        makeTask({ id: "kidB", projectId: "p1", title: "Kid B", parentId: "t2", dependencies: ["t1"] }),
      ],
    });
    const { view } = makeView();
    await openProject(view);
    const edge = drawn(view).edges[0];

    internals(view).repoint(edge, EdgeEnd.Target, nodeFor(view, "spare"), release());

    expect(MockMenu.instances).toHaveLength(1);
    expect(MockMenu.instances[0].items.map((i) => i._title)).toEqual([
      'Move: "One" → "Kid A"',
      'Move: "One" → "Kid B"',
    ]);
    expect(mockAddTaskDependency).not.toHaveBeenCalled();

    MockMenu.instances[0].items[1]._onClick!();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRemoveTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "kidB" }), "t1",
    );
  });
});

// ---------------------------------------------------------------------------
// Linking to a task the level doesn't draw
// ---------------------------------------------------------------------------

describe("linking to a task beside the one the level belongs to", () => {
  /** Drilled into `host`, whose two neighbours are what a link out can reach. */
  async function drilledIntoHost() {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "host", projectId: "p1", title: "Host" }),
        makeTask({ id: "kid", projectId: "p1", title: "Kid", parentId: "host" }),
        makeTask({ id: "n1", projectId: "p1", title: "Neighbour one" }),
        makeTask({ id: "n2", projectId: "p1", title: "Neighbour two" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    internals(view).drillPath = [internals(view).projects[0], internals(view).tasks[0]];
    internals(view).renderGraph();
    return { view, kid: internals(view).tasks.find((t) => t.id === "kid")! };
  }

  const rightClick = () => new MouseEvent("contextmenu", { bubbles: true });

  it("offers both directions on a card of the level", async () => {
    const { view, kid } = await drilledIntoHost();
    internals(view).openTaskContextMenu(rightClick(), kid);

    expect(MockMenu.instances[0].items.map((i) => i._title)).toEqual([
      "Add subtask",
      "Wait on a task outside…",
      "Block a task outside…",
      "Move task…",
      "Delete task",
    ]);
  });

  it("lists the neighbours of the task the level belongs to, by title", async () => {
    const { view, kid } = await drilledIntoHost();
    internals(view).openTaskContextMenu(rightClick(), kid);
    MockMenu.instances[0].item("Wait on a task outside…")._onClick!();

    expect(MockMenu.instances[1].items.map((i) => i._title)).toEqual([
      "Neighbour one",
      "Neighbour two",
    ]);
  });

  it("writes the link onto the waiting end, whichever direction was chosen", async () => {
    const { view, kid } = await drilledIntoHost();

    internals(view).openTaskContextMenu(rightClick(), kid);
    MockMenu.instances[0].item("Wait on a task outside…")._onClick!();
    MockMenu.instances[1].item("Neighbour one")._onClick!();
    await Promise.resolve();
    expect(mockAddTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "kid" }), "n1",
    );

    mockAddTaskDependency.mockClear();
    internals(view).openTaskContextMenu(rightClick(), kid);
    MockMenu.instances.at(-1)!.item("Block a task outside…")._onClick!();
    MockMenu.instances.at(-1)!.item("Neighbour two")._onClick!();
    await Promise.resolve();
    expect(mockAddTaskDependency).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "n2" }), "kid",
    );
  });

  it("leaves out a neighbour the link is already there for", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "host", projectId: "p1", title: "Host" }),
        makeTask({ id: "kid", projectId: "p1", title: "Kid", parentId: "host", dependencies: ["n1"] }),
        makeTask({ id: "n1", projectId: "p1", title: "Neighbour one" }),
        makeTask({ id: "n2", projectId: "p1", title: "Neighbour two" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    internals(view).drillPath = [internals(view).projects[0], internals(view).tasks[0]];
    internals(view).renderGraph();
    const kid = internals(view).tasks.find((t) => t.id === "kid")!;

    internals(view).openTaskContextMenu(rightClick(), kid);
    MockMenu.instances[0].item("Wait on a task outside…")._onClick!();

    // Already waiting on the first one; offering it again would only be refused.
    expect(MockMenu.instances[1].items.map((i) => i._title)).toEqual(["Neighbour two"]);
  });

  it("drops a direction with nowhere left to go", async () => {
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [
        makeTask({ id: "host", projectId: "p1", title: "Host" }),
        makeTask({ id: "kid", projectId: "p1", title: "Kid", parentId: "host", dependencies: ["n1"] }),
        makeTask({ id: "n1", projectId: "p1", title: "Neighbour one" }),
      ],
    });
    const { view } = makeView();
    await view.onOpen();
    internals(view).drillPath = [internals(view).projects[0], internals(view).tasks[0]];
    internals(view).renderGraph();
    const kid = internals(view).tasks.find((t) => t.id === "kid")!;

    internals(view).openTaskContextMenu(rightClick(), kid);

    // The one neighbour is already waited on, and blocking it would close a cycle.
    const titles = MockMenu.instances[0].items.map((i) => i._title);
    expect(titles).toEqual(["Add subtask", "Move task…", "Delete task"]);
  });

  it("offers nothing at the top of a project, whose neighbours are other projects", async () => {
    // A dependency never crosses a project, so there is nothing out there to reach.
    mockLoadVaultData.mockResolvedValue({
      projects: [makeProject({ id: "p1", title: "Alpha" })],
      tasks: [makeTask({ id: "t1", projectId: "p1", title: "One" })],
    });
    const { view } = makeView();
    await openProject(view);

    internals(view).openTaskContextMenu(rightClick(), internals(view).tasks[0]);

    expect(MockMenu.instances[0].items.map((i) => i._title))
      .toEqual(["Add subtask", "Move task…", "Delete task"]);
  });
});
