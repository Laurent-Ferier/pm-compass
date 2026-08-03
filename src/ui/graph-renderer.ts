/** Drawing the task graph: absolutely positioned cards over an SVG of dependency edges.
 *  Placement comes from `layoutGraph`, or from whatever the caller passes instead; this
 *  holds the DOM, the viewport offset and the pointer gestures — tap, double tap, dragging
 *  a card to a position of its own, and dropping one on another card or on something
 *  outside the drawing, either of which the view reads as a move. */
import { layoutGraph, type LayoutSpacing } from "./graph-layout";
import { Box, GraphNode, type Point } from "./graph-node";
import { GraphEdge } from "./graph-edge";

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

/** Marks the card a drop would land on. */
const DROP_TARGET_CLASS = "pm-drop-target";

export interface GraphRendererOptions {
  container: HTMLElement;
  nodes: GraphNode[];
  edges: GraphEdge[];
  spacing: LayoutSpacing;
  /** Positions a card was dragged to, overriding the layout. Keyed by node id. */
  storedPositions?: Record<string, Point>;
  /** `origin` is what the press landed on, which is where a tap's meaning comes from — a
   *  release can happen anywhere, a connect drag ending over another card being the case
   *  that matters. */
  onNodeTap?: (node: GraphNode, evt: PointerEvent, origin: Element | null) => void;
  onNodeDoubleTap?: (node: GraphNode, evt: PointerEvent, origin: Element | null) => void;
  onEdgeContextMenu?: (edge: GraphEdge, evt: MouseEvent) => void;
  onNodeDragEnd?: (node: GraphNode, position: Point) => void;
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
  /** Where the cards go. `layoutGraph` — dependency order, left to right — unless the
   *  caller has somewhere else in mind: a level with no edges to sort has none. */
  layout?: (nodes: GraphNode[], edges: GraphEdge[], spacing: LayoutSpacing) => void;
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
    for (const node of this.nodes) {
      if (!node.isDraggable) continue;
      const stored = this.opts.storedPositions?.[node.id];
      if (stored) node.position = { ...stored };
    }
  }

  /** Places the cards again — for a layout that reads the room it has, which a resize
   *  changes. The drawing stays; only where each card sits moves, which is all a reflow is. */
  relayout(): void {
    this.layOut();
    for (const node of this.nodes) node.reposition();
    this.repositionEdges();
  }

  private buildLayers(): void {
    this.edgeLayer = activeDocument.createElementNS(SVG_NS, "svg");
    this.edgeLayer.classList.add("pm-graph-edges");
    this.container.appendChild(this.edgeLayer);

    this.nodeLayer = this.container.createDiv({ cls: "pm-graph-nodes" });
  }

  private drawNodes(): void {
    for (const node of this.nodes) this.wireNode(node, node.render(this.nodeLayer));
  }

  private drawEdges(): void {
    for (const edge of this.edges) {
      edge.render(this.edgeLayer, (evt) => this.opts.onEdgeContextMenu?.(edge, evt));
    }
  }

  private repositionEdges(): void {
    for (const edge of this.edges) edge.reposition();
  }

  /** Where `dragged` would land: the card its centre sits over, as long as `accepts` takes
   *  it. Geometry rather than a hit test — the dragged card is itself what sits under the
   *  pointer, and layout space is where every box already is. */
  private dropTargetFor(dragged: GraphNode, accepts: (target: GraphNode) => boolean): GraphNode | null {
    if (!this.opts.nodeDrop) return null;
    const covered = this.nodes.find((n) => n !== dragged && n.box.contains(dragged.position));
    return covered && accepts(covered) ? covered : null;
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
        node.reposition();
        this.repositionEdges();
      };

      const onMove = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
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
        node.reposition();
        this.repositionEdges();
        // What lies outside wins: a gesture far enough to reach it leaves the card's own
        // centre behind, over whichever card it happens to have been dragged across — so
        // the cards are only searched once nothing over there has taken it.
        const away = this.outsideLanding(outside ?? [], client, takesOutside);
        setLanding(away ?? this.dropTargetFor(node, takesCard));
      };

      const onUp = (ue: PointerEvent) => {
        if (ue.pointerId !== pointerId) return;
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
          this.opts.onNodeDragEnd?.(node, { ...node.position });
          return;
        }
        this.opts.onNodeTap?.(node, ue, origin);
        if (this.lastTap?.node === node && ue.timeStamp - this.lastTap.at < DOUBLE_TAP_MS) {
          this.lastTap = null;
          this.opts.onNodeDoubleTap?.(node, ue, origin);
          return;
        }
        this.lastTap = { node, at: ue.timeStamp };
      };

      const onCancel = (ce: PointerEvent) => {
        if (ce.pointerId !== pointerId) return;
        stop();
        setLanding(null);
        if (!dragging) return;
        el.classList.remove("pm-graph-node--dragging");
        restore();
      };

      // Drops itself from `teardown` too, so a card pressed all session doesn't pile up
      // handlers there that have already unhooked themselves.
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
    };

    el.addEventListener("pointerdown", onPointerDown);
    this.teardown.push(() => el.removeEventListener("pointerdown", onPointerDown));
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
    this.nodeLayer.style.transform = transform;
    this.edgeLayer.style.transform = transform;
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
    this.edgeLayer.remove();
    this.nodeLayer.remove();
  }
}
