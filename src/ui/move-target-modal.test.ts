// @vitest-environment jsdom
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian DOM polyfills (same shape as the other *-rendering tests)
// ---------------------------------------------------------------------------

function installObsidianDOMPolyfills() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlProto = HTMLElement.prototype as any;

  type CreateElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };

  function createElOn(this: Element, tag: string, opts?: CreateElOpts): Element {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts?.type) (el as HTMLInputElement).type = opts.type;
    if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
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
  htmlProto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  htmlProto.toggleClass = function (this: HTMLElement, cls: string, force?: boolean) {
    this.classList.toggle(cls, force);
  };
  htmlProto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  htmlProto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
}

beforeAll(() => { installObsidianDOMPolyfills(); });

// ---------------------------------------------------------------------------

const { moveTaskMock } = vi.hoisted(() => ({ moveTaskMock: vi.fn() }));

vi.mock("obsidian", () => ({
  App: class {},
  Notice: class {},
  Component: class { load() {} unload() {} },
  // Titles go through MarkdownRenderer; the real one is Obsidian-internal, so
  // stand in the same <p>-wrapped shape renderInlineMarkdown unwraps.
  MarkdownRenderer: {
    render: vi.fn(async (_app: unknown, markdown: string, el: HTMLElement) => {
      const p = document.createElement("p");
      p.textContent = markdown;
      el.appendChild(p);
    }),
  },
  moment: () => ({ format: () => "", isValid: () => true }),
  setIcon: (el: HTMLElement, name: string) => {
    el.dataset.icon = name;
  },
  Modal: class {
    contentEl: HTMLElement = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public app: any) {}
    open() {
      // Real modals wrap contentEl in a `.modal` holding a close button; mirror
      // that so onOpen's removal of the button has something to find.
      const modal = document.createElement("div");
      modal.className = "modal";
      const closeBtn = document.createElement("div");
      closeBtn.className = "modal-close-button";
      modal.appendChild(closeBtn);
      modal.appendChild(this.contentEl);
      // Tests locate the modal by its contentEl, appended where they can find it.
      document.body.appendChild(modal);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).onOpen?.();
    }
    close() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).onClose?.();
      this.contentEl.remove();
    }
  },
}));

vi.mock("../model/task-move", () => ({ moveTask: moveTaskMock }));

import { MoveTargetModal, openMoveTaskModal, type MoveChoice } from "./move-target-modal";
import type { Project, Task } from "../model/shared";
import { PRIORITY_COLORS, STATUS_COLORS, Priority } from "../model/task-vocabulary";

// ---------------------------------------------------------------------------
// Fixtures: Alpha holds parent -> kid; Beta is empty.
// ---------------------------------------------------------------------------

function makeProject(id: string, title: string): Project {
  return { id, title, tasks: [], filePath: `Projects/${title}.md` };
}

function makeTask(o: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: "alpha", status: "todo", dependencies: [], subtasks: [],
    filePath: `Projects/Alpha_tasks/${o.id}.md`, ...o,
  } as Task;
}

const PROJECTS = [
  { ...makeProject("alpha", "Alpha"), color: "#123456" },
  makeProject("beta", "Beta"),
];
const TASKS = [
  makeTask({ id: "parent", title: "Parent", priority: Priority.High, status: "in-progress" }),
  makeTask({ id: "kid", title: "Kid", parentId: "parent" }),
  makeTask({ id: "far", title: "Far", projectId: "beta" }),
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const APP = {} as any;

// `prototype.constructor` is typed as plain `Function`, so `Parameters<…>` of it
// collapses to `never` and silently accepted anything. Read the options off the class.
function open(opts: Partial<ConstructorParameters<typeof MoveTargetModal>[1]> = {}) {
  const onChoose = vi.fn();
  const modal = new MoveTargetModal(APP, {
    heading: "Move", ctaLabel: "Move", projects: PROJECTS, tasks: TASKS, onChoose,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(opts as any),
  });
  modal.open();
  return { modal, el: modal.contentEl, onChoose };
}

const rows = (el: HTMLElement, sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];
/** Row titles only — rows also carry a status pill, which `textContent` would glue on. */
const rowText = (el: HTMLElement, sel: string) =>
  rows(el, sel).map((r) => (r.querySelector(".pm-mt-row-label") ?? r).textContent);
const cta = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button.mod-cta")!;
const chevron = (el: HTMLElement, sel: string, i: number) =>
  rows(el, sel)[i].querySelector<HTMLElement>(".pm-mt-chevron");
/** Toggles the branch of the i-th row matching `sel`. Every branch starts shut. */
const toggle = (el: HTMLElement, sel: string, i: number) => chevron(el, sel, i)!.click();

beforeEach(async () => {
  const { MarkdownRenderer } = await import("obsidian");
  vi.mocked(MarkdownRenderer.render).mockClear();
  moveTaskMock.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

/** The DOM of the most recently opened modal. */
const openedModal = () => document.body.lastElementChild as HTMLElement;

// ---------------------------------------------------------------------------

describe("MoveTargetModal — project selection", () => {
  it("lists every project", () => {
    const { el } = open();
    expect(rowText(el, ".pm-mt-project-row")).toEqual(["Alpha", "Beta"]);
  });

  it("starts with every project collapsed, so no tasks are on show", () => {
    const { el } = open();
    expect(rows(el, ".pm-mt-parent-row")).toHaveLength(0);
  });

  it("removes Obsidian's own close button, leaving Cancel as the one way out", () => {
    const { el } = open();
    // The button lives on the `.modal` wrapper, a level up from the content.
    expect(el.parentElement?.querySelector(".modal-close-button")).toBeNull();
    const cancel = [...el.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    expect(cancel).toBeDefined();
  });

  it("does not open a project merely because it was selected", () => {
    const { el } = open();
    rows(el, ".pm-mt-project-row")[0].click();

    // Selecting says where the task lands; the chevron says what's on show.
    expect(rows(el, ".pm-mt-parent-row")).toHaveLength(0);
    expect(cta(el).disabled).toBe(false);
  });

  it("opens a project one level at a time, not its whole subtree", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);

    // Kid stays shut inside Parent until Parent is opened in its own right.
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Parent"]);
  });

  it("nests only the tasks belonging to each project", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 1); // Beta

    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Far"]);
  });

  it("indents a task deeper than its project, and a subtask deeper again", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent, to reach Kid
    const project = rows(el, ".pm-mt-project-row")[0];
    const [parent, kid] = rows(el, ".pm-mt-parent-row");

    const pad = (r: HTMLElement) => parseFloat(r.style.paddingLeft || "0");
    expect(pad(parent)).toBeGreaterThan(pad(project));
    expect(pad(kid)).toBeGreaterThan(pad(parent));
  });

  it("resets the chosen parent when a different project is picked", () => {
    const { el, onChoose } = open();
    toggle(el, ".pm-mt-project-row", 0);
    rows(el, ".pm-mt-parent-row")[0].click(); // Parent
    rows(el, ".pm-mt-project-row")[1].click(); // switch to Beta
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "beta", parentTask: undefined }),
    );
  });
});

describe("MoveTargetModal — hiding completed tasks", () => {
  // Alpha: "Shipped" is done but holds an open "Loose end"; "Scrapped" is
  // cancelled with nothing under it; "Live" is open.
  const CLOSED_TASKS = [
    makeTask({ id: "live", title: "Live" }),
    makeTask({ id: "shipped", title: "Shipped", status: "done" }),
    makeTask({ id: "loose", title: "Loose end", parentId: "shipped" }),
    makeTask({ id: "scrapped", title: "Scrapped", status: "cancelled" }),
    makeTask({ id: "gone", title: "Gone", parentId: "scrapped", status: "done" }),
  ];
  const openClosed = (o = {}) => open({ tasks: CLOSED_TASKS, ...o });
  const hideBtn = (el: HTMLElement) => el.querySelector<HTMLElement>(".pm-mt-hide-completed")!;
  /** The icon is a plain toggle, so a click is the only way to set it. */
  const setHide = (el: HTMLElement, on: boolean) => {
    if (hideBtn(el).getAttribute("aria-pressed") !== String(on)) hideBtn(el).click();
  };

  it("hides completed tasks by default", () => {
    const { el } = openClosed();
    expect(hideBtn(el).getAttribute("aria-pressed")).toBe("true");

    toggle(el, ".pm-mt-project-row", 0);
    // "Scrapped" is cancelled and its only child is done, so the whole branch
    // goes. "Shipped" is done but survives as the route to "Loose end", and
    // opens straight through to it rather than making that a second click.
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Live", "Shipped", "Loose end"]);
  });

  it("shows its state on the icon, and says what a click would do", () => {
    const { el } = openClosed();
    expect(hideBtn(el).dataset.icon).toBe("eye-off");
    expect(hideBtn(el).title).toBe("Show completed tasks");

    hideBtn(el).click();

    expect(hideBtn(el).dataset.icon).toBe("eye");
    expect(hideBtn(el).title).toBe("Hide completed tasks");
    expect(hideBtn(el).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a completed task that is the only route to open work", () => {
    const { el } = openClosed();
    toggle(el, ".pm-mt-project-row", 0);

    // Shipped is done, but hiding it would strand "Loose end" with no way in.
    // It stays a signpost, and shuts on demand like any other branch.
    expect(rowText(el, ".pm-mt-parent-row")).toContain("Shipped");
    toggle(el, ".pm-mt-parent-row", 1);
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Live", "Shipped"]);
  });

  it("shows every completed task once the toggle is off", () => {
    const { el } = openClosed();
    setHide(el, false);
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 2); // open Scrapped

    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Live", "Shipped", "Scrapped", "Gone"]);
  });

  it("gives no chevron to a branch whose children are all hidden", () => {
    const { el } = openClosed();
    toggle(el, ".pm-mt-project-row", 0);

    // Nothing under Shipped is open... except Loose end, so it keeps its chevron.
    expect(chevron(el, ".pm-mt-parent-row", 1)).not.toBeNull(); // Shipped -> Loose end
    expect(chevron(el, ".pm-mt-parent-row", 0)).toBeNull(); // Live is a leaf
  });

  it("gives no chevron to a project whose tasks are all hidden", () => {
    const { el } = open({ tasks: [makeTask({ id: "only", title: "Only", status: "done" })] });
    expect(chevron(el, ".pm-mt-project-row", 0)).toBeNull();
  });

  it("keeps a selection the toggle has just hidden, marking the way back to it", () => {
    const { el, onChoose } = openClosed();
    setHide(el, false);
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 2); // open Scrapped
    rows(el, ".pm-mt-parent-row")[3].click(); // select Gone (done)

    setHide(el, true);

    // Gone and its parent Scrapped are both culled, so Alpha — the last row on
    // the way down that survives — carries the mark. The choice stands: flicking
    // the filter to look around shouldn't cost the user their destination.
    expect(rows(el, ".pm-mt-row--holds-selection")).toEqual([
      el.querySelector(".pm-mt-project-row"),
    ]);
    expect(cta(el).disabled).toBe(false);

    cta(el).click();
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ parentTask: expect.objectContaining({ id: "gone" }) }),
    );
  });

  it("keeps a selection the toggle leaves on show", () => {
    const { el } = openClosed();
    toggle(el, ".pm-mt-project-row", 0);
    rows(el, ".pm-mt-parent-row")[0].click(); // Live
    setHide(el, false);

    expect(cta(el).disabled).toBe(false);
    expect(rowText(el, ".pm-mt-row--selected")).toEqual(["Live"]);
  });
});

describe("MoveTargetModal — opening through completed tasks", () => {
  // A chain of done tasks with one live task at the bottom: every link survives
  // the cull only because "Buried" does.
  const CHAIN = [
    makeTask({ id: "a", title: "A", status: "done" }),
    makeTask({ id: "b", title: "B", parentId: "a", status: "cancelled" }),
    makeTask({ id: "c", title: "C", parentId: "b", status: "done" }),
    makeTask({ id: "buried", title: "Buried", parentId: "c" }),
  ];

  it("opens a whole chain of done tasks in one click, down to the live one", () => {
    const { el } = open({ tasks: CHAIN });
    toggle(el, ".pm-mt-project-row", 0);

    // Every done row here exists only to be clicked through, so clicking through
    // them is not work worth handing to the user.
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["A", "B", "C", "Buried"]);
  });

  it("stops opening at the first level that holds live work", () => {
    const { el } = open({
      tasks: [
        makeTask({ id: "done-top", title: "Done top", status: "done" }),
        makeTask({ id: "live-kid", title: "Live kid", parentId: "done-top" }),
        makeTask({ id: "deep", title: "Deep", parentId: "live-kid" }),
      ],
    });
    toggle(el, ".pm-mt-project-row", 0);

    // "Live kid" is a real destination, so its own subtree is the user's call.
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Done top", "Live kid"]);
  });

  it("opens through done tasks revealed deeper in, not just at the top level", () => {
    const { el } = open({
      tasks: [
        makeTask({ id: "live", title: "Live" }),
        makeTask({ id: "done-mid", title: "Done mid", parentId: "live", status: "done" }),
        makeTask({ id: "leaf", title: "Leaf", parentId: "done-mid" }),
      ],
    });
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Live

    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Live", "Done mid", "Leaf"]);
  });

  it("leaves done tasks shut when they are shown as destinations in their own right", () => {
    const { el } = open({ tasks: CHAIN });
    const hide = el.querySelector<HTMLElement>(".pm-mt-hide-completed")!;
    hide.click(); // show completed

    toggle(el, ".pm-mt-project-row", 0);

    // Nothing is a mere signpost now, so "A" opens one level like any other row.
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["A"]);
  });

  it("lets a chain opened for you be shut again", () => {
    const { el } = open({ tasks: CHAIN });
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // shut A

    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["A"]);
  });
});

describe("MoveTargetModal — marking an out-of-sight selection", () => {
  it("marks the collapsed ancestor holding the selection", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent
    rows(el, ".pm-mt-parent-row")[1].click(); // select Kid
    expect(rows(el, ".pm-mt-row--holds-selection")).toHaveLength(0);

    toggle(el, ".pm-mt-parent-row", 0); // shut Parent, hiding Kid

    expect(rowText(el, ".pm-mt-row--holds-selection")).toEqual(["Parent"]);
    expect(rows(el, ".pm-mt-parent-row")[0].title).toBe("The chosen destination is inside");
  });

  it("falls back to the project row when the whole tree is shut", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    rows(el, ".pm-mt-parent-row")[0].click(); // select Parent
    toggle(el, ".pm-mt-project-row", 0); // shut Alpha

    expect(rowText(el, ".pm-mt-row--holds-selection")).toEqual(["Alpha"]);
  });

  it("marks nothing while the selection can speak for itself", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    rows(el, ".pm-mt-parent-row")[0].click(); // select Parent, on show

    expect(rows(el, ".pm-mt-row--holds-selection")).toHaveLength(0);
  });

  it("marks nothing for a project root, which is the row itself", () => {
    const { el } = open();
    rows(el, ".pm-mt-project-row")[0].click(); // Alpha's root

    expect(rows(el, ".pm-mt-row--holds-selection")).toHaveLength(0);
    expect(rows(el, ".pm-mt-row--selected")).toHaveLength(1);
  });

  it("keeps a disabled row's refusal reason on hover, marking it all the same", () => {
    // Alpha's root is refused; Kid, inside it, is not.
    const isDisabled = (c: MoveChoice) =>
      c.kind === "existing" && !c.parentTask ? "Already there" : undefined;
    const { el } = open({ isDisabled });
    toggle(el, ".pm-mt-project-row", 0);
    rows(el, ".pm-mt-parent-row")[0].click(); // select Parent
    toggle(el, ".pm-mt-project-row", 0); // shut Alpha

    const alpha = rows(el, ".pm-mt-project-row")[0];
    expect(alpha.classList.contains("pm-mt-row--holds-selection")).toBe(true);
    expect(alpha.title).toBe("Already there");
  });
});

describe("MoveTargetModal — task detail", () => {
  const taskRow = (el: HTMLElement, id: string) =>
    rows(el, ".pm-mt-parent-row").find((r) => r.dataset.taskId === id)!;

  it("colours the ribbon by priority and names it on hover", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    const ribbon = taskRow(el, "parent").querySelector<HTMLElement>(".pm-task-ribbon")!;

    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe(PRIORITY_COLORS.high);
    expect(ribbon.title).toBe("Priority: High");
  });

  it("leaves the ribbon uncoloured for a task with no priority, so CSS falls back", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent, to reach Kid
    const ribbon = taskRow(el, "kid").querySelector<HTMLElement>(".pm-task-ribbon")!;

    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("");
    expect(ribbon.title).toBe("Priority: None");
  });

  it("shows the status as a pill, labelled and coloured like the dashboard's", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    const pill = taskRow(el, "parent").querySelector<HTMLElement>(".pm-mt-status")!;

    expect(pill.textContent).toBe("In Progress");
    expect(pill.style.getPropertyValue("--pm-status-color")).toBe(STATUS_COLORS["in-progress"]);
  });

  it("gives a project row a ribbon of its own colour, keeping labels aligned", () => {
    const { el } = open();
    const ribbon = rows(el, ".pm-mt-project-row")[0].querySelector<HTMLElement>(".pm-task-ribbon")!;

    expect(ribbon.style.getPropertyValue("--pm-ribbon-color")).toBe("#123456");
  });

  it("renders the title as markdown, so wikilinks and tags aren't shown raw", async () => {
    const { MarkdownRenderer } = await import("obsidian");
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);

    expect(MarkdownRenderer.render).toHaveBeenCalledWith(
      expect.anything(), "Parent", expect.any(HTMLElement), "", expect.anything(),
    );
  });

  it("gives a project row no status pill", () => {
    const { el } = open();
    expect(rows(el, ".pm-mt-project-row")[0].querySelector(".pm-mt-status")).toBeNull();
  });
});

describe("MoveTargetModal — expanding and collapsing the tree", () => {
  it("gives a chevron to rows with children and none to leaves", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent, to reach Kid

    expect(chevron(el, ".pm-mt-project-row", 0)).not.toBeNull(); // Alpha has tasks
    expect(chevron(el, ".pm-mt-parent-row", 0)).not.toBeNull(); // Parent has Kid
    expect(chevron(el, ".pm-mt-parent-row", 1)).toBeNull(); // Kid is a leaf
  });

  it("expands a project from its chevron without selecting it", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);

    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Parent"]);
    expect(cta(el).disabled).toBe(true); // nothing selected
  });

  it("opens a subtree from its chevron, and shuts it again on a second click", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);

    toggle(el, ".pm-mt-parent-row", 0); // open Parent
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Parent", "Kid"]);

    toggle(el, ".pm-mt-parent-row", 0);
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Parent"]);
  });

  it("collapses a project's whole tree from its chevron", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-project-row", 0);

    expect(rows(el, ".pm-mt-parent-row")).toHaveLength(0);
  });

  it("leaves other projects shut when one is opened", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0); // Alpha

    // Beta's "Far" is nowhere to be seen.
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Parent"]);
  });

  it("restores the branches opened earlier when a project is reopened", () => {
    const { el } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent
    toggle(el, ".pm-mt-project-row", 0); // shut Alpha, hiding both
    toggle(el, ".pm-mt-project-row", 0); // and open it again

    // Parent was opened deliberately, so it comes back opened, not reset.
    expect(rowText(el, ".pm-mt-parent-row")).toEqual(["Parent", "Kid"]);
  });

  it("does not deselect the project when its own chevron is clicked", () => {
    const { el, onChoose } = open();
    rows(el, ".pm-mt-project-row")[0].click(); // select Alpha
    toggle(el, ".pm-mt-project-row", 0); // open it
    toggle(el, ".pm-mt-project-row", 0); // and shut it again
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "alpha", parentTask: undefined }),
    );
  });

  it("keeps a selection made before its ancestor was collapsed", () => {
    const { el, onChoose } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent
    rows(el, ".pm-mt-parent-row")[1].click(); // Kid
    toggle(el, ".pm-mt-parent-row", 0); // collapse Parent, hiding Kid
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ parentTask: expect.objectContaining({ id: "kid" }) }),
    );
  });
});

describe("MoveTargetModal — choosing", () => {
  it("disables the confirm button until something is selected", () => {
    const { el } = open();
    expect(cta(el).disabled).toBe(true);
  });

  it("reports a project root choice", () => {
    const { el, onChoose } = open();
    rows(el, ".pm-mt-project-row")[0].click(); // select Alpha
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith({
      kind: "existing", projectId: "alpha", projectFilePath: "Projects/Alpha.md",
      projectTitle: "Alpha", parentTask: undefined,
    });
  });

  it("reports a parent-task choice", () => {
    const { el, onChoose } = open();
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent
    rows(el, ".pm-mt-parent-row")[1].click(); // Kid
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ parentTask: expect.objectContaining({ id: "kid" }) }),
    );
  });
});

describe("MoveTargetModal — disabled destinations", () => {
  const isDisabled = (c: MoveChoice) =>
    c.kind === "existing" && c.parentTask?.id === "kid" ? "Cannot move a task under its own subtask" : undefined;

  it("marks a rejected destination disabled and explains why on hover", () => {
    const { el } = open({ isDisabled });
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent
    const kid = rows(el, ".pm-mt-parent-row")[1];

    expect(kid.classList.contains("pm-mt-row--disabled")).toBe(true);
    expect(kid.title).toBe("Cannot move a task under its own subtask");
  });

  it("ignores clicks on a disabled destination", () => {
    const { el, onChoose } = open({ isDisabled });
    rows(el, ".pm-mt-project-row")[0].click(); // select Alpha's root
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0); // open Parent
    rows(el, ".pm-mt-parent-row")[1].click(); // Kid — disabled
    cta(el).click();

    // Still on the project root, which is allowed.
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ parentTask: undefined }));
  });

  it("leaves an allowed sibling clickable", () => {
    const { el } = open({ isDisabled });
    toggle(el, ".pm-mt-project-row", 0);

    expect(rows(el, ".pm-mt-parent-row")[0].classList.contains("pm-mt-row--disabled")).toBe(false);
  });
});

describe("MoveTargetModal — new project", () => {
  it("is not offered unless the caller opts in", () => {
    const { el } = open();
    expect(rows(el, ".pm-mt-new-project")).toHaveLength(0);
  });

  it("swaps in a name input when chosen", () => {
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();

    expect(el.querySelector(".pm-mt-new-project-input")).not.toBeNull();
  });

  it("reports the typed title", () => {
    const { el, onChoose } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();
    const input = el.querySelector<HTMLInputElement>(".pm-mt-new-project-input")!;
    input.value = "Languages";
    input.dispatchEvent(new Event("input"));
    cta(el).click();

    expect(onChoose).toHaveBeenCalledWith({ kind: "new-project", title: "Languages" });
  });

  it("commits on Enter in the name box", () => {
    const { el, onChoose } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();
    const input = el.querySelector<HTMLInputElement>(".pm-mt-new-project-input")!;
    input.value = "Languages";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(onChoose).toHaveBeenCalledWith({ kind: "new-project", title: "Languages" });
  });

  it("shows an empty state when there are no projects and no new-project option", () => {
    const { el } = open({ projects: [], allowNewProject: false });
    expect(el.querySelector(".pm-mt-empty")?.textContent).toBe("No projects");
    expect(rows(el, ".pm-mt-project-row")).toHaveLength(0);
  });

  it("keeps the caret in the name box across an unrelated re-render", () => {
    // renderTree() runs again whenever the tree changes under the user — here a
    // chevron. Re-focusing the name input on those passes would yank the caret
    // out mid-word.
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();
    const input = el.querySelector<HTMLInputElement>(".pm-mt-new-project-input")!;
    input.value = "Lang";
    input.dispatchEvent(new Event("input"));

    const elsewhere = el.querySelector<HTMLElement>(".pm-mt-hide-completed")!;
    elsewhere.focus();
    toggle(el, ".pm-mt-project-row", 0);

    expect(document.activeElement).toBe(elsewhere);
  });

  it("focuses the name input when the row is first activated", () => {
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();

    expect(document.activeElement).toBe(el.querySelector(".pm-mt-new-project-input"));
  });

  it("stays disabled while the name is blank", () => {
    const { el } = open({ allowNewProject: true });
    rows(el, ".pm-mt-new-project")[0].click();

    expect(cta(el).disabled).toBe(true);
  });

  it("drops an existing selection, since a new project has nothing to nest under", () => {
    const { el, onChoose } = open({ allowNewProject: true });
    toggle(el, ".pm-mt-project-row", 0);
    rows(el, ".pm-mt-parent-row")[0].click(); // Parent
    rows(el, ".pm-mt-new-project")[0].click();
    const input = el.querySelector<HTMLInputElement>(".pm-mt-new-project-input")!;
    input.value = "Gamma";
    input.dispatchEvent(new Event("input"));

    expect(rows(el, ".pm-mt-row--selected")).toEqual([el.querySelector(".pm-mt-new-project")]);

    cta(el).click();
    expect(onChoose).toHaveBeenCalledWith({ kind: "new-project", title: "Gamma" });
  });
});

describe("openMoveTaskModal", () => {
  it("moves the task to the chosen destination", async () => {
    const task = TASKS[1]; // Kid
    const onDone = vi.fn();
    openMoveTaskModal(APP, task, PROJECTS, TASKS, onDone);
    const el = openedModal();

    const projectRows = rows(el, ".pm-mt-project-row");
    projectRows[1].click(); // Beta
    cta(el).click();
    await vi.waitFor(() => expect(moveTaskMock).toHaveBeenCalled());

    expect(moveTaskMock).toHaveBeenCalledWith(
      APP, task,
      expect.objectContaining({ projectId: "beta", parentTask: undefined }),
      TASKS,
      // moveTask needs the project list to find the file the task is leaving.
      PROJECTS,
    );
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("does not offer creating a new project", () => {
    openMoveTaskModal(APP, TASKS[1], PROJECTS, TASKS, vi.fn());
    const el = openedModal();
    expect(rows(el, ".pm-mt-new-project")).toHaveLength(0);
  });

  it("greys out the task's own subtree as a destination", () => {
    // Moving "parent" under its own child "kid" must be refused.
    openMoveTaskModal(APP, TASKS[0], PROJECTS, TASKS, vi.fn());
    const el = openedModal();
    // Alpha's own row is a no-op destination for a task already at its root, and
    // Parent is the task being moved, so both are disabled — the chevron is the
    // way into a tree you can't select.
    toggle(el, ".pm-mt-project-row", 0);
    toggle(el, ".pm-mt-parent-row", 0);

    const kid = rows(el, ".pm-mt-parent-row").find((r) => r.dataset.taskId === "kid")!;
    expect(kid.classList.contains("pm-mt-row--disabled")).toBe(true);
    expect(kid.title).toMatch(/own subtask/i);
  });

  it("surfaces a failed move instead of silently swallowing it", async () => {
    const err = new Error("disk full");
    moveTaskMock.mockRejectedValueOnce(err);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onDone = vi.fn();

    openMoveTaskModal(APP, TASKS[1], PROJECTS, TASKS, onDone);
    const el = openedModal();
    rows(el, ".pm-mt-project-row")[1].click();
    cta(el).click();

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
