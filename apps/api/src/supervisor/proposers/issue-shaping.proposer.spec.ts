import type { ProposerContext } from '../invocation/supervisor-proposer.port';
import type {
  SnapshotInput,
  SnapshotSpecRejection,
} from '../snapshot/snapshot.types';
import {
  IssueShapingProposer,
  parseShaping,
  shapingInstruction,
} from './issue-shaping.proposer';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function rejection(
  overrides: Partial<SnapshotSpecRejection> = {},
): SnapshotSpecRejection {
  return {
    repository: 'marinoscar/opifex',
    issueNumber: 401,
    message: 'No testable acceptance criteria were found.',
    rejectedAt: NOW,
    ...overrides,
  };
}

function context(
  rejections: SnapshotSpecRejection[],
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
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
    specRejections: rejections,
  } satisfies SnapshotInput;

  return {
    state,
    snapshot: '# Factory snapshot\n',
    model: { name: 'test-model', ask },
  };
}

const GOOD = JSON.stringify({
  reasoning: 'The issue states a problem but no checkable outcome.',
  acceptanceCriteria: [
    'GET /api/things returns 200 with a paginated body',
    'A request without the permission returns 403',
  ],
  gaps: ['No affected component is named'],
  suggestedBody: '## Problem statement\n\n…',
});

function answer(text: string) {
  return jest.fn().mockResolvedValue({
    text,
    costUsd: null,
    tokensInput: null,
    tokensOutput: null,
  });
}

describe('IssueShapingProposer (#109)', () => {
  const proposer = new IssueShapingProposer();

  describe('which issues it shapes', () => {
    it('takes the issues the deterministic gate turned away', async () => {
      // Not a guess from the text: a record that the system already refused
      // the issue and told the author why.
      const ask = answer(GOOD);
      const drafts = await proposer.propose(context([rejection()], ask));

      expect(drafts).toHaveLength(1);
      expect(drafts[0].targetRef).toBe('marinoscar/opifex#401');
    });

    it('caps how many it shapes per invocation', async () => {
      const ask = answer(GOOD);
      const many = Array.from({ length: 8 }, (_, i) =>
        rejection({ issueNumber: 400 + i }),
      );

      const drafts = await proposer.propose(context(many, ask));

      expect(drafts).toHaveLength(IssueShapingProposer.MAX_PER_INVOCATION);
    });

    it('declines when the gate turned nothing away', async () => {
      const drafts = await proposer.propose(context([]));

      expect(drafts[0].outcome).toBe('declined');
      expect(drafts[0].targetKind).toBe('factory');
    });

    it('does not call the model when there is nothing to shape', async () => {
      const ask = jest.fn();
      await proposer.propose(context([], ask));
      expect(ask).not.toHaveBeenCalled();
    });
  });

  describe('what it proposes', () => {
    it('produces concrete, testable acceptance criteria', async () => {
      const drafts = await proposer.propose(
        context([rejection()], answer(GOOD)),
      );

      const details = drafts[0].details as { acceptanceCriteria: string[] };
      expect(details.acceptanceCriteria).toEqual([
        'GET /api/things returns 200 with a paginated body',
        'A request without the permission returns 403',
      ]);
    });

    it('flags the gaps it found', async () => {
      const drafts = await proposer.propose(
        context([rejection()], answer(GOOD)),
      );

      expect((drafts[0].details as { gaps: string[] }).gaps).toEqual([
        'No affected component is named',
      ]);
    });

    it('keeps the rewrite as a string, never applying it', async () => {
      // #109: "the proposal never edits the issue itself". Structural — this
      // class has no GitHub client to edit with.
      const drafts = await proposer.propose(
        context([rejection()], answer(GOOD)),
      );

      const details = drafts[0].details as { suggestedBody: string };
      expect(details.suggestedBody).toContain('## Problem statement');
      expect(Object.keys(drafts[0])).not.toContain('apply');
    });

    it('records why the gate rejected it, so the shaping can be judged against it', async () => {
      const drafts = await proposer.propose(
        context([rejection()], answer(GOOD)),
      );

      expect(
        (drafts[0].details as { rejectedBecause: string }).rejectedBecause,
      ).toBe('No testable acceptance criteria were found.');
    });

    it('is attributed to the issue-shaping action class', async () => {
      const drafts = await proposer.propose(
        context([rejection()], answer(GOOD)),
      );
      expect(drafts[0].actionClass).toBe('issue-shaping');
    });

    it('targets an issue that has no work order, by owner/name#number', async () => {
      // The log's targetRef is deliberately not a foreign key, for exactly
      // this case: an issue the gate refused has nothing to point at.
      const drafts = await proposer.propose(
        context([rejection({ issueNumber: 77 })], answer(GOOD)),
      );

      expect(drafts[0].targetKind).toBe('issue');
      expect(drafts[0].targetRef).toBe('marinoscar/opifex#77');
    });
  });

  describe('parseShaping', () => {
    it('accepts an empty gaps list', () => {
      // An issue can be under-specified purely by missing criteria.
      const shaping = parseShaping(
        JSON.stringify({
          reasoning: 'r',
          acceptanceCriteria: ['a'],
          suggestedBody: 'b',
        }),
      );

      expect(shaping.gaps).toEqual([]);
    });

    it('rejects a shaping with no acceptance criteria', () => {
      expect(() =>
        parseShaping(
          JSON.stringify({
            reasoning: 'r',
            acceptanceCriteria: [],
            suggestedBody: 'b',
          }),
        ),
      ).toThrow('acceptanceCriteria');
    });

    it('rejects a shaping with no rewrite', () => {
      expect(() =>
        parseShaping(
          JSON.stringify({ reasoning: 'r', acceptanceCriteria: ['a'] }),
        ),
      ).toThrow('suggestedBody');
    });

    it('reads a fenced block', () => {
      const shaping = parseShaping('```json\n' + GOOD + '\n```');
      expect(shaping.acceptanceCriteria).toHaveLength(2);
    });
  });

  describe('the prompt', () => {
    it('quotes what the author was actually told', () => {
      expect(shapingInstruction(rejection())).toContain(
        'No testable acceptance criteria were found.',
      );
    });

    it('defines testable rather than assuming the word is shared', () => {
      expect(shapingInstruction(rejection())).toContain(
        'mark done or not done without a judgement',
      );
    });

    it('forbids inventing scope', () => {
      // A shaping that changes what the issue asks for is a different issue,
      // and a reviewer will reject it — correctly.
      expect(shapingInstruction(rejection())).toContain('Do not invent scope');
    });
  });
});
