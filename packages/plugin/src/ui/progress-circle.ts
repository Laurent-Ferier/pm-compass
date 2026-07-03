const SVG_NS = "http://www.w3.org/2000/svg";

function setCircleAttrs(el: SVGCircleElement, cx: number, r: number, strokeWidth: number): void {
  el.setAttribute("cx", String(cx));
  el.setAttribute("cy", String(cx));
  el.setAttribute("r", String(r));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke-width", String(strokeWidth));
}

function createCircleBase(
  size: number,
  r: number,
  strokeWidth: number,
  svgClass: string,
  trackDim?: boolean,
): { svg: SVGSVGElement; cx: number; circ: number } {
  const cx = size / 2;
  const circ = 2 * Math.PI * r;
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.addClass(svgClass);

  const track = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
  setCircleAttrs(track, cx, r, strokeWidth);
  track.addClass("pm-dash-circle-track");
  if (trackDim) track.addClass("pm-dash-circle-track--dim");
  svg.appendChild(track);

  return { svg, cx, circ };
}

/** Appends an arc of length `ratio * circ` (no-op when `ratio <= 0`), rotated by
 *  `offsetFraction` of the full circle so a second arc can continue where the first ends. */
function addArc(
  svg: SVGSVGElement,
  cx: number,
  r: number,
  strokeWidth: number,
  circ: number,
  ratio: number,
  offsetFraction: number,
  decorate: (arc: SVGCircleElement) => void,
): void {
  if (ratio <= 0) return;
  const len = ratio * circ;
  const arc = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
  setCircleAttrs(arc, cx, r, strokeWidth);
  arc.setAttribute("stroke-dasharray", `${len} ${circ - len}`);
  arc.setAttribute("stroke-dashoffset", String(circ / 4));
  if (offsetFraction > 0) {
    arc.setAttribute("transform", `rotate(${offsetFraction * 360}, ${cx}, ${cx})`);
  }
  decorate(arc);
  svg.appendChild(arc);
}

function addLabel(svg: SVGSVGElement, cx: number, label: string): void {
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(cx));
  text.setAttribute("y", String(cx + 1));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "middle");
  text.addClass("pm-dash-circle-label");
  text.textContent = label;
  svg.appendChild(text);
}

export function buildProgressCircle(opts: {
  size: number;
  r: number;
  strokeWidth: number;
  ratio: number;
  svgClass: string;
  trackDim?: boolean;
  emptyFill?: boolean;
  label?: string;
}): SVGSVGElement {
  const { size, r, strokeWidth, ratio, svgClass, trackDim, emptyFill, label } = opts;
  const { svg, cx, circ } = createCircleBase(size, r, strokeWidth, svgClass, trackDim);

  if (ratio > 0) {
    addArc(svg, cx, r, strokeWidth, circ, ratio, 0, (arc) => arc.addClass("pm-dash-circle-fill"));
  } else if (emptyFill) {
    addArc(svg, cx, r, strokeWidth, circ, 1, 0, (arc) => {
      arc.addClass("pm-dash-circle-fill");
      arc.addClass("pm-dash-circle-fill--empty");
    });
  }

  if (label !== undefined) addLabel(svg, cx, label);
  return svg;
}

/** Circular progress with up to two colored arcs layered on a track.
 *  Arc 1 starts at the top; Arc 2 continues where Arc 1 ends.
 *  The remaining track represents the third (unlabelled) segment. */
export function buildTriColorCircle(opts: {
  size: number;
  r: number;
  strokeWidth: number;
  /** Fraction [0,1] for the first (green) arc. */
  ratio1: number;
  /** Fraction [0,1] for the second (orange) arc. */
  ratio2: number;
  trackDim?: boolean;
  label?: string;
}): SVGSVGElement {
  const { size, r, strokeWidth, ratio1, ratio2, trackDim, label } = opts;
  const { svg, cx, circ } = createCircleBase(size, r, strokeWidth, "pm-dash-circle-svg", trackDim);

  addArc(svg, cx, r, strokeWidth, circ, ratio1, 0, (arc) => arc.setAttribute("stroke", "#22c55e"));         // closed same day — green
  addArc(svg, cx, r, strokeWidth, circ, ratio2, ratio1, (arc) => arc.setAttribute("stroke", "#f97316"));    // closed late — orange

  if (label !== undefined) addLabel(svg, cx, label);
  return svg;
}
