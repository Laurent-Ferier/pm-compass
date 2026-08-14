# UI conventions — Technical Description

This document describes the rules every view keeps when it builds its DOM: the attributes an element carries, and what each one is for. A rule here holds across the tabs, the modals and the graph — a view that needs an exception says so where it makes it.

## Labels and tooltips

An element is labelled once, by `aria-label`, and that label is what its tooltip shows.

Obsidian draws the tooltip itself, from a `pointerover` handler bound to `[aria-label]`. A `title` attribute makes the browser draw a second one beside it, so no view sets a `title`. `--no-tooltip: true` on an element suppresses Obsidian's, and nothing in the plugin declares it.

Being both the tooltip and what a screen reader says, the label is the fuller wording of the two: a toolbar button is labelled "Delete the task", not "Delete". An option field feeding it is named for the element it labels — `label` where the element has no text of its own, as on [`ActionButtonSpec`](../../src/ui/day-task-row.ts) and `renderStatusIcon()`; `tooltip` where it already carries visible text, as on [`MetaBadgeSpec`](../../src/ui/task-badges.ts) and [`DropdownItem`](../../src/ui/task-creator.ts).

A section heading's ⓘ is a different thing: it opens the plugin's own popover, built by `createCollapsibleSection()` from an `options.tooltip` string, and no hover reaches it.
