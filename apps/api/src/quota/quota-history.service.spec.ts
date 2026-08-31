import type { PrismaService } from '../prisma/prisma.service';
import { QuotaHistoryService } from './quota-history.service';

/**
 * Prisma is a double here, same discipline as `quota.service.spec.ts`: what
 * is under test is the query SHAPE this service builds — filter translation,
 * pagination, and how the loaded rows are assembled into `EpisodeFacts` — not
 * whether Postgres can store a row. Every branch of what those rows MEAN
 * (`deriveDisposition`, `toEpisode`, `matchWindow`) is covered without a
 * database in `quota-history.spec.ts`; this file only covers what genuinely
 * lives in the query layer.
 */
describe('QuotaHistoryService', () => {
  let runEventFindMany: jest.Mock;
  let runEventCount: jest.Mock;
  let escalationFindMany: jest.Mock;
  let quotaWindowFindMany: jest.Mock;
  let quotaWindowCount: jest.Mock;
  let service: QuotaHistoryService;

  function baseRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'event-1',
      occurredAt: new Date('2026-08-25T10:00:00.000Z'),
      blockedReason: 'rate-limit',
      blockedUntil: new Date('2026-08-25T15:00:00.000Z'),
      runId: 'run-1',
      run: {
        runnerKey: 'claude-code-local',
        status: 'blocked',
        resumesAt: new Date('2026-08-25T15:05:00.000Z'),
        endedAt: null,
        lastEventAt: null,
        workOrder: {
          identity: 'WO-1',
          issueNumber: 42,
          repository: { owner: 'acme', name: 'widgets' },
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    runEventFindMany = jest.fn().mockResolvedValue([]);
    runEventCount = jest.fn().mockResolvedValue(0);
    escalationFindMany = jest.fn().mockResolvedValue([]);
    quotaWindowFindMany = jest.fn().mockResolvedValue([]);
    quotaWindowCount = jest.fn().mockResolvedValue(0);

    service = new QuotaHistoryService({
      runEvent: { findMany: runEventFindMany, count: runEventCount },
      escalation: { findMany: escalationFindMany },
      quotaWindow: { findMany: quotaWindowFindMany, count: quotaWindowCount },
    } as unknown as PrismaService);
  });

  describe('episodes', () => {
    it('defaults the reason filter to BOTH subscription-level reasons', async () => {
      await service.episodes({});

      const where = runEventFindMany.mock.calls[0]![0].where;
      expect(where.blockedReason).toEqual({
        not: null,
        in: ['rate-limit', 'quota-exhausted'],
      });
    });

    it('narrows to a single reason when one is requested', async () => {
      await service.episodes({ reason: 'quota-exhausted' });

      const where = runEventFindMany.mock.calls[0]![0].where;
      expect(where.blockedReason).toEqual({
        not: null,
        in: ['quota-exhausted'],
      });
    });

    it('translates since/until into plain occurredAt bounds', async () => {
      await service.episodes({
        since: '2026-08-25T00:00:00.000Z',
        until: '2026-08-26T00:00:00.000Z',
      });

      const where = runEventFindMany.mock.calls[0]![0].where;
      expect(where.occurredAt).toEqual({
        gte: new Date('2026-08-25T00:00:00.000Z'),
        lte: new Date('2026-08-26T00:00:00.000Z'),
      });
    });

    it('omits occurredAt entirely when neither since nor until is given', async () => {
      await service.episodes({});

      const where = runEventFindMany.mock.calls[0]![0].where;
      expect(where.occurredAt).toBeUndefined();
    });

    it('filters by the RUN’s runnerKey, not a column on the event', async () => {
      await service.episodes({ runnerKey: 'claude-code-local' });

      const where = runEventFindMany.mock.calls[0]![0].where;
      expect(where.run).toEqual({ runnerKey: 'claude-code-local' });
    });

    it('paginates with the default page size and page 1', async () => {
      await service.episodes({});

      const args = runEventFindMany.mock.calls[0]![0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(25);
    });

    it('computes skip from an explicit page and pageSize', async () => {
      await service.episodes({ page: 3, pageSize: 10 });

      const args = runEventFindMany.mock.calls[0]![0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it('reports totalPages from the count, independent of the page returned', async () => {
      runEventCount.mockResolvedValue(47);

      const result = await service.episodes({ pageSize: 10 });

      expect(result.total).toBe(47);
      expect(result.totalPages).toBe(5);
    });

    it('returns an empty page without querying blocks/escalations/windows', async () => {
      runEventFindMany.mockResolvedValueOnce([]);
      runEventCount.mockResolvedValue(0);

      const result = await service.episodes({});

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 0,
      });
      // Only the page query and its count ran — no follow-up queries for a
      // page with nothing on it.
      expect(escalationFindMany).not.toHaveBeenCalled();
      expect(quotaWindowFindMany).not.toHaveBeenCalled();
    });

    it('assembles EpisodeFacts from the joined row shape and interprets it', async () => {
      runEventFindMany.mockResolvedValueOnce([baseRow()]);
      runEventCount.mockResolvedValue(1);
      // blocksByRun's own findMany call (second runEvent.findMany call)
      runEventFindMany.mockResolvedValueOnce([]);

      const result = await service.episodes({});

      expect(result.items).toHaveLength(1);
      const episode = result.items[0]!;
      expect(episode.eventId).toBe('event-1');
      expect(episode.runId).toBe('run-1');
      expect(episode.repository).toBe('acme/widgets');
      expect(episode.workOrderIdentity).toBe('WO-1');
      expect(episode.issueNumber).toBe(42);
      // Latest block (no later block loaded), run blocked, resume scheduled.
      expect(episode.disposition).toBe('parked');
    });

    it('loads the run’s OTHER blocks unfiltered by the page’s since/until', async () => {
      // nextBlockAt has to be the run's actual next block even when it falls
      // outside the requested window — the doc comment on `blocksByRun` is
      // explicit about this. Assert the follow-up query carries no date
      // bound of its own.
      runEventFindMany.mockResolvedValueOnce([baseRow()]);
      runEventCount.mockResolvedValue(1);
      runEventFindMany.mockResolvedValueOnce([]);

      await service.episodes({
        since: '2026-08-25T00:00:00.000Z',
        until: '2026-08-25T12:00:00.000Z',
      });

      const blocksArgs = runEventFindMany.mock.calls[1]![0];
      expect(blocksArgs.where.occurredAt).toBeUndefined();
      expect(blocksArgs.where.runId).toEqual({ in: ['run-1'] });
    });

    it('derives nextBlockAt from a later block on the same run, bounding the episode', async () => {
      const laterBlock = new Date('2026-08-25T16:00:00.000Z');
      runEventFindMany.mockResolvedValueOnce([
        baseRow({ run: { ...baseRow().run, status: 'succeeded' } }),
      ]);
      runEventCount.mockResolvedValue(1);
      runEventFindMany.mockResolvedValueOnce([
        { runId: 'run-1', occurredAt: laterBlock },
      ]);

      const result = await service.episodes({});

      const episode = result.items[0]!;
      expect(episode.nextActivityAt).toBe(laterBlock.toISOString());
      expect(episode.disposition).toBe('resumed');
    });

    it('passes escalations through only to the run that raised them', async () => {
      runEventFindMany.mockResolvedValueOnce([baseRow()]);
      runEventCount.mockResolvedValue(1);
      runEventFindMany.mockResolvedValueOnce([]);
      escalationFindMany.mockResolvedValueOnce([
        {
          runId: 'run-1',
          kind: 'system',
          status: 'open',
          raisedAt: new Date('2026-08-25T10:30:00.000Z'),
          summary: 'undated block',
        },
        // No runId at all — must not blow up, and must not attach anywhere.
        {
          runId: null,
          kind: 'system',
          status: 'open',
          raisedAt: new Date('2026-08-25T10:30:00.000Z'),
          summary: 'orphaned row',
        },
      ]);

      const result = await service.episodes({});

      const episode = result.items[0]!;
      expect(episode.disposition).toBe('escalated');
      expect(episode.escalation?.summary).toBe('undated block');
    });

    it('matches the stored window on runner and exact reset instant', async () => {
      runEventFindMany.mockResolvedValueOnce([baseRow()]);
      runEventCount.mockResolvedValue(1);
      runEventFindMany.mockResolvedValueOnce([]);
      quotaWindowFindMany.mockResolvedValueOnce([
        {
          runnerKey: 'claude-code-local',
          kind: 'five_hour',
          resetsAt: new Date('2026-08-25T15:00:00.000Z'),
          pressure: 'allowed',
          peakPressure: 'exhausted',
          firstObservedAt: new Date('2026-08-25T10:00:00.000Z'),
          lastObservedAt: new Date('2026-08-25T14:55:00.000Z'),
          observations: 12,
        },
      ]);

      const result = await service.episodes({});

      expect(result.items[0]!.window).toEqual({
        kind: 'five_hour',
        resetsAt: '2026-08-25T15:00:00.000Z',
        pressure: 'allowed',
        peakPressure: 'exhausted',
        firstObservedAt: '2026-08-25T10:00:00.000Z',
        lastObservedAt: '2026-08-25T14:55:00.000Z',
        observations: 12,
      });
    });

    it('leaves window null when nothing stored carries the reset instant', async () => {
      runEventFindMany.mockResolvedValueOnce([baseRow()]);
      runEventCount.mockResolvedValue(1);
      runEventFindMany.mockResolvedValueOnce([]);
      quotaWindowFindMany.mockResolvedValueOnce([]);

      const result = await service.episodes({});

      expect(result.items[0]!.window).toBeNull();
    });

    it('does not issue a follow-up query per row — fixed query count for a multi-row page', async () => {
      const rowA = baseRow({ id: 'event-1', runId: 'run-1' });
      const rowB = baseRow({
        id: 'event-2',
        runId: 'run-2',
        run: { ...baseRow().run, runnerKey: 'other-runner' },
      });
      runEventFindMany.mockResolvedValueOnce([rowA, rowB]);
      runEventCount.mockResolvedValue(2);
      runEventFindMany.mockResolvedValueOnce([]); // blocksByRun

      await service.episodes({});

      // page query + blocksByRun query = 2 calls to runEvent.findMany, not
      // one per row.
      expect(runEventFindMany).toHaveBeenCalledTimes(2);
      expect(escalationFindMany).toHaveBeenCalledTimes(1);
      expect(quotaWindowFindMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('exhaustedWindows', () => {
    function windowRow(overrides: Record<string, unknown> = {}) {
      return {
        runnerKey: 'claude-code-local',
        kind: 'five_hour',
        resetsAt: new Date('2026-08-25T15:00:00.000Z'),
        pressure: 'allowed',
        peakPressure: 'exhausted',
        firstObservedAt: new Date('2026-08-25T10:00:00.000Z'),
        lastObservedAt: new Date('2026-08-25T14:55:00.000Z'),
        observations: 12,
        ...overrides,
      };
    }

    it('filters on peakPressure exhausted, never on pressure', async () => {
      await service.exhaustedWindows({});

      const where = quotaWindowFindMany.mock.calls[0]![0].where;
      expect(where.peakPressure).toBe('exhausted');
      expect(where.pressure).toBeUndefined();
    });

    it('translates since/until into an OVERLAP test against the observation span', async () => {
      // since -> lastObservedAt >= since; until -> firstObservedAt <= until.
      // This is what lets a window first sighted before the range but still
      // exhausted inside it be returned — a plain comparison against
      // resetsAt would miss it entirely.
      await service.exhaustedWindows({
        since: '2026-08-25T12:00:00.000Z',
        until: '2026-08-25T13:00:00.000Z',
      });

      const where = quotaWindowFindMany.mock.calls[0]![0].where;
      expect(where.lastObservedAt).toEqual({
        gte: new Date('2026-08-25T12:00:00.000Z'),
      });
      expect(where.firstObservedAt).toEqual({
        lte: new Date('2026-08-25T13:00:00.000Z'),
      });
    });

    it('filters by runnerKey when given', async () => {
      await service.exhaustedWindows({ runnerKey: 'claude-code-local' });

      const where = quotaWindowFindMany.mock.calls[0]![0].where;
      expect(where.runnerKey).toBe('claude-code-local');
    });

    it('returns blockedRuns: 0 for a window that hit the wall with nothing dispatched', async () => {
      // #476's named acceptance criterion: a window with no run_events row
      // at all must still be returned, distinguishably, as blockedRuns: 0.
      quotaWindowFindMany.mockResolvedValueOnce([windowRow()]);
      quotaWindowCount.mockResolvedValue(1);
      runEventFindMany.mockResolvedValueOnce([]); // blocksAgainst: nothing blocked

      const result = await service.exhaustedWindows({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.blockedRuns).toBe(0);
      expect(result.items[0]!.blockedEvents).toBe(0);
    });

    it('counts distinct runs and total events for a window that DID block runs', async () => {
      quotaWindowFindMany.mockResolvedValueOnce([windowRow()]);
      quotaWindowCount.mockResolvedValue(1);
      runEventFindMany.mockResolvedValueOnce([
        {
          runId: 'run-1',
          blockedUntil: new Date('2026-08-25T15:00:00.000Z'),
          run: { runnerKey: 'claude-code-local' },
        },
        // Same run blocking twice against the same window.
        {
          runId: 'run-1',
          blockedUntil: new Date('2026-08-25T15:00:00.000Z'),
          run: { runnerKey: 'claude-code-local' },
        },
        {
          runId: 'run-2',
          blockedUntil: new Date('2026-08-25T15:00:00.000Z'),
          run: { runnerKey: 'claude-code-local' },
        },
      ]);

      const result = await service.exhaustedWindows({});

      expect(result.items[0]!.blockedRuns).toBe(2); // distinct runs
      expect(result.items[0]!.blockedEvents).toBe(3); // total blocked events
    });

    it('returns an empty page without querying blocksAgainst', async () => {
      quotaWindowFindMany.mockResolvedValueOnce([]);
      quotaWindowCount.mockResolvedValue(0);

      const result = await service.exhaustedWindows({});

      expect(result.items).toEqual([]);
      expect(runEventFindMany).not.toHaveBeenCalled();
    });

    it('paginates with page/pageSize and reports totalPages from the count', async () => {
      quotaWindowFindMany.mockResolvedValueOnce([windowRow()]);
      quotaWindowCount.mockResolvedValue(30);
      runEventFindMany.mockResolvedValueOnce([]);

      const result = await service.exhaustedWindows({ page: 2, pageSize: 10 });

      const args = quotaWindowFindMany.mock.calls[0]![0];
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
      expect(result.totalPages).toBe(3);
    });
  });
});
