import {
  Priority,
  PRIORITY_LABELS,
  STATUS_LABELS,
  getPriorityColor,
  getStatusColor,
} from "../model/task-vocabulary";
import { ALERT_SVG, UNLINK_SVG, setSvgIcon } from "./icons";

/**
 * The badges every task row is built from — priority ribbon, status pill,
 * warning glyphs, and the trailing metadata band — shared by the day-checklist
 * and project-task rows (`BaseTabView`), the inbox (`InboxView`) and the
 * move/promote picker (`MoveTargetModal`). One component per kind of value, so
 * a deadline, a day label or an age reads the same wherever it appears; colour
 * and tooltip live here, the dropdown wiring stays with the caller, since the
 * picker's copies are read-only.
 *
 * Its own module rather than base-tab-view.ts: that file imports
 * MoveTargetModal, so the picker can't import back from it.
 */

/**
 * A ribbon coloured by `effectivePriority ?? priority`, titled with both when a
 * rolled-up priority outranks the task's own. Left uncoloured for no priority,
 * so the CSS fallback shows.
 *
 * Where the two differ — and the task has a level of its own — the bar fades from
 * the inherited level at the top to the task's own at the bottom. A solid bar
 * showing only the roll-up made the priority picker look broken on a subtask:
 * picking a level below the parent's changed nothing on screen, and only the hover
 * title said why.
 *
 * One geometry everywhere (`.pm-task-ribbon`: a rounded bar stretched to the
 * row's height); only the surrounding margin is a per-row-type concern, and
 * that lives in the CSS beside each row. Callers that let the user change the
 * priority add `.pm-task-ribbon--editable` themselves — see
 * `BaseTabView.attachPriorityDropdown`.
 */
export function renderPriorityRibbon(
  container: HTMLElement,
  priority: Priority | undefined,
  effectivePriority?: Priority,
): HTMLElement {
  const rolledUp = !!effectivePriority && effectivePriority !== priority;
  // The fade needs two levels to run between. A task with no priority of its own has
  // nothing to show at the bottom, and fading to the uncoloured fallback would read as
  // a level it doesn't have — it gets the inherited colour solid instead.
  const ownColor = getPriorityColor(priority);
  const fade = rolledUp && !!ownColor;

  const ribbon = container.createDiv({
    cls: "pm-task-ribbon" + (fade ? " pm-task-ribbon--inherited" : ""),
  });

  const color = getPriorityColor(effectivePriority ?? priority);
  if (color) ribbon.style.setProperty("--pm-ribbon-color", color);
  if (fade) ribbon.style.setProperty("--pm-ribbon-own-color", ownColor);

  // No `??` fallbacks: `PRIORITY_LABELS` is total over `Priority`, and everything that
  // reaches here has been narrowed to one (`toPriority` at the vault boundary, the
  // marker table when parsing a checklist line).
  const ownLabel = PRIORITY_LABELS[priority ?? Priority.None];
  ribbon.title = rolledUp
    ? `Effective priority: ${PRIORITY_LABELS[effectivePriority]} (own: ${ownLabel})`
    : `Priority: ${ownLabel}`;
  return ribbon;
}

/** A pill labelled and tinted by status: solid text, 22/55 alpha for fill and border. */
export function renderStatusPill(container: HTMLElement, cls: string, status: string): HTMLElement {
  const color = getStatusColor(status);
  const pill = container.createSpan({ cls, text: STATUS_LABELS[status] ?? status });
  pill.style.setProperty("--pm-status-bg", `${color}22`);
  pill.style.setProperty("--pm-status-color", color);
  pill.style.setProperty("--pm-status-border-color", `${color}55`);
  return pill;
}

/** How a meta badge is tinted. Not task vocabulary (it says nothing about the task
 *  itself), so it lives here rather than in `task-vocabulary.ts`. */
export enum BadgeTone {
  Neutral = "neutral",
  Warning = "warning",
  Danger = "danger",
}

export interface MetaBadgeSpec {
  text: string;
  /** A raw SVG constant from `icons.ts`, drawn before the text. */
  icon?: string;
  tone?: BadgeTone;
  title?: string;
  /** Turns the badge into a click target (the day label that opens that day's note).
   *  The click is stopped from reaching the row, whose own handler would otherwise
   *  toggle the actions toolbar underneath it. */
  onClick?: () => void;
}

/**
 * Opens the trailing metadata band a task row ends with. Everything in it is a
 * `renderMetaBadge` chip, so a deadline, a day label and an inbox item's age
 * all sit in the same place and read the same across the dashboard and the inbox.
 */
export function createBadgeBand(container: HTMLElement): HTMLElement {
  return container.createDiv({ cls: "pm-task-badges" });
}

/** One chip in a `createBadgeBand` band: a short value, optionally prefixed by an
 *  icon and tinted by `tone`. */
export function renderMetaBadge(container: HTMLElement, spec: MetaBadgeSpec): HTMLElement {
  const tone = spec.tone ?? BadgeTone.Neutral;
  const badge = container.createSpan({
    cls: "pm-task-badge"
      + (tone === BadgeTone.Neutral ? "" : ` pm-task-badge--${tone}`)
      + (spec.onClick ? " pm-task-badge--link" : ""),
  });
  if (spec.icon) setSvgIcon(badge.createSpan({ cls: "pm-task-badge-icon" }), spec.icon);
  badge.createSpan({ text: spec.text });
  if (spec.title) badge.title = spec.title;
  if (spec.onClick) {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      spec.onClick!();
    });
  }
  return badge;
}

/** A small alert glyph flagging a completed task that still hides unfinished subtasks. */
export function renderSubtaskWarning(container: HTMLElement, cls: string): HTMLElement {
  const warn = container.createSpan({ cls });
  setSvgIcon(warn, ALERT_SVG);
  warn.setAttribute("aria-label", "Completed, but has unfinished subtasks");
  warn.title = "Completed, but has unfinished subtasks";
  return warn;
}

/** A small glyph flagging an open task whose enclosing (parent) task is already completed. */
export function renderParentDoneWarning(container: HTMLElement, cls: string): HTMLElement {
  const warn = container.createSpan({ cls });
  setSvgIcon(warn, UNLINK_SVG);
  warn.setAttribute("aria-label", "Still open, but its parent task is completed");
  warn.title = "Still open, but its parent task is completed";
  return warn;
}
