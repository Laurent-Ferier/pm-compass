/** Placing the task graph's cards: a topological sweep left to right, one card at a time.
 *  Pure geometry over `GraphNode`/`GraphEdge` — it sets each node's `position` and draws
 *  nothing. Positions are centres, as the stored `nodePositions` have always been. */
import { GraphNode, NODE_HEIGHT, NODE_WIDTH, type Point } from "./graph-node";
import { GraphEdge } from "./graph-edge";

export interface LayoutSpacing {
  /** Gap between adjacent columns — the horizontal step. */
  rankSep: number;
  /** Gap between neighbours sharing a column — the vertical step. */
  nodeSep: number;
}

/** A card's slot on the grid, before it becomes a centre in pixels. */
interface Slot {
  column: number;
  row: number;
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

/** Whether the card belongs to the band down the left: what the graph hangs off, and what
 *  it waits on from outside. Neither is a card of the level being drawn. */
function inBand(node: GraphNode): boolean {
  return node.isContext || node.isExternal;
}

/** The first column with none of `node`'s dependencies in it or after it. Everything it
 *  waits on is already placed, so this is one past the furthest of them — and never the
 *  band's own column, which is `first`'s doing. */
function columnFor(node: GraphNode, adj: Adjacency, slots: Map<GraphNode, Slot>, first: number): number {
  if (inBand(node)) return 0;
  let column = first;
  for (const pred of adj.preds.get(node)!) {
    const slot = slots.get(pred);
    if (slot) column = Math.max(column, slot.column + 1);
  }
  return column;
}

/** Whether the open segments `a`-`b` and `c`-`d` cross. Segments meeting at a shared card
 *  don't count: edges out of one card fan, they don't cross. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
}

/** Where a card's centre falls, given its slot. */
function centreOf(slot: Slot, spacing: LayoutSpacing): Point {
  return {
    x: slot.column * (NODE_WIDTH + spacing.rankSep) + NODE_WIDTH / 2,
    y: slot.row * (NODE_HEIGHT + spacing.nodeSep) + NODE_HEIGHT / 2,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The row to drop `node` into: the free one whose incoming edges cross the fewest of the
 * edges already drawn. Ties go to the row nearest the middle of what it depends on, which
 * is what draws a chain straight rather than letting it step down the graph.
 *
 * Only drawn edges are weighed on either side. An edge that shapes the layout without
 * being rendered can't be crossed, and counting it would push cards down past free rows.
 */
function rowFor(
  column: number,
  incoming: GraphEdge[],
  slots: Map<GraphNode, Slot>,
  drawn: GraphEdge[],
  taken: Set<number>,
  rowCount: number,
  spacing: LayoutSpacing,
): number {
  const placedPreds = incoming
    .filter((e) => e.isDrawn && slots.has(e.source))
    .map((e) => e.source);
  const predCentres = placedPreds.map((p) => centreOf(slots.get(p)!, spacing));
  const wanted = predCentres.length > 0 ? mean(predCentres.map((c) => c.y)) : 0;

  const drawnSegments = drawn
    .filter((e) => e.isDrawn)
    .map((e) => ({
      edge: e,
      from: centreOf(slots.get(e.source)!, spacing),
      to: centreOf(slots.get(e.target)!, spacing),
    }));

  let best = { row: 0, crossings: Infinity, distance: Infinity };
  // One row per card is always enough: no column can hold more than every card there is.
  for (let row = 0; row < rowCount; row++) {
    if (taken.has(row)) continue;

    const centre = centreOf({ column, row }, spacing);
    let crossings = 0;
    for (let i = 0; i < placedPreds.length; i++) {
      for (const other of drawnSegments) {
        // An edge sharing an end with this one fans out of it; it can't cross it.
        if (other.edge.source === placedPreds[i] || other.edge.target === placedPreds[i]) continue;
        if (segmentsCross(predCentres[i], centre, other.from, other.to)) crossings++;
      }
    }

    const distance = Math.abs(centre.y - wanted);
    if (crossings < best.crossings || (crossings === best.crossings && distance < best.distance)) {
      best = { row, crossings, distance };
    }
  }

  // No column can hold more cards than the graph has, so a free row is always among the
  // ones tried. Falling past them anyway would drop a card on top of another, so the row
  // below everything taken is the answer rather than row 0.
  if (best.crossings === Infinity) return Math.max(-1, ...taken) + 1;
  return best.row;
}

/**
 * A card with nothing before it and a column to itself sits level with the middle of what
 * hangs off it, rather than at the top — this is what centres a project heading or a
 * drilled-into task against its children.
 */
function centreSources(nodes: GraphNode[], adj: Adjacency, columns: Map<GraphNode, number>): void {
  const alone = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const column = columns.get(node)!;
    alone.set(column, [...(alone.get(column) ?? []), node]);
  }
  for (const node of nodes) {
    if (adj.preds.get(node)!.length > 0) continue;
    if (alone.get(columns.get(node)!)!.length > 1) continue;
    const succs = adj.succs.get(node)!;
    if (succs.length === 0) continue;
    node.position = { x: node.position.x, y: mean(succs.map((s) => s.position.y)) };
  }
}

/**
 * Sets every card's `position`. Columns run left to right in dependency order — a card
 * with nothing before it lands in the first, and each of the others one past everything
 * it waits on.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], spacing: LayoutSpacing): void {
  if (nodes.length === 0) return;

  const adj = buildAdjacency(nodes, edges);
  const slots = new Map<GraphNode, Slot>();
  const takenRows = new Map<number, Set<number>>();
  const columns = new Map<GraphNode, number>();
  const drawn: GraphEdge[] = [];

  const incoming = new Map<GraphNode, GraphEdge[]>(nodes.map((n) => [n, []]));
  for (const edge of edges) incoming.get(edge.target)?.push(edge);

  // The band keeps the first column to itself, so no card of the level is ever drawn among
  // its cards. Where the graph has no band, the level starts at the left edge as before.
  const first = nodes.some(inBand) ? 1 : 0;

  for (const node of topologicalOrder(nodes, adj)) {
    const column = columnFor(node, adj, slots, first);
    const taken = takenRows.get(column) ?? new Set<number>();
    const row = rowFor(column, incoming.get(node)!, slots, drawn, taken, nodes.length, spacing);

    taken.add(row);
    takenRows.set(column, taken);
    slots.set(node, { column, row });
    columns.set(node, column);
    node.position = centreOf({ column, row }, spacing);

    // Its edges can be drawn now, and so counted against whatever is placed next.
    for (const edge of edges) {
      if (edge.target !== node && edge.source !== node) continue;
      if (slots.has(edge.source) && slots.has(edge.target) && !drawn.includes(edge)) drawn.push(edge);
    }
  }

  centreSources(nodes, adj, columns);

  const minY = Math.min(...nodes.map((n) => n.position.y));
  for (const node of nodes) node.position = { x: node.position.x, y: node.position.y - minY + NODE_HEIGHT / 2 };
}
