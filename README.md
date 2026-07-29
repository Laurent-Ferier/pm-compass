# pm-compass

An Obsidian plugin that adds a task dashboard, an inbox, a weekly review, and a
dependency graph on top of two things your vault already has: project/task notes from
[obsidian-pm](https://github.com/stepankropachev/obsidian-pm) and checklist items in
Obsidian's core Daily Notes. It reads and edits those files directly — there's no
separate database, and everything it does is a normal markdown edit you can also make
by hand.

## What it adds to Daily Notes

Daily-note checklists work as plain `- [ ] ...` lines, compatible with the emoji-date
format used by the community Tasks plugin (`➕` created, `📅` due, `⏳` scheduled,
`✅` completed, plus priority emoji), so they stay readable with or without this
plugin installed. On top of that, PM Compass adds:

- **Recurring habits** — define a habit once (daily, or specific weekdays) in
  settings, and its checklist line is inserted into each day's note automatically,
  reconciled whenever you open or create that day's note.
- **An Inbox** — a dedicated note for quick-capture tasks that don't belong to a
  specific day yet, with age tracking and a staleness warning past a configurable
  threshold. Checking an Inbox item off moves it to today's note as done, rather than
  deleting it, so closing from the Inbox still leaves a record of when it happened.
- **One-tap actions on any checklist item** — reschedule to another day, move to the
  Inbox, promote it to a project task, delete, or attach a note to it, all without
  opening the underlying file.
- **A ramp from checklist to project** — a line in the Inbox or today's note can be
  promoted into a real obsidian-pm task file, under an existing project or a new one,
  without retyping it: its dates, tags, priority, and indented notes come along. An
  item that has been aging in the Inbox usually just needed a home, not a deadline.

## What it adds to Project Manager

obsidian-pm's project/task notes are read as-is (same frontmatter, same files) and get
a few things obsidian-pm alone doesn't provide:

- **A dependency graph** — every task and project rendered as an interactive graph
  (the Task Graph view), instead of only a flat note. Tasks can be created, edited, and
  deleted inline, moved to another parent or project (subtasks included), and wired up
  with dependencies by drag-to-connect.
- **Priority and deadline that flow downhill** — a subtask with no due date or
  priority of its own inherits its parent's, whichever is more urgent, so a deadline
  set once on a project task is automatically reflected everywhere underneath it.
- **A single ranked queue** — the Dashboard's Approaching Deadlines and Priority Queue
  surface what's actually urgent across every project at once, instead of opening each
  project note to check.
- **A weekly rollup** — the Week Summary tallies what was completed, created, put in
  progress, or blocked this week, across all projects.
- **Quick edit everywhere** — priority and status can be changed from a dropdown right
  on a task's row, in the Dashboard or the graph, without opening its note.
- **Settings sync** — the projects folder is read from obsidian-pm's own settings on
  startup, so it only needs to be configured once.

## Dashboard

The Dashboard is the plugin's main view (a sidebar tab, not a separate window) and the
one place daily checklist items and obsidian-pm project tasks show up together: the
picked day's checklist plus unclosed items from the surrounding days, so nothing
quietly falls off the bottom of an old note; and, for project tasks, what's due soon
and what's worth working on next, ranked automatically so priority set on a parent
task is reflected in its subtasks too. Clicking a project task opens it in the **Task
Graph**, a separate view of every task and its dependencies as an interactive graph.

Technical details: [docs/dashboard.md](docs/dashboard.md), [docs/graph-display.md](docs/graph-display.md).

## Inbox

The Inbox is where a task goes when it doesn't belong to a specific day yet — capture
it without deciding when to work on it. From there it can be scheduled onto a day,
closed straight from the list, promoted into a project task, or left to age; anything
sitting untouched past a configurable threshold is flagged so it doesn't get
forgotten. Promoting is the usual answer to that flag: an item rots in the Inbox when
it was never a one-day task to begin with. Each item can also carry a priority — set
from the coloured ribbon on its row, stored as the Obsidian Tasks marker the note
itself shows — and the list can be sorted by it instead of by capture date.

Technical details: [docs/inbox.md](docs/inbox.md).

## Week Summary

The Week Summary answers two questions: are the habits you set out to keep actually
sticking, and what happened on your projects this week. Each recurring habit shows how
many days it was completed; each day shows how much of that day's checklist got closed
on time versus late; and project tasks completed, created, in progress, or blocked
this week are all one click away.

Technical details: [docs/week-summary.md](docs/week-summary.md).

## Setup

Requirements, install/verify commands, building the plugin, and installing it into a
vault: [docs/setup.md](docs/setup.md).

## Documentation

- [docs/overview.md](docs/overview.md) — goals and full feature list
- [docs/dashboard.md](docs/dashboard.md) — Dashboard data flow and scoring algorithm
- [docs/inbox.md](docs/inbox.md) — Inbox data flow and actions
- [docs/week-summary.md](docs/week-summary.md) — Week Summary aggregation
- [docs/settings.md](docs/settings.md) — settings reference and recurring-habit reconciliation
- [docs/graph-display.md](docs/graph-display.md) — Task Graph view rendering internals
- [docs/class-map.html](docs/class-map.html) — class relationships and responsibilities
- [docs/setup.md](docs/setup.md) — requirements, build, install, release
- [docs/preview/](docs/preview/) — rendering a style change in a browser, and measuring it on a phone

## Development

This plugin was built with extensive use of [Claude Code](https://claude.com/claude-code)
(Claude Sonnet), from initial implementation through ongoing features and fixes.
