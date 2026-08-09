import { setIcon } from "obsidian";
import { Priority, PRIORITY_LABELS, statusLabel, getPriorityColor, getStatusColor } from "../model/base-task";
import { Icon, statusIcon } from "./icons";

/**
 * The badges every task row is built from — priority ribbon, status pill, warning glyphs,
 * the trailing metadata band. One component per kind of value, colour and tooltip here,
 * the dropdown wiring with the caller. Its own module because base-tab-view.ts imports
 * MoveTargetModal, so the picker can't import back from it.
 */

/**
 * A hex colour with an alpha suffix, for the translucent fills the badges and cards use.
 *
 * The one way to make one. A colour off the palette is always six digits, but a project's
 * is whatever its note says, and `#abc22` is not a colour — so the short form is expanded
 * rather than suffixed as it stands.
 */
export function withAlpha(hex: string, alphaHex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const expanded = h.length === 3 ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h;
  return `#${expanded}${alphaHex}`;
}

/** The fill of a priority ribbon, here and on the graph's node cards. `above` is the
 *  highest level at or over the task, `below` at or under it, and the bar fades between
 *  them. Empty when neither has a colour, so the caller's fallback shows. */
export function priorityRibbonBackground(
  above: Priority | undefined,
  below: Priority | undefined,
): string {
  // An uncoloured end gives the whole bar to the other; fading to the fallback would
  // read as a level the task doesn't have.
  const top = getPriorityColor(above);
  const bottom = getPriorityColor(below);
  if (!top || !bottom || top === bottom) return top || bottom;
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}

/**
 * A ribbon filled by `priorityRibbonBackground`, titled with the levels it stands for.
 * `fromParents` / `fromSubtasks` are the roll-ups either side of the task, each falling
 * back to its own level — two rather than one so the picker visibly does something on a
 * subtask its parent outranks, and the title names what the fade alone can't say.
 * Callers that allow editing add `.pm-task-ribbon--editable` themselves.
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

  // No `??` fallbacks: `PRIORITY_LABELS` is total over `Priority`, and everything
  // reaching here has been narrowed to one.
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

/** How a status pill is tinted: solid text over a 22-alpha fill, a 55-alpha border. The
 *  one place those alphas live — the graph's cards are built as HTML and read it too. */
export function statusPillColors(status: string): { bg: string; text: string; border: string } {
  const color = getStatusColor(status);
  return { bg: withAlpha(color, "22"), text: color, border: withAlpha(color, "55") };
}

/** A pill labelled and tinted by status. `opts.text` overrides the label; `status` still
 *  decides the colour. */
export function renderStatusPill(
  container: HTMLElement,
  cls: string,
  status: string,
  opts?: { text?: string },
): HTMLElement {
  const { bg, text, border } = statusPillColors(status);
  const pill = container.createSpan({ cls, text: opts?.text ?? statusLabel(status) });
  pill.style.setProperty("--pm-status-bg", bg);
  pill.style.setProperty("--pm-status-color", text);
  pill.style.setProperty("--pm-status-border-color", border);
  return pill;
}

/** The status as one glyph, where a checklist row carries its checkbox. `opts.title`
 *  spells it out; `opts.interactive` makes it a button to the keyboard too. */
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

/** How a meta badge is tinted. Not task vocabulary, so it lives here. */
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
  /** Turns the badge into a click target, handed back so a picker can open on it. The
   *  click is kept from the row, whose handler would toggle the toolbar underneath. */
  onClick?: (badge: HTMLElement) => void;
}

/** Opens the trailing metadata band a task row ends with, holding `renderMetaBadge`
 *  chips so every kind of date sits in the same place and reads the same. */
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
    /** The count without the alarm, for a date whose age is information not a problem. */
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
