import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';

/**
 * The two things worth testing: that every row names its subject, and that the
 * three enum vocabularies are translated in BOTH directions.
 *
 * The second is where this endpoint would actually break. Postgres cannot hold
 * a dot in an enum label, so the client says `run_started` while the wire, the
 * runners and the cockpit say `run.started` — and `source` is spelled
 * differently again. The compiler catches the type mismatch and NOT the source
 * one, which is how that nearly shipped in #164.
 */
describe('EventsService', () => {
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: '22222222-2222-2222-2222-222222222222',
      type: 'run_progress',
      source: 'runner',
      occurredAt: new Date('2026-08-23T01:30:00Z'),
      runId: '11111111-1111-1111-1111-111111111111',
      summary: 'Edited apps/api/src/foo.ts',
      run: { workOrder: { identity: 'wo_opifex_312_a3f91c2_a1' } },
      ...overrides,
    };
  }

  let findMany: jest.Mock;
  let count: jest.Mock;
  let service: EventsService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row()]);
    count = jest.fn().mockResolvedValue(1);
    service = new EventsService({
      runEvent: { findMany, count },
    } as unknown as PrismaService);
  });

  describe('every row names its subject', () => {
    it('carries the work order IDENTITY, not a row id', async () => {
      // A feed of "edited a file" with no subject is a list of sentences
      // nobody can act on, and a uuid tells a human nothing.
      const { items } = await service.feed({});

      expect(items[0].workOrderId).toBe('wo_opifex_312_a3f91c2_a1');
      expect(items[0].runId).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('joins through the run to get it', async () => {
      await service.feed({});

      expect(findMany.mock.calls[0][0].select.run).toEqual({
        select: { workOrder: { select: { identity: true } } },
      });
    });
  });

  describe('translating out of the database', () => {
    it.each([
      ['run_started', 'run.started'],
      ['run_heartbeat', 'run.heartbeat'],
      ['run_progress', 'run.progress'],
      ['run_blocked', 'run.blocked'],
      ['run_completed', 'run.completed'],
      ['run_failed', 'run.failed'],
    ])('turns %s into %s', async (stored, wire) => {
      findMany.mockResolvedValue([row({ type: stored })]);

      const { items } = await service.feed({});

      expect(items[0].type).toBe(wire);
    });

    it.each([
      ['runner', 'runner'],
      ['git', 'git'],
      ['control_plane', 'control-plane'],
    ])('turns source %s into %s', async (stored, wire) => {
      // The one the compiler cannot catch: both are strings and both are
      // plausible, so a missed translation ships a label the cockpit maps to
      // nothing.
      findMany.mockResolvedValue([row({ source: stored })]);

      const { items } = await service.feed({});

      expect(items[0].source).toBe(wire);
    });
  });

  describe('translating INTO the database', () => {
    it('filters on the stored spelling when given the wire one', async () => {
      // A caller asking for `run.started` — the only name that appears in the
      // schema, in a runner's output, or in this API's own responses — would
      // otherwise match nothing and get an empty feed rather than an error.
      await service.feed({ type: 'run.started' });

      expect(findMany.mock.calls[0][0].where.type).toBe('run_started');
    });

    it('does the same for the source, which is spelled differently again', async () => {
      await service.feed({ source: 'control-plane' });

      expect(findMany.mock.calls[0][0].where.source).toBe('control_plane');
    });

    it.each([
      ['runner', 'runner'],
      ['git', 'git'],
      ['control-plane', 'control_plane'],
    ])('maps source filter %s to %s', async (given, stored) => {
      await service.feed({ source: given });

      expect(findMany.mock.calls[0][0].where.source).toBe(stored);
    });

    it('applies no filter when none is asked for', async () => {
      await service.feed({});

      expect(findMany.mock.calls[0][0].where).toEqual({});
    });

    it('round-trips: what comes out can be filtered back in', async () => {
      // The property that makes the two directions consistent. If they
      // disagreed, an operator clicking a row's own type to filter by it would
      // get nothing back.
      findMany.mockResolvedValue([
        row({ type: 'run_blocked', source: 'control_plane' }),
      ]);
      const { items } = await service.feed({});

      await service.feed({ type: items[0].type, source: items[0].source });

      expect(findMany.mock.calls[1][0].where).toEqual({
        type: 'run_blocked',
        source: 'control_plane',
      });
    });
  });

  describe('the feed itself', () => {
    it('is newest first, with the tiebreak that makes paging stable', async () => {
      // Two events can share a reported millisecond; an unstable sort would
      // shuffle them between pages so a reader sees one twice and another
      // never.
      await service.feed({});

      expect(findMany.mock.calls[0][0].orderBy).toEqual([
        { occurredAt: 'desc' },
        { recordedAt: 'desc' },
      ]);
    });

    it('defaults to the 20 the dashboard panel asks for', async () => {
      // RunEvent is high-volume: a feed nobody can keep up with is not more
      // informative than one they can.
      await service.feed({});

      expect(findMany.mock.calls[0][0].take).toBe(20);
    });

    it('paginates', async () => {
      await service.feed({ page: 3, pageSize: 10 });

      expect(findMany.mock.calls[0][0].skip).toBe(20);
      expect(findMany.mock.calls[0][0].take).toBe(10);
    });

    it('counts against the SAME filter it queried with', async () => {
      await service.feed({ type: 'run.failed' });

      expect(count.mock.calls[0][0].where).toEqual(
        findMany.mock.calls[0][0].where,
      );
    });

    it('returns an empty page rather than failing on a quiet factory', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      const page = await service.feed({});

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });
  });
});
