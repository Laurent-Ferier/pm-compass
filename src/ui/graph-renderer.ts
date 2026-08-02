/** Drawing the task graph: absolutely positioned cards over an SVG of dependency edges.
 *  Placement comes from `layoutGraph`; this holds the DOM, the viewport offset and the
 *  pointer gestures — tap, double tap, and dragging a card to a position of its own. */
import { layoutGraph, type LayoutSpacing } from "./graph-layout";
import { GraphNode, nodesBoundingBox, type BoundingBox, type Point } from "./graph-node";
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
      // Only the finger that started the gesture drives it: a second one scrolling the
      // page would otherwise drag the card out from under the first.
      const pointerId = e.pointerId;
      let dragging = false;

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
      };

      const onUp = (ue: PointerEvent) => {
        if (ue.pointerId !== pointerId) return;
        stop();
        if (dragging) {
          el.classList.remove("pm-graph-node--dragging");
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
        if (!dragging) return;
        el.classList.remove("pm-graph-node--dragging");
        node.position = startPos;
        node.reposition();
        this.repositionEdges();
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
    for (const node of this.nodes) node.destroy();
    for (const edge of this.edges) edge.destroy();
    this.edgeLayer.remove();
    this.nodeLayer.remove();
  }
}
