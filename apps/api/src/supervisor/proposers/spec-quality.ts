import type {
  SnapshotRun,
  SnapshotWorkOrder,
} from '../snapshot/snapshot.types';

/**
 * Correlating specification shape with outcome (#111).
 *
 * VISION §10's roadmap rule: *"if metric 3 is low, fix specification quality
 * before scaling"*, and *"throughput ceiling is spec quality, not token
 * budget"*. This is the arithmetic behind that advice — deliberately
 * deterministic, so the FINDING is a fact and only the narration around it is
 * judgement.
 *
 * ## Why the correlation is not asked of the model
 *
 * A model handed a snapshot and asked "which issue shapes worked" will produce
 * a confident answer whether or not the data supports one, and #90's approval
 * rate cannot distinguish a plausible narrative from a true one. Computing the
 * buckets here means a reviewer is judging what to DO about a measured
 * difference, which is the actual judgement work, rather than whether the
 * difference exists.
 */

/** One band of specification detail, and how its runs turned out. */
export interface SpecQualityBucket {
  /** Inclusive lower bound on acceptance-criteria count. */
  from: number;
  /** Inclusive upper bound, or null for "and above". */
  to: number | null;
  label: string;
  /** Runs in this band that concluded inside the window. */
  runs: number;
  /** Of those, how many opened a pull request that merged. */
  merged: number;
  /**
   * `merged / runs`, or null when the band has no runs.
   *
   * Null rather than 0, the same rule `metrics.dto.ts` states for the six
   * success metrics: an empty band has no evidence, and 0% says the opposite —
   * that everything in it failed.
   */
  firstPassRate: number | null;
}

/**
 * The bands.
 *
 * Three, not ten. The question is whether more specification correlates with
 * acceptance, and a band with two runs in it answers nothing — narrow bands
 * would produce a table full of nulls that reads as a finding.
 */
const BANDS: readonly { from: number; to: number | null; label: string }[] = [
  { from: 0, to: 1, label: '0–1 acceptance criteria' },
  { from: 2, to: 4, label: '2–4 acceptance criteria' },
  { from: 5, to: null, label: '5 or more acceptance criteria' },
];

/**
 * How many runs a band needs before its rate is worth reporting.
 *
 * Below this the rate is arithmetic, not evidence. Reporting it anyway is how
 * a dashboard ends up asserting that one-criterion issues fail 100% of the
 * time on the strength of a single run.
 */
export const MIN_RUNS_FOR_SIGNAL = 3;

export interface SpecQualityFinding {
  buckets: SpecQualityBucket[];
  /**
   * Whether any two bands with enough runs actually differ.
   *
   * The gate on saying anything at all. #111's value is telling an operator
   * which issue shapes work; a report that every band performs the same is
   * worth writing, and a report from data too thin to tell is not.
   */
  hasSignal: boolean;
  /** The bands that met the minimum. Empty when nothing did. */
  comparable: SpecQualityBucket[];
}

/** Bucket concluded runs by how specified their work order was. */
export function correlateSpecQuality(
  runs: readonly SnapshotRun[],
): SpecQualityFinding {
  const buckets: SpecQualityBucket[] = BANDS.map((band) => ({
    ...band,
    runs: 0,
    merged: 0,
    firstPassRate: null,
  }));

  for (const run of runs) {
    const bucket = buckets.find(
      (b) =>
        run.acceptanceCriteriaCount >= b.from &&
        (b.to === null || run.acceptanceCriteriaCount <= b.to),
    );
    if (!bucket) continue;

    bucket.runs += 1;
    // MERGED, not "succeeded". Success metric 3 counts merges, and #215 keeps
    // closed-unmerged distinct precisely so a withdrawn pull request does not
    // flatter first-pass acceptance.
    if (run.pullRequestState === 'merged') bucket.merged += 1;
  }

  for (const bucket of buckets) {
    bucket.firstPassRate =
      bucket.runs === 0 ? null : bucket.merged / bucket.runs;
  }

  const comparable = buckets.filter((b) => b.runs >= MIN_RUNS_FOR_SIGNAL);
  const rates = comparable.map((b) => b.firstPassRate ?? 0);
  const hasSignal =
    comparable.length >= 2 && Math.max(...rates) - Math.min(...rates) > 0;

  return { buckets, hasSignal, comparable };
}

/**
 * Queued work orders whose specification looks thin, flagged BEFORE dispatch.
 *
 * #111's third criterion, and the reason it is worth stating: the same
 * observation after a failure is a post-mortem, and the same observation
 * before dispatch is the only version that saves anything.
 *
 * The threshold is the lowest band's ceiling — the deterministic gate (#62)
 * already rejects zero criteria outright, so what this catches is the issue
 * that cleared the floor and is still thin.
 */
export function underSpecifiedQueue(
  orders: readonly SnapshotWorkOrder[],
): SnapshotWorkOrder[] {
  return orders.filter(
    (order) => order.acceptanceCriteriaCount <= BANDS[0].to!,
  );
}

/** `73%`, or `—` when there is no evidence. Never `0%` for "unmeasured". */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}
