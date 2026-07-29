# Week Summary — Technical Description

`WeekSummaryView` (`ui/week-summary-view.ts`, extends `BaseTabView`) is the third tab
`PMCompassView` owns. Unlike the Dashboard and Inbox, it doesn't operate on individual
checklist items — it's read-only, built from one aggregated snapshot of the whole
displayed week rather than per-row queries. See [class-map.html](class-map.html) for
how it sits in the wider class graph.

## Data flow

`WeekSummaryView.render(content, tasks, projects, config)` receives the same
obsidian-pm `Task[]`/`Project[]` the Dashboard gets (loaded once by
`PMCompassView.render()`, see [dashboard.md](dashboard.md)), but loads its own
checklist data independently via `WeekSummary.load(app, weekStart, config,
habitsTag)` (`model/daily/week-summary.ts`), since it needs all seven days of the displayed
week at once rather than one day plus a fixed window either side.

`WeekSummary.load()`:

1. Computes each of the 7 days' expected daily-note path (Monday–Sunday, ISO week)
   and reads whichever of those files exist — days with no note yet (`hasNote:
   false`) are not created, just skipped.
2. Parses every line in each file into `DayTask`s (no filtering at this stage — even
   non-checklist lines are attempted and discarded by `DayTask.parse` returning
   `null`).
3. For each day, splits tasks into **habit items** (tagged `#<habitsTag>`) and
   everything else, and:
   - runs `computeDailyTaskCounts()` (`model/daily/week-summary.ts`) over the non-habit
     items: `closedOnTime` (checked, with no `✅` date or one on/before the note's own
     date), `closedLate` (checked, closed after the note's date), `open`, `total`.
   - counts `habitsDone`/`habitsTotal` for the day.
   - for every habit item, keys it by `task.displayTitle(habitsTag)` — the title with
     *all* tags stripped, not just the habits tag (unlike the Dashboard/Inbox title
     rendering, see [dashboard.md](dashboard.md)) — and accumulates, across the whole
     week: how many days that key was *present* (`itemPresenceCount`), how many days
     it was *checked* (`itemCompletionCount`), and which day indices it was checked on
     (`itemCheckedDays`).
4. Returns a `WeekSummary` with `days: DayEntry[]` (one per day, in order) and
   `habits: HabitSummary[]` (one per distinct habit title, sorted by completion count
   descending).

Grouping by *display title* rather than by the recurring habit's `id` means a habit
still rolls up correctly across a week in which its definition was renamed mid-week —
at the cost of two differently-worded occurrences of what's conceptually the same
habit appearing as two separate rows.

## Layout

```
Week navigator
└─ Daily Tasks (collapsible)
   ├─ Habits by task   — one row per distinct habit, completion count + day chips
   ├─ Habits by day    — 7 progress rings, one per day
   └─ Small tasks      — 7 tri-color rings, one per day
└─ Project Tasks (collapsible)
   └─ Week Stats       — Completed / Created / In Progress / Blocked, expandable
```

### Week navigator

The bar itself is the dashboard's `.pm-dash-date-nav` — the shared "Tab bars" block of
`styles.css`, so it sticks, sizes and reads like the Dashboard's and the Inbox's.

`weekOffset` (an integer, kept on the `WeekSummaryView` instance) is added to
`moment().startOf("isoWeek")` to get the displayed week's Monday. Prev/next buttons
increment/decrement it and call `onRefresh()`; a "This week" button (shown only when
`weekOffset !== 0`) resets it to `0`.

### Habits by task

One row per `HabitSummary`: a progress ring (`completionCount / presenceCount`), the
habit's display title, and a `done/present` count. If the habit was checked on at
least one day, a chevron expands a row of day-abbreviation chips (`Mon`…`Sun`) for the
days it was actually checked; clicking one opens that day's note.

### Habits by day / Small tasks

Two rows of 7 rings (Monday first), built with `buildProgressCircle()` /
`buildTriColorCircle()` (`ui/progress-circle.ts`):

- **Habits by day** — one ring per day, ratio = `habitsDone / habitsTotal` for that
  day. A day with no note, or a future day, renders dimmed (`trackDim`); a day with a
  note but zero habit items renders as an explicit "empty" ring rather than an empty
  one indistinguishable from "no data".
- **Small tasks** — the tri-color equivalent for non-habit items:
  `closedOnTime`/`closedLate` slices plus the implicit open remainder, so a fully-open
  day and a fully-closed day are visually distinct at a glance. A legend below the row
  spells out the three colors (green = closed, orange = late, grey = open).

Both rows show a `done/total` (or `—` when there's no note, or the note has no items)
label inside the ring; clicking a ring with a note opens it.

### Week Stats

Four expandable rows — Completed, Created, In Progress, Blocked — each a plain count
of obsidian-pm `Task`s, computed independently of the daily-note data above:

- **Completed** — `task.completed` timestamp falls within the displayed ISO week.
- **Created** — `task.createdAt` falls within the displayed week.
- **In Progress** / **Blocked** — current `status`, regardless of when that happened.

Each row expands (via `BaseTabView.renderExpandList()`) into the same read-only task
rows the Dashboard uses, with priority/due date already resolved through
`computeEffectiveValues()` (parent-to-subtask inheritance — see
[dashboard.md](dashboard.md)) so a subtask's inherited urgency is visible here too.

## Related documents

- [overview.md](overview.md) — what the plugin is for and how its features fit together
- [dashboard.md](dashboard.md) — the priority/deadline inheritance this tab's Week Stats section reuses
- [settings.md](settings.md) — the habits tag this tab groups by
- [class-map.html](class-map.html) — full class map; `WeekSummaryView` sits under "Tab views"
