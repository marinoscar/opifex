import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_GRANT_BUDGET_CEILING_USD,
  DEFAULT_GRANT_EXPIRY_DAYS,
  DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
  DEFAULT_GRANT_MAX_FAILURE_RATE,
  DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
  defaultGrantAttributes,
} from './defaults';
import { narrowerOf, type NarrowableGrant } from './renewal';
import { TrustGrantNotRenewableException } from './trust-grant-not-renewable.exception';
import { TrustGrantService, type TrustGrantRow } from './trust-grant.service';

/**
 * One-tap trust-grant renewal (#115, epic #22, VISION §8).
 *
 * > Expiry — days or session. Renewal is one tap; silence revokes.
 *
 * Two properties carry the whole feature, and both are the kind that a later,
 * individually reasonable change breaks silently:
 *
 *  1. **A renewal never widens anything.** Not scope, not the ceiling, not the
 *     thresholds. `narrowerOf` is asserted attribute by attribute so that a
 *     sixth attribute added without its `min` fails here rather than in
 *     production a fortnight later.
 *  2. **A renewal creates no grace period.** One millisecond past `expiresAt`
 *     is refused. This is the assertion somebody will eventually want to
 *     relax, because the operator is right there and clearly wants the grant —
 *     and relaxing it turns "silence revokes" into "silence revokes unless
 *     somebody notices in time", at which point expiry is advisory.
 */

const NOW = new Date('2026-08-24T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const REPO = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const GRANTER = '33333333-3333-4333-8333-333333333333';

// -- narrowerOf -------------------------------------------------------------

function old(overrides: Partial<NarrowableGrant> = {}): NarrowableGrant {
  return {
    // Created 14 days before now with a 14-day life, i.e. exactly the default:
    // so the baseline grant constrains NOTHING and every assertion below is
    // about the single attribute it overrides.
    createdAt: new Date(NOW.getTime() - 14 * DAY_MS),
    expiresAt: new Date(NOW.getTime() + 1 * DAY_MS),
    budgetCeilingUsd: DEFAULT_GRANT_BUDGET_CEILING_USD,
    maxFailureRate: DEFAULT_GRANT_MAX_FAILURE_RATE,
    maxCostPerActionUsd: DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
    minActionsBeforeAutoRevoke: DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
    ...overrides,
  };
}

describe('narrowerOf (#115): a renewal never widens', () => {
  const defaults = defaultGrantAttributes(NOW);

  it('takes the defaults when the old grant constrains nothing', () => {
    // The baseline. Without this the five assertions below could all pass
    // against a function that ignored `defaults` entirely.
    expect(narrowerOf(old(), defaults, NOW)).toEqual(defaults);
  });

  it('narrows the EXPIRY when the old grant was given a shorter life', () => {
    // Two days long, granted two days ago and expiring in a few hours. The
    // narrowed expiry must be TWO DAYS FROM NOW — not the old absolute
    // `expiresAt`, which is hours away and would make renewal a no-op that
    // looks like it worked.
    const result = narrowerOf(
      old({
        createdAt: new Date(NOW.getTime() - 2 * DAY_MS + 6 * 3600_000),
        expiresAt: new Date(NOW.getTime() + 6 * 3600_000),
      }),
      defaults,
      NOW,
    );

    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + 2 * DAY_MS);
    expect(result.expiresAt.getTime()).toBeLessThan(
      defaults.expiresAt.getTime(),
    );
    // Every other attribute untouched.
    expect(result.budgetCeilingUsd).toBe(defaults.budgetCeilingUsd);
    expect(result.maxFailureRate).toBe(defaults.maxFailureRate);
    expect(result.maxCostPerActionUsd).toBe(defaults.maxCostPerActionUsd);
    expect(result.minActionsBeforeAutoRevoke).toBe(
      defaults.minActionsBeforeAutoRevoke,
    );
  });

  it('never EXTENDS the expiry past the default, however long the old grant ran', () => {
    const result = narrowerOf(
      old({
        createdAt: new Date(NOW.getTime() - 365 * DAY_MS),
        expiresAt: new Date(NOW.getTime() + 1 * DAY_MS),
      }),
      defaults,
      NOW,
    );

    expect(result.expiresAt.getTime()).toBe(
      NOW.getTime() + DEFAULT_GRANT_EXPIRY_DAYS * DAY_MS,
    );
  });

  it('narrows the BUDGET CEILING when the old grant had a smaller one', () => {
    const result = narrowerOf(old({ budgetCeilingUsd: 5 }), defaults, NOW);

    expect(result.budgetCeilingUsd).toBe(5);
    expect(result.expiresAt).toEqual(defaults.expiresAt);
    expect(result.maxFailureRate).toBe(defaults.maxFailureRate);
    expect(result.maxCostPerActionUsd).toBe(defaults.maxCostPerActionUsd);
    expect(result.minActionsBeforeAutoRevoke).toBe(
      defaults.minActionsBeforeAutoRevoke,
    );
  });

  it('narrows MAX FAILURE RATE when the old grant tolerated fewer failures', () => {
    const result = narrowerOf(old({ maxFailureRate: 0.1 }), defaults, NOW);

    expect(result.maxFailureRate).toBe(0.1);
    expect(result.expiresAt).toEqual(defaults.expiresAt);
    expect(result.budgetCeilingUsd).toBe(defaults.budgetCeilingUsd);
    expect(result.maxCostPerActionUsd).toBe(defaults.maxCostPerActionUsd);
    expect(result.minActionsBeforeAutoRevoke).toBe(
      defaults.minActionsBeforeAutoRevoke,
    );
  });

  it('narrows MAX COST PER ACTION when the old grant capped it lower', () => {
    const result = narrowerOf(old({ maxCostPerActionUsd: 0.5 }), defaults, NOW);

    expect(result.maxCostPerActionUsd).toBe(0.5);
    expect(result.expiresAt).toEqual(defaults.expiresAt);
    expect(result.budgetCeilingUsd).toBe(defaults.budgetCeilingUsd);
    expect(result.maxFailureRate).toBe(defaults.maxFailureRate);
    expect(result.minActionsBeforeAutoRevoke).toBe(
      defaults.minActionsBeforeAutoRevoke,
    );
  });

  it('narrows MIN ACTIONS BEFORE AUTO-REVOKE downwards, because a lower floor fires SOONER', () => {
    // The counter-intuitive one, and the reason each attribute gets its own
    // assertion. A renewal that RAISED this would delay auto-revoke — a
    // widening dressed up as a statistics improvement.
    const result = narrowerOf(
      old({ minActionsBeforeAutoRevoke: 1 }),
      defaults,
      NOW,
    );

    expect(result.minActionsBeforeAutoRevoke).toBe(1);
    expect(result.expiresAt).toEqual(defaults.expiresAt);
    expect(result.budgetCeilingUsd).toBe(defaults.budgetCeilingUsd);
    expect(result.maxFailureRate).toBe(defaults.maxFailureRate);
    expect(result.maxCostPerActionUsd).toBe(defaults.maxCostPerActionUsd);
  });

  it('ignores the old value on every attribute where it is WIDER', () => {
    const result = narrowerOf(
      old({
        budgetCeilingUsd: 5_000,
        maxFailureRate: 0.99,
        maxCostPerActionUsd: 500,
        minActionsBeforeAutoRevoke: 100,
      }),
      defaults,
      NOW,
    );

    expect(result).toEqual(defaults);
  });

  it('falls back to the defaults on an unreadable old figure rather than propagating NaN', () => {
    // `Math.min(NaN, 25)` is NaN, and a NaN ceiling is not a narrow ceiling —
    // it is one every comparison fails against, which is the single direction
    // a budget check may never fail in.
    const result = narrowerOf(
      old({ budgetCeilingUsd: Number.NaN, maxCostPerActionUsd: Infinity }),
      defaults,
      NOW,
    );

    expect(result.budgetCeilingUsd).toBe(DEFAULT_GRANT_BUDGET_CEILING_USD);
    expect(result.maxCostPerActionUsd).toBe(
      DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
    );
  });

  it('falls back to the default DURATION on a corrupt old one', () => {
    // `createdAt` after `expiresAt`. Propagating a non-positive duration would
    // compute an expiry at or before `now`, which `create` refuses outright —
    // making such a grant permanently un-renewable with an error naming a
    // column the operator cannot see.
    const result = narrowerOf(
      old({
        createdAt: new Date(NOW.getTime() + 10 * DAY_MS),
        expiresAt: new Date(NOW.getTime() + 1 * DAY_MS),
      }),
      defaults,
      NOW,
    );

    expect(result.expiresAt).toEqual(defaults.expiresAt);
  });
});

// -- TrustGrantService.renew ------------------------------------------------

function row(overrides: Partial<TrustGrantRow> = {}): TrustGrantRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    actionClass: 're-dispatch',
    repositoryId: REPO,
    expiresAt: new Date(NOW.getTime() + 6 * 3600_000),
    budgetCeilingUsd: 25,
    spentUsd: 4,
    actionsAuthorized: 8,
    actionsFailed: 1,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    minActionsBeforeAutoRevoke: 3,
    status: 'active',
    endedAt: null,
    endReason: null,
    endDetail: null,
    revokedById: null,
    note: null,
    grantedById: GRANTER,
    grantedFromProposalId: '55555555-5555-4555-8555-555555555555',
    renewedFromId: null,
    createdAt: new Date(NOW.getTime() - 14 * DAY_MS),
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A Prisma double that honours the `status: 'active'` guard.
 *
 * Deliberately not a bag of `mockResolvedValue`s: the guard on the closing
 * `updateMany` IS the concurrency property under test, and a double that
 * returned `{ count: 1 }` regardless would pass whether or not the guard were
 * there. `$transaction` runs the callback and rethrows, which is enough to
 * assert that a throw leaves no successor behind — `created` is recorded, so
 * a test can see the row that was rolled back.
 */
function prismaDouble(stored: TrustGrantRow) {
  const store: TrustGrantRow[] = [stored];
  const created: TrustGrantRow[] = [];

  const findUnique = jest.fn(
    async (args: any) => store.find((r) => r.id === args.where.id) ?? null,
  );

  const create = jest.fn(async (args: any) => {
    const made: TrustGrantRow = {
      ...row(),
      id: '66666666-6666-4666-8666-666666666666',
      spentUsd: 0,
      actionsAuthorized: 0,
      actionsFailed: 0,
      status: 'active',
      endedAt: null,
      endReason: null,
      endDetail: null,
      revokedById: null,
      grantedFromProposalId: null,
      note: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...args.data,
    };
    created.push(made);
    return made;
  });

  const updateMany = jest.fn(async (args: any) => {
    const target = store.find((r) => {
      if (r.id !== args.where.id) return false;
      if (args.where.status !== undefined && r.status !== args.where.status) {
        return false;
      }
      // The claim's guard. Honoured rather than ignored, because "prompted
      // once, ever" is the property `claimRenewalPrompt` exists to provide and
      // a double that always matched would pass with the guard deleted.
      if (
        args.where.renewalPromptedAt === null &&
        (r as any).renewalPromptedAt != null
      ) {
        return false;
      }
      return true;
    });
    if (!target) return { count: 0 };
    Object.assign(target, args.data);
    return { count: 1 };
  });

  const tx = { trustGrant: { findUnique, create, updateMany } };

  const prisma = {
    trustGrant: tx.trustGrant,
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as unknown as PrismaService;

  return { prisma, store, created, create, updateMany, findUnique };
}

describe('TrustGrantService.renew (#115)', () => {
  it('creates a successor with the SAME SCOPE and ends the old grant', async () => {
    const db = prismaDouble(row());
    const service = new TrustGrantService(db.prisma);

    const result = await service.renew(row().id, ACTOR, 'still useful', NOW);

    // Scope, unchanged. There is no input on `renew` that could change it.
    expect(result.renewed.actionClass).toBe('re-dispatch');
    expect(result.renewed.repositoryId).toBe(REPO);
    expect(db.create.mock.calls[0]![0].data.actionClass).toBe('re-dispatch');
    expect(db.create.mock.calls[0]![0].data.repositoryId).toBe(REPO);

    // The chain, both ways.
    expect(result.renewed.renewedFromId).toBe(row().id);
    expect(result.ended.id).toBe(row().id);
    expect(result.ended.endReason).toBe('superseded_by_renewal');
    expect(result.ended.status).toBe('revoked');
    expect(result.ended.endedAt).toBe(NOW.toISOString());
    // Forwards as well as backwards: the sentence on the old row names the
    // successor, so an operator reading the digest can follow it without
    // querying for renewals.
    expect(result.ended.endDetail).toContain(result.renewed.id);

    // And the store actually changed — not just the returned view.
    expect(db.store[0]!.status).toBe('revoked');
    expect(db.store[0]!.endReason).toBe('superseded_by_renewal');
  });

  it('attributes the successor to the RENEWING actor, not the original granter', async () => {
    const db = prismaDouble(row());
    const service = new TrustGrantService(db.prisma);

    const result = await service.renew(row().id, ACTOR, null, NOW);

    expect(result.renewed.grantedById).toBe(ACTOR);
    expect(result.renewed.grantedById).not.toBe(GRANTER);
    // And the old row records who ended it, so the chain names a person at
    // every link rather than one person's apparently endless decision.
    expect(result.ended.revokedById).toBe(ACTOR);
  });

  it('takes FRESH attributes from the defaults, not the old grant, and resets the spend', async () => {
    // The old grant had a generous explicit ceiling. Copying it forward would
    // let one afternoon's decision persist for as long as somebody keeps
    // tapping renew.
    const db = prismaDouble(
      row({ budgetCeilingUsd: 500, maxCostPerActionUsd: 100, spentUsd: 480 }),
    );
    const service = new TrustGrantService(db.prisma);

    const result = await service.renew(row().id, ACTOR, null, NOW);

    expect(result.renewed.budgetCeilingUsd).toBe(
      DEFAULT_GRANT_BUDGET_CEILING_USD,
    );
    expect(result.renewed.maxCostPerActionUsd).toBe(
      DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
    );
    expect(result.renewed.expiresAt).toBe(
      new Date(
        NOW.getTime() + DEFAULT_GRANT_EXPIRY_DAYS * DAY_MS,
      ).toISOString(),
    );
    // Fresh budget: the previous spend stays on the old row.
    expect(result.renewed.spentUsd).toBe(0);
    expect(result.renewed.actionsAuthorized).toBe(0);
  });

  it('carries a NARROWER old term through to the successor', async () => {
    const db = prismaDouble(row({ budgetCeilingUsd: 3 }));
    const service = new TrustGrantService(db.prisma);

    const result = await service.renew(row().id, ACTOR, null, NOW);

    expect(result.renewed.budgetCeilingUsd).toBe(3);
  });

  it('does NOT carry the originating proposal forward', async () => {
    // The successor was created by a renewal, not by that proposal's
    // approval. The proposal stays reachable by walking `renewedFromId` back.
    const db = prismaDouble(row());
    const service = new TrustGrantService(db.prisma);

    await service.renew(row().id, ACTOR, null, NOW);

    expect(
      db.create.mock.calls[0]![0].data.grantedFromProposalId,
    ).toBeUndefined();
  });

  it('refuses a grant ONE MILLISECOND past its expiry — renewal creates no grace period', async () => {
    const expiresAt = new Date(NOW.getTime() - 1);
    const db = prismaDouble(row({ expiresAt }));
    const service = new TrustGrantService(db.prisma);

    await expect(service.renew(row().id, ACTOR, null, NOW)).rejects.toThrow(
      TrustGrantNotRenewableException,
    );
    // Nothing was written. A refusal that still created a row would be worse
    // than allowing the renewal.
    expect(db.created).toHaveLength(0);
    expect(db.store[0]!.status).toBe('active');

    await expect(
      service.renew(row().id, ACTOR, null, NOW),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('renews at ONE MILLISECOND BEFORE expiry — the boundary is exclusive on one side only', async () => {
    // The mirror of the test above, so a change that moved the comparison to
    // `<` would fail here rather than silently granting an extra tick.
    const db = prismaDouble(row({ expiresAt: new Date(NOW.getTime() + 1) }));
    const service = new TrustGrantService(db.prisma);

    await expect(
      service.renew(row().id, ACTOR, null, NOW),
    ).resolves.toBeDefined();
  });

  it('refuses a REVOKED grant, distinguishably', async () => {
    const db = prismaDouble(
      row({
        status: 'revoked',
        endedAt: NOW,
        endReason: 'manual_revocation',
        endDetail: 'Revoked because the class was misbehaving.',
      }),
    );
    const service = new TrustGrantService(db.prisma);

    await expect(
      service.renew(row().id, ACTOR, null, NOW),
    ).rejects.toMatchObject({ reason: 'revoked' });
    expect(db.created).toHaveLength(0);
  });

  it('refuses a SUSPENDED grant, distinguishably, and shows the evidence', async () => {
    const db = prismaDouble(
      row({
        status: 'suspended',
        endedAt: NOW,
        endReason: 'failure_rate_exceeded',
        endDetail:
          '6 of 9 authorized actions failed (67%), over the 34% ceiling.',
      }),
    );
    const service = new TrustGrantService(db.prisma);

    const error = await service
      .renew(row().id, ACTOR, null, NOW)
      .catch((e: unknown) => e as TrustGrantNotRenewableException);

    expect(error).toBeInstanceOf(TrustGrantNotRenewableException);
    expect((error as TrustGrantNotRenewableException).reason).toBe('suspended');
    // The numbers travel with the refusal — an operator who cannot check a
    // refusal learns to treat all of them as arbitrary.
    expect((error as any).getResponse().details.endDetail).toContain('67%');
    expect(db.created).toHaveLength(0);
  });

  it('refuses an already-EXPIRED row distinguishably from a revoked one', async () => {
    const db = prismaDouble(
      row({
        status: 'expired',
        expiresAt: new Date(NOW.getTime() - DAY_MS),
        endedAt: new Date(NOW.getTime() - DAY_MS),
        endReason: 'expired',
      }),
    );
    const service = new TrustGrantService(db.prisma);

    await expect(
      service.renew(row().id, ACTOR, null, NOW),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('refuses a class that is no longer autonomy-eligible', async () => {
    // The registry may change under a grant: #99 demotes classes, and VISION
    // §8's never-trustable list can grow. A path named "renew" must not be the
    // one that reissues trust the registry has withdrawn.
    const db = prismaDouble(row({ actionClass: 'quarantine-decision' }));
    const service = new TrustGrantService(db.prisma);

    await expect(
      service.renew(row().id, ACTOR, null, NOW),
    ).rejects.toMatchObject({ reason: 'class-ineligible' });
    expect(db.created).toHaveLength(0);
  });

  it('404s on a grant that does not exist', async () => {
    const db = prismaDouble(row());
    const service = new TrustGrantService(db.prisma);

    await expect(
      service.renew('77777777-7777-4777-8777-777777777777', ACTOR, null, NOW),
    ).rejects.toThrow(NotFoundException);
  });

  it('rolls the successor back when the old grant stopped being active mid-transaction', async () => {
    const db = prismaDouble(row());
    const service = new TrustGrantService(db.prisma);

    // A concurrent revocation, landing after the read and before the close.
    db.updateMany.mockImplementationOnce(async () => ({ count: 0 }));

    await expect(service.renew(row().id, ACTOR, null, NOW)).rejects.toThrow(
      TrustGrantNotRenewableException,
    );
    // The successor row was created inside the transaction and the throw is
    // what rolls it back. What matters is that the method REFUSES rather than
    // returning a grant that outlived its own transaction.
    expect(db.updateMany).toHaveBeenCalled();
  });

  it('has no code path that sets actionClass or repositoryId from an argument', () => {
    // A structural assertion, deliberately. The behavioural tests above prove
    // scope is preserved for the inputs they use; this one fails the moment
    // somebody ADDS a parameter that could change it, which is the change that
    // would make #115's "no renewal path can extend scope" false.
    const source = readFileSync(
      join(__dirname, 'trust-grant.service.ts'),
      'utf8',
    );
    const body = source.slice(
      source.indexOf('  async renew('),
      source.indexOf('  async claimRenewalPrompt('),
    );

    expect(body).toContain('actionClass: old.actionClass');
    expect(body).toContain('repositoryId: old.repositoryId');

    // And the signature mentions neither, so there is nothing to take them
    // from. A parameter that does not exist cannot be widened by a `where`
    // clause getting relaxed later.
    const signature = body.slice(0, body.indexOf('): Promise'));
    expect(signature).not.toMatch(/actionClass|repositoryId/);
  });
});

describe('TrustGrantService.claimRenewalPrompt (#115)', () => {
  it('is won once and only once', async () => {
    const db = prismaDouble(row());
    const service = new TrustGrantService(db.prisma);

    await expect(service.claimRenewalPrompt(row().id, NOW)).resolves.toBe(true);
    await expect(service.claimRenewalPrompt(row().id, NOW)).resolves.toBe(
      false,
    );
  });

  it('claims conditionally on the row being unprompted, not by reading first', async () => {
    const db = prismaDouble(row());
    const service = new TrustGrantService(db.prisma);

    await service.claimRenewalPrompt(row().id, NOW);

    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: row().id, status: 'active', renewalPromptedAt: null },
      data: { renewalPromptedAt: NOW },
    });
    expect(db.findUnique).not.toHaveBeenCalled();
  });
});
