# Dashboard — Technical Description

`DashboardView` (`ui/dashboard-view.ts`, extends `BaseTabView`) is one of three
long-lived tab views owned by `PMCompassView` — see [class-map.html](class-map.html)
for how it sits in the wider class graph. This document covers its data flow, layout,
and the deadline/priority scoring it renders.

## Data flow

`PMCompassView.render()` is the single data-loading entry point for all three tabs
(Dashboard, Inbox, Week Summary). It re-runs on a debounced timer whenever a watched
daily note or a file under the projects folder changes, or when the user switches tabs
or navigates the date.

Before loading anything (skipped when the active tab is Inbox, since Inbox doesn't
depend on it): `backfillRecurringHabits(app, settings)` inserts any missing recurring
habit lines into the current week's daily notes, so the checklist below is always
complete before it's read.

Then, in parallel:

| Call | Returns |
|---|---|
| `loadDayChecklist(app, dashboardDate, dnConfig)` | the picked day's checklist (`DayTask[]`) + its file path |
| `loadVaultData(app, projectsFolder)` | `{ tasks, projects }` parsed from obsidian-pm frontmatter |
| `dashboardView.loadAdjacentUnclosed(dashboardDate, dnConfig)` | unclosed items from the surrounding days (`unclosedDaysBefore`/`unclosedDaysAfter` settings, 7 by default) |
| `readInboxItems(...)` | only used here to decide whether the Inbox *tab* needs a stale-warning badge — not rendered on this tab |

The result is handed to `DashboardView.render(content, checklistItems, dnPath, tasks,
projects, adjacentData, resolvedInboxPath)`, which builds the whole tab body
synchronously from already-loaded data — no further async work happens inside it.

## Layout

```
Date navigator
└─ Daily Tasks (collapsible)
   ├─ Overdue tasks       (collapsible, sub-section)
   ├─ <Day>'s Checklist   (collapsible, sub-section)
   └─ Upcoming tasks      (collapsible, sub-section)
└─ Project Tasks (collapsible)
   ├─ Approaching Deadlines (collapsible, sub-section)
   └─ Priority Queue        (collapsible, sub-section)
```

Every collapsible section's open/closed state persists in
`settings.dashboardCollapsed`, keyed by a stable string (e.g. `"tasks.checklist"`), so
it survives the full DOM teardown that happens on every refresh.

### Date navigator

- `dashboardDate` is a `moment` kept on the `DashboardView` instance itself (not
  re-derived from settings), so it survives re-renders triggered by unrelated file
  changes.
- The prev/next buttons, the native date-picker input, and the "Today" button (shown
  only when not already on today) all just reassign `dashboardDate` and call
  `onRefresh()`, which re-runs `PMCompassView.render()` for the new date.
- Clicking the date label opens that day's note, creating it via
  `DayMarkdownFile.ensure()` first if it doesn't exist yet.

### Daily Tasks

Three sections, all built from `DayTask[]` (daily-note checklist lines) and all
funneling into the same row renderer, `renderDayTaskRow()`:

1. **Overdue tasks** (`renderAdjacentUnclosedSection`) — unclosed items from the past
   `unclosedDaysBefore` days. Only days that actually have unclosed items get a row;
   each row carries a clickable date label to that day's note.
2. **`<Day>`'s Checklist** (`renderChecklistSection`) — the picked day's own checklist.
   Habit-tagged items (tags include `#<dailyHabitsTag>`, default `#daily`) render
   first as their own group; the rest follow. This is the only one of the three whose
   rows can be **reordered by dragging** — see [inbox.md](inbox.md#drag-to-reorder) for
   the mechanics. The other two span several days' notes, where a manual order has
   nowhere to live; habit rows keep an inert grip for alignment but aren't draggable,
   since `reconcileRecurringHabits()` rewrites them into their definitions' `order` on
   every refresh (they're reordered from the settings tab instead).
3. **Upcoming tasks** — the same as Overdue but for the next `unclosedDaysAfter` days.

**Row rendering** (`renderDayTaskRow`), shared by all three:

- **Priority ribbon** (`BaseTabView.renderChecklistPriority()`, shared with the Inbox —
  see [inbox.md](inbox.md#row-rendering)) shows and edits the line's Obsidian Tasks
  marker, so a task scheduled out of the Inbox keeps a visible, editable priority. Inert
  on habit rows and on rows with no resolved file path.
- **Checkbox** toggles via `toggleChecklistItem()`, applied *optimistically*: rather
  than a full re-render, `rawLine`/`checked` on the in-memory `DayTask` and the row's
  CSS classes are patched directly once the write resolves.
- **Title** renders `item.habitMatchTitle(habitsTag)` — strips only the configured
  habits tag. Any other `#tag` on the line stays in the text and renders inline
  through Obsidian's real `MarkdownRenderer`, exactly as it would in the note itself.
- **Note chevron / edit-title / add-note** buttons are shared with `InboxView` via
  `day-task-row.ts`.
- **Reschedule / move-to-inbox / promote / delete** buttons only appear for non-habit,
  unchecked rows that have a resolved file path — a habit row shows a small icon
  instead, since its title belongs to the shared recurring definition rather than to
  this one day.
- **Promote** turns a day-note checklist line into an obsidian-pm task file via
  `BaseTabView.openPromoteModal()`, the same handler the Inbox uses; the row's own
  `filePath` is passed as the source, so the line is removed from whichever day note
  holds it (including an adjacent day's, in the overdue/upcoming sections). The
  conversion rules are documented in [inbox.md](inbox.md). `render()` stashes its
  `projects` argument on the instance for this: `renderDayTaskRow()` sits several
  levels below `render()` and would otherwise have to thread the list through.

### Project Tasks

Both sections read the same obsidian-pm `Task[]`/`Project[]` data, filtered to
`activeTasks` (status not `done` or `cancelled`).

**Priority/deadline inheritance.** Before either section runs,
`computeEffectiveValues(tasks, taskById)` (`model/task-scoring.ts`) walks each task's
`parentId` chain and lets it inherit an ancestor's priority or due date whenever the
ancestor's is more urgent — a subtask with no due date of its own shows its parent's;
a subtask under a critical-priority parent is treated as critical even with no
priority set directly on it. The walk stops at the first `done`/`cancelled` ancestor or
a cycle.

1. **Approaching Deadlines** (`selectApproachingDeadlines`) — active tasks (using
   effective values) due within the next 7 days, excluding tasks that are themselves a
   parent of another listed task, sorted by due date and then by priority.
2. **Priority Queue** (`selectPriorityQueue`) — every active task with an effective
   priority or due date, sorted by a combined urgency score and capped at 15,
   excluding anything already shown in Approaching Deadlines:

   ```
   score = deadlinePoints(due) + PRIORITY_SCORE[priority]

   deadlinePoints:  overdue → 1000   today → 500   tomorrow → 200
                    ≤3 days → 100    ≤7 days → 50   ≤14 days → 20   else → 5

   PRIORITY_SCORE:  critical → 400   high → 300   medium → 200   low → 100
   ```

Both sections render through `BaseTabView.renderTaskRow()` — shared with any other tab
that shows a `Task`: priority ribbon (click → priority dropdown), status badge (click
→ status dropdown), project badge, due-date label, edit button (opens `TaskModal`;
ctrl-click opens the note directly), row click hands off to the Task Graph view
(`BaseTabView.openInGraph()`, see [graph-display.md](graph-display.md)), right-click
opens an add-subtask/move/delete context menu.

An amber warning glyph may also appear on the row, flagging a parent/subtask completion
mismatch: an `unlink` icon when the task is still open but its parent is already completed
(`isOpenUnderCompletedParent`), or an `alert-triangle` when the task is itself completed
but still hides an open descendant (`isCompletedWithOpenSubtasks`, in `model/shared.ts`).
On these active-only sections only the `unlink` case fires — the rows are filtered to
active tasks — but both are checked here because `renderTaskRow` is shared with tabs that
may show completed tasks. Hover for the explanation.

### Moving a task

"Move task…" opens the same `MoveTargetModal` promotion uses, then calls
`moveTask(app, task, destination, allTasks, projects)` (`model/task-move.ts`). It
moves the task **and its whole subtree** (`collectDescendants`), to another parent,
another project, or both. Points worth knowing:

- **The picker is a single tree**, not a project list plus a parent list. Projects are
  the top level and selecting a project row means the project root. Every branch —
  project and task alike — starts shut and reveals one level at a time, so a deep
  project never dumps its whole subtree on you at once.
- **Selecting and expanding are separate.** The chevron is the only thing that opens or
  shuts a branch: clicking a row picks a destination and nothing more, so a branch
  holds whatever you last set it to for as long as the modal is open, and the whole
  lot resets to collapsed next time you open it. That separation is what lets a
  greyed-out destination (an illegal move, e.g. the task's own subtree, or the project
  the task already sits at the root of) still be opened to reach the legal rows
  beneath it.
- **The eye icon at the top right hides completed tasks**, and starts on: done and
  cancelled tasks are the bulk of an old project's tree and are almost never what you
  are moving work under, so the tree opens showing live work only. A completed task
  survives the cull when open work sits below it — hiding it would strand that work
  with no route to it — so a greyed-out "done" row in the tree is a signpost, not an
  oversight. Projects are never hidden: a project has no status, and its root stays a
  legal destination whatever its tasks look like. Turning the icon off restores the
  full tree.
- **Expanding opens straight through those signposts.** With the filter on, a done row
  is only in the tree because live work sits below it, so opening a branch keeps going
  through any done rows it leads with — however deep the chain — and stops at the first
  level holding something not done. Otherwise the survivors-as-signposts rule would
  just hand you a chain of rows that exist purely to be clicked through. They are
  ordinary branches once open, and shut again on their own chevron. With the filter off
  every done task is a real destination, so expanding reverts to one level a click.
- **A selection outlives its row going off screen**, whether you collapsed an ancestor
  or the eye icon culled it — you picked it deliberately, and a collapse is not a change
  of mind. So that it is never committed to invisibly, the tree marks the nearest row
  still on show along the way down to it with a dashed outline (`selectionMarkerKey`,
  `.pm-mt-row--holds-selection`) — dashed, where the selection itself is a solid accent
  fill. Worth knowing if you are reading the code expecting the simpler rule: an earlier
  cut dropped the selection when the eye icon hid it, which cost people a destination
  they had already chosen just for glancing at what was hidden.
- **Task rows carry a priority ribbon and a status pill**, read-only echoes of the
  dashboard row's (same `task-vocabulary.ts` colours, same `pm-dash-task-status` class,
  minus the dropdowns — the picker shows where a task sits, it isn't a place to edit
  it). The ribbon sits immediately before the title rather than at the row's far left,
  so it tracks the indent and reads as belonging to its task. A project row's ribbon
  takes the project's own colour, which keeps every label preceded by a bar.
- **Task titles render as markdown** (`renderTaskTitle`, as the views do), so wikilinks
  and tags read the same here as on the dashboard instead of as raw `[[…]]`. CSS makes
  them inert: clicking a link would navigate the workspace behind the modal, so a click
  anywhere on the row picks it. A `Modal` isn't a `Component`, so unlike the views —
  which hand `MarkdownRenderer` their plugin — this one owns a `Component` it loads on
  open and unloads on close.
- **Obsidian's own close button (the top-right X) is removed** in `onOpen`, since it
  only duplicates the Cancel button in the footer, and on mobile its 44px box would
  crowd the eye toggle out of the corner. Cancel is then the one way out; the eye
  toggle takes the freed corner, the heading taking the horizontal slack via flex.

- **A same-project reparent moves no files.** Every task in a project lives directly in
  one flat `<project>_tasks/` folder whatever its depth — nesting is `parentId` alone —
  so only a change of project relocates anything (via `fileManager.renameFile`, for the
  task and every descendant, with `-2` suffixing on filename collisions).
- **The moved task's dependencies are cleared.** `isValidDependencyTarget` requires
  dependencies to share a project *and* a parent, so any move invalidates them by
  definition; its siblings stay behind. Dependencies *inside* the moving subtree
  survive, since the whole subtree travels together. Tasks elsewhere that depended on
  anything moved are pruned.
- **`type` follows depth**: `subtask` when nested, `task` at root; `milestone` survives
  a move between projects but is lost through a nest-then-unnest round trip.
- **Destinations inside the task's own subtree are refused** (`isValidMoveTarget`),
  and the picker greys them out with the reason rather than letting the move fail.
- **The frontmatter write is the commit point.** `parentId`/`projectId` are all
  `loadVaultData` reads, so the `subtaskIds`/`## Subtasks` and `taskIds`/`## Tasks`
  lists are denormalized copies maintained for obsidian-pm's benefit. Writes are
  ordered so a crash leaves a correct tree with at worst a stale link section, and
  every step is idempotent — re-running the same move repairs it.

## Refresh & consistency

- `PMCompassView` watches every path in `watchedDailyPaths` (the current day's file,
  any adjacent-day file that has unclosed items, and the Inbox file) via vault
  `modify`/`create` events — debounced 300ms for creates and 2000ms for modifies, long
  enough not to fight active typing — and any file under the projects folder via
  `metadataCache`'s `changed`/vault's `delete` events (which also auto-stamps a
  `completed` date if a task's status flips to `done` from an edit made outside the
  plugin).
- Every refresh reloads all data sources from scratch; there is no incremental patch
  path. UI state that should survive a refresh — open note panels, scroll position,
  collapsed sections, which tab is active — is tracked separately (`openNoteKeys`,
  `dashboardCollapsed` in settings, a manual scroll-top save/restore around the DOM
  swap) rather than being derived from keeping the old DOM around.

## Related documents

- [overview.md](overview.md) — what the plugin is for and how its features fit together
- [class-map.html](class-map.html) — full class map; `DashboardView` sits under "Tab views"
- [graph-display.md](graph-display.md) — the Task Graph view a Dashboard row hands off to
