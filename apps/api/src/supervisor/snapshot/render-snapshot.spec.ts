import { age, clip, renderSnapshot } from './render-snapshot';
import {
  DEFAULT_SNAPSHOT_LIMITS,
  type SnapshotInput,
  type SnapshotRun,
  type SnapshotWorkOrder,
} from './snapshot.types';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function run(overrides: Partial<SnapshotRun> = {}): SnapshotRun {
  return {
    id: 'run-1',
    workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
    repository: 'marinoscar/opifex',
    issueNumber: 312,
    issueTitle: 'Add the thing',
    status: 'stalled',
    runnerKey: 'claude-code-local',
    startedAt: new Date('2026-08-24T10:00:00.000Z'),
    endedAt: null,
    lastEventAt: new Date('2026-08-24T11:30:00.000Z'),
    attemptCount: 1,
    costUsd: 1.5,
    attentionReason: null,
    stopReason: null,
    pullRequestNumber: null,
    pullRequestState: null,
    ...overrides,
  };
}

function workOrder(
  overrides: Partial<SnapshotWorkOrder> = {},
): SnapshotWorkOrder {
  return {
    identity: 'wo_opifex_401_bbbbbbb_a1',
    repository: 'marinoscar/opifex',
    issueNumber: 401,
    issueTitle: 'Queued thing',
    status: 'queued',
    attempt: 1,
    acceptanceCriteriaCount: 3,
    createdAt: new Date('2026-08-24T09:00:00.000Z'),
    ...overrides,
  };
}

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 2,
      runsStalled: 1,
      runsBlocked: 0,
      runsSucceededInWindow: 5,
      runsFailedInWindow: 1,
      workOrdersQueued: 4,
      workOrdersHeld: 1,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 1,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
    ...overrides,
  };
}

describe('renderSnapshot (#88)', () => {
  describe('purity and determinism', () => {
    it('renders identical text for identical input', () => {
      const a = renderSnapshot(input({ attentionRuns: [run()] }));
      const b = renderSnapshot(input({ attentionRuns: [run()] }));
      expect(a.text).toBe(b.text);
    });

    it('derives every age from generatedAt, not from the clock', () => {
      // The same state rendered "later" — the only thing that changes is the
      // caller's timestamp. If the renderer read the clock this test would be
      // flaky by construction; instead it is exact.
      const later = new Date(NOW.getTime() + 60 * 60 * 1000);
      const first = renderSnapshot(input({ attentionRuns: [run()] }));
      const second = renderSnapshot(
        input({ generatedAt: later, attentionRuns: [run()] }),
      );
      expect(first.text).toContain('last event: 30m ago');
      expect(second.text).toContain('last event: 1.5h ago');
    });

    it('does not mutate its input', () => {
      const original = input({ attentionRuns: [run(), run({ id: 'run-2' })] });
      const copy = JSON.parse(JSON.stringify(original)) as unknown;
      renderSnapshot(original, {
        ...DEFAULT_SNAPSHOT_LIMITS,
        attentionRuns: 1,
      });
      expect(JSON.parse(JSON.stringify(original))).toEqual(copy);
    });

    it('preserves the order it was given rather than re-sorting', () => {
      const rendered = renderSnapshot(
        input({
          attentionRuns: [run({ id: 'zzz' }), run({ id: 'aaa' })],
        }),
      );
      expect(rendered.text.indexOf('run zzz')).toBeLessThan(
        rendered.text.indexOf('run aaa'),
      );
    });
  });

  describe('bounding and truncation', () => {
    it('caps a section and says how many it dropped', () => {
      const runs = Array.from({ length: 20 }, (_, i) =>
        run({ id: `run-${i}` }),
      );
      const rendered = renderSnapshot(input({ attentionRuns: runs }), {
        ...DEFAULT_SNAPSHOT_LIMITS,
        attentionRuns: 3,
      });

      expect(rendered.truncated).toBe(true);
      expect(rendered.text).toContain('… 17 more not shown (of 20).');
      expect(rendered.truncatedSections).toEqual([
        { section: 'Runs needing attention', shown: 3, total: 20 },
      ]);
      expect(rendered.text).toContain('run-2');
      expect(rendered.text).not.toContain('run-3 ');
    });

    it('announces truncation inside the section AND in a summary block', () => {
      const runs = Array.from({ length: 5 }, (_, i) => run({ id: `run-${i}` }));
      const rendered = renderSnapshot(input({ attentionRuns: runs }), {
        ...DEFAULT_SNAPSHOT_LIMITS,
        attentionRuns: 2,
      });
      expect(rendered.text).toContain('## Truncation');
      expect(rendered.text).toContain(
        'This snapshot does not show the whole factory.',
      );
      expect(rendered.text).toContain('Runs needing attention: showing 2 of 5');
    });

    it('reports no truncation when everything fits', () => {
      const rendered = renderSnapshot(input({ attentionRuns: [run()] }));
      expect(rendered.truncated).toBe(false);
      expect(rendered.truncatedSections).toEqual([]);
      expect(rendered.text).not.toContain('## Truncation');
    });

    it('truncates each section independently, so a busy one cannot crowd out the queue', () => {
      const rendered = renderSnapshot(
        input({
          attentionRuns: Array.from({ length: 50 }, (_, i) =>
            run({ id: `r${i}` }),
          ),
          queuedWorkOrders: [workOrder()],
        }),
        { ...DEFAULT_SNAPSHOT_LIMITS, attentionRuns: 2 },
      );
      expect(rendered.text).toContain('wo_opifex_401_bbbbbbb_a1');
      expect(rendered.truncatedSections).toHaveLength(1);
    });

    it('stays bounded in size even with far more rows than the caps allow', () => {
      const many = Array.from({ length: 500 }, (_, i) => run({ id: `r${i}` }));
      const rendered = renderSnapshot(
        input({ attentionRuns: many, recentRuns: many }),
      );
      expect(rendered.characters).toBe(rendered.text.length);
      expect(rendered.characters).toBeLessThan(20_000);
    });
  });

  describe('what the text says', () => {
    it('renders empty sections as an explicit statement, not as absence', () => {
      // "No run currently needs attention" and a missing section read very
      // differently to a model. The second looks like a rendering failure.
      const rendered = renderSnapshot(input());
      expect(rendered.text).toContain('No run currently needs attention.');
      expect(rendered.text).toContain('The queue is empty.');
      expect(rendered.text).toContain('Nothing is quarantined.');
      expect(rendered.text).toContain('No escalation is outstanding.');
    });

    it('distinguishes unreported cost from zero cost (VISION §6)', () => {
      const unknown = renderSnapshot(
        input({ attentionRuns: [run({ costUsd: null })] }),
      );
      const free = renderSnapshot(
        input({ attentionRuns: [run({ costUsd: 0 })] }),
      );
      expect(unknown.text).toContain('cost: not reported');
      expect(free.text).toContain('cost: $0.00');
    });

    it('says so when a run has never produced an event', () => {
      const rendered = renderSnapshot(
        input({ attentionRuns: [run({ lastEventAt: null })] }),
      );
      expect(rendered.text).toContain('last event: none received');
    });

    it('includes the totals line even when every list is empty', () => {
      const rendered = renderSnapshot(input());
      expect(rendered.text).toContain('Runs: 2 running, 1 stalled, 0 blocked');
      expect(rendered.text).toContain('Escalations outstanding: 1');
    });

    it('carries the work order identity, which is what a proposal refers to', () => {
      const rendered = renderSnapshot(input({ attentionRuns: [run()] }));
      expect(rendered.text).toContain(
        'work order: wo_opifex_312_a3f91c2_a1 (attempt 1)',
      );
    });

    it('renders an open pull request differently from a merged one', () => {
      const open = renderSnapshot(
        input({
          recentRuns: [run({ pullRequestNumber: 7, pullRequestState: null })],
        }),
      );
      const merged = renderSnapshot(
        input({
          recentRuns: [
            run({ pullRequestNumber: 7, pullRequestState: 'merged' }),
          ],
        }),
      );
      expect(open.text).toContain('pull request: #7 (open)');
      expect(merged.text).toContain('pull request: #7 (merged)');
    });

    it('ends with exactly one trailing newline', () => {
      const rendered = renderSnapshot(input({ attentionRuns: [run()] }));
      expect(rendered.text.endsWith('\n')).toBe(true);
      expect(rendered.text.endsWith('\n\n')).toBe(false);
    });
  });
});

describe('age', () => {
  it('reports whole minutes below an hour', () => {
    expect(age(new Date('2026-08-24T11:59:00.000Z'), NOW)).toBe('1m');
    expect(age(new Date('2026-08-24T11:01:00.000Z'), NOW)).toBe('59m');
  });

  it('switches to hours at an hour and to days at two', () => {
    expect(age(new Date('2026-08-24T11:00:00.000Z'), NOW)).toBe('1.0h');
    expect(age(new Date('2026-08-22T12:00:00.000Z'), NOW)).toBe('2.0d');
  });

  it('names a future timestamp rather than rendering a negative age', () => {
    expect(age(new Date('2026-08-24T13:00:00.000Z'), NOW)).toBe(
      'in the future',
    );
  });

  it('coarsens, so an unchanged factory renders the same string twice', () => {
    const a = age(new Date('2026-08-24T11:30:20.000Z'), NOW);
    const b = age(new Date('2026-08-24T11:30:50.000Z'), NOW);
    expect(a).toBe(b);
  });
});

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('short', 20)).toBe('short');
  });

  it('collapses whitespace so a multi-line stop reason stays one line', () => {
    expect(clip('two\n\n  lines', 40)).toBe('two lines');
  });

  it('says it clipped, and how long the original was', () => {
    const clipped = clip('x'.repeat(100), 20);
    expect(clipped).toContain('… [clipped, 100 chars]');
    expect(clipped.startsWith('x'.repeat(19))).toBe(true);
  });
});
