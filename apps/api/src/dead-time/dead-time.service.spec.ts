import { PrismaService } from '../prisma/prisma.service';
import { DeadTimeService, type DeadObservation } from './dead-time.service';

const NOW = new Date('2026-08-21T12:00:00Z');
const RUN = '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d';

function openRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'interval-1',
    runId: RUN,
    kind: 'stalled',
    startedAt: new Date(NOW.getTime() - 60 * 60_000),
    run: {
      status: 'stalled',
      lastEventAt: new Date(NOW.getTime() - 60 * 60_000),
      endedAt: null,
    },
    ...overrides,
  };
}

function stalled(since: Date, runId = RUN): DeadObservation {
  return { runId, kind: 'stalled', since };
}

describe('DeadTimeService', () => {
  let prisma: {
    deadInterval: {
      findMany: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: DeadTimeService;

  beforeEach(() => {
    prisma = {
      deadInterval: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new DeadTimeService(prisma as unknown as PrismaService);
  });

  describe('opening', () => {
    it('opens an interval at when progress STOPPED, not at the tick', async () => {
      const stoppedAt = new Date(NOW.getTime() - 47 * 60_000);

      const result = await service.record([stalled(stoppedAt)], [RUN], NOW);

      expect(result.opened).toBe(1);
      expect(prisma.deadInterval.create).toHaveBeenCalledWith({
        data: { runId: RUN, kind: 'stalled', startedAt: stoppedAt },
      });
    });

    it('does not open a second interval for a run that already has one', async () => {
      prisma.deadInterval.findMany.mockResolvedValue([openRow()]);

      const result = await service.record(
        [stalled(new Date(NOW.getTime() - 60 * 60_000))],
        [RUN],
        NOW,
      );

      expect(prisma.deadInterval.create).not.toHaveBeenCalled();
      expect(prisma.deadInterval.updateMany).not.toHaveBeenCalled();
      expect(result.open).toBe(1);
    });
  });

  describe('closing', () => {
    it('closes as RESUMED at the event that brought the run back', async () => {
      const cameBackAt = new Date(NOW.getTime() - 3 * 60_000);
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({
          run: { status: 'running', lastEventAt: cameBackAt, endedAt: null },
        }),
      ]);

      // Judged this sweep, and no longer observed as making no progress.
      const result = await service.record([], [RUN], NOW);

      expect(result.resumed).toBe(1);
      expect(prisma.deadInterval.updateMany).toHaveBeenCalledWith({
        where: { id: 'interval-1', endedAt: null },
        data: { endedAt: cameBackAt, endedBy: 'resumed' },
      });
    });

    it('closes as CONCLUDED at the run end when the run finished while stalled', async () => {
      const endedAt = new Date(NOW.getTime() - 5 * 60_000);
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({
          run: { status: 'succeeded', lastEventAt: endedAt, endedAt },
        }),
      ]);

      const result = await service.record([], [], NOW);

      expect(result.concluded).toBe(1);
      expect(prisma.deadInterval.updateMany).toHaveBeenCalledWith({
        where: { id: 'interval-1', endedAt: null },
        data: { endedAt, endedBy: 'concluded' },
      });
    });

    /**
     * Kept distinct from `concluded`: a quarantined run did not finish, and by
     * VISION §8 it cannot clear its own quarantine.
     */
    it('closes as QUARANTINED, not concluded', async () => {
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({
          run: { status: 'quarantined', lastEventAt: null, endedAt: null },
        }),
      ]);

      const result = await service.record([], [], NOW);

      expect(result.quarantined).toBe(1);
      expect(result.concluded).toBe(0);
      expect(prisma.deadInterval.updateMany).toHaveBeenCalledWith({
        where: { id: 'interval-1', endedAt: null },
        data: { endedAt: NOW, endedBy: 'quarantined' },
      });
    });

    /**
     * A conclusion beats a stale observation from the same sweep: the detector
     * ran milliseconds before the terminal event landed, and a run that has
     * concluded is not still stalled.
     */
    it('closes a concluded run even when the sweep still reported it stalled', async () => {
      const endedAt = new Date(NOW.getTime() - 60_000);
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({ run: { status: 'failed', lastEventAt: endedAt, endedAt } }),
      ]);

      const result = await service.record(
        [stalled(new Date(NOW.getTime() - 60 * 60_000))],
        [RUN],
        NOW,
      );

      expect(result.concluded).toBe(1);
      expect(prisma.deadInterval.create).not.toHaveBeenCalled();
    });

    /** Guarded in the WHERE clause so two overlapping ticks close it once. */
    it('guards the close on the interval still being open', async () => {
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({
          run: { status: 'running', lastEventAt: NOW, endedAt: null },
        }),
      ]);

      await service.record([], [RUN], NOW);

      const call = prisma.deadInterval.updateMany.mock.calls[0][0];
      expect(call.where.endedAt).toBeNull();
    });

    /**
     * A negative duration would SUBTRACT from the window and make a bad day
     * look better than a good one.
     */
    it('never ends an interval before it began', async () => {
      const startedAt = new Date(NOW.getTime() - 10 * 60_000);
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({
          startedAt,
          run: {
            status: 'succeeded',
            lastEventAt: null,
            // A runner stamping `occurredAt` from its own skewed clock.
            endedAt: new Date(NOW.getTime() - 40 * 60_000),
          },
        }),
      ]);

      await service.record([], [], NOW);

      const call = prisma.deadInterval.updateMany.mock.calls[0][0];
      expect(call.data.endedAt).toEqual(startedAt);
    });
  });

  describe('a run that stalled twice', () => {
    /**
     * #232: "one interval per stall, not one per run, or a run that stalled
     * twice reports only its last."
     */
    it('closes the first interval and opens a second', async () => {
      const firstStop = new Date(NOW.getTime() - 120 * 60_000);
      const secondStop = new Date(NOW.getTime() - 30 * 60_000);
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({
          startedAt: firstStop,
          run: {
            status: 'stalled',
            lastEventAt: secondStop,
            endedAt: null,
          },
        }),
      ]);

      const result = await service.record([stalled(secondStop)], [RUN], NOW);

      expect(result.resumed).toBe(1);
      expect(result.opened).toBe(1);
      // The first stall ends exactly where the second begins: the event that
      // revived the run is the one it then went silent after.
      expect(prisma.deadInterval.updateMany).toHaveBeenCalledWith({
        where: { id: 'interval-1', endedAt: null },
        data: { endedAt: secondStop, endedBy: 'resumed' },
      });
      expect(prisma.deadInterval.create).toHaveBeenCalledWith({
        data: { runId: RUN, kind: 'stalled', startedAt: secondStop },
      });
    });

    it('closes and reopens when a stalled run becomes parked', async () => {
      const blockedSince = new Date(NOW.getTime() - 20 * 60_000);
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow({
          run: {
            status: 'blocked',
            lastEventAt: blockedSince,
            endedAt: null,
          },
        }),
      ]);

      const result = await service.record(
        [{ runId: RUN, kind: 'parked', since: blockedSince }],
        [RUN],
        NOW,
      );

      expect(result.resumed).toBe(1);
      expect(prisma.deadInterval.create).toHaveBeenCalledWith({
        data: { runId: RUN, kind: 'parked', startedAt: blockedSince },
      });
    });
  });

  describe('a run the sweep did not look at', () => {
    /**
     * The same rule `reconciler.task.ts` applies to escalations: a run that
     * dropped out of the sweep has not recovered, it has vanished. Closing its
     * interval would report the dead time as over on the strength of not
     * having looked.
     */
    it('leaves its interval OPEN', async () => {
      prisma.deadInterval.findMany.mockResolvedValue([openRow()]);

      const result = await service.record([], [], NOW);

      expect(prisma.deadInterval.updateMany).not.toHaveBeenCalled();
      expect(result.open).toBe(1);
      expect(result.resumed).toBe(0);
    });

    it('leaves every interval open when a failed sweep reports nothing', async () => {
      prisma.deadInterval.findMany.mockResolvedValue([
        openRow(),
        openRow({ id: 'interval-2', runId: 'other-run' }),
      ]);

      const result = await service.record([], [], NOW);

      expect(prisma.deadInterval.updateMany).not.toHaveBeenCalled();
      expect(result.open).toBe(2);
    });
  });
});
