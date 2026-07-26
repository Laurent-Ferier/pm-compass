# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- The settings tab is searchable on Obsidian 1.13.0+.
- Inbox items and the day's tasks have a priority, set from a ribbon on the row.
- The Inbox can be sorted by deadline, priority, title or file order, in either direction.
- Inbox items (in file order) and the day's checklist tasks can be reordered by dragging their grip.

### Changed

- Scheduling a task for a day with no note yet gives it a target date, cleared or hidden from the Inbox and honoured once that day's note appears; replaces the small-task planning window setting.
- The date picker is now a themed in-app calendar.
- The dashboard and task graph skip off-screen rebuilds, for performance.

### Fixed

- The row action buttons no longer cover the text while editing a task title.

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

