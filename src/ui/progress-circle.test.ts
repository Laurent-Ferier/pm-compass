// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { buildProgressCircle, buildTriColorCircle } from "./progress-circle";
import { bagOf } from "./__testing__/dom-bag";

beforeAll(() => {
  bagOf(SVGElement.prototype).addClass = function (this: SVGElement, cls: string) {
    this.classList.add(cls);
  };
  bagOf(window).activeDocument = document;
});

describe("buildProgressCircle", () => {
  it("adds a fill arc when ratio > 0", () => {
    const svg = buildProgressCircle({ size: 40, r: 16, strokeWidth: 4, ratio: 0.5, svgClass: "test" });
    const fill = svg.querySelector(".pm-dash-circle-fill");
    expect(fill).not.toBeNull();
  });

  it("adds no arc when ratio <= 0 and emptyFill is not set", () => {
    const svg = buildProgressCircle({ size: 40, r: 16, strokeWidth: 4, ratio: 0, svgClass: "test" });
    expect(svg.querySelector(".pm-dash-circle-fill")).toBeNull();
  });

  it("adds a dimmed empty-fill arc when ratio <= 0 and emptyFill is set", () => {
    const svg = buildProgressCircle({
      size: 40, r: 16, strokeWidth: 4, ratio: 0, svgClass: "test", emptyFill: true,
    });
    const fill = svg.querySelector(".pm-dash-circle-fill--empty");
    expect(fill).not.toBeNull();
  });

  it("dims the track when trackDim is set", () => {
    const svg = buildProgressCircle({
      size: 40, r: 16, strokeWidth: 4, ratio: 0.5, svgClass: "test", trackDim: true,
    });
    expect(svg.querySelector(".pm-dash-circle-track--dim")).not.toBeNull();
  });

  it("does not dim the track when trackDim is unset", () => {
    const svg = buildProgressCircle({ size: 40, r: 16, strokeWidth: 4, ratio: 0.5, svgClass: "test" });
    expect(svg.querySelector(".pm-dash-circle-track--dim")).toBeNull();
  });

  it("adds a label when given", () => {
    const svg = buildProgressCircle({ size: 40, r: 16, strokeWidth: 4, ratio: 0.5, svgClass: "test", label: "50%" });
    const label = svg.querySelector(".pm-dash-circle-label");
    expect(label?.textContent).toBe("50%");
  });

  it("omits the label when not given", () => {
    const svg = buildProgressCircle({ size: 40, r: 16, strokeWidth: 4, ratio: 0.5, svgClass: "test" });
    expect(svg.querySelector(".pm-dash-circle-label")).toBeNull();
  });

  it("renders an empty label", () => {
    const svg = buildProgressCircle({ size: 40, r: 16, strokeWidth: 4, ratio: 0.5, svgClass: "test", label: "" });
    expect(svg.querySelector(".pm-dash-circle-label")).not.toBeNull();
  });
});

describe("buildTriColorCircle", () => {
  it("renders both arcs with the second offset to continue after the first", () => {
    const svg = buildTriColorCircle({ size: 40, r: 16, strokeWidth: 4, ratio1: 0.3, ratio2: 0.3 });
    const circles = svg.querySelectorAll("circle");
    // track + arc1 + arc2
    expect(circles).toHaveLength(3);
    const arc2 = circles[2];
    expect(arc2.getAttribute("transform")).toContain("rotate(108");
    expect(arc2.getAttribute("stroke")).toBe("#f97316");
  });

  it("omits the second arc when ratio2 is 0", () => {
    const svg = buildTriColorCircle({ size: 40, r: 16, strokeWidth: 4, ratio1: 0.3, ratio2: 0 });
    const circles = svg.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
  });

  it("omits both arcs when both ratios are 0", () => {
    const svg = buildTriColorCircle({ size: 40, r: 16, strokeWidth: 4, ratio1: 0, ratio2: 0 });
    const circles = svg.querySelectorAll("circle");
    expect(circles).toHaveLength(1);
  });

  it("does not rotate the first arc (offsetFraction 0)", () => {
    const svg = buildTriColorCircle({ size: 40, r: 16, strokeWidth: 4, ratio1: 0.3, ratio2: 0 });
    const arc1 = svg.querySelectorAll("circle")[1];
    expect(arc1.getAttribute("transform")).toBeNull();
  });

  it("adds a label when given", () => {
    const svg = buildTriColorCircle({ size: 40, r: 16, strokeWidth: 4, ratio1: 0.3, ratio2: 0.3, label: "3/10" });
    expect(svg.querySelector(".pm-dash-circle-label")?.textContent).toBe("3/10");
  });
});

describe("buildProgressCircle — dimensions and classes", () => {
  it("creates an SVG element with the requested dimensions", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "pm-dash-circle-svg" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("width")).toBe("56");
    expect(svg.getAttribute("height")).toBe("56");
    expect(svg.getAttribute("viewBox")).toBe("0 0 56 56");
  });

  it("adds the requested CSS class to the svg element", () => {
    const svg = buildProgressCircle({ size: 28, r: 11, strokeWidth: 3, ratio: 0.8, svgClass: "pm-dash-item-circle" });
    expect(svg.classList.contains("pm-dash-item-circle")).toBe(true);
  });

  it("always renders a track circle", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg" });
    const circles = svg.querySelectorAll("circle");
    expect(circles.length).toBeGreaterThanOrEqual(1);
    expect(circles[0].classList.contains("pm-dash-circle-track")).toBe(true);
  });

  it("renders a fill circle when ratio > 0", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "my-svg" });
    const fill = svg.querySelector(".pm-dash-circle-fill");
    expect(fill).not.toBeNull();
    expect(fill?.classList.contains("pm-dash-circle-fill--empty")).toBe(false);
  });

  it("does not render a fill circle when ratio is 0 and emptyFill is false", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", emptyFill: false });
    expect(svg.querySelector(".pm-dash-circle-fill")).toBeNull();
  });

  it("renders an empty-fill circle when ratio is 0 and emptyFill is true", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", emptyFill: true });
    const fill = svg.querySelector(".pm-dash-circle-fill");
    expect(fill).not.toBeNull();
    expect(fill?.classList.contains("pm-dash-circle-fill--empty")).toBe(true);
  });

  it("renders a label text element when label is provided", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "my-svg", label: "3/5" });
    const text = svg.querySelector("text");
    expect(text).not.toBeNull();
    expect(text?.textContent).toBe("3/5");
    expect(text?.classList.contains("pm-dash-circle-label")).toBe(true);
  });

  it("does not render a label when label is not provided", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0.5, svgClass: "my-svg" });
    expect(svg.querySelector("text")).toBeNull();
  });

  it("adds the dim class to the track when trackDim is true", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", trackDim: true });
    expect(svg.querySelector(".pm-dash-circle-track--dim")).not.toBeNull();
  });

  it("does not add the dim class when trackDim is false", () => {
    const svg = buildProgressCircle({ size: 56, r: 20, strokeWidth: 4, ratio: 0, svgClass: "my-svg", trackDim: false });
    expect(svg.querySelector(".pm-dash-circle-track--dim")).toBeNull();
  });
});
