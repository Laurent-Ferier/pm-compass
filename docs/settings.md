# Settings — Technical Description

`PMCompassSettingTab` (`ui/settings-tab.ts`, extends Obsidian's `PluginSettingTab`) is the plugin's settings screen, opened from Obsidian's own Settings window or via the gear icon on the Dashboard. It edits `PMCompassPlugin.settings` directly and calls `plugin.saveSettings()` after every change — there's no separate "save" step.

**The fields themselves are documented where they live**, in `PMCompassSettings` (`model/settings.ts`), each with its default and the code that reads it; the recurring-habit shape is `RecurringTaskDefinition` (`model/daily/recurring-task.ts`). This document covers only what the types don't say.

Not every field has a control here: the sort mode and direction come from the Inbox's own sort bar, and `panelConfig`/`nodePositions`/`dashboardCollapsed` are written by the views that use them. The screen groups the rest under "Project Manager integration", "Daily Notes integration" and "Confirmations".

Each `confirm*` field is read where the action happens and passed to `confirmAction()` (`ui/task-creator.ts`), which opens a `ConfirmModal` when the field is on and runs the action itself when it is off.

## Recurring habits

The settings-screen row for each habit (`displayRecurringTaskRow`) has an always-editable title field (Enter or blur commits, Escape reverts), one toggle button per weekday, an active toggle at the end of the title line — which greys the weekday row out when off, though the buttons stay clickable so a schedule can be adjusted before switching the habit back on — reorder buttons (swapping `order` with the adjacent row), a pencil opening `RecurringTaskModal` for the multi-line `detail` text, and delete.

Obsidian's components can only append to a `Setting`'s `controlEl`, and on a phone it stretches each of them to the full row width. `displayRecurringTaskRow` therefore regroups them afterwards into a `.pm-recurring-task-days` row and a `.pm-recurring-task-actions` row, which is what lets the CSS lay a habit out as `title / Mo–Su / actions` on a narrow screen.

**Reconciliation** — keeping daily notes in step with the current definitions — isn't triggered from this screen. It happens automatically:

- `PMCompassPlugin` watches `vault.on("create")` and `workspace.on("file-open")`; when a daily note for **today or a later day in the current ISO week** is opened or created, it debounces (800ms) a call to `DayMarkdownFile.reconcileRecurringHabits()` for that note. Past days are never touched, so editing today's habit list can't retroactively rewrite a note from earlier in the week.
- The Dashboard and Week Summary tabs also call `backfillRecurringHabits()` on every render, to guarantee the current week's notes are complete before being read (the Inbox tab skips it, since it doesn't depend on it).
- A manual "Backfill recurring habits for this week" command covers on-demand use.

Renaming a habit's `title` does not rewrite lines already inserted under the old title — those keep their text and are simply no longer matched by future reconciliation, so nothing already written to a note is silently changed.
