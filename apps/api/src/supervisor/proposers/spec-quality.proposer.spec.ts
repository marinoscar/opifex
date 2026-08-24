import type { ProposerContext } from '../invocation/supervisor-proposer.port';
import type {
  SnapshotInput,
  SnapshotRun,
  SnapshotWorkOrder,
} from '../snapshot/snapshot.types';
import { SpecQualityProposer } from './spec-quality.proposer';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function run(
  acceptanceCriteriaCount: number,
  pullRequestState: string | null,
  id: string,
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

function order(
  acceptanceCriteriaCount: number,
  identity: string,
): SnapshotWorkOrder {
  return {
    identity,
    repository: 'marinoscar/opifex',
    issueNumber: 1,
    issueTitle: null,
    status: 'queued',
    attempt: 1,
    acceptanceCriteriaCount,
    createdAt: NOW,
  };
}

function context(
  recentRuns: SnapshotRun[],
  queued: SnapshotWorkOrder[] = [],
  ask = jest.fn().mockResolvedValue({
    text: 'State the HTTP status in each criterion.',
    costUsd: null,
    tokensInput: null,
    tokensOutput: null,
  }),
): ProposerContext {
  const state = {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 0,
      runsStalled: 0,
      runsBlocked: 0,
      runsSucceededInWindow: recentRuns.length,
      runsFailedInWindow: 0,
      workOrdersQueued: queued.length,
      workOrdersHeld: 0,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
    },
    attentionRuns: [],
    recentRuns,
    queuedWorkOrders: queued,
    quarantinedWorkOrders: [],
    escalations: [],
    specRejections: [],
  } satisfies SnapshotInput;

  return { state, snapshot: '# Factory snapshot\n', model: { name: 'm', ask } };
}

const SIGNAL = [
  ...Array.from({ length: 3 }, (_, i) => run(1, null, `t${i}`)),
  ...Array.from({ length: 3 }, (_, i) => run(6, 'merged', `k${i}`)),
];

describe('SpecQualityProposer (#111)', () => {
  const proposer = new SpecQualityProposer();

  beforeEach(() => {
    // The proposer logs a warning when narration is unavailable, which is a
    // deliberate path here rather than a surprise. Silenced so the suite's
    // output stays readable.
    jest
      .spyOn(
        (proposer as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('when there is nothing to say', () => {
    it('declines rather than narrating thin data', async () => {
      const drafts = await proposer.propose(context([]));

      expect(drafts[0].outcome).toBe('declined');
      expect(drafts[0].reasoning).toContain('arithmetic, not evidence');
    });

    it('does not call the model', async () => {
      const ask = jest.fn();
      await proposer.propose(context([], [], ask));
      expect(ask).not.toHaveBeenCalled();
    });
  });

  describe('when a band differs', () => {
    it('proposes, attributed to the spec-quality class', async () => {
      const drafts = await proposer.propose(context(SIGNAL));

      expect(drafts).toHaveLength(1);
      expect(drafts[0].outcome).toBe('proposed');
      expect(drafts[0].actionClass).toBe('spec-quality-feedback');
    });

    it('cites the runs it reasoned from', async () => {
      // #111: "feedback cites the runs/PRs it reasons from." The ids, so a
      // reviewer can check the correlation rather than trust it.
      const drafts = await proposer.propose(context(SIGNAL));

      const cited = (drafts[0].details as { citedRuns: unknown[] }).citedRuns;
      expect(cited).toHaveLength(SIGNAL.length);
      expect(cited[0]).toMatchObject({
        runId: 't0',
        acceptanceCriteriaCount: 1,
      });
    });

    it('states the measured rates in the reasoning', async () => {
      const drafts = await proposer.propose(context(SIGNAL));

      expect(drafts[0].reasoning).toContain(
        'First-pass acceptance by specification',
      );
      expect(drafts[0].reasoning).toContain('5 or more acceptance criteria');
    });

    it('marks a band below the threshold rather than reporting its rate', async () => {
      const runs = [...SIGNAL, run(3, 'merged', 'mid')];

      const drafts = await proposer.propose(context(runs));

      expect(drafts[0].reasoning).toContain('below the threshold');
    });
  });

  describe('flagging the queue before dispatch', () => {
    it('lists thin queued orders even with no correlation signal', async () => {
      // #111's third criterion. The same observation after a failure is a
      // post-mortem; before dispatch it is the only version that saves
      // anything.
      const drafts = await proposer.propose(context([], [order(1, 'wo-thin')]));

      expect(drafts[0].outcome).toBe('proposed');
      const flagged = (
        drafts[0].details as { underSpecifiedQueue: { identity: string }[] }
      ).underSpecifiedQueue;
      expect(flagged).toEqual([
        expect.objectContaining({
          identity: 'wo-thin',
          acceptanceCriteriaCount: 1,
        }),
      ]);
    });

    it('does not flag a well-specified queued order', async () => {
      const drafts = await proposer.propose(
        context(SIGNAL, [order(7, 'wo-fat')]),
      );

      expect(
        (drafts[0].details as { underSpecifiedQueue: unknown[] })
          .underSpecifiedQueue,
      ).toEqual([]);
    });

    it('blocks nothing — its output is a draft', async () => {
      const drafts = await proposer.propose(context([], [order(0, 'wo-0')]));

      expect(drafts[0].targetKind).toBe('factory');
      expect(Object.keys(drafts[0])).not.toContain('hold');
    });
  });

  describe('when the model is unavailable', () => {
    it('still records the measured finding', async () => {
      // The one proposer with something true to say without a model. Losing
      // the whole proposal because the prose failed would throw away a real
      // measurement.
      const ask = jest.fn().mockRejectedValue(new Error('no adapter'));

      const drafts = await proposer.propose(context(SIGNAL, [], ask));

      expect(drafts[0].outcome).toBe('proposed');
      expect(drafts[0].reasoning).toContain('First-pass acceptance');
      expect((drafts[0].details as { narrated: boolean }).narrated).toBe(false);
    });

    it('records that it was narrated when the model answered', async () => {
      const drafts = await proposer.propose(context(SIGNAL));

      expect((drafts[0].details as { narrated: boolean }).narrated).toBe(true);
      expect(drafts[0].reasoning).toContain('State the HTTP status');
    });
  });

  it('tells the model not to dispute the measured rates', async () => {
    const ask = jest.fn().mockResolvedValue({
      text: 'ok',
      costUsd: null,
      tokensInput: null,
      tokensOutput: null,
    });

    await proposer.propose(context(SIGNAL, [], ask));

    expect(ask.mock.calls[0][0].instruction).toContain('Do not');
    expect(ask.mock.calls[0][0].instruction).toContain('MEASURED');
  });
});
