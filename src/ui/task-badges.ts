import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  getPriorityColor,
  getStatusColor,
} from "../model/task-vocabulary";

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
  priority: string | undefined,
  effectivePriority?: string,
): HTMLElement {
  const ribbon = container.createDiv({ cls });
  const color = getPriorityColor(effectivePriority ?? priority);
  if (color) ribbon.style.setProperty("--pm-ribbon-color", color);

  const ownLabel = PRIORITY_LABELS[priority ?? ""] ?? "None";
  const effLabel = effectivePriority ? PRIORITY_LABELS[effectivePriority] ?? effectivePriority : ownLabel;
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
