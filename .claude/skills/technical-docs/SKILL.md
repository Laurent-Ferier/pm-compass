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

**A list of parallel things keeps one shape.** Decide the questions each entry answers and in what order — what it is, what it holds, what standing it has, what is kept of it — and answer every one in every entry. An entry that skips a question leaves a hole a reader feels, and one that wanders into a different question reads as a different list.

**Answer the lead-in, and nothing else.** A list introduced by "…and what a model holds of each" answers exactly that, entry by entry. Which class picks between two constants, or what a pass later does with the value, belongs to the section that owns it — name it and link there. What belongs to no entry goes in its own short list after, never inside the nearest bullet.

**A section's first line is a fact, not a menu.** "What a task and the note listing it are made of, and where each part of that lives" only paraphrases the heading above it. State what the section claims — "The model is read out of the notes, and the notes carry redundancy: only the frontmatter and the checklist are held in memory" — and let the diagram and the list carry the rest. Announcing scope is the opening paragraph's job, once per document.

**Leave out the trivial.** A type whose whole content is the names of its fields, a constant pairing two strings, a helper that does what it is called — none of them earn an entry, however neatly it is written. Ask what the entry says that the declaration does not; if the answer is "it names its own fields", drop it.

**Never point forward.** A clause saying what the next section will explain tells a reader something they are about to be told; the heading below already promises it. Cut it, and cut any clause an earlier entry has answered — including one just added on request, judged where it landed rather than as it was asked for.

**"Nothing" is an answer.** Where an entry has no counterpart — no reading holds it, nothing reads it, no one writes it — say so in the slot the other entries fill. A silently missing answer reads as an oversight.

**A section about structure says what is held; a section about process says what runs.** Keep them apart: the shape and its parts first, the sequence diagrams and their walkthroughs after. A method name in a structure list is a warning that the two have mixed — `listingFromCache` earns its place only because it names what turns this file into that field.

**Name the invariant, then what follows from it.** "A bug below costs a stale checklist, not a lost task" is the consequence, and leaves the reader to work out the rule behind it; "While the frontmatter is right, nothing is lost — the views are built from it alone, and a drifted listing is rebuilt from it" states the invariant and lets the consequence hang off it. Where a subsystem is allowed to be wrong, say what has to stay right.

**Say it the plain way round: event, then effect.** "A task's own status or title moving onto the line that lists it, in its project or its parent task" was called difficult to read, and rightly — the subject is a gerund and two qualifications sit between dashes before the sentence lands. "Updating the task list according to a change in a task's title or status" carries the same fact with nothing stacked in the middle. When a sentence needs an aside to be true, the aside usually belongs to a bullet under it.

**When the reader restates your sentence, that is the sentence.** A paraphrase offered back — "I see, this is about updating the task list according to a change in its title or status" — is the reader telling you what they understood and how they would have written it. Adopt their words and their structure, fixing the grammar and any loose reference as you go ("its" → "a task's"). Change nothing else: an accurate second sentence about which parts of the entry move is still an answer to a question nobody put.

**Be succinct.** Cut the trailing clause that restates the sentence it hangs off ("…, so a re-read landing what the model already held reaches nobody", "…, and this interface is the whole of what a model may be asked"). If a sentence would survive being deleted, delete it.

- **Never open with "What …"** — not "What a task is", not "What one project note reads as", not "What the plugin makes of a note". A noun phrase alone is not a responsibility either: "One day note, or the inbox: its lines as last read" says what it holds, not what it answers for.
- **Name the values, don't gesture at them.** "what every task holds, whichever kind it is" and "what a row draws" tell a reader nothing — list them: title, status, priority, dates, tags. Then say who uses them ("a row renderer draws any task from these").
- **A responsibility is something done or held, never something *been*.** No "responsible for being a task", no "responsible for being the one way in". Write what it holds and what it answers: "responsible for what every task holds, whichever kind it is, and for ordering two of them"; "responsible for every read of and write to the day notes and the inbox".
- **An interface answers, it doesn't "say what someone needs".** "**ModelStore** is responsible for saying what a model needs of the store holding it" describes the declaration, not the job. Write what it does when called — "collecting the changes models report and passing them on to whoever listens" — and name the class that answers it.
- **Say what it does, not what it doesn't.** Drop "and nothing else", "it decides nothing about…", "is no part of it" unless the exclusion is a rule a reader would otherwise get wrong.
- **A responsibility never names the caller.** **IModel** answers `refresh()` when its data changed; that a note is what calls it is not **IModel**'s to know. Write the class from inside the class.
- **Say what is *not* its.** The line that keeps a layer honest is usually the one that hands something away: "Which tasks are its children is no part of it — that is **ProjectTaskStore**'s `childrenOf`."
- **No anecdotes, and no war stories.** "which is why it imports nothing", "measured on a phone: three notes out of 123", "being a separate class is what says so" — how the code came to be that way is not what it does. State the rule the bug taught, not the bug.
- **Don't justify a line of code the code already justifies.** If a comment beside it explains why a call waits, a lock is taken, or a guard exists, the document says what happens and stops. Repeating the reasoning means two places to keep true.
- **Generic parameters come after the responsibility**, never before it — a reader meets **BaseModel** before they meet its `NoteFile`. Say that they are generic parameters: "Its generic parameter `NoteFile` extends **ModelFile**: …" for one, "Two generic parameters:" and a bullet each for more. Each says what it stands for and what the known subclasses bind it to.
- **Give a parameter its constraint**, so the same thing never gets two names in prose ("`NoteFile` … named as **ModelFile**"). `extends` is a word of the sentence, not part of the code span: `` `NoteFile` extends **ModelFile** ``, `` `Fields` extends `ListingFields` ``. A default reads the same way — "`Edit`, `FieldEdit<Fields>` by default".
- **Name another class, don't describe it.** A section says what *its* class does; anything else is a bold link and, at most, the relationship — "the IO layer listens to it, through **FileCache**". What **FileCache** then does with the call belongs in **FileCache**'s section.
- **Say it once.** A fact stated in its own place is not repeated where it is convenient: the subclasses of a generic class each carry their `*extends `FileStore<ProjectFields, ProjectFile, Project>`*` line, so the parent's section does not list them. Before adding a sentence, ask which section owns that fact — and if it is not this one, link there instead.

## Naming things

- **A class of the system is capitalized, bold and linked** on every mention: `[**BaseFile**](#basefilefields-edit--srcmodeliobase-filets)`. Never in backticks. The link goes to that class's section when the document has one — the GitHub anchor of its heading, lowercased with everything but letters, digits, spaces and hyphens dropped and spaces turned to hyphens — and to its source file otherwise (`../../src/ui/task-list.ts`). A document linking into another names the file too: `data-model.md#basefile…`.
- **Every class named has somewhere to link to.** An interface or class the prose leans on — **ModelFile**, **ModelStore** — earns its own section rather than being explained inside another's.
- **A link carries the path, so don't repeat it**: `[**TaskList**](../../src/ui/task-list.ts) — …`, not the same path again in backticks after the name.
- **A class is not linked in its own section**, nor where its name opens the entry describing it.
- **Backticks are for everything else** — methods (`writeOwed()`), fields (`isDirty`), types and enums (`ChangeOrigin`, `ProjectFields`), file paths, literals. A member of a named class reads **DayStore**`.announce()`.
- **A function or method keeps its parentheses**, every time it is named: `ensureListed()`, `syncChildLinks()`, `processFrontMatter()` — the Obsidian API included. That is what tells a reader which names are called and which are read. Getters do not take them (`readsOnTouch`, `childSection`), nor do fields, types, or event and status names that happen to match a method (`delete`, `done`).
- **Headings keep the signature**: ``### `FileStore<Fields, NoteFile, Model>` — `src/model/store/file-store.ts` ``, with the `*abstract, extends …*` line under it.
- **Type parameters are words, not letters**: `FileStore<Fields, NoteFile, Model>`, never `FileStore<F, N, T>`. The same names go in the code and in the diagrams.

## Diagrams

- The sources are `docs/technical/diagrams/*.mmd`; `pnpm docs:diagrams` renders them, writes `class-map.html`, and fills the ```mermaid fences in the prose. Never edit a fence by hand — edit the `.mmd` and re-run. `pnpm docs:diagrams:check` is what CI runs.
- One diagram per thing a reader is trying to see. A diagram covering two unrelated screens is two diagrams, and a sequence diagram covering two scenarios — a change arriving from outside, a change the plugin makes — is one per scenario.
- **Every diagram sits under a heading of its own, with a sentence or two before it** saying what it answers. A diagram dropped at the end of a section, unannounced, is one a reader skips.
- **Lead with the picture, then the rules.** A subsystem's first section shows its shape — what holds what, which way the arrows run — and the prose after it is short paragraphs stating the rules that picture raises. Pages of mechanism before a reader knows what is a copy of what lose them, however accurate.
- Every generic class carries a `note for X "…"` saying what its parameters stand for, and every inheritance edge that binds one says so: `ListingFile <|-- ProjectFile : Fields = ProjectFields`.
- A new source needs an entry in `CAPTIONS` in `scripts/render-diagrams.mjs` — that is what orders the page — and a `<!-- diagram:name -->` / `<!-- /diagram -->` pair in the prose.

## A scenario walked through

A sequence diagram is followed by its scenario in prose — what happens, in order, from the first event to the redraw.

- **A numbered list, one item per arrow.** The diagram is `autonumber`ed, so item *n* is arrow *n*, in the same order, branches included. Never a paragraph a reader has to match against the picture themselves, and never a run of steps merged into one item.
- **One step, one sentence.** A step whose sentence needs a second clause to hold up is usually two steps, or a detail that belongs to the class's own section.
- **Classes are linked here as everywhere** — bold and linked on their first mention in each list, the diagram's participants included.
- **Point at a detail rather than half-telling it.** Where the *why* belongs to a class's own section, name the thing and link it — "the cache refreshes its copy of the note — cf. [`readsOnTouch`](#…)" — instead of a clause that gestures at a distinction it doesn't explain. A reader who wants the split reads that section.
- **Say the plain thing.** If a step is "the cache refreshes its copy of the note", write that, not a sentence walking around it ("what the cache holds was parsed before the edit, so the note is read again"). If naming what happens takes a paragraph, the step is at the wrong altitude.

## Prose

- **An aside is a blockquote callout**, not a paragraph among the others: `> **Note:** …` — for what qualifies a description rather than states it (which subclass supplies what, the case that doesn't apply). GitHub renders it as a callout, so a reader sees at a glance that it is a remark.
- **Never hard-wrap.** One line per paragraph, list entry, heading or table row, however long it runs.
- **Keep it factual and short.** State the rule and stop; no selling, no reassurance, no drawing a moral.
- **Open with "This document describes …"**, and say what the document covers — the subsystem, the rules it states, the classes it leans on and where those are documented. Not why the document exists, and not a first fact about the subject with the scope buried later.
- **Never describe the document itself** anywhere but that opening paragraph.
- **Link the sibling document** on the first mention of a subsystem that has one — [task-listings.md](../../../docs/technical/task-listings.md) for the listings, [settings.md](../../../docs/technical/settings.md) for the settings screen.
- The same rules apply to a class's doc comment in the code: responsibility first, no anecdote, no history of what changed.
