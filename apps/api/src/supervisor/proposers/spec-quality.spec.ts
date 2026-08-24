import type {
  SnapshotRun,
  SnapshotWorkOrder,
} from '../snapshot/snapshot.types';
import {
  MIN_RUNS_FOR_SIGNAL,
  correlateSpecQuality,
  formatRate,
  underSpecifiedQueue,
} from './spec-quality';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function run(
  acceptanceCriteriaCount: number,
  pullRequestState: string | null,
  id = 'r',
): SnapshotRun {
  return {
    id,
    workOrderIdentity: `wo_${id}`,
    repository: 'marinoscar/opifex',
    issueNumber: 1,
    issueTitle: null,
    status: 'succeeded',
    runnerKey: 'claude-code-local',
    startedAt: NOW,
    endedAt: NOW,
    lastEventAt: NOW,
    attemptCount: 1,
    costUsd: null,
    attentionReason: null,
    stopReason: null,
    pullRequestNumber: 1,
    pullRequestState,
    acceptanceCriteriaCount,
  };
}

function order(acceptanceCriteriaCount: number): SnapshotWorkOrder {
  return {
    identity: `wo-${acceptanceCriteriaCount}`,
    repository: 'marinoscar/opifex',
    issueNumber: 1,
    issueTitle: null,
    status: 'queued',
    attempt: 1,
    acceptanceCriteriaCount,
    createdAt: NOW,
  };
}

describe('correlateSpecQuality (#111)', () => {
  it('buckets runs into three bands', () => {
    const finding = correlateSpecQuality([
      run(1, 'merged'),
      run(3, 'merged'),
      run(9, null),
    ]);

    expect(finding.buckets.map((b) => b.runs)).toEqual([1, 1, 1]);
  });

  it('counts MERGED, not succeeded', () => {
    // Metric 3 counts merges, and #215 keeps closed-unmerged distinct so a
    // withdrawn pull request does not flatter first-pass acceptance.
    const finding = correlateSpecQuality([
      run(3, 'merged', 'a'),
      run(3, 'closed', 'b'),
      run(3, null, 'c'),
    ]);

    const band = finding.buckets[1];
    expect(band.runs).toBe(3);
    expect(band.merged).toBe(1);
    expect(band.firstPassRate).toBeCloseTo(1 / 3);
  });

  it('reports null, never 0, for a band with no runs', () => {
    const finding = correlateSpecQuality([]);

    for (const bucket of finding.buckets) {
      expect(bucket.runs).toBe(0);
      // 0% would say everything in the band failed. Nothing is in it.
      expect(bucket.firstPassRate).toBeNull();
    }
  });

  it('finds no signal from a single band, however many runs', () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      run(3, 'merged', `r${i}`),
    );

    expect(correlateSpecQuality(runs).hasSignal).toBe(false);
  });

  it('finds no signal below the minimum run count', () => {
    const runs = [run(1, null, 'a'), run(1, null, 'b'), run(9, 'merged', 'c')];

    // The 5+ band has one run. A rate from one run is arithmetic, not
    // evidence.
    expect(correlateSpecQuality(runs).hasSignal).toBe(false);
    expect(MIN_RUNS_FOR_SIGNAL).toBeGreaterThan(1);
  });

  it('finds a signal when two comparable bands differ', () => {
    const thin = Array.from({ length: 3 }, (_, i) => run(1, null, `t${i}`));
    const thick = Array.from({ length: 3 }, (_, i) =>
      run(6, 'merged', `k${i}`),
    );

    const finding = correlateSpecQuality([...thin, ...thick]);

    expect(finding.hasSignal).toBe(true);
    expect(finding.comparable).toHaveLength(2);
  });

  it('finds no signal when two comparable bands perform identically', () => {
    // Worth reporting as a finding elsewhere, but there is no difference to
    // advise about.
    const a = Array.from({ length: 3 }, (_, i) => run(1, 'merged', `a${i}`));
    const b = Array.from({ length: 3 }, (_, i) => run(6, 'merged', `b${i}`));

    expect(correlateSpecQuality([...a, ...b]).hasSignal).toBe(false);
  });

  it('puts a very large criteria count in the top band', () => {
    const finding = correlateSpecQuality([run(50, 'merged')]);
    expect(finding.buckets[2].runs).toBe(1);
  });

  it('is deterministic', () => {
    const runs = [run(1, 'merged', 'a'), run(4, null, 'b')];
    expect(correlateSpecQuality(runs)).toEqual(correlateSpecQuality(runs));
  });
});

describe('underSpecifiedQueue', () => {
  it('flags queued orders at or below the lowest band', () => {
    expect(underSpecifiedQueue([order(0), order(1), order(2)])).toHaveLength(2);
  });

  it('leaves a well-specified order alone', () => {
    expect(underSpecifiedQueue([order(5)])).toEqual([]);
  });
});

describe('formatRate', () => {
  it('renders an em dash for no evidence, never 0%', () => {
    expect(formatRate(null)).toBe('—');
  });

  it('renders a real zero as 0%', () => {
    expect(formatRate(0)).toBe('0%');
  });

  it('rounds to whole percent', () => {
    expect(formatRate(1 / 3)).toBe('33%');
  });
});
