import { setIcon } from "obsidian";
import { Priority, PRIORITY_LABELS, statusLabel, getPriorityColor, getStatusColor } from "../model/base-task";
import { Icon, statusIcon } from "./icons";

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
 * including the task's own level (which stands in for a missing one) — so a task with no
 * tree around it passes its own level for both, which fills the bar solid as passing
 * neither would. Two levels rather than one so the priority
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

/** A pill labelled and tinted by status: solid text, 22/55 alpha for fill and border.
 *  `opts.text` overrides the label; `status` still decides the colour. */
export function renderStatusPill(
  container: HTMLElement,
  cls: string,
  status: string,
  opts?: { text?: string },
): HTMLElement {
  const color = getStatusColor(status);
  const pill = container.createSpan({ cls, text: opts?.text ?? statusLabel(status) });
  pill.style.setProperty("--pm-status-bg", `${color}22`);
  pill.style.setProperty("--pm-status-color", color);
  pill.style.setProperty("--pm-status-border-color", `${color}55`);
  return pill;
}

/** The status as one glyph, where a checklist row carries its checkbox. Shape from
 *  `STATUS_ICONS`, colour from the status; `opts.title` spells it out in words.
 *  `opts.interactive` makes it a button to the keyboard as well: Enter and Space
 *  reach the caller's click handler. */
export function renderStatusIcon(
  container: HTMLElement,
  cls: string,
  status: string,
  opts?: { title?: string; interactive?: boolean },
): HTMLElement {
  const icon = container.createSpan({ cls });
  setIcon(icon, statusIcon(status));
  icon.style.setProperty("--pm-status-color", getStatusColor(status));
  icon.setAttribute("aria-label", opts?.title ?? statusLabel(status));
  if (opts?.title) icon.title = opts.title;
  if (opts?.interactive) {
    icon.setAttribute("role", "button");
    icon.tabIndex = 0;
    icon.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      icon.click();
    });
  }
  return icon;
}

/** How a meta badge is tinted. Not task vocabulary (it says nothing about the task
 *  itself), so it lives here rather than in `model/base-task.ts`. */
export enum BadgeTone {
  Neutral = "neutral",
  Warning = "warning",
  Danger = "danger",
}

export interface MetaBadgeSpec {
  text: string;
  /** An icon drawn before the text. */
  icon?: Icon;
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
  if (spec.icon) setIcon(badge.createSpan({ cls: "pm-task-badge-icon" }), spec.icon);
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

/** The floor on where a `renderDaysBadge` chip turns red — a later warn threshold pushes
 *  it further out, so a chip never reddens before it has warned. */
export const OLD_AGE_DAYS = 14;

/** A day count that has run on too long — an Inbox item's age, a passed deadline. The
 *  alert glyph appears past `warnAfterDays` (0 disables it), the red past the later of
 *  `OLD_AGE_DAYS` and that threshold. */
export function renderDaysBadge(
  container: HTMLElement,
  days: number,
  opts: {
    warnAfterDays: number;
    title: string;
    /** Replaces `title` once the glyph is showing. */
    warnTitle?: string;
    /** The count without the alarm: no glyph, no escalation. For a date whose age is
     *  information rather than a problem, such as when a task was created. */
    quiet?: boolean;
    onClick?: (badge: HTMLElement) => void;
  },
): HTMLElement {
  const warned = !opts.quiet && opts.warnAfterDays > 0 && days >= opts.warnAfterDays;
  return renderMetaBadge(container, {
    text: `${days} d`,
    icon: warned ? Icon.AgeWarning : undefined,
    tone: opts.quiet || days <= Math.max(OLD_AGE_DAYS, opts.warnAfterDays)
      ? (warned ? BadgeTone.Warning : BadgeTone.Neutral)
      : BadgeTone.Danger,
    title: warned ? (opts.warnTitle ?? opts.title) : opts.title,
    onClick: opts.onClick,
  });
}

/** A small alert glyph flagging a completed task that still hides unfinished subtasks. */
export function renderSubtaskWarning(container: HTMLElement, cls: string): HTMLElement {
  const warn = container.createSpan({ cls });
  setIcon(warn, Icon.SubtaskWarning);
  warn.setAttribute("aria-label", "Completed, but has unfinished subtasks");
  warn.title = "Completed, but has unfinished subtasks";
  return warn;
}

/** A small glyph flagging an open task whose enclosing (parent) task is already completed. */
export function renderParentDoneWarning(container: HTMLElement, cls: string): HTMLElement {
  const warn = container.createSpan({ cls });
  setIcon(warn, Icon.ParentDoneWarning);
  warn.setAttribute("aria-label", "Still open, but its parent task is completed");
  warn.title = "Still open, but its parent task is completed";
  return warn;
}
