/** Drawing the task graph: absolutely positioned cards over an SVG of dependency edges.
 *  Placement comes from `layoutGraph`, or from whatever the caller passes instead; this
 *  holds the DOM, the viewport offset and the pointer gestures — tap, double tap, dragging
 *  a card to a position of its own, and dropping one on another card or on something
 *  outside the drawing, either of which the view reads as a move. */
import { layoutGraph, type LayoutSpacing } from "./graph-layout";
import { Box, GraphNode, type Point } from "./graph-node";
import { EdgeEnd, GraphEdge } from "./graph-edge";
import {
  MAX_CARD_HEIGHT, MAX_CARD_WIDTH, MIN_CARD_HEIGHT, MIN_CARD_WIDTH, clamp, type CardLayout,
} from "../model/project/card-layout";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * How far a finger travels before it drags a card rather than tapping it. The few pixels a
 * mouse gets are under what a thumb rolls while pressing a badge. Raising the distance also
 * makes the long-press menu more tolerant of wobble, where a delay would eat into its timing.
 */
const TOUCH_DRAG_THRESHOLD = 24;
const MOUSE_DRAG_THRESHOLD = 4;

/** Two taps on one card closer together than this read as a double tap. */
const DOUBLE_TAP_MS = 300;

/** A card's own controls carry their own pointer handlers, so a press on one of them
 *  must not also start dragging the card. It still counts as a tap. */
const CARD_CONTROLS = ".pm-node-ribbon, .pm-node-status, .pm-node-connect-btn, .pm-node-edit-btn";

/** The corner pulled to make a card bigger. Its own gesture rather than one of the controls
 *  above: a press on it neither drags the card nor counts as a tap on it. */
const RESIZE_HANDLE = ".pm-node-resize-handle";

/** Marks a card while its corner is being pulled. */
const RESIZING_CLASS = "pm-graph-node--resizing";

/** Marks the card a drop would land on. */
const DROP_TARGET_CLASS = "pm-drop-target";

/** Marks whatever a dependency being re-pointed would land on — the same mark the connect
 *  gesture leaves, both of them meaning "the link ends here". */
const CONNECT_TARGET_CLASS = "pm-connect-target";

export interface GraphRendererOptions {
  container: HTMLElement;
  nodes: GraphNode[];
  edges: GraphEdge[];
  spacing: LayoutSpacing;
  /** `origin` is what the press landed on, which is where a tap's meaning comes from — a
   *  release can happen anywhere, a connect drag ending over another card being the case
   *  that matters. */
  onNodeTap?: (node: GraphNode, evt: PointerEvent, origin: Element | null) => void;
  onNodeDoubleTap?: (node: GraphNode, evt: PointerEvent, origin: Element | null) => void;
  onEdgeContextMenu?: (edge: GraphEdge, evt: MouseEvent) => void;
  /** A card let go of somewhere new, and a card's corner let go of. Both hand over the
   *  card's whole layout as it now stands — the renderer has already applied it and settled
   *  the drawing round it, so what remains is recording it. */
  onNodeDragEnd?: (node: GraphNode, layout: CardLayout) => void;
  onNodeResizeEnd?: (node: GraphNode, layout: CardLayout) => void;
  /** Dropping a card onto another one. Only a target `canDrop` accepts lights up, and a
   *  drop on one puts the dragged card back where it started rather than reporting a new
   *  position: what this gesture changes is the tree, not the layout. What landing on a
   *  given card means is the view's to say. */
  nodeDrop?: {
    canDrop: (dragged: GraphNode, target: GraphNode) => boolean;
    onDrop: (dragged: GraphNode, target: GraphNode) => void;
  };
  /** Dropping a card somewhere outside the drawing — the breadcrumb, today. Hit-tested
   *  against rects measured once as the gesture begins, the same geometry a card-on-card
   *  drop is judged by: a pointer test would find the card being dragged. */
  outsideDrop?: {
    /** Asked once per gesture: what these elements are is the caller's, and a re-render
     *  builds them afresh. */
    targets: () => HTMLElement[];
    /** What marks the one a drop would land on. Its own, not the cards': whatever is over
     *  there is not card-shaped, and the mark has to suit it. */
    markClass: string;
    canDrop: (dragged: GraphNode, target: HTMLElement) => boolean;
    onDrop: (dragged: GraphNode, target: HTMLElement) => void;
  };
  /** Dragging one end of a drawn line onto another card, which re-points the dependency it
   *  stands for. The renderer runs the pointer and the geometry; which stored link moves,
   *  and whether it may, is the view's to say. */
  edgeRepoint?: {
    canDrop: (edge: GraphEdge, end: EdgeEnd, target: GraphNode) => boolean;
    /** `evt` is the release, which is where a menu asking what the drop meant opens. */
    onDrop: (edge: GraphEdge, end: EdgeEnd, target: GraphNode, evt: PointerEvent) => void;
  };
  /** Where the cards go. `layoutGraph` — dependency order, left to right — unless the
   *  caller has somewhere else in mind: a level with no edges to sort has none. */
  layout?: (nodes: GraphNode[], edges: GraphEdge[], spacing: LayoutSpacing) => void;
  /** Whatever is sized or placed off where the cards ended up — the frame round a level and
   *  the cards outside it. Run after any stored position, which the layout can't see: a
   *  card dragged to a place of its own moves once the layout has already run. `placed` are
   *  the cards that already have a place — a stored one, or the one a live gesture is giving
   *  them — which this may hold within bounds but must not arrange. */
  settle?: (
    nodes: GraphNode[],
    edges: GraphEdge[],
    spacing: LayoutSpacing,
    placed: ReadonlySet<GraphNode>,
  ) => void;
}

/** What a gesture is currently over: a card of the drawing, or an element outside it. One
 *  is held at a time, and identity is all it takes to tell two of them apart. */
type Landing = GraphNode | HTMLElement;

/** One element a drop can land on outside the drawing, and the box it occupies — measured
 *  once, the breadcrumb being unable to move while a card is being dragged. */
interface OutsideTarget {
  element: HTMLElement;
  box: Box;
}

export class GraphRenderer {
  private readonly container: HTMLElement;
  private readonly nodes: GraphNode[];
  private readonly edges: GraphEdge[];
  private readonly opts: GraphRendererOptions;

  private backdropLayer!: HTMLElement;
  private edgeLayer!: SVGSVGElement;
  private nodeLayer!: HTMLElement;

  /** The offset from layout space to the container, as `fit` last set it. */
  private pan: Point = { x: 0, y: 0 };

  private lastTap: { node: GraphNode; at: number } | null = null;
  private teardown: Array<() => void> = [];
  /** What a live gesture has marked outside the drawing. Held here rather than left to the
   *  gesture: an element outside doesn't die with this renderer, so a refresh mid-drag
   *  would strand the mark on it. */
  private outsideMark: HTMLElement | null = null;

  constructor(opts: GraphRendererOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.nodes = opts.nodes;
    this.edges = opts.edges;

    this.layOut();

    this.buildLayers();
    this.drawNodes();
    this.drawEdges();
  }

  /** Places every card: the layout first, then whichever of them were dragged somewhere of
   *  their own. Only a card the level can move keeps a place — one it can't was put where
   *  it is by the layout, and a position stored against it says nothing. */
  private layOut(): void {
    (this.opts.layout ?? layoutGraph)(this.nodes, this.edges, this.opts.spacing);
    for (const node of this.nodes) node.restorePlace();
    this.opts.settle?.(this.nodes, this.edges, this.opts.spacing, this.placed());
  }

  /** The cards that already have a place of their own: one the card carries, and the one a
   *  gesture is carrying right now, whose place has not been written anywhere yet. */
  private placed(dragged?: GraphNode): Set<GraphNode> {
    const set = new Set(this.nodes.filter((n) => n.placedAt));
    if (dragged) set.add(dragged);
    return set;
  }

  /** Settles again and moves what that changed — for a card that has just gone somewhere
   *  new, so the frame round it grows there and then rather than at the next render. */
  private resettle(dragged?: GraphNode): void {
    this.opts.settle?.(this.nodes, this.edges, this.opts.spacing, this.placed(dragged));
    for (const node of this.nodes) node.reposition();
    this.repositionEdges();
  }

  /** Places the cards again — for a layout that reads the room it has, which a resize
   *  changes. The drawing stays; only where each card sits moves, which is all a reflow is. */
  relayout(): void {
    this.layOut();
    for (const node of this.nodes) node.reposition();
    this.repositionEdges();
  }

  /** Three layers, bottom to top: whatever stands behind the drawing, the lines, then the
   *  cards. The frame round a level is a backdrop, so a line crossing it runs over it rather
   *  than disappearing under it — and the cards still sit above both. */
  private buildLayers(): void {
    this.backdropLayer = this.container.createDiv({ cls: "pm-graph-backdrop" });

    this.edgeLayer = activeDocument.createElementNS(SVG_NS, "svg");
    this.edgeLayer.classList.add("pm-graph-edges");
    this.container.appendChild(this.edgeLayer);

    this.nodeLayer = this.container.createDiv({ cls: "pm-graph-nodes" });
  }

  private drawNodes(): void {
    for (const node of this.nodes) {
      this.wireNode(node, node.render(node.isBackdrop ? this.backdropLayer : this.nodeLayer));
    }
  }

  private drawEdges(): void {
    for (const edge of this.edges) {
      edge.render(this.edgeLayer, {
        onContextMenu: (evt) => this.opts.onEdgeContextMenu?.(edge, evt),
        onPointerDown: (evt) => this.wireEdge(edge, evt),
      });
    }
  }

  /**
   * A press anywhere on a line takes hold of the end nearer it and carries that end to
   * another card, which re-points the dependency. The whole line rather than the tips of it:
   * aiming at an arrowhead is finer work than the gesture is worth.
   *
   * The rubber band is drawn into the edge layer, in layout space, rather than over the page
   * as the connect gesture's is: the geometry here already lives in layout space, and a band
   * of its own means the real line never moves and never has to be put back.
   */
  private wireEdge(edge: GraphEdge, e: PointerEvent): void {
    if (e.button !== 0 || !this.opts.edgeRepoint) return;
    const from = this.toLayout({ x: e.clientX, y: e.clientY });
    const end = edge.nearestEnd(from);
    // The container's own handler would otherwise follow, and the press must not also count
    // as one on whatever sits under the line.
    e.preventDefault();
    e.stopPropagation();

    const pointerId = e.pointerId;
    // The end left in place, which is what the band is drawn from.
    const anchor = end === EdgeEnd.Source ? edge.target : edge.source;
    const band = activeDocument.createElementNS(SVG_NS, "line");
    band.classList.add("pm-graph-edge", "pm-graph-edge--dragging");
    this.edgeLayer.appendChild(band);
    let landing: GraphNode | null = null;
    const asked = new Map<GraphNode, boolean>();

    const setLanding = (next: GraphNode | null) => {
      if (next === landing) return;
      landing?.card.classList.remove(CONNECT_TARGET_CLASS);
      next?.card.classList.add(CONNECT_TARGET_CLASS);
      landing = next;
    };

    const drawBand = (to: Point) => {
      const start = anchor.exitTowards(to);
      band.setAttribute("x1", String(start.x));
      band.setAttribute("y1", String(start.y));
      band.setAttribute("x2", String(to.x));
      band.setAttribute("y2", String(to.y));
    };
    drawBand(from);

    const done = () => {
      stop();
      band.remove();
      setLanding(null);
    };

    const stop = this.trackPointer(pointerId, {
      move: (me) => {
        const at = this.toLayout({ x: me.clientX, y: me.clientY });
        drawBand(at);
        // Geometric, like every other drop test here: the band sits under the pointer, and a
        // frame's own body takes no pointer events at all.
        const over = this.nodesAt(at).find((n) => {
          if (n === anchor) return false;
          const known = asked.get(n);
          if (known !== undefined) return known;
          const answer = this.opts.edgeRepoint!.canDrop(edge, end, n);
          asked.set(n, answer);
          return answer;
        });
        setLanding(over ?? null);
      },
      up: (ue) => {
        const target = landing;
        done();
        if (target) this.opts.edgeRepoint?.onDrop(edge, end, target, ue);
      },
      cancel: done,
    });
  }

  /**
   * Drops the click a browser sends after a tap, when it lands anywhere but the drawing.
   *
   * That click is hit-tested where the finger was as it is sent, not against what the finger
   * pressed — so a tap that opened a modal has it land on the modal's backdrop, which reads
   * it as a click outside and closes what the tap just opened. A mouse has no such trouble:
   * its click goes to what the press and the release share.
   *
   * Only a click from outside is dropped, which is the whole of the phantom: a card still
   * sitting under the finger means nothing came up over it.
   */
  private dropStrayClick(): void {
    const kill = (e: Event) => {
      const target = e.target as Node | null;
      if (target && this.container.contains(target)) return;
      e.stopPropagation();
      e.preventDefault();
    };
    // Off again on the next turn of the loop: the click, if it comes at all, comes with the
    // rest of the gesture, and a later one belongs to whatever the user pressed next.
    const off = () => activeDocument.removeEventListener("click", kill, true);
    activeDocument.addEventListener("click", kill, true);
    this.teardown.push(off);
    window.setTimeout(() => {
      off();
      this.teardown = this.teardown.filter((t) => t !== off);
    });
  }

  /** Follows one pointer to the end of its gesture, and hands back the stop that unhooks it.
   *  Another pointer's events are none of the gesture's business, so they are dropped here
   *  rather than in each handler. The stop drops itself from `teardown` too, so a card
   *  pressed all session doesn't pile up handlers there that have already unhooked. */
  private trackPointer(
    pointerId: number,
    handlers: { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel: (e: PointerEvent) => void },
  ): () => void {
    const only = (handle: (e: PointerEvent) => void) => (e: PointerEvent) => {
      if (e.pointerId === pointerId) handle(e);
    };
    const onMove = only(handlers.move);
    const onUp = only(handlers.up);
    const onCancel = only(handlers.cancel);
    const stop = () => {
      activeDocument.removeEventListener("pointermove", onMove);
      activeDocument.removeEventListener("pointerup", onUp);
      activeDocument.removeEventListener("pointercancel", onCancel);
      this.teardown = this.teardown.filter((off) => off !== stop);
    };
    activeDocument.addEventListener("pointermove", onMove);
    activeDocument.addEventListener("pointerup", onUp);
    activeDocument.addEventListener("pointercancel", onCancel);
    this.teardown.push(stop);
    return stop;
  }

  private repositionEdges(): void {
    for (const edge of this.edges) edge.reposition();
  }

  /** The cards a point in layout space falls on, the smallest first. Smallest, because the
   *  frame round a level holds every card of it: a card inside is the nearer answer, and the
   *  frame is only what the empty room inside it means. */
  private nodesAt(point: Point): GraphNode[] {
    return this.nodes
      .filter((n) => n.box.contains(point))
      .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
  }

  /** A point on the page in layout space. The layers are translated by `pan` inside a
   *  container whose own rect moves with the scroll, so there is no scroll term. */
  private toLayout(client: Point): Point {
    const box = Box.of(this.container.getBoundingClientRect());
    return { x: client.x - box.left - this.pan.x, y: client.y - box.top - this.pan.y };
  }

  /** Where `dragged` would land: the smallest card its centre sits over that `accepts`
   *  takes. Geometry rather than a hit test — the dragged card is itself what sits under the
   *  pointer, and layout space is where every box already is. */
  private dropTargetFor(dragged: GraphNode, accepts: (target: GraphNode) => boolean): GraphNode | null {
    if (!this.opts.nodeDrop) return null;
    return this.nodesAt(dragged.position).find((n) => n !== dragged && accepts(n)) ?? null;
  }

  /** The boxes a drop can land in outside the drawing, as they stand right now. */
  private measureOutside(): OutsideTarget[] {
    const targets = this.opts.outsideDrop?.targets() ?? [];
    return targets.map((element) => ({ element, box: Box.of(element.getBoundingClientRect()) }));
  }

  /** The element outside the drawing the pointer is over, if `accepts` takes the card. */
  private outsideLanding(
    targets: OutsideTarget[],
    client: Point,
    accepts: (target: HTMLElement) => boolean,
  ): HTMLElement | null {
    const found = targets.find((t) => t.box.contains(client));
    return found && accepts(found.element) ? found.element : null;
  }

  /**
   * Whether the pointer has gone above the drawing, which is where the bar a card can be
   * dropped on sits. The one direction that says nothing about where the card should go:
   * `heldInside` stops the card itself at the top edge, so a gesture reaching up there
   * left it behind and was meant for what is up there.
   *
   * Every other direction is a placement. The drawing is only as big as the cards in it,
   * so a card carried past its bottom or its right is asking it to grow — which `fit` does
   * on the next breath.
   */
  private aboveContainer(client: Point): boolean {
    const box = Box.of(this.container.getBoundingClientRect());
    // A container with no box of its own can't say the pointer has left it, so it doesn't.
    if (box.width === 0 && box.height === 0) return false;
    return client.y < box.top;
  }

  /** `position`, held where the container can still draw it. The graph scrolls, but not
   *  above its own top: a card dragged past it would be clipped away mid-gesture. */
  private heldInside(node: GraphNode, centre: Point): Point {
    return { x: centre.x, y: Math.max(centre.y, node.box.height / 2 - this.pan.y) };
  }

  /** One card's pointer gesture: a press that travels far enough drags the card, and one
   *  that doesn't is a tap — a second tap soon after being a double. */
  private wireNode(node: GraphNode, el: HTMLElement): void {
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const origin = e.target as Element | null;
      if (origin?.closest?.(RESIZE_HANDLE) && node.isResizable) {
        this.wireResize(node, el, e);
        return;
      }
      const draggable = !origin?.closest?.(CARD_CONTROLS) && node.isDraggable;
      const threshold = e.pointerType === "touch" ? TOUCH_DRAG_THRESHOLD : MOUSE_DRAG_THRESHOLD;
      const startClient = { x: e.clientX, y: e.clientY };
      const startPos = { ...node.position };
      // Only the finger that started the gesture drives it: a second one scrolling the
      // page would otherwise drag the card out from under the first.
      const pointerId = e.pointerId;
      let dragging = false;
      /** Where the pointer last was, which is what anything outside the drawing is judged
       *  against — the card itself never gets that far. */
      let client = startClient;
      /** Where the drop would land, kept per gesture so it can be unmarked from wherever
       *  the gesture ends. */
      let landing: Landing | null = null;
      /** Measured the first frame of a drag, not on every press: the boxes can't move while
       *  a card is being dragged, and most presses are taps. */
      let outside: OutsideTarget[] | null = null;
      /** `canDrop` walks the task tree, and a drag asks about the same target frame after
       *  frame. Nothing it reads changes while the gesture is on, so one answer per target
       *  crossed does — for either kind. */
      const asked = new Map<Landing, boolean>();
      const accepts = <T extends Landing>(target: T, ask: (t: T) => boolean) => {
        const known = asked.get(target);
        if (known !== undefined) return known;
        const answer = ask(target);
        asked.set(target, answer);
        return answer;
      };
      const takesCard = (target: GraphNode) =>
        accepts(target, (t) => this.opts.nodeDrop?.canDrop(node, t) ?? false);
      const takesOutside = (target: HTMLElement) =>
        accepts(target, (t) => this.opts.outsideDrop?.canDrop(node, t) ?? false);

      /** Marks where the drop would land, taking the mark off wherever it was. A card and
       *  an element outside carry different ones: what is over there is not card-shaped. */
      const markFor = (l: Landing) => l instanceof GraphNode
        ? { el: l.card, cls: DROP_TARGET_CLASS }
        : { el: l, cls: this.opts.outsideDrop!.markClass };
      const setLanding = (next: Landing | null) => {
        if (next === landing) return;
        if (landing) { const m = markFor(landing); m.el.classList.remove(m.cls); }
        if (next) { const m = markFor(next); m.el.classList.add(m.cls); }
        this.outsideMark = next instanceof GraphNode ? null : next;
        landing = next;
      };

      /** Puts the card back where the press found it. */
      const restore = () => {
        node.position = startPos;
        this.resettle(node);
      };

      const onMove = (me: PointerEvent) => {
        const dx = me.clientX - startClient.x;
        const dy = me.clientY - startClient.y;
        if (!dragging) {
          if (!draggable || Math.hypot(dx, dy) < threshold) return;
          dragging = true;
          outside = this.measureOutside();
          el.classList.add("pm-graph-node--dragging");
        }
        client = { x: me.clientX, y: me.clientY };
        // Where the gesture asks the card to go, which is not always where it can: pulled
        // off the top of the container, the card stops at that edge while the gesture goes
        // on. Dropping onto the breadcrumb leaves the drawing entirely, and a card that
        // followed it there would simply be clipped away.
        node.position = this.heldInside(node, { x: startPos.x + dx, y: startPos.y + dy });
        // Settled with this card counted as placed, so what arranges the others holds it
        // where it may go rather than putting it back where it would have gone.
        this.resettle(node);
        // What lies outside wins: a gesture far enough to reach it leaves the card's own
        // centre behind, over whichever card it happens to have been dragged across — so
        // the cards are only searched once nothing over there has taken it.
        const away = this.outsideLanding(outside ?? [], client, takesOutside);
        setLanding(away ?? this.dropTargetFor(node, takesCard));
      };

      const onUp = (ue: PointerEvent) => {
        stop();
        if (dragging) {
          el.classList.remove("pm-graph-node--dragging");
          const target = landing;
          setLanding(null);
          // A drop on another card, or outside the drawing, is a move rather than a
          // placement: the card goes back and the view decides what the drop meant.
          if (target) {
            restore();
            if (target instanceof GraphNode) this.opts.nodeDrop?.onDrop(node, target);
            else this.opts.outsideDrop?.onDrop(node, target);
            return;
          }
          // Let go up on the bar with nothing there to drop on: the gesture was for what is
          // up there, not for a place along the top edge, which is all the card can reach.
          if (this.aboveContainer(client)) {
            restore();
            return;
          }
          // Kept on the card as well as reported: the next settle has to see it as a card
          // with a place of its own, whether or not the vault has caught up yet. Whole
          // pixels — a finger reports fractions of one, and this is written into a note.
          node.layout = { ...node.layout, x: Math.round(node.position.x), y: Math.round(node.position.y) };
          this.opts.onNodeDragEnd?.(node, node.layout);
          return;
        }
        if (ue.pointerType === "touch") this.dropStrayClick();
        this.opts.onNodeTap?.(node, ue, origin);
        if (this.lastTap?.node === node && ue.timeStamp - this.lastTap.at < DOUBLE_TAP_MS) {
          this.lastTap = null;
          this.opts.onNodeDoubleTap?.(node, ue, origin);
          return;
        }
        this.lastTap = { node, at: ue.timeStamp };
      };

      const onCancel = () => {
        stop();
        setLanding(null);
        if (!dragging) return;
        el.classList.remove("pm-graph-node--dragging");
        restore();
      };

      const stop = this.trackPointer(pointerId, { move: onMove, up: onUp, cancel: onCancel });
    };

    el.addEventListener("pointerdown", onPointerDown);
    this.teardown.push(() => el.removeEventListener("pointerdown", onPointerDown));
  }

  /**
   * Pulling a card's bottom-right corner. The card's top left stays where it is, so the card
   * grows the way the pointer travels and nothing already read moves out from under the eye;
   * the drawing settles round each step, so the frame grows with it rather than at the end.
   *
   * Cancelled — a call coming in, the view refreshing — the card goes back to the size the
   * press found it at, like a drag that was let go of nowhere.
   */
  private wireResize(node: GraphNode, el: HTMLElement, e: PointerEvent): void {
    // The press must not also reach the card under the handle, nor start a drag.
    e.preventDefault();
    e.stopPropagation();

    const start = { x: e.clientX, y: e.clientY };
    const from = { width: node.box.width, height: node.box.height };
    el.classList.add(RESIZING_CLASS);

    const applySize = (width: number, height: number) => {
      node.resize(width, height);
      // Counted as placed: what arranges the others must work round the card being pulled,
      // not put it back where a card of its old size would have gone.
      this.resettle(node);
    };

    const finish = () => {
      stop();
      el.classList.remove(RESIZING_CLASS);
    };

    const stop = this.trackPointer(e.pointerId, {
      move: (me) => {
        applySize(
          clamp(from.width + (me.clientX - start.x), MIN_CARD_WIDTH, MAX_CARD_WIDTH),
          clamp(from.height + (me.clientY - start.y), MIN_CARD_HEIGHT, MAX_CARD_HEIGHT),
        );
      },
      up: () => {
        finish();
        if (node.box.width === from.width && node.box.height === from.height) return;
        // Whole pixels, for the same reason a dragged-to place is — see `onNodeDragEnd`.
        node.layout = { ...node.layout, w: Math.round(node.box.width), h: Math.round(node.box.height) };
        this.opts.onNodeResizeEnd?.(node, node.layout);
      },
      cancel: () => {
        finish();
        applySize(from.width, from.height);
      },
    });
  }

  /** The cards it drew, for a caller that has to read where they ended up. */
  get cards(): readonly GraphNode[] {
    return this.nodes;
  }

  /** The box the cards occupy, in layout space. */
  boundingBox(): Box {
    return Box.around(this.nodes);
  }

  /**
   * Offsets the drawing so the graph sits `padding` from the container's top left, and
   * reports the room it needs. The caller decides what to do with those dimensions — a
   * section fixes only its height, the drilled-in graph both.
   */
  fit(padding: number): { width: number; height: number } {
    const box = this.boundingBox();
    this.pan = { x: padding - box.left, y: padding - box.top };
    const transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
    for (const layer of [this.backdropLayer, this.edgeLayer, this.nodeLayer]) {
      layer.style.transform = transform;
    }
    return {
      width: Math.ceil(box.width) + padding * 2,
      height: Math.ceil(box.height) + padding * 2,
    };
  }

  destroy(): void {
    for (const off of this.teardown) off();
    this.teardown = [];
    // An element outside the drawing outlives this renderer, so the mark a live gesture
    // left on it has to come off here — nothing else will take it with them.
    if (this.outsideMark && this.opts.outsideDrop) {
      this.outsideMark.classList.remove(this.opts.outsideDrop.markClass);
    }
    this.outsideMark = null;
    for (const node of this.nodes) node.destroy();
    for (const edge of this.edges) edge.destroy();
    for (const layer of [this.backdropLayer, this.edgeLayer, this.nodeLayer]) layer.remove();
  }
}
