/** Placing a level drawn as a frame: the level's own cards inside the box standing for the
 *  project or task they belong to, and the cards for tasks beyond it hung off its two sides.
 *  Pure geometry over `GraphNode`/`GraphEdge`, like `graph-layout`, and split in two because
 *  the frame can only be sized once everything inside it has been placed — which, for a card
 *  dragged to a place of its own, is after the layout has run. */
import { layoutGraph, type LayoutSpacing } from "./graph-layout";
import { ContainerNode, GraphNode, NODE_HEIGHT, NODE_WIDTH } from "./graph-node";
import { GraphEdge } from "./graph-edge";

/** How much room the frame leaves round the cards inside it. */
export const CONTAINER_PADDING = 28;
/** The band above them the frame's own title sits in. */
export const CONTAINER_HEADER = 26;
/** How far outside the frame the cards standing for tasks beyond the level sit. */
export const OUTSIDE_GAP = 60;

/** One level's cards, split by the part each plays in the drawing. */
interface ContainerLevel {
  container: ContainerNode | null;
  /** The level's own cards, which the frame is drawn around. */
  inner: GraphNode[];
  /** The cards standing for tasks beyond the level, which hang off its sides. */
  outside: GraphNode[];
}

function splitLevel(nodes: GraphNode[]): ContainerLevel {
  const container = nodes.find((n): n is ContainerNode => n instanceof ContainerNode) ?? null;
  const inner: GraphNode[] = [];
  const outside: GraphNode[] = [];
  for (const node of nodes) {
    if (node === container) continue;
    (node.isExternal ? outside : inner).push(node);
  }
  return { container, inner, outside };
}

/**
 * Places the level's own cards and nothing else: the frame is sized to wherever they end up
 * and the cards outside it to wherever the frame ends up, both of which `settleContainerLevel`
 * settles once any stored position has been applied. Only the edges running between two of
 * them sort the columns — one reaching outside says nothing about where a card sits inside.
 */
export function layoutContainerLevel(
  nodes: GraphNode[],
  edges: GraphEdge[],
  spacing: LayoutSpacing,
): void {
  // `layoutGraph` already ignores an edge with an end outside the cards it is given.
  layoutGraph(splitLevel(nodes).inner, edges, spacing);
}

/**
 * Sizes the frame round the cards inside it and hangs the ones beyond the level off its
 * sides: a prerequisite to the left, so its arrow into the frame still points forward, and
 * anything else to the right. A card at both ends counts as a prerequisite — there is one
 * card per task whichever way its arrows run, and the left is where the chain starts.
 *
 * Run after any stored position, so a card dragged out grows the frame and carries what is
 * outside along with it. It moves nothing inside and translates nothing: `layoutGraph`
 * normalises to the top left before stored positions are read, and doing it again afterwards
 * would rewrite what a stored centre means, drifting the card a little further every render.
 *
 * A card in `placed` has been put somewhere by hand and is left there — held clear of the
 * frame, which is the one place it may not be: the box stands for the level itself, and a
 * card from beyond it sitting inside would say it belongs there.
 */
export function settleContainerLevel(
  nodes: GraphNode[],
  edges: GraphEdge[],
  spacing: LayoutSpacing,
  placed: ReadonlySet<GraphNode> = new Set(),
): void {
  const { container, inner, outside } = splitLevel(nodes);
  if (!container) return;
  container.fitAround(inner, CONTAINER_PADDING, CONTAINER_HEADER);
  for (const node of outside) {
    if (placed.has(node)) node.position = node.box.clearOf(container.box);
  }
  const arranged = outside.filter((n) => !placed.has(n));
  if (arranged.length === 0) return;

  const box = container.box;
  const step = NODE_HEIGHT + spacing.nodeSep;

  // One pass over the edges rather than one per card: what each of them reaches, and
  // whether any of it runs the way that puts the card on the left.
  const ends = new Map<GraphNode, GraphNode[]>(arranged.map((n) => [n, []]));
  const outgoing = new Set<GraphNode>();
  for (const e of edges) {
    ends.get(e.source)?.push(e.target);
    ends.get(e.target)?.push(e.source);
    if (ends.has(e.source)) outgoing.add(e.source);
  }

  const sides = { left: [] as GraphNode[], right: [] as GraphNode[] };
  /** Where in the drawing a card's own links point, which is the height it wants to sit at. */
  const anchors = new Map<GraphNode, number>();
  for (const node of arranged) {
    const reached = ends.get(node)!;
    anchors.set(
      node,
      reached.length > 0
        ? reached.reduce((sum, e) => sum + e.position.y, 0) / reached.length
        : box.centre.y,
    );
    sides[outgoing.has(node) ? "left" : "right"].push(node);
  }

  const columns = [
    ["left", box.left - OUTSIDE_GAP - NODE_WIDTH / 2],
    ["right", box.right + OUTSIDE_GAP + NODE_WIDTH / 2],
  ] as const;
  for (const [side, column] of columns) {
    const cards = sides[side].sort((a, b) => anchors.get(a)! - anchors.get(b)!);
    const top = box.centre.y - ((cards.length - 1) * step) / 2;
    cards.forEach((node, i) => {
      node.position = { x: column, y: top + i * step };
    });
  }
}
