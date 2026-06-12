// Pure geometry for the dashboard donut/ring widgets (design §4.2 "SentimentRing").
// Both rings (topics + sentiment) render as a stack of stroked <circle> arcs;
// this module computes each arc's length (stroke-dasharray) and rotation
// (stroke-dashoffset) so the .astro component stays a thin SVG template.
//
// Convention: the SVG circle stroke begins at 3 o'clock and runs clockwise.
// A POSITIVE stroke-dashoffset shifts the dash pattern counter-clockwise, so
// `offset = circumference / 4` moves the first arc's start to 12 o'clock
// ("start od góry"). Each later segment subtracts the arc length already drawn,
// so it begins exactly where the previous one ended.

export interface DonutSegment {
  color: string;
  /** Arc length of this segment = (value / total) × circumference. */
  dasharray: number;
  /** stroke-dashoffset positioning the arc; starts at circumference/4 (top). */
  dashoffset: number;
}

export interface DonutValue {
  value: number;
  color: string;
}

/** Default ring radius (design §4.2: viewBox 0 0 128 128, cx=cy=64, r=54). */
export const DONUT_RADIUS = 54;

/**
 * Maps a list of (value, color) slices to SVG ring segments. Zero-value slices
 * are dropped (no zero-length arc to render); when every value is zero the
 * result is empty and the component shows only the `#E8E8E8` track + "brak danych".
 */
export function donutSegments(values: DonutValue[], r: number = DONUT_RADIUS): DonutSegment[] {
  const circumference = 2 * Math.PI * r;
  const total = values.reduce((sum, v) => sum + v.value, 0);
  if (total === 0) return [];

  const segments: DonutSegment[] = [];
  let drawn = 0; // arc length consumed by earlier segments
  for (const { value, color } of values) {
    if (value === 0) continue;
    const dasharray = (value / total) * circumference;
    segments.push({
      color,
      dasharray,
      dashoffset: circumference * 0.25 - drawn,
    });
    drawn += dasharray;
  }
  return segments;
}
