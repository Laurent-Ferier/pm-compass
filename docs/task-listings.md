# Task listings — Technical Description

A project note lists its root tasks under `## Tasks`; a parent task lists its subtasks
under `## Subtasks`. Both are the same thing — a checklist of wiki-links to the notes
below them — and both are **derived**: the tasks themselves are the record, the listing
is a copy kept for obsidian-pm and for reading a project as a note.

```markdown
---
pm-project: true
taskIds: ["a1b2c3d4e5f60718", "0918273645abcdef"]
---

## Tasks
- [x] [[write-the-spec|Write the spec]]
- [ ] [[ship-it|Ship it]]
```

The frontmatter id list and the body checklist are written together and say the same
thing twice. The id list is what obsidian-pm reads; the checklist is what a person
reads, and — because a checkbox in a note is a thing people click — what a person
edits. Keeping the two in step with the tasks they name is what this document is
about.

`BaseNote` (`model/project/base-note.ts`) holds the listing behaviour, since a project and a
parent task differ only in which section holds the list (`ChildLinkSection`) and where
the children's own notes sit. `ProjectFile` and `ProjectTaskFile` each supply those two
answers and inherit the rest. The markdown-level work — finding the section, matching an
entry, rewriting one — is in `model/project/child-links.ts`.

## What a listing is not

`loadVaultData()` never reads a listing. A task's parentage is its own
`parentId`/`projectId` frontmatter and nothing else, so the entire subsystem below can
be wrong without the Dashboard, the Task Graph, or any view being wrong. That is the
point: a denormalized copy that no read path depends on can be repaired at leisure, and
a bug in it costs a stale checklist rather than a lost task.

It also means the listing is not authoritative when the two disagree. Every rule here
resolves a conflict in favour of the task's own frontmatter, except the one case below
where a box is known to be a fresh edit.

## Which way a change travels

`syncChangedNote()` (`model/project/listing-sync.ts`) runs off `metadataCache`'s
`changed` event for any file under the projects folder. The direction it syncs follows
**which note changed**, not what changed inside it — the event only says the file was
reparsed, and diffing the note against its previous self would mean keeping that
previous self around:

- A **listing note** that changed is a listing that moved, so its boxes drive the
  tasks they name (`BaseNote.applyChildBoxes` → `ProjectTaskFile.applyParentBox`).
- A **task note** that changed is a status or title that moved, so it drives the line
  that lists it (`ProjectTaskFile.pushToListing` → `updateChildLink`).
- A task with subtasks is **both**, and the two touch different files, so it simply
  runs both.

Guessing the direction wrong costs nothing because **neither direction writes when
nothing moved**. That is not an optimisation. Each direction's write is itself a file
change that wakes the other one, so a write-unconditionally version of either function
would leave a project note and its tasks rewriting each other until Obsidian was
closed. `rewriteChildLinks` compares its output to the section it read and returns
without touching the file when they match; `applyParentBox` checks the status before
committing to a `processFrontMatter` call, which rewrites a note whatever its callback
does. `model/project/listing-convergence.test.ts` exists to pin this down: it drives
each kind of edit — a box ticked, a status changed from the modal, a task created,
renamed, moved, cancelled — through both directions and asserts the writes stop.

`applyParentBox` reads the metadata cache to decide whether there is anything to do, but
the **file** to decide what to write. The parent's `changed` event can outrun the
child's own reparse, so the cached status may be one edit stale — and acting on it
would reopen a task that had since been cancelled.

### Where the listeners live

The `changed` handler is registered by `PMCompassView`, so the event-driven half of the
sync only runs **while the plugin's tab is open**. That is why `patchField` and
`update()` push to the listing directly as well as through the event: an edit made from
the Dashboard moves the checklist with it rather than a beat later, and a task closed
from the Task Graph still moves it when nothing is listening.

The `delete` and `rename` handlers are registered by `PMCompassPlugin` itself
(`main.ts`), so they run whether or not a tab is open — a note deleted from the file
explorer is exactly the case the view would miss.

Nothing catches an edit made with every tab closed. That is what the opening pass is
for.

## The verification problem

A box that disagrees with the task it names means one of two opposite things:

1. Someone just ticked it, and the task should close.
2. The note predates the sync (or was written by hand, or restored from a backup), and
   the box was never meaningful, so it should be rewritten from the status.

Nothing in the note distinguishes them. Reading (1) when the truth is (2) closes tasks
the user never touched; reading (2) when the truth is (1) discards a tick. The second
is recoverable — the user ticks it again — so **(2) is the default**, and (1) is only
read once the listing is *known* to have agreed with its tasks at some earlier point.

`PMCompassPlugin.verifiedListings` is that knowledge: the set of note paths whose
listing has been checked this session. A note in the set has its boxes read as edits; a
note outside it has its boxes answered by the statuses (`BaseNote.repairChildBoxes`),
and joins the set by having been. The set is per-session and not persisted — a note can
change between two runs of the plugin, and a stored "verified" flag would be a claim
about a file the plugin was not watching.

Notes leave the set on `delete` and on `rename` (by old path), since whatever arrives
at a path next is a note nobody has checked.

The practical cost of a listing that has never been verified is one tick: the first box
you click in that note goes towards checking it rather than closing that task.

## The opening pass

`repairListings()` (`model/project/listing-repair.ts`) is the bulk version, run once
per session from the first Dashboard render and available on demand as the **"Check
project and subtask listings against the tasks that exist"** command. It walks every
project and every task and makes each listing agree with the tasks that actually exist:
entries added, titles refreshed, boxes matched to statuses, departed entries dropped.
Every note it covers joins `verifiedListings`.

It walks **every** task, not only those that currently have children. A task that has
lost its last subtask still carries that subtask's line in its own `## Subtasks` and its
id in `subtaskIds`, and skipping it would leave the pass unable to repair the one case
it most needs to. A task with no children and no section costs one read and no write.

It also puts each task's `Project:`/`Parent:` body prefix back in step with its
`parentId`. `moveTask` writes the two together but commits them separately (see
[dashboard.md](dashboard.md)), so a crash between them leaves the listing following one
parent while the status push follows the other.

The pass is **started by the first render, not awaited by it**
(`PMCompassView.render()` → `plugin.ensureListingsVerified`). It reads every project
and task note, which on a large vault is a visible stall, and blocking on it buys
nothing: a note the pass has not reached yet is exactly the unverified case
`syncChangedNote` already handles by answering that note's boxes with the statuses.
`verifyListingsOnLoad` (default on) turns the pass off entirely, leaving each note to
earn its standing the first time it changes.

Both the pass and the per-note repair are idempotent, and the pass writes nothing on a
vault already in step — including the frontmatter, which is guarded separately because
`processFrontMatter` rewrites a file whatever its callback does and `touch()` would
stamp `updatedAt` on every note in the vault, on every pass, waking the box handler once
per note as it went. The id list also keeps whatever order it already has, so a repair
that changes nothing else can't reshuffle a field obsidian-pm writes too and hand Sync a
conflict for free.

## Entries the plugin does not own

A `## Tasks` section is an ordinary markdown heading in a note the user owns, and
`[[2026 Q3 review]]` may well be sitting under it because they put it there.

An entry `repairListings` can't account for is therefore removed **only** when its
basename resolves to a `pm-task` note in the folder the children live in — positive
evidence that the plugin wrote it and that the task has since moved elsewhere.
Everything else stays. A folder-relative lookup cannot tell a link the user wrote from a
task note that has been deleted, and an unattended pass over every project note in the
vault must not guess between them.

That leaves a real gap: a task deleted **outside** the plugin, whose file is gone and
whose entry is consequently indistinguishable from a user's link to a note not created
yet. `unlinkDeletedTask()` closes it from the other side, off the vault's `delete`
event — there the deletion itself is the evidence and the path is exact. It tries the
project note that owns the folder first (one read, the common case), then only the
sibling task notes whose cache shows a non-empty `subtaskIds`, so a 200-task project
costs one read rather than 200. The stale id in the frontmatter is left for the next
`syncChildLinks` to prune.

Its body edit goes through `vault.process` rather than a read-then-modify pair: the
delete event fires part-way through `ProjectTaskFile.delete` (the file is trashed before
its parent is unlinked), so the two can be editing the same note at once.

## Matching an entry

Two regexes read the checklist, and both are anchored to the start of a line. An
indented `- [ ] [[some-task]]` nested under an entry is the user's own breakdown of it,
and is neither read as a child nor rewritten as one. Edits are confined to the span
between the section's heading and the next `## ` heading, so a checklist line quoted in
a task's description can't be mistaken for the real entry, and the heading match is
itself line-anchored so that a `### Tasks` sub-heading — or a `## Tasks` quoted in the
prose — doesn't open a section.

Entries are written `- [x] [[basename|Title]]` but matched with the alias optional, so a
hand-edited `[[basename]]` is still found; rewriting one keeps it bare rather than
inventing an alias for it.

`- [x]` means **done** specifically. A cancelled task is closed but was never finished,
so its box stays clear, and unticking a box reopens a task as `todo`.

## Where a task's own entry lives

The reverse lookup — given a task, which note lists it? — is read off the
`Project: [[…]]` / `Parent: [[…]]` wiki-link that opens the task's body, not off its
`parentId`. The link names a basename, which is what the checklist matches on, and it
travels in the same file as the task. `projectFileForTask()` reads
`<project>_tasks/` back to `<project>.md` for the `Project:` case.

A task with no such prefix — a hand-made note — has no entry to sync, and is left
alone rather than guessed at.

## Related documents

- [overview.md](overview.md) — what the plugin is for and how its features fit together
- [dashboard.md](dashboard.md) — `moveTask`'s write ordering, and the events that drive the sync
- [settings.md](settings.md) — `verifyListingsOnLoad`
- [class-map.html](class-map.html) — full class map; `BaseNote` sits above `ProjectFile` and `ProjectTaskFile`
