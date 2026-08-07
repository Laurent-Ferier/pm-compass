# Task listings — Technical Description

A project note lists its root tasks under `## Tasks`; a parent task lists its subtasks under `## Subtasks`. Both are the same thing — a checklist of wiki-links to the notes below them — and both are **derived**: the tasks themselves are the record, the listing is a copy kept for obsidian-pm and for reading a project as a note.

```markdown
---
pm-project: true
taskIds: ["a1b2c3d4e5f60718", "0918273645abcdef"]
---

## Tasks
- [x] [[write-the-spec|Write the spec]]
- [ ] [[ship-it|Ship it]]
```

The frontmatter id list and the body checklist say the same thing twice. The id list is what obsidian-pm reads; the checklist is what a person reads and — because a checkbox in a note is a thing people click — what a person edits. Keeping the two in step with the tasks they name is what this document is about.

[**ListingFile**](data-model.md#listingfilefields--srcmodeliolisting-filets) holds the listing behaviour, and [**ProjectFile**](data-model.md#projectfile--srcmodelioproject-filets) and [**ProjectTaskFile**](data-model.md#projecttaskfile--srcmodelioproject-task-filets) extend it. The markdown-level work — finding the section, matching an entry, rewriting one — is in `model/project/child-links.ts`.

## A listing is part of the note's reading

A note's fields are its frontmatter, plus this one thing that isn't: `ListingFields.listing` holds the boxes under its own heading, filled by [**FileStore**](data-model.md#filestorefields-notefile-model--srcmodelstorefile-storets)`.parseNote` alongside everything else. So "the boxes moved" is a reading that moved, told apart from "the frontmatter moved" by the same `sameFields` comparison, and every rule below is answered from what the note holds rather than from a copy of the file passed around.

`listingFromCache()` reads the listing out of the `CachedMetadata` the frontmatter already came from — the headings say where the section is, `listItems[].task` carries each box, and the links say what each one names — so a note's listing costs what its frontmatter costs and no file is opened for it. `readChildLinkBoxes()` is the same reading off a note's text, kept as the definition the cache reading is tested to agree with.

## No read path depends on a listing

A task's parentage is its own `parentId`/`projectId` frontmatter and nothing else, so the entire subsystem below can be wrong without the Dashboard, the Task Graph, or any view being wrong. A bug in it costs a stale checklist rather than a lost task.

The listing is therefore not authoritative when the two disagree. Every rule here resolves a conflict in favour of the task's own frontmatter, except the one case below where a box is known to be a fresh edit.

## Which way a change travels

`syncChangedNote()` (`model/project/listing-sync.ts`) runs off the store's own telling that a note **changed** — [**ProjectStore**](data-model.md#projectstore--srcmodelstoreproject-storets)`.announce` handing the window's notes to [**ProjectService**](data-model.md#projectservice--srcmodelserviceproject-servicets)`.changed`, at the end of the window a burst of vault events is gathered into. Obsidian's `changed` event is only what makes the store re-read the note; whether the reading moved is the models' answer, and a reparse that landed what the note already said reconciles nothing. The direction it syncs follows **which note it is**, not what changed inside it — diffing a listing against its previous self would decide nothing the rules below don't already decide:

- A **listing note** that changed is a listing that moved, so its boxes drive the tasks they name ([**ListingFile**](data-model.md#listingfilefields--srcmodeliolisting-filets)`.applyChildBoxes` → [**ProjectTaskFile**](data-model.md#projecttaskfile--srcmodelioproject-task-filets)`.applyParentBox`).
- A **task note** that changed is a status or title that moved, so it drives the line that lists it ([**ProjectTaskFile**](data-model.md#projecttaskfile--srcmodelioproject-task-filets)`.pushToListing` → `updateChildLink`).
- A task with subtasks is **both**, and the two touch different files, so it runs both.

Guessing the direction wrong costs nothing because **neither direction writes when nothing moved** — each direction's write is itself a file change that wakes the other one. `rewriteChildLinks` compares its output to the section it read and returns without touching the file when they match; `applyParentBox` checks the status before committing to a `processFrontMatter` call, which rewrites a note whatever its callback does. `model/project/listing-convergence.test.ts` drives each kind of edit through both directions and asserts the writes stop.

`applyParentBox` reads the metadata cache to decide whether there is anything to do, but the **file** to decide what to write: the parent's `changed` event can outrun the child's own reparse, leaving the cached status one edit stale.

**Where the listeners live.** Every handler belongs to [**ProjectService**](data-model.md#projectservice--srcmodelserviceproject-servicets), over a folder [**ProjectStore**](data-model.md#projectstore--srcmodelstoreproject-storets) watches from the moment the plugin loads, so the sync runs whether or not a tab is open — an edit made with every tab closed is answered like any other.

**The write-loop guard.** A reconciler that both listens for a change and writes notes would otherwise see its own writes come back. The guard is the one [**BaseFile**](data-model.md#basefilefields-edit--srcmodeliobase-filets) gives a field, carried one level down into the body:

- Every writer in `child-links.ts` hands back the listing it left, and [**ListingFile**](data-model.md#listingfilefields--srcmodeliolisting-filets)`.wrote` takes it onto the note's own reading, so a re-read landing exactly that wakes nobody.
- Nothing outside [**ListingFile**](data-model.md#listingfilefields--srcmodeliolisting-filets) calls those writers directly, [**ProjectTaskFile**](data-model.md#projecttaskfile--srcmodelioproject-task-filets)`.syncParentListing` included: it goes through the note that holds the line, not at the file.
- A task note's own `writeOwed` pushes the title and the box to the listing directly as well as through the event, so the listing moves with an edit made while no view is open to hear it.
- A note the plugin has just written is read back off the *file*, the metadata cache still holding what it said before. The read that would take it is a view's, so [**ProjectStore**](data-model.md#projectstore--srcmodelstoreproject-storets)`.announce` takes it itself when the window closes on anything still owed — otherwise a note edited by hand while a write of the plugin's own was in the air would sit unreconciled until someone opened a tab.

**A note that arrives is not a note that changed.** `pushToListing` mirrors a task onto the line that lists it and adds none — `updateChildLink` leaves an absent entry absent, so a status pushed part-way through a move touches neither parent. That leaves the arrival: a task note the plugin never saw created, landing from a sync or an editor or a file copied in, which nothing lists and nothing therefore mirrors.

[**ProjectTaskFile**](data-model.md#projecttaskfile--srcmodelioproject-task-filets)`.ensureListed` is the one case that adds a line. [**ProjectService**](data-model.md#projectservice--srcmodelserviceproject-servicets) runs it only for a path **neither half has ever held** when the reparse reached it, **and** that is owed no read of the plugin's own — the second test being what keeps it off `createTask` and `moveTask`, which list the note themselves and would append the line twice if a second writer raced them. A listing that already names the arrival costs a cache read and no write.

The opening pass is no answer to this: it is memoized on `verifyPass` to run once a session, so a note Obsidian has yet to index when the plugin loads is one the pass's walk doesn't hold and never runs again to notice. What an arrival needs is the one listing it belongs to.

**A path is all it takes.** The listing half is answered from what the note holds, so `syncChangedNote` needs no text and reads no file for it: a caller that noticed a note some other way — a folder walk, an arrival no change event carried — can reconcile its listing with a path alone. Only the *task* half opens a file, for the `Project:`/`Parent:` link naming where a task is listed, which is body text nobody holds a reading of.

## The verification problem

A box that disagrees with the task it names means one of two opposite things:

1. Someone just ticked it, and the task should close.
2. The note predates the sync (or was written by hand, or restored from a backup), so the box was never meaningful and should be rewritten from the status.

Nothing in the note distinguishes them. Reading (1) when the truth is (2) closes tasks the user never touched; reading (2) when the truth is (1) discards a tick. The second is recoverable — the user ticks it again — so **(2) is the default**, and (1) is only read once the listing is *known* to have agreed with its tasks at some earlier point.

[**ListingFile**](data-model.md#listingfilefields--srcmodeliolisting-filets)`.isVerified` is that knowledge — the standing `syncChildBoxes` decides on — and it is held for the session only: a note can change between two runs of the plugin, and a stored "verified" flag would be a claim about a file the plugin was not watching. A note leaving its path — a `delete`, or a `rename` seen under the old path — is dropped along with its flag, so whatever arrives there next is a note nobody has checked.

The practical cost of a listing that has never been verified is one tick: the first box you click in that note goes towards checking it rather than closing that task.

## The opening pass

`repairListings()` (`model/project/listing-repair.ts`) is the bulk version, run once per session from the store's warm-up and available on demand as the **"Check project and subtask listings against the tasks that exist"** command. It walks every project and every task and makes each listing agree with the tasks that actually exist: entries added, titles refreshed, boxes matched to statuses, departed entries dropped. Every note it covers is marked verified.

It walks **every** task, not only those that currently have children. A task that has lost its last subtask still carries that subtask's line in its own `## Subtasks` and its id in `subtaskIds`, and skipping it would leave the pass unable to repair the one case it most needs to. A task with no children and no section costs one read and no write.

It also puts each task's `Project:`/`Parent:` body prefix back in step with its `parentId`. `moveTask` (`model/project/task-move.ts`) writes the two together but commits them separately, so a crash between them leaves the listing following one parent while the status push follows the other.

### Tasks whose frontmatter names something that isn't there

A `parentId` naming a task the folder doesn't hold is treated as a root of its project — listed under `## Tasks`, given a `Project:` prefix — because that is what it now is. The frontmatter is the part that needs saying so: `buildChildMap` files such a task under the missing id, and the task graph picks a project's roots with `!t.parentId`, so a dangling id matches no parent's children and no root filter and the task is **invisible in the graph** while sitting correctly in every listing.

Clearing it is the repair, and it is the command's to make, not the session-start pass's (`RepairOpts.clearDanglingParents`). On a synced vault a parent note that has not landed yet is indistinguishable from one that never existed, and an unattended pass that cleared the id would throw away real parentage; the command runs when a person asked it to on a vault they are looking at. The write re-checks the id against the file, so a note that gained a real parent while the pass walked is left alone.

A `projectId` naming no project in the folder is **counted and never repaired**: nothing holds such a task and nothing lists it, but which project it meant is not in the note, and an unattended guess would file it under the wrong one. The count is reported in the command's notice so the vault can be fixed by hand.

A note marked `pm-task: true` that the reader can't read as a task at all never reaches the repair pass — it isn't in the task list the pass is handed. [**ProjectStore**](data-model.md#projectstore--srcmodelstoreproject-storets)`.unreadableTaskNotes` is the walk that accounts for them, comparing the folder's files against every task the folder holds: frontmatter `parseTask` can't place (it wants an `id` and a `projectId`), and a second note claiming an id another already has, which the folder's reading drops rather than doubling the row. Counted against the **unfiltered** task list, archived ones included, since the pass's own list has those taken out and counting them here would be a lie about the vault. Reported, never repaired — nothing in such a note says what it was meant to be.

The pass is **started by the warm-up, not awaited by it** ([**VaultData**](data-model.md#vaultdata--srcmodelservicevault-datats)`.warm()` → [**ProjectService**](data-model.md#projectservice--srcmodelserviceproject-servicets)`.ensureListingsVerified`) — the start of the session rather than the first render, so it happens whether or not a dashboard is ever opened. It reads every project and task note, which on a large vault is a visible stall, and blocking on it buys nothing: a note the pass has not reached yet is exactly the unverified case `syncChangedNote` already handles. The `verifyListingsOnLoad` setting ([settings.md](settings.md)) turns the pass off entirely, leaving each note to earn its standing the first time it changes.

The warm-up itself waits for `workspace.onLayoutReady`, and that wait is what makes the pass mean anything. A plugin's `onload` runs before Obsidian has finished listing the vault, so a folder walked there holds only the files the tree happened to have reached — and the pass, memoized to run once a session, would vouch for those few and never run again. Watching still starts in `onload`: nothing that changes from that moment is missed, and the wait is only for the first read.

Both the pass and the per-note repair are idempotent, and the pass writes nothing on a vault already in step — including the frontmatter, guarded separately because `processFrontMatter` rewrites a file whatever its callback does and `touch()` would stamp `updatedAt` on every note in the vault, on every pass. The id list also keeps whatever order it already has, so a repair that changes nothing else can't reshuffle a field obsidian-pm writes too and hand Sync a conflict for free.

## Entries the plugin does not own

A `## Tasks` section is an ordinary markdown heading in a note the user owns, and `[[2026 Q3 review]]` may well be sitting under it because they put it there.

An entry `repairListings` can't account for is therefore removed **only** when its basename resolves to a `pm-task` note in the folder the children live in — positive evidence that the plugin wrote it and that the task has since moved elsewhere. Everything else stays. A folder-relative lookup cannot tell a link the user wrote from a task note that has been deleted, and an unattended pass over every project note in the vault must not guess.

That leaves a real gap: a task deleted **outside** the plugin, whose file is gone and whose entry is indistinguishable from a user's link to a note not created yet. `unlinkDeletedTask()` closes it from the other side, off the vault's `delete` event — there the deletion itself is the evidence and the path is exact. It tries the project note that owns the folder first (one read, the common case), then only the sibling task notes whose cache shows a non-empty `subtaskIds`, so a 200-task project costs one read rather than 200. The stale id in the frontmatter is left for the next `syncChildLinks` to prune. Its body edit goes through `vault.process` rather than a read-then-modify pair: the delete event fires part-way through [**ProjectTaskFile**](data-model.md#projecttaskfile--srcmodelioproject-task-filets)`.delete`, so the two can be editing the same note at once.

## Matching an entry

Two regexes read the checklist, both anchored to the start of a line. An indented `- [ ] [[some-task]]` nested under an entry is the user's own breakdown of it, and is neither read as a child nor rewritten as one. Edits are confined to the span between the section's heading and the next `## ` heading, so a checklist line quoted in a task's description can't be mistaken for the real entry, and the heading match is itself line-anchored so a `### Tasks` sub-heading doesn't open a section.

`listingFromCache()` matches exactly as narrowly, in the cache's own terms: a level-2 heading, an unindented list item, a `[ ]`/`[x]` box — Obsidian calls any character a box, this plugin only writes those — and the link starting at the column right after it, so `- [ ] see [[task]]` is prose that happens to link rather than an entry. `child-links.test.ts` asserts the two readings agree case by case rather than testing them apart.

Entries are written `- [x] [[basename|Title]]` but matched with the alias optional, so a hand-edited `[[basename]]` is still found; rewriting one keeps it bare.

`- [x]` means **done** specifically. A cancelled task is closed but was never finished, so its box stays clear, and unticking a box reopens a task as `todo`.

## Where a task's own entry lives

The reverse lookup — given a task, which note lists it? — is read off the `Project: [[…]]` / `Parent: [[…]]` wiki-link that opens the task's body, not off its `parentId`. The link names a basename, which is what the checklist matches on, and it travels in the same file as the task. `projectFileForTask()` reads `<project>_tasks/` back to `<project>.md` for the `Project:` case. A task with no such prefix — a hand-made note — has no entry to sync, and is left alone rather than guessed at.

An arrival is the one lookup that goes further, since a note with no line yet has nothing to be left alone with: a task that names no parent and opens with no prefix is placed by the folder it sits in, `_tasks/` naming its project as surely as the link would have. A task that names a `parentId` and opens with no prefix is not — which sibling that id is, is not in the note and not in the folder either — and waits for the opening pass, which reads the whole folder and can answer it.
