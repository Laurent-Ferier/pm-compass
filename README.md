# pm-compass

Every task in one place: a dashboard, an inbox, a weekly review and an interactive dependency graph, built on two things your vault already has — project/task notes from [obsidian-pm](https://github.com/stepankropachev/obsidian-pm) and checklist items in Obsidian's core Daily Notes. It reads and edits those files directly, so there's no separate database, and everything it does is a normal markdown edit you can also make by hand.

## What it adds to Daily Notes

Daily-note checklists work as plain `- [ ] ...` lines, compatible with the emoji-date format used by the community Tasks plugin (`➕` created, `📅` due, `⏳` scheduled, `✅` completed, plus priority emoji), so they stay readable with or without this plugin installed. On top of that, PM Compass adds:

- **A [Dashboard](docs/guide/dashboard.md)** — one day's checklist without opening its note, with the neighbouring days' unclosed lines beside it, so what is overdue or coming up is on the same screen as today.
- **An [Inbox](docs/guide/inbox.md)** — a dedicated note for quick-capture tasks that don't belong to a specific day yet, with age tracking and a staleness warning past a configurable threshold. Checking an Inbox item off moves it to today's note as done, rather than deleting it, so closing from the Inbox still leaves a record of when it happened.
- **A [Week Summary](docs/guide/week-summary.md)** — a week of daily notes read at once: how much of each day was closed, and whether each recurring habit held.
- **Recurring habits** — define a habit once (daily, or specific weekdays) in [settings](docs/technical/settings.md), and its checklist line is inserted into each day's note automatically, reconciled whenever you open or create that day's note.
- **One-tap actions on any checklist item** — reschedule to another day, move to the Inbox, promote it to a project task, delete, or attach a note to it, all without opening the underlying file.
- **A ramp from checklist to project** — a line in the Inbox or today's note can be promoted into a real obsidian-pm task file, under an existing project or a new one, without retyping it: its dates, tags, priority, and indented notes come along. An item that has been aging in the Inbox usually just needed a home, not a deadline.

## What it adds to Project Manager

obsidian-pm's project/task notes are read as-is (same frontmatter, same files) and get a few things obsidian-pm alone doesn't provide:

- **A dependency graph** — every task and project rendered as an interactive graph (the [Task Graph](docs/guide/graph-display.md) view), instead of only a flat note. Tasks can be created, edited, and deleted inline, moved to another parent or project (subtasks included), and wired up with dependencies by drag-to-connect.
- **Priority and deadline that flow downhill** — a subtask with no due date or priority of its own inherits its parent's, whichever is more urgent, so a deadline set once on a project task is automatically reflected everywhere underneath it.
- **A single ranked queue** — the [Dashboard](docs/guide/dashboard.md)'s Priority Queue surfaces what's actually urgent across every project at once, overdue first, instead of opening each project note to check.
- **A weekly rollup** — the [Week Summary](docs/guide/week-summary.md) tallies what was completed, created, put in progress, or blocked this week, across all projects.
- **Quick edit everywhere** — priority and status can be changed from a dropdown right on a task's row, in the Dashboard or the graph, without opening its note.
- **Settings sync** — the projects folder is read from obsidian-pm's own settings on startup, so it only needs to be configured once.

The Dashboard is the one view where both kinds of task appear together; every other tab shows exactly one of them.

## User's guide

- [Dashboard](docs/guide/dashboard.md) — one day checklist.
- [Inbox](docs/guide/inbox.md) — the tasks that are not planned yet.
- [Week Summary](docs/guide/week-summary.md) — one week statistics.
- [Task Graph](docs/guide/graph-display.md) — a visual view of a project's tasks and the dependencies between them.

## Technical guide

- [Setup](docs/technical/setup.md) — requirements, build, install into a vault, preview, release
- [Data model](docs/technical/data-model.md) — the models, notes, caches and watchers behind every view, class by class and layer by layer, with the hierarchies and relationships drawn. The diagrams alone are on one page as the [class map](docs/technical/class-map.html).
- [Settings](docs/technical/settings.md) — the settings screen: where each field is read, what the recurring-habit reconciliation does, and which settings no control writes

### Down the rabbit hole

Subsystems with rules of their own, worth a document each.

- [Task listings](docs/technical/task-listings.md) — keeping the `## Tasks`/`## Subtasks` checklists in step with the tasks they name.
- [Theming](docs/technical/theming.md) — which variable every colour comes from, and the palette that stays fixed on both themes.

## Bugs and ideas

Bug reports and feature ideas are welcome, by email at [pmcompass@proton.me](mailto:pmcompass@proton.me) or as an issue on [GitHub](https://github.com/Laurent-Ferier/pm-compass/issues). For a bug, the plugin version, the Obsidian version, and whether it happened on desktop or mobile are the three things that make it reproducible.

## Development

This plugin was built with extensive use of [Claude Code](https://claude.com/claude-code) (Claude Sonnet), from initial implementation through ongoing features and fixes.
