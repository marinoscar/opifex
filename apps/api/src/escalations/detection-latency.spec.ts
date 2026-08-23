import { stats } from './detection-latency';

describe('detection-latency statistics', () => {
  it('reports nulls, not zeros, for an empty sample', () => {
    // Zero milliseconds is an excellent latency; "we measured nothing" is not
    // a latency at all. Rendering them the same shows a perfect dashboard for
    // a system that never detected anything.
    expect(stats([])).toEqual({
      count: 0,
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
      maxMs: null,
    });
  });

  it('reports a value that actually happened', () => {
    // Nearest-rank, not interpolated: the operator has to be able to go and
    // find the run behind the number.
    const samples = [1_000, 2_000, 3_000, 9_000];

    const result = stats(samples);

    for (const value of [
      result.p50Ms,
      result.p90Ms,
      result.p99Ms,
      result.maxMs,
    ]) {
      expect(samples).toContain(value);
    }
  });

  it('puts p50 at the median', () => {
    expect(stats([1, 2, 3, 4, 5]).p50Ms).toBe(3);
  });

  it('puts p90 near the slow tail', () => {
    const samples = Array.from({ length: 100 }, (_, i) => (i + 1) * 100);

    expect(stats(samples).p90Ms).toBe(9_000);
  });

  it('reports the true worst case', () => {
    // The tail is the interesting half: a p50 of two seconds with a max of
    // four hours is the failure this system exists to eliminate, still
    // happening.
    expect(stats([1_000, 2_000, 4 * 60 * 60_000]).maxMs).toBe(4 * 60 * 60_000);
  });

  it('handles a single sample without pretending to a distribution', () => {
    expect(stats([1_500])).toEqual({
      count: 1,
      p50Ms: 1_500,
      p90Ms: 1_500,
      p99Ms: 1_500,
      maxMs: 1_500,
    });
  });

  it('does not depend on the order it received them', () => {
    expect(stats([9_000, 1_000, 3_000, 2_000])).toEqual(
      stats([1_000, 2_000, 3_000, 9_000]),
    );
  });

  it("does not mutate the caller's array", () => {
    const samples = [3, 1, 2];

    stats(samples);

    expect(samples).toEqual([3, 1, 2]);
  });
});
