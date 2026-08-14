# Theming — Technical Description

This document describes where every colour the plugin draws comes from: the Obsidian variables the chrome takes, the variables that carry a warning, the fixed palette that stands for a task's own values, and the custom properties that carry a colour set in TypeScript into `styles.css`. It states the rules a change to `styles.css` or to a view has to keep, and names the file each colour is declared in. How to see a style change without a device is in [setup.md](setup.md#previewing-a-style-change-in-a-browser).

Obsidian sets its variables on `body.theme-dark` / `body.theme-light`, and the user switches between them at any moment. Nothing in the plugin reads which theme is on, and there is no `.theme-light` rule in `styles.css`: a colour follows the theme by being one of the theme's own variables.

## Chrome

Text, icons, surfaces and borders take an Obsidian variable, never a literal:

- `--text-normal` — anything the reader reads: a task title, a card's title, an input's value, a graph edge.
- `--text-muted` — a value beside the reading: a due date, a section label, a metadata band.
- `--text-faint` — what is there to be found rather than read: a placeholder, an icon button at rest, a card's resize handle, a subtask count.
- `--background-primary` — the surface a card or a panel is drawn on.
- `--background-secondary` — a surface raised off it: a graph container, a stat block.
- `--background-modifier-hover` — the fill a row or a button takes under the pointer.
- `--background-modifier-border` — every border, through `--pm-border`.
- `--color-accent` / `--interactive-accent` — what the plugin has picked or filled: a selected card, a checked checkbox, a focus ring.
- `--text-on-accent` — text and glyphs over any of those fills.

`--pm-border` is declared on `body`, not `:root`. Themes set `--background-modifier-border` on `body`, so at `:root` the shorthand computes to guaranteed-invalid and every `border: var(--pm-border)` draws nothing.

A `var(--x, literal)` fallback is not written for these. Obsidian defines them all, so the fallback only ever fires where the app isn't — in the preview harness — and a dark-theme literal there hides a variable the harness forgot to declare.

> **Note:** a `box-shadow` keeps its `rgba(0, 0, 0, …)`. A shadow is the absence of light on either theme.

## Signals

A warning, an error and an overdue date are Obsidian's, so each theme darkens or lightens them with the rest of its palette:

- `--text-warning` — the subtask and parent-done glyphs, on a row and on a graph card.
- `--text-error` — an overdue date, an invalid field's border.
- `--color-red` / `--color-orange` — the fill behind a destructive button or a banner, tinted with `rgba(var(--color-red-rgb), …)` or `color-mix()` where it has to stay translucent.

## The palette

A task's own values carry fixed hexes, declared in [base-task.ts](../../src/model/base-task.ts): `STATUS_COLORS`, `PRIORITY_COLORS`, and `NEUTRAL_COLOR` for a value that has none. A project's colour is whatever its note says. These are a legend rather than chrome — a status has to read as the same colour on both themes, and a project's colour is the user's — so they do not move with the theme. They are mid-tone, and they are drawn as a fill under theme-coloured text or as a tint behind it: `statusPillColors()` in [task-badges.ts](../../src/ui/task-badges.ts) gives a pill a `22`-alpha fill and a `55`-alpha border off the same hex, and `withAlpha()` is the one way to build such a colour.

## From TypeScript to CSS

A colour decided in TypeScript is set as a custom property on the element, and `styles.css` holds the declaration that reads it:

- `--pm-ribbon-color` — a priority ribbon's fill, solid or a gradient between the levels above and below the task.
- `--pm-status-bg` / `--pm-status-color` / `--pm-status-border-color` — a status pill's three tints.
- `--pm-project-color`, `--pm-dot-color`, `--pm-legend-dot-color`, `--pm-stat-number-color` — a project's colour where a row, a picker or a chart legend shows it.
- `--pm-swatch-color` — the colour a swatch stands for: the project modal's colour field and the preview in the picker it opens.
- `--pm-hue-color` / `--pm-cursor-x` / `--pm-cursor-y` — the colour picker's square and where its two cursors sit on it, in per cent (see [color-picker.ts](../../src/ui/color-picker.ts)).

Each consumer names a theme variable as its fallback, so an element the caller left alone still draws in the theme's colours. `setCssStyles()` with a colour in it belongs to a project card, whose border, tint and text are all one free-form hex.

## Checking both themes

`docs/technical/preview/tabs.html` shims Obsidian's variables on `body`, dark by default and light under `body.theme-light`, and carries a toggle between them; `tabs.html#light` opens straight into light. A variable the shim doesn't declare goes unset there rather than falling back, which is what makes the page able to answer whether a colour follows the theme.

The graph is not in that harness. A change to a card is checked in the app, with Appearance switched between light and dark.
