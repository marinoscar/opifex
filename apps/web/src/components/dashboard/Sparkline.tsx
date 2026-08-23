/**
 * A trend line, in about forty lines of SVG and no new dependency.
 *
 * Epic #19.
 *
 * ## Why not `@mui/x-charts`
 *
 * Six 100x32 trend lines do not justify ~150–200 KB. `@mui/x-charts` pulls
 * `d3-scale` and `d3-shape` plus its own theming layer, and the
 * same-vendor-as-the-DataGrid argument actually points the other way: MUI X
 * packages must move in lockstep, and `@mui/x-data-grid` is load-bearing
 * across ~45 tested files here. Adding a second package to that version pin
 * turns every MUI X bump into a two-front migration for the sake of a
 * decoration. And there is, today, no data to draw.
 *
 * ## The documented revisit trigger — this is not "never use a chart library"
 *
 * Add `@mui/x-charts`, pinned to the same major as `@mui/x-data-grid`, the day
 * the cockpit needs any ONE of:
 *
 *   - axes with ticks and labels,
 *   - hover tooltips or a crosshair,
 *   - brushing / zooming a time range,
 *   - stacked or multi-series plots,
 *   - a real time scale (irregularly spaced samples, gaps that must show as
 *     gaps rather than as straight lines).
 *
 * The moment any of those is on a ticket, this component stops being a
 * cheaper option and starts being a worse one. Delete it then; do not grow it.
 *
 * ## The accessible name is the deliverable; the drawing is decoration
 *
 * A 100x32 line has no axis, no scale and no labels — sighted or not, nobody
 * can read a VALUE off it. What it communicates is a direction, so that is
 * what the `aria-label` says, in words ("Detection latency trend: rising over
 * the last 12 samples — worse"). The polyline is `role="img"` with that name
 * and nothing else exposed.
 *
 * ## Fewer than two points renders NOTHING
 *
 * The single most important line in this file. With one point (or none) a
 * polyline degenerates into a flat horizontal stroke, and a flat line is not a
 * neutral drawing — it reads as "stable", which is a measurement. Claiming
 * stability when the truth is "we have one sample" is exactly the fabrication
 * the honesty contract (see `components/common/NotWiredState.tsx`) forbids.
 * So: `null`, and the tile shows nothing where the chart would be.
 */

import { Box } from '@mui/material';

/** The direction a series moved, first sample to last. */
export type TrendDirection = 'rising' | 'falling' | 'flat';

/**
 * Below this relative change, a series is reported `flat`.
 *
 * 1% of the span of the series. An absolute epsilon cannot work across metrics
 * whose units range from a ratio (0..1) to a cost in dollars, and calling a
 * 0.3% wobble "rising" trains the operator to ignore the word.
 */
const FLAT_THRESHOLD = 0.01;

/**
 * Classify a series by comparing its last sample to its first.
 *
 * First-to-last, deliberately, rather than a fitted slope: this is a
 * four-word summary for a screen reader, and "where did it end up compared to
 * where it started" is the question a glance at a sparkline answers. A
 * regression line would be more defensible statistically and less faithful to
 * the picture beside it.
 */
export function summarizeTrend(values: readonly number[]): TrendDirection {
  if (values.length < 2) return 'flat';

  const first = values[0];
  const last = values[values.length - 1];
  const span = Math.max(...values) - Math.min(...values);
  // A series with no span at all is genuinely flat; otherwise scale the
  // threshold to the series' own range so it works for ratios and dollars
  // alike.
  if (span === 0) return 'flat';
  if (Math.abs(last - first) < span * FLAT_THRESHOLD) return 'flat';

  return last > first ? 'rising' : 'falling';
}

export interface SparklineProps {
  /** The series, oldest first. Fewer than two points renders nothing. */
  values: readonly number[];
  /** CSS width in px. The geometry is viewBox-based and does not depend on it. */
  width?: number;
  /** CSS height in px. */
  height?: number;
  /**
   * The accessible name, stating the trend IN WORDS. Required, and there is no
   * default: a caller who has not decided what the line means cannot draw it.
   */
  ariaLabel: string;
}

/**
 * The internal coordinate space. All geometry is computed against this and the
 * SVG is stretched to the requested CSS size with
 * `preserveAspectRatio="none"`, so the component has no layout maths at all.
 */
const VIEWBOX_WIDTH = 100;
const VIEWBOX_HEIGHT = 32;
/** Keeps the stroke and the end dot from being clipped at the extremes. */
const VERTICAL_PADDING = 3;

export function Sparkline({
  values,
  width = 100,
  height = 32,
  ariaLabel,
}: SparklineProps) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  const usableHeight = VIEWBOX_HEIGHT - VERTICAL_PADDING * 2;

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * VIEWBOX_WIDTH;
    // A genuinely constant series (span 0) is drawn down the middle. Unlike the
    // one-point case this IS a real reading — "it did not move" — so it draws.
    const normalized = span === 0 ? 0.5 : (value - min) / span;
    // SVG y grows downward; the series must not be drawn upside down.
    const y = VIEWBOX_HEIGHT - VERTICAL_PADDING - normalized * usableHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const [lastX, lastY] = points[points.length - 1].split(',');

  return (
    <Box
      component="svg"
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      // Non-uniform stretch: the x axis is "samples" and the y axis is the
      // metric's own unit, so there is no aspect ratio worth preserving —
      // and `vector-effect` below keeps the stroke from stretching with it.
      preserveAspectRatio="none"
      sx={{ width, height, display: 'block', overflow: 'visible' }}
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        // `currentColor`, so the line inherits whatever the tile has decided
        // about emphasis and so it inverts with the theme for free — same rule
        // as the brand marks. No hex may appear in this file.
        stroke="currentColor"
        strokeWidth={1.5}
        // Without this the non-uniform scale above would render a stroke that
        // is visibly thicker vertically than horizontally.
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The end dot answers "which end is now?", which a bare line cannot. */}
      <circle
        cx={lastX}
        cy={lastY}
        r={2}
        fill="currentColor"
        vectorEffect="non-scaling-stroke"
      />
    </Box>
  );
}

export default Sparkline;
