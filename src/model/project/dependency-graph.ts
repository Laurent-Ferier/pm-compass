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

/** Which end of a lifted dependency names a task the level doesn't hold, and so gets a card
 *  of its own rather than being lifted onto one. At most one end can: a pair with neither on
 *  the level says nothing about it. */
export enum ExternalEnd {
  /** Both ends lift onto cards of the level. */
  None = "none",
  /** The prerequisite lives outside: what the level waits on. */
  Prerequisite = "prerequisite",
  /** The waiting task lives outside: what waits on the level. */
  Dependent = "dependent",
}

/** A dependency as one level sees it. `sourceId` is the prerequisite's card, `targetId` the
 *  waiting task's — the direction an arrow points. */
export interface LiftedDependency {
  sourceId: string;
  targetId: string;
  kind: DependencyKind;
  /** Which end, if either, names a task the level doesn't hold. */
  external: ExternalEnd;
  /** The stored dependencies it stands for; one, itself, when `Direct`. */
  origins: DependencyOrigin[];
}

const pairKey = (sourceId: string, targetId: string) => `${sourceId}->${targetId}`;

/**
 * Every dependency `visibleIds` can show, each lifted to the visible cards its ends belong
 * to. A pair is dropped when both ends land on the same card — a dependency internal to a
 * subtree, saying nothing about it — or when neither end lifts at all, which is a link
 * between two tasks the level has nothing to do with. An end that lifts to nothing while
 * the other does is kept instead, named as itself and marked `external`: what a level waits
 * on from outside, and what waits on it from outside, are both about that level. Pairs
 * coincide: several links can lift onto one line, and a direct one wins over the indirect
 * ones sharing its cards.
 *
 * `hiddenIds` are cards of the level a filter is holding back. They lift like the visible
 * ones, and a pair landing on one is dropped rather than drawn: what the level isn't
 * showing is not something it waits on from outside either.
 *
 * `enclosingId` is the task the level belongs to, drawn as the frame its cards sit in. Its
 * own dependencies lift onto it, so what it waits on from outside is drawn against that
 * frame rather than lost. It is the last card an end can lift to, never one of the level's
 * own: the ancestor walk climbs one parent at a time and every card of the level is a child
 * of it, so a card inside always answers first.
 */
export function liftDependencies(
  allTasks: Task[],
  visibleIds: Iterable<string>,
  hiddenIds: Iterable<string> = [],
  enclosingId?: string,
): LiftedDependency[] {
  const visible = new Set(visibleIds);
  const hidden = new Set(hiddenIds);
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const lifted = new Map<string, string | undefined>();

  /** The card of the level `id` sits under, itself when it is one — shown or not. */
  const liftId = (id: string): string | undefined => {
    if (lifted.has(id)) return lifted.get(id);
    const onLevel = (candidate: string) =>
      visible.has(candidate) || hidden.has(candidate) || candidate === enclosingId;
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
    if (task.dependencies.length === 0) continue;
    // The waiting end is the same for every dependency this task holds.
    const liftedTarget = liftId(task.id);
    if (liftedTarget && hidden.has(liftedTarget)) continue;
    for (const prerequisiteId of task.dependencies) {
      const liftedSource = liftId(prerequisiteId);
      if (liftedSource && hidden.has(liftedSource)) continue;
      // Neither end on the level: a link between two tasks it has nothing to do with.
      if (!liftedTarget && !liftedSource) continue;
      // Off the level, an end stands for itself — the prerequisite as long as it is a task
      // at all, an id naming nothing being nothing to draw. The waiting end always is one:
      // it is the task whose dependencies these are.
      const target = liftedTarget ?? task.id;
      const source = liftedSource ?? (byId.has(prerequisiteId) ? prerequisiteId : undefined);
      if (!source || source === target) continue;
      const external = !liftedSource
        ? ExternalEnd.Prerequisite
        : !liftedTarget ? ExternalEnd.Dependent : ExternalEnd.None;
      // A line from a card of the level to the frame around it: the same line of descent,
      // drawn as an arrow from a box to the box holding it, which is nothing to follow.
      // `ExternalEnd.None` is exactly "both ends landed on cards of this level".
      if (external === ExternalEnd.None && (source === enclosingId || target === enclosingId)) continue;

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
