import { NotFoundException } from '@nestjs/common';

import { UNRESOLVED } from '../escalations/escalations.service';
import { PrismaService } from '../prisma/prisma.service';
import { RunsService } from './runs.service';

/**
 * The two decisions worth testing here are what `needsAttention` MEANS and how
 * the timeline is ordered. Field copying gets one assertion; the rest goes to
 * the parts that would be silently wrong.
 */
describe('RunsService', () => {
  function runRow(overrides: Record<string, unknown> = {}) {
    return {
      id: '11111111-1111-1111-1111-111111111111',
      status: 'running',
      startedAt: new Date('2026-08-23T01:00:00Z'),
      lastEventAt: new Date('2026-08-23T01:30:00Z'),
      attentionReason: null as string | null,
      resumesAt: null as Date | null,
      runnerKey: 'claude-code-local',
      costUsd: { toNumber: () => 1.25 },
      pullRequestUrl: null as string | null,
      workOrder: {
        identity: 'wo_opifex_312_a3f91c2_a1',
        issueNumber: 312,
        issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
        issueTitle: 'Add a permit search prompt builder',
        baseCommit: 'a3f91c2000000000000000000000000000000000',
        attempt: 1,
        branch: 'factory/312-a3f91c2-a1',
        repository: { owner: 'marinoscar', name: 'opifex' },
      },
      ...overrides,
    };
  }

  function eventRow(overrides: Record<string, unknown> = {}) {
    return {
      id: '22222222-2222-2222-2222-222222222222',
      type: 'run_progress',
      source: 'runner',
      occurredAt: new Date('2026-08-23T01:30:00Z'),
      runId: '11111111-1111-1111-1111-111111111111',
      summary: 'Edited apps/api/src/foo.ts',
      ...overrides,
    };
  }

  let findMany: jest.Mock;
  let count: jest.Mock;
  let findUnique: jest.Mock;
  let eventFindMany: jest.Mock;
  let eventCount: jest.Mock;
  let service: RunsService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([runRow()]);
    count = jest.fn().mockResolvedValue(1);
    findUnique = jest.fn().mockResolvedValue(runRow());
    eventFindMany = jest.fn().mockResolvedValue([eventRow()]);
    eventCount = jest.fn().mockResolvedValue(1);

    service = new RunsService({
      run: { findMany, count, findUnique },
      runEvent: { findMany: eventFindMany, count: eventCount },
    } as unknown as PrismaService);
  });

  describe('explicit ordering (#82)', () => {
    const orderBy = () => findMany.mock.calls[0][0].orderBy;

    it('orders by the column the operator asked for', async () => {
      await service.list({ sort: 'startedAt', direction: 'asc' });
      expect(orderBy()).toEqual([{ startedAt: 'asc' }]);
    });

    it('defaults an explicit sort to descending', async () => {
      await service.list({ sort: 'startedAt' });
      expect(orderBy()).toEqual([{ startedAt: 'desc' }]);
    });

    it('puts a run that never reported first when sorting silence ascending', async () => {
      // A null `lastEventAt` is a run that has never reported anything — the
      // worst case, not a missing value to sort past. #82 calls this "the
      // operationally important one".
      await service.list({ sort: 'lastEventAt', direction: 'asc' });
      expect(orderBy()).toEqual([
        { lastEventAt: { sort: 'asc', nulls: 'first' } },
      ]);
    });

    it('puts it last when sorting silence descending', async () => {
      await service.list({ sort: 'lastEventAt', direction: 'desc' });
      expect(orderBy()).toEqual([
        { lastEventAt: { sort: 'desc', nulls: 'last' } },
      ]);
    });

    it('keeps unreported cost last in both directions', async () => {
      // Null cost means NOT REPORTED (VISION §6 makes cost reporting a declared
      // capability), so it must not sort as the cheapest run or the priciest.
      for (const direction of ['asc', 'desc'] as const) {
        findMany.mockClear();
        await service.list({ sort: 'costUsd', direction });
        expect(orderBy()).toEqual([
          { costUsd: { sort: direction, nulls: 'last' } },
        ]);
      }
    });

    it('breaks a status tie by recency, so the order is stable', async () => {
      await service.list({ sort: 'status', direction: 'asc' });
      expect(orderBy()).toEqual([{ status: 'asc' }, { startedAt: 'desc' }]);
    });

    it('an explicit sort wins over the attention default', async () => {
      // The operator asked. The attention ordering is a DEFAULT, not a rule.
      await service.list({ needsAttention: true, sort: 'costUsd' });
      expect(orderBy()).toEqual([{ costUsd: { sort: 'desc', nulls: 'last' } }]);
    });
  });

  describe('needsAttention', () => {
    it('means an escalation nobody has acknowledged or resolved', async () => {
      // NOT a status list. `status IN (stalled, failed, quarantined)` never
      // drains — a run that failed last Tuesday is still failed today, so the
      // panel fills with history and today's problem is on page three. The
      // escalation lifecycle is the thing #57 built to be resolved.
      await service.list({ needsAttention: true });

      expect(findMany.mock.calls[0][0].where).toEqual({
        escalations: { some: { status: { in: UNRESOLVED } } },
      });
    });

    it('reuses the escalation service list rather than declaring its own', async () => {
      // Two lists would drift, and the two disagreeing means the panel shows a
      // run nobody will be told about, or hides one somebody already was.
      await service.list({ needsAttention: true });

      const statuses =
        findMany.mock.calls[0][0].where.escalations.some.status.in;
      expect(statuses).toBe(UNRESOLVED);
      expect([...statuses].sort()).toEqual([
        'delivered',
        'dispatched',
        'failed',
        'raised',
      ]);
    });

    it('orders by longest silence first, never-reported at the very top', async () => {
      // `lastEventAt` is the age the panel is about: a run working happily for
      // six hours is not the problem, one silent for six minutes is. A run
      // that has never reported anything is the WORST case, not a null to sort
      // past.
      await service.list({ needsAttention: true });

      expect(findMany.mock.calls[0][0].orderBy).toEqual([
        { lastEventAt: { sort: 'asc', nulls: 'first' } },
      ]);
    });

    it('orders an unfiltered list newest first instead', async () => {
      // A list screen wants recency; the attention panel wants urgency. They
      // are different questions and must not share an order.
      await service.list({});

      expect(findMany.mock.calls[0][0].orderBy).toEqual([
        { startedAt: 'desc' },
      ]);
    });

    it('applies no escalation filter when not asked for', async () => {
      await service.list({});
      expect(findMany.mock.calls[0][0].where).toEqual({});
    });

    it('does NOT list a run whose only signal is attentionReason', async () => {
      // A real, reachable state: the poller writes attentionReason the moment
      // it finds a run with no handle, before any escalation exists. The lag
      // is deliberate and bounded — the watchdog sweeps stalled runs too, so
      // it escalates on a later tick. Widening the filter to cover it would
      // trade a bounded lag for an unbounded one, since nothing ever clears
      // attentionReason and the panel would never drain.
      await service.list({ needsAttention: true });

      expect(JSON.stringify(findMany.mock.calls[0][0].where)).not.toContain(
        'attentionReason',
      );
    });

    it('combines with a status filter', async () => {
      await service.list({ needsAttention: true, status: 'stalled' });

      expect(findMany.mock.calls[0][0].where).toMatchObject({
        status: 'stalled',
        escalations: { some: { status: { in: UNRESOLVED } } },
      });
    });
  });

  describe('the run summary', () => {
    it('keeps attentionReason and resumesAt as separate fields', async () => {
      // VISION §9 gives three failure modes three responses, and the
      // operator's next move is decided by WHICH of these is populated. One
      // merged "message" would destroy exactly that distinction — the cockpit
      // calls it the most expensive mistake this UI can make.
      findMany.mockResolvedValue([
        runRow({
          status: 'blocked',
          attentionReason: null,
          resumesAt: new Date('2026-08-23T05:00:00Z'),
        }),
      ]);

      const { items } = await service.list({});

      expect(items[0].attentionReason).toBeNull();
      expect(items[0].resumesAt).toBe('2026-08-23T05:00:00.000Z');
    });

    it('carries an attention reason without inventing a resume time', async () => {
      findMany.mockResolvedValue([
        runRow({ status: 'stalled', attentionReason: 'silent for 12 minutes' }),
      ]);

      const { items } = await service.list({});

      expect(items[0].attentionReason).toBe('silent for 12 minutes');
      expect(items[0].resumesAt).toBeNull();
    });

    it('converts the cost Decimal to a number', async () => {
      // Prisma hands back a Decimal. Left unconverted it serializes as an
      // object and the cockpit renders "[object Object]".
      const { items } = await service.list({});
      expect(items[0].costUsd).toBe(1.25);
    });

    it('keeps a missing cost as null rather than zero', async () => {
      // "The runner reports no cost" and "this run was free" are different
      // claims, and a zero on the cost screen is the expensive one to get
      // wrong.
      findMany.mockResolvedValue([runRow({ costUsd: null })]);

      const { items } = await service.list({});

      expect(items[0].costUsd).toBeNull();
    });

    it('shortens the base commit and names the runner', async () => {
      const { items } = await service.list({});

      expect(items[0].workOrder.baseCommit).toBe('a3f91c2');
      expect(items[0].workOrder.repository).toBe('marinoscar/opifex');
      expect(items[0].runner).toBe('claude-code-local');
    });

    it('reports lastEventAt as null when nothing has been reported', async () => {
      findMany.mockResolvedValue([runRow({ lastEventAt: null })]);

      const { items } = await service.list({});

      expect(items[0].lastEventAt).toBeNull();
    });
  });

  describe('one run', () => {
    it('returns it', async () => {
      const run = await service.findById(
        '11111111-1111-1111-1111-111111111111',
      );
      expect(run.id).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('404s rather than returning null', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.findById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('the event timeline', () => {
    it('is paginated', async () => {
      // #80: RunEvent is high-volume (#39) and an unpaginated timeline "will
      // not survive a real run" — one run emits a progress event per tool call
      // plus heartbeats.
      await service.events('11111111-1111-1111-1111-111111111111', {
        page: 2,
        pageSize: 10,
      });

      expect(eventFindMany.mock.calls[0][0].skip).toBe(10);
      expect(eventFindMany.mock.calls[0][0].take).toBe(10);
    });

    it('defaults to a bounded page rather than everything', async () => {
      await service.events('11111111-1111-1111-1111-111111111111', {});

      expect(eventFindMany.mock.calls[0][0].take).toBe(50);
    });

    it('breaks timestamp ties so paging cannot duplicate or skip a row', async () => {
      // Two events can share a reported timestamp — a runner emitting several
      // in the same millisecond — and an unstable sort would shuffle them
      // between pages.
      await service.events('11111111-1111-1111-1111-111111111111', {});

      expect(eventFindMany.mock.calls[0][0].orderBy).toEqual([
        { occurredAt: 'desc' },
        { recordedAt: 'desc' },
      ]);
    });

    it('translates the Prisma enum back to the wire spelling', async () => {
      // Postgres cannot hold a dot in an enum label, so the generated client
      // says `run_started`. Every runner, the schema and the cockpit say
      // `run.started`. Returning the client's spelling would put a name in
      // front of an operator that appears nowhere in the documents.
      eventFindMany.mockResolvedValue([eventRow({ type: 'run_started' })]);

      const { items } = await service.events(
        '11111111-1111-1111-1111-111111111111',
        {},
      );

      expect(items[0].type).toBe('run.started');
    });

    it('translates the source too, which is spelled differently again', async () => {
      eventFindMany.mockResolvedValue([eventRow({ source: 'control_plane' })]);

      const { items } = await service.events(
        '11111111-1111-1111-1111-111111111111',
        {},
      );

      expect(items[0].source).toBe('control-plane');
    });

    it('shows the work order IDENTITY, not its row id', async () => {
      // Rendered to a human in the mono token. A uuid tells them nothing.
      const { items } = await service.events(
        '11111111-1111-1111-1111-111111111111',
        {},
      );

      expect(items[0].workOrderId).toBe('wo_opifex_312_a3f91c2_a1');
    });

    it('404s for a run that does not exist', async () => {
      // "No events yet" and "no such run" are different answers, and returning
      // the first for a mistyped id sends somebody hunting for a runner that
      // never started.
      findUnique.mockResolvedValue(null);

      await expect(service.events('missing', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(eventFindMany).not.toHaveBeenCalled();
    });

    it('reports an empty timeline for a real run with no events', async () => {
      eventFindMany.mockResolvedValue([]);
      eventCount.mockResolvedValue(0);

      const page = await service.events(
        '11111111-1111-1111-1111-111111111111',
        {},
      );

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });
  });

  describe('pagination', () => {
    it('reports the page it served, not the one it was asked for blindly', async () => {
      count.mockResolvedValue(87);

      const page = await service.list({ page: 3, pageSize: 10 });

      expect(page).toMatchObject({ page: 3, pageSize: 10, total: 87 });
      expect(findMany.mock.calls[0][0].skip).toBe(20);
    });

    it('counts against the SAME filter it queried with', async () => {
      // A total computed over a different where clause is a pager that walks
      // off the end of the results.
      await service.list({ needsAttention: true });

      expect(count.mock.calls[0][0].where).toEqual(
        findMany.mock.calls[0][0].where,
      );
    });
  });
});
