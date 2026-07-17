# Settings — Technical Description

`PMCompassSettingTab` (`ui/settings-tab.ts`, extends Obsidian's `PluginSettingTab`) is
the plugin's settings screen, opened from Obsidian's own Settings window or via the
gear icon on the Dashboard. It edits `PMCompassPlugin.settings` directly and calls
`plugin.saveSettings()` after every change — there's no separate "save" step. All
fields live in `PMCompassSettings` (`model/settings.ts`).

## Fields

| Setting | Type | Default | Used by |
|---|---|---|---|
| `syncObsidianPmSettings` | `boolean` | `true` | `main.ts` — on load, overwrites `projectsFolder` from obsidian-pm's own settings file |
| `projectsFolder` | `string` | `"Projects"` | `loadVaultData()` — where to scan for `pm-project`/`pm-task` frontmatter; also where `ProjectFile.create()` writes a project made while promoting. Disabled in the UI while sync is on |
| `inboxFilePath` | `string` | `""` (auto) | `resolveInboxPath()` — Inbox note path; empty means `<Daily Notes folder>/Inbox.md` |
| `inboxStaleAfterDays` | `number` | `7` | `InboxView` — age threshold for the ⚠️ staleness warning (`0` disables it) — see [inbox.md](inbox.md) |
| `unclosedDaysBefore` | `number` | `7` | `DashboardView.loadAdjacentUnclosed()` — how many past days to scan for the "Overdue tasks" section |
| `unclosedDaysAfter` | `number` | `7` | same, for the "Upcoming tasks" section |
| `recurringTasksHeading` | `string` | `"# Routine"` | `DayMarkdownFile` — the markdown heading recurring habits are inserted under/expected below in each daily note |
| `dailyHabitsTag` | `string` | `"daily"` | Tag (without `#`) applied to every recurring habit line; used to identify habit items across the Dashboard, Inbox, and Week Summary, and to strip the tag from a promoted item's title — see [dashboard.md](dashboard.md), [week-summary.md](week-summary.md) |
| `recurringTasks` | `RecurringTaskDefinition[]` | `[]` | the habit list itself, below |
| `panelConfig.showActiveOnly` | `boolean` | `true` | Task Graph — hide done/cancelled tasks by default — see [graph-display.md](graph-display.md) |
| `nodePositions` | `Record<string, {x,y}>` | `{}` | Task Graph — manually-dragged node positions, keyed by node id |
| `dashboardCollapsed` | `Record<string, boolean>` | `{}` | every collapsible section's open/closed state, keyed by a stable section id (e.g. `"tasks.checklist"`) |

`syncObsidianPmSettings` and `projectsFolder` are under a "Project Manager
integration" heading; `inboxFilePath` through the recurring-habits fields are under
"Daily Notes integration". `panelConfig`/`nodePositions`/`dashboardCollapsed` have no
settings-screen UI of their own — they're written by the views that use them.

## Recurring habits

Each entry is a `RecurringTaskDefinition` (`model/recurring-task.ts`):

```ts
{
  id: string;            // stable identity, unrelated to title
  title: string;          // checklist text, without the habits tag
  weekdays: number;       // bitmask, bit 0 = Monday … bit 6 = Sunday
  order: number;          // sort key
  active: boolean;        // inactive definitions are never reconciled or backfilled
  createdAt: string;       // "YYYY-MM-DD", display/sort only
  detail: string;          // free-form text, inserted as indented sub-lines below the task line
}
```

The settings-screen row for each habit (`displayRecurringTaskRow`) supports: inline
title rename (click the title), one toggle button per weekday, an active/inactive
toggle, reorder (swaps `order` with the adjacent row), a pencil button opening
`RecurringTaskModal` to edit the multi-line `detail` text, and delete.

**Reconciliation** — keeping daily notes in sync with the current definitions — isn't
triggered from this screen. It happens automatically:

- `PMCompassPlugin` watches `vault.on("create")` and `workspace.on("file-open")`; when
  a daily note for **today or a later day in the current ISO week** is opened or
  created, it debounces (800ms) a call to `DayMarkdownFile.reconcileRecurringHabits()`
  for that note. Past days are never touched, so editing today's habit list can't
  retroactively rewrite a note from earlier in the week.
- The Dashboard and Week Summary tabs also call `backfillRecurringHabits()`
  unconditionally on every render, to guarantee the current week's notes are complete
  before being read (the Inbox tab skips this, since it doesn't depend on it — see
  [dashboard.md](dashboard.md)).
- A manual "Backfill recurring habits for this week" command is also registered for
  on-demand use.

Renaming a habit's `title` does not rewrite lines already inserted under the old
title — those keep their original text and are simply no longer matched by future
reconciliation, so nothing already written to a note is silently changed.

## Related documents

- [overview.md](overview.md) — what the plugin is for and how its features fit together
- [dashboard.md](dashboard.md) — the Overdue/Upcoming window and priority scoring these settings tune
- [inbox.md](inbox.md) — Inbox path and staleness threshold in use
- [week-summary.md](week-summary.md) — how `dailyHabitsTag` groups habits across a week
- [graph-display.md](graph-display.md) — `panelConfig`/`nodePositions` in use
- [class-map.html](class-map.html) — full class map; `PMCompassSettingTab` sits under "Modals & settings"
