/**
 * Percentiles over a detection-latency sample.
 *
 * Computed in process rather than in SQL. VISION §11 designs for a single
 * operator with a handful of concurrent runs, so the sample is thousands of
 * rows at most and a `percentile_cont` would buy nothing but a
 * Postgres-shaped query nobody can unit test. The cap below is what keeps
 * that assumption from quietly becoming wrong.
 */
export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

/**
 * The most rows one summary will read.
 *
 * If a window ever exceeds this, the summary says so rather than silently
 * describing a subset — a truncation nobody reports reads as "this is what
 * happened", which is the same class of lie as measuring stop-to-detected.
 */
export const MAX_SAMPLES = 10_000;

export function stats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    // Nulls rather than zeros. Zero milliseconds is an excellent latency and
    // "we measured nothing" is not a latency at all; rendering them the same
    // would show a perfect dashboard for a system that never detected
    // anything.
    return { count: 0, p50Ms: null, p90Ms: null, p99Ms: null, maxMs: null };
  }

  const sorted = [...samples].sort((a, b) => a - b);

  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
  };
}

/**
 * Nearest-rank, not interpolated.
 *
 * Every value reported is one that actually happened. An interpolated p90 of
 * 4.3 seconds for a sample where no detection took between 3 and 9 seconds
 * describes an event that never occurred, and the whole point of this metric
 * is that an operator can go and find the run behind the number.
 */
function percentile(sorted: number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}
