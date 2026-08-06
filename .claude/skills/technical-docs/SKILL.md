---
name: technical-docs
description: Write or refresh one of the plugin's technical documents (docs/technical/data-model.md and its kin) — what each class is responsible for, how the layers fit, and the mermaid diagrams that go with them. Use when asked to document a class, a subsystem or a layer for someone reading the code, or to review such a document.
---

# Writing a technical document

A technical document says what each class is responsible for, and how the pieces stand against each other. It is written for someone with the repo open. It is not a user guide (that is `user-guide`), and it is not a history of how the code got here.

## A class description

Every description opens with the class named, then its responsibility: "**IModel** is responsible for …", or the plainer verb when that reads better — "**BaseTask** holds the information every task needs to be rendered or sorted:". Then, if it is worth saying, how an instance is identified. Then only what a reader can't get from the signature: the rule the class enforces, what it refuses to answer, what a subclass has to supply.

> **`IModel`** — **IModel** is responsible for taking a change to the data it holds: `refresh()` when that data has changed, `discard()` when it is gone. A model is identified by `id`, and by the `filePath` its data was read from.

Where the name already opens the line — a bullet in a list of views — it reads "… — it is responsible for …" instead. Never "Responsible for …" with no subject.

**Enumerations are bullet lists.** A description listing what a class answers — its methods, its events, the values it reports — puts them one per line rather than running them together in a sentence: `- \`refresh()\` — that data has changed.` A sentence carrying more than two of them is a list waiting to be written.

**State the rule, not the mechanism.** "It keeps track of which notes have gone stale and reads them on demand" is what a reader needs; which call marks the path, which call finds the mark, and in what order, is in the code. Walk through a mechanism only where the order is the point (an echo suppressed, a lock taken, a write that must land before a read).

**Be succinct.** Cut the trailing clause that restates the sentence it hangs off ("…, so a re-read landing what the model already held reaches nobody", "…, and this interface is the whole of what a model may be asked"). If a sentence would survive being deleted, delete it.

- **Never open with "What …"** — not "What a task is", not "What one project note reads as", not "What the plugin makes of a note". A noun phrase alone is not a responsibility either: "One day note, or the inbox: its lines as last read" says what it holds, not what it answers for.
- **Name the values, don't gesture at them.** "what every task holds, whichever kind it is" and "what a row draws" tell a reader nothing — list them: title, status, priority, dates, tags. Then say who uses them ("a row renderer draws any task from these").
- **A responsibility is something done or held, never something *been*.** No "responsible for being a task", no "responsible for being the one way in". Write what it holds and what it answers: "responsible for what every task holds, whichever kind it is, and for ordering two of them"; "responsible for every read of and write to the day notes and the inbox".
- **An interface answers, it doesn't "say what someone needs".** "**ModelStore** is responsible for saying what a model needs of the store holding it" describes the declaration, not the job. Write what it does when called — "collecting the changes models report and passing them on to whoever listens" — and name the class that answers it.
- **Say what it does, not what it doesn't.** Drop "and nothing else", "it decides nothing about…", "is no part of it" unless the exclusion is a rule a reader would otherwise get wrong.
- **A responsibility never names the caller.** **IModel** answers `refresh()` when its data changed; that a note is what calls it is not **IModel**'s to know. Write the class from inside the class.
- **Say what is *not* its.** The line that keeps a layer honest is usually the one that hands something away: "Which tasks are its children is no part of it — that is **ProjectTaskNoteStore**'s `childrenOf`."
- **No anecdotes, and no war stories.** "which is why it imports nothing", "measured on a phone: three notes out of 123", "being a separate class is what says so" — how the code came to be that way is not what it does. State the rule the bug taught, not the bug.
- **Don't justify a line of code the code already justifies.** If a comment beside it explains why a call waits, a lock is taken, or a guard exists, the document says what happens and stops. Repeating the reasoning means two places to keep true.
- **Generic parameters come after the responsibility**, never before it — a reader meets **BaseModel** before they meet its `Note`. Say that they are generic parameters: "Its generic parameter `Note` extends **ModelNote**: …" for one, "Two generic parameters:" and a bullet each for more. Each says what it stands for and what the known subclasses bind it to.
- **Give a parameter its constraint**, so the same thing never gets two names in prose ("`Note` … named as **ModelNote**"). `extends` is a word of the sentence, not part of the code span: `` `Note` extends **ModelNote** ``, `` `Fields` extends `ListingFields` ``. A default reads the same way — "`Edit`, `FieldEdit<Fields>` by default".
- **Name another class, don't describe it.** A section says what *its* class does; anything else is a bold link and, at most, the relationship — "the IO layer listens to it, through **NoteCache**". What **NoteCache** then does with the call belongs in **NoteCache**'s section.
- **Say it once.** A fact stated in its own place is not repeated where it is convenient: the subclasses of a generic class each carry their `*extends `NoteStore<ProjectFields, ProjectNote, Project>`*` line, so the parent's section does not list them. Before adding a sentence, ask which section owns that fact — and if it is not this one, link there instead.

## Naming things

- **A class of the system is capitalized, bold and linked** on every mention: `[**BaseNote**](#basenotefields-edit--srcmodelstorebase-notets)`. Never in backticks. The link goes to that class's section when the document has one — the GitHub anchor of its heading, lowercased with everything but letters, digits, spaces and hyphens dropped and spaces turned to hyphens — and to its source file otherwise (`../../src/ui/task-list.ts`). A document linking into another names the file too: `data-model.md#basenote…`.
- **Every class named has somewhere to link to.** An interface or class the prose leans on — **ModelNote**, **ModelStore** — earns its own section rather than being explained inside another's.
- **A link carries the path, so don't repeat it**: `[**TaskList**](../../src/ui/task-list.ts) — …`, not the same path again in backticks after the name.
- **A class is not linked in its own section**, nor where its name opens the entry describing it.
- **Backticks are for everything else** — methods (`writeOwed`), fields (`isDirty`), types and enums (`ChangeOrigin`, `ProjectFields`), file paths, literals. A member of a named class reads **DayStore**`.announce`.
- **Headings keep the signature**: ``### `NoteStore<Fields, Note, Model>` — `src/model/store/note-store.ts` ``, with the `*abstract, extends …*` line under it.
- **Type parameters are words, not letters**: `NoteStore<Fields, Note, Model>`, never `NoteStore<F, N, T>`. The same names go in the code and in the diagrams.

## Diagrams

- The sources are `docs/technical/diagrams/*.mmd`; `pnpm docs:diagrams` renders them, writes `class-map.html`, and fills the ```mermaid fences in the prose. Never edit a fence by hand — edit the `.mmd` and re-run. `pnpm docs:diagrams:check` is what CI runs.
- One diagram per thing a reader is trying to see. A diagram covering two unrelated screens is two diagrams.
- Every generic class carries a `note for X "…"` saying what its parameters stand for, and every inheritance edge that binds one says so: `ListingNote <|-- ProjectNote : Fields = ProjectFields`.
- A new source needs an entry in `CAPTIONS` in `scripts/render-diagrams.mjs` — that is what orders the page — and a `<!-- diagram:name -->` / `<!-- /diagram -->` pair in the prose.

## Prose

- **An aside is a blockquote callout**, not a paragraph among the others: `> **Note:** …` — for what qualifies a description rather than states it (which subclass supplies what, the case that doesn't apply). GitHub renders it as a callout, so a reader sees at a glance that it is a remark.
- **Never hard-wrap.** One line per paragraph, list entry, heading or table row, however long it runs.
- **Keep it factual and short.** State the rule and stop; no selling, no reassurance, no drawing a moral.
- **Never describe the document itself** beyond the one opening paragraph that says what it covers.
- **Link the sibling document** on the first mention of a subsystem that has one — [task-listings.md](../../../docs/technical/task-listings.md) for the listings, [settings.md](../../../docs/technical/settings.md) for the settings screen.
- The same rules apply to a class's doc comment in the code: responsibility first, no anecdote, no history of what changed.
