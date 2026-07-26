# PM Compass — System Overview

## What it is

An Obsidian plugin that layers personal project-management workflows on top of two
data sources that already exist in the vault, without owning either:

- **[obsidian-pm](https://github.com/stepankropachev/obsidian-pm)** project/task notes —
  structured data stored as frontmatter (`pm-project: true`, `pm-task: true`) on
  markdown files under a configured projects folder.
- **Obsidian's core Daily Notes** — informal `- [ ] ...` checklist items in the vault's
  daily notes and a dedicated Inbox note.

PM Compass reads both in place via the metadata cache / vault API and writes back to
the same files — there is no separate database or sync step. Everything the plugin
shows can also be read and hand-edited as plain markdown.

## Goals

- **One view for "what needs attention"**, spanning both informal daily checklist
  items and structured project tasks, instead of cross-referencing project notes by
  hand every morning.
- **Don't force a single task format.** A quick to-do can stay a checklist line in
  today's note; a task worth tracking dependencies/deadlines/subtasks for can live as
  an obsidian-pm task file. The Dashboard is the place these two meet — and a line
  that turns out to deserve the heavier format can be **promoted** into one rather
  than retyped, so picking the light format first costs nothing later.
- **Stay inspectable.** State lives in markdown/frontmatter the user already owns, not
  in an opaque plugin database — every mutation the plugin makes is a normal edit to a
  normal note.
- **Reduce daily janitorial work**: recurring habits get inserted automatically,
  stale/unclosed items surface on their own, and a task's priority/deadline propagate
  down to its subtasks without re-entering them.

The repo previously scaffolded a CLI package and a shared-types package under a
`packages/` monorepo layout (see `git log -- packages/cli`); both were removed as
unused, and the repo was later flattened to a single package at the root — matching
[Obsidian's sample plugin layout](https://github.com/obsidianmd/obsidian-sample-plugin),
which the community directory's submission tooling expects (`manifest.json` at the
repo root).

## Main features

| Feature | Where | Details |
|---|---|---|
| **Dashboard** — today's (or any day's) checklist, overdue/upcoming unclosed items, approaching deadlines, and a priority queue of active project tasks | Dashboard tab | [dashboard.md](dashboard.md) |
| **Inbox** — quick-capture list for untriaged tasks: add, schedule to a day, close, promote, or delete, with age and staleness tracking | Inbox tab | [inbox.md](inbox.md) |
| **Promote to project task** — turn an Inbox line or a daily-note checklist item into an obsidian-pm task file, under an existing project or a brand-new one, carrying its dates, tags, priority, and notes across | Inbox tab + Dashboard tab | [inbox.md](inbox.md) |
| **Move task** — move a project task, with its whole subtree, to another parent or another project | Dashboard + Task Graph context menus | [dashboard.md](dashboard.md) |
| **Week Summary** — per-day completion ring and a per-habit weekly grid | Week Summary tab | [week-summary.md](week-summary.md) |
| **Task Graph** — every obsidian-pm task/project rendered as a cytoscape.js dependency graph, with inline edit/create/delete, move to another parent/project, and drag-to-connect dependencies | separate workspace leaf | [graph-display.md](graph-display.md) |
| **Recurring habits** — user-defined recurring task definitions (daily, or specific weekdays) auto-inserted into daily notes; reconciled on note open/create and backfillable for the current week on demand | plugin settings + background reconciliation | [settings.md](settings.md) |
| **Settings** — projects folder, obsidian-pm settings sync, habits tag, Inbox path/staleness threshold, unclosed-day window, recurring task list | Settings tab | [settings.md](settings.md) |

## Data model, at a glance

Two independent shapes feed the UI — they're read from different files, in different
formats, and are never merged into one record. Nothing links an instance of one to an
instance of the other; the only traffic between them is a one-way **conversion**
(promotion, see below):

- **`Task` / `Project`** (plain interfaces, `model/shared.ts`) — parsed from
  obsidian-pm frontmatter under the configured projects folder by `loadVaultData()`.
  Carries status, priority, dependencies, subtasks, due date.
- **`DayTask`** (`model/day-task.ts`) — parsed from a single `- [ ] ...` checklist line
  in a daily note or the Inbox note by `DayMarkdownFile`. Carries title, tags, checked
  state, and the Tasks-plugin-style emoji markers (`➕` created, `📅` due, `✅`
  completed, `🔺⏫🔼🔽⏬` priority).

Both shapes take their priority from one `Priority` string enum
(`model/task-vocabulary.ts`) rather than passing bare strings around: its values are the
stored ones (`"critical"`, `"high"`, …), so frontmatter and checklist markers are
unchanged, and `toPriority()` narrows anything read from disk — an unrecognised
hand-typed value becomes `None` at the boundary instead of travelling through the app.
`Priority.Lowest` (the Tasks plugin's `⏬`) exists only on the checklist side; it is
absent from the `PRIORITIES` picker list and folds to `Low` on promotion. The same file
holds the other persisted string enums — `InboxSortBy`/`InboxSortDir` — for the same
reason: call sites name the value while the stored setting stays the plain string.

The Dashboard is the one view that shows both side by side; every other tab shows
exactly one of the two.

`promoteChecklistItem()` (`model/checklist-promote.ts`) is the single point where a
`DayTask` becomes a `Task`: it reads the line, writes a new task file, and deletes the
line. It is a conversion and not a link — the new task holds no reference back to the
note it came from, and there is no reverse operation. Everything else stays strictly
within one shape. See [inbox.md](inbox.md) for what survives the crossing.

See [class-map.html](class-map.html) for how every class involved — views, modals, and
the file-wrapper/value-object classes behind `Task`, `Project`, and `DayTask` —
relates to the others.
