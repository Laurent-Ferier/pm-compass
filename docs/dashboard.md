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
   first as their own group; the rest follow.
3. **Upcoming tasks** — the same as Overdue but for the next `unclosedDaysAfter` days.

**Row rendering** (`renderDayTaskRow`), shared by all three:

- **Checkbox** toggles via `toggleChecklistItem()`, applied *optimistically*: rather
  than a full re-render, `rawLine`/`checked` on the in-memory `DayTask` and the row's
  CSS classes are patched directly once the write resolves.
- **Title** renders `item.habitMatchTitle(habitsTag)` — strips only the configured
  habits tag. Any other `#tag` on the line stays in the text and renders inline
  through Obsidian's real `MarkdownRenderer`, exactly as it would in the note itself.
- **Note chevron / edit-title / add-note** buttons are shared with `InboxView` via
  `day-task-row.ts`.
- **Reschedule / move-to-inbox / delete** buttons only appear for non-habit, unchecked
  rows that have a resolved file path — a habit row shows a small icon instead, since
  its title belongs to the shared recurring definition rather than to this one day.

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
opens an add-subtask/delete context menu.

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
