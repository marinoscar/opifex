import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import type { ApprovalGateService } from '../approvals/approval-gate.service';
import type { ClassApprovalRates } from '../approvals/approval.types';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import type { FallbackWebhookTransport } from '../notifications/fallback-webhook.transport';
import type { PushSubscriptionsService } from '../notifications/push-subscriptions.service';
import type { WebPushTransport } from '../notifications/web-push.transport';
import type { PrismaService } from '../prisma/prisma.service';
import { ACTION_CLASSES } from '../supervisor/action-classes';
import type { DecisionLogService } from '../supervisor/decision-log/decision-log.service';
import type { ActionClassApprovalRate } from '../supervisor/decision-log/decision-log.types';
import type { TrustGrantService } from '../trust/trust-grant.service';
import { PromotionController } from './promotion.controller';
import {
  MIN_SAMPLE,
  REGRESSION_WINDOW_DAYS,
  holdDetail,
  shortfallCount,
} from './promotion-policy';
import { PromotionService } from './promotion.service';

const CLASS = 're-dispatch';

function proposalRate(
  actionClass: string,
  wouldApprove: number,
  wouldReject: number,
): ActionClassApprovalRate {
  const judged = wouldApprove + wouldReject;
  return {
    actionClass,
    proposed: judged,
    declined: 0,
    wouldApprove,
    wouldReject,
    pendingReview: 0,
    approvalRate: judged === 0 ? null : wouldApprove / judged,
  };
}

interface StoredState {
  actionClass: string;
  rung: 'observe' | 'measure' | 'promoted';
  changedAt: Date;
  changeReason: string | null;
  changeDetail: string | null;
  evidenceJson: unknown;
  promotedAt: Date | null;
  demotedAt: Date | null;
  demotionCount: number;
}

function storedState(
  actionClass: string,
  rung: StoredState['rung'],
  overrides: Partial<StoredState> = {},
): StoredState {
  return {
    actionClass,
    rung,
    changedAt: new Date('2026-08-01T00:00:00.000Z'),
    changeReason: rung === 'promoted' ? 'promoted_on_evidence' : null,
    changeDetail: null,
    evidenceJson: null,
    promotedAt:
      rung === 'promoted' ? new Date('2026-08-01T00:00:00.000Z') : null,
    demotedAt: null,
    demotionCount: 0,
    ...overrides,
  };
}

/**
 * A real `PromotionService` over in-memory doubles, not a stubbed service.
 *
 * The property this file exists to protect is that `requirement` is the POLICY
 * LAYER'S sentence and not a second computation — and a stubbed service would
 * make that untestable by construction, since the string would be whatever the
 * stub returned. So the controller runs over the real service, the real
 * `evaluateLadder`, and doubles only at the database and transport edges.
 */
function build(
  options: {
    enabled?: boolean;
    proposalsLifetime?: ActionClassApprovalRate[];
    proposalsRecent?: ActionClassApprovalRate[];
    states?: StoredState[];
    activeGrants?: { id: string }[];
  } = {},
) {
  const rows = new Map(
    (options.states ?? []).map((row) => [row.actionClass, { ...row }]),
  );

  const upsert = jest.fn(async (args: any) => {
    const key = args.where.actionClass as string;
    const existing = rows.get(key);
    if (existing) {
      rows.set(key, { ...existing, ...args.update } as StoredState);
    } else {
      rows.set(key, {
        demotionCount: 0,
        promotedAt: null,
        demotedAt: null,
        ...args.create,
      } as StoredState);
    }
    return rows.get(key);
  });

  const prisma = {
    promotionState: {
      findMany: jest.fn(async () => [...rows.values()].map((r) => ({ ...r }))),
      findUnique: jest.fn(async (args: any) => {
        const row = rows.get(args.where.actionClass as string);
        return row ? { ...row } : null;
      }),
      upsert,
    },
    trustGrant: { findMany: jest.fn(async () => options.activeGrants ?? []) },
  } as unknown as PrismaService;

  const approvalRates = jest.fn(async (since?: Date) =>
    since === undefined
      ? (options.proposalsLifetime ?? [])
      : (options.proposalsRecent ?? []),
  );

  const suspend = jest.fn(
    async (_id: string, _reason: string, _detail: string, _now?: Date) => true,
  );

  const service = new PromotionService(
    prisma,
    {
      approvalRatesByClass: jest.fn(
        async () => [] as unknown as ClassApprovalRates[],
      ),
    } as unknown as ApprovalGateService,
    { approvalRates } as unknown as DecisionLogService,
    { suspend } as unknown as TrustGrantService,
    {
      targets: jest.fn(async () => []),
    } as unknown as PushSubscriptionsService,
    {
      isConfigured: () => false,
      send: jest.fn(),
    } as unknown as WebPushTransport,
    {
      isConfigured: () => false,
      send: jest.fn(),
    } as unknown as FallbackWebhookTransport,
    new ConfigService({
      appUrl: 'https://opifex.example',
      promotion: { enabled: options.enabled ?? true },
    }),
  );

  return {
    rows,
    suspend,
    service,
    controller: new PromotionController(service),
  };
}

describe('PromotionController (#101)', () => {
  // ===========================================================================
  // The gates, and the endpoint that must not exist
  // ===========================================================================
  describe('permissions', () => {
    const required = (handler: unknown): string[] =>
      new Reflector().get<string[]>(PERMISSIONS_KEY, handler as never) ?? [];

    it('gates the ladder read on trust:read', () => {
      expect(required(PromotionController.prototype.states)).toEqual([
        PERMISSIONS.TRUST_READ,
      ]);
    });

    it('gates the per-class read on trust:read', () => {
      expect(required(PromotionController.prototype.state)).toEqual([
        PERMISSIONS.TRUST_READ,
      ]);
    });

    it('gates manual demotion on trust:revoke, NOT on trust:grant', () => {
      // Narrowing authority must never be gated on the permission that widens
      // it: an operator who can see a class misbehaving has to be able to stop
      // it without also holding the power to grant.
      const permissions = required(PromotionController.prototype.demote);

      expect(permissions).toEqual([PERMISSIONS.TRUST_REVOKE]);
      expect(permissions).not.toContain(PERMISSIONS.TRUST_GRANT);
    });

    it('exposes NO promote handler at all', () => {
      // VISION §7: promotion is earned on a demonstrated record and demotion
      // is "automatic on regression, not a judgment call". A hand-promotion is
      // exactly the judgement call the ladder removes, and it would also
      // corrupt the measurement — the frozen evidence behind such a rung would
      // describe a decision made on no evidence. Asserted structurally, so
      // adding one is a failing test rather than a code review someone has to
      // catch.
      const handlers = Object.getOwnPropertyNames(
        PromotionController.prototype,
      );

      expect(handlers).not.toContain('promote');
      expect(handlers.filter((name) => /promot/i.test(name))).toEqual([]);
    });
  });

  // ===========================================================================
  // GET /promotion/states
  // ===========================================================================
  describe('states', () => {
    it("reports the policy layer's shortfall sentence UNCHANGED", async () => {
      // 18 of 20 samples, all approved. The class is short on SAMPLE, not on
      // rate, and the policy layer says so in one sentence.
      const { controller } = build({
        proposalsLifetime: [proposalRate(CLASS, 18, 0)],
      });

      const ladder = await controller.states();
      const state = ladder.states.find((s) => s.actionClass === CLASS)!;

      // Identity with `holdDetail`, not a hardcoded string. A test that
      // asserted the prose would still pass if the controller computed its own
      // number and happened to phrase it the same way; this one fails the
      // moment the two implementations diverge, which is the whole point of
      // there being only one.
      expect(state.requirement).toBe(
        holdDetail(state.rung, state.currentEvidence),
      );
      expect(state.requirement).toContain(`${MIN_SAMPLE - 18} more needed`);
      expect(state.wouldChange).toBeNull();

      // And the numbers behind it, so a bar can be drawn without parsing.
      expect(state.currentEvidence.sample).toBe(18);
      expect(state.currentEvidence.rate).toBe(1);
      expect(ladder.thresholds.minSample).toBe(MIN_SAMPLE);
    });

    it('reports the rate shortfall as a count of approvals, from the policy layer', async () => {
      const { controller } = build({
        proposalsLifetime: [proposalRate(CLASS, 15, 5)],
      });

      const ladder = await controller.states();
      const state = ladder.states.find((s) => s.actionClass === CLASS)!;

      expect(state.requirement).toBe(
        holdDetail(state.rung, state.currentEvidence),
      );
      expect(state.requirement).toContain(
        `${shortfallCount(state.currentEvidence)} more approval(s)`,
      );
    });

    it('reports the ladder as globally disabled', async () => {
      const { controller } = build({ enabled: false });

      await expect(controller.states()).resolves.toMatchObject({
        enabled: false,
      });
    });

    it('reports it as enabled when PROMOTION_LADDER_ENABLED is on', async () => {
      const { controller } = build({ enabled: true });

      await expect(controller.states()).resolves.toMatchObject({
        enabled: true,
      });
    });

    it('still says what a class needs while the ladder is switched off', async () => {
      // Deliberate: `evaluateLadder` rule 2 short-circuits a paused ladder to
      // "the ladder is paused" for EVERY class. Since the flag defaults off,
      // reporting that per class would replace every actionable shortfall with
      // the same sentence about a flag — on most deployments, always. The
      // pause is reported ONCE, at the top; the evidence is reported per class.
      const { controller } = build({
        enabled: false,
        proposalsLifetime: [proposalRate(CLASS, 18, 0)],
      });

      const ladder = await controller.states();
      const state = ladder.states.find((s) => s.actionClass === CLASS)!;

      expect(state.requirement).toContain('more needed');
      expect(state.requirement).not.toContain('paused');
    });

    it('reports wouldChange as a forecast a disabled ladder will not act on', async () => {
      const { controller } = build({
        enabled: false,
        proposalsLifetime: [proposalRate(CLASS, MIN_SAMPLE, 0)],
      });

      const ladder = await controller.states();
      const state = ladder.states.find((s) => s.actionClass === CLASS)!;

      // "It has earned promotion AND the ladder is off" is the single most
      // important thing this endpoint can say, and it takes both fields.
      expect(state.wouldChange).toBe('promote');
      expect(ladder.enabled).toBe(false);
      expect(state.rung).toBe('observe');
    });

    it('lists every registered class, including ones the ladder has never seen', async () => {
      const { controller } = build();

      const ladder = await controller.states();

      // A class MISSING from the list is indistinguishable from a class
      // nothing has ever proposed.
      expect(ladder.states.length).toBeGreaterThanOrEqual(
        ACTION_CLASSES.length,
      );
      for (const entry of ACTION_CLASSES) {
        expect(ladder.states.map((s) => s.actionClass)).toContain(entry.id);
      }
    });

    it('joins the registry title and never falls back to the raw id', async () => {
      const { controller } = build({
        states: [storedState('retired-class', 'promoted')],
      });

      const ladder = await controller.states();
      const byClass = new Map(
        ladder.states.map((s) => [s.actionClass, s.actionClassTitle]),
      );

      expect(byClass.get(CLASS)).toBe('Re-dispatch after transient failure');
      // A retired class keeps its row — it may be standing on the promoted
      // rung right now — and its missing title travels as null.
      expect(byClass.get('retired-class')).toBeNull();
    });

    it('says an ineligible class can never be promoted, whatever its record', async () => {
      const { controller } = build({
        proposalsLifetime: [proposalRate('quarantine-decision', 100, 0)],
      });

      const ladder = await controller.states();
      const state = ladder.states.find(
        (s) => s.actionClass === 'quarantine-decision',
      )!;

      expect(state.eligible).toBe(false);
      expect(state.requirement).toContain('can never be promoted');
      expect(state.wouldChange).toBeNull();
    });
  });

  // ===========================================================================
  // GET /promotion/states/:actionClass
  // ===========================================================================
  describe('state', () => {
    it('carries the FROZEN evidence and the change history', async () => {
      const frozen = {
        actionClass: CLASS,
        approved: 20,
        rejected: 0,
        sample: 20,
        rate: 1,
        recentApproved: 0,
        recentRejected: 0,
        recentSample: 0,
        recentRate: null,
        fromProposals: 20,
        fromApprovals: 0,
      };

      const { controller } = build({
        states: [
          storedState(CLASS, 'promoted', {
            evidenceJson: frozen,
            changeDetail: 'Approval rate 100% over 20 human decision(s).',
            demotionCount: 2,
            demotedAt: new Date('2026-07-01T00:00:00.000Z'),
          }),
        ],
        // The factory has moved on since the decision.
        proposalsLifetime: [proposalRate(CLASS, 30, 1)],
      });

      const body = await controller.state(CLASS);

      // Frozen: the counts the decision was actually made from, never
      // refreshed. Evidence that moved afterwards cannot be checked against
      // the decision, which is the only thing stating it was for.
      expect(body.state.evidence).toEqual(frozen);
      // Live: the factory as it stands now. Different claim, different field.
      expect(body.state.currentEvidence.sample).toBe(31);
      expect(body.state.changeReason).toBe('promoted_on_evidence');
      expect(body.state.changeDetail).toContain('100%');
      expect(body.state.demotionCount).toBe(2);
      expect(body.state.promotedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(body.state.demotedAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('repeats the global switch, so a deep link is not misleading', async () => {
      const { controller } = build({ enabled: false });

      await expect(controller.state(CLASS)).resolves.toMatchObject({
        enabled: false,
      });
    });

    it('answers observe for a registered class the ladder has never evaluated', async () => {
      // "The cron has not run" is not "the class does not exist"; a read that
      // 404'd until an hourly job had fired would look broken on a fresh
      // install.
      const { controller } = build();

      const body = await controller.state(CLASS);

      expect(body.state.rung).toBe('observe');
      expect(body.state.evidence).toBeNull();
      expect(body.state.demotionCount).toBe(0);
    });

    it('404s on an id that is neither registered nor stored', async () => {
      const { controller } = build();

      await expect(controller.state('re-dispach')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('still answers for a stored class that has left the registry', async () => {
      const { controller } = build({
        states: [storedState('retired-class', 'promoted')],
      });

      await expect(controller.state('retired-class')).resolves.toMatchObject({
        state: { rung: 'promoted', actionClassTitle: null },
      });
    });
  });

  // ===========================================================================
  // POST /promotion/states/:actionClass/demote
  // ===========================================================================
  describe('demote', () => {
    const promoted = () =>
      build({
        states: [storedState(CLASS, 'promoted')],
        proposalsLifetime: [proposalRate(CLASS, MIN_SAMPLE, 0)],
        activeGrants: [{ id: 'g1' }, { id: 'g2' }],
      });

    it('suspends every active grant for the class — the durable effect', async () => {
      const { controller, suspend } = promoted();

      const result = await controller.demote(CLASS, {} as never, 'admin-9');

      expect(result.grantsSuspended).toBe(2);
      expect(suspend).toHaveBeenCalledTimes(2);
      // Suspended, not revoked: this is the system acting on a human's
      // judgement about a class, and `TrustGrantService` keeps the two verbs
      // distinct.
      expect(suspend.mock.calls[0]![1]).toBe('class_demoted');
    });

    it('records the change as demoted_manually with the actor in the detail', async () => {
      const { controller, rows } = promoted();

      const result = await controller.demote(
        CLASS,
        { note: 'Bad diffs nobody rejected because nobody looked.' } as never,
        'admin-9',
      );

      const stored = rows.get(CLASS)!;
      expect(stored.rung).toBe('measure');
      expect(stored.changeReason).toBe('demoted_manually');
      // The actor travels in prose because `promotion_states` has no actor
      // column. That is a gap in the provenance graph, named rather than
      // hidden — see `demoteManually`.
      expect(stored.changeDetail).toContain('admin-9');
      expect(stored.changeDetail).toContain('Bad diffs');
      expect(stored.demotionCount).toBe(1);
      expect(result.state.rung).toBe('measure');
    });

    it('warns that the ladder will restore the rung when the record still clears the bar', async () => {
      const { controller } = promoted();

      const result = await controller.demote(CLASS, {} as never, 'admin-9');

      // The COMMON case, not an edge one. Nothing records a human hold-down,
      // so the next evaluation re-promotes on the lifetime record — while the
      // suspended grants stay suspended, so nothing resumes running. An
      // operator not told this would conclude the demotion had failed.
      expect(result.rungMayBeRestoredByLadder).toBe(true);
      expect(result.grantsSuspended).toBe(2);
    });

    it('does not warn when the record no longer supports promotion', async () => {
      const { controller } = build({
        states: [storedState(CLASS, 'promoted')],
        proposalsLifetime: [proposalRate(CLASS, 10, 10)],
        activeGrants: [],
      });

      const result = await controller.demote(CLASS, {} as never, 'admin-9');

      expect(result.rungMayBeRestoredByLadder).toBe(false);
    });

    it('409s on a class that is not promoted, and changes nothing', async () => {
      const { controller, rows, suspend } = build({
        states: [storedState(CLASS, 'measure')],
        activeGrants: [{ id: 'g1' }],
      });

      await expect(
        controller.demote(CLASS, {} as never, 'admin-9'),
      ).rejects.toBeInstanceOf(ConflictException);

      // In particular it does NOT suspend grants. A class can hold grants
      // without being promoted — grants come from a human tap, not from the
      // ladder — and answering 200 here would tell an operator their grants
      // had been dealt with when they had not.
      expect(suspend).not.toHaveBeenCalled();
      expect(rows.get(CLASS)!.rung).toBe('measure');
    });

    it('names the conflict in details.reason and says where the class stands', async () => {
      const { controller } = build({
        states: [storedState(CLASS, 'measure')],
      });

      await controller.demote(CLASS, {} as never, 'admin-9').then(
        () => {
          throw new Error('expected a conflict');
        },
        (error: ConflictException) => {
          const body = error.getResponse() as {
            details: { reason: string; rung: string };
            message: string;
          };
          expect(body.details.reason).toBe('not-promoted');
          expect(body.details.rung).toBe('measure');
          // Points at the thing that actually stops execution.
          expect(body.message).toContain('/api/trust/grants/');
        },
      );
    });

    it('recomputes nothing: the recent window in the detail comes from the policy layer', async () => {
      const { controller, rows } = promoted();

      await controller.demote(CLASS, {} as never, 'admin-9');

      expect(rows.get(CLASS)!.changeDetail).toContain(
        `last ${REGRESSION_WINDOW_DAYS} days`,
      );
    });
  });
});
