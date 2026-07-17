# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Promote an inbox or daily-note task into a project task, under an existing project or a new one.
- "Move task…" in the task context menu, to move a task and its subtasks to another parent or project.

### Changed

- Renamed the dashboard view title from "Project manager dashboard" to "PM Compass dashboard".
- Root tasks are recorded in the project's `taskIds` and `## Tasks` when promoted or moved.

### Fixed

- Moving a task drops dependencies it can no longer satisfy.

## [1.0.5] - 2026-07-11

### Fixed

- Empty dashboard when the daily-notes folder does not exist on disk.

