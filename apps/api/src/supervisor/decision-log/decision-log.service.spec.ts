import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { DecisionLogService, hashSnapshot } from './decision-log.service';
import type { InvocationDraft, ProposalDraft } from './decision-log.types';

const STARTED = new Date('2026-08-24T12:00:00.000Z');
const FINISHED = new Date('2026-08-24T12:00:04.500Z');

function invocation(overrides: Partial<InvocationDraft> = {}): InvocationDraft {
  return {
    startedAt: STARTED,
    finishedAt: FINISHED,
    outcome: 'completed',
    model: 'small-model-1',
    snapshotText: '# Factory snapshot\n',
    snapshotGeneratedAt: STARTED,
    snapshotTruncated: false,
    snapshotCharacters: 20,
    ...overrides,
  };
}

function proposal(overrides: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    actionClass: 'run-diagnosis',
    outcome: 'proposed',
    summary: 'The run died on a missing dependency',
    reasoning: 'The last event before silence was an npm install failure.',
    targetKind: 'run',
    targetRef: 'run-1',
    ...overrides,
  };
}

function prismaDouble() {
  const invocationCreate = jest.fn().mockResolvedValue({ id: 'inv-1' });
  const proposalCreate = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ id: `prop-${proposalCreate.mock.calls.length}` }),
    );

  const tx = {
    supervisorInvocation: { create: invocationCreate },
    supervisorProposal: { create: proposalCreate },
  };

  return {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    supervisorInvocation: {
      create: invocationCreate,
      findUnique: jest.fn().mockResolvedValue(null),
    },
    supervisorProposal: {
      create: proposalCreate,
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    _tx: tx,
  };
}

describe('DecisionLogService (#90)', () => {
  let prisma: ReturnType<typeof prismaDouble>;
  let service: DecisionLogService;

  beforeEach(() => {
    prisma = prismaDouble();
    service = new DecisionLogService(prisma as unknown as PrismaService);
  });

  describe('record', () => {
    it('writes the invocation and its proposals in one transaction', async () => {
      // A proposal whose invocation row is missing has no snapshot, and the
      // snapshot is the answer to "what did it actually know?" A half-written
      // entry is worse than none, because it looks like evidence.
      await service.record(invocation(), [proposal(), proposal()]);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma._tx.supervisorInvocation.create).toHaveBeenCalledTimes(1);
      expect(prisma._tx.supervisorProposal.create).toHaveBeenCalledTimes(2);
    });

    it('records an invocation that proposed nothing', async () => {
      // A log with gaps cannot be reviewed: a missing entry is
      // indistinguishable from an invocation that silently failed.
      const result = await service.record(invocation());

      expect(result.invocationId).toBe('inv-1');
      expect(result.proposalIds).toEqual([]);
      expect(prisma._tx.supervisorInvocation.create).toHaveBeenCalledTimes(1);
    });

    it('records an invocation that never ran because the supervisor is off', async () => {
      await service.record(
        invocation({
          outcome: 'skipped_disabled',
          model: 'none',
          snapshotText: '',
          failureReason: 'SUPERVISOR_ENABLED=false',
        }),
      );

      const data = prisma._tx.supervisorInvocation.create.mock.calls[0][0].data;
      expect(data.outcome).toBe('skipped_disabled');
      expect(data.failureReason).toBe('SUPERVISOR_ENABLED=false');
    });

    it('computes the duration from the two timestamps', async () => {
      await service.record(invocation());

      const data = prisma._tx.supervisorInvocation.create.mock.calls[0][0].data;
      expect(data.durationMs).toBe(4500);
    });

    it('never records a negative duration', async () => {
      await service.record(
        invocation({ startedAt: FINISHED, finishedAt: STARTED }),
      );

      const data = prisma._tx.supervisorInvocation.create.mock.calls[0][0].data;
      expect(data.durationMs).toBe(0);
    });

    it('hashes the snapshot it stored', async () => {
      await service.record(invocation({ snapshotText: 'hello' }));

      const data = prisma._tx.supervisorInvocation.create.mock.calls[0][0].data;
      expect(data.snapshotHash).toBe(hashSnapshot('hello'));
      expect(data.snapshotHash).toHaveLength(64);
    });

    it('rejects an unknown action class rather than opening a new bin', async () => {
      // ADR-0011: a misspelled class silently starts a measurement bin with
      // one sample in it, and nothing fails until promotion depends on it.
      await expect(
        service.record(invocation(), [
          proposal({ actionClass: 'issue shaping' as never }),
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects the batch before writing anything when one class is unknown', async () => {
      await expect(
        service.record(invocation(), [
          proposal(),
          proposal({ actionClass: 'nope' as never }),
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('stores a declined proposal as a row, not as an absence', async () => {
      await service.record(invocation(), [
        proposal({
          outcome: 'declined',
          summary: 'Nothing to decompose',
          targetKind: 'factory',
          targetRef: undefined,
        }),
      ]);

      const data = prisma._tx.supervisorProposal.create.mock.calls[0][0].data;
      expect(data.outcome).toBe('declined');
      expect(data.targetRef).toBeNull();
    });

    it('carries a null cost through rather than defaulting it to zero', async () => {
      await service.record(invocation({ costUsd: null }));

      const data = prisma._tx.supervisorInvocation.create.mock.calls[0][0].data;
      expect(data.costUsd).toBeNull();
    });
  });

  describe('review', () => {
    it('records the verdict, the reviewer and the time', async () => {
      await service.review('prop-1', 'would_approve', 'user-1', 'reasonable');

      const args = prisma.supervisorProposal.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'prop-1' });
      expect(args.data.review).toBe('would_approve');
      expect(args.data.reviewedById).toBe('user-1');
      expect(args.data.reviewNote).toBe('reasonable');
      expect(args.data.reviewedAt).toBeInstanceOf(Date);
    });

    it('accepts a rejection with no note', async () => {
      // Demanding prose would suppress the fast verdicts that make a review
      // queue survivable, and a rejection with no reason is still evidence.
      await service.review('prop-1', 'would_reject', 'user-1');

      const args = prisma.supervisorProposal.updateMany.mock.calls[0][0];
      expect(args.data.reviewNote).toBeNull();
    });

    it('does not touch the proposal itself', async () => {
      await service.review('prop-1', 'would_approve', 'user-1');

      const data = prisma.supervisorProposal.updateMany.mock.calls[0][0].data;
      // Editing what was proposed would make the approval rate a measurement
      // of hindsight.
      expect(data).not.toHaveProperty('summary');
      expect(data).not.toHaveProperty('reasoning');
      expect(data).not.toHaveProperty('actionClass');
    });

    it('404s on an id that matched nothing', async () => {
      prisma.supervisorProposal.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.review('missing', 'would_approve', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('approvalRates', () => {
    it('lists every registered class, including ones nothing proposed', async () => {
      const rates = await service.approvalRates();

      const ids = rates.map((r) => r.actionClass);
      expect(ids).toContain('run-diagnosis');
      expect(ids).toContain('quarantine-decision');
      expect(ids).toContain('re-dispatch');
    });

    it('reports null, never 0, for a class with nothing reviewed', async () => {
      // 0% says a class always proposes badly. "No evidence" is the opposite
      // conclusion, and it is the one the data supports.
      prisma.supervisorProposal.groupBy.mockResolvedValue([
        {
          actionClass: 'run-diagnosis',
          outcome: 'proposed',
          review: 'pending',
          _count: { _all: 4 },
        },
      ]);

      const rate = (await service.approvalRates()).find(
        (r) => r.actionClass === 'run-diagnosis',
      );

      expect(rate?.proposed).toBe(4);
      expect(rate?.pendingReview).toBe(4);
      expect(rate?.approvalRate).toBeNull();
    });

    it('divides by judged proposals only', async () => {
      prisma.supervisorProposal.groupBy.mockResolvedValue([
        {
          actionClass: 'issue-shaping',
          outcome: 'proposed',
          review: 'would_approve',
          _count: { _all: 3 },
        },
        {
          actionClass: 'issue-shaping',
          outcome: 'proposed',
          review: 'would_reject',
          _count: { _all: 1 },
        },
        {
          actionClass: 'issue-shaping',
          outcome: 'proposed',
          review: 'pending',
          _count: { _all: 10 },
        },
      ]);

      const rate = (await service.approvalRates()).find(
        (r) => r.actionClass === 'issue-shaping',
      );

      // An unreviewed backlog must not look like a failing class.
      expect(rate?.approvalRate).toBeCloseTo(0.75);
      expect(rate?.pendingReview).toBe(10);
    });

    it('keeps declined proposals out of the approval fraction', async () => {
      prisma.supervisorProposal.groupBy.mockResolvedValue([
        {
          actionClass: 'decomposition',
          outcome: 'declined',
          review: 'pending',
          _count: { _all: 9 },
        },
        {
          actionClass: 'decomposition',
          outcome: 'proposed',
          review: 'would_approve',
          _count: { _all: 1 },
        },
      ]);

      const rate = (await service.approvalRates()).find(
        (r) => r.actionClass === 'decomposition',
      );

      // Having correctly nothing to say must not count against a proposer.
      expect(rate?.declined).toBe(9);
      expect(rate?.proposed).toBe(1);
      expect(rate?.approvalRate).toBe(1);
    });

    it('windows by createdAt when asked', async () => {
      const since = new Date('2026-08-17T00:00:00.000Z');
      await service.approvalRates(since);

      expect(prisma.supervisorProposal.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { createdAt: { gte: since } } }),
      );
    });

    it('returns a stable order', async () => {
      const ids = (await service.approvalRates()).map((r) => r.actionClass);
      expect(ids).toEqual([...ids].sort());
    });
  });

  describe('listProposals', () => {
    it('orders newest first with an id tie-break, so paging cannot skip a row', async () => {
      await service.listProposals({ page: 2, pageSize: 25 });

      const args = prisma.supervisorProposal.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.skip).toBe(25);
      expect(args.take).toBe(25);
    });

    it('builds a filter only from the parameters that were supplied', async () => {
      await service.listProposals({
        page: 1,
        pageSize: 10,
        review: 'pending',
      });

      const args = prisma.supervisorProposal.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ review: 'pending' });
    });

    it('carries snapshot truncation onto each proposal', async () => {
      prisma.supervisorProposal.findMany.mockResolvedValue([
        {
          id: 'prop-1',
          invocationId: 'inv-1',
          actionClass: 'run-diagnosis',
          outcome: 'proposed',
          summary: 's',
          reasoning: 'r',
          targetKind: 'run',
          targetRef: 'run-1',
          details: null,
          review: 'pending',
          reviewedAt: null,
          reviewNote: null,
          createdAt: STARTED,
          invocation: { snapshotTruncated: true },
        },
      ]);

      const { items } = await service.listProposals({ page: 1, pageSize: 10 });

      expect(items[0].snapshotTruncated).toBe(true);
      expect(items[0].createdAt).toBe(STARTED.toISOString());
    });
  });

  describe('getInvocation', () => {
    it('404s when there is none', async () => {
      await expect(service.getInvocation('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the stored snapshot text verbatim', async () => {
      prisma.supervisorInvocation.findUnique.mockResolvedValue({
        id: 'inv-1',
        startedAt: STARTED,
        finishedAt: FINISHED,
        durationMs: 4500,
        outcome: 'completed',
        model: 'small-model-1',
        snapshotText: '# Factory snapshot\n',
        snapshotHash: hashSnapshot('# Factory snapshot\n'),
        snapshotGeneratedAt: STARTED,
        snapshotTruncated: false,
        snapshotCharacters: 20,
        costUsd: { toNumber: () => 0.02 },
        tokensInput: 900,
        tokensOutput: 120,
        failureReason: null,
      });

      const view = await service.getInvocation('inv-1');

      expect(view.snapshotText).toBe('# Factory snapshot\n');
      expect(view.costUsd).toBe(0.02);
      expect(view.snapshotGeneratedAt).toBe(STARTED.toISOString());
    });
  });
});
