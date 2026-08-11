/** A link between two cards: one task waiting on another, drawn as a line from the
 *  prerequisite to whatever waits on it. */
import { GraphNode, type Point } from "./graph-node";

/** How far back from the target's edge the line stops, leaving room for the arrowhead. */
const ARROW_LENGTH = 9;
const ARROW_HALF_WIDTH = 4;

/** The line and arrowhead one edge draws, in layout space. */
export interface EdgeGeometry {
  start: Point;
  /** Where the line stops — the arrowhead's base. */
  base: Point;
  /** The arrowhead, as three points. */
  head: [Point, Point, Point];
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** How wide the invisible stroke under a drawn edge is. A 2px line is not something a
 *  pointer can be asked to hit, least of all a finger — and this is what has to be caught
 *  before either end of a dependency can be carried anywhere. */
const HIT_WIDTH = 24;

/** Which end of a line a gesture has hold of: the prerequisite's, or the waiting task's. */
export enum EdgeEnd {
  Source = "source",
  Target = "target",
}

/** What an edge reports to whoever drew it. */
export interface EdgeHandlers {
  onContextMenu: (evt: MouseEvent) => void;
  /** A press on the line itself, which is what takes hold of one of its ends. */
  onPointerDown?: (evt: PointerEvent) => void;
}

export abstract class GraphEdge {
  constructor(
    readonly source: GraphNode,
    readonly target: GraphNode,
  ) {}

  /** Both ends name it, since a pair of cards is joined at most once. */
  get id(): string {
    return `${this.source.id}->${this.target.id}`;
  }

  /** Draws itself into `layer`, if it draws at all, reporting on whatever it drew. */
  abstract render(layer: SVGSVGElement, handlers: EdgeHandlers): void;

  /** The end of the line nearer `point`, both read in layout space. The whole line is a
   *  grab: aiming at the tip of an arrow is finer work than the gesture is worth, and which
   *  half of it was pressed says which end was meant. */
  nearestEnd(point: Point): EdgeEnd {
    const { start, head } = this.geometry();
    const away = (p: Point) => Math.hypot(point.x - p.x, point.y - p.y);
    return away(start) <= away(head[0]) ? EdgeEnd.Source : EdgeEnd.Target;
  }

  /** Moves what it drew to where its cards now sit. */
  abstract reposition(): void;

  abstract destroy(): void;

  /** Where the edge runs, from one card's boundary to the other's. */
  protected geometry(): EdgeGeometry {
    const start = this.source.exitTowards(this.target.position);
    const tip = this.target.exitTowards(this.source.position);

    const dx = tip.x - start.x;
    const dy = tip.y - start.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const base = { x: tip.x - ux * ARROW_LENGTH, y: tip.y - uy * ARROW_LENGTH };

    return {
      start,
      base,
      head: [
        tip,
        { x: base.x - uy * ARROW_HALF_WIDTH, y: base.y + ux * ARROW_HALF_WIDTH },
        { x: base.x + uy * ARROW_HALF_WIDTH, y: base.y - ux * ARROW_HALF_WIDTH },
      ],
    };
  }
}

/** The suffix the line and its arrowhead take when the dependency is not held by the two
 *  cards it joins — see `DependencyEdge.isLifted`. */
const LIFTED = "lifted";

/** The suffix the line and its arrowhead take when both cards it joins hold work that is
 *  behind the reader — see `DependencyEdge.isClosed`. */
const CLOSED = "closed";

/**
 * One task waiting on another: a line with an arrowhead, and the only edge a right-click
 * can reach — its menu is what removes the dependency. It draws three elements, the third
 * being a wide invisible stroke that is what the pointer actually hits.
 */
export class DependencyEdge extends GraphEdge {
  private line: SVGLineElement | null = null;
  private head: SVGPolygonElement | null = null;
  private hit: SVGLineElement | null = null;
  private teardown: (() => void) | null = null;

  /**
   * Whether an end of the dependency is a task the level doesn't hold — one below it, lifted
   * onto the card standing for it, or one outside it, drawn as a card of its own. One mark
   * covers both: what the line has to say is that it reaches past this level, and which way
   * it does is already legible at its ends.
   */
  protected get isLifted(): boolean {
    return this.source.isExternal || this.target.isExternal;
  }

  /**
   * Whether the dependency is behind the reader, both tasks it joins having been closed.
   * Only then: a line into open work still says what that work is waiting on, so it keeps
   * its voice however finished the task at its other end is.
   */
  private get isClosed(): boolean {
    return this.source.isClosed && this.target.isClosed;
  }

  render(layer: SVGSVGElement, handlers: EdgeHandlers): void {
    this.line = svgEl(layer, "line", "pm-graph-edge");
    this.head = svgEl(layer, "polygon", "pm-graph-edge-head");
    if (this.isLifted) {
      this.line.classList.add(`pm-graph-edge--${LIFTED}`);
      this.head.classList.add(`pm-graph-edge-head--${LIFTED}`);
    }
    if (this.isClosed) {
      this.line.classList.add(`pm-graph-edge--${CLOSED}`);
      this.head.classList.add(`pm-graph-edge-head--${CLOSED}`);
    }
    this.hit = svgEl(layer, "line", "pm-graph-edge-hit");
    this.hit.setAttribute("stroke-width", String(HIT_WIDTH));

    const hit = this.hit;
    const menu = (e: Event) => {
      // Stopped here so the container's own handler doesn't follow with its add-task menu.
      e.preventDefault();
      e.stopPropagation();
      handlers.onContextMenu(e as MouseEvent);
    };
    const press = (e: Event) => handlers.onPointerDown?.(e as PointerEvent);
    hit.addEventListener("contextmenu", menu);
    hit.addEventListener("pointerdown", press);
    this.teardown = () => {
      hit.removeEventListener("contextmenu", menu);
      hit.removeEventListener("pointerdown", press);
    };

    this.reposition();
  }

  reposition(): void {
    if (!this.line || !this.head || !this.hit) return;
    const { start, base, head } = this.geometry();
    for (const l of [this.line, this.hit]) {
      l.setAttribute("x1", String(start.x));
      l.setAttribute("y1", String(start.y));
      l.setAttribute("x2", String(base.x));
      l.setAttribute("y2", String(base.y));
    }
    this.head.setAttribute("points", head.map((p) => `${p.x},${p.y}`).join(" "));
  }

  destroy(): void {
    this.teardown?.();
    this.teardown = null;
    for (const el of [this.line, this.head, this.hit]) el?.remove();
    this.line = this.head = this.hit = null;
  }
}

/** A dependency neither of whose ends is on this level: it holds between tasks somewhere
 *  below the two cards it is drawn against. Dotted, to say the link is not theirs. */
export class IndirectDependencyEdge extends DependencyEdge {
  protected override get isLifted(): boolean {
    return true;
  }
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  layer: SVGSVGElement,
  tag: K,
  cls: string,
): SVGElementTagNameMap[K] {
  const el = activeDocument.createElementNS(SVG_NS, tag);
  el.classList.add(cls);
  layer.appendChild(el);
  return el;
}

/** What the view spells out before the cards exist: an edge by the ids of its ends, and
 *  the kind to build once both resolve. */
export interface EdgeSpec {
  source: string;
  target: string;
  kind: new (source: GraphNode, target: GraphNode) => GraphEdge;
}

/** Builds the edges against the cards drawn, dropping any naming one that isn't there. */
export function resolveEdges(nodes: GraphNode[], specs: EdgeSpec[]): GraphEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [];
  for (const spec of specs) {
    const source = byId.get(spec.source);
    const target = byId.get(spec.target);
    if (!source || !target || source === target) continue;
    edges.push(new spec.kind(source, target));
  }
  return edges;
}
