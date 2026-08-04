# pm-compass

An Obsidian plugin that adds a task dashboard, an inbox, a weekly review, and a dependency graph on top of two things your vault already has: project/task notes from [obsidian-pm](https://github.com/stepankropachev/obsidian-pm) and checklist items in Obsidian's core Daily Notes. It reads and edits those files directly — there's no separate database, and everything it does is a normal markdown edit you can also make by hand.

## What it adds to Daily Notes

Daily-note checklists work as plain `- [ ] ...` lines, compatible with the emoji-date format used by the community Tasks plugin (`➕` created, `📅` due, `⏳` scheduled, `✅` completed, plus priority emoji), so they stay readable with or without this plugin installed. On top of that, PM Compass adds:

- **Recurring habits** — define a habit once (daily, or specific weekdays) in settings, and its checklist line is inserted into each day's note automatically, reconciled whenever you open or create that day's note.
- **An Inbox** — a dedicated note for quick-capture tasks that don't belong to a specific day yet, with age tracking and a staleness warning past a configurable threshold. Checking an Inbox item off moves it to today's note as done, rather than deleting it, so closing from the Inbox still leaves a record of when it happened.
- **One-tap actions on any checklist item** — reschedule to another day, move to the Inbox, promote it to a project task, delete, or attach a note to it, all without opening the underlying file.
- **A ramp from checklist to project** — a line in the Inbox or today's note can be promoted into a real obsidian-pm task file, under an existing project or a new one, without retyping it: its dates, tags, priority, and indented notes come along. An item that has been aging in the Inbox usually just needed a home, not a deadline.

## What it adds to Project Manager

obsidian-pm's project/task notes are read as-is (same frontmatter, same files) and get a few things obsidian-pm alone doesn't provide:

- **A dependency graph** — every task and project rendered as an interactive graph (the Task Graph view), instead of only a flat note. Tasks can be created, edited, and deleted inline, moved to another parent or project (subtasks included), and wired up with dependencies by drag-to-connect.
- **Priority and deadline that flow downhill** — a subtask with no due date or priority of its own inherits its parent's, whichever is more urgent, so a deadline set once on a project task is automatically reflected everywhere underneath it.
- **A single ranked queue** — the Dashboard's Priority Queue surfaces what's actually urgent across every project at once, overdue first, instead of opening each project note to check.
- **A weekly rollup** — the Week Summary tallies what was completed, created, put in progress, or blocked this week, across all projects.
- **Quick edit everywhere** — priority and status can be changed from a dropdown right on a task's row, in the Dashboard or the graph, without opening its note.
- **Settings sync** — the projects folder is read from obsidian-pm's own settings on startup, so it only needs to be configured once.

The Dashboard is the one view where both kinds of task appear together; every other tab shows exactly one of them.

## Data model

Two independent shapes feed the UI. They are read from different files in different formats and are never merged into one record — nothing links an instance of one to an instance of the other:

- **`Task` / `Project`** (`model/project/`) — parsed from obsidian-pm frontmatter under the configured projects folder by `loadVaultData()`. Carries status, priority, dependencies, subtasks, due date. Parentage is `parentId`/`projectId` alone; the `## Tasks`/`## Subtasks` checklists in the notes are derived copies kept in step in the background — see [docs/task-listings.md](docs/task-listings.md).
- **`DayTask`** (`model/daily/day-task.ts`) — parsed from a single `- [ ] ...` checklist line in a daily note or the Inbox note by `DayMarkdownFile`. Carries title, tags, checked state, and the Tasks-plugin-style emoji markers.

Both derive from `BaseTask` (`model/base-task.ts`), which declares what a row draws and what a list orders on, so one renderer and one comparator serve both.

`promoteChecklistItem()` (`model/operations/checklist-promote.ts`) is the single point where a `DayTask` becomes a `Task`. It is a one-way conversion, not a link: the new task holds no reference back to the line it came from, and there is no reverse operation.

## Documentation

- [docs/setup.md](docs/setup.md) — requirements, build, install into a vault, preview, release
- [docs/dashboard.md](docs/dashboard.md) — the Dashboard tab in pictures: layout, rows, actions
- [docs/inbox.md](docs/inbox.md) — the Inbox tab in pictures: triaging, ordering, promoting
- [docs/week-summary.md](docs/week-summary.md) — the Week Summary tab in pictures: what it counts
- [docs/graph-display.md](docs/graph-display.md) — the Task Graph in pictures: levels, cards, gestures
- [docs/task-listings.md](docs/task-listings.md) — keeping `## Tasks`/`## Subtasks` in step
- [docs/settings.md](docs/settings.md) — settings screen and recurring-habit reconciliation
- [docs/class-map.html](docs/class-map.html) — class relationships and responsibilities

## Bugs and ideas

Bug reports and feature ideas are welcome, by email at [pmcompass@proton.me](mailto:pmcompass@proton.me) or as an issue on [GitHub](https://github.com/Laurent-Ferier/pm-compass/issues). For a bug, the plugin version, the Obsidian version, and whether it happened on desktop or mobile are the three things that make it reproducible.

## Development

This plugin was built with extensive use of [Claude Code](https://claude.com/claude-code) (Claude Sonnet), from initial implementation through ongoing features and fixes.
