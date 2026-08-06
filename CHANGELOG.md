# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- A project picker in the inbox's bar narrows its undated project tasks to the projects you pick.
- A setting per confirmation dialog, at the bottom of the settings page, turns that question off.
- A project can be archived, keeping its tasks out of the graph, the dashboard and the inbox.
- Dragging a card in the task graph onto another moves the task under it; dropping it on a breadcrumb entry moves it there.
- Dragging either end of a dependency onto another card re-points it, which is how a dependency reaches a task on another level.
- A task's menu can link it to a task beside the one the level belongs to, in either direction.
- Shift+Enter confirms a dialog from anywhere inside it; Escape still cancels.
- A card in the task graph is resized by pulling its bottom-right corner.
- A project's card can be moved and resized too, each keeping a place of its own from the first time it is drawn.

### Changed

- The tabs redraw when a project note has actually changed, not whenever Obsidian reparses one.
- The checklists are put back in step only for notes that actually changed, so the plugin's own repairs cost no further pass.
- A checklist ticked by hand counts as the note having changed, so the tabs redraw with it.
- Checking the project listings frees a task whose parent no longer exists, and reports task notes it can't read or place.
- The checklists are kept in step whether or not a PM Compass tab is open.
- The documentation has been revised to read as a user's guide.
- The docs are split into a user's guide and technical notes, the latter holding a class-by-class data model whose diagrams are generated from mermaid sources.
- Every dialog's buttons look and sit the same: Cancel, then the confirm button.
- A project task's row offers add-subtask, move and delete as their own icons, in place of the "More actions" menu.
- Every task is read through one model layer, which holds what it has read, re-reads only the notes that changed, and warms itself in the background from plugin load.
- A row a screen is showing is the note itself, so an edit lands on every list holding it and a re-read that changes nothing redraws nothing.
- The dashboard's tasks load in the background: it shows at once, and Overdue and Next up fill in as the neighbouring day notes are read.
- The general setting that turned off loading the dashboard's tasks in the background is gone — it always does.
- The dashboard's Approaching Deadlines and Priority Queue are one "Priority Queue", overdue tasks first.
- Dropping cytoscape.js to draw the task graph, which shrinks the plugin from 658 KB to 164 KB.
- The move dialog opens on where the task currently sits.
- Moving a task keeps its dependencies; ones held further down are drawn as dashed edges.
- Tasks the graph depends on, and ones depending on it, are drawn beside it as dotted cards nothing acts on.
- The task graph shows one level at a time: the projects at the top, and a level's own tasks below, drawn in a frame naming the project or task they belong to, with the tasks beyond it hung around that frame.
- A dependency can join two tasks at different levels of a project, as long as neither is below the other.
- Every panel opening over a view — the graph's gear panel, the inbox's pickers, the dropdowns, the date picker — is one surface.
- Where a graph card sits and how big it is are stored on the task's note as `cardLayout`, not in the plugin's settings; positions dragged before this are not carried over.
- The graph's "Reset layout" is split in two: one forgets the card positions, the other the card sizes.
- The graph places each card in the nearest room the ones already drawn leave it, so a resized card pushes its neighbours aside.
- A dependency line has one dashed form, whether it is held below the level or reaches outside it.
- A dotted card's dragged-to position is no longer remembered between renders.

### Fixed

- The tabs redraw right after a change you made, rather than a few seconds later and again after that.
- The start-of-session listing check waits for Obsidian to have listed the vault, rather than reading a folder still filling up and checking a handful of notes.
- A task note that arrives from a sync or an editor is listed by the project or parent that should hold it, without waiting for the next session.
- A task moved somewhere new is drawn where its new siblings leave it, rather than keeping the place it was dragged to among the ones it left.
- A task's priority ribbon and deadline roll up the whole tree above it, closed links included.
- Panels and fields draw their border on a phone again.
- Tapping a card's edit button on a phone opens the task or project dialog instead of closing it at once.
- The day chips under a habit in the week summary are all one width and one line tall.

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

