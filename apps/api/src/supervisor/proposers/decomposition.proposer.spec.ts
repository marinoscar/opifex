import type { ProposerContext } from '../invocation/supervisor-proposer.port';
import type {
  SnapshotInput,
  SnapshotWorkOrder,
} from '../snapshot/snapshot.types';
import {
  DecompositionProposer,
  decompositionInstruction,
  oversized,
  parseDecomposition,
} from './decomposition.proposer';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function order(overrides: Partial<SnapshotWorkOrder> = {}): SnapshotWorkOrder {
  return {
    identity: 'wo_opifex_312_a3f91c2_a3',
    repository: 'marinoscar/opifex',
    issueNumber: 312,
    issueTitle: 'Rewrite the whole thing',
    status: 'quarantined',
    attempt: 3,
    acceptanceCriteriaCount: 1,
    createdAt: NOW,
    ...overrides,
  };
}

function context(
  orders: SnapshotWorkOrder[],
  ask = jest.fn(),
): ProposerContext {
  const state = {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 0,
      runsStalled: 0,
      runsBlocked: 0,
      runsSucceededInWindow: 0,
      runsFailedInWindow: 0,
      workOrdersQueued: 0,
      workOrdersHeld: 0,
      workOrdersQuarantined: orders.length,
      escalationsOutstanding: 0,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: orders,
    escalations: [],
    specRejections: [],
  } satisfies SnapshotInput;

  return {
    state,
    snapshot: '# Factory snapshot\n',
    model: { name: 'test-model', ask },
  };
}

const GOOD_PLAN = JSON.stringify({
  reasoning: 'The order bundles a migration with a UI change.',
  predictedAttemptsPerChild: 1,
  children: [
    {
      title: 'Add the migration',
      rationale: 'The schema half of the parent.',
      acceptanceCriteria: [
        'The migration applies cleanly',
        'Rollback is tested',
      ],
    },
    {
      title: 'Wire the screen',
      rationale: 'The UI half of the parent.',
      acceptanceCriteria: ['The screen renders the new column'],
    },
  ],
});

function answer(text: string) {
  return jest.fn().mockResolvedValue({
    text,
    costUsd: null,
    tokensInput: null,
    tokensOutput: null,
  });
}

describe('DecompositionProposer (#110)', () => {
  const proposer = new DecompositionProposer();

  describe('which orders it looks at', () => {
    it('takes quarantined orders', () => {
      expect(oversized([order()])).toHaveLength(1);
    });

    it('leaves a merely queued order alone', () => {
      // Proposing a split for a queued order would be guessing at size from
      // the text. #111 does that deliberately; this should not do it by
      // accident.
      expect(oversized([order({ status: 'queued' })])).toEqual([]);
    });

    it('caps how many it attempts per invocation', async () => {
      const ask = answer(GOOD_PLAN);
      const orders = Array.from({ length: 6 }, (_, i) =>
        order({ identity: `wo-${i}` }),
      );

      const drafts = await proposer.propose(context(orders, ask));

      expect(drafts).toHaveLength(DecompositionProposer.MAX_PER_INVOCATION);
    });
  });

  describe('when nothing is oversized', () => {
    it('declines rather than staying silent', async () => {
      const drafts = await proposer.propose(context([]));

      expect(drafts).toHaveLength(1);
      expect(drafts[0].outcome).toBe('declined');
      expect(drafts[0].targetKind).toBe('factory');
    });

    it('does not call the model', async () => {
      const ask = jest.fn();
      await proposer.propose(context([], ask));
      expect(ask).not.toHaveBeenCalled();
    });
  });

  describe('what it proposes', () => {
    it('records the children with their testable criteria', async () => {
      const drafts = await proposer.propose(
        context([order()], answer(GOOD_PLAN)),
      );

      const details = drafts[0].details as {
        children: { title: string; acceptanceCriteria: string[] }[];
      };
      expect(details.children).toHaveLength(2);
      expect(details.children[0].acceptanceCriteria).toEqual([
        'The migration applies cleanly',
        'Rollback is tested',
      ]);
    });

    it('targets the work order by identity', async () => {
      const drafts = await proposer.propose(
        context([order()], answer(GOOD_PLAN)),
      );

      expect(drafts[0].targetKind).toBe('work-order');
      expect(drafts[0].targetRef).toBe('wo_opifex_312_a3f91c2_a3');
    });

    it('records a checkable prediction against metric 4', async () => {
      // #110: "the proposal should predict the improvement it expects so the
      // prediction is checkable."
      const drafts = await proposer.propose(
        context([order()], answer(GOOD_PLAN)),
      );

      const details = drafts[0].details as {
        prediction: {
          parentAttempts: number;
          predictedAttemptsPerChild: number;
        };
      };
      expect(details.prediction).toEqual({
        parentAttempts: 3,
        predictedAttemptsPerChild: 1,
      });
    });

    it('states the creation constraint in the record itself', async () => {
      // Whoever promotes this class reads the proposal, and may not read #110.
      const drafts = await proposer.propose(
        context([order()], answer(GOOD_PLAN)),
      );

      expect(
        (drafts[0].details as { creationConstraint: string })
          .creationConstraint,
      ).toContain('gated');
    });

    it('creates nothing — its whole output is drafts', async () => {
      const drafts = await proposer.propose(
        context([order()], answer(GOOD_PLAN)),
      );

      for (const draft of drafts) {
        expect(Object.keys(draft).sort()).toEqual(
          [
            'actionClass',
            'details',
            'outcome',
            'reasoning',
            'summary',
            'targetKind',
            'targetRef',
          ].sort(),
        );
      }
    });
  });

  describe('when the model says the order is not oversized', () => {
    it('records a decline against that order, not a failure', async () => {
      // A judgement belongs in the log as evidence about the class.
      const empty = JSON.stringify({
        reasoning: 'It failed on a flaky test, not on size.',
        children: [],
      });

      const drafts = await proposer.propose(context([order()], answer(empty)));

      expect(drafts[0].outcome).toBe('declined');
      expect(drafts[0].targetRef).toBe('wo_opifex_312_a3f91c2_a3');
      expect(drafts[0].reasoning).toContain('flaky test');
    });
  });

  describe('parseDecomposition', () => {
    it('reads a fenced JSON block', () => {
      const plan = parseDecomposition(
        'Sure:\n```json\n' + GOOD_PLAN + '\n```\nDone.',
      );
      expect(plan.children).toHaveLength(2);
    });

    it('reads bare JSON with prose around it', () => {
      const plan = parseDecomposition(
        `Here you go. ${GOOD_PLAN} Hope that helps.`,
      );
      expect(plan.predictedAttemptsPerChild).toBe(1);
    });

    it('rejects a single-child split', () => {
      const one = JSON.stringify({
        reasoning: 'r',
        predictedAttemptsPerChild: 1,
        children: [{ title: 't', rationale: 'r', acceptanceCriteria: ['a'] }],
      });
      expect(() => parseDecomposition(one)).toThrow('at least two children');
    });

    it('rejects a child with no acceptance criteria', () => {
      const bad = JSON.stringify({
        reasoning: 'r',
        predictedAttemptsPerChild: 1,
        children: [
          { title: 't', rationale: 'r', acceptanceCriteria: [] },
          { title: 'u', rationale: 'r', acceptanceCriteria: ['a'] },
        ],
      });
      expect(() => parseDecomposition(bad)).toThrow(
        'children[0].acceptanceCriteria',
      );
    });

    it('names the field that was wrong', () => {
      const bad = JSON.stringify({
        reasoning: 'r',
        predictedAttemptsPerChild: 1,
        children: [
          { rationale: 'r', acceptanceCriteria: ['a'] },
          { title: 'u', rationale: 'r', acceptanceCriteria: ['a'] },
        ],
      });
      // "invalid proposal" is a message nobody can act on.
      expect(() => parseDecomposition(bad)).toThrow('children[0].title');
    });

    it('rejects a missing prediction', () => {
      const bad = JSON.stringify({
        reasoning: 'r',
        children: [
          { title: 't', rationale: 'r', acceptanceCriteria: ['a'] },
          { title: 'u', rationale: 'r', acceptanceCriteria: ['a'] },
        ],
      });
      expect(() => parseDecomposition(bad)).toThrow(
        'predictedAttemptsPerChild',
      );
    });

    it('rejects text with no JSON in it at all', () => {
      expect(() => parseDecomposition('I would rather not.')).toThrow(
        'no JSON object or array',
      );
    });
  });

  describe('the prompt', () => {
    it('names the order, its attempt count and its criteria count', () => {
      const instruction = decompositionInstruction(order());

      expect(instruction).toContain('wo_opifex_312_a3f91c2_a3');
      expect(instruction).toContain('attempt 3');
      expect(instruction).toContain('1 acceptance criteria');
    });

    it('asks for testable criteria per child', () => {
      expect(decompositionInstruction(order())).toContain(
        'a reviewer could check as done or not done',
      );
    });

    it('offers the model a way to say no', () => {
      expect(decompositionInstruction(order())).toContain(
        'return an empty children array',
      );
    });
  });
});
