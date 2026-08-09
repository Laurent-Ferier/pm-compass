# Operations — one pass over the vault

The plugin's writes to a note don't go through the model layer. A model holds a reading and answers what a view draws from; an **operation** works out what to write from the file as it stands right now, and writes it back. Everything under `src/model/operations/` is that and nothing else: free functions, no state, no classes.

An operation takes the notes it works on and holds no state between calls — so nothing about it can disagree with a second call on the same file. Every pass computes what to write from the file as it stands inside the lock, so an edit made in Obsidian's editor, or landed by a sync since the last reading, is never written over.

A pass over a day note is split in two. The lock, the read and the write belong to [**TaskIO**](data-model.md#taskio--srcmodeliotask-iots), which owns the path — every change is owed to the note and lands in the one guarded pass there; what to make of the lines is a pure function of them, and lives at the foot of that same file, reached through the method that pairs with it. A pass over more than one note is [**TaskService**](data-model.md#taskservice--srcmodelservicetask-servicets)'s own method rather than a free function: it holds the store, and asks it for each note it touches.

Which layer holds what is in [data-model.md](data-model.md) — the models, the files and the caches under them, and the services over those. This document is the layer between: what each module here is responsible for.

**An operation holds the pass, and nothing else.** The cache holds paths, readings and events; the service holds which settings are in force and when a pass runs. Every write an operation makes is a change it asks a note for, which is what keeps the reading of that note in step — see [**TaskIO**](data-model.md#taskio--srcmodeliotask-iots).

## `file-helpers.ts` — `src/model/operations/file-helpers.ts`

Paths and the files at them, which is all this is: resolving a path to its file, creating a folder with its missing ancestors, and making a free path to put a note at.

- `resolveFile(app, path)` — a vault-relative path as its `TFile`, null for one that isn't a file.
- `ensureFolderRecursive(app, folder)` — the folder with its missing ancestors, created when absent. It can lose the race between the check and the create, which counts as success; `vault.createFolder()` throws on a nested path whose intermediate segments aren't there yet, hence the walk.
- `basenameOf` / `parentDirOf` / `slugify` / `uniquePathIn` / `generateId` — what a path is made of, and the making of a free one.

Nothing here belongs to one caller: every entry is reached from the models, the files and the services alike, and the module names nothing of this plugin's own — a path is a path whichever kind of note sits at it. What one part alone uses lives with that part: the file lock and a note's lines with [**TaskIO**](data-model.md#taskio--srcmodeliotask-iots), which owns the path; the body prefix with [**ProjectTaskIO**](data-model.md#projecttaskio--srcmodelioproject-task-iots), which writes it; what a note's frontmatter reads as with [frontmatter.ts](data-model.md#frontmatterts--srcmodelprojectfrontmatterts), where the keys already live; and the making of a particular note with the service that owns it — the inbox's with [**TaskService**](data-model.md#taskservice--srcmodelservicetask-servicets), a day's with [**DayNoteService**](data-model.md#daynoteservice--srcmodelserviceday-note-servicets).

No view reaches into this module for a write. A tab that needs a note made asks the service that owns it — see `TaskService.ensureInboxNote`.

## `habit-reconcile.ts` — `src/model/operations/habit-reconcile.ts`

`reconcileRecurringHabits` gives one day note the habits its definitions call for and prunes the habit-tagged lines matching no active, scheduled one. Pruning covers the whole file rather than the heading's own section, so a line left outside it is cleaned up too.

It takes the note rather than a path, and what to change is `computeHabitChanges`' — a section that doesn't read as the definitions say is taken out and put back whole, each line the note already had going back as it stood. What is here is owing that change to the note as one edit: the habit lines taken out and the section put back, which only make sense together — a note caught between the two is a note missing its habits, and would send whatever read it next about putting them back. What a note is owed it marks itself, which is why this names nothing back to its caller.

The lines it decides from are the ones the write itself is handed, read inside the lock: a tick landing mid-pass would otherwise leave every removal resolving against a line that no longer reads that way, and the section put back from the stale text — the habit written twice and the tick lost with the duplicate. The read above the lock only asks whether there is anything to do at all, so a note already right owes nothing and wakes nobody. Which habits, and under which heading, is the caller's — [**TaskService**](data-model.md#taskservice--srcmodelservicetask-servicets)`.backfillHabits` for the week ahead, its `reconcileDayNote` for a single note.

A habit is a top-level checklist line carrying the habits tag. A line indented under another task, or one whose tag was taken off by hand, is not one: it is neither held nor pruned, and the definition behind it is written afresh under the heading — which is what indenting or untagging says, that the line is now the person's own and the habit still owed.

## `checklist-promote.ts` — `src/model/operations/checklist-promote.ts`

`promoteChecklistItem` turns an inbox line into a project task, translating its metadata across the two models and then dropping the line. The line goes last, so a crash mid-way leaves a visible duplicate rather than losing the item.
