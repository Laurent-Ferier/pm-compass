/** Placing the task graph's cards: a topological sweep left to right, one card at a time,
 *  each dropped into the nearest room the ones already down leave it. Pure geometry over
 *  `GraphNode`/`GraphEdge` — it sets each node's `position` and draws nothing. Positions are
 *  centres, as the `cardLayout` a task's note carries has always been. */
import { Box, GraphNode, NODE_HEIGHT, NODE_WIDTH } from "./graph-node";
import { GraphEdge } from "./graph-edge";

export interface LayoutSpacing {
  /** Gap between adjacent columns — the horizontal step. */
  rankSep: number;
  /** Gap between neighbours sharing a column — the vertical step. */
  nodeSep: number;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** The edges of one card, split by direction. */
interface Adjacency {
  preds: Map<GraphNode, GraphNode[]>;
  succs: Map<GraphNode, GraphNode[]>;
}

function buildAdjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const known = new Set(nodes);
  const preds = new Map<GraphNode, GraphNode[]>();
  const succs = new Map<GraphNode, GraphNode[]>();
  for (const node of nodes) {
    preds.set(node, []);
    succs.set(node, []);
  }
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    succs.get(e.source)!.push(e.target);
    preds.get(e.target)!.push(e.source);
  }
  return { preds, succs };
}

/**
 * Kahn's algorithm: the cards with nothing to wait on go in the queue, and each one taken
 * out releases its successors. A card only ever comes out once everything it depends on
 * has, which is what lets the placement below settle a card for good the moment it sees it.
 *
 * A cycle — which the UI forbids but a hand-edited vault can still spell out — leaves its
 * cards waiting forever. They come last, in the order they were given, rather than not at all.
 */
function topologicalOrder(nodes: GraphNode[], adj: Adjacency): GraphNode[] {
  const waitingOn = new Map(nodes.map((n) => [n, adj.preds.get(n)!.length]));
  const queue = nodes.filter((n) => waitingOn.get(n) === 0);
  const order: GraphNode[] = [];
  const released = new Set<GraphNode>(queue);

  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const succ of adj.succs.get(node)!) {
      const left = waitingOn.get(succ)! - 1;
      waitingOn.set(succ, left);
      if (left === 0 && !released.has(succ)) {
        released.add(succ);
        queue.push(succ);
      }
    }
  }

  if (order.length < nodes.length) order.push(...nodes.filter((n) => !released.has(n)));
  return order;
}

/**
 * Where `node`'s left edge can go: clear of everything it waits on, `rankSep` past the
 * furthest of them. Zero for a card that waits on nothing, and for one whose prerequisites
 * are not placed — a cycle, which the UI forbids but a hand-edited vault can spell out.
 */
function leftEdgeFor(
  node: GraphNode,
  adj: Adjacency,
  placed: ReadonlySet<GraphNode>,
  spacing: LayoutSpacing,
): number {
  const preds = adj.preds.get(node)!.filter((p) => placed.has(p));
  return Math.max(0, ...preds.map((p) => p.box.right + spacing.rankSep));
}

/** The height a card wants to sit at: level with the middle of what it waits on, which is
 *  what draws a chain straight rather than letting it step down the graph. The top of the
 *  drawing for a card that waits on nothing, so those stack from there. */
function wantedCentreY(node: GraphNode, adj: Adjacency, placed: ReadonlySet<GraphNode>): number {
  const preds = adj.preds.get(node)!.filter((p) => placed.has(p));
  return preds.length > 0 ? mean(preds.map((p) => p.position.y)) : 0;
}

/**
 * The height nearest `wanted` at which `node` clears every card already down, searched
 * downwards: a card pushed off the height it asked for goes under what took it, never over,
 * so cards with nothing to sort them by end up in the order they were given.
 *
 * Only the cards sharing its band of the drawing can be in the way — two cards in different
 * columns never touch however close their heights.
 */
function freeCentreY(
  node: GraphNode,
  left: number,
  wanted: number,
  placed: readonly GraphNode[],
  spacing: LayoutSpacing,
): number {
  const right = left + node.box.width;
  const inTheWay = placed.filter((p) => left < p.box.right && p.box.left < right);
  // Each one rules out a band of heights: any nearer and the two boxes would touch.
  const bands = inTheWay.map((p) => {
    const reach = (node.box.height + p.box.height) / 2 + spacing.nodeSep;
    return { from: p.position.y - reach, to: p.position.y + reach };
  });
  // Touching a band's edge is clear of it: that is exactly `nodeSep` between the two.
  const clears = (y: number) => bands.every((b) => y <= b.from || y >= b.to);
  if (clears(wanted)) return wanted;
  // Under whatever is in the way — the foot of a band, and never further than the first
  // one that is itself clear. The bands are finite, so the lowest foot always is.
  return bands
    .map((b) => b.to)
    .filter((y) => y > wanted && clears(y))
    .reduce((lowest, y) => Math.min(lowest, y));
}

/**
 * Whether `node` has the room round it that the placement leaves every card: `nodeSep`
 * clear of anything sharing its band of the drawing. Not merely "not on top of" — two cards
 * a pixel apart are as unreadable as two overlapping ones, and the gap is what says they
 * are separate cards at all.
 */
function standsClear(node: GraphNode, nodes: GraphNode[], spacing: LayoutSpacing): boolean {
  const room = new Box(
    node.box.left,
    node.box.top - spacing.nodeSep,
    node.box.right,
    node.box.bottom + spacing.nodeSep,
  );
  return !nodes.some((other) => other !== node && room.overlaps(other.box));
}

/**
 * A card with nothing before it sits level with the middle of what hangs off it, rather
 * than at the height it was given before any of that was placed — this is what centres a
 * project heading or a drilled-into task against its children. Left where it is when the
 * move would crowd another card: a tidier drawing is not worth two cards run together.
 */
function centreSources(nodes: GraphNode[], adj: Adjacency, spacing: LayoutSpacing): void {
  for (const node of nodes) {
    if (adj.preds.get(node)!.length > 0) continue;
    const succs = adj.succs.get(node)!;
    if (succs.length === 0) continue;
    const was = node.position;
    node.position = { x: was.x, y: mean(succs.map((s) => s.position.y)) };
    if (!standsClear(node, nodes, spacing)) node.position = was;
  }
}

/** How many cards fit across `width`, laid out with `spacing` and `padding` at each edge.
 *  Never fewer than one: a panel too narrow for a card still has to draw it. */
export function gridColumns(
  width: number,
  spacing: LayoutSpacing,
  padding: number,
  cardWidth = NODE_WIDTH,
): number {
  const room = width - padding * 2 + spacing.rankSep;
  return Math.max(1, Math.floor(room / (cardWidth + spacing.rankSep)));
}

/**
 * Places cards in reading order, wrapping every `columns`. For a level whose cards have
 * nothing to sort them by — the projects — where a card sits says nothing, so the room is
 * what decides: a topological sweep would file them all down one column.
 *
 * Positions are centres and the drawing starts at the same offset `layoutGraph` leaves,
 * so `fit` sees the two the same way.
 */
export function layoutGrid(nodes: GraphNode[], spacing: LayoutSpacing, columns: number): void {
  // One cell for every card, cut to the largest of them: a list whose rows step by different
  // amounts is no longer a list. Cards sit at their cell's top left, so a card made smaller
  // than its neighbours still lines up with them rather than floating in the middle.
  const cellWidth = Math.max(NODE_WIDTH, ...nodes.map((n) => n.box.width));
  const cellHeight = Math.max(NODE_HEIGHT, ...nodes.map((n) => n.box.height));
  nodes.forEach((node, i) => {
    node.position = {
      x: (i % columns) * (cellWidth + spacing.rankSep) + node.box.width / 2,
      y: Math.floor(i / columns) * (cellHeight + spacing.nodeSep) + node.box.height / 2,
    };
  });
}

/**
 * Keeps the cards the grid placed off the ones that already have a place of their own, each
 * moved down to the nearest height where it clears them. Nothing already placed moves: those
 * are exactly the cards not to arrange.
 *
 * Only a project being drawn for the first time is ever in this position — every other one
 * carries the place it was given, wherever the user has since put it.
 */
export function settleGrid(
  nodes: GraphNode[],
  _edges: GraphEdge[],
  spacing: LayoutSpacing,
  placed: ReadonlySet<GraphNode> = new Set(),
): void {
  if (placed.size === 0) return;
  const inTheWay = nodes.filter((n) => placed.has(n));
  for (const node of nodes) {
    if (placed.has(node)) continue;
    node.position = {
      x: node.position.x,
      y: freeCentreY(node, node.box.left, node.position.y, inTheWay, spacing),
    };
    // Counted from here on, so two new projects don't both land in the one free spot.
    inTheWay.push(node);
  }
}

/**
 * Sets every card's `position`. One card at a time, in dependency order: each goes as far
 * left as everything it waits on allows, and then to the height nearest the middle of those
 * at which it clears whatever is already down.
 *
 * There are no rows and no columns — a card can be any size, so where the next one fits is
 * a question about the boxes already on the drawing rather than about a grid. Cards all at
 * the one size still fall into the ranks and rows that grid would have given them.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], spacing: LayoutSpacing): void {
  if (nodes.length === 0) return;

  const adj = buildAdjacency(nodes, edges);
  const placed: GraphNode[] = [];
  const down = new Set<GraphNode>();

  for (const node of topologicalOrder(nodes, adj)) {
    const left = leftEdgeFor(node, adj, down, spacing);
    const wanted = wantedCentreY(node, adj, down);
    node.position = {
      x: left + node.box.width / 2,
      y: freeCentreY(node, left, wanted, placed, spacing),
    };
    placed.push(node);
    down.add(node);
  }

  centreSources(nodes, adj, spacing);

  // Back to the top of the drawing: a card can end up above the height the first of them
  // was given. Measured from the cards' own top edges rather than their centres, so a card
  // of another size settles level with the rest.
  const top = Math.min(...nodes.map((n) => n.box.top));
  for (const node of nodes) node.position = { x: node.position.x, y: node.position.y - top };
}
