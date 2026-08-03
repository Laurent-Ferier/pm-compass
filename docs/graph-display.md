# Graph Display Architecture

## The pieces

The graph is drawn by the plugin itself — there is no graph library. Four modules split
the job, and all of them speak in `GraphNode`/`GraphEdge`:

| Module | Responsibility |
|---|---|
| `ui/graph-node.ts` | `GraphNode` (abstract) and its two kinds. Each holds its card, its centre and its box geometry (`left`/`top`/`exitTowards`), and draws itself into a positioned wrapper. Owns `NODE_WIDTH`/`NODE_HEIGHT`. |
| `ui/graph-edge.ts` | `GraphEdge` (abstract) and its two kinds. Each draws itself; `resolveEdges()` ties id-named specs to the cards drawn, dropping any that dangle. |
| `ui/graph-layout.ts` | `layoutGraph(nodes, edges, spacing)` — a topological left-to-right placement — and `layoutGrid(nodes, spacing, columns)`, reading order wrapped every `columns`. Both set each node's `position`; pure geometry, no DOM. |
| `ui/graph-container-layout.ts` | `layoutContainerLevel` and `settleContainerLevel` — a level drawn as a frame: its own cards inside, the ones beyond it hung off the sides. Two halves, because the frame can only be sized once everything inside it is down. |
| `ui/graph-renderer.ts` | `GraphRenderer` — holds the two layers, the viewport offset, and the pointer gestures. It tells nodes and edges to draw themselves; it does not draw them. |

Both hierarchies replace what would otherwise be a flag:

| Base | Kinds |
|---|---|
| `GraphNode` | `ProjectNode` — one project's card, drawn only at the top of the trail, naming its project in `projectId`. The grid places it, so `isDraggable` is false. `TaskNode` — one task's card. Standing for a task the level doesn't hold it is `isExternal`, takes an id of its own (`<taskId>-ext`) and carries the task's in `taskId`; it still drags, its place remembered against that id of its own. `ContainerNode` — the frame round a level, taking `container:<id>`, naming the level's task in `taskId` (a project holds no dependency, so its frame names none), sized off the cards inside it rather than placed, and never draggable. |
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
| `[Project]` | the project's frame, its root tasks inside, the dotted cards around | `layoutContainerLevel` + `settleContainerLevel` |
| `[Project, Task, …]` | the last task's frame, its children inside, the dotted cards around | `layoutContainerLevel` + `settleContainerLevel` |

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

`buildElements()` returns the frame the level is drawn in, the level's own cards — a
project's root tasks, or the last drilled-into task's children — plus one dotted card per
task beyond the level at either end of a dependency, and the dependency edges between them
all. The frame comes **first**: the cards are absolutely positioned, so the order they are
drawn in is what puts the box under what it holds.

The frame is what the project or task the level belongs to is drawn as. It exists because a
dependency of *that* task has to point somewhere: its own links lift onto it (see
`liftDependencies`'s `enclosingId`), and there is no card among its children standing for it.
The breadcrumb correspondingly stops one short — it names the way back, not where you are,
which the frame says already. A level holding no card at all still draws its frame, with
"No tasks here." inside it, since nothing else on screen would name where the trail has come
to. A link between the frame and a card inside it is dropped rather than drawn: an arrow from
a box to the box holding it is nothing to follow, and `isValidDependencyTarget` refuses to
create one for the same reason.

A dotted card is the level's own card drawn **inert** (`TaskCardKind.External`): it carries
neither the action buttons nor the task's id — not on the card, its ribbon, or its status
pill. That one absence is what makes it inert everywhere, rather than a guard per gesture:
every path to a task goes through `data-task-id`, so the context menu finds no task, the
priority and status pickers open on nothing, a connect drag never lights it up, and
`selectGraphNode` and `startDragConnect` find the real card because it is the only one
naming the task. What the DOM can't say the node does: `isExternal` keeps it out of drags,
double-taps, moves and selection. It sits **outside the frame**: a prerequisite on its left,
anything else on its right, which is the direction the drawing already reads in. Each is
**one card per task**, whichever way its arrows run — a task the level both waits on and is
waited on by is drawn once, on the left, where its chain starts.

A dotted card **can be dragged**, though, which is the one thing it takes: where it sits is
a matter of reading, not of the vault, and the automatic sides don't always suit. Its place
is remembered against `<taskId>-ext`, and `settleContainerLevel` then leaves it alone — except
to hold it **clear of the frame**, the one place it may not go: the box stands for the level
itself, and a card from beyond it sitting inside would say it belongs there. The push-out is
`Box.clearOf`, by whichever of the four sides is the shortest way. This is re-run every frame
of the drag, so the card slides along the frame's edge rather than snapping on release.

`liftDependencies` (`model/project/dependency-graph.ts`) is what decides: each end of a
stored dependency lifts to the card standing for it on the level, and an end that lifts to
nothing while the other lifts is kept, named as itself and marked with the `ExternalEnd` it
stands at. The frame is the **last** card an end can lift to — the walk climbs one parent at
a time and every card of the level is a child of it, so a card inside always answers first. A pair with neither end on the level, or with both landing on one card, is
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

### The two halves of a level's placement

A level drawn in a frame is placed **twice**, and the split is not cosmetic. `layoutGraph`
runs first over the level's own cards alone — edges reaching outside say nothing about where
a card sits inside. Then `GraphRenderer` applies the positions cards were dragged to, which
the layout never sees. Only then can the frame be sized, so `settleContainerLevel` runs last,
through the renderer's `settle` option: it grows the box round wherever the cards ended up and
hangs the dotted ones off its sides. A drag re-runs it every frame (`resettle`), so the frame
grows under the finger rather than at the next render.

`settleContainerLevel` moves nothing inside the frame and **translates nothing**.
`layoutGraph`'s normalisation to the top left is safe because it runs before a stored position
is read; doing it again afterwards would rewrite what that stored centre means, drifting the
card a little further every render. The frame's left edge going negative is harmless — `fit`
pans by `-box.left` either way.

---

## Rendering

`GraphRenderer` puts three layers in the container, bottom to top: `.pm-graph-backdrop`,
`<svg class="pm-graph-edges">`, `.pm-graph-nodes`. A node draws into the backdrop when it
reports `isBackdrop`, which only the frame does — so a line crossing the frame runs **over**
it rather than disappearing beneath it, and the cards still sit above both. `fit(padding)`
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
- **Drag** moves the card. A press travels 4px (mouse) or 24px (touch) before it counts as a drag rather than a tap — the finger figure is what a thumb rolls while pressing a badge. On release the position is written to `settings.nodePositions` and the graph refits. `pointercancel` puts the card back. A card nothing places by hand — a project's, sat where the grid put it, and the frame, sized off what it holds — reports `isDraggable: false`, which is the one rule: such a card never moves, and no stored position is read or written for it.
- **Drag onto another card** moves the task under it; **drag onto a breadcrumb entry** moves it there, which is how it comes back out. See [Moving a task](#moving-a-task).
- **Drag one end of a line** onto another card re-points the dependency. See [Re-pointing a dependency](#re-pointing-a-dependency).

The card a drop lands on is the **smallest** box holding the drop point, not the first found: the frame holds every card of its level, and a card inside it is the nearer answer. The frame is only what the empty room inside it means.

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

A drop **asks before it writes** (`confirmAction` under `confirmTaskMoves`, "Move" rather than the default "Delete" wording): the gesture is a couple of centimetres of travel, and what it commits relocates files and clears the task's dependencies. Either way the card goes back where it started — a drop changes the tree, not the layout, so nothing is written to `settings.nodePositions` and the graph re-renders around the task's new home. Confirmed, it goes through `applyTaskMove()`, the same move-and-report the picker's own choice lands in.

Note what the two other drag gestures do **not** do: dragging a card onto empty space moves its stored *position*, and drag-to-connect adds a *dependency*. Neither changes a task's parent (see [dashboard.md](dashboard.md) for the re-parenting rules).

---

## Re-pointing a dependency

Pressing a drawn line takes hold of the end nearer the press and carries it to another card;
letting go there re-points the stored dependency. This is the only way to make a dependency
reach a task the level doesn't hold: the ⛓ connect button starts from a card's own id, and a
dotted card carries none — it is inert by having nothing on it to act on.

The whole line is a grab, not the tips of it: aiming at an arrowhead is finer work than the
gesture is worth, and which half was pressed says which end was meant (`nearestEnd`). The
invisible stroke under the line (`HIT_WIDTH`) is what a pointer actually catches, and it wears
a `grab` cursor to say so.

`GraphRenderer.wireEdge` owns the gesture, reported through `edgeRepoint` and knowing nothing
about tasks. The band it drags is drawn into the **edge layer, in layout space**, unlike the
connect gesture's page-wide overlay: the geometry here already lives in layout space, and a
band of its own means the real line never moves and never has to be put back. Targets are
found geometrically (`nodesAt`), never by `elementFromPoint` — the frame's body takes no
pointer events at all, so a hit test would never return it.

What a drop *means* is the view's. `repointChoices` takes the stored links the line stands for
— one for a solid line, as many as lift onto it for a dashed one — swaps the end that moved
for the task the card dropped on stands for, and keeps only those `isValidDependencyTarget`
allows. One choice is applied at once; several open a menu naming each link. `applyRepoint`
writes the new link **before** dropping the old one: when the waiting end has moved these are
two files, and a failure between them leaves the link where it was rather than losing it; when
it hasn't, they are one file read and rewritten twice, which run together would clobber the
first write. A re-point asks nothing — it rewrites a link rather than losing one; only
dropping a dependency from the edge menu does, under `confirmDependencyRemoval`. That
question names both ends wherever its menu entry did, a dashed line standing for links one
end alone wouldn't tell apart.

The pair goes through `writeTogether`, which holds off the vault's own change events until
both writes are done. Each write wakes `metadataCache`, and a refresh landing between them
would read a vault where the link is stored at **both** its old end and its new, and draw it
twice for as long as the second write took.

Depth is no bar to a dependency: `isValidDependencyTarget` refuses two tasks on one line of
descent (both ends would lift onto the same card at every level, so the link is undrawable),
but any other pair within a project is fair, and the graph lifts each end to the card standing
for it.

## Linking to a task the level doesn't draw

A dependency can also be made where there is no arrow to re-point yet. The node context menu
carries two entries — **"Wait on a task outside…"** and **"Block a task outside…"**, one per
direction, since which end the task is at is the whole of what the choice means. Each lists
the tasks sitting **beside the one the level belongs to** (`outsideCandidates`), filtered by
`isValidDependencyTarget`, and a direction with nothing left to offer is left off the menu
entirely. They reach the graph through `TaskContextMenuOptions.extraItems`, so the menu stays
shared with the Dashboard, which knows no level and adds nothing. At the top of a project
there is nothing to offer: a project's neighbours are other projects, and a dependency never
crosses one.
