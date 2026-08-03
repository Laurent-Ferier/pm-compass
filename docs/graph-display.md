# Graph Display Architecture

## The pieces

The graph is drawn by the plugin itself — there is no graph library. Four modules split
the job, and all of them speak in `GraphNode`/`GraphEdge`:

| Module | Responsibility |
|---|---|
| `ui/graph-node.ts` | `GraphNode` (abstract) and its two kinds. Each holds its card, its centre and its box geometry (`left`/`top`/`exitTowards`), and draws itself into a positioned wrapper. Owns `NODE_WIDTH`/`NODE_HEIGHT`. |
| `ui/graph-edge.ts` | `GraphEdge` (abstract) and its two kinds. Each draws itself; `resolveEdges()` ties id-named specs to the cards drawn, dropping any that dangle. |
| `ui/graph-layout.ts` | `layoutGraph(nodes, edges, spacing)` — a topological left-to-right placement — and `layoutGrid(nodes, spacing, columns)`, reading order wrapped every `columns`. Both set each node's `position`; pure geometry, no DOM. |
| `ui/graph-renderer.ts` | `GraphRenderer` — holds the two layers, the viewport offset, and the pointer gestures. It tells nodes and edges to draw themselves; it does not draw them. |

Both hierarchies replace what would otherwise be a flag:

| Base | Kinds |
|---|---|
| `GraphNode` | `ProjectNode` — one project's card, drawn only at the top of the trail, naming its project in `projectId`. The grid places it, so `isDraggable` is false. `TaskNode` — one task's card. Standing for a task the level doesn't hold it is `isExternal`, takes an id of its own (`<taskId>-ext`), carries the task's in `taskId`, and is not draggable either. |
| `GraphEdge` | `DependencyEdge` — draws a line, an arrowhead and a wide invisible hit stroke, and reports right-clicks. `IndirectDependencyEdge` — the same, dashed, for a link neither of whose ends is on this level. Either kind adds an `external` variant class when a card at one of its ends `isExternal`, which draws it dotted and dimmed to match that card; the two marks stack, an outside end saying nothing about the kind. |

`ui/task-graph-view.ts` assembles the cards' data, hands the renderer nodes and edges, and
handles what a tap means.

---

## Data flow

`refresh()` loads all tasks and projects from the Obsidian vault via `loadVaultData()`, stores them in `this.tasks` / `this.projects`, prunes the drill path if any referenced tasks were deleted (or the pinned project itself is gone), drops any saved node positions for nodes that no longer exist via `pruneStalePositions()`, then calls `renderGraph()`.

`openTask(projectId, taskId)` is the other entry point into this view — called by `BaseTabView.openInGraph()` when a task row is clicked elsewhere (e.g. the Dashboard). It reloads vault data, rebuilds `drillPath` to the task's parent context (project, or parent task if it has one), and sets `pendingSelectTaskId` so the card gets selected once the render is up.

---

## `renderGraph()` — the routing layer

It tears down the renderer, empties the container, dispatches on `drillPath` via `renderGraphContent()`, then consumes `pendingSelectTaskId`. Selecting last is what lets the card be found once the whole render is up.

There is **one panel and one `GraphRenderer`** at every level. What differs is only which cards it holds and where they go:

| `drillPath` | Cards | Placement |
|---|---|---|
| `[]` (empty) | one `ProjectNode` per project | `layoutGrid` |
| `[Project]` | that project's root tasks, plus the dotted cards | `layoutGraph` |
| `[Project, Task, …]` | the last task's children, plus the dotted cards | `layoutGraph` |

The last two rows are the same code path — `buildElements()`. Both go through
`createGraph()`, which is where the renderer is built and wired.

---

## The two levels

### The projects (`drillPath = []`)

`renderProjectGrid()` draws one card per project, sorted by title, and no task at all: a
project's tasks are one drill in, and the card names the project already. Since there is
nothing to sort these cards by, `layoutGrid` wraps them to the panel's width rather than
filing them down one column, and `onResize()` calls `GraphRenderer.relayout()` — which
re-runs the layout and moves the cards it already drew, reading no vault and building no
DOM. Only when the width has come to hold a different number of cards across, though, since
Obsidian reports a resize per frame while a divider is dragged; `gridColumnCount` records
what was last laid out, counted by the two places that decide to lay the grid out — the
first render and the reflow — while the layout itself only places the cards. Nothing here
is remembered: a card that isn't draggable neither reads nor writes a stored position, and
`pruneStalePositions()` sweeps any `proj-<id>` key an older build left.

Archived projects (`archived: true` in the project note) are left out unless the gear's
"Show archived" is on, when they are drawn faded with an "Archived" pill. Both gear toggles
only change what is drawn, so they redraw without re-reading the vault. Turning the toggle
off while drilled into an archived project drops back to the grid. The flag is set from
`ProjectModal`; `model/project/archive.ts` holds the filters the other views share.

### A level of tasks (`drillPath.length >= 1`)

`buildElements()` returns the level's own cards — a project's root tasks, or the last
drilled-into task's children — plus one dotted card per task outside the level at either end
of a dependency, and the dependency edges between them all. The project or task the level
belongs to gets **no card**: it is named in the breadcrumb above, and a card would say it
twice.

A dotted card is the level's own card drawn **inert** (`TaskCardKind.External`): it carries
neither the action buttons nor the task's id — not on the card, its ribbon, or its status
pill. That one absence is what makes it inert everywhere, rather than a guard per gesture:
every path to a task goes through `data-task-id`, so the context menu finds no task, the
priority and status pickers open on nothing, a connect drag never lights it up, and
`selectGraphNode` and `startDragConnect` find the real card because it is the only one
naming the task. What the DOM can't say the node does: `isExternal` keeps it out of drags,
double-taps, moves and selection. It sits in the same flow as the rest: no band forces a column, so a prerequisite
with nothing before it falls in column 0 and a dependent falls past whatever it waits on.
Each is **one card per task**, whichever way its arrows run — a task the level both waits on
and is waited on by draws `B → X → A` as the chain it is.

`liftDependencies` (`model/project/dependency-graph.ts`) is what decides: each end of a
stored dependency lifts to the card standing for it on the level, and an end that lifts to
nothing while the other lifts is kept, named as itself and marked with the `ExternalEnd` it
stands at. A pair with neither end on the level, or with both landing on one card, is
dropped. So is one reaching a card a filter is holding back — a hidden card is the level's
own, not something outside it.

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
itself onto the middle of what hangs off it, instead of leaving it at the top.

Rows are slots, not free ordinates: a card with two dependencies takes the free row nearest
the middle of them, not an ordinate exactly between them.

`layoutGrid` is the other placement, for the projects: `gridColumns()` counts what the width
holds, and the cards fill rows in reading order. It ends where `layoutGraph` does — the first
card centred on `(NODE_WIDTH / 2, NODE_HEIGHT / 2)` — so `fit` sees the two the same way.
Spacing comes from the view: `DRILL_SPACING` for a level of tasks, the tighter `GRID_SPACING`
for the projects.

---

## Rendering

`GraphRenderer` puts two layers in the container: an `<svg class="pm-graph-edges">` under
a `<div class="pm-graph-nodes">`, so cards always sit above the lines. `fit(padding)`
sets a `translate` on both layers and reports the room the graph needs. The container is
given a height either way, and a level of tasks a `minWidth` too, so a wide graph scrolls
sideways rather than being squeezed.

Each node draws itself as an absolutely positioned `.pm-graph-node` wrapper holding the
card the view built. A `DependencyEdge` draws itself as three SVG elements: the visible
line, its arrowhead polygon, and a 14px-wide transparent stroke that is what a pointer
actually hits — a 1.5px line is not something a finger can be asked to aim at.

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
- **`contextmenu` on `graphContainer`** (also once in `onOpen`) handles right-click: on a `.pm-node-card` it opens a task context menu (add subtask, move, delete) for whatever task the card names, and a card naming none — a dotted one — offers nothing rather than falling through to the menu for the room below, which is about the level and not about the card pressed. At the top of the trail, a right-click on a project's own card offers "Add task" for it and the room between the cards offers nothing; below it, empty space opens an add-task/subtask menu scoped to the drilled-into level. An edge's own handler stops propagation, so right-clicking a dependency offers only "Remove dependency".
- **Tap** (`onNodeTap` → `handleNodeTap`) branches on whether the press landed on `.pm-node-edit-btn`: if so it opens `TaskModal`/`ProjectModal` (ctrl-click opens the note instead); otherwise it selects the card (`selectGraphNode()`) and signals the Dashboard tab to highlight the same task (`signalDashboard()`), so a click in the graph is reflected back in the Dashboard's rows. A project card with no edit button pressed drills into that project.
- **Double tap** drills down: pushes the task onto `drillPath` and re-renders. Two presses on one card within 300ms; guarded so tapping the edit button doesn't also drill.
- **Drag** moves the card. A press travels 4px (mouse) or 24px (touch) before it counts as a drag rather than a tap — the finger figure is what a thumb rolls while pressing a badge. On release the position is written to `settings.nodePositions` and the graph refits. `pointercancel` puts the card back. A card the level doesn't own — a project's, a dotted one — reports `isDraggable: false`, which is the one rule: such a card never moves, and no stored position is read or written for it.
- **Drag onto another card** moves the task under it; **drag onto a breadcrumb entry** moves it there, which is how it comes back out. See [Moving a task](#moving-a-task).

A gesture belongs to the pointer that started it: only that `pointerId` moves or ends it, so a second finger scrolling the page doesn't take the card with it. What a tap *means* is read off where the press landed, never off the release — a drag-to-connect is released over whichever card it was dropped on, and reading that would open the wrong task's modal.

Stored positions override the layout for those cards only, so everything else still gets
fresh placement on the next render.

---

## Moving a task

"Move task…" in the node context menu opens `MoveTargetModal` and calls `moveTask()`, shared verbatim with the Dashboard's identical menu item via `openMoveTaskModal()` (`ui/move-target-modal.ts`) — this view has its own `openTaskContextMenu()`, independent of `BaseTabView`'s, so the shared helper lives in the modal's module rather than on the base class, which this view does not extend.

**Dropping a card on another card** is the same move without the picker: the destination is the card it landed on. The renderer owns the gesture (`nodeDrop` in `GraphRendererOptions`) and knows nothing about tasks — it asks `canDrop` which cards may be landed on, marks the one under the dragged card `.pm-drop-target`, and reports the drop. The view answers both from `isValidMoveTarget()`, so a card the move would be refused for — the task's own subtree, or where it already sits — never lights up and never takes a drop.

The hit test is geometric, in layout space: the dragged card's centre inside another's box. A pointer hit test would only ever find the dragged card, which is what sits under the pointer.

**Dropping a card on a breadcrumb entry** is how a task comes back *out* of where it sits — the one direction covering another card can't express. The breadcrumb names every level above, so dropping on the project entry moves the task to that project's root and dropping on an ancestor task moves it under that task; "All" carries no `data-drill-index` and is never a candidate at all. `isValidMoveTarget`'s `AlreadyHere` is what makes the current level inert, so at `drillPath.length === 1` the gesture correctly does nothing.

The renderer owns this as `outsideDrop`: it asks for the elements once as the drag begins, measures their rects, and hit-tests the **pointer** against them — the breadcrumb cannot move while a card is being dragged, and `elementFromPoint` is both absent in jsdom and already recorded here as unreliable behind an overlay. What lies outside wins over a card the dragged one happens to cover, since a gesture that has travelled that far means the breadcrumb — so the cards are only searched once nothing over there has taken it. `canDrop` is asked once per target per gesture, for either kind, since nothing it reads changes while the gesture is on. The mark is the caller's: `markClass` rather than the cards' `.pm-drop-target`, because a dashed card outline round a line of text reads as an accident. The card itself stops at the container's top edge (`heldInside`) while the pointer travels on, or `overflow: auto` would simply clip it away mid-gesture. A drag that ends **above** the container with nothing to drop on restores rather than saving (`aboveContainer`), so a release over "All" can't write a position far above the graph. Only above: the container is sized to the cards in it, so a card carried past the bottom or the right edge is asking the drawing to *grow*, which the `fit` on the next breath does — testing every direction would silently throw those placements away. The mark itself spreads by `box-shadow` rather than padding, since an entry that grew when marked would shift the trail out from under the rects the gesture is still being judged against. `destroy()` clears the mark from the entry: a breadcrumb span does not die with the renderer.

What the drop *means* is the view's, in `breadcrumbMove()`; both it and `dropMove()` funnel through `moveDestination()` and `confirmMove()`, so the two gestures land in the same check, the same dialog and the same `applyTaskMove()`.

A task that has moved **loses its stored position** (`forgetMovedPositions()`, run on every vault read against the tasks still in hand — the only record of where they were): a dragged-to position is a place among *siblings*, and a moved task is drawn in another graph, where it would strand the card on top of whatever the layout put there. Comparing reads rather than reacting to the gesture means a move made from the Dashboard, or in the notes themselves, is caught too.

A drop **asks before it writes** (`ConfirmModal`, "Move" rather than the default "Delete" wording): the gesture is a couple of centimetres of travel, and what it commits relocates files and clears the task's dependencies. Either way the card goes back where it started — a drop changes the tree, not the layout, so nothing is written to `settings.nodePositions` and the graph re-renders around the task's new home. Confirmed, it goes through `applyTaskMove()`, the same move-and-report the picker's own choice lands in.

Note what the two other drag gestures do **not** do: dragging a card onto empty space moves its stored *position*, and drag-to-connect adds a *dependency*. Neither changes a task's parent (see [dashboard.md](dashboard.md) for the re-parenting rules).
