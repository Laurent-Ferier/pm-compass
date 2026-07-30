# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

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

