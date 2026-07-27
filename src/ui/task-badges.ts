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
 * The fill of a priority ribbon, wherever one is drawn — the task rows here and the
 * graph's node cards, which paint the same bar into a cytoscape HTML label instead of
 * a `.pm-task-ribbon` div.
 *
 * `above` is the highest level at or over the task, `below` the highest at or under it,
 * and the bar fades from one to the other, so which end answers which question never
 * changes from row to row. Empty when neither has a colour, so the caller's fallback
 * shows.
 */
export function priorityRibbonBackground(
  above: Priority | undefined,
  below: Priority | undefined,
): string {
  // An uncoloured end gives the whole bar to the other: fading to the fallback colour
  // would read as a level the task doesn't have.
  const top = getPriorityColor(above);
  const bottom = getPriorityColor(below);
  if (!top || !bottom || top === bottom) return top || bottom;
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}

/**
 * A ribbon filled by `priorityRibbonBackground`, titled with the levels it stands for.
 * `fromParents` / `fromSubtasks` are the roll-ups either side of the task, each already
 * including the task's own level (which stands in for a missing one); pass neither where
 * there is no tree, as on a checklist line. Two levels rather than one so the priority
 * picker visibly does something on a subtask its parent outranks. The title names the
 * levels, which is what disambiguates the case the fade can't: a task outranked from
 * both sides shows neither end in its own colour.
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
  fromParents?: Priority,
  fromSubtasks?: Priority,
): HTMLElement {
  const ribbon = container.createDiv({ cls: "pm-task-ribbon" });
  const background = priorityRibbonBackground(fromParents ?? priority, fromSubtasks ?? priority);
  if (background) ribbon.style.setProperty("--pm-ribbon-color", background);

  // No `??` fallbacks: `PRIORITY_LABELS` is total over `Priority`, and everything that
  // reaches here has been narrowed to one (`toPriority` at the vault boundary, the
  // marker table when parsing a checklist line).
  const ownLabel = PRIORITY_LABELS[priority ?? Priority.None];
  const rolledUp: string[] = [];
  if (fromParents && fromParents !== priority) {
    rolledUp.push(`from parent tasks: ${PRIORITY_LABELS[fromParents]}`);
  }
  if (fromSubtasks && fromSubtasks !== priority) {
    rolledUp.push(`from subtasks: ${PRIORITY_LABELS[fromSubtasks]}`);
  }
  ribbon.title = rolledUp.length > 0
    ? `Priority: ${ownLabel} (${rolledUp.join(", ")})`
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
  /** Turns the badge into a click target — the day label that opens that day's note, the
   *  deadline that opens the date picker on itself, which is why the badge is handed back.
   *  The click is stopped from reaching the row, whose own handler would otherwise toggle
   *  the actions toolbar underneath it. */
  onClick?: (badge: HTMLElement) => void;
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
      spec.onClick!(badge);
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
