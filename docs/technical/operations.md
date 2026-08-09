# Operations — one pass over the vault

The plugin's writes to a note don't go through the model layer. A model holds a reading and answers what a view draws from; a **pass** works out what to write from the file as it stands right now, and writes it back. Every pass computes what to write from the file as it stands inside the lock, so an edit made in Obsidian's editor, or landed by a sync since the last reading, is never written over.

Every pass belongs to whatever owns the notes it touches, which is why none is left under `src/model/operations/` — what is there is what belongs to no note at all: paths, and the files at them.

A pass over a day note is split in two. The lock, the read and the write belong to [**TaskIO**](data-model.md#taskio--srcmodeliotask-iots), which owns the path — every change is owed to the note and lands in the one guarded pass there; what to make of the lines is a pure function of them, and lives at the foot of that same file, reached through the method that pairs with it. A pass over more than one note is [**TaskService**](data-model.md#taskservice--srcmodelservicetask-servicets)'s own method rather than a free function: it holds the store, and asks it for each note it touches.

Which layer holds what is in [data-model.md](data-model.md) — the models, the files and the caches under them, and the services over those. This document is the layer between: what each module here is responsible for.

**Whoever holds a pass holds nothing else of the note.** The cache holds paths, readings and events; the service holds which settings are in force and when a pass runs. Every write a pass makes is a change it asks a note for, which is what keeps the reading of that note in step — see [**TaskIO**](data-model.md#taskio--srcmodeliotask-iots).

## `file-helpers.ts` — `src/model/operations/file-helpers.ts`

Paths and the files at them, which is all this is: resolving a path to its file, creating a folder with its missing ancestors, and making a free path to put a note at.

- `resolveFile(app, path)` — a vault-relative path as its `TFile`, null for one that isn't a file.
- `ensureFolderRecursive(app, folder)` — the folder with its missing ancestors, created when absent. It can lose the race between the check and the create, which counts as success; `vault.createFolder()` throws on a nested path whose intermediate segments aren't there yet, hence the walk.
- `uniquePathIn(app, folder, title, untitled, taken?)` — a free path for a note called `title`, suffixing `-2`, `-3`… on collision. It slugifies the title itself, and `untitled` names what the note *is* — `"task"`, `"project"` — for a title written in characters no slug survives. `taken` reserves paths not on disk yet, so a subtree moving whole allocates every destination up front and two moving siblings can't both claim `slug-2`.
- `basenameOf` / `parentDirOf` / `generateId` — what a path is made of, and the id a new note carries.

Nothing here belongs to one caller: every entry is reached from the models, the files and the services alike, and the module names nothing of this plugin's own — a path is a path whichever kind of note sits at it. What one part alone uses lives with that part: the file lock and a note's lines with [**TaskIO**](data-model.md#taskio--srcmodeliotask-iots), which owns the path; the body prefix with [**ProjectTaskIO**](data-model.md#projecttaskio--srcmodelioproject-task-iots), which writes it; what a note's frontmatter reads as with [frontmatter.ts](data-model.md#frontmatterts--srcmodelprojectfrontmatterts), where the keys already live; and the making of a particular note with the service that owns it — the inbox's with [**TaskService**](data-model.md#taskservice--srcmodelservicetask-servicets), a day's with [**DayNoteService**](data-model.md#daynoteservice--srcmodelserviceday-note-servicets).

No view reaches into this module for a write. A tab that needs a note made asks the service that owns it — see `TaskService.ensureInboxNote`.
