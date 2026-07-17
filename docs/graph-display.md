# Graph Display Architecture

## Data flow

`refresh()` loads all tasks and projects from the Obsidian vault via `loadVaultData()`, stores them in `this.tasks` / `this.projects`, prunes the drill path if any referenced tasks were deleted (or the pinned project itself is gone), drops any saved node positions for nodes that no longer exist via `pruneStalePositions()`, then calls `renderGraph()`.

`openTask(projectId, taskId)` is the other entry point into this view — called by `BaseTabView.openInGraph()` when a task row is clicked elsewhere (e.g. the Dashboard). It reloads vault data, rebuilds `drillPath` to the task's parent context (project, or parent task if it has one), and sets `pendingSelectTaskId` so the node gets auto-selected once the next layout settles.

---

## `renderGraph()` — the routing layer

This method first tears down any existing cytoscape instances, then branches on `drillPath`:

| `drillPath` | What renders |
|---|---|
| `[]` (empty) | `renderAllProjectsTable()` — one section per project |
| `[Project]` | `createProjectSectionCy()` for that single project |
| `[Project, Task, ...]` | `buildElements()` → single cytoscape drill-down view |

---

## Three display modes

### All-projects view (`drillPath = []`)

`renderAllProjectsTable()` iterates every project, creates a `<div class="pm-project-section">` per project, and calls `createProjectSectionCy()` for each. Each project gets its own independent cytoscape instance stored in `this.cys[]`.

### Single-project / section view

`createProjectSectionCy()` builds a flat element list:
- One **project anchor node** (`id: proj-<id>`, `nodeType: "project"`)
- One **task node** per top-level task in that project
- **Invisible virtual edges** from the project node to each task (for dagre to align them)
- **Visible dependency edges** between tasks that declare dependencies on each other

Dagre lays it out left-to-right (`rankDir: LR`). After layout, a vertical SVG separator line is drawn between the project column and the task column via `renderSectionSeparator()`.

### Drill-down view (`drillPath.length >= 2`)

`buildElements()` creates:
- One **context-task node** representing the parent task being drilled into (`id: <taskId>-ctx`)
- One **task node** per immediate child of that parent
- Invisible virtual edges from context → each child (for dagre)
- Visible dependency edges between sibling tasks

Below 500px container width, `renderGraph()` strips the context node and virtual edges from these elements before building the graph, so only the task cards themselves are shown.

---

## Node rendering — `nodeHtmlLabel`

Cytoscape nodes are declared with `"background-color": "transparent"` and no label. The `cytoscape-node-html-label` plugin injects real HTML into each node's bounding box via the `tpl` callback.

**Task card** (`taskNodeTemplate`):

```
[priority ribbon] [title          ]  [✏ edit]
                  [status badge][due]  [⛓ link]
                  [↳ N subtasks]
```

- The colored left ribbon represents priority (clickable → opens priority dropdown)
- The status badge is colored per status (clickable → opens status dropdown)
- The pencil button opens the full `TaskModal`
- The link button starts a drag-to-connect gesture for adding dependencies

**Project card** (`projectNodeTemplate`): project title with its color, plus a pencil button.

---

## Interaction model

Because `nodeHtmlLabel` overlays real DOM elements, cytoscape's own tap events and the HTML button clicks can conflict. The code separates them:

- **`pointerdown` on `cyContainer`** (registered once in `onOpen`) intercepts clicks on `.pm-node-ribbon`, `.pm-node-status`, and `.pm-node-connect-btn` before cytoscape sees them, calls `e.preventDefault()`, and opens the appropriate dropdown or starts the drag gesture
- **`contextmenu` on `cyContainer`** (also registered once in `onOpen`) handles right-click separately from the tap/pointerdown paths: on a `.pm-node-card` it opens a task context menu (add subtask, move, delete); on empty space it opens an add-task/subtask menu scoped to whichever project section (or drilled-into task) was clicked
- **`tap` on cytoscape nodes** branches on whether the tap landed on `.pm-node-edit-btn` (via `getEventTarget()`): if so it opens `TaskModal`/`ProjectModal` (ctrl-click opens the note instead); otherwise it selects the node (`selectGraphNode()`) and signals the Dashboard tab to highlight the same task (`signalDashboard()`), so a click in the graph is reflected back in the Dashboard's checklist/task rows
- **`cxttap` on a dependency edge** opens a remove-dependency menu
- **`dbltap`** drills down: pushes the task onto `drillPath` and calls `renderGraph()` again (guarded so tapping the edit button doesn't also trigger a drill-down)

---

## Moving a task

"Move task…" in the node context menu opens `MoveTargetModal` and calls `moveTask()`, shared verbatim with the Dashboard's identical menu item via `openMoveTaskModal()` (`ui/move-target-modal.ts`) — this view has its own `openTaskContextMenu()`, independent of `BaseTabView`'s, so the shared helper lives in the modal's module rather than on the base class, which this view does not extend.

Note what the two drag gestures here do **not** do: dragging a node moves its stored *position* (`dragfree` → `settings.nodePositions`), and drag-to-connect adds a *dependency*. Neither changes a task's parent — re-parenting only happens through the menu, since it can relocate files and invalidate dependencies (see [dashboard.md](dashboard.md) for the rules).

## Layout and viewport

After cytoscape runs the dagre layout, a one-time `layoutstop` handler:

1. Calls `applyStoredPositions()` — restores any manually-dragged node positions from `plugin.settings.nodePositions`
2. Calls `fitMainCy()` / `fitSectionCy()` — sizes the container to the bounding box and sets the viewport pan so nodes start at `(pad, pad)`
3. Disables user pan/zoom (the view is static; scrolling happens at the scroll-wrapper level)
4. Draws the SVG separator line(s)
5. If `pendingSelectTaskId` is set (from `openTask()`), selects that node once the layout has settled — this step runs in both `createProjectSectionCy()`'s and the drill-down view's `layoutstop` handler, since `openTask()` can land on either depending on how deep the target task is nested

On `dragfree`, only the dragged node's position is saved to settings, leaving all unmodified nodes to get fresh dagre positions on the next render.

---

## SVG separator lines

SVG lines are drawn on top of the cytoscape canvas (appended to the same container) after layout, using `renderedPosition()` (screen coordinates). The two views draw different amounts:

- **All-projects / single-project view** (`createProjectSectionCy` → `renderSectionSeparator()`): one **vertical line** per section, between its project column and its task column. No horizontal lines — each project's cytoscape instance is a fully separate `<div class="pm-project-section">`, stacked by normal DOM flow rather than drawn.
- **Drill-down view** (`buildElements()` → `renderSeparators()`): the same **vertical line** between the context-task column and its children, plus horizontal-line logic between adjacent context rows — but `buildElements()` only ever produces a single context node, so that horizontal branch is currently dead code (`contextNodes.length - 1` is always `0`).
