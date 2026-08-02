/** Drawing the task graph: absolutely positioned cards over an SVG of dependency edges.
 *  Placement comes from `layoutGraph`; this holds the DOM, the viewport offset and the
 *  pointer gestures — tap, double tap, dragging a card to a position of its own, and
 *  dropping one on another card, which the view reads as a move. */
import { layoutGraph, type LayoutSpacing } from "./graph-layout";
import { GraphNode, nodesBoundingBox, NODE_HEIGHT, NODE_WIDTH, type BoundingBox, type Point } from "./graph-node";
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
   *  position: what this gesture changes is the tree, not the layout.
   *
   *  A card dropped left of the context divide lands on the context card the whole column
   *  stands for, without having to cover it. The two are the same drop to the renderer;
   *  what a context card means as a destination is the view's to say. */
  nodeDrop?: {
    canDrop: (dragged: GraphNode, target: GraphNode) => boolean;
    onDrop: (dragged: GraphNode, target: GraphNode) => void;
  };
}

/** Where a drop would land: the card itself, and — for one taken from the context column
 *  rather than from the card — where that column ends, which is what gets painted. */
interface DropTarget {
  node: GraphNode;
  zoneRight: number | null;
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
  /** The overlay marking the context column while a drop would land in it. */
  private dropZoneEl: HTMLElement | null = null;

  constructor(opts: GraphRendererOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.nodes = opts.nodes;
    this.edges = opts.edges;

    layoutGraph(this.nodes, this.edges, opts.spacing);
    for (const node of this.nodes) {
      const stored = opts.storedPositions?.[node.id];
      if (stored) node.position = { ...stored };
    }

    this.buildLayers();
    this.drawNodes();
    this.drawEdges();
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

  /** Where `dragged` would land: the card its centre sits over, or the context card whose
   *  column it has been pulled into, as long as `accepts` takes it. Geometry rather than a
   *  hit test: the dragged card is itself what sits under the pointer, and layout space is
   *  where every box already is. */
  private dropTargetFor(
    dragged: GraphNode,
    divide: number | null,
    accepts: (target: GraphNode) => boolean,
  ): DropTarget | null {
    if (!this.opts.nodeDrop) return null;
    const { x, y } = dragged.position;
    const covered = this.nodes.find((n) =>
      n !== dragged
      && x >= n.left && x <= n.left + NODE_WIDTH
      && y >= n.top && y <= n.top + NODE_HEIGHT,
    );
    const target = covered
      ? { node: covered, zoneRight: null }
      : this.contextZoneTarget(dragged, divide);
    return target && accepts(target.node) ? target : null;
  }

  /** The context card a drop left of the divide lands on — the column stands for it, so
   *  the card needn't be covered. Null for a card that isn't over there, or a graph with
   *  no divide of its own to cross. */
  private contextZoneTarget(dragged: GraphNode, divide: number | null): DropTarget | null {
    if (dragged.isContext) return null;
    if (divide === null || dragged.position.x >= divide) return null;
    // Nearest by row, though every graph drawn here heads its cards with a single one.
    const node = this.contextNodes()
      .filter((n) => n !== dragged)
      .sort((a, b) =>
        Math.abs(a.position.y - dragged.position.y) - Math.abs(b.position.y - dragged.position.y))[0];
    return node ? { node, zoneRight: divide + this.pan.x } : null;
  }

  /** Where the context column ends and the cards it heads begin, in layout space. Null when
   *  either side is empty, or the two overlap and no line belongs between them. Taken once
   *  as a drag begins: a card crossing the divide would otherwise take it along. */
  private contextDivide(): number | null {
    const contextRight = this.contextNodes().map((n) => n.position.x + NODE_WIDTH / 2);
    const contentLeft = this.contentNodes().map((n) => n.position.x - NODE_WIDTH / 2);
    if (contextRight.length === 0 || contentLeft.length === 0) return null;
    const right = Math.max(...contextRight);
    const left = Math.min(...contentLeft);
    return right < left ? (right + left) / 2 : null;
  }

  /** The same divide in container coordinates, which is what the separators are drawn in. */
  contextDivideX(): number | null {
    const divide = this.contextDivide();
    return divide === null ? null : divide + this.pan.x;
  }

  /** Paints the column a drop would land in, or takes the paint off again. */
  private paintDropZone(right: number | null): void {
    if (right === null) {
      this.dropZoneEl?.remove();
      this.dropZoneEl = null;
      return;
    }
    if (!this.dropZoneEl) {
      // First in the container, so it paints under the edges and the cards: painting order
      // among these is tree order, none of them carrying a z-index of its own.
      this.dropZoneEl = this.container.createDiv({ cls: "pm-graph-drop-zone" });
      this.container.prepend(this.dropZoneEl);
    }
    this.dropZoneEl.style.width = `${right}px`;
  }

  /** One card's pointer gesture: a press that travels far enough drags the card, and one
   *  that doesn't is a tap — a second tap soon after being a double. */
  private wireNode(node: GraphNode, el: HTMLElement): void {
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const origin = e.target as Element | null;
      const draggable = !origin?.closest?.(CARD_CONTROLS);
      const threshold = e.pointerType === "touch" ? TOUCH_DRAG_THRESHOLD : MOUSE_DRAG_THRESHOLD;
      const startClient = { x: e.clientX, y: e.clientY };
      const startPos = { ...node.position };
      // Read before anything moves, so the line the drop is judged against is the one the
      // separator was drawn at.
      const divide = this.contextDivide();
      // Only the finger that started the gesture drives it: a second one scrolling the
      // page would otherwise drag the card out from under the first.
      const pointerId = e.pointerId;
      let dragging = false;
      /** Where the drop would land, kept per gesture so it can be unmarked from wherever
       *  the gesture ends. */
      let dropTarget: DropTarget | null = null;
      /** `canDrop` walks the task tree, and a drag asks about the same card frame after
       *  frame. Nothing it reads changes while the gesture is on, so one answer per card
       *  crossed does. */
      const accepted = new Map<GraphNode, boolean>();
      const accepts = (target: GraphNode) => {
        const known = accepted.get(target);
        if (known !== undefined) return known;
        const answer = this.opts.nodeDrop?.canDrop(node, target) ?? false;
        accepted.set(target, answer);
        return answer;
      };
      const setDropTarget = (next: DropTarget | null) => {
        if (next?.node === dropTarget?.node && next?.zoneRight === dropTarget?.zoneRight) return;
        dropTarget?.node.card.classList.remove(DROP_TARGET_CLASS);
        next?.node.card.classList.add(DROP_TARGET_CLASS);
        this.paintDropZone(next?.zoneRight ?? null);
        dropTarget = next;
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
          el.classList.add("pm-graph-node--dragging");
        }
        node.position = { x: startPos.x + dx, y: startPos.y + dy };
        node.reposition();
        this.repositionEdges();
        setDropTarget(this.dropTargetFor(node, divide, accepts));
      };

      const onUp = (ue: PointerEvent) => {
        if (ue.pointerId !== pointerId) return;
        stop();
        if (dragging) {
          el.classList.remove("pm-graph-node--dragging");
          const target = dropTarget;
          setDropTarget(null);
          // A drop on another card is a move, not a placement: the card goes back and
          // the view is left to decide what the drop means.
          if (target) {
            restore();
            this.opts.nodeDrop?.onDrop(node, target.node);
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
        setDropTarget(null);
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

  /** A card's place in the container, `fit`'s offset applied. */
  renderedPosition(node: GraphNode): Point {
    return { x: node.position.x + this.pan.x, y: node.position.y + this.pan.y };
  }

  boundingBox(): BoundingBox {
    return nodesBoundingBox(this.nodes);
  }

  /**
   * Offsets the drawing so the graph sits `padding` from the container's top left, and
   * reports the room it needs. The caller decides what to do with those dimensions — a
   * section fixes only its height, the drilled-in graph both.
   */
  fit(padding: number): { width: number; height: number } {
    const bb = this.boundingBox();
    this.pan = { x: padding - bb.x1, y: padding - bb.y1 };
    const transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
    this.nodeLayer.style.transform = transform;
    this.edgeLayer.style.transform = transform;
    return { width: Math.ceil(bb.w) + padding * 2, height: Math.ceil(bb.h) + padding * 2 };
  }

  /** The cards standing for what the graph hangs off, in the order they were given. */
  contextNodes(): GraphNode[] {
    return this.nodes.filter((n) => n.isContext);
  }

  /** The cards the graph is about, rather than what it hangs off. */
  contentNodes(): GraphNode[] {
    return this.nodes.filter((n) => !n.isContext);
  }

  destroy(): void {
    for (const off of this.teardown) off();
    this.teardown = [];
    this.paintDropZone(null);
    for (const node of this.nodes) node.destroy();
    for (const edge of this.edges) edge.destroy();
    this.edgeLayer.remove();
    this.nodeLayer.remove();
  }
}
