import type {
  SnapshotEscalation,
  SnapshotInput,
  SnapshotRun,
  SnapshotWorkOrder,
} from '../snapshot/snapshot.types';
import {
  BriefRank,
  MAX_BRIEF_ITEMS,
  composeBrief,
  rankBrief,
  trustSection,
} from './daily-brief';
import { type TrustDigest, buildTrustDigest } from './trust-digest';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function run(overrides: Partial<SnapshotRun> = {}): SnapshotRun {
  return {
    id: 'run-1',
    workOrderIdentity: 'wo_1',
    repository: 'marinoscar/opifex',
    issueNumber: 1,
    issueTitle: null,
    status: 'stalled',
    runnerKey: 'claude-code-local',
    startedAt: NOW,
    endedAt: null,
    lastEventAt: NOW,
    attemptCount: 1,
    costUsd: null,
    attentionReason: 'silent for 40m',
    stopReason: null,
    pullRequestNumber: null,
    pullRequestState: null,
    acceptanceCriteriaCount: 3,
    ...overrides,
  };
}

function order(overrides: Partial<SnapshotWorkOrder> = {}): SnapshotWorkOrder {
  return {
    identity: 'wo_q',
    repository: 'marinoscar/opifex',
    issueNumber: 2,
    issueTitle: null,
    status: 'quarantined',
    attempt: 3,
    acceptanceCriteriaCount: 3,
    createdAt: NOW,
    ...overrides,
  };
}

function escalation(
  overrides: Partial<SnapshotEscalation> = {},
): SnapshotEscalation {
  return {
    id: 'esc-1',
    kind: 'run_stalled',
    status: 'raised',
    summary: 'A run went quiet',
    raisedAt: NOW,
    runId: 'run-9',
    ...overrides,
  };
}

function state(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 1,
      runsStalled: 0,
      runsBlocked: 0,
      runsSucceededInWindow: 4,
      runsFailedInWindow: 0,
      workOrdersQueued: 2,
      workOrdersHeld: 0,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
    specRejections: [],
    ...overrides,
  };
}

describe('rankBrief (#93)', () => {
  it('puts an unacknowledged escalation above everything else', () => {
    // Not because it is most severe — a stalled run costs nothing sitting.
    // It is top because an unacknowledged escalation may mean the
    // notification failed silently, which is the failure #58 exists to stop.
    const brief = rankBrief(
      state({
        escalations: [escalation()],
        quarantinedWorkOrders: [order()],
        attentionRuns: [run()],
      }),
    );

    expect(brief.items[0].rank).toBe(BriefRank.Unacknowledged);
    expect(brief.items[0].headline).toContain('Unacknowledged');
  });

  it('ranks quarantine above a silent run', () => {
    const brief = rankBrief(
      state({ attentionRuns: [run()], quarantinedWorkOrders: [order()] }),
    );

    expect(brief.items.map((i) => i.rank)).toEqual([
      BriefRank.Quarantined,
      BriefRank.SilentRun,
    ]);
  });

  it('ranks a thin specification last, because it has cost nothing yet', () => {
    const brief = rankBrief(
      state({
        attentionRuns: [run()],
        queuedWorkOrders: [
          order({ status: 'queued', acceptanceCriteriaCount: 1 }),
        ],
      }),
    );

    expect(brief.items[brief.items.length - 1].rank).toBe(BriefRank.ThinSpec);
  });

  it('gives every item a reason for where it ranks', () => {
    // A brief whose ordering cannot be argued with is one nobody can correct
    // when it gets the order wrong.
    const brief = rankBrief(
      state({ escalations: [escalation()], quarantinedWorkOrders: [order()] }),
    );

    for (const item of brief.items) {
      expect(item.why.length).toBeGreaterThan(30);
    }
  });

  it('is quiet when nothing needs anybody', () => {
    const brief = rankBrief(state());

    expect(brief.quiet).toBe(true);
    expect(brief.items).toEqual([]);
  });

  it('does not treat a healthy queue as something needing attention', () => {
    const brief = rankBrief(
      state({
        queuedWorkOrders: [
          order({ status: 'queued', acceptanceCriteriaCount: 5 }),
        ],
      }),
    );

    expect(brief.quiet).toBe(true);
  });

  it('ignores a blocked run, which resumes on its own', () => {
    const brief = rankBrief(
      state({ attentionRuns: [run({ status: 'blocked' })] }),
    );

    expect(brief.quiet).toBe(true);
  });

  it('keeps snapshot order within a rank band', () => {
    // The snapshot already orders each list most-starved-first, so two items
    // of the same rank keep that meaning.
    const brief = rankBrief(
      state({
        quarantinedWorkOrders: [
          order({ identity: 'first' }),
          order({ identity: 'second' }),
        ],
      }),
    );

    expect(brief.items.map((i) => i.ref)).toEqual(['first', 'second']);
  });

  it('caps the ranked list', () => {
    const brief = rankBrief(
      state({
        quarantinedWorkOrders: Array.from({ length: 30 }, (_, i) =>
          order({ identity: `wo-${i}` }),
        ),
      }),
    );

    expect(brief.items).toHaveLength(MAX_BRIEF_ITEMS);
  });

  it('is pure', () => {
    const input = state({ escalations: [escalation()] });
    expect(rankBrief(input)).toEqual(rankBrief(input));
  });
});

describe('composeBrief', () => {
  it('keeps a quiet day short', () => {
    // Padding a quiet day teaches its reader that most of it can be skipped,
    // and after that the loud day gets skipped too.
    const text = composeBrief(rankBrief(state()), state());

    expect(text).toContain('Nothing needed you');
    expect(text.split('\n').length).toBeLessThan(10);
  });

  it('numbers the ranked items and states why each ranks there', () => {
    const input = state({
      escalations: [escalation()],
      attentionRuns: [run()],
    });
    const text = composeBrief(rankBrief(input), input);

    expect(text).toContain('1. Unacknowledged');
    expect(text).toContain('2. Silent run');
    expect(text).toContain('silent for 40m');
  });

  it('always says what ran under trust', () => {
    const text = composeBrief(rankBrief(state()), state());

    expect(text).toContain('Ran under trust: nothing');
  });
});

describe('trustSection (ADR-0012)', () => {
  it('says nothing is promoted rather than omitting the section', () => {
    const lines = trustSection({
      items: [],
      quiet: true,
      trustExecuted: [],
      trustNotShown: 0,
    });

    expect(lines.join('\n')).toContain('No action class is promoted');
  });

  it('lists trust-executed actions in full', () => {
    const lines = trustSection({
      items: [],
      quiet: false,
      trustExecuted: [
        {
          actionClass: 're-dispatch',
          summary: 'Re-ran wo_1',
          ref: 'wo_1',
          at: '09:00',
        },
        {
          actionClass: 're-dispatch',
          summary: 'Re-ran wo_2',
          ref: 'wo_2',
          at: '10:00',
        },
      ],
      trustNotShown: 0,
    });

    expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(2);
  });

  it('says how many it could not show rather than truncating silently', () => {
    // The whole difference between this section and the ranked list: an
    // omission here is an action that happened without the operator and was
    // not reported.
    const lines = trustSection({
      items: [],
      quiet: false,
      trustExecuted: [],
      trustNotShown: 4,
    });

    expect(lines.join('\n')).toContain('4 more not listed');
    expect(lines.join('\n')).toContain('meant to be complete');
  });
});

describe('trustSection with a digest (#100)', () => {
  /** The smallest digest that says "nothing, and nothing to say about it". */
  function quietDigest(): TrustDigest {
    return buildTrustDigest({
      now: NOW,
      windowStart: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      actions: [],
      totalActions: 0,
      activeGrants: [],
      endedGrants: [],
      previousWindowActionsByGrant: {},
    });
  }

  function digestWith(count: number): TrustDigest {
    return buildTrustDigest({
      now: NOW,
      windowStart: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      actions: Array.from({ length: count }, (_, i) => ({
        approvalId: `appr-${i}`,
        actionClass: 're-dispatch',
        repositoryId: 'repo-1',
        summary: `Re-dispatched wo_${i}`,
        targetRef: `wo_${i}`,
        grantId: 'grant-1',
        estimatedCostUsd: 0.25,
        at: new Date(NOW.getTime() - (i + 1) * 60 * 60 * 1000),
        origin: 'grant' as const,
      })),
      totalActions: count,
      activeGrants: [],
      endedGrants: [],
      previousWindowActionsByGrant: {},
    });
  }

  it('leaves the ranked half alone — the digest never reorders it', () => {
    // ADR-0012: the two halves answer different questions, and letting what
    // ran under trust reorder what needs a human would blur the one property
    // #93 says the brief is worth building for.
    const input = state({
      escalations: [escalation()],
      quarantinedWorkOrders: [order()],
    });

    expect(rankBrief(input, digestWith(5)).items).toEqual(
      rankBrief(input).items,
    );
  });

  it('fills trustExecuted and trustNotShown from the digest', () => {
    const brief = rankBrief(state(), digestWith(3));

    expect(brief.trustExecuted).toHaveLength(3);
    expect(brief.trustNotShown).toBe(0);
    expect(brief.trustDigest).toBeDefined();
  });

  it('keeps a quiet trust section to one line', () => {
    const lines = trustSection(rankBrief(state(), quietDigest()));

    expect(lines).toHaveLength(1);
  });

  it('keeps the whole brief short on a day that was quiet both ways', () => {
    const input = state();
    const text = composeBrief(rankBrief(input, quietDigest()), input);

    expect(text.split('\n').length).toBeLessThan(10);
    expect(text).toContain('Ran under trust: nothing');
  });

  it('renders the pre-#100 line when no digest was read at all', () => {
    // Absent means "no trust data was read", not "nothing ran", and it must
    // not render as a set of empty headings.
    const lines = trustSection(rankBrief(state()));

    expect(lines.join('\n')).toContain('No action class is promoted');
  });

  it('lists what ran under trust below the ranked items', () => {
    const input = state({ escalations: [escalation()] });
    const text = composeBrief(rankBrief(input, digestWith(2)), input);

    expect(text.indexOf('1. Unacknowledged')).toBeLessThan(
      text.indexOf('Ran under trust:'),
    );
    expect(text).toContain('Re-dispatched wo_0');
    expect(text).toContain('Re-dispatched wo_1');
  });
});
