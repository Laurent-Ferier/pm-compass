# Graph Display Architecture

## Data flow

`refresh()` loads all tasks and projects from the Obsidian vault via `loadVaultData()`, stores them in `this.tasks` / `this.projects`, prunes the drill path if any referenced tasks were deleted, then calls `renderGraph()`.

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
- **`tap` on cytoscape nodes** handles only the edit button (identified by checking if `getEventTarget()` is inside `.pm-node-edit-btn`)
- **`dbltap`** drills down: pushes the task onto `drillPath` and calls `renderGraph()` again

---

## Layout and viewport

After cytoscape runs the dagre layout, a one-time `layoutstop` handler:

1. Calls `applyStoredPositions()` — restores any manually-dragged node positions from `plugin.settings.nodePositions`
2. Calls `fitMainCy()` / `fitSectionCy()` — sizes the container to the bounding box and sets the viewport pan so nodes start at `(pad, pad)`
3. Disables user pan/zoom (the view is static; scrolling happens at the scroll-wrapper level)
4. Draws the SVG separator lines

On `dragfree`, only the dragged node's position is saved to settings, leaving all unmodified nodes to get fresh dagre positions on the next render.

---

## SVG separator lines

SVG lines are drawn on top of the cytoscape canvas (appended to the same container) after layout. They use `renderedPosition()` (screen coordinates) to place:

- A **vertical line** between the context/project column and the task columns
- **Horizontal lines** between project rows in the all-projects view
