/** The cards the task graph draws: what each stands for, the markup it holds, and where
 *  the layout put it. The layout, the renderer and the view all pass these around. */

/** The box a card occupies. Every graph here draws the same card, so one size fits. */
export const NODE_WIDTH = 160;
export const NODE_HEIGHT = 72;

export interface Point {
  x: number;
  y: number;
}

/**
 * A rectangle, held as its four edges — the shape a `DOMRect` already carries, so anything
 * measured off the page becomes one without arithmetic. Which coordinates they are read in
 * is the caller's to know: a card's box is in layout space, a client rect in the page's,
 * and only boxes read the same way can be compared.
 */
export class Box {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly right: number,
    readonly bottom: number,
  ) {}

  /** The same box, taken off anything already measured — a `DOMRect`, above all. */
  static of(edges: { left: number; top: number; right: number; bottom: number }): Box {
    return new Box(edges.left, edges.top, edges.right, edges.bottom);
  }

  /** A box of the given size, sitting on `centre`. Placing a card is choosing this: where
   *  its middle goes, the card's own size settling the four edges. */
  static centredOn(centre: Point, width: number, height: number): Box {
    return new Box(
      centre.x - width / 2,
      centre.y - height / 2,
      centre.x + width / 2,
      centre.y + height / 2,
    );
  }

  /** The box a set of cards occupies. Empty, at the origin, for no cards at all. */
  static around(nodes: GraphNode[]): Box {
    if (nodes.length === 0) return new Box(0, 0, 0, 0);
    const boxes = nodes.map((n) => n.box);
    return new Box(
      Math.min(...boxes.map((b) => b.left)),
      Math.min(...boxes.map((b) => b.top)),
      Math.max(...boxes.map((b) => b.right)),
      Math.max(...boxes.map((b) => b.bottom)),
    );
  }

  get width(): number {
    return this.right - this.left;
  }

  get height(): number {
    return this.bottom - this.top;
  }

  /** The middle of the box — where the layout thinks of a card as being, and what an edge
   *  aims at before trimming back to the boundary. */
  get centre(): Point {
    return { x: (this.left + this.right) / 2, y: (this.top + this.bottom) / 2 };
  }

  /** The same box, its size untouched, moved to sit on `centre`. */
  movedTo(centre: Point): Box {
    return Box.centredOn(centre, this.width, this.height);
  }

  /** Whether `point` falls inside, both read in the same coordinates. */
  contains(point: Point): boolean {
    return point.x >= this.left && point.x <= this.right
      && point.y >= this.top && point.y <= this.bottom;
  }
}

export interface GraphNodeFields {
  id: string;
  /** The card itself, as the view's templates build it. */
  card: HTMLElement;
}

export abstract class GraphNode {
  readonly id: string;
  readonly card: HTMLElement;

  /**
   * Where the card sits and how big it is, in layout space — the one thing a card's
   * geometry is held as. `NODE_WIDTH` by `NODE_HEIGHT` is only what it starts at: give a
   * card a box of another size and everything reading its extent follows, the edges it
   * joins, the drop test and the bounding box alike.
   */
  box: Box = Box.centredOn({ x: 0, y: 0 }, NODE_WIDTH, NODE_HEIGHT);

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

  /** Stands for a task outside the level being drawn — one it waits on, or one waiting on
   *  it. Such a card is drawn but isn't the level's: it takes no menu, no drag and no part
   *  in a move. */
  readonly isExternal: boolean = false;

  /** Whether a press can carry the card somewhere else — and so whether a place of its own
   *  is remembered for it at all. A card the level doesn't own has none to be moved to. */
  get isDraggable(): boolean {
    return !this.isExternal;
  }

  /** The card's centre, which is where the layout places it and what an edge aims at.
   *  Setting it carries the box along, the card's size untouched. */
  get position(): Point {
    return this.box.centre;
  }

  set position(centre: Point) {
    this.box = this.box.movedTo(centre);
  }

  get left(): number {
    return this.box.left;
  }

  get top(): number {
    return this.box.top;
  }

  /** Where the segment from this card's centre towards `towards` leaves its box. */
  exitTowards(towards: Point): Point {
    const centre = this.box.centre;
    const dx = towards.x - centre.x;
    const dy = towards.y - centre.y;
    if (dx === 0 && dy === 0) return centre;
    const tx = dx !== 0 ? this.box.width / 2 / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? this.box.height / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return { x: centre.x + dx * t, y: centre.y + dy * t };
  }
}

/** A project's card. A tap opens that project, and it sits where the grid put it rather
 *  than anywhere a drag would leave it — the grid reflows, so a place among these cards
 *  would mean nothing the next time round. */
export class ProjectNode extends GraphNode {
  /** The project the card stands for, so a tap needn't read it back out of the markup. */
  readonly projectId: string;

  constructor(fields: GraphNodeFields & { projectId: string }) {
    super(fields);
    this.projectId = fields.projectId;
  }

  override get isDraggable(): boolean {
    return false;
  }
}

/**
 * One task's card. A card standing for a task outside the level takes an id of its own,
 * the task's belonging to its real card wherever that is drawn, and carries the task's
 * separately.
 */
export class TaskNode extends GraphNode {
  /** The task the card stands for. */
  readonly taskId: string;
  override readonly isExternal: boolean;

  constructor(fields: GraphNodeFields & { taskId?: string; isExternal?: boolean }) {
    super(fields);
    this.taskId = fields.taskId ?? fields.id;
    this.isExternal = fields.isExternal ?? false;
  }
}
