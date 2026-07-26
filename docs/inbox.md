# Inbox — Technical Description

`InboxView` (`ui/inbox-view.ts`, extends `BaseTabView`) is the second of the three
tabs `PMCompassView` owns. It renders one file — a dedicated Inbox note — as a flat
list of untriaged `DayTask` checklist items, with actions to schedule, close, promote,
edit, or delete each one. See [class-map.html](class-map.html) for how it sits in the
wider class graph, and [overview.md](overview.md) for how it fits alongside the
Dashboard.

## Which file it reads

`resolveInboxPath(inboxFilePath, dnConfig)` (`model/day-task-actions.ts`) decides the
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
   items missing that key (no `➕`, no `📅`, no priority marker) stay last either way,
   and ties still break newest-first:
   - `InboxSortBy.Created` (the default) — `createdAt` descending (newest first); undated items —
     task lines added without a `➕` marker — sort after all dated ones, in their
     original file order.
   - `InboxSortBy.Priority` — most urgent first (`priorityRank`, which also ranks
     `Priority.Lowest`, the `⏬` level absent from `PRIORITIES`), items with no marker
     last, falling back to the date order above within one level.
   - `InboxSortBy.Due` — soonest `📅` deadline first, items with no deadline last (an undated item
     is never more urgent than a dated one), falling back to the date order within one
     deadline.
   - `InboxSortBy.Title` — alphabetical, case- and accent-insensitive (`localeCompare` with
     `sensitivity: "base"`), so `Écrire` sorts with `ecrire` rather than after every
     ASCII title, and numeric-aware so `Task 2` precedes `Task 10`.
   - `InboxSortBy.File` — no sorting: `lineIndex` ascending, i.e. exactly the order the lines
     appear in the Inbox file. Labelled "Default" in the UI.

Beyond the Inbox list itself, `PMCompassView.render()` also uses `readInboxItems()`'s
result to decide whether the **Inbox tab button** needs a staleness warning badge
(`hasStaleInboxItems`, checked against `settings.inboxStaleAfterDays` the same way
individual rows are — see below), so a stale item is visible even from another tab.

## Row rendering

Each row (built directly in `InboxView.render()`, not factored into a separate method
the way `DashboardView.renderDayTaskRow()` is) shows:

- **Reorder grip** — only in the "Default" (file order) mode; see [Drag to
  reorder](#drag-to-reorder) below.
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
- **Age badge** — `Math.floor((now - createdAt) / 1 day)`, shown as `"<n> d"`. Items
  with no `createdAt` (no `➕` marker) show no badge at all. Past `OLD_AGE_DAYS` (14,
  a fixed constant independent of the setting below) the badge switches to a red
  "old" style.
- **Stale warning** — a separate `⚠️` icon, shown only when `staleAfterDays > 0` (the
  `inboxStaleAfterDays` setting, default 7) and the item's age has reached that
  threshold. Sharing the same "old" cutoff would conflate a user-tunable warning with
  a fixed visual escalation, so the two are computed and rendered independently.
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
labelled with the current mode and opens a dropdown of all five: "Created",
"Priority", "Deadline", "Title" and "Default" (`INBOX_SORT_MODES`/
`INBOX_SORT_LABELS` in `inbox-view.ts`). Picking the mode already in effect is a no-op;
picking another saves `settings.inboxSortBy` and refreshes. A stored mode outside
`INBOX_SORT_MODES` — only reachable by hand-editing `data.json` — narrows to "Created"
before anything looks a label up, since those lookups would otherwise throw and take the
whole tab's render with them. The button's text carries the mode for the eye and its
`aria-label` repeats it for screen readers, which would otherwise hear only the affordance.

To its right, a second button (`.pm-inbox-sort-dir-btn`) flips that mode's direction. It
carries an arrow icon and no text; its tooltip names the order a click would give, in the
current mode's own terms — "Oldest first", "Least urgent", "Latest", "Z → A", "File order"
(`INBOX_SORT_DIR_LABELS`). Direction is stored per mode in `settings.inboxSortDir` and
resolved by `resolveInboxSortDir()` against each mode's default (`InboxSortDir.Desc` for
created/priority, `InboxSortDir.Asc` for the rest), so setting "Title" to Z → A leaves the other
modes alone.

Either way the reordering happens in `readInboxItems()` on the next read, not in the
view.

## Drag to reorder

In the "Default" mode — and only there — each row gets a grip at its leading edge that
drags the row to a new position (`createDragReorder()` in `src/ui/drag-reorder.ts`,
shared with the Dashboard's checklist section). Every other mode recomputes the order
from the items' own fields on the next refresh, which would silently undo the move the
moment it was made, so no grip is offered. A single-item list gets none either.

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

A sticky input at the bottom of the tab (`.pm-inbox-add-bar`) appends a new item on
Enter via `appendInboxItem()`, which is `DayMarkdownFile.createTask(title, new
Date())` — a brand-new unchecked line with today's date as its `➕` creation marker,
appended to the end of the Inbox file. The input clears and disables itself
immediately on submit (re-enabling once the write settles) so a second Enter before
the write completes can't create a duplicate item.

## Promotion — from checklist line to task file

`promoteChecklistItem(app, sourcePath, item, target, opts)`
(`model/checklist-promote.ts`) is the one bridge between the plugin's two task shapes
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
