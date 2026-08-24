import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotService, SNAPSHOT_WINDOW_DAYS } from './snapshot.service';
import { DEFAULT_SNAPSHOT_LIMITS } from './snapshot.types';

/** A Prisma `Decimal`, as far as anything here is concerned. */
const decimal = (value: number) => ({ toNumber: () => value });

const NOW = new Date('2026-08-24T12:00:00.000Z');

function prismaDouble() {
  return {
    run: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    workOrder: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    escalation: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'stalled',
    runnerKey: 'claude-code-local',
    startedAt: new Date('2026-08-24T10:00:00.000Z'),
    endedAt: null,
    lastEventAt: new Date('2026-08-24T11:30:00.000Z'),
    attemptCount: 2,
    costUsd: decimal(1.25),
    attentionReason: 'silent for 30m',
    stopReason: null,
    pullRequestNumber: null,
    pullRequestState: null,
    workOrder: {
      identity: 'wo_opifex_312_a3f91c2_a1',
      issueNumber: 312,
      issueTitle: 'Add the thing',
      repository: { owner: 'marinoscar', name: 'opifex' },
    },
    ...overrides,
  };
}

describe('SnapshotService (#88)', () => {
  let prisma: ReturnType<typeof prismaDouble>;
  let service: SnapshotService;

  beforeEach(() => {
    prisma = prismaDouble();
    service = new SnapshotService(prisma as unknown as PrismaService);
  });

  describe('collect', () => {
    it('reports zero for a status groupBy omits entirely', () => {
      // groupBy returns no row for a status with no rows. Anything other than
      // zero here would put `undefined` in the totals line.
      return service.collect(NOW).then((input) => {
        expect(input.totals.runsRunning).toBe(0);
        expect(input.totals.workOrdersQuarantined).toBe(0);
      });
    });

    it('reads counts out of the groupBy result', async () => {
      prisma.run.groupBy.mockResolvedValue([
        { status: 'running', _count: { _all: 3 } },
        { status: 'stalled', _count: { _all: 1 } },
      ]);
      prisma.workOrder.groupBy.mockResolvedValue([
        { status: 'queued', _count: { _all: 7 } },
        { status: 'held', _count: { _all: 2 } },
      ]);

      const input = await service.collect(NOW);

      expect(input.totals.runsRunning).toBe(3);
      expect(input.totals.runsStalled).toBe(1);
      expect(input.totals.runsBlocked).toBe(0);
      expect(input.totals.workOrdersQueued).toBe(7);
      expect(input.totals.workOrdersHeld).toBe(2);
    });

    it('windows the succeeded/failed counts from the supplied instant', async () => {
      await service.collect(NOW);

      const since = new Date(
        NOW.getTime() - SNAPSHOT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      expect(prisma.run.count).toHaveBeenCalledWith({
        where: { status: 'succeeded', endedAt: { gte: since } },
      });
      expect(prisma.run.count).toHaveBeenCalledWith({
        where: { status: 'failed', endedAt: { gte: since } },
      });
    });

    it('fetches one more row than the cap, so the dropped count is measured not guessed', async () => {
      await service.collect(NOW);

      const takes = prisma.run.findMany.mock.calls.map(
        (call) => (call[0] as { take: number }).take,
      );
      expect(takes).toContain(DEFAULT_SNAPSHOT_LIMITS.attentionRuns + 1);
      expect(takes).toContain(DEFAULT_SNAPSHOT_LIMITS.recentRuns + 1);
    });

    it('orders attention runs by silence with never-seen runs first', async () => {
      await service.collect(NOW);

      const attentionQuery = prisma.run.findMany.mock.calls.find((call) =>
        JSON.stringify(call[0]).includes('stalled'),
      )?.[0] as { orderBy: unknown[] };

      expect(attentionQuery.orderBy[0]).toEqual({
        lastEventAt: { sort: 'asc', nulls: 'first' },
      });
      // A total order. Two runs silent since the same instant must not swap
      // places between snapshots, or a re-render stops being comparable.
      expect(attentionQuery.orderBy[1]).toEqual({ id: 'asc' });
    });

    it('narrows a run row to plain values, flattening the repository', async () => {
      prisma.run.findMany.mockResolvedValueOnce([runRow()]);

      const input = await service.collect(NOW);

      expect(input.attentionRuns[0]).toEqual({
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
        attemptCount: 2,
        costUsd: 1.25,
        attentionReason: 'silent for 30m',
        stopReason: null,
        pullRequestNumber: null,
        pullRequestState: null,
      });
    });

    it('carries a null cost through rather than defaulting it to zero', async () => {
      prisma.run.findMany.mockResolvedValueOnce([runRow({ costUsd: null })]);

      const input = await service.collect(NOW);

      expect(input.attentionRuns[0].costUsd).toBeNull();
    });

    it('counts acceptance criteria rather than carrying their text', async () => {
      prisma.workOrder.findMany.mockResolvedValueOnce([
        {
          identity: 'wo_opifex_401_bbbbbbb_a1',
          issueNumber: 401,
          issueTitle: 'Queued thing',
          status: 'queued',
          attempt: 1,
          acceptanceCriteria: ['a', 'b', 'c'],
          createdAt: new Date('2026-08-24T09:00:00.000Z'),
          repository: { owner: 'marinoscar', name: 'opifex' },
        },
      ]);

      const input = await service.collect(NOW);

      expect(input.queuedWorkOrders[0].acceptanceCriteriaCount).toBe(3);
    });

    it('holds no state between invocations', async () => {
      // VISION §7's whole requirement. Two collects must each issue their own
      // queries — a cache here is the context drift the section describes.
      await service.collect(NOW);
      const after = prisma.run.groupBy.mock.calls.length;
      await service.collect(NOW);

      expect(prisma.run.groupBy.mock.calls.length).toBe(after * 2);
    });
  });

  describe('render', () => {
    it('returns the input beside the text it produced', async () => {
      prisma.run.findMany.mockResolvedValueOnce([runRow()]);

      const { input, rendered } = await service.render(NOW);

      expect(input.generatedAt).toBe(NOW);
      expect(rendered.text).toContain('# Factory snapshot');
      expect(rendered.text).toContain('wo_opifex_312_a3f91c2_a1');
      expect(rendered.characters).toBe(rendered.text.length);
    });

    it('renders the same text twice for the same database state', async () => {
      prisma.run.findMany.mockResolvedValue([runRow()]);

      const first = await service.render(NOW);
      const second = await service.render(NOW);

      expect(first.rendered.text).toBe(second.rendered.text);
    });
  });
});
