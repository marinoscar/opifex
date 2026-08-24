import type { ProposerContext } from '../invocation/supervisor-proposer.port';
import type { SnapshotInput, SnapshotRun } from '../snapshot/snapshot.types';
import {
  HYPOTHESIS_PREFIX,
  RunDiagnosisProposer,
  diagnosable,
  diagnosisInstruction,
} from './run-diagnosis.proposer';

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
    startedAt: NOW,
    endedAt: null,
    lastEventAt: NOW,
    attemptCount: 2,
    costUsd: 1,
    attentionReason: 'silent for 40m',
    stopReason: null,
    pullRequestNumber: null,
    pullRequestState: null,
    ...overrides,
  };
}

function context(runs: SnapshotRun[], ask = jest.fn()): ProposerContext {
  const state = {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 0,
      runsStalled: runs.length,
      runsBlocked: 0,
      runsSucceededInWindow: 0,
      runsFailedInWindow: 0,
      workOrdersQueued: 0,
      workOrdersHeld: 0,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
    },
    attentionRuns: runs,
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
  } satisfies SnapshotInput;

  return {
    state,
    snapshot: '# Factory snapshot\n',
    model: { name: 'test-model', ask },
  };
}

function answer(text: string) {
  return jest
    .fn()
    .mockResolvedValue({
      text,
      costUsd: 0.01,
      tokensInput: 10,
      tokensOutput: 5,
    });
}

describe('RunDiagnosisProposer (#92)', () => {
  const proposer = new RunDiagnosisProposer();

  describe('which runs it explains', () => {
    it('diagnoses stalled and quarantined runs', () => {
      const runs = [run({ status: 'stalled' }), run({ status: 'quarantined' })];
      expect(diagnosable(runs)).toHaveLength(2);
    });

    it('skips a blocked run, whose cause is already recorded exactly', () => {
      // Parked on a rate limit with a scheduled resume. Asking a model why it
      // stopped would narrate a fact the control plane already knows.
      expect(diagnosable([run({ status: 'blocked' })])).toEqual([]);
    });

    it('caps how many runs one invocation diagnoses', async () => {
      const ask = answer('It died on a missing dependency.');
      const runs = Array.from({ length: 10 }, (_, i) =>
        run({ id: `run-${i}` }),
      );

      const drafts = await proposer.propose(context(runs, ask));

      // A bad day produces dozens of failed runs, and asking dozens of times
      // spends the quota VISION §7 says the workers get first.
      expect(drafts).toHaveLength(RunDiagnosisProposer.MAX_PER_INVOCATION);
      expect(ask).toHaveBeenCalledTimes(
        RunDiagnosisProposer.MAX_PER_INVOCATION,
      );
    });

    it('takes the worst first, since the snapshot orders by longest silence', async () => {
      const ask = answer('diagnosis');
      const runs = [
        run({ id: 'worst' }),
        run({ id: 'next' }),
        run({ id: 'third' }),
        run({ id: 'fourth' }),
      ];

      const drafts = await proposer.propose(context(runs, ask));

      expect(drafts.map((d) => d.targetRef)).toEqual([
        'worst',
        'next',
        'third',
      ]);
    });
  });

  describe('when nothing needs explaining', () => {
    it('declines rather than returning nothing', async () => {
      // #90: a class nothing proposes must be distinguishable from one always
      // proposed correctly. "Everything was healthy" is evidence.
      const drafts = await proposer.propose(context([]));

      expect(drafts).toHaveLength(1);
      expect(drafts[0].outcome).toBe('declined');
      expect(drafts[0].actionClass).toBe('run-diagnosis');
    });

    it('does not call the model at all', async () => {
      const ask = jest.fn();
      await proposer.propose(context([], ask));
      expect(ask).not.toHaveBeenCalled();
    });

    it('declines against the factory, not against a run it did not look at', async () => {
      const drafts = await proposer.propose(context([]));
      expect(drafts[0].targetKind).toBe('factory');
      expect(drafts[0].targetRef).toBeUndefined();
    });
  });

  describe('attribution', () => {
    it('marks every diagnosis as a hypothesis, in both fields', async () => {
      const drafts = await proposer.propose(
        context([run()], answer('The install step failed.')),
      );

      expect(drafts[0].summary.startsWith(HYPOTHESIS_PREFIX)).toBe(true);
      expect(drafts[0].reasoning.startsWith(HYPOTHESIS_PREFIX)).toBe(true);
    });

    it('adds the caveat itself rather than asking the model for it', async () => {
      // A model asked to caveat itself will sometimes decline to, and the
      // record cannot be corrected once it is written.
      const drafts = await proposer.propose(
        context([run()], answer('It broke.')),
      );

      expect(drafts[0].reasoning).toContain(HYPOTHESIS_PREFIX);
      expect(drafts[0].reasoning).toContain('It broke.');
    });

    it('tells the model not to add its own caveat', () => {
      expect(diagnosisInstruction(run())).toContain(
        'the attribution is added automatically',
      );
    });
  });

  describe('the evidence it links to', () => {
    it('records the specific facts it reasoned from', async () => {
      const drafts = await proposer.propose(context([run()], answer('x')));

      expect(drafts[0].details).toEqual({
        evidence: {
          workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
          status: 'stalled',
          runnerKey: 'claude-code-local',
          attemptCount: 2,
          lastEventAt: NOW.toISOString(),
          attentionReason: 'silent for 40m',
          stopReason: null,
        },
      });
    });

    it('targets the run, so the summary can find its diagnosis', async () => {
      const drafts = await proposer.propose(context([run()], answer('x')));

      expect(drafts[0].targetKind).toBe('run');
      expect(drafts[0].targetRef).toBe('run-1');
    });

    it('handles a run that has never emitted an event', async () => {
      const drafts = await proposer.propose(
        context([run({ lastEventAt: null })], answer('x')),
      );

      expect(
        (drafts[0].details as { evidence: { lastEventAt: null } }).evidence
          .lastEventAt,
      ).toBeNull();
    });
  });

  describe('the prompt', () => {
    it('names the run, the work order and the attempt', () => {
      const instruction = diagnosisInstruction(run());

      expect(instruction).toContain('run-1');
      expect(instruction).toContain('wo_opifex_312_a3f91c2_a1');
      expect(instruction).toContain('attempt 2');
    });

    it('tells the model to say when it cannot conclude', () => {
      expect(diagnosisInstruction(run())).toContain(
        'say that instead of guessing',
      );
    });

    it('sends the snapshot as the only state', async () => {
      const ask = answer('x');
      await proposer.propose(context([run()], ask));

      expect(ask.mock.calls[0][0].snapshot).toBe('# Factory snapshot\n');
    });
  });

  describe('summaries', () => {
    it('takes the first line, so the log list is readable', async () => {
      const drafts = await proposer.propose(
        context([run()], answer('It ran out of disk.\n\nMore detail follows.')),
      );

      expect(drafts[0].summary).toBe(
        `${HYPOTHESIS_PREFIX} It ran out of disk.`,
      );
    });

    it('says so rather than producing an empty summary', async () => {
      const drafts = await proposer.propose(context([run()], answer('   ')));

      expect(drafts[0].summary).toContain('no diagnosis text');
    });
  });

  it('lets a model failure surface as a proposer failure', async () => {
    // Not swallowed into a `declined` row: declined means the supervisor
    // looked and had nothing to say, and a broken adapter is not a judgement.
    const ask = jest.fn().mockRejectedValue(new Error('no adapter'));

    await expect(proposer.propose(context([run()], ask))).rejects.toThrow(
      'no adapter',
    );
  });
});
