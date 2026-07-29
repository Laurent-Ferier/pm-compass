# Inbox — Technical Description

`InboxView` (`ui/inbox-view.ts`, extends `BaseTabView`) is the second of the three
tabs `PMCompassView` owns. It renders one file — a dedicated Inbox note — as a flat
list of untriaged `DayTask` checklist items, with actions to schedule, close, promote,
edit, or delete each one. See [class-map.html](class-map.html) for how it sits in the
wider class graph, and [overview.md](overview.md) for how it fits alongside the
Dashboard.

## Which file it reads

`resolveInboxPath(inboxFilePath, dnConfig)` (`model/operations/day-task-actions.ts`) decides the
Inbox note's path: the user-configured `settings.inboxFilePath` if set, otherwise
`<Daily Notes folder>/Inbox.md`, falling back to `Inbox.md` at the vault root if no
Daily Notes folder is configured either. The file is created on first write (via
`DayMarkdownFile.createTask`/`addTask`) — nothing needs to pre-exist.

## Data flow

`PMCompassView.render()` loads Inbox data unconditionally on every render (in parallel
with the Dashboard's own data — see [dashboard.md](dashboard.md)), via
`readInboxItems(app, resolvedPath)`:

1. `DayMarkdownFile.removeCheckedTasks()` parses every line, **deletes any already-
   checked lines from the file**, and returns only the unchecked tasks. This is a
   side-effecting read: checked items normally shouldn't exist in the Inbox (closing
   an item moves it out, see below), but this is a safety net if one was checked by
   some other means, so the list never has to render a checked row.
2. Results are ordered by `sortInboxItems(tasks, settings.inboxSortBy, dir)`, where the
   mode is an `InboxSortBy` enum member (its value is what gets persisted), and
   `dir` is `resolveInboxSortDir(sortBy, settings.inboxSortDir)`. The orders below are
   each mode's default direction; the opposite direction flips the mode's key only —
   items missing that key (no `➕`, no `📅`, no priority marker) stay last either way.
   Whatever the mode, tasks it cannot tell apart are ordered by priority (most urgent
   first, whichever way the mode itself reads) and then newest-first — bar `File`, whose
   ties are settled by creation date first, since its own key is a fact about the file
   rather than a judgement about the task. The mode button's tooltip names that chain
   (`INBOX_SORT_CHAINS`). A project task sorts
   by the values *in force* — `computeEffectiveValues`' roll-ups, which is what its row
   shows — so a subtask under a critical parent ranks critical rather than unset:
   - `InboxSortBy.Created` (the default) — `createdAt` descending (newest first); undated items —
     task lines added without a `➕` marker — sort after all dated ones, in their
     original file order.
   - `InboxSortBy.Priority` — most urgent first (`priorityRank`, which also ranks
     `Priority.Lowest`, the `⏬` level absent from `PRIORITIES`), items with no marker
     last, then by the priority the task carries itself — so two subtasks of one high
     parent order high before medium — falling back to the date order above.
   - `InboxSortBy.Due` — soonest `📅` deadline first, items with no deadline last (an undated item
     is never more urgent than a dated one), falling back to the date order within one
     deadline. Selectable only where something carries a deadline — see [Sort bar](#sort-bar).
   - `InboxSortBy.Title` — alphabetical, case- and accent-insensitive (`localeCompare` with
     `sensitivity: "base"`), so `Écrire` sorts with `ecrire` rather than after every
     ASCII title, and numeric-aware so `Task 2` precedes `Task 10`.
   - `InboxSortBy.File` — no sorting: `lineIndex` ascending, i.e. exactly the order the lines
     appear in the Inbox file. Labelled "Default" in the UI.

Beyond the Inbox list itself, `PMCompassView.render()` also uses `readInboxItems()`'s
result to decide whether the **Inbox tab button** needs a staleness warning badge
(`hasStaleInboxItems`, checked against `settings.inboxStaleAfterDays` the same way
individual rows are — see below), so a stale item is visible even from another tab.

## What the list holds

The Inbox's own untriaged lines, and — the dashboard being merged — the project tasks
carrying a priority that nothing dates (`selectUndatedTasks`, `model/task-scoring.ts`).
The merged dashboard's horizons are days, so an undated task has none to sit in; the Inbox
is already where work waiting to be planned lives, and giving one a deadline from its
toolbar is what moves it onto the dashboard. The dashboard's own rows carry the reverse:
"Move to inbox" clears the deadline, sending the task back here.

Both kinds go through `TaskList` (`ui/task-list.ts`), the same class every dashboard list
is built on — see [dashboard.md](dashboard.md) for what it owns:

- **Merged** (`mergeDailyAndProjectTasks`, the default) — one list, untitled, with the sort
  button's order applied across both kinds (`sortInboxItems` takes any `BaseTask`): a
  project task sorts among the inbox's lines by priority, deadline, title or creation date,
  since both kinds have those. Only "Default" (file order) keeps them apart, and puts them
  last — a position in the Inbox file is a property of the file, which they have no line in.
- **Split** — two lists, "Inbox items" and "Project tasks with no deadline", each named so
  neither is mistaken for the other. A title is only added when there *is* a second list:
  with no undated project tasks the Inbox shows one unnamed list either way.

## Row rendering

An inbox row and a dashboard checklist row are the same row: `BaseTabView.renderDayTaskRow()`
draws the whole middle of it — the `<li>`, its main line, the grip's slot, the priority
ribbon, the toggle box, the title, the note chevron and the habit icon — and each view
appends only its own ends, `badges` after the title and `actions` at the trailing edge.
That shared skeleton is what keeps the two tabs' lists on one grid; they drifted apart when
each drew its own. `InboxView.renderInboxRow()` is the Inbox's half of it, and shows:

- **The leading slot** — the reorder grip in the "Default" (file order) mode, the recurring
  mark on a habit, the ⏳ target day on an item already aimed at one (clicking it shows that
  day), and the inbox glyph on everything else. One of them on every row, all the same
  width, so the Inbox's list and the Dashboard's line up. See [Drag to
  reorder](#drag-to-reorder) below.
- **Toggle box** — the dashboard's own `pm-dash-checkbox`, closing the item
  (`closeInboxItem`) rather than ticking a line. It replaced a native `input[type=checkbox]`,
  whose width was one of the things that put the two lists on different grids.
- **Priority ribbon** — a coloured bar just inside the grip (whose tap zone is widened
  well past the 4px bar by a transparent overlay, see `styles.css`), rendered by the same
  `renderPriorityRibbon()` the Dashboard's project-task rows use. Clicking it opens the
  `PRIORITIES` dropdown and writes the pick straight into the line's Obsidian Tasks
  marker (`🔺⏫🔼🔽`) via `setChecklistItemPriority()` → `DayMarkdownFile.updatePriority()`,
  so the value is the same one `promoteChecklistItem` later reads (see below) and the
  one the Tasks plugin renders in the note itself. Habit rows keep the ribbon (so rows
  stay aligned) but not the click handler: a habit line is regenerated from its
  definition, which would drop the marker on the next reconcile. The renderer itself
  (`BaseTabView.renderChecklistPriority()`) is shared with the Dashboard's day checklist,
  so scheduling an item onto a day keeps its priority both on the line and on screen.
- **Checkbox** — *not* a plain toggle. Checking it calls `closeInboxItem()`, which
  removes the line from the Inbox and re-adds it to **today's** daily note, marked
  done with a `✅` timestamp, preserving any sub-lines. Closing from the Inbox is
  therefore not a delete — it leaves a record of when the task was actually done, and
  on the day it was done, not the day it was captured.
- **Title** — `item.habitMatchTitle(habitsTag)`: strips only the configured habits
  tag; any other `#tag` renders inline via Obsidian's `MarkdownRenderer`, same as the
  Dashboard.
- **Habit icon** — shown instead of an edit-title button when the item carries the
  habits tag, since a habit line's title belongs to the shared recurring definition
  (see [settings.md](settings.md)), not to this one Inbox line.
- **⏳ target badge** — the day the item is planned for, on an item carrying one. Clicking
  it takes the Dashboard to that day, like every other date badge on the row. Red once
  that day is past: the note it was waiting for never came, and since a planned item is
  exempt from the staleness warning below, this badge is what says so.
- **Age badge** — the item's creation day through `BaseTabView.renderDateBadge()`, the one
  date badge every row in the plugin uses: `"today"` on the day itself, `"<n> d"` once it is
  past — the Inbox's ages and the Dashboard's deadlines therefore read alike. Items with no
  `createdAt` (no `➕` marker) show no badge at all. Past `OLD_AGE_DAYS` (14, a fixed
  constant independent of the setting below) the badge switches to a red "old" style.
  Clicking it takes the Dashboard to that day, as every other date badge does.
- **Stale warning** — a separate `⚠️` icon, shown only when `staleAfterDays > 0` (the
  `inboxStaleAfterDays` setting, default 7) and the item's age has reached that
  threshold. Sharing the same "old" cutoff would conflate a user-tunable warning with
  a fixed visual escalation, so the two are computed and rendered independently.
  An item carrying a `⏳` target day is exempt whatever its age — `isStaleInboxItem`
  (`model/day-task.ts`), the one rule both this badge and the tab's read: it isn't
  untriaged work piling up, it is planned, so its age badge goes `quiet` (no glyph, and
  no red "old" escalation either). A plan that went by unhonoured reddens its own ⏳
  badge instead, which says the thing that needs saying — the day, not the wait.
- **Note chevron / add-note / edit-title** — shared with the Dashboard via
  `day-task-row.ts`.
- **Promote button** — the answer to an item that has aged past its threshold because
  it was never a "today" task in the first place. Opens `MoveTargetModal` (one
  collapsible tree of every project, each opening into its task tree a level at a
  time, completed tasks hidden by default, plus a "New project…" row) and hands the
  choice to `promoteChecklistItem()`, which converts the line into
  an obsidian-pm task file and deletes it from the Inbox. Hidden for habit items,
  which are regenerated from their definition and would only be stranded by a promote.
  The same button appears on Dashboard rows — see [dashboard.md](dashboard.md); an
  Inbox line and a day-note line are the same `DayTask` in the same kind of file, so
  the only per-caller difference is which file the line is removed from.
- **Schedule button** — reuses `day-task-row.ts`'s `appendRescheduleButton()` (the
  same date-picker button the Dashboard uses to reschedule), wired to
  `scheduleInboxItem()`: removes the line from the Inbox and adds it, unchanged, to
  the target day's note (creating that note if needed). Labeled "Schedule" here rather
  than "Reschedule", since an Inbox item was never on a day to begin with.
- **Delete** — `removeInboxItem()` behind a `ConfirmModal`, a plain delete (unlike
  closing, nothing is preserved).

## Sort bar

A button above the list (`.pm-inbox-sort-bar`, hidden when the inbox is empty) is
labelled with the current mode and opens a dropdown of the five: "Created",
"Priority", "Deadline", "Title" and "Default" (`INBOX_SORT_MODES`/
`INBOX_SORT_LABELS` in `inbox-view.ts`). Picking the mode already in effect is a no-op;
picking another saves `settings.inboxSortBy` and refreshes.

"Deadline" can only be taken where there is one to read: `hasSortableDeadline` asks the same
key the mode sorts on (`day-task-actions.ts`), and with nothing dated — which is the norm in
a list of untriaged lines and undated project tasks — picking it would leave the list
untouched and read as broken. It is **disabled**, not hidden: `openDropdown` takes a
`disabled` flag, which fades the item, marks it `aria-disabled` and drops its click handler,
with the reason in its tooltip. The list of modes is what says which modes exist, so a mode
that can't be taken here still has to appear. A mode that isn't on offer — "Deadline" with
nothing dated, or a value outside `INBOX_SORT_MODES`, only reachable by hand-editing
`data.json` — narrows to "Created" before anything looks a label up, since those lookups
would otherwise throw and take the whole tab's render with them. The button's text carries the mode for the eye and its
`aria-label` repeats it for screen readers, which would otherwise hear only the affordance;
its tooltip names what the mode actually orders by, key and tie-breaks both
(`INBOX_SORT_CHAINS`) — "File order, then creation date", "Title, then priority, then
creation date", and so on.

To its right, a second button (`.pm-inbox-sort-dir-btn`) flips that mode's direction. It
carries an arrow icon and no text; the arrow shows the direction **in effect**, and so does
the tooltip, in the mode's own terms, with the flip spelled out after it — "Newest first —
click for Oldest first" (`INBOX_SORT_DIR_LABELS`). The two halves have to agree: naming
only the flip there made the arrow and the tooltip contradict each other, which reads as
the list being sorted backwards. Direction is stored per mode in `settings.inboxSortDir`
and resolved by `resolveInboxSortDir()` against each mode's default (`InboxSortDir.Desc`
for created/priority, `InboxSortDir.Asc` for the rest), so setting "Title" to Z → A leaves
the other modes alone.

The view sorts what it displays (`InboxView.render` → `sortInboxItems`), rather than
trusting the order `readInboxItems()` handed it — merged, the project tasks have to take
their place among the inbox's own lines.

## Drag to reorder

In the "Default" mode — and only there — each row gets a working grip at its leading edge
that drags the row to a new position (`createDragReorder()` in `src/ui/drag-reorder.ts`,
shared with the Dashboard's lists). Every other mode recomputes the order from the items'
own fields on the next refresh, which would silently undo the move the moment it was made,
so the grip stays inert. A single-item list, and a project-task row, are inert too — the
grip's width is still rendered (`renderInertDragHandle`), which is what keeps every row's
ribbon and title on the same line whatever list it is in.

The mechanics, which are what make this work inside Obsidian rather than in a browser:

- **Pointer events, not HTML5 drag-and-drop**, whose `dragstart` never fires on mobile.
  `pointermove`/`pointerup` are tracked on `activeDocument` (the pointer leaves the grip
  almost immediately, and pointer capture isn't reliable across Obsidian's mobile
  WebViews), and the grip carries `touch-action: none` so a touch drag doesn't scroll
  the list instead.
- **A dedicated grip rather than the whole row**, so a finger dragged anywhere else
  still scrolls. A press only becomes a drag past `DRAG_THRESHOLD_PX`, so a tap doesn't
  jitter the list, and the grip swallows the click such a press ends in — the row would
  otherwise read it as `attachActionsTapToggle`'s "open the toolbar" tap. A *completed*
  drag needs no guard: the dragged row is `pointer-events: none` throughout, so press and
  release land on different elements and the click goes to their common ancestor, the list.
- **No reshuffling during the drag**: the dragged row is translated under the pointer
  (`--pm-reorder-offset`) and a 2px indicator (`--pm-reorder-top`) marks where it would
  land. Every other row keeps its geometry, so their rects are measured once when the drag
  begins and the per-frame work is arithmetic rather than a reflow per row. A frame loop is
  needed regardless, since a finger held at the list's edge must keep auto-scrolling while
  emitting no move events at all; that is also the only thing that moves the cached rects,
  and it moves them all together, so the pointer is simply corrected by the scroll delta.

The drop is reported as the dragged item's new *visual* neighbours, which the view
translates into a file position. In `InboxSortDir.Asc` that's the row below the drop; in
"Reversed" the list reads bottom-up, so it's the row *above* it — and a drop at the
visual top is the end of the file. Either way it lands in `reorderChecklistItem()` →
`DayMarkdownFile.moveTaskBefore(item, anchor)`, which takes the destination as a
neighbouring task rather than a line index: both ends are re-resolved from freshly read
content inside the file lock, so a move decided from a rendered list stays correct even
if the file shifted underneath it since that render. A null anchor appends after the
last *task*, not at EOF, so dropping at the bottom of the list can't push the line past
trailing content that isn't a task at all.

## Add bar

A sticky input at the bottom of the tab (`.pm-add-bar`, drawn by
`BaseTabView.renderAddBar()` and shared with the Dashboard) appends a new item on
Enter via `appendInboxItem()`, which is `DayMarkdownFile.createTask(title, new
Date())` — a brand-new unchecked line with today's date as its `➕` creation marker,
appended to the end of the Inbox file. The input clears and disables itself
immediately on submit (re-enabling once the write settles) so a second Enter before
the write completes can't create a duplicate item.

## Promotion — from checklist line to task file

`promoteChecklistItem(app, sourcePath, item, target, opts)`
(`model/operations/checklist-promote.ts`) is the one bridge between the plugin's two task shapes
(see [overview.md](overview.md)). It is a **one-way conversion, not a link**: nothing
connects the resulting task file back to the line it came from, and nothing brings it
back.

How each part of the line is translated:

| Line | Task frontmatter |
| --- | --- |
| title, minus every `#tag` (`item.displayTitle(habitsTag)`) | `title` |
| `#tags` | `tags` (leading `#` stripped) |
| `🛫` start / `📅` due | `start` / `due` |
| `🔺⏫🔼🔽` priority | `priority` — `Priority.Lowest` (`⏬`) folds to `Low`, having no counterpart in `PRIORITIES` |
| *no priority marker* | `priority: medium` — most lines carry none, and landing them unset would sort them below every task that has one |
| indented sub-lines | `description` |
| — | `status: todo`, `progress: 0`, `dependencies: []` |
| chosen parent | `parentId` + `type: subtask`; otherwise `type: task` |

A task landing at a project's **root** is also registered in the project file's
`taskIds` and `## Tasks` list (`ProjectFile.addTaskLink`); a nested one is registered
in its parent's `subtaskIds`/`## Subtasks` instead. Neither list is read by this
plugin — `loadVaultData` derives the tree from `projectId`/`parentId` alone — but the
obsidian-pm plugin's own board reads them, so a promoted task would be invisible there
without this step.

Picking "New project…" calls `ProjectFile.create` first, which writes the full
obsidian-pm project schema (including `customFields`/`teamMembers`/`savedViews`, which
this plugin never reads) so the result is indistinguishable from a project made there.
That schema is owned by obsidian-pm, not this repo.

**Write order.** The Inbox line is deleted **last**, following the rule
`rescheduleChecklistItem` already sets: confirm the target exists before touching the
source. A crash mid-way therefore leaves a visible duplicate — the new task plus the
original line — rather than losing the item.

## Refresh

Most mutations (`closeInboxItem`, `scheduleInboxItem`, `removeInboxItem`,
`appendInboxItem`) are a single `DayMarkdownFile` write followed by `this.onRefresh()`.
Promotion is the exception: it writes a task file, possibly a project file, and a
parent/project link before deleting the line (see above). Either way there's no
optimistic local patch here the way the Dashboard's checkbox toggle has; the whole tab
re-renders from a fresh `readInboxItems()` read after every action.

## Related documents

- [overview.md](overview.md) — what the plugin is for and how its features fit together
- [dashboard.md](dashboard.md) — the tab the Inbox shares its row-rendering building blocks with
- [settings.md](settings.md) — Inbox file path and staleness threshold settings
- [class-map.html](class-map.html) — full class map; `InboxView` sits under "Tab views"
