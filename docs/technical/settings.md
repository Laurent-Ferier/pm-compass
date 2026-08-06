# Settings — Technical Description

The plugin's settings screen: how it describes itself to the two Obsidian versions that ask for it in different ways, how a recurring habit is edited, and which settings have no control on it at all. The fields themselves are documented where they live, in `PMCompassSettings` (`src/model/settings.ts`), each with its default and the code that reads it; the shape of one habit is `RecurringTaskDefinition` (`src/model/daily/recurring-task.ts`). The listings the `verifyListingsOnLoad` setting governs have a document of their own: [task-listings.md](task-listings.md).

## The screen

[**PMCompassSettingTab**](../../src/ui/settings-tab.ts) — *extends Obsidian's `PluginSettingTab`* — is responsible for describing the screen as sections of entries, and for answering both ways Obsidian asks for them:

- `getSettingDefinitions()` hands the description over on 1.13.0+, where Obsidian draws the rows and indexes them for the settings search.
- `display()` walks the same sections and draws them itself on 1.12.x.
- `rerender()` is either one again after a value changed — `update()` on 1.13.0+, `display()` below it.

Both paths build a row through the same `build` callback, so a control is written once. It edits [**PMCompassPlugin**](../../src/main.ts)`.settings` directly and saves after every change; there is no separate "save" step, and a setting a view has to be told about names its refresh in the entry that edits it.

The description is three shapes, all in [settings-tab.ts](../../src/ui/settings-tab.ts):

- `SettingEntry` — one row: its name, its description, the aliases the search also matches, and the callback that fills it. The typed entry builders (`toggleEntry`, `textEntry`, `numberEntry`, `warningEntry`) name the settings field they edit rather than spelling out a getter and a setter.
- `SettingSection` — a run of rows under one heading, and optionally a list. On 1.13.0+ a section is a setting group, which is what draws a card around it; on 1.12.x the heading is a row and the CSS joins the run below it.
- `SettingList` — the rows standing for items the user adds, reorders and removes, with the callbacks that do so. On 1.13.0+ Obsidian draws those affordances itself — a drag handle and a delete button per row, an add control in the list header. On 1.12.x there is no such list, so `entries(true)` asks each row to draw its own move and delete buttons and the add control follows as a row of its own.

The sections are General, Project manager integration, Daily notes integration, Recurring daily habits and Confirmations.

> **Note:** the daily notes section warns when no day note can be created. Answering that reads the vault, so a tab opened on such a vault draws once without the warning and `refreshDayNotesState` asks for one re-render.

## Recurring habits

The habits are a `SettingList`: `buildRecurringTaskRow` fills one row, and the section supplies the add, reorder and delete callbacks. A row carries

- an always-editable title field — Enter or blur commits, Escape reverts, an unchanged or blank value reverts in place rather than re-rendering;
- an active toggle at the end of the title line, which greys the weekday row out when off, the buttons staying clickable so a schedule can be adjusted before switching the habit back on;
- one toggle button per weekday, over the `weekdays` bitmask;
- a pencil opening [**RecurringTaskModal**](../../src/ui/recurring-task-modal.ts) for the multi-line `detail` text;
- move-up, move-down and delete buttons, on 1.12.x only — 1.13.0+ takes those from the list.

Obsidian's components can only append to a `Setting`'s `controlEl`, and on a phone it stretches each of them to the full row width. The row therefore regroups them afterwards into a `.pm-recurring-task-days` row and a `.pm-recurring-task-actions` row, which is what lets the CSS lay a habit out as `title / Mo–Su / actions` on a narrow screen. A 1.13.0+ list draws its drag handle and delete button into `controlEl` after the callback has run, so a `MutationObserver` moves whatever lands there later into the action row.

Renaming a habit's `title` does not rewrite lines already inserted under the old title — those keep their text and are simply no longer matched by future reconciliation.

Saving a definition writes nothing to the daily notes: the screen edits the settings, and getting the notes back in step with them is [**TaskStore**](data-model.md#taskstore--srcmodelstoretask-storets)'s.

## Settings with no control here

- `inboxSortBy`, `inboxSortDir`, `inboxHidePlanned` and `inboxHiddenProjects` are written by the Inbox's own sort bar and filters.
- `panelConfig` and `dashboardCollapsed` are written by the views that use them.

Each `confirm*` field is read where the action happens and passed to `confirmAction()` ([task-creator.ts](../../src/ui/task-creator.ts)), which opens a [**ConfirmModal**](../../src/ui/task-creator.ts) when the field is on and runs the action itself when it is off.
