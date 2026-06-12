import { describe, expect, it } from "vitest";

import { DONUT_RADIUS, donutSegments } from "./donut";

const CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

describe("donutSegments", () => {
  it("returns an empty array when every value is zero (UI shows the bare track)", () => {
    expect(
      donutSegments([
        { value: 0, color: "#a" },
        { value: 0, color: "#b" },
      ]),
    ).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(donutSegments([])).toEqual([]);
  });

  it("renders a single non-zero segment as a full circle", () => {
    const [seg, ...rest] = donutSegments([{ value: 7, color: "#44872E" }]);

    expect(rest).toHaveLength(0);
    expect(seg.dasharray).toBeCloseTo(CIRCUMFERENCE, 6);
    expect(seg.color).toBe("#44872E");
    // First segment starts at the top.
    expect(seg.dashoffset).toBeCloseTo(CIRCUMFERENCE * 0.25, 6);
  });

  it("makes the segment arc lengths sum to the circumference", () => {
    const segments = donutSegments([
      { value: 3, color: "#a" },
      { value: 2, color: "#b" },
      { value: 5, color: "#c" },
    ]);
    const total = segments.reduce((sum, s) => sum + s.dasharray, 0);

    expect(total).toBeCloseTo(CIRCUMFERENCE, 6);
  });

  it("sizes each arc proportionally to its value", () => {
    const segments = donutSegments([
      { value: 1, color: "#a" }, // 1/4
      { value: 3, color: "#b" }, // 3/4
    ]);

    expect(segments[0].dasharray).toBeCloseTo(CIRCUMFERENCE * 0.25, 6);
    expect(segments[1].dasharray).toBeCloseTo(CIRCUMFERENCE * 0.75, 6);
  });

  it("accumulates offsets so each segment begins where the previous ended", () => {
    const segments = donutSegments([
      { value: 1, color: "#a" },
      { value: 1, color: "#b" },
      { value: 2, color: "#c" },
    ]);

    // offset(n) = circumference/4 − (arc lengths drawn before n)
    expect(segments[0].dashoffset).toBeCloseTo(CIRCUMFERENCE * 0.25, 6);
    expect(segments[1].dashoffset).toBeCloseTo(CIRCUMFERENCE * 0.25 - segments[0].dasharray, 6);
    expect(segments[2].dashoffset).toBeCloseTo(CIRCUMFERENCE * 0.25 - segments[0].dasharray - segments[1].dasharray, 6);
  });

  it("skips zero-value slices but keeps the order of the non-zero ones", () => {
    const segments = donutSegments([
      { value: 2, color: "#first" },
      { value: 0, color: "#skipped" },
      { value: 2, color: "#second" },
    ]);

    expect(segments.map((s) => s.color)).toEqual(["#first", "#second"]);
    // The kept segments still tile the whole circle (no gap left by the skip).
    expect(segments.reduce((sum, s) => sum + s.dasharray, 0)).toBeCloseTo(CIRCUMFERENCE, 6);
  });

  it("honors a custom radius", () => {
    const r = 40;
    const [seg] = donutSegments([{ value: 1, color: "#a" }], r);

    expect(seg.dasharray).toBeCloseTo(2 * Math.PI * r, 6);
  });
});
