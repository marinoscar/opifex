import { ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_GRANT_BUDGET_CEILING_USD,
  DEFAULT_GRANT_EXPIRY_DAYS,
  DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
  DEFAULT_GRANT_MAX_FAILURE_RATE,
  DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
} from './defaults';
import {
  createTrustGrantSchema,
  listTrustGrantsQuerySchema,
  revokeTrustGrantSchema,
} from './dto/trust-grant.dto';
import { TrustGrantService, type TrustGrantRow } from './trust-grant.service';
import { TrustController } from './trust.controller';

const REPO = 'repo-1';
const USER = 'user-1';
const NOW = new Date('2026-08-24T12:00:00.000Z');

function row(overrides: Partial<TrustGrantRow> = {}): TrustGrantRow {
  return {
    id: 'grant-1',
    actionClass: 're-dispatch',
    repositoryId: REPO,
    expiresAt: new Date('2026-09-07T12:00:00.000Z'),
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
    grantedById: USER,
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A Prisma double that honours the WHERE clause, over a REAL
 * `TrustGrantService`.
 *
 * The controller is not tested against a stubbed service here, and that is
 * deliberate for two of the properties below. "`includeEnded=false` omits
 * revoked grants" and "revocation takes effect immediately" are claims about
 * what a caller OBSERVES, and a service double returning a canned list would
 * assert only that the controller passed a flag along — it would stay green if
 * the flag meant nothing. Running the real service over a filtering double
 * makes the whole path the thing under test.
 */
function prismaDouble(rows: TrustGrantRow[] = [], repositoryExists = true) {
  const store = [...rows];

  const matches = (r: TrustGrantRow, where: any = {}): boolean => {
    if (where.id !== undefined && r.id !== where.id) return false;
    if (where.status !== undefined && r.status !== where.status) return false;
    if (where.actionClass !== undefined && r.actionClass !== where.actionClass)
      return false;
    if (
      where.repositoryId !== undefined &&
      r.repositoryId !== where.repositoryId
    )
      return false;
    if (
      where.renewedFromId !== undefined &&
      r.renewedFromId !== where.renewedFromId
    )
      return false;
    return true;
  };

  const findMany = jest.fn(async (args: any = {}) => {
    const filtered = store.filter((r) => matches(r, args.where));
    return args.take ? filtered.slice(0, args.take) : filtered;
  });

  const updateMany = jest.fn(async (args: any) => {
    const targets = store.filter((r) => matches(r, args.where));
    for (const target of targets) Object.assign(target, args.data);
    return { count: targets.length };
  });

  const create = jest.fn(async (args: any) => {
    const created = row({ ...args.data, id: 'grant-new' });
    store.push(created);
    return created;
  });

  return {
    store,
    trustGrant: {
      findMany,
      findUnique: jest.fn(
        async (args: any) => store.find((r) => r.id === args.where.id) ?? null,
      ),
      create,
      update: jest.fn(),
      updateMany,
    },
    repository: {
      findUnique: jest.fn(async () => (repositoryExists ? { id: REPO } : null)),
    },
  };
}

function build(...args: Parameters<typeof prismaDouble>) {
  const prisma = prismaDouble(...args);
  const service = new TrustGrantService(prisma as unknown as PrismaService);
  return { prisma, service, controller: new TrustController(service) };
}

/** Query DTOs arrive parsed; parse them here so defaults are real. */
const query = (raw: Record<string, unknown> = {}) =>
  listTrustGrantsQuerySchema.parse(raw) as never;

describe('TrustController (#101)', () => {
  // ===========================================================================
  // The gates
  // ===========================================================================
  describe('permissions', () => {
    /**
     * Read off the handler metadata rather than by booting the guards. The
     * guards are tested on their own; what silently regresses here is the
     * DECORATION — a handler that loses its `@Auth` still compiles, still
     * returns 200 in every other test in this file, and is only wrong in
     * production.
     */
    const required = (handler: unknown): string[] =>
      new Reflector().get<string[]>(PERMISSIONS_KEY, handler as never) ?? [];

    it('gates the grant list on trust:read', () => {
      expect(required(TrustController.prototype.list)).toEqual([
        PERMISSIONS.TRUST_READ,
      ]);
    });

    it('gates the grant detail on trust:read', () => {
      expect(required(TrustController.prototype.get)).toEqual([
        PERMISSIONS.TRUST_READ,
      ]);
    });

    it('gates creating a grant on trust:grant, never on trust:read', () => {
      const permissions = required(TrustController.prototype.create);

      expect(permissions).toEqual([PERMISSIONS.TRUST_GRANT]);
      expect(permissions).not.toContain(PERMISSIONS.TRUST_READ);
    });

    it('gates revocation on trust:revoke, NOT on trust:grant', () => {
      // The separation is the point. Narrowing authority is always the safe
      // direction, and an operator watching a grant misbehave must never be
      // blocked from stopping it because the permission that stops it is the
      // same one that hands it out.
      const permissions = required(TrustController.prototype.revoke);

      expect(permissions).toEqual([PERMISSIONS.TRUST_REVOKE]);
      expect(permissions).not.toContain(PERMISSIONS.TRUST_GRANT);
    });
  });

  // ===========================================================================
  // POST /trust/grants — the endpoint's central property
  // ===========================================================================
  describe('create', () => {
    it('attaches all four VISION §8 attributes from the defaults', async () => {
      const { controller, prisma } = build([]);

      const created = await controller.create(
        { actionClass: 're-dispatch', repositoryId: REPO } as never,
        USER,
      );

      const written = prisma.trustGrant.create.mock.calls[0]![0].data as Record<
        string,
        unknown
      >;

      // Scope.
      expect(written.actionClass).toBe('re-dispatch');
      expect(written.repositoryId).toBe(REPO);
      // Budget ceiling.
      expect(written.budgetCeilingUsd).toBe(DEFAULT_GRANT_BUDGET_CEILING_USD);
      // Auto-revoke, both thresholds and the sample-size floor that makes the
      // rate rules mean anything.
      expect(written.maxFailureRate).toBe(DEFAULT_GRANT_MAX_FAILURE_RATE);
      expect(written.maxCostPerActionUsd).toBe(
        DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
      );
      // Expiry: not asserted to the millisecond, but asserted to be the
      // DEFAULT WINDOW rather than "some future date" — an assertion that
      // accepted any future instant would pass against a ten-year grant.
      const days =
        (new Date(created.expiresAt).getTime() - Date.now()) /
        (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(DEFAULT_GRANT_EXPIRY_DAYS - 0.01);
      expect(days).toBeLessThanOrEqual(DEFAULT_GRANT_EXPIRY_DAYS);

      // And the view really carries them, so a client sees the terms.
      expect(created.budgetCeilingUsd).toBe(DEFAULT_GRANT_BUDGET_CEILING_USD);
      expect(created.maxFailureRate).toBe(DEFAULT_GRANT_MAX_FAILURE_RATE);
      expect(created.minActionsBeforeAutoRevoke).toBe(
        DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
      );
      expect(created.status).toBe('active');
    });

    it('records the authenticated caller as the grantor, never the body', async () => {
      const { controller, prisma } = build([]);

      await controller.create(
        {
          actionClass: 're-dispatch',
          repositoryId: REPO,
          grantedById: 'somebody-else',
        } as never,
        USER,
      );

      expect(
        (prisma.trustGrant.create.mock.calls[0]![0].data as any).grantedById,
      ).toBe(USER);
    });

    describe('refuses the four attributes as caller input', () => {
      // VISION §8's design move is that the four attach AUTOMATICALLY. A
      // caller who could set the expiry could set it to 3650 days, and the
      // mechanism would still appear on every screen while revoking nothing.
      const forbidden: [string, unknown][] = [
        ['expiresAt', new Date('2036-01-01T00:00:00.000Z').toISOString()],
        ['budgetCeilingUsd', 10000],
        ['maxFailureRate', 1],
        ['maxCostPerActionUsd', 9999],
        ['minActionsBeforeAutoRevoke', 100000],
      ];

      it.each(forbidden)('rejects a body carrying %s', (field, value) => {
        const parsed = createTrustGrantSchema.safeParse({
          actionClass: 're-dispatch',
          repositoryId: REPO,
          [field]: value,
        });

        // REFUSED, not stripped. A 201 over a grant whose real ceiling is a
        // twentieth of the one requested leaves the operator believing they
        // hold trust they do not, and nobody re-reads a 201 to find out.
        expect(parsed.success).toBe(false);
      });

      it.each(forbidden)(
        'never writes a caller-supplied %s even if one reaches the handler',
        async (field, value) => {
          // Belt and braces: the schema is the gate, but the handler must not
          // be the kind of code that would forward the field if the gate were
          // ever loosened. It spreads `defaultGrantAttributes()` LAST and
          // never spreads the body.
          const { controller, prisma } = build([]);

          await controller.create(
            {
              actionClass: 're-dispatch',
              repositoryId: REPO,
              [field]: value,
            } as never,
            USER,
          );

          const written = prisma.trustGrant.create.mock.calls[0]![0]
            .data as Record<string, unknown>;
          expect(written[field]).not.toBe(value);
        },
      );

      it('still accepts the three fields it does take', () => {
        expect(
          createTrustGrantSchema.safeParse({
            actionClass: 're-dispatch',
            repositoryId: REPO,
            note: 'Re-dispatch has been reliable for a month.',
          }).success,
        ).toBe(true);
      });
    });

    it('refuses a class the registry marks ineligible for autonomy', async () => {
      const { controller } = build([]);

      await expect(
        controller.create(
          { actionClass: 'quarantine-decision', repositoryId: REPO } as never,
          USER,
        ),
      ).rejects.toThrow(/not autonomy-eligible/);
    });

    it('404s rather than 500s when the repository does not exist', async () => {
      const { controller } = build([], false);

      await expect(
        controller.create(
          { actionClass: 're-dispatch', repositoryId: 'nope' } as never,
          USER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ===========================================================================
  // GET /trust/grants
  // ===========================================================================
  describe('list', () => {
    it('omits revoked, expired and suspended grants by default', async () => {
      const { controller } = build([
        row({ id: 'live' }),
        row({ id: 'revoked', status: 'revoked' }),
        row({ id: 'expired', status: 'expired' }),
        row({ id: 'suspended', status: 'suspended' }),
      ]);

      const listed = await controller.list(query());

      expect(listed.map((g) => g.id)).toEqual(['live']);
    });

    it('includes the ended ones on includeEnded=true, so they stay auditable', async () => {
      // #101's requirement, and #96's last acceptance criterion. A grant that
      // vanished when it died would take its evidence with it — and that
      // evidence is what the promotion ladder and the daily digest read.
      const { controller } = build([
        row({ id: 'live' }),
        row({ id: 'revoked', status: 'revoked' }),
        row({ id: 'expired', status: 'expired' }),
      ]);

      const listed = await controller.list(query({ includeEnded: 'true' }));

      expect(listed.map((g) => g.id).sort()).toEqual([
        'expired',
        'live',
        'revoked',
      ]);
    });

    it('reads includeEnded=false as false, not as a non-empty string', async () => {
      // `z.coerce.boolean()` would make the string "false" true, which is the
      // single most likely way this filter could silently invert.
      expect(
        listTrustGrantsQuerySchema.parse({ includeEnded: 'false' }),
      ).toEqual({ includeEnded: false });
    });

    it('passes the three filters through', async () => {
      const { controller, prisma } = build([]);

      await controller.list(
        query({
          repositoryId: REPO,
          actionClass: 're-dispatch',
          status: 'suspended',
        }),
      );

      expect(prisma.trustGrant.findMany.mock.calls[0]![0].where).toEqual({
        repositoryId: REPO,
        actionClass: 're-dispatch',
        status: 'suspended',
      });
    });

    it('joins the registry title, and NEVER falls back to the raw id', async () => {
      const { controller } = build([
        row({ id: 'known', actionClass: 're-dispatch' }),
        row({ id: 'drifted', actionClass: 'not-in-the-registry' }),
      ]);

      const listed = await controller.list(query());
      const byId = new Map(listed.map((g) => [g.id, g.actionClassTitle]));

      expect(byId.get('known')).toBe('Re-dispatch after transient failure');
      // Null, not `'not-in-the-registry'`. A title that silently equalled its
      // id makes registry drift invisible — and a grant outlives edits to the
      // taxonomy, so this is a real case, not a defensive one.
      expect(byId.get('drifted')).toBeNull();
    });
  });

  // ===========================================================================
  // GET /trust/grants/:id
  // ===========================================================================
  describe('get', () => {
    it('adds the registry entry and both halves of the renewal chain', async () => {
      const { controller } = build([
        row({ id: 'original', status: 'expired', renewedFromId: 'ancestor' }),
        row({ id: 'renewal', renewedFromId: 'original' }),
      ]);

      const detail = await controller.get('original');

      expect(detail.actionClassEntry).toMatchObject({
        title: 'Re-dispatch after transient failure',
        autonomyEligible: true,
      });
      expect(detail.actionClassEntry?.definition).toEqual(expect.any(String));
      expect(detail.actionClassEntry?.reversibility).toEqual(
        expect.any(String),
      );
      // Backward edge and forward edge. An expired grant WITH a renewal was
      // kept alive; one without is "silence revokes" having happened, and the
      // backward edge alone cannot tell them apart.
      expect(detail.renewedFromId).toBe('ancestor');
      expect(detail.renewedBy.map((r) => r.id)).toEqual(['renewal']);
    });

    it('reports a null registry entry for a class that has left the taxonomy', async () => {
      const { controller } = build([
        row({ id: 'drifted', actionClass: 'retired-class' }),
      ]);

      await expect(controller.get('drifted')).resolves.toMatchObject({
        actionClassEntry: null,
      });
    });

    it('404s on an unknown id', async () => {
      const { controller } = build([]);

      await expect(controller.get('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ===========================================================================
  // DELETE /trust/grants/:id
  // ===========================================================================
  describe('revoke', () => {
    it('takes effect immediately and returns the ENDED grant', async () => {
      const { controller } = build([row({ id: 'grant-1' })]);

      const ended = await controller.revoke(
        'grant-1',
        { note: 'Cost per PR is climbing.' } as never,
        'admin-9',
      );

      expect(ended.status).toBe('revoked');
      expect(ended.endReason).toBe('manual_revocation');
      // The actor is a column, not prose: a provenance edge that exists only
      // in a sentence is a hole in the graph.
      expect(ended.revokedById).toBe('admin-9');
      expect(ended.endedAt).not.toBeNull();
      expect(ended.endDetail).toContain('Cost per PR is climbing.');
    });

    it('stops the grant authorizing on the very next call', async () => {
      // "Immediate" is a claim about `authorize`, not about a status column,
      // so it is asserted against `authorize`.
      const { controller, service } = build([row({ id: 'grant-1' })]);

      await expect(
        service.authorize('re-dispatch', REPO, 0, NOW),
      ).resolves.toMatchObject({ authorized: true });

      await controller.revoke('grant-1', {} as never, 'admin-9');

      await expect(
        service.authorize('re-dispatch', REPO, 0, NOW),
      ).resolves.toMatchObject({ authorized: false, reason: 'revoked' });
    });

    it('accepts a request with no body at all', async () => {
      // A DELETE frequently arrives without one. Revocation is the safe
      // direction and must never be harder than granting, so the schema
      // defaults rather than 400s.
      const { controller } = build([row({ id: 'grant-1' })]);
      const body = revokeTrustGrantSchema.parse(undefined);

      await expect(
        controller.revoke('grant-1', body as never, 'admin-9'),
      ).resolves.toMatchObject({ status: 'revoked' });
    });

    it('404s on an unknown id rather than reporting a conflict', async () => {
      const { controller } = build([]);

      await expect(
        controller.revoke('missing', {} as never, 'admin-9'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s on a grant that already ended, preserving the original reason', async () => {
      const { controller, prisma } = build([
        row({
          id: 'grant-1',
          status: 'suspended',
          endReason: 'failure_rate_exceeded',
          endDetail: 'Failure rate 62% over 8 actions.',
          endedAt: NOW,
        }),
      ]);

      await expect(
        controller.revoke('grant-1', {} as never, 'admin-9'),
      ).rejects.toBeInstanceOf(ConflictException);

      // Untouched. "Revoked by Ana" overwriting "suspended: failure rate 62%"
      // would erase the only record of a class misbehaving.
      const stored = prisma.store.find((r) => r.id === 'grant-1')!;
      expect(stored.endReason).toBe('failure_rate_exceeded');
      expect(stored.revokedById).toBeNull();
    });

    it('names the conflict in details.reason, where a client can branch on it', async () => {
      const { controller } = build([
        row({
          id: 'grant-1',
          status: 'revoked',
          endReason: 'manual_revocation',
        }),
      ]);

      await controller.revoke('grant-1', {} as never, 'admin-9').then(
        () => {
          throw new Error('expected a conflict');
        },
        (error: ConflictException) => {
          const body = error.getResponse() as {
            details: { reason: string; status: string };
          };
          expect(body.details.reason).toBe('already-ended');
          expect(body.details.status).toBe('revoked');
        },
      );
    });
  });
});
