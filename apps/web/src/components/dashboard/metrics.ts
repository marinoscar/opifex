/**
 * The six success metrics — what they are called, what they mean, and how a
 * number turns into a string.
 *
 * Epic #19, VISION §10, which opens: "Six metrics. The web application exists
 * primarily to show them." That sentence is why this is a data module rather
 * than six blocks of JSX: the definitions are the product, and they are worth
 * being able to test, iterate on, and read in one place without a browser.
 *
 * ## `definition`, `help` and `target` are quoted VERBATIM from VISION §10
 *
 * Not paraphrased, not "improved". Two reasons:
 *
 *  1. An operator who reads "Direct measure of recovered productivity" on a
 *     tile can find that exact sentence in the vision document, and knows the
 *     tile and the plan are talking about the same thing. A paraphrase quietly
 *     becomes a second definition, and then the metric means two things.
 *  2. It makes drift VISIBLE: if VISION §10 is edited, the diff here is a
 *     one-line change in a data file rather than an archaeology exercise
 *     across components.
 *
 * The split between the three fields mirrors the table's own columns:
 * `definition` is the qualifier attached to the metric's name ("stop →
 * notified"), `help` is the entire "Why" cell, and `target` is the target
 * sentence — which VISION states for exactly one of the six, so the field is
 * optional and is NOT invented for the other five.
 *
 * ## Why the definitions render even with no data
 *
 * This is point 2 of the honesty contract in
 * `components/common/NotWiredState.tsx`: an unwired tile still shows its name
 * and its meaning. A tile that teaches what will be measured is doing the
 * app's stated job — showing the six metrics — even before anything computes
 * them. Only the NUMBER is missing, and a missing number reads `—`.
 */

import type { MetricId } from '../../types/cockpit';
import { METRIC_IDS } from '../../types/cockpit';

/**
 * The dimension a metric is measured in. Drives the `format` below and, more
 * importantly, tells the reader what kind of thing the bare number is before
 * they have learned the metric.
 */
export type MetricUnit = 'seconds' | 'hours' | 'ratio' | 'count' | 'usd';

/**
 * Which way is good.
 *
 * Load-bearing for the sparkline's spoken description: "rising" is meaningless
 * on its own, and a screen reader user hearing "trend rising" about detection
 * latency should be hearing that things got WORSE. `Sparkline`'s accessible
 * name is built from this, which is the actual deliverable of the chart.
 */
export type MetricDirection = 'lower-is-better' | 'higher-is-better';

export interface MetricDefinition {
  id: MetricId;
  /** Metric name, from VISION §10's table. */
  label: string;
  /** The qualifier VISION attaches to the name. Verbatim. */
  definition: string;
  /** VISION §10's entire "Why" cell. Verbatim. */
  help: string;
  unit: MetricUnit;
  /**
   * Renders a value for display. Never called with `null` — an absent value is
   * `—`, decided by `MetricTile`, so no formatter needs a "no data" branch and
   * none can accidentally format `null` as `0`.
   */
  format: (value: number) => string;
  direction: MetricDirection;
  /** VISION states a target for exactly one metric. Absent is correct. */
  target?: string;
}

/**
 * `45` -> `45s`, `330` -> `5m 30s`, `7200` -> `2h 0m`.
 *
 * Compound rather than decimal (`5.5m`) because the target is "seconds"
 * (VISION §10) and a decimal minute hides the unit that matters most.
 */
function formatSeconds(value: number): string {
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) {
    const minutes = Math.floor(value / 60);
    return `${minutes}m ${Math.round(value % 60)}s`;
  }
  const hours = Math.floor(value / 3600);
  return `${hours}h ${Math.floor((value % 3600) / 60)}m`;
}

/** A fraction in 0..1 as whole percent. The API sends `0.82`, not `82`. */
function formatRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export const METRIC_DEFINITIONS: Record<MetricId, MetricDefinition> = {
  detectionLatency: {
    id: 'detectionLatency',
    label: 'Detection latency',
    definition: 'stop → notified',
    help: 'The original complaint, quantified.',
    unit: 'seconds',
    format: formatSeconds,
    direction: 'lower-is-better',
    // The only target VISION §10 states. Quoted, including the word "Target",
    // so the tile cannot be read as promising a number the document does not.
    target: 'Target: seconds.',
  },
  deadTimePerDay: {
    id: 'deadTimePerDay',
    label: 'Dead time per day',
    definition: 'hours parked or stalled',
    help: 'Direct measure of recovered productivity',
    unit: 'hours',
    // One decimal: this is a comparison-over-days number, and minutes of
    // precision on a daily total is noise pretending to be signal.
    format: (value) => `${value.toFixed(1)} h`,
    direction: 'lower-is-better',
  },
  firstPassAcceptance: {
    id: 'firstPassAcceptance',
    label: 'First-pass acceptance rate',
    definition: 'PRs merged without rework',
    help: 'Spec quality',
    unit: 'ratio',
    format: formatRatio,
    // The ONLY higher-is-better metric of the six, and by VISION §10 the one
    // that decides the roadmap: "If first-pass acceptance is low, adding
    // throughput actively makes life worse."
    direction: 'higher-is-better',
  },
  attemptsPerWorkOrder: {
    id: 'attemptsPerWorkOrder',
    label: 'Attempts per work order',
    definition: 'runs before a work order lands',
    help: 'Decomposition quality',
    unit: 'count',
    format: (value) => value.toFixed(1),
    direction: 'lower-is-better',
  },
  costPerMergedPr: {
    id: 'costPerMergedPr',
    label: 'Cost per merged PR',
    definition: 'spend divided by merges',
    help: 'Economic viability',
    unit: 'usd',
    // Cents matter: the interesting movement in this number is between $2 and
    // $20, and rounding to dollars would flatten most of it.
    format: (value) =>
      value.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    direction: 'lower-is-better',
  },
  quotaBurn: {
    id: 'quotaBurn',
    label: 'Quota burn vs. reset window',
    definition: 'share of the window already spent',
    help: 'Scheduling health',
    unit: 'ratio',
    format: formatRatio,
    // Lower is better, and it can legitimately exceed 100%: burning the window
    // faster than it resets is precisely the condition this metric exists to
    // catch (VISION §11, shared quota).
    direction: 'lower-is-better',
  },
};

/**
 * The definitions in VISION §10's table order, which is also cockpit display
 * order. Derived from `METRIC_IDS` rather than re-listed, so the order lives in
 * exactly one place and a new metric cannot be added to one list only.
 */
export const METRIC_LIST: readonly MetricDefinition[] = METRIC_IDS.map(
  (id) => METRIC_DEFINITIONS[id],
);
