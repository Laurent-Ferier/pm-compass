import {
  Priority,
  PRIORITY_LABELS,
  STATUS_LABELS,
  getPriorityColor,
  getStatusColor,
} from "../model/task-vocabulary";
import { ALERT_SVG, UNLINK_SVG, setSvgIcon } from "./icons";

/**
 * The priority ribbon and status pill, shared by the dashboard/inbox task rows
 * (`BaseTabView.renderTaskRow`) and the move/promote picker
 * (`MoveTargetModal`). Colour and tooltip live here; the dashboard's dropdown
 * wiring stays with the caller, since the picker's copies are read-only.
 *
 * Its own module rather than base-tab-view.ts: that file imports
 * MoveTargetModal, so the picker can't import back from it.
 */

/**
 * A ribbon coloured by `effectivePriority ?? priority`, titled with both when a
 * rolled-up priority outranks the task's own. Left uncoloured for no priority,
 * so the CSS fallback shows.
 */
export function renderPriorityRibbon(
  container: HTMLElement,
  cls: string,
  priority: Priority | undefined,
  effectivePriority?: Priority,
): HTMLElement {
  const ribbon = container.createDiv({ cls });
  const color = getPriorityColor(effectivePriority ?? priority);
  if (color) ribbon.style.setProperty("--pm-ribbon-color", color);

  // No `??` fallbacks: `PRIORITY_LABELS` is total over `Priority`, and everything that
  // reaches here has been narrowed to one (`toPriority` at the vault boundary, the
  // marker table when parsing a checklist line).
  const ownLabel = PRIORITY_LABELS[priority ?? Priority.None];
  const effLabel = effectivePriority ? PRIORITY_LABELS[effectivePriority] : ownLabel;
  ribbon.title = effectivePriority && effectivePriority !== priority
    ? `Effective priority: ${effLabel} (own: ${ownLabel})`
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
