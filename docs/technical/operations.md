# Operations — one pass over the vault

The plugin's writes to a note don't go through the model layer. A model holds a reading and answers what a view draws from; an **operation** opens a file, works out what to write from what is in it right now, and writes it back. Everything under `src/model/operations/` is that and nothing else: free functions, no state, no classes.

An operation takes the app and the paths it works on, and holds no state between calls — so nothing about it can disagree with a second call on the same file. Every pass computes what to write from the file as it stands inside the lock, so an edit made in Obsidian's editor, or landed by a sync since the last reading, is never written over.

Which layer holds what is in [data-model.md](data-model.md) — the models, the files and the caches under them, and the services over those. This document is the layer between: what each module here is responsible for.

**An operation names the paths it wrote rather than invalidating them itself.** The cache holds paths, readings and events; the service holds which settings, when, and what to invalidate; an operation holds the pass. A pass that marked its own writes would bury a cache write in a function that reads like a pure one.

## `file-helpers.ts` — `src/model/operations/file-helpers.ts`

The plumbing every pass is built on: resolving a path to its file, creating a note or a folder with its missing ancestors, splitting frontmatter from body, and generating an id or a free path.

- `withFileLock(path, fn)` — runs `fn` once any other pass over that path has settled. The one lock there is: a second, anywhere, and two passes over one path stop excluding each other.
- `readFileLines` / `writeFileLines` / `appendFileLines` — a file as its lines, absent counting as none.

## `day-note-lines.ts` — `src/model/operations/day-note-lines.ts`

The read-modify-write passes over one note's checklist lines: `parseTasks`, `addTask`, `removeTask`, `removeCheckedTasks`, `checkTask` / `uncheckTask`, `updateTitle`, `updatePriority`, `updateScheduledDate`, `updateSubLines`, `moveTaskBefore` and `insertUnderHeading`. `parseTasksFromLines` is the read behind them, and what [**TaskFile**](data-model.md#taskfile--srcmodeliotask-filets) parses its own reading with.

Which file a line belongs to is the caller's — a line carries the note it was read from, and an operation writes where it is told.

## `day-note.ts` — `src/model/operations/day-note.ts`

Where a day's note lives, and making one:

- `dayNotePath(date, config)` — the path a day has under the daily-notes scheme, whether or not the file exists.
- `matchDailyNotePath(path, config)` — the date that path stands for, or null when its name is not a day's.
- `ensureDayNotePath(app, date, config?)` — the path of that day's note, created through Templater when the vault has it.

Two rules `ensureDayNotePath` puts on its caller. The path it hands back is authoritative and must not be recomputed, Templater being free to land the note elsewhere. And a null is a silent refusal — the vault says nowhere to put a note — so a caller moving a line into that note resolves it *before* touching the source, or the line is lost.

## `habit-reconcile.ts` — `src/model/operations/habit-reconcile.ts`

`reconcileRecurringHabits` gives one day note the habits its definitions call for and prunes the habit-tagged lines matching no active, scheduled one. Pruning covers the whole file rather than the heading's own section, so a line left outside it is cleaned up too.

## `inbox-migrate.ts` — `src/model/operations/inbox-migrate.ts`

`migrateInboxTargets` moves every inbox item whose ⏳ target day takes tasks into that day's checklist, which is what makes a target date a plan rather than a label. A day that never gets a note keeps its item. It reports how many moved and every note it wrote — the inbox, and each day note an item landed in, under the path `ensureDayNotePath` handed back.

## `day-reconcile.ts` — `src/model/operations/day-reconcile.ts`

`reconcileDayNote` puts one day note back in step with what the vault has moved on to: the habit pass, then the inbox migration. It fills the caller's `touched` array as the writing happens rather than handing it back at the end, so a pass that throws halfway still names what it got through.

## `checklist-promote.ts` — `src/model/operations/checklist-promote.ts`

`promoteChecklistItem` turns an inbox line into a project task, translating its metadata across the two models and then dropping the line. The line goes last, so a crash mid-way leaves a visible duplicate rather than losing the item.
