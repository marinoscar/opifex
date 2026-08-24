import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TrustGrantStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TrustGrantService, type TrustGrantRow } from './trust-grant.service';
import type { CreateTrustGrantInput } from './trust-grant.types';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const EXPIRES = new Date('2026-09-07T12:00:00.000Z');
const REPO = 'repo-1';

function row(overrides: Partial<TrustGrantRow> = {}): TrustGrantRow {
  return {
    id: 'grant-1',
    actionClass: 're-dispatch',
    repositoryId: REPO,
    expiresAt: EXPIRES,
    budgetCeilingUsd: 25,
    spentUsd: 0,
    actionsAuthorized: 0,
    actionsFailed: 0,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    minActionsBeforeAutoRevoke: 3,
    status: 'active',
    endedAt: null,
    endReason: null,
    endDetail: null,
    revokedById: null,
    note: null,
    grantedById: 'user-1',
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function input(
  overrides: Partial<CreateTrustGrantInput> = {},
): CreateTrustGrantInput {
  return {
    actionClass: 're-dispatch',
    repositoryId: REPO,
    grantedById: 'user-1',
    expiresAt: EXPIRES,
    budgetCeilingUsd: 25,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    ...overrides,
  };
}

/**
 * A Prisma double that actually honours the WHERE clause.
 *
 * Deliberately not a `mockResolvedValue` per call. The property under test —
 * "an expired grant stops authorizing immediately" — IS the WHERE clause, and
 * a double that returns a canned list regardless of the filter would pass
 * whether or not the filter were there. This one applies the filter, so
 * deleting `expiresAt: { gt: now }` from the service turns the test red.
 */
function prismaDouble(rows: TrustGrantRow[] = [], repositoryExists = true) {
  const store = [...rows];

  function matches(r: TrustGrantRow, where: any = {}): boolean {
    if (where.id !== undefined && r.id !== where.id) return false;
    if (where.actionClass !== undefined && r.actionClass !== where.actionClass)
      return false;
    if (
      where.repositoryId !== undefined &&
      r.repositoryId !== where.repositoryId
    )
      return false;
    if (where.status !== undefined && r.status !== where.status) return false;
    const e = where.expiresAt;
    if (e) {
      if (e.gt && !(r.expiresAt.getTime() > e.gt.getTime())) return false;
      if (e.lte && !(r.expiresAt.getTime() <= e.lte.getTime())) return false;
    }
    return true;
  }

  function order(rowsIn: TrustGrantRow[], orderBy: any): TrustGrantRow[] {
    const clauses: any[] = Array.isArray(orderBy)
      ? orderBy
      : orderBy
        ? [orderBy]
        : [];
    return [...rowsIn].sort((a, b) => {
      for (const clause of clauses) {
        const [key, direction] = Object.entries(clause)[0] as [string, string];
        const av = (a as any)[key];
        const bv = (b as any)[key];
        const cmp =
          av instanceof Date
            ? av.getTime() - (bv as Date).getTime()
            : String(av).localeCompare(String(bv));
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  const findMany = jest.fn(async (args: any = {}) => {
    const filtered = order(
      store.filter((r) => matches(r, args.where)),
      args.orderBy,
    );
    return args.take ? filtered.slice(0, args.take) : filtered;
  });

  const update = jest.fn(async (args: any) => {
    const target = store.find((r) => r.id === args.where.id);
    if (!target) throw Object.assign(new Error('not found'), { code: 'P2025' });
    for (const [key, value] of Object.entries(args.data as object)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        (target as any)[key] =
          ((target as any)[key] ?? 0) +
          (value as { increment: number }).increment;
      } else {
        (target as any)[key] = value;
      }
    }
    return target;
  });

  const updateMany = jest.fn(async (args: any) => {
    const targets = store.filter((r) => matches(r, args.where));
    for (const target of targets) Object.assign(target, args.data);
    return { count: targets.length };
  });

  const create = jest.fn(async (args: any) =>
    row({ ...args.data, id: 'new-1' }),
  );

  return {
    store,
    trustGrant: {
      findMany,
      findUnique: jest.fn(
        async (args: any) => store.find((r) => r.id === args.where.id) ?? null,
      ),
      create,
      update,
      updateMany,
    },
    repository: {
      findUnique: jest.fn(async () => (repositoryExists ? { id: REPO } : null)),
    },
  };
}

function serviceOver(...args: Parameters<typeof prismaDouble>) {
  const prisma = prismaDouble(...args);
  return {
    prisma,
    service: new TrustGrantService(prisma as unknown as PrismaService),
  };
}

describe('TrustGrantService (#96)', () => {
  // -------------------------------------------------------------------------
  describe('create', () => {
    it('writes a valid grant', async () => {
      const { prisma, service } = serviceOver();

      const view = await service.create(
        input({ note: 'after 4 clean runs' }),
        NOW,
      );

      expect(prisma.trustGrant.create).toHaveBeenCalledTimes(1);
      const data = prisma.trustGrant.create.mock.calls[0]![0].data;
      expect(data).toMatchObject({
        actionClass: 're-dispatch',
        repositoryId: REPO,
        expiresAt: EXPIRES,
        budgetCeilingUsd: 25,
        maxFailureRate: 0.34,
        maxCostPerActionUsd: 5,
        note: 'after 4 clean runs',
      });
      expect(view.actionClass).toBe('re-dispatch');
    });

    it('leaves minActionsBeforeAutoRevoke to the column default when omitted', async () => {
      const { prisma, service } = serviceOver();

      await service.create(input(), NOW);

      expect(
        prisma.trustGrant.create.mock.calls[0]![0].data,
      ).not.toHaveProperty('minActionsBeforeAutoRevoke');
    });

    it('rejects an unknown action class', async () => {
      // ADR-0011: validated at the boundary. A grant for a class nothing can
      // ever match still reads as "trust granted" on every screen listing it.
      const { service } = serviceOver();

      await expect(
        service.create(
          input({ actionClass: 'refactor-everything' as never }),
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects quarantine-decision, which can never receive a grant', async () => {
      // VISION §7 ranks it last and annotates it "probably never"; VISION §8
      // puts clearing quarantine on the never-trustable list outright. #95
      // enforces the list again at execution time — two independent gates,
      // because a safety property in one place is one refactor from none.
      const { prisma, service } = serviceOver();

      await expect(
        service.create(input({ actionClass: 'quarantine-decision' }), NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.trustGrant.create).not.toHaveBeenCalled();
    });

    it('rejects an expiry that is not in the future', async () => {
      const { service } = serviceOver();

      await expect(
        service.create(input({ expiresAt: NOW }), NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create(input({ expiresAt: new Date(NOW.getTime() - 1) }), NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a ceiling of zero, a negative ceiling, and a NaN ceiling', async () => {
      // A grant with no ceiling is not a narrower grant, it is a blank check —
      // and `NaN > ceiling` is false, so a NaN ceiling authorizes everything.
      const { service } = serviceOver();

      for (const budgetCeilingUsd of [
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        await expect(
          service.create(input({ budgetCeilingUsd }), NOW),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('rejects a failure rate outside [0, 1]', async () => {
      const { service } = serviceOver();

      for (const maxFailureRate of [-0.01, 1.01, Number.NaN]) {
        await expect(
          service.create(input({ maxFailureRate }), NOW),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('rejects a per-action cost cap of zero or less', async () => {
      const { service } = serviceOver();

      for (const maxCostPerActionUsd of [0, -5, Number.NaN]) {
        await expect(
          service.create(input({ maxCostPerActionUsd }), NOW),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('rejects a sample-size floor below one', async () => {
      const { service } = serviceOver();

      await expect(
        service.create(input({ minActionsBeforeAutoRevoke: 0 }), NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create(input({ minActionsBeforeAutoRevoke: 2.5 }), NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s when the repository does not exist', async () => {
      // Checked before the insert so the caller gets a 404 naming the
      // repository rather than a 500 naming a foreign key constraint.
      const { service } = serviceOver([], false);

      await expect(service.create(input(), NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('authorize', () => {
    it('authorizes an active, unexpired, in-budget grant', async () => {
      const { service } = serviceOver([row()]);

      const result = await service.authorize('re-dispatch', REPO, 2, NOW);

      expect(result.authorized).toBe(true);
      expect(result.authorized && result.grant.id).toBe('grant-1');
    });

    it('refuses a grant ONE MILLISECOND past its expiry — no grace period', async () => {
      // #96's third acceptance criterion, asserted at the boundary. The row is
      // deliberately left at `status: 'active'`: the sweep has not run, and
      // that is exactly the state in which a status-driven check would still
      // be authorizing work. The timestamp is the authority.
      const lapsed = row({ expiresAt: new Date(NOW.getTime() - 1) });
      const { service } = serviceOver([lapsed]);

      const result = await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(result.authorized).toBe(false);
      expect(!result.authorized && result.reason).toBe('expired');
    });

    it('still authorizes one millisecond before expiry', async () => {
      // The other side of the same boundary, so the test above is pinning an
      // edge rather than a blanket refusal.
      const { service } = serviceOver([
        row({ expiresAt: new Date(NOW.getTime() + 1) }),
      ]);

      const result = await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(result.authorized).toBe(true);
    });

    it('filters on the timestamp, not on the status column', async () => {
      // `status` is only as fresh as the last sweep. Asserting the WHERE shape
      // as well as the outcome, because this is the one line that makes "no
      // grace period" true.
      const { prisma, service } = serviceOver([row()]);

      await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(prisma.trustGrant.findMany.mock.calls[0]![0].where).toEqual({
        actionClass: 're-dispatch',
        repositoryId: REPO,
        status: 'active',
        expiresAt: { gt: NOW },
      });
    });

    it('distinguishes no-grant from expired from revoked from suspended', async () => {
      // The same OUTCOME, four different DIAGNOSES. VISION §8's "silence
      // revokes" only reads as deliberate if the system can say which one
      // happened — collapsed into one reason, a lapsed grant looks exactly
      // like a grant that was never made.
      const cases: Array<[TrustGrantStatus | 'none', string]> = [
        ['none', 'no-grant'],
        ['expired', 'expired'],
        ['revoked', 'revoked'],
        ['suspended', 'suspended'],
      ];

      for (const [status, expected] of cases) {
        const rows =
          status === 'none'
            ? []
            : [
                row({
                  status,
                  endedAt: NOW,
                  endReason:
                    status === 'revoked' ? 'manual_revocation' : 'expired',
                  endDetail: 'Ended after 2 failures.',
                  // Unexpired, so only the status can explain the refusal.
                  expiresAt: EXPIRES,
                }),
              ];
        const { service } = serviceOver(rows);

        const result = await service.authorize('re-dispatch', REPO, 1, NOW);

        expect(result.authorized).toBe(false);
        expect(!result.authorized && result.reason).toBe(expected);
      }
    });

    it('reports a stale active row past its expiry as expired, not as a grant', async () => {
      const { service } = serviceOver([
        row({
          status: 'active',
          expiresAt: new Date(NOW.getTime() - 3600_000),
        }),
      ]);

      const result = await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(!result.authorized && result.reason).toBe('expired');
      expect(!result.authorized && result.detail).toContain('1 hour');
    });

    it('refuses a class the registry rules out, before touching the database', async () => {
      const { prisma, service } = serviceOver([row()]);

      const result = await service.authorize(
        'quarantine-decision',
        REPO,
        1,
        NOW,
      );

      expect(!result.authorized && result.reason).toBe('class-ineligible');
      expect(prisma.trustGrant.findMany).not.toHaveBeenCalled();
    });

    it('refuses an unknown class as ineligible rather than as a missing grant', async () => {
      // `isAutonomyEligible` returns false for an unknown id, so a typo is a
      // refusal rather than a promotion path (see action-classes.ts).
      const { service } = serviceOver([row()]);

      const result = await service.authorize('typo-class', REPO, 1, NOW);

      expect(!result.authorized && result.reason).toBe('class-ineligible');
    });

    it('refuses when the projected spend would cross the ceiling', async () => {
      const { service } = serviceOver([row({ spentUsd: 24 })]);

      const result = await service.authorize('re-dispatch', REPO, 2, NOW);

      expect(!result.authorized && result.reason).toBe('budget-exhausted');
      expect(!result.authorized && result.detail).toContain('$26.00');
    });

    it('authorizes spend that lands exactly ON the ceiling', async () => {
      // `>`, not `>=`: a $25 ceiling authorizes spending UP TO $25. Same
      // boundary `budget-overrun.ts` uses, so the two cannot disagree by a
      // cent about what a ceiling means.
      const { service } = serviceOver([row({ spentUsd: 24 })]);

      const result = await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(result.authorized).toBe(true);
    });

    it('refuses a NaN or negative projected cost as budget-exhausted', async () => {
      // An unknown cost is not a zero cost. `NaN > ceiling` is false, so
      // letting it through would make the ceiling pass for every action whose
      // cost nobody could compute — mirrors #65 and the spend ledger.
      const { prisma, service } = serviceOver([row()]);

      for (const projected of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        const result = await service.authorize(
          're-dispatch',
          REPO,
          projected,
          NOW,
        );
        expect(!result.authorized && result.reason).toBe('budget-exhausted');
      }
      expect(prisma.trustGrant.findMany).not.toHaveBeenCalled();
    });

    it('picks the grant with the most headroom among three overlapping grants', async () => {
      // Overlapping grants are legitimate — a renewal issued before the old
      // one lapsed is exactly this shape — so the choice must be
      // deterministic, or two identical requests would charge different rows
      // and smear the spend across a history nobody can reconcile.
      const { service } = serviceOver([
        row({ id: 'thin', budgetCeilingUsd: 25, spentUsd: 24 }),
        row({ id: 'fat', budgetCeilingUsd: 100, spentUsd: 10 }),
        row({ id: 'middling', budgetCeilingUsd: 50, spentUsd: 30 }),
      ]);

      const result = await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(result.authorized && result.grant.id).toBe('fat');
    });

    it('breaks a headroom tie by the later expiry', async () => {
      const later = new Date(EXPIRES.getTime() + 86_400_000);
      const { service } = serviceOver([
        row({ id: 'sooner', expiresAt: EXPIRES }),
        row({ id: 'later', expiresAt: later }),
      ]);

      const result = await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(result.authorized && result.grant.id).toBe('later');
    });

    it('is stable across repeated calls with the same data', async () => {
      const rows = [
        row({ id: 'a', budgetCeilingUsd: 40, spentUsd: 10 }),
        row({ id: 'b', budgetCeilingUsd: 40, spentUsd: 10 }),
        row({ id: 'c', budgetCeilingUsd: 40, spentUsd: 10 }),
      ];
      const { service } = serviceOver(rows);

      const first = await service.authorize('re-dispatch', REPO, 1, NOW);
      const second = await service.authorize('re-dispatch', REPO, 1, NOW);

      expect(first.authorized && first.grant.id).toBe(
        second.authorized && second.grant.id,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('recordUsage', () => {
    it('charges the grant with atomic increments, never read-modify-write', async () => {
      // Asserting the CALL SHAPE, not just the resulting totals: a
      // read-modify-write implementation would produce identical totals here
      // and lose a charge the moment two auto-executions land together — and
      // the charge that gets lost is the one that would have crossed the
      // ceiling, because that is the busy case.
      const { prisma, service } = serviceOver([row()]);

      await service.recordUsage('grant-1', { costUsd: 2.5, failed: true }, NOW);

      expect(prisma.trustGrant.update).toHaveBeenCalledTimes(1);
      expect(prisma.trustGrant.update.mock.calls[0]![0]).toEqual({
        where: { id: 'grant-1' },
        data: {
          spentUsd: { increment: 2.5 },
          actionsAuthorized: { increment: 1 },
          actionsFailed: { increment: 1 },
        },
      });
    });

    it('increments actionsFailed by zero on a success, keeping the call shape constant', async () => {
      const { prisma, service } = serviceOver([row()]);

      await service.recordUsage('grant-1', { costUsd: 1, failed: false }, NOW);

      expect(
        prisma.trustGrant.update.mock.calls[0]![0].data.actionsFailed,
      ).toEqual({ increment: 0 });
    });

    it('suspends the grant when the charge exhausts the budget', async () => {
      const { prisma, service } = serviceOver([
        row({ budgetCeilingUsd: 25, spentUsd: 24 }),
      ]);

      const result = await service.recordUsage(
        'grant-1',
        { costUsd: 2, failed: false },
        NOW,
      );

      expect(result.suspended).toBe(true);
      expect(result.reason).toBe('budget_exhausted');
      expect(result.detail).toMatch(/\d/);
      expect(prisma.store[0]!.status).toBe('suspended');
      expect(prisma.store[0]!.endedAt).toEqual(NOW);
    });

    it('suspends on a failure rate breach and says which numbers tripped it', async () => {
      const { service } = serviceOver([
        row({ actionsAuthorized: 8, actionsFailed: 3, spentUsd: 2 }),
      ]);

      const result = await service.recordUsage(
        'grant-1',
        { costUsd: 0.1, failed: true },
        NOW,
      );

      expect(result.reason).toBe('failure_rate_exceeded');
      expect(result.detail).toContain('4 of 9');
    });

    it('leaves a healthy grant active', async () => {
      const { service } = serviceOver([row()]);

      const result = await service.recordUsage(
        'grant-1',
        { costUsd: 1, failed: false },
        NOW,
      );

      expect(result.suspended).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.grant.spentUsd).toBe(1);
      expect(result.grant.actionsAuthorized).toBe(1);
    });

    it('rejects a NaN or negative charge rather than poisoning the column', async () => {
      const { service } = serviceOver([row()]);

      await expect(
        service.recordUsage('grant-1', { costUsd: Number.NaN, failed: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.recordUsage('grant-1', { costUsd: -5, failed: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s for a grant that does not exist', async () => {
      const { service } = serviceOver([]);

      await expect(
        service.recordUsage('missing', { costUsd: 1, failed: false }, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  describe('suspend and revoke', () => {
    it('revokes an active grant with the manual reason and the actor recorded in revokedById', async () => {
      const { prisma, service } = serviceOver([row()]);

      const changed = await service.revoke(
        'grant-1',
        'user-9',
        'Opened the wrong PRs twice.',
        NOW,
      );

      expect(changed).toBe(true);
      expect(prisma.store[0]!.status).toBe('revoked');
      expect(prisma.store[0]!.endReason).toBe('manual_revocation');
      // The provenance edge lives in the column, not the prose — VISION §5.
      expect(prisma.store[0]!.revokedById).toBe('user-9');
      expect(prisma.store[0]!.endDetail).not.toContain('user-9');
      expect(prisma.store[0]!.endDetail).toContain(
        'Opened the wrong PRs twice.',
      );
    });

    it('leaves revokedById null for a system suspension', async () => {
      const { prisma, service } = serviceOver([row()]);

      await service.suspend(
        'grant-1',
        'budget_exhausted',
        '$25.00 spent.',
        NOW,
      );

      expect(prisma.store[0]!.status).toBe('suspended');
      // Nobody decided this — a null actor is the meaningful fact, not a
      // gap to fill in later.
      expect(prisma.store[0]!.revokedById).toBeNull();
    });

    it('is a NO-OP, not an error, when the grant has already ended', async () => {
      // A sweep and a human revoking the same grant in the same second is an
      // ordinary race, not a fault. Whichever loses returns quietly rather
      // than raising an exception some caller then decides to swallow.
      const ended = row({
        status: 'expired',
        endedAt: NOW,
        endReason: 'expired',
        endDetail: 'Lapsed 2 hours ago.',
      });
      const { prisma, service } = serviceOver([ended]);

      await expect(
        service.revoke('grant-1', 'user-9', null, NOW),
      ).resolves.toBe(false);
      await expect(
        service.suspend('grant-1', 'budget_exhausted', '$25.00 spent.', NOW),
      ).resolves.toBe(false);

      // The original cause of death survives both attempts.
      expect(prisma.store[0]!.status).toBe('expired');
      expect(prisma.store[0]!.endReason).toBe('expired');
      expect(prisma.store[0]!.endDetail).toBe('Lapsed 2 hours ago.');
    });

    it('does not resurrect or overwrite a revoked grant with a suspension', async () => {
      const { prisma, service } = serviceOver([row()]);

      await service.revoke('grant-1', 'user-9', null, NOW);
      await service.suspend(
        'grant-1',
        'failure_rate_exceeded',
        '4 of 9 failed.',
        NOW,
      );

      expect(prisma.store[0]!.status).toBe('revoked');
      expect(prisma.store[0]!.endReason).toBe('manual_revocation');
    });
  });

  // -------------------------------------------------------------------------
  describe('sweepExpired', () => {
    it('marks lapsed active grants expired and counts them', async () => {
      const past = new Date(NOW.getTime() - 90 * 60 * 1000);
      const { prisma, service } = serviceOver([
        row({ id: 'a', expiresAt: past }),
        row({ id: 'b', expiresAt: past }),
        row({ id: 'c', expiresAt: EXPIRES }),
      ]);

      await expect(service.sweepExpired(NOW)).resolves.toBe(2);

      expect(prisma.store.map((r) => r.status)).toEqual([
        'expired',
        'expired',
        'active',
      ]);
      expect(prisma.store[0]!.endReason).toBe('expired');
      // "saying when it lapsed" — per row, which is why this is not one bulk
      // update.
      expect(prisma.store[0]!.endDetail).toContain(past.toISOString());
      expect(prisma.store[0]!.endDetail).toMatch(/\d/);
      // Nobody decided this either — an expiry is silence, not a revocation.
      expect(prisma.store[0]!.revokedById).toBeNull();
    });

    it('does not touch a grant that has already ended', async () => {
      const past = new Date(NOW.getTime() - 1000);
      const { prisma, service } = serviceOver([
        row({
          id: 'revoked',
          expiresAt: past,
          status: 'revoked',
          endReason: 'manual_revocation',
          endDetail: 'Revoked by user 7.',
        }),
      ]);

      await expect(service.sweepExpired(NOW)).resolves.toBe(0);
      expect(prisma.store[0]!.status).toBe('revoked');
      expect(prisma.store[0]!.endDetail).toBe('Revoked by user 7.');
    });

    it('is idempotent — a second sweep over the same data counts zero', async () => {
      const { service } = serviceOver([
        row({ expiresAt: new Date(NOW.getTime() - 1) }),
      ]);

      await expect(service.sweepExpired(NOW)).resolves.toBe(1);
      await expect(service.sweepExpired(NOW)).resolves.toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('list, get and expiringSoon', () => {
    it('lists only active grants by default', async () => {
      const { service } = serviceOver([
        row({ id: 'a' }),
        row({ id: 'b', status: 'revoked' }),
      ]);

      const listed = await service.list({}, NOW);

      expect(listed.map((g) => g.id)).toEqual(['a']);
    });

    it('keeps revoked and expired grants auditable when asked', async () => {
      // #96's last acceptance criterion. A grant that disappears when it dies
      // takes its evidence with it, and the evidence is what the promotion
      // ladder and the daily digest are made of.
      const { service } = serviceOver([
        row({ id: 'a' }),
        row({ id: 'b', status: 'revoked' }),
        row({ id: 'c', status: 'expired' }),
      ]);

      const listed = await service.list({ includeEnded: true }, NOW);

      expect(listed.map((g) => g.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('filters by repository, class and status', async () => {
      const { prisma, service } = serviceOver([]);

      await service.list(
        {
          repositoryId: REPO,
          actionClass: 're-dispatch',
          status: 'suspended',
        },
        NOW,
      );

      expect(prisma.trustGrant.findMany.mock.calls[0]![0].where).toEqual({
        repositoryId: REPO,
        actionClass: 're-dispatch',
        status: 'suspended',
      });
    });

    it('404s on an unknown id', async () => {
      const { service } = serviceOver([]);

      await expect(service.get('missing', NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('derives the read-model figures a renewal prompt needs', async () => {
      const { service } = serviceOver([
        row({
          budgetCeilingUsd: 25,
          spentUsd: 21,
          actionsAuthorized: 8,
          actionsFailed: 2,
          expiresAt: new Date(NOW.getTime() + 3600_000),
        }),
      ]);

      const view = await service.get('grant-1', NOW);

      expect(view.remainingBudgetUsd).toBe(4);
      expect(view.budgetHeadroomFraction).toBeCloseTo(0.16);
      expect(view.msUntilExpiry).toBe(3600_000);
      expect(view.failureRate).toBeCloseTo(0.25);
      expect(view.nearExpiry).toBe(true);
      expect(view.nearBudget).toBe(true);
    });

    it('reports a null failure rate before anything has been authorized', async () => {
      // 0/0 is "no evidence". Rendering it as a 0% failure rate says the
      // opposite of what the data supports — same rule as `approvalRates`.
      const { service } = serviceOver([row()]);

      expect((await service.get('grant-1', NOW)).failureRate).toBeNull();
    });

    it('returns grants expiring inside the window, soonest first', async () => {
      const inOneHour = new Date(NOW.getTime() + 3600_000);
      const inOneDay = new Date(NOW.getTime() + 86_400_000);
      const inOneMonth = new Date(NOW.getTime() + 30 * 86_400_000);
      const { service } = serviceOver([
        row({ id: 'month', expiresAt: inOneMonth }),
        row({ id: 'day', expiresAt: inOneDay }),
        row({ id: 'hour', expiresAt: inOneHour }),
      ]);

      const soon = await service.expiringSoon(48 * 3600_000, NOW);

      expect(soon.map((g) => g.id)).toEqual(['hour', 'day']);
    });

    it('excludes grants that have already lapsed from expiringSoon', async () => {
      // An already-lapsed grant is not "expiring soon", it is gone. Offering a
      // renewal tap for it would imply the tap keeps alive something that has
      // already stopped working.
      const { service } = serviceOver([
        row({ id: 'gone', expiresAt: new Date(NOW.getTime() - 1) }),
      ]);

      await expect(service.expiringSoon(48 * 3600_000, NOW)).resolves.toEqual(
        [],
      );
    });

    it('rejects a nonsensical window', async () => {
      const { service } = serviceOver([]);

      await expect(
        service.expiringSoon(Number.NaN, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  it('names at least one number in every refusal detail it produces', async () => {
    // #47: the reason is not a log message. A refusal a human cannot evaluate
    // is indistinguishable from an arbitrary one, and VISION §8's whole
    // argument is that an operator who finds the system unpredictable grants
    // blanket trust next time.
    const details: string[] = [];

    const push = async (
      rows: TrustGrantRow[],
      actionClass: string,
      projected: number,
    ) => {
      const { service } = serviceOver(rows);
      const result = await service.authorize(actionClass, REPO, projected, NOW);
      expect(result.authorized).toBe(false);
      if (!result.authorized) details.push(result.detail);
    };

    await push([], 're-dispatch', 1); // no-grant
    await push(
      [row({ expiresAt: new Date(NOW.getTime() - 1) })],
      're-dispatch',
      1,
    ); // expired
    await push(
      [row({ status: 'revoked', endedAt: NOW, endDetail: '2 bad PRs.' })],
      're-dispatch',
      1,
    ); // revoked
    await push(
      [
        row({
          status: 'suspended',
          endedAt: NOW,
          endReason: 'failure_rate_exceeded',
          endDetail: '4 of 9 failed.',
        }),
      ],
      're-dispatch',
      1,
    ); // suspended
    await push([row({ spentUsd: 25 })], 're-dispatch', 1); // budget-exhausted
    await push([row()], 'quarantine-decision', 1); // class-ineligible

    expect(details).toHaveLength(6);
    for (const detail of details) {
      expect(detail).toMatch(/\d/);
    }
  });
});
