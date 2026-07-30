// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { buildProgressCircle, buildTriColorCircle } from "./progress-circle";

beforeAll(() => {
  const svgProto = SVGElement.prototype as any;
  svgProto.addClass = function (this: SVGElement, cls: string) {
    this.classList.add(cls);
  };
  (window as any).activeDocument = document;
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
