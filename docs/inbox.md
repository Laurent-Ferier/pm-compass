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
2. Results are sorted by `createdAt` descending (newest first); undated items — task
   lines added without a `➕` marker — sort after all dated ones, in their original
   file order.

Beyond the Inbox list itself, `PMCompassView.render()` also uses `readInboxItems()`'s
result to decide whether the **Inbox tab button** needs a staleness warning badge
(`hasStaleInboxItems`, checked against `settings.inboxStaleAfterDays` the same way
individual rows are — see below), so a stale item is visible even from another tab.

## Row rendering

Each row (built directly in `InboxView.render()`, not factored into a separate method
the way `DashboardView.renderDayTaskRow()` is) shows:

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
  time, completed tasks hidden by default, plus a "+ New project…" row) and hands the
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
| `🔺⏫🔼🔽` priority | `priority` — `⏬` ("lowest") folds to `low`, which has no counterpart in `PRIORITIES` |
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

Picking "+ New project…" calls `ProjectFile.create` first, which writes the full
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
