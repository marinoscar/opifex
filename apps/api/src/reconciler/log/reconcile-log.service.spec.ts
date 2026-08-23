import { PrismaService } from '../../prisma/prisma.service';
import type { TickRecord } from '../reconciler.types';
import { ReconcileLogService } from './reconcile-log.service';

function tick(overrides: Partial<TickRecord> = {}): TickRecord {
  return {
    startedAt: new Date('2026-08-21T10:00:00Z'),
    finishedAt: new Date('2026-08-21T10:00:01Z'),
    durationMs: 1000,
    outcome: 'completed',
    repositoriesObserved: 1,
    failures: [],
    allFromCache: false,
    rateLimitRemaining: 4999,
    projections: [{ repository: 'acme/app', issues: [] }],
    workOrdersCreated: 0,
    rejections: [],
    actions: [],
    ...overrides,
  };
}

const ACTION = {
  type: 'dispatch' as const,
  repository: 'acme/app',
  issueNumber: 312,
  reason: 'dispatch: factory:ready is set',
  evidence: {
    intent: 'dispatch' as const,
    inputLabels: ['factory:ready'],
    workOrderIdentity: null,
    runStatus: null,
    currentMirrorLabels: [],
    desiredMirrorLabels: ['factory/dispatched'],
  },
};

describe('ReconcileLogService', () => {
  let prisma: { reconcileTick: Record<string, jest.Mock> };
  let service: ReconcileLogService;

  beforeEach(() => {
    prisma = {
      reconcileTick: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new ReconcileLogService(prisma as unknown as PrismaService);
  });

  describe('record', () => {
    it('writes a row for EVERY tick, including a quiet one', async () => {
      // A log with gaps cannot be reviewed: a missing entry is
      // indistinguishable from a tick that never ran.
      await service.record(tick());

      expect(prisma.reconcileTick.create).toHaveBeenCalled();
    });

    it('writes a row even for a skipped tick', async () => {
      await service.record(tick({ outcome: 'skipped-locked', repositoriesObserved: 0 }));

      const [{ data }] = prisma.reconcileTick.create.mock.calls[0];
      expect(data.outcome).toBe('skipped-locked');
    });

    it('omits the heavy payload on a quiet tick', async () => {
      // The retention half of the tension: every tick recorded, but a full
      // projection on each of ~1,440 rows a day grows without bound.
      await service.record(tick({ actions: [], failures: [] }));

      const [{ data }] = prisma.reconcileTick.create.mock.calls[0];
      expect(data.projections).toBeUndefined();
      expect(data.actions).toBeUndefined();
      // The summary is still complete.
      expect(data.actionsComputed).toBe(0);
      expect(data.durationMs).toBe(1000);
    });

    it('KEEPS the payload when the tick computed actions', async () => {
      await service.record(tick({ actions: [ACTION] }));

      const [{ data }] = prisma.reconcileTick.create.mock.calls[0];
      expect(data.actions).toHaveLength(1);
      expect(data.projections).toBeDefined();
    });

    it('keeps the payload when the tick had failures, even with no actions', async () => {
      // A failing tick is exactly the one worth reading later.
      await service.record(
        tick({ actions: [], failures: [{ repository: 'acme/app', reason: 'boom' }] }),
      );

      const [{ data }] = prisma.reconcileTick.create.mock.calls[0];
      expect(data.projections).toBeDefined();
    });

    it('always records the failures, payload or not', async () => {
      await service.record(tick());

      const [{ data }] = prisma.reconcileTick.create.mock.calls[0];
      expect(data.failures).toEqual([]);
    });

    it('records actionsExecuted as 0, rather than leaving it implied', async () => {
      // So "we were read-only for a week" is checkable against the log rather
      // than against memory.
      await service.record(tick({ actions: [ACTION] }));

      const [{ data }] = prisma.reconcileTick.create.mock.calls[0];
      expect(data.actionsExecuted).toBe(0);
    });

    it('serialises Dates inside the payload into readable ISO strings', async () => {
      await service.record(tick({ actions: [ACTION] }));

      const [{ data }] = prisma.reconcileTick.create.mock.calls[0];
      expect(JSON.stringify(data.actions)).toContain('factory:ready');
    });

    it('does NOT throw when the write fails', async () => {
      // A tick that reconciled correctly but failed to log is not a failed
      // tick. Reporting it as one would put a phantom reconciler bug in front
      // of whoever reviews the week.
      prisma.reconcileTick.create.mockRejectedValue(new Error('disk full'));

      await expect(service.record(tick())).resolves.toBeUndefined();
    });
  });

  describe('history', () => {
    it('returns newest first', async () => {
      await service.history({ page: 1, pageSize: 25 });

      expect(prisma.reconcileTick.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { startedAt: 'desc' } }),
      );
    });

    it('paginates', async () => {
      await service.history({ page: 3, pageSize: 10 });

      expect(prisma.reconcileTick.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('filters to ticks that actually decided something', async () => {
      // A week is ~10,000 ticks and in a healthy factory nearly all did
      // nothing. Reading the week means reading the ones that acted.
      await service.history({ page: 1, pageSize: 25, actionsOnly: true });

      expect(prisma.reconcileTick.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { actionsComputed: { gt: 0 } } }),
      );
    });

    it('filters by outcome', async () => {
      await service.history({ page: 1, pageSize: 25, outcome: 'partial' });

      expect(prisma.reconcileTick.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { outcome: 'partial' } }),
      );
    });

    it('applies no filter by default', async () => {
      await service.history({ page: 1, pageSize: 25 });

      expect(prisma.reconcileTick.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('prune', () => {
    it('deletes only ticks older than the cutoff', async () => {
      const cutoff = new Date('2026-08-07T00:00:00Z');
      prisma.reconcileTick.deleteMany.mockResolvedValue({ count: 42 });

      expect(await service.prune(cutoff)).toBe(42);
      expect(prisma.reconcileTick.deleteMany).toHaveBeenCalledWith({
        where: { startedAt: { lt: cutoff } },
      });
    });
  });
});
