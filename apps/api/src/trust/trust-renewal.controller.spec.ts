import { Reflector } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { renewTrustGrantSchema } from './dto/trust-renewal.dto';
import type { TrustGrantService } from './trust-grant.service';
import type {
  RenewTrustGrantResult,
  TrustGrantView,
} from './trust-grant.types';
import { TrustRenewalController } from './trust-renewal.controller';

/**
 * `POST /api/trust/grants/:id/renew` (#115, VISION §8).
 *
 * What can silently regress at this layer is the CONTRACT rather than the
 * behaviour: an endpoint that loses its `@Auth`, or that grows an attributes
 * field on its body, still compiles and still returns 201 in every other test.
 * Both would be a widening path with "renew" on the button, which is the one
 * thing #115 says must not exist.
 */

const NOW = new Date('2026-08-24T12:00:00.000Z');
const GRANT = '44444444-4444-4444-8444-444444444444';
const ACTOR = '22222222-2222-4222-8222-222222222222';

function view(overrides: Partial<TrustGrantView> = {}): TrustGrantView {
  return {
    id: GRANT,
    actionClass: 're-dispatch',
    repositoryId: 'repo-1',
    expiresAt: NOW.toISOString(),
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
    grantedById: ACTOR,
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    remainingBudgetUsd: 25,
    budgetHeadroomFraction: 1,
    msUntilExpiry: 0,
    failureRate: null,
    nearExpiry: false,
    nearBudget: false,
    ...overrides,
  };
}

function serviceDouble() {
  const result: RenewTrustGrantResult = {
    renewed: view({
      id: '66666666-6666-4666-8666-666666666666',
      renewedFromId: GRANT,
    }),
    ended: view({ status: 'revoked', endReason: 'superseded_by_renewal' }),
  };

  return {
    renew: jest.fn(async () => result),
  } as unknown as TrustGrantService & { renew: jest.Mock };
}

describe('TrustRenewalController (#115)', () => {
  describe('the gate', () => {
    /**
     * Read off the handler metadata rather than by booting the guard, exactly
     * as `ApprovalsController`'s spec does: `PermissionsGuard` is tested on
     * its own, and what regresses here is the DECORATION.
     */
    const required = (handler: unknown): string[] =>
      new Reflector().get<string[]>(PERMISSIONS_KEY, handler as never) ?? [];

    it('requires trust:grant, because a renewal IS a grant', () => {
      // Not a weaker `trust:renew`. A renewal writes a new row authorizing
      // unattended execution for another fortnight with the renewing user's
      // name on it — the same authority "Always approve this class"
      // exercises, which `ApprovalsController` refuses outright without this
      // permission. A separate renewal permission would be a way to hold trust
      // indefinitely without ever being allowed to grant it.
      expect(required(TrustRenewalController.prototype.renew)).toEqual([
        PERMISSIONS.TRUST_GRANT,
      ]);
    });
  });

  describe('the body', () => {
    it('accepts a note and nothing else', () => {
      expect(renewTrustGrantSchema.parse({ note: 'still earning it' })).toEqual(
        { note: 'still earning it' },
      );
      expect(renewTrustGrantSchema.parse({})).toEqual({});
    });

    it('has no attribute field a caller could widen the grant with', () => {
      // The enforcement is the ABSENCE of the field, not a check on it. zod
      // strips unknown keys, so anything sent here never reaches the service —
      // and the service takes no attributes either, so there are two layers
      // and neither has a widening path.
      const parsed = renewTrustGrantSchema.parse({
        note: 'hi',
        budgetCeilingUsd: 100_000,
        expiresAt: '2099-01-01T00:00:00.000Z',
        actionClass: 'quarantine-decision',
        repositoryId: 'some-other-repo',
      } as never);

      expect(parsed).toEqual({ note: 'hi' });
      expect(Object.keys(renewTrustGrantSchema.shape)).toEqual(['note']);
    });
  });

  describe('renewing', () => {
    it('passes the grant id, the CALLER as the actor, and the note', async () => {
      const service = serviceDouble();
      const controller = new TrustRenewalController(service);

      await controller.renew(GRANT, { note: 'still useful' }, ACTOR);

      expect(service.renew).toHaveBeenCalledWith(GRANT, ACTOR, 'still useful');
    });

    it('normalises an absent note to null rather than passing undefined', async () => {
      const service = serviceDouble();
      const controller = new TrustRenewalController(service);

      await controller.renew(GRANT, {}, ACTOR);

      expect(service.renew).toHaveBeenCalledWith(GRANT, ACTOR, null);
    });

    it('returns BOTH rows so the caller can show the chain', async () => {
      // Only the successor would be indistinguishable from "a second grant was
      // created alongside the first" — two live grants for one scope with two
      // independent ceilings, and no way to tell from this screen.
      const controller = new TrustRenewalController(serviceDouble());

      const result = await controller.renew(GRANT, {}, ACTOR);

      expect(result.ended.id).toBe(GRANT);
      expect(result.ended.endReason).toBe('superseded_by_renewal');
      expect(result.renewed.renewedFromId).toBe(GRANT);
    });

    it("returns the plain object — the envelope is the interceptor's job", async () => {
      const controller = new TrustRenewalController(serviceDouble());

      const result = await controller.renew(GRANT, {}, ACTOR);

      expect(Object.keys(result).sort()).toEqual(['ended', 'renewed']);
    });
  });
});
