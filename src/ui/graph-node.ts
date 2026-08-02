/** The cards the task graph draws: what each stands for, the markup it holds, and where
 *  the layout put it. The layout, the renderer and the view all pass these around. */

/** The box a card occupies. Every graph here draws the same card, so one size fits. */
export const NODE_WIDTH = 160;
export const NODE_HEIGHT = 72;

export interface Point {
  x: number;
  y: number;
}

export interface GraphNodeFields {
  id: string;
  /** The card itself, as the view's templates build it. */
  card: HTMLElement;
}

export abstract class GraphNode {
  readonly id: string;
  readonly card: HTMLElement;

  /** The centre of the card, in layout space. `layoutGraph` sets it; a drag moves it. */
  position: Point = { x: 0, y: 0 };

  /** The positioned wrapper the card sits in, once drawn. */
  private el: HTMLElement | null = null;

  constructor(fields: GraphNodeFields) {
    this.id = fields.id;
    this.card = fields.card;
  }

  /** Draws itself into `layer` and hands back the wrapper, which is what the renderer
   *  listens on — the wrapper stands wider than the card, so a press anywhere on the
   *  card reaches it. */
  render(layer: HTMLElement): HTMLElement {
    const el = layer.createDiv({ cls: "pm-graph-node" });
    el.appendChild(this.card);
    this.el = el;
    this.reposition();
    return el;
  }

  /** The wrapper it drew, or null before it has drawn one. */
  get element(): HTMLElement | null {
    return this.el;
  }

  /** Moves what it drew to where it now sits. */
  reposition(): void {
    if (!this.el) return;
    this.el.style.left = `${this.left}px`;
    this.el.style.top = `${this.top}px`;
  }

  destroy(): void {
    this.el?.remove();
    this.el = null;
  }

  /** Stands for what the graph hangs off rather than for one of its tasks. The first
   *  column holds these, and the separators are drawn against them. */
  abstract readonly isContext: boolean;

  /** Stands for a task the graph waits on from outside it. Having nothing before it, it
   *  falls in the first column, under the card the graph hangs off — and it is no more one
   *  of the level's cards than that one is: neither the divide nor a drop counts it. */
  readonly isExternal: boolean = false;

  /** Whether a double tap opens the card's own children. A context card stands for where
   *  the graph already is, so there is nothing left to open; an external card's children
   *  belong to wherever that task lives, not here. */
  get canDrillIn(): boolean {
    return !this.isContext && !this.isExternal;
  }

  get left(): number {
    return this.position.x - NODE_WIDTH / 2;
  }

  get top(): number {
    return this.position.y - NODE_HEIGHT / 2;
  }

  /** Where the segment from this card's centre towards `towards` leaves its box. */
  exitTowards(towards: Point): Point {
    const dx = towards.x - this.position.x;
    const dy = towards.y - this.position.y;
    if (dx === 0 && dy === 0) return { ...this.position };
    const tx = dx !== 0 ? NODE_WIDTH / 2 / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? NODE_HEIGHT / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return { x: this.position.x + dx * t, y: this.position.y + dy * t };
  }
}

/** A project's heading card. It heads its section, and a tap opens that project. */
export class ProjectNode extends GraphNode {
  readonly isContext = true;
}

/**
 * One task's card. Standing as the graph's context — the task drilled into, left of its
 * children — the task's own card can appear beside it, so this one takes an id of its own
 * and carries the task's separately.
 */
export class TaskNode extends GraphNode {
  /** The task the card stands for. */
  readonly taskId: string;
  readonly isContext: boolean;
  override readonly isExternal: boolean;

  constructor(fields: GraphNodeFields & { taskId?: string; isContext?: boolean; isExternal?: boolean }) {
    super(fields);
    this.taskId = fields.taskId ?? fields.id;
    this.isContext = fields.isContext ?? false;
    this.isExternal = fields.isExternal ?? false;
  }
}

export interface BoundingBox {
  x1: number;
  y1: number;
  w: number;
  h: number;
}

/** The box a set of cards occupies, in layout space. */
export function nodesBoundingBox(nodes: GraphNode[]): BoundingBox {
  if (nodes.length === 0) return { x1: 0, y1: 0, w: 0, h: 0 };
  const x1 = Math.min(...nodes.map((n) => n.left));
  const y1 = Math.min(...nodes.map((n) => n.top));
  return {
    x1,
    y1,
    w: Math.max(...nodes.map((n) => n.left + NODE_WIDTH)) - x1,
    h: Math.max(...nodes.map((n) => n.top + NODE_HEIGHT)) - y1,
  };
}
