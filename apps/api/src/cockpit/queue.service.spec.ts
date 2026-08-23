import { DispatchService } from '../dispatch/dispatch.service';
import type { DispatchDecision } from '../dispatch/dispatch-policy';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';

/**
 * The read model, not the rows.
 *
 * What is under test is the question the endpoint answers — "why is this not
 * running yet" — because that is the part the `work_orders` table cannot
 * answer on its own. Field copying is asserted once; the state mapping and the
 * headroom arithmetic get the coverage, since those are the decisions.
 */
describe('QueueService', () => {
  const REPOSITORY = { owner: 'marinoscar', name: 'opifex' };

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: '11111111-1111-1111-1111-111111111111',
      identity: 'wo_opifex_312_a3f91c2_a1',
      branch: 'factory/312-a3f91c2-a1',
      issueNumber: 312,
      issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
      issueTitle: 'Add a permit search prompt builder',
      baseCommit: 'a3f91c2000000000000000000000000000000000',
      attempt: 1,
      needs: [] as string[],
      status: 'queued',
      holdReason: null as string | null,
      queuedAt: new Date('2026-08-23T01:00:00Z'),
      createdAt: new Date('2026-08-23T00:30:00Z'),
      repository: REPOSITORY,
      ...overrides,
    };
  }

  function decision(
    overrides: Partial<DispatchDecision> = {},
  ): DispatchDecision {
    return {
      outcome: 'dispatch',
      runnerKey: 'claude-code-local',
      queueReason: null,
      reason: 'Dispatch to claude-code-local, with 2 slot(s) free.',
      candidates: [
        {
          runnerKey: 'claude-code-local',
          eligible: true,
          reason: 'has 2 slot(s) free',
          unmetNeeds: [],
          headroom: 2,
        },
      ],
      ...overrides,
    };
  }

  const QUEUED_FULL = decision({
    outcome: 'queued',
    runnerKey: null,
    queueReason: 'capable-runners-are-at-capacity',
    reason: 'Queued: every capable runner is at capacity.',
    candidates: [],
  });

  let findMany: jest.Mock;
  let decide: jest.Mock;
  let service: QueueService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row()]);
    decide = jest.fn().mockResolvedValue(decision());

    service = new QueueService(
      { workOrder: { findMany } } as unknown as PrismaService,
      { decide } as unknown as DispatchService,
    );
  });

  describe('which rows it lists', () => {
    it('lists queued and held work orders and nothing else', async () => {
      // NOT `dispatched`: that work order has a Run and belongs to the runs
      // screen. Listing it here too would double-count the same work and make
      // queue depth read high while the factory is busy working through it.
      await service.list();

      expect(findMany.mock.calls[0][0].where).toEqual({
        status: { in: ['queued', 'held'] },
      });
    });

    it('orders the way the dispatch pass drains, held rows last', async () => {
      // This is what makes `position` a fact rather than a decoration:
      // position 1 is the work order the next tick actually picks up.
      await service.list();

      expect(findMany.mock.calls[0][0].orderBy).toEqual([
        { queuedAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
      ]);
    });

    it('returns an empty list without asking the dispatch policy', async () => {
      findMany.mockResolvedValue([]);

      const entries = await service.list();

      expect(entries).toEqual([]);
      expect(decide).not.toHaveBeenCalled();
    });
  });

  describe('the work order reference', () => {
    it('shortens the base commit to seven characters', async () => {
      // The cockpit's type says "already shortened upstream", so it is the
      // API's job. Leaving it to the browser would put a second opinion about
      // identity where #62 says there must not be one.
      const [entry] = await service.list();

      expect(entry.workOrder.baseCommit).toBe('a3f91c2');
    });

    it('carries the identity and branch verbatim rather than recomposed', async () => {
      // Re-run idempotency rests on these strings matching exactly.
      const [entry] = await service.list();

      expect(entry.workOrder.id).toBe('wo_opifex_312_a3f91c2_a1');
      expect(entry.workOrder.branch).toBe('factory/312-a3f91c2-a1');
    });

    it('renders the repository as owner/name', async () => {
      const [entry] = await service.list();
      expect(entry.workOrder.repository).toBe('marinoscar/opifex');
    });

    it('falls back to the issue number when there is no title', async () => {
      // `issueTitle` is nullable on the row and the cockpit's type is not.
      findMany.mockResolvedValue([row({ issueTitle: null })]);

      const [entry] = await service.list();

      expect(entry.workOrder.title).toBe('Issue #312');
    });

    it('turns an empty issue URL into null', async () => {
      // The column defaults to '' for rows written before #154. The cockpit
      // renders null as "no link"; '' would render as a broken one.
      findMany.mockResolvedValue([row({ issueUrl: '' })]);

      const [entry] = await service.list();

      expect(entry.workOrder.issueUrl).toBeNull();
    });
  });

  describe('why a work order is not running', () => {
    it('is ready when a runner could take it right now', async () => {
      const [entry] = await service.list();

      expect(entry.state).toBe('ready');
      expect(entry.waitingOn).toBeNull();
    });

    it('is waiting when every capable runner is full', async () => {
      decide.mockResolvedValue(QUEUED_FULL);

      const [entry] = await service.list();

      expect(entry.state).toBe('waiting');
    });

    it('reuses the policy sentence rather than paraphrasing it', async () => {
      // #64 requires that selection reasoning is recorded. An operator
      // comparing the queue panel against the dispatch log should read the
      // same sentence in both.
      decide.mockResolvedValue(QUEUED_FULL);

      const [entry] = await service.list();

      expect(entry.waitingOn).toBe(
        'Queued: every capable runner is at capacity.',
      );
    });

    it('is held when a human paused it, whatever the fleet says', async () => {
      // A policy outcome outranks a scheduling one: a held work order is not
      // "ready" just because a runner has capacity.
      findMany.mockResolvedValue([row({ status: 'held' })]);

      const [entry] = await service.list();

      expect(entry.state).toBe('held');
    });

    it('names the mechanism when a hold carries no reason', async () => {
      // A factory:hold label records no reason of its own. Returning null
      // would render as "nothing is blocking this", which is the opposite of
      // the truth.
      findMany.mockResolvedValue([row({ status: 'held', holdReason: null })]);

      const [entry] = await service.list();

      expect(entry.waitingOn).toMatch(/factory:hold/);
    });

    it('uses the stored reason when a hold has one', async () => {
      findMany.mockResolvedValue([
        row({
          status: 'held',
          holdReason: 'Quarantined: identity disagrees with itself',
        }),
      ]);

      const [entry] = await service.list();

      expect(entry.waitingOn).toBe(
        'Quarantined: identity disagrees with itself',
      );
    });

    it('never reports dispatching', async () => {
      // A work order stops being `queued` the instant its Run row is created,
      // inside the same pass — there is no committed state between the two for
      // this endpoint to observe. Emitting it would invent a transition the
      // database never holds.
      findMany.mockResolvedValue([row(), row({ id: 'b', status: 'held' })]);

      const entries = await service.list();

      expect(entries.map((e) => e.state)).not.toContain('dispatching');
    });
  });

  describe('headroom is consumed down the list', () => {
    it('marks only as many ready as the fleet can actually take', async () => {
      // Two free slots and three queued work orders: reporting all three ready
      // would tell the operator three things can start when one cannot.
      findMany.mockResolvedValue([
        row({ id: 'a' }),
        row({ id: 'b' }),
        row({ id: 'c' }),
      ]);

      const entries = await service.list();

      expect(entries.map((e) => e.state)).toEqual([
        'ready',
        'ready',
        'waiting',
      ]);
    });

    it('says the slots are taken, not that it is dispatching', async () => {
      // The policy's own sentence begins "Dispatch to claude-code-local…",
      // which on a row that is NOT dispatching reads as though it is. Reusing
      // it here was a real bug, caught by a probe against a fleet with finite
      // headroom and three rows to fit into it — the double could not, because
      // the double had never run out.
      findMany.mockResolvedValue([
        row({ id: 'a' }),
        row({ id: 'b' }),
        row({ id: 'c' }),
      ]);

      const entries = await service.list();

      expect(entries[2].waitingOn).not.toMatch(/^Dispatch to/);
      expect(entries[2].waitingOn).toContain('free slot');
      expect(entries[2].waitingOn).toContain('claude-code-local');
    });

    it('still reuses the policy sentence when the POLICY refused it', async () => {
      // #64: selection reasoning is recorded, and the two places an operator
      // reads it must agree. This is the case where that still applies.
      decide.mockResolvedValue(QUEUED_FULL);
      findMany.mockResolvedValue([row({ id: 'a' })]);

      const entries = await service.list();

      expect(entries[0].waitingOn).toBe(
        'Queued: every capable runner is at capacity.',
      );
    });

    it('does not let a held row consume a slot', async () => {
      // A held work order is not going to start, so it must not push a queued
      // one that could into `waiting`.
      findMany.mockResolvedValue([
        row({ id: 'a', status: 'held' }),
        row({ id: 'b' }),
        row({ id: 'c' }),
      ]);

      const entries = await service.list();

      expect(entries.map((e) => e.state)).toEqual(['held', 'ready', 'ready']);
    });

    it('marks nothing ready when the fleet has no headroom at all', async () => {
      decide.mockResolvedValue(
        decision({
          candidates: [{ ...decision().candidates[0], headroom: 0 }],
        }),
      );
      findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

      const entries = await service.list();

      expect(entries.map((e) => e.state)).toEqual(['waiting', 'waiting']);
    });
  });

  describe('asking the dispatch policy', () => {
    it('asks once per distinct needs set, not once per row', async () => {
      // Two queries per row on a panel that polls every thirty seconds is how
      // a read model becomes the most expensive thing in the system.
      findMany.mockResolvedValue([
        row({ id: 'a', needs: [] }),
        row({ id: 'b', needs: [] }),
        row({ id: 'c', needs: ['own-infrastructure'] }),
      ]);

      await service.list();

      expect(decide).toHaveBeenCalledTimes(2);
    });

    it('treats the same needs in a different order as one set', async () => {
      findMany.mockResolvedValue([
        row({ id: 'a', needs: ['full-streaming', 'cost-reporting'] }),
        row({ id: 'b', needs: ['cost-reporting', 'full-streaming'] }),
      ]);

      await service.list();

      expect(decide).toHaveBeenCalledTimes(1);
    });

    it('routes each row against ITS OWN needs decision', async () => {
      // A work order needing own-infrastructure can be waiting while one
      // needing nothing is ready, and vice versa.
      decide.mockImplementation(async (needs: string[]) =>
        needs.length > 0 ? QUEUED_FULL : decision(),
      );
      findMany.mockResolvedValue([
        row({ id: 'a', needs: ['own-infrastructure'] }),
        row({ id: 'b', needs: [] }),
      ]);

      const entries = await service.list();

      expect(entries.map((e) => e.state)).toEqual(['waiting', 'ready']);
    });
  });

  describe('position and enqueuedAt', () => {
    it('numbers positions from one, in list order', async () => {
      findMany.mockResolvedValue([
        row({ id: 'a' }),
        row({ id: 'b' }),
        row({ id: 'c' }),
      ]);

      const entries = await service.list();

      expect(entries.map((e) => e.position)).toEqual([1, 2, 3]);
    });

    it('uses queuedAt when the work order is queued', async () => {
      const [entry] = await service.list();
      expect(entry.enqueuedAt).toBe('2026-08-23T01:00:00.000Z');
    });

    it('falls back to createdAt for a held row, which has no queuedAt', async () => {
      // #155 nulls queuedAt on a hold so releasing one cannot jump the queue.
      findMany.mockResolvedValue([row({ status: 'held', queuedAt: null })]);

      const [entry] = await service.list();

      expect(entry.enqueuedAt).toBe('2026-08-23T00:30:00.000Z');
    });
  });

  describe('the limit', () => {
    it('passes the caller limit through to the query', async () => {
      await service.list(5);
      expect(findMany.mock.calls[0][0].take).toBe(5);
    });

    it('defaults rather than fetching the whole table', async () => {
      await service.list();
      expect(findMany.mock.calls[0][0].take).toBe(25);
    });
  });
});
