import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { serializeWorkOrder } from '../work-orders/work-order-document';
import { generateWorkOrder } from '../work-orders/work-order-generator';
import { WorkOrdersService } from './work-orders.service';

/**
 * The property that matters is that `document` is THE authorized document.
 *
 * Everything else here is field copying. The assertion that would catch a real
 * regression is the byte comparison against `serializeWorkOrder` — the same
 * function that produced what was committed to the branch and posted to the
 * issue — because a second rendering that merely looks right is exactly the
 * failure #63 exists to make impossible.
 */
describe('WorkOrdersService', () => {
  const BASE = 'a3f91c2000000000000000000000000000000000';

  /** The generator's own output, so nothing here is hand-assembled. */
  function generated(overrides: Record<string, unknown> = {}) {
    const result = generateWorkOrder({
      issue: {
        repository: { owner: 'marinoscar', name: 'opifex' },
        issueNumber: 312,
        title: 'Add a permit search prompt builder',
        issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
        taskSpec: 'Add a permit search prompt builder to the chat surface.',
        acceptanceCriteria: [
          'Searching by address returns the matching permits',
          'An empty result set renders the empty state',
        ],
        pathConstraints: ['apps/api/**'],
        decisionRefs: ['ADR-0042'],
        needs: ['full-streaming'],
        ...overrides,
      },
      baseCommit: BASE,
      attempt: 1,
      budgetCeilingUsd: 5,
      wallClockTimeoutMinutes: 30,
    });
    if (!result.ok) throw new Error('fixture did not generate');
    return result.workOrder;
  }

  function row(overrides: Record<string, unknown> = {}) {
    const w = generated();
    return {
      id: '11111111-1111-1111-1111-111111111111',
      identity: w.identity,
      branch: w.branch,
      issueNumber: w.issueNumber,
      issueUrl: w.issueUrl,
      issueTitle: w.issueTitle,
      baseCommit: w.baseCommit,
      attempt: w.attempt,
      taskSpec: w.taskSpec,
      acceptanceCriteria: w.acceptanceCriteria,
      pathConstraints: w.pathConstraints,
      decisionRefs: w.decisionRefs,
      needs: w.needs,
      // The column, as the select returns it. Null is the ordinary case and
      // the fixture says so rather than omitting the field — an omitted
      // optional in a fixture is exactly how #273 went unnoticed.
      modelTier: (w.modelTier ?? null) as string | null,
      budgetCeilingUsd: w.budgetCeilingUsd,
      wallClockTimeoutMinutes: w.wallClockTimeoutMinutes,
      status: 'queued',
      holdReason: null as string | null,
      queuedAt: new Date('2026-08-23T01:00:00Z'),
      createdAt: new Date('2026-08-23T00:30:00Z'),
      authorizationCommentUrl: null as string | null,
      repository: { owner: 'marinoscar', name: 'opifex' },
      runs: [] as unknown[],
      _count: { runs: 0 },
      ...overrides,
    };
  }

  let findMany: jest.Mock;
  let findFirst: jest.Mock;
  let count: jest.Mock;
  let service: WorkOrdersService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row()]);
    findFirst = jest.fn().mockResolvedValue(row());
    count = jest.fn().mockResolvedValue(1);

    service = new WorkOrdersService({
      workOrder: { findMany, findFirst, count },
    } as unknown as PrismaService);
  });

  describe('the authorized document', () => {
    it('serializes byte-identically to what was committed and posted', () => {
      // The assertion the whole endpoint exists for. A document that merely
      // LOOKS right would pass a field-by-field comparison and still make
      // #84's authorization-record view an illustration rather than a check.
      return service
        .findOne('11111111-1111-1111-1111-111111111111')
        .then((detail) => {
          const expected = serializeWorkOrder(generated());
          expect(`${JSON.stringify(detail.document, null, 2)}\n`).toBe(
            expected,
          );
        });
    });

    it('carries the schema version, so a reader knows what shape they have', async () => {
      const detail = await service.findOne(
        '11111111-1111-1111-1111-111111111111',
      );
      expect(detail.document.schemaVersion).toBeTruthy();
    });

    it('refuses a row whose identity its own coordinates do not derive', async () => {
      // Serving the raw columns anyway would put a document in front of an
      // operator that nothing ever authorized.
      findFirst.mockResolvedValue(
        row({ identity: 'wo_something-else_312_a3f91c2_a1' }),
      );

      await expect(service.findOne('anything')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('refuses a row declaring a need this build does not understand', async () => {
      findFirst.mockResolvedValue(row({ needs: ['gpu-attached'] }));

      await expect(service.findOne('anything')).rejects.toThrow(/gpu-attached/);
    });

    it('names the row in the refusal, since the caller has only an id', async () => {
      findFirst.mockResolvedValue(
        row({ identity: 'wo_something-else_312_a3f91c2_a1' }),
      );

      await expect(service.findOne('anything')).rejects.toThrow(
        /wo_something-else_312_a3f91c2_a1/,
      );
    });
  });

  describe('the model tier (#273)', () => {
    it('renders in the document when the row carries one', async () => {
      // Not colocated with the byte-identical test above on purpose: that
      // test's default fixture has never carried a tier, which is the exact
      // shape #273 hid in. This exercises the field the round trip above
      // does not.
      findFirst.mockResolvedValue(row({ modelTier: 'large' }));

      const detail = await service.findOne('x');

      const expected = serializeWorkOrder(generated({ modelTier: 'large' }));
      expect(`${JSON.stringify(detail.document, null, 2)}\n`).toBe(expected);
    });

    it('omits the key entirely when the column is null', async () => {
      const detail = await service.findOne(
        '11111111-1111-1111-1111-111111111111',
      );

      expect('modelTier' in detail.document).toBe(false);
    });

    it('refuses a row whose stored tier this build does not understand', async () => {
      // `rehydrateWorkOrder` refuses rather than drops it: silently dropping
      // would render the document as though nothing had been asked for.
      findFirst.mockResolvedValue(row({ modelTier: 'enormous' }));

      await expect(service.findOne('anything')).rejects.toThrow(/enormous/);
    });
  });

  describe('looking one up', () => {
    it('accepts the identity, which is the string an operator actually has', async () => {
      // It is what the authorization record shows and what the branch encodes.
      // Making them paste a uuid they have never seen would be a lookup key
      // chosen for the database's convenience.
      await service.findOne('wo_opifex_312_a3f91c2_a1');

      expect(findFirst.mock.calls[0][0].where).toEqual({
        identity: 'wo_opifex_312_a3f91c2_a1',
      });
    });

    it('accepts a row id too', async () => {
      await service.findOne('11111111-1111-1111-1111-111111111111');

      expect(findFirst.mock.calls[0][0].where).toEqual({
        id: '11111111-1111-1111-1111-111111111111',
      });
    });

    it('404s rather than returning null', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('the base commit', () => {
    it('is returned IN FULL on the detail, because it is meant to be checked out', async () => {
      // A 7-character prefix is not a git ref you can rely on resolving in a
      // repository with enough history.
      const detail = await service.findOne(
        '11111111-1111-1111-1111-111111111111',
      );

      expect(detail.baseCommit).toBe(BASE);
      expect(detail.baseCommit).toHaveLength(40);
    });

    it('is shortened on the LIST, where it is a label in a table', async () => {
      const { items } = await service.list({});

      expect(items[0].baseCommit).toBe('a3f91c2');
    });
  });

  describe('provenance', () => {
    it('carries the authorization comment URL as a first-class field', async () => {
      // The traversable edge VISION §5 rests on. Reconstructing it from the
      // issue URL would be a guess about where dispatch posted.
      findFirst.mockResolvedValue(
        row({
          authorizationCommentUrl:
            'https://github.com/o/r/issues/312#issuecomment-9',
        }),
      );

      const detail = await service.findOne('x');

      expect(detail.authorizationCommentUrl).toBe(
        'https://github.com/o/r/issues/312#issuecomment-9',
      );
    });

    it('is null before dispatch has posted it, not an empty string', async () => {
      const detail = await service.findOne(
        '11111111-1111-1111-1111-111111111111',
      );
      expect(detail.authorizationCommentUrl).toBeNull();
    });
  });

  describe('the list', () => {
    it('is newest first — history, not dispatch order', async () => {
      // Unlike /queue, whose order IS its answer.
      await service.list({});

      expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
    });

    it('lists every status, not just the waiting ones', async () => {
      await service.list({});

      expect(findMany.mock.calls[0][0].where).toEqual({});
    });

    it('filters by status when asked', async () => {
      await service.list({ status: 'quarantined' });

      expect(findMany.mock.calls[0][0].where).toEqual({
        status: 'quarantined',
      });
    });

    it('splits owner/name for a repository filter', async () => {
      await service.list({ repository: 'marinoscar/opifex' });

      expect(findMany.mock.calls[0][0].where).toEqual({
        repository: { owner: 'marinoscar', name: 'opifex' },
      });
    });

    it('counts runs, which is what #66 judges decomposition on', async () => {
      findMany.mockResolvedValue([row({ _count: { runs: 3 } })]);

      const { items } = await service.list({});

      expect(items[0].runCount).toBe(3);
    });

    it('counts against the SAME filter it queried with', async () => {
      await service.list({ status: 'failed' });

      expect(count.mock.calls[0][0].where).toEqual(
        findMany.mock.calls[0][0].where,
      );
    });

    it('falls back to the issue number when there is no title', async () => {
      findMany.mockResolvedValue([row({ issueTitle: null })]);

      const { items } = await service.list({});

      expect(items[0].issueTitle).toBe('Issue #312');
    });
  });

  describe('runs on the detail', () => {
    it('converts the cost Decimal and keeps a missing one null', async () => {
      findFirst.mockResolvedValue(
        row({
          runs: [
            {
              id: '22222222-2222-2222-2222-222222222222',
              status: 'succeeded',
              runnerKey: 'claude-code-local',
              startedAt: new Date('2026-08-23T02:00:00Z'),
              endedAt: new Date('2026-08-23T02:30:00Z'),
              costUsd: { toNumber: () => 2.5 } as unknown,
              pullRequestUrl: 'https://github.com/o/r/pull/9',
            },
            {
              id: '33333333-3333-3333-3333-333333333333',
              status: 'failed',
              runnerKey: 'claude-code-local',
              startedAt: new Date('2026-08-23T03:00:00Z'),
              endedAt: null,
              costUsd: null,
              pullRequestUrl: null,
            },
          ],
        }),
      );

      const detail = await service.findOne('x');

      expect(detail.runs[0].costUsd).toBe(2.5);
      expect(detail.runs[1].costUsd).toBeNull();
      expect(detail.runs[1].endedAt).toBeNull();
    });
  });
});
