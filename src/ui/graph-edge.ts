/** A link between two cards. A dependency is drawn between them; a virtual edge only
 *  shapes the layout, which is how a context card comes to sit left of everything
 *  hanging off it. */
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

/** How wide the invisible stroke under a drawn edge is. A 1.5px line is not something a
 *  pointer can be asked to hit, least of all a finger. */
const HIT_WIDTH = 14;

export abstract class GraphEdge {
  constructor(
    readonly source: GraphNode,
    readonly target: GraphNode,
  ) {}

  /** Both ends name it, since a pair of cards is joined at most once. */
  get id(): string {
    return `${this.source.id}->${this.target.id}`;
  }

  /** Draws itself into `layer`, if it draws at all. `onContextMenu` fires on a right-click
   *  of whatever it drew. */
  abstract render(layer: SVGSVGElement, onContextMenu: (evt: MouseEvent) => void): void;

  /** Whether the layout's crossing test should weigh this edge: nothing can cross what
   *  isn't on the page. */
  get isDrawn(): boolean {
    return true;
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

  /** A suffix marking the line and its head as a variant of the plain dependency. */
  protected get variant(): string | null {
    return null;
  }

  render(layer: SVGSVGElement, onContextMenu: (evt: MouseEvent) => void): void {
    this.line = svgEl(layer, "line", "pm-graph-edge");
    this.head = svgEl(layer, "polygon", "pm-graph-edge-head");
    if (this.variant) {
      this.line.classList.add(`pm-graph-edge--${this.variant}`);
      this.head.classList.add(`pm-graph-edge-head--${this.variant}`);
    }
    this.hit = svgEl(layer, "line", "pm-graph-edge-hit");
    this.hit.setAttribute("stroke-width", String(HIT_WIDTH));

    const hit = this.hit;
    const handler = (e: Event) => {
      // Stopped here so the container's own handler doesn't follow with its add-task menu.
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e as MouseEvent);
    };
    hit.addEventListener("contextmenu", handler);
    this.teardown = () => hit.removeEventListener("contextmenu", handler);

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
  protected override get variant(): string {
    return "indirect";
  }
}

/** What joins a context card to each task hanging off it. It draws nothing: it exists so
 *  the ranking puts the context card in the first column. */
export class VirtualEdge extends GraphEdge {
  render(): void {}
  reposition(): void {}
  destroy(): void {}
  override get isDrawn(): boolean {
    return false;
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
