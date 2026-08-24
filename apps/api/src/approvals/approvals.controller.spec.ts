import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import type { ApprovalGateService } from './approval-gate.service';
import {
  ApprovalNotPendingException,
  notPendingFor,
} from './approval-not-pending.exception';
import type { ApprovalRequestView, DecideResult } from './approval.types';
import { ApprovalsController } from './approvals.controller';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function view(
  overrides: Partial<ApprovalRequestView> = {},
): ApprovalRequestView {
  return {
    id: 'a1',
    actionClass: 're-dispatch',
    repositoryId: 'repo-1',
    proposalId: null,
    targetKind: 'work-order',
    targetRef: 'marinoscar/opifex#312',
    summary: 'Re-dispatch work order 312 at attempt 2',
    reasoning: 'The run failed with a 429 from the runner, judged transient.',
    blastRadius: 'One new branch and one runner invocation on the same quota.',
    effects: [{ kind: 'spend', usd: 1.5 }],
    estimatedCostUsd: 1.5,
    timeoutPolicy: 'deny',
    timeoutAt: '2026-08-24T16:00:00.000Z',
    status: 'pending',
    decidedAt: null,
    decidedById: null,
    decidedVia: null,
    decisionNote: null,
    grantId: null,
    createdGrantId: null,
    escalationId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function decideResult(overrides: Partial<DecideResult> = {}): DecideResult {
  return {
    approval: view({ status: 'approved', decidedVia: 'human' }),
    createdGrantId: null,
    grantSkippedReason: null,
    decidedAfterTimeout: false,
    ...overrides,
  };
}

function gateDouble() {
  return {
    listPending: jest.fn(async () => [view()]),
    get: jest.fn(async () => view()),
    decide: jest.fn(async () => decideResult()),
    approvalRatesByClass: jest.fn(async () => []),
  } as unknown as ApprovalGateService & {
    listPending: jest.Mock;
    get: jest.Mock;
    decide: jest.Mock;
    approvalRatesByClass: jest.Mock;
  };
}

function user(permissions: string[]): RequestUser {
  return {
    id: 'user-1',
    email: 'operator@example.com',
    roles: [],
    permissions,
    isActive: true,
  };
}

const DECIDER = user([PERMISSIONS.APPROVALS_DECIDE]);
const ADMIN = user([PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.TRUST_GRANT]);

function build() {
  const gate = gateDouble();
  return { gate, controller: new ApprovalsController(gate) };
}

describe('ApprovalsController', () => {
  // ===========================================================================
  // The gates
  // ===========================================================================
  describe('permissions', () => {
    /**
     * Read off the handler metadata rather than by booting the guard.
     *
     * `PermissionsGuard` is tested on its own; what can silently regress here
     * is the DECORATION — an endpoint that loses its `@Auth` or acquires the
     * wrong permission still compiles, still returns 200 in every other test
     * in this file, and is only wrong in production.
     */
    const required = (handler: unknown): string[] =>
      new Reflector().get<string[]>(PERMISSIONS_KEY, handler as never) ?? [];

    it('gates the queue on approvals:read', () => {
      expect(required(ApprovalsController.prototype.list)).toEqual([
        PERMISSIONS.APPROVALS_READ,
      ]);
    });

    it('gates the detail view on approvals:read', () => {
      expect(required(ApprovalsController.prototype.get)).toEqual([
        PERMISSIONS.APPROVALS_READ,
      ]);
    });

    it('gates the rates read model on approvals:read', () => {
      expect(required(ApprovalsController.prototype.rates)).toEqual([
        PERMISSIONS.APPROVALS_READ,
      ]);
    });

    it('gates deciding on approvals:decide, not on approvals:read', () => {
      // Separate for the reason `escalations:acknowledge` is separate from
      // `escalations:read`: a verdict is not an observation, it is the
      // evidence that grants autonomy later.
      const permissions = required(ApprovalsController.prototype.decide);

      expect(permissions).toEqual([PERMISSIONS.APPROVALS_DECIDE]);
      expect(permissions).not.toContain(PERMISSIONS.APPROVALS_READ);
    });

    it('does NOT put trust:grant on the decide route itself', () => {
      // It must stay conditional on the flag. Declaring it here would make
      // every ordinary approval admin-only, which is the opposite of VISION
      // §8's "approvals must be cheap".
      expect(required(ApprovalsController.prototype.decide)).not.toContain(
        PERMISSIONS.TRUST_GRANT,
      );
    });
  });

  // ===========================================================================
  // GET /approvals
  // ===========================================================================
  describe('list', () => {
    it('passes the three filters through', async () => {
      const { controller, gate } = build();

      await controller.list({
        repositoryId: 'repo-1',
        actionClass: 're-dispatch',
        status: 'parked',
      } as never);

      expect(gate.listPending).toHaveBeenCalledWith({
        repositoryId: 'repo-1',
        actionClass: 're-dispatch',
        status: 'parked',
      });
    });

    it('omits absent filters rather than passing undefined', async () => {
      const { controller, gate } = build();

      await controller.list({} as never);

      expect(gate.listPending).toHaveBeenCalledWith({});
    });

    it('returns the rows unwrapped — the envelope is the interceptor’s job', async () => {
      const { controller } = build();

      expect(await controller.list({} as never)).toEqual([view()]);
    });
  });

  // ===========================================================================
  // GET /approvals/:id
  // ===========================================================================
  describe('get', () => {
    it('joins the registry entry, including the DEFINITION sentence', async () => {
      // VISION §8 requires enough context to decide from a phone, and an
      // operator who has to already know what `re-dispatch` means does not
      // have context, they have a label. #91: "each class has a precise
      // definition, not a category label."
      const { controller } = build();

      const detail = (await controller.get('a1')) as {
        actionClassEntry: {
          title: string;
          definition: string;
          reversibility: string;
          autonomyEligible: boolean;
        } | null;
      };

      expect(detail.actionClassEntry).not.toBeNull();
      expect(detail.actionClassEntry!.title).toBe(
        'Re-dispatch after transient failure',
      );
      expect(detail.actionClassEntry!.definition.length).toBeGreaterThan(20);
      expect(detail.actionClassEntry!.reversibility).toBe(
        'reversible-with-effort',
      );
      expect(typeof detail.actionClassEntry!.autonomyEligible).toBe('boolean');
    });

    it('still returns the approval, with a null entry, for an unknown class', async () => {
      // Not a defensive case. An unknown class PARKS (ADR-0014's conservative
      // default), and ADR-0014 is explicit that a parked approval today most
      // likely means the proposer and the registry have drifted — so the
      // detail view has to render it rather than 500.
      const { controller, gate } = build();
      gate.get.mockResolvedValueOnce(
        view({
          actionClass: 'invented-class',
          status: 'parked',
          timeoutPolicy: 'park_and_escalate',
          timeoutAt: null,
        }),
      );

      const detail = (await controller.get('a1')) as {
        actionClass: string;
        actionClassEntry: unknown;
        timeoutAt: string | null;
      };

      expect(detail.actionClass).toBe('invented-class');
      expect(detail.actionClassEntry).toBeNull();
      // The null timeout is the never-auto-approve guarantee, and it has to
      // survive to the client so no countdown is rendered for it.
      expect(detail.timeoutAt).toBeNull();
    });

    it('keeps every field the decision needs', async () => {
      const { controller } = build();

      const detail = (await controller.get('a1')) as Record<string, unknown>;

      // VISION §8's four, plus the machine record and the promise.
      expect(detail.summary).toBeDefined();
      expect(detail.reasoning).toBeDefined();
      expect(detail.blastRadius).toBeDefined();
      expect(detail.effects).toEqual([{ kind: 'spend', usd: 1.5 }]);
      expect(detail.timeoutPolicy).toBe('deny');
      expect(detail.timeoutAt).toBe('2026-08-24T16:00:00.000Z');
    });
  });

  // ===========================================================================
  // POST /approvals/:id/decide
  // ===========================================================================
  describe('decide', () => {
    it('records an ordinary verdict against the calling user', async () => {
      const { controller, gate } = build();

      await controller.decide(
        'a1',
        { decision: 'approve', note: 'Transient, agreed.' } as never,
        DECIDER,
      );

      expect(gate.decide).toHaveBeenCalledWith('a1', {
        decision: 'approve',
        actorUserId: 'user-1',
        note: 'Transient, agreed.',
      });
    });

    it('omits the flag entirely when it was not sent', async () => {
      const { controller, gate } = build();

      await controller.decide('a1', { decision: 'deny' } as never, DECIDER);

      expect(gate.decide).toHaveBeenCalledWith('a1', {
        decision: 'deny',
        actorUserId: 'user-1',
      });
    });

    describe('"Always approve this class" requires trust:grant as well', () => {
      it('refuses with 403 when the caller lacks trust:grant', async () => {
        const { controller } = build();

        await expect(
          controller.decide(
            'a1',
            { decision: 'approve', alwaysApproveThisClass: true } as never,
            DECIDER,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('does NOT apply the single decision either', async () => {
        // The load-bearing assertion of this file. The operator tapped ONE
        // button meaning "approve this AND stop asking me". Approving the
        // action while silently dropping the grant tells them their intention
        // landed: they stop watching the class, and every later request of it
        // is then resolved by a TIMEOUT — which for an autonomy-eligible
        // class means DENIED by silence (ADR-0014), so the work quietly stops
        // instead of running unattended. Refusing both is recoverable in one
        // step; half-applying is not detectable at all from the operator's
        // side.
        const { controller, gate } = build();

        await expect(
          controller.decide(
            'a1',
            { decision: 'approve', alwaysApproveThisClass: true } as never,
            DECIDER,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(gate.decide).not.toHaveBeenCalled();
      });

      it('says so in a sentence, with a discriminator the cockpit can branch on', async () => {
        const { controller } = build();

        const error = await controller
          .decide(
            'a1',
            { decision: 'approve', alwaysApproveThisClass: true } as never,
            DECIDER,
          )
          .catch((caught: ForbiddenException) => caught);

        const body = (error as ForbiddenException).getResponse() as {
          message: string;
          details: {
            reason: string;
            requiredPermission: string;
            decisionApplied: boolean;
          };
        };

        expect(body.message).toContain('NOT applied');
        expect(body.message).toContain(PERMISSIONS.TRUST_GRANT);
        // `HttpExceptionFilter` overwrites the envelope's `code` from the
        // status code, so the discriminator has to travel in `details.reason`.
        expect(body.details.reason).toBe('trust-grant-required');
        expect(body.details.requiredPermission).toBe(PERMISSIONS.TRUST_GRANT);
        expect(body.details.decisionApplied).toBe(false);
      });

      it('passes the flag through when the caller HAS trust:grant', async () => {
        const { controller, gate } = build();
        gate.decide.mockResolvedValueOnce(
          decideResult({ createdGrantId: 'grant-9' }),
        );

        const result = await controller.decide(
          'a1',
          { decision: 'approve', alwaysApproveThisClass: true } as never,
          ADMIN,
        );

        expect(gate.decide).toHaveBeenCalledWith('a1', {
          decision: 'approve',
          actorUserId: 'user-1',
          alwaysApproveThisClass: true,
        });
        expect(result.createdGrantId).toBe('grant-9');
      });

      it('surfaces grantSkippedReason when the flag minted nothing', async () => {
        // A flag that quietly does nothing is how an operator comes to believe
        // they hold a grant they do not, and then stops watching a class
        // nobody promoted. The sentence has to reach the client.
        const { controller, gate } = build();
        gate.decide.mockResolvedValueOnce(
          decideResult({
            grantSkippedReason:
              'Action class "quarantine-decision" is not autonomy-eligible.',
          }),
        );

        const result = await controller.decide(
          'a1',
          { decision: 'approve', alwaysApproveThisClass: true } as never,
          ADMIN,
        );

        expect(result.createdGrantId).toBeNull();
        expect(result.grantSkippedReason).toContain('not autonomy-eligible');
      });

      it('refuses on the flag even when the decision is a denial', async () => {
        // The permission check is about the FLAG, not about the verdict. A
        // caller without `trust:grant` cannot use it either way, and letting
        // the deny through would make the refusal look verdict-dependent.
        const { controller, gate } = build();

        await expect(
          controller.decide(
            'a1',
            { decision: 'deny', alwaysApproveThisClass: true } as never,
            DECIDER,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(gate.decide).not.toHaveBeenCalled();
      });

      it('lets an explicit false through untouched', async () => {
        const { controller, gate } = build();

        await controller.decide(
          'a1',
          { decision: 'approve', alwaysApproveThisClass: false } as never,
          DECIDER,
        );

        expect(gate.decide).toHaveBeenCalledWith('a1', {
          decision: 'approve',
          actorUserId: 'user-1',
          alwaysApproveThisClass: false,
        });
      });
    });

    describe('an approval that is no longer open', () => {
      /**
       * A 409 that NAMES which of the four ways it was resolved.
       *
       * #98: "an approval arriving after its timeout is handled
       * unambiguously." A generic conflict does not satisfy that — "somebody
       * else answered this" and "the clock answered it while you were typing"
       * call for completely different things from the operator.
       */
      type ResolvedRow = Parameters<typeof notPendingFor>[0];

      const resolved = (overrides: Partial<ResolvedRow>) =>
        notPendingFor({
          id: 'a1',
          status: 'approved',
          decidedVia: 'human',
          decidedAt: new Date('2026-08-24T11:00:00.000Z'),
          decidedById: 'user-2',
          timeoutPolicy: 'deny',
          ...overrides,
        });

      it('names an already-decided approval, and who decided it', async () => {
        const { controller, gate } = build();
        gate.decide.mockRejectedValueOnce(resolved({}));

        const error = await controller
          .decide('a1', { decision: 'approve' } as never, DECIDER)
          .catch((caught: unknown) => caught as ApprovalNotPendingException);

        const body = (error as ApprovalNotPendingException).getResponse() as {
          message: string;
          details: { reason: string; decidedById: string };
        };

        expect((error as ApprovalNotPendingException).getStatus()).toBe(409);
        expect(body.details.reason).toBe('already-decided-by-human');
        expect(body.details.decidedById).toBe('user-2');
        expect(body.message).toContain('user-2');
      });

      it('names a timed-out approval as timed out, not as decided', async () => {
        const { controller, gate } = build();
        gate.decide.mockRejectedValueOnce(
          resolved({
            status: 'auto_denied',
            decidedVia: 'timeout',
            decidedById: null,
          }),
        );

        const error = await controller
          .decide('a1', { decision: 'approve' } as never, DECIDER)
          .catch((caught: unknown) => caught as ApprovalNotPendingException);

        const body = (error as ApprovalNotPendingException).getResponse() as {
          message: string;
          details: { reason: string };
        };

        expect(body.details.reason).toBe('already-timed-out');
        // Silence is not evidence either way, and the message says so — an
        // operator who reads this as a rejection would draw the wrong lesson
        // about the class.
        expect(body.message).toContain('not evidence');
      });

      it('names a superseded approval as superseded, so it can be raised again', async () => {
        const { controller, gate } = build();
        gate.decide.mockRejectedValueOnce(
          resolved({
            status: 'superseded',
            decidedVia: null,
            decidedById: null,
          }),
        );

        const error = await controller
          .decide('a1', { decision: 'approve' } as never, DECIDER)
          .catch((caught: unknown) => caught as ApprovalNotPendingException);

        const body = (error as ApprovalNotPendingException).getResponse() as {
          message: string;
          details: { reason: string };
        };

        expect(body.details.reason).toBe('superseded');
        expect(body.message).toContain('raise it again');
      });

      it('distinguishes all four resolutions from one another', async () => {
        const reasons = [
          resolved({}),
          resolved({ status: 'auto_approved', decidedVia: 'timeout' }),
          resolved({ decidedVia: 'grant' }),
          resolved({ status: 'superseded', decidedVia: null }),
        ].map(
          (exception) =>
            (exception.getResponse() as { details: { reason: string } }).details
              .reason,
        );

        expect(new Set(reasons).size).toBe(4);
      });
    });
  });

  // ===========================================================================
  // GET /approvals/rates
  // ===========================================================================
  describe('rates', () => {
    it('passes the window through', async () => {
      const { controller, gate } = build();

      await controller.rates({ days: 7 } as never);

      expect(gate.approvalRatesByClass).toHaveBeenCalledWith(7);
    });
  });
});
