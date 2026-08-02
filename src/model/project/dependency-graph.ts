/** Dependencies read at one level of the tree. A stored dependency joins two tasks that
 *  need not be siblings — a move leaves it alone — so a graph drawing one level lifts each
 *  end to the card standing for it there, which is the task itself or an ancestor of it. */
import type { Task } from "./task";
import { WalkAction, walkAncestors } from "./task-tree";

/** Whether a lifted dependency is the stored one, or stands for links further down. */
export enum DependencyKind {
  Direct = "direct",
  Indirect = "indirect",
}

/** One stored dependency: `dependentId` waits on `prerequisiteId`. */
export interface DependencyOrigin {
  dependentId: string;
  prerequisiteId: string;
}

/** A dependency as one level sees it. `sourceId` is the prerequisite's card, `targetId` the
 *  waiting task's — the direction an arrow points. */
export interface LiftedDependency {
  sourceId: string;
  targetId: string;
  kind: DependencyKind;
  /** Whether `sourceId` names a task the level doesn't hold — one it waits on from outside,
   *  which the graph draws a card of its own for rather than lifting. */
  external: boolean;
  /** The stored dependencies it stands for; one, itself, when `Direct`. */
  origins: DependencyOrigin[];
}

const pairKey = (sourceId: string, targetId: string) => `${sourceId}->${targetId}`;

/**
 * Every dependency `visibleIds` can show, each lifted to the visible cards its ends belong
 * to. A pair is dropped when the waiting end lifts to nothing — outside the level's
 * subtrees, or another project — or when both ends land on the same card, a dependency
 * internal to a subtree saying nothing about it. A prerequisite that lifts to nothing is
 * kept instead, named as itself and marked `external`: what a level waits on from outside
 * is about that level. Pairs coincide: several links can lift onto one line, and a direct
 * one wins over the indirect ones sharing its cards.
 *
 * `hiddenIds` are cards of the level a filter is holding back. They lift like the visible
 * ones, and a pair landing on one is dropped rather than drawn: what the level isn't
 * showing is not something it waits on from outside either.
 */
export function liftDependencies(
  allTasks: Task[],
  visibleIds: Iterable<string>,
  hiddenIds: Iterable<string> = [],
): LiftedDependency[] {
  const visible = new Set(visibleIds);
  const hidden = new Set(hiddenIds);
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const lifted = new Map<string, string | undefined>();

  /** The card of the level `id` sits under, itself when it is one — shown or not. */
  const liftId = (id: string): string | undefined => {
    if (lifted.has(id)) return lifted.get(id);
    const onLevel = (candidate: string) => visible.has(candidate) || hidden.has(candidate);
    let found: string | undefined = onLevel(id) ? id : undefined;
    if (!found) {
      walkAncestors(byId, id, (ancestor) => {
        if (!onLevel(ancestor.id)) return;
        found = ancestor.id;
        return WalkAction.Stop;
      });
    }
    lifted.set(id, found);
    return found;
  };

  const edges = new Map<string, LiftedDependency>();
  for (const task of allTasks) {
    for (const prerequisiteId of task.dependencies) {
      const target = liftId(task.id);
      if (!target || hidden.has(target)) continue;
      const lifted = liftId(prerequisiteId);
      if (lifted && hidden.has(lifted)) continue;
      // Off the level, the prerequisite stands for itself — as long as it is a task at all;
      // an id naming nothing is nothing to draw.
      const external = !lifted;
      const source = lifted ?? (byId.has(prerequisiteId) ? prerequisiteId : undefined);
      if (!source || source === target) continue;

      const kind = source === prerequisiteId && target === task.id
        ? DependencyKind.Direct
        : DependencyKind.Indirect;
      const origin: DependencyOrigin = { dependentId: task.id, prerequisiteId };
      const existing = edges.get(pairKey(source, target));
      if (!existing) {
        edges.set(pairKey(source, target), { sourceId: source, targetId: target, kind, external, origins: [origin] });
        continue;
      }
      existing.origins.push(origin);
      if (kind === DependencyKind.Direct) existing.kind = DependencyKind.Direct;
    }
  }
  return [...edges.values()];
}
