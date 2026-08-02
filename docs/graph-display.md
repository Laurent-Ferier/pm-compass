# Graph Display Architecture

## The pieces

The graph is drawn by the plugin itself — there is no graph library. Four modules split
the job, and all of them speak in `GraphNode`/`GraphEdge`:

| Module | Responsibility |
|---|---|
| `ui/graph-node.ts` | `GraphNode` (abstract) and its two kinds. Each holds its card, its centre and its box geometry (`left`/`top`/`exitTowards`), and draws itself into a positioned wrapper. Owns `NODE_WIDTH`/`NODE_HEIGHT`. |
| `ui/graph-edge.ts` | `GraphEdge` (abstract) and its two kinds. Each draws itself; `resolveEdges()` ties id-named specs to the cards drawn, dropping any that dangle. |
| `ui/graph-layout.ts` | `layoutGraph(nodes, edges, spacing)` — a topological left-to-right placement that sets each node's `position`. Pure geometry, no DOM. |
| `ui/graph-renderer.ts` | `GraphRenderer` — holds the two layers, the viewport offset, and the pointer gestures. It tells nodes and edges to draw themselves; it does not draw them. |

Both hierarchies replace what would otherwise be a flag:

| Base | Kinds |
|---|---|
| `GraphNode` | `ProjectNode` — a project heading, always context. `TaskNode` — one task's card; standing as the graph's own context it takes an id of its own (`<taskId>-ctx`) and carries the task's in `taskId`. A context card has no children left to open, so `canDrillIn` is false for it. |
| `GraphEdge` | `DependencyEdge` — draws a line, an arrowhead and a wide invisible hit stroke, and reports right-clicks. `VirtualEdge` — `render`/`reposition`/`destroy` are all no-ops. |

`ui/task-graph-view.ts` assembles the cards' data, hands the renderer nodes and edges, and
handles what a tap means.

---

## Data flow

`refresh()` loads all tasks and projects from the Obsidian vault via `loadVaultData()`, stores them in `this.tasks` / `this.projects`, prunes the drill path if any referenced tasks were deleted (or the pinned project itself is gone), drops any saved node positions for nodes that no longer exist via `pruneStalePositions()`, then calls `renderGraph()`.

`openTask(projectId, taskId)` is the other entry point into this view — called by `BaseTabView.openInGraph()` when a task row is clicked elsewhere (e.g. the Dashboard). It reloads vault data, rebuilds `drillPath` to the task's parent context (project, or parent task if it has one), and sets `pendingSelectTaskId` so the card gets selected once the render is up.

---

## `renderGraph()` — the routing layer

It tears down any existing renderers, empties the container, dispatches on `drillPath` via `renderGraphContent()`, then consumes `pendingSelectTaskId`. Selecting last is what lets a task in the *third* project section still be found — no section knows which of them holds it.

| `drillPath` | What renders |
|---|---|
| `[]` (empty) | `renderAllProjectsTable()` — one section per project |
| `[Project]` | `createProjectSection()` for that single project |
| `[Project, Task, ...]` | `buildElements()` → single drill-down graph |

Both call `createGraph()`, which is where the renderer is built and wired. The two differ
only in spacing, padding, what a tap drills into, and how much of their room they fix.

---

## Three display modes

### All-projects view (`drillPath = []`)

`renderAllProjectsTable()` iterates every project, creates a `<div class="pm-project-section">` per project, and calls `createProjectSection()` for each. Each project gets its own renderer, stored in `this.graphs[]`.

### Single-project / section view

`createProjectSection()` builds a flat element list:
- One **`ProjectNode`** (`id: proj-<id>`)
- One **`TaskNode`** per top-level task in that project
- **Virtual edges** from the project node to each task — never drawn, they only put the project card in the first column
- **Dependency edges** between tasks that declare dependencies on each other

### Drill-down view (`drillPath.length >= 2`)

`buildElements()` creates:
- One **context `TaskNode`** standing for the parent being drilled into (`id: <taskId>-ctx`, carrying the real task in `taskId`)
- One **`TaskNode`** per immediate child of that parent
- Virtual edges from context → each child
- Dependency edges between sibling tasks

Below 500px container width, `renderGraphContent()` strips the context node and virtual edges before building the graph, so only the task cards themselves are shown.

---

## Layout

`layoutGraph` places one card at a time, in the order a topological sort hands them out.
Because a card only ever comes up once everything it depends on is already down, its slot
can be settled there and then — there is no second pass over the whole graph.

1. **Order** — `topologicalOrder` is Kahn's algorithm. Every card with nothing to wait on
   goes into a queue; taking one out decrements its successors' counts, and any that reach
   zero join the queue. A cycle (which the UI forbids, but a hand-edited vault can spell
   out) leaves its cards waiting forever, so they are appended last rather than dropped.
2. **Column** — `columnFor` takes the first column holding none of the card's dependencies,
   which is one past the furthest of them. A card waiting on nothing lands in column 0; a
   card waiting on something in column 0 *and* something in column 2 lands in column 3,
   not column 1.
3. **Row** — `rowFor` tries every free row in that column and counts, for each, how many
   of the card's incoming edges would cross an edge already drawn (a real segment-crossing
   test, since an edge can span several columns). Fewest crossings wins. Ties go to the row
   nearest the middle of what the card depends on, which is what draws a chain straight
   rather than letting it step down the graph.

One final pass: `centreSources` lifts a card that waits on nothing and has its column to
itself onto the middle of what hangs off it — this is what centres a project heading, or a
drilled-into task, against its children instead of leaving it at the top.

Rows are slots, not free ordinates: a card with two dependencies takes the free row nearest
the middle of them, not an ordinate exactly between them.

Spacing comes from the view: `DRILL_SPACING` for the drilled-in graph, `SECTION_SPACING`
for the tighter project sections.

---

## Rendering

`GraphRenderer` puts two layers in the container: an `<svg class="pm-graph-edges">` under
a `<div class="pm-graph-nodes">`, so cards always sit above the lines. `fit(padding)`
sets a `translate` on both layers and reports the room the graph needs — the drilled-in
view fixes its container's width and height, a section only its height.

Each node draws itself as an absolutely positioned `.pm-graph-node` wrapper holding the
card the view built. A `DependencyEdge` draws itself as three SVG elements: the visible
line, its arrowhead polygon, and a 14px-wide transparent stroke that is what a pointer
actually hits — a 1.5px line is not something a finger can be asked to aim at. A
`VirtualEdge` draws nothing.

The cards themselves are built as elements (`taskNodeCard` / `projectNodeCard`), not as
markup strings, so no value is ever interpolated into HTML.

**Task card** (`taskNodeCard`):

```
[priority ribbon] [title            ]  [✏ edit]
                  [status badge][⚠][due]  [⛓ link]
                  [↳ N subtasks]
```

- The colored left ribbon represents priority (clickable → opens priority dropdown)
- The status badge is colored per status (clickable → opens status dropdown)
- An amber warning glyph may sit between the status badge and the due date, flagging a
  parent/subtask completion mismatch: an `alert-triangle` when the task is completed
  (`done`/`cancelled`) but still has an open descendant, or an `unlink` when the task is
  still open but its parent is already completed (`isCompletedWithOpenSubtasks` /
  `isOpenUnderCompletedParent` in `model/project/task-tree.ts`). Hover for the explanation
- The pencil button opens the full `TaskModal`
- The link button starts a drag-to-connect gesture for adding dependencies

**Project card** (`projectNodeCard`): project title with its color, plus a pencil button.

---

## Interaction model

Two layers of handlers, split by who owns the gesture:

- **`pointerdown` on `graphContainer`** (registered once in `onOpen`) opens the pickers: `.pm-node-ribbon` and `.pm-node-status` open their dropdowns, `.pm-node-connect-btn` starts the drag-to-connect gesture. The renderer sees these presses too, but knows not to start dragging the card from one of a card's own controls.
- **`contextmenu` on `graphContainer`** (also once in `onOpen`) handles right-click: on a `.pm-node-card` it opens a task context menu (add subtask, move, delete); on empty space it opens an add-task/subtask menu scoped to whichever project section (or drilled-into task) was clicked. An edge's own handler stops propagation, so right-clicking a dependency offers only "Remove dependency".
- **Tap** (`onNodeTap` → `handleNodeTap`) branches on whether the press landed on `.pm-node-edit-btn`: if so it opens `TaskModal`/`ProjectModal` (ctrl-click opens the note instead); otherwise it selects the card (`selectGraphNode()`) and signals the Dashboard tab to highlight the same task (`signalDashboard()`), so a click in the graph is reflected back in the Dashboard's rows. A project card with no edit button pressed drills into that project.
- **Double tap** drills down: pushes the task onto `drillPath` and re-renders. Two presses on one card within 300ms; guarded so tapping the edit button doesn't also drill.
- **Drag** moves the card. A press travels 4px (mouse) or 24px (touch) before it counts as a drag rather than a tap — the finger figure is what a thumb rolls while pressing a badge. On release the position is written to `settings.nodePositions`, the graph refits, and the separators redraw. `pointercancel` puts the card back.

A gesture belongs to the pointer that started it: only that `pointerId` moves or ends it, so a second finger scrolling the page doesn't take the card with it. What a tap *means* is read off where the press landed, never off the release — a drag-to-connect is released over whichever card it was dropped on, and reading that would open the wrong task's modal.

Stored positions override the layout for those cards only, so everything else still gets
fresh placement on the next render.

---

## Moving a task

"Move task…" in the node context menu opens `MoveTargetModal` and calls `moveTask()`, shared verbatim with the Dashboard's identical menu item via `openMoveTaskModal()` (`ui/move-target-modal.ts`) — this view has its own `openTaskContextMenu()`, independent of `BaseTabView`'s, so the shared helper lives in the modal's module rather than on the base class, which this view does not extend.

Note what the two drag gestures here do **not** do: dragging a card moves its stored *position*, and drag-to-connect adds a *dependency*. Neither changes a task's parent — re-parenting only happens through the menu, since it can relocate files and invalidate dependencies (see [dashboard.md](dashboard.md) for the rules).

---

## SVG separator lines

A third `<svg class="pm-sep-svg">` overlay sits above both layers, drawn after each fit
from `renderedPosition()`. The two views draw different amounts:

- **All-projects / single-project view** (`renderSectionSeparator()`): one **vertical line** per section, between its project column and its task column. No horizontal lines — each project section is a separate `<div>`, stacked by normal DOM flow rather than drawn.
- **Drill-down view** (`renderSeparators()`): the same **vertical line** between the context column and its children, plus horizontal-line logic between adjacent context rows — but `buildElements()` only ever produces a single context node, so that horizontal branch is currently dead code.

Either line is skipped when the two columns overlap, which is what dragging a card across
the divide can do.
