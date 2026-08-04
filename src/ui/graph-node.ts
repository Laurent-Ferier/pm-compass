/** The cards the task graph draws: what each stands for, the markup it holds, and where
 *  the layout put it. The layout, the renderer and the view all pass these around. */
import type { CardLayout } from "../model/project/card-layout";

/** The box a card starts at, which is what it stays at until it is made another size. */
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

  /** Whether the two boxes share any room at all. Edges touching is not overlapping: two
   *  boxes laid side by side are not on top of one another. */
  overlaps(other: Box): boolean {
    return this.left < other.right && other.left < this.right
      && this.top < other.bottom && other.top < this.bottom;
  }

  /** The nearest centre this box could take to be clear of `other` — pushed out by whichever
   *  of the four sides is the shortest way out. Its own centre when it is already clear. */
  clearOf(other: Box): Point {
    if (!this.overlaps(other)) return this.centre;
    const { x, y } = this.centre;
    const ways = [
      { x: other.left - this.width / 2, y },
      { x: other.right + this.width / 2, y },
      { x, y: other.top - this.height / 2 },
      { x, y: other.bottom + this.height / 2 },
    ];
    return ways.reduce((a, b) => (Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a));
  }
}

export interface GraphNodeFields {
  id: string;
  /** The card itself, as the view's templates build it. */
  card: HTMLElement;
  /** The place and size of its own it is drawn at, as the task's note holds them. */
  layout?: CardLayout | null;
}

export abstract class GraphNode {
  readonly id: string;
  readonly card: HTMLElement;

  /**
   * Where the card sits and how big it is, in layout space — the one thing a card's
   * geometry is held as. `NODE_WIDTH` by `NODE_HEIGHT` is only what it starts at: give a
   * card a box of another size and everything reading its extent follows, the layout that
   * spaces it, the edges it joins, the drop test and the bounding box alike.
   */
  box: Box;

  /**
   * The place and size of its own it is drawn at, which the vault holds against the task
   * rather than against the drawing. An `x` is what makes a card one the layout must work
   * around instead of arranging; this is updated the moment a gesture ends, so the drawing
   * settles there and then rather than at the next read of the vault.
   */
  layout: CardLayout | null;

  /** The positioned wrapper the card sits in, once drawn. */
  private el: HTMLElement | null = null;

  constructor(fields: GraphNodeFields) {
    this.id = fields.id;
    this.card = fields.card;
    this.layout = fields.layout ?? null;
    this.box = Box.centredOn(
      { x: 0, y: 0 },
      this.layout?.w ?? NODE_WIDTH,
      this.layout?.h ?? NODE_HEIGHT,
    );
  }

  /** The place of its own it is drawn at, which the layout must leave alone — null when it
   *  has none. A card the level can't move was put where it is by the layout, so one stored
   *  against it says nothing. */
  get placedAt(): Point | null {
    const { x, y } = this.layout ?? {};
    return this.isDraggable && x !== undefined && y !== undefined ? { x, y } : null;
  }

  /** Puts the card back at that place, the layout having just placed it among the rest. */
  restorePlace(): void {
    const place = this.placedAt;
    if (place) this.position = place;
  }

  /** Grows or shrinks the card, its top left staying put — which is the corner the handle
   *  is opposite, so the card grows the way the pointer is travelling. */
  resize(width: number, height: number): void {
    this.box = new Box(this.box.left, this.box.top, this.box.left + width, this.box.top + height);
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

  /** Moves and sizes what it drew to the box it now occupies. The wrapper carries both, the
   *  card inside it being sized off the wrapper in CSS. */
  reposition(): void {
    if (!this.el) return;
    this.el.setCssStyles({
      left: `${this.left}px`,
      top: `${this.top}px`,
      width: `${this.box.width}px`,
      height: `${this.box.height}px`,
    });
  }

  destroy(): void {
    this.el?.remove();
    this.el = null;
  }

  /** Stands for a task outside the level being drawn — one it waits on, or one waiting on
   *  it. Such a card is drawn but isn't the level's: it takes no menu and no part in a move,
   *  though it can still be put somewhere that reads better. */
  readonly isExternal: boolean = false;

  /** Drawn under the lines rather than over them — what a card stands behind rather than
   *  among. Only the frame round a level does. */
  readonly isBackdrop: boolean = false;

  /** Whether a press can carry the card somewhere else — and so whether a place of its own
   *  is remembered for it at all. */
  get isDraggable(): boolean {
    return true;
  }

  /** Whether a corner of the card can be pulled to make it bigger. A size is the task's
   *  own, so only a card standing for one the level may act on carries the handle. */
  get isResizable(): boolean {
    return false;
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

/**
 * A project's card. A tap opens that project. It can be dragged and resized like any other
 * card, and it keeps a place of its own from the first time it is drawn — the grid hands it
 * one and the view writes it down, so the projects stop being a layout the panel's width
 * redoes and become an arrangement, which is the user's to make and to keep.
 */
export class ProjectNode extends GraphNode {
  /** The project the card stands for, so a tap needn't read it back out of the markup. */
  readonly projectId: string;

  constructor(fields: GraphNodeFields & { projectId: string }) {
    super(fields);
    this.projectId = fields.projectId;
  }

  override get isResizable(): boolean {
    return true;
  }
}

/**
 * The project or task the level belongs to, drawn as the frame its cards sit in. It is
 * sized off them rather than placed: how big the frame is is settled once everything inside
 * it is down, a card dragged to a place of its own included. Nothing places it, so it never
 * moves and never remembers a position.
 */
export class ContainerNode extends GraphNode {
  /** The task the frame stands for. A project holds no dependencies of its own, so its
   *  frame is never at the end of an edge and names none. */
  readonly taskId?: string;
  override readonly isBackdrop = true;

  constructor(fields: GraphNodeFields & { taskId?: string }) {
    super(fields);
    this.taskId = fields.taskId;
  }

  override get isDraggable(): boolean {
    return false;
  }

  /** Grows the box round `inner`, `padding` on every side and `header` above that. Cards of
   *  its own size, for a level holding none: a frame still has to be drawn. */
  fitAround(inner: GraphNode[], padding: number, header: number): void {
    if (inner.length === 0) {
      this.box = Box.centredOn(this.box.centre, NODE_WIDTH, NODE_HEIGHT);
      return;
    }
    const around = Box.around(inner);
    this.box = new Box(
      around.left - padding,
      around.top - padding - header,
      around.right + padding,
      around.bottom + padding,
    );
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

  /** A card for a task outside the level holds nothing to act on, and a size is written to
   *  the task's own note — so it is drawn at whatever size that note asks for, and cannot
   *  be the card that changes it. */
  override get isResizable(): boolean {
    return !this.isExternal;
  }
}
