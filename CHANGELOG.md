# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed

- The inbox holds a project task with no deadline whether or not it has a priority.
- The icon picker leads with the glyphs, offers every emoji Unicode names, and searches both by what they stand for.
- A project card in the graph draws its icon as a watermark.

## [1.2.1] - 2026-08-14

### Added

- The graph's project grid makes and deletes projects, from a right-click.
- A project's card in the graph carries its icon, and so does the leading slot of its tasks' rows in the dashboard and the inbox; a project left with the icon it was created with is drawn as before.
- A project's icon is picked from a searchable grid of emoji and of Obsidian's own glyphs, instead of typed.

### Fixed

- The graph's cards are readable on a light theme.
- A row's icons and buttons show one tooltip, not two.
- Escape on an open calendar or icon grid closes only that popup, not the dialog under it.

### Changed

- The plugin's description leads with what it gives you, in the community list and the README.
- The ribbon icon names the PM Compass dashboard, telling it apart from Project Manager's.
- The add-task bar sits under the list instead of scrolling away with it.
- A half-typed task survives clicking away, switching tab and the refresh that redraws the tab; Escape throws it away.

## [1.2.0] - 2026-08-11

### Added

#### Task graph

- Dragging a card onto another moves the task under it; onto a breadcrumb entry, it moves there.
- Dragging either end of a dependency re-points it, and a task's menu links it to a task on another level, in either direction.
- Cards resize by their bottom-right corner, a project's card included, each keeping a place of its own.

#### Inbox

- A project picker in the inbox's bar narrows its undated project tasks to the projects you pick.

#### Tasks and projects

- A project can be archived, keeping its tasks out of the graph, the dashboard and the inbox.

#### Dialogs

- Shift+Enter confirms a dialog from anywhere inside it; Escape still cancels.
- A setting per confirmation dialog turns that question off.

### Changed

#### Task graph

- The graph shows one level at a time: the projects at the top, a level's own tasks in a frame naming what they belong to, and the tasks beyond it as dotted cards around that frame nothing acts on.
- Dropping cytoscape.js to draw the graph shrinks the plugin from 658 KB to 164 KB.
- A card's place and size live on its note as `cardLayout`, and "Reset layout" forgets the two separately; positions dragged before this are not carried over.
- The graph places each card in the nearest room the ones already drawn leave it, so a resized card pushes its neighbours aside.
- A card's title wraps over as many lines as it has room for, and a card no size has been set for is as tall as its whole title.
- A card's edit and connect buttons sit together mid trailing edge, clear of the resize corner; a done or cancelled card is faded until hovered or picked.
- A dependency can join two tasks at different levels, as long as neither is below the other, and is drawn dashed wherever it reaches; between two closed tasks it fades as they do, and moving a task keeps it.

#### Dashboard

- The dashboard's tasks always load in the background — it shows at once, Overdue and Next up fill in as the day notes are read — and the setting that turned this off is gone.
- Approaching Deadlines and Priority Queue are one "Priority Queue", overdue tasks first.

#### Tasks and projects

- A project task's row offers add-subtask, move and delete as their own icons, in place of the "More actions" menu.
- A subtask whose parent note was deleted outside the plugin moves up to its project on its own.

#### Dialogs and panels

- The task dialog's Start and Due open the plugin's own calendar, not the platform's date picker.
- Every dialog's buttons look and sit the same: Cancel, then the confirm button; the move dialog opens on where the task currently sits.
- Every panel opening over a view — the graph's gear panel, the inbox's pickers, the dropdowns, the date picker — is one surface.

#### Notes and syncing

- Every task is read through one model layer that holds what it has read, re-reads only the notes that changed, and warms itself in the background from plugin load.
- A row a screen is showing is the note itself, so an edit lands on every list holding it and a re-read that changes nothing redraws nothing.
- The tabs redraw when a note has actually changed — a project note edited, a checklist ticked by hand, an inbox item written into a day note — not whenever Obsidian reparses one.
- The checklists are kept in step whether or not a PM Compass tab is open, and only for the notes that changed.

#### Documentation

- The docs are split into a user's guide and technical notes, the latter holding a class-by-class data model with generated mermaid diagrams and the settings tab's two render paths.

### Removed

- The commands that backfilled the week's habits and checked the listings: both run on their own, when the dashboard opens and at the start of each session.

### Fixed

#### Task graph

- "None" lines up with the other rows in the priority picker.
- A screen too narrow for where the project cards were put lays them out to fit instead of drawing them past its edge.
- A task moved somewhere new is drawn where its new siblings leave it, not where it was dragged among the ones it left.

#### Dashboard

- An open dashboard no longer re-reads the week's day notes over and over, and an edit to today's note redraws it once, not twice.
- The weekday names in the week summary and the habit settings follow your locale, as the calendar already did.
- The day chips under a habit are all one width and one line tall.

#### Tasks and projects

- A task's priority ribbon and deadline roll up the whole tree above it, closed links included.
- Saving the task editor keeps a description edited on the note meanwhile, and says so.

#### Dialogs and panels

- The date picker opens in the window its tab is in, so it works in a popped-out leaf.

#### Notes and syncing

- An edit to a note made while the plugin rewrites its listing is no longer overwritten.
- The tabs redraw right after a change you made, rather than a few seconds later and again after that.
- The start-of-session listing check waits for Obsidian to have listed the vault, and a task note arriving from a sync or an editor is listed by its project or parent without waiting for the next session.

#### Mobile

- Panels and fields draw their border on a phone again.
- Tapping a card's edit button on a phone opens the task or project dialog instead of closing it at once.

## [1.1.1] - 2026-07-31

### Changed

- The author name in Obsidian's plugin list links to the author's GitHub profile.
- Each settings section is a card of its own on Obsidian 1.13.0+.
- Habits are a drag-to-reorder list on Obsidian 1.13.0+.

## [1.1.0] - 2026-07-30

### Added

- The author name in Obsidian's plugin list links to a contact address for bugs and ideas.
- A project task's row has a "Move to inbox" button, clearing its deadline.
- The Inbox tab links to the inbox note, opening it in a tab.
- The dashboard has an add-task bar, opened from a + beside the date, writing onto the day it is showing.
- The dashboard shows the project tasks completed on the day it is showing.
- The settings tab is searchable on Obsidian 1.13.0+.
- Inbox items and the day's tasks have a priority, set from a ribbon on the row.
- The Inbox can be sorted by deadline, priority, title or file order, in either direction.
- Inbox items (in file order) and the day's checklist tasks can be reordered by dragging their grip.
- Daily and project tasks share one dashboard, by date, under "Overdue", "Current" and "Next up".
- An inbox item planned for a day shows in the dashboard under that day.

### Changed

- The settings tab is regrouped, with day counts picked rather than typed.
- No day note is created while the daily notes core plugin is off and has left no folder or format behind; existing ones are still read.
- A release ships a minified plugin, a seventh of the size it was.
- Tasks sharing an inherited priority are ordered by how urgent their own subtree is.
- Closed tasks sort below open ones, in every list and every order.
- A task's status and its checkbox in the project or parent note stay in step; a setting turns off the check when the dashboard opens.
- A ticked task keeps its note, promote and delete actions.
- Editing a task title in place gives the field the whole row.
- Scheduling a task for a day with no daily note leaves it in the inbox with a target date, honoured once that note appears.
- A planned inbox item raises no staleness warning; its ⏳ badge turns red instead, once that day has gone by.
- The date picker is now a themed in-app calendar.
- The dashboard and task graph skip off-screen rebuilds, for performance.
- Daily and project tasks share one row: a leading marker, the same badges, a wrapping title, and the dates it is sorted by at the end.
- A task's ribbon fades from the highest priority above it to the highest below it, in the dashboard and the graph alike.
- The priority, status and sort dropdowns mark the value in force.
- Clicking a task's day takes the dashboard to it, and clicking its project opens the task graph.
- The Inbox sorts its own items and the project tasks beside them as one list; its buttons name the order in effect and what breaks its ties.
- Cancelling a task cancels everything below it, at any depth.
- Every icon now comes from Obsidian's own set, so all of them follow the theme.

### Fixed

- A task or project is shown once when a syncing tool has left conflict copies of its note beside it.
- A project or parent note's listing follows the task it names, wherever the change came from: created, renamed, moved, closed, reopened or deleted.
- A ticked inbox item planned for a day can still have that day cleared.
- Creating a daily note kept at the vault root no longer makes a folder named after part of its date.
- Promoting an inbox item to a project task keeps its deadline, including a ⏳ planned day.
- Promoting a day-note task gives the project task that day as its deadline.
- The dashboard reads every date against the day it shows, and badges that day's own rows with "today".
- A project task's age counts from today, not from the day the dashboard is showing.
- The row action buttons no longer cover the text while editing a task title.
- The priority and status dropdowns open anchored to their badge and stay inside the window.
- The dashboard keeps its scroll position when a task is edited.
- A task's ribbon shows both its own priority and the one inherited from its parent.
- The dashboard no longer opens blank on mobile after being built inside a closed drawer.
- A graph card's priority bar is easier to hit on a phone, and its dropdowns no longer close as the finger lifts.

## [1.0.7] - 2026-07-19

### Fixed

- The date picker opens anchored to its button.
- Recurring habits follow the order set in settings.

## [1.0.6] - 2026-07-17

### Added

- Promote an inbox or daily-note task into a project task, under an existing project or a new one.
- "Move task…" in the task context menu, to move a task and its subtasks to another parent or project.
- Warning glyphs flagging a completed task with open subtasks, or an open task under a completed parent.

### Changed

- Renamed the dashboard view title from "Project manager dashboard" to "PM Compass dashboard".
- Root tasks are recorded in the project's `taskIds` and `## Tasks` when promoted or moved.
- A habit's active toggle moved to its title line, and greys out the weekday buttons when off.

### Fixed

- Moving a task drops dependencies it can no longer satisfy.
- Saving a task edit before its description loads no longer blanks the description.
- Moving a task into a project with a same-named file keeps its subtask links correct.
- A failed vault write now shows a notice instead of failing silently.
- Mobile: the note chevron no longer overlaps a task's title.
- Mobile: the last rows of the Dashboard and Inbox are no longer stuck behind the navbar.
- Mobile: a habit's weekday buttons stay on one row in settings.

## [1.0.5] - 2026-07-11

### Fixed

- Empty dashboard when the daily-notes folder does not exist on disk.

