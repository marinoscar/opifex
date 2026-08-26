import { Injectable, Logger } from '@nestjs/common';

import { HardSpendCeilingService } from '../budget/hard-spend-ceiling';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkNeverTrustable,
  type AutonomyEffect,
  type NeverTrustableRefusal,
} from './never-trustable';

/**
 * What an executor asks the boundary to allow.
 *
 * `effects` is REQUIRED. ADR-0013 rests on that: "an optional field is a field
 * someone forgets, and 'someone forgot' is not a security property." An
 * executor that cannot say what it is about to do does not typecheck, let
 * alone run.
 */
export interface AutonomyEnforcementRequest {
  /**
   * The class the action belongs to, for the audit trail only.
   *
   * A plain string, not `ActionClassId`, and the guard never reads it. ADR-0013
   * is explicit that a refusal can fire "against an action of a class nobody
   * has ever promoted, or that has no `autonomyEligible` row at all" — the
   * whole reason the check is on the effect is that it does not need the class
   * to be right.
   */
  actionClass: string;
  /** Everything this action would do. Derive it with `effectsFor`. */
  effects: readonly AutonomyEffect[];
  /** The `SupervisorProposal` this came from, when it came from one. */
  proposalId?: string;
  /** The trust grant being exercised (#96), when one is. */
  grantId?: string;
  /** A run id, work order identity or `owner/name#number`. */
  targetRef?: string;
  /** The human on whose behalf this ran, if any. Autonomy usually has none. */
  actorUserId?: string;
}

/**
 * Permitted, or refused with every rule that matched.
 *
 * A discriminated union rather than a boolean plus an out-parameter, so a
 * caller cannot read `refusals` without having first established there are
 * some, and cannot proceed on `permitted` without the compiler agreeing.
 */
export type NeverTrustableVerdict =
  { permitted: true } | { permitted: false; refusals: NeverTrustableRefusal[] };

/**
 * The execution boundary's never-trustable check, with a record (#95).
 *
 * Thin by design. All of the judgement is in `never-trustable.ts`, which reads
 * no configuration and can be tested without a container; this class exists to
 * supply the one value that guard needs from the outside world — the #65 hard
 * ceiling, which since #345 an admin can move through an audited, interactive
 * write and nothing else can (ADR-0018 §6) — and to add the
 * audit row ADR-0013 requires, because "a refusal that is silently dropped
 * at the boundary makes that signal invisible at the exact moment it would
 * matter most: repeated attempts are how a misbehaving proposer or a promotion
 * mistake would first show up."
 *
 * What it deliberately does NOT do: record permitted executions. VISION §8's
 * digest — "auto-approved actions still record what would have been asked" —
 * is real and is #97/#100's. Building half of it here would produce a second
 * partial record of the same events for the digest to disagree with.
 */
@Injectable()
export class NeverTrustableService {
  private readonly logger = new Logger(NeverTrustableService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ceiling: HardSpendCeilingService,
  ) {}

  async enforce(
    request: AutonomyEnforcementRequest,
  ): Promise<NeverTrustableVerdict> {
    // `.value` is a copy of a frozen-by-convention record read from the
    // environment once at boot. Nothing between here and there can raise it:
    // no endpoint, no setting, no trust grant (#65).
    const refusals = checkNeverTrustable(request.effects, this.ceiling.value);

    if (refusals.length === 0) {
      return { permitted: true };
    }

    this.logger.warn(
      `Refused ${request.actionClass}: ` +
        refusals.map((refusal) => refusal.reason).join(' '),
    );

    await this.record(request, refusals);

    return { permitted: false, refusals };
  }

  /**
   * One `AuditEvent` per refused action, however many rules matched.
   *
   * One row and not one per rule, because the event being recorded is the
   * ATTEMPT. Three rows would make a single action that tried three forbidden
   * things look like three separate incidents, and the count of refusals is
   * the number #95 wants to watch for escalation.
   */
  private async record(
    request: AutonomyEnforcementRequest,
    refusals: readonly NeverTrustableRefusal[],
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: request.actorUserId ?? null,
          action: 'autonomy.refused',
          targetType: 'action-class',
          targetId: request.actionClass,
          meta: {
            // Three index-aligned arrays: rule ids for aggregation, reasons
            // for a human reading one row, effects for reconstructing what
            // was actually attempted.
            rules: refusals.map((refusal) => refusal.rule),
            reasons: refusals.map((refusal) => refusal.reason),
            effects: refusals.map((refusal) => refusal.effect),
            proposalId: request.proposalId ?? null,
            grantId: request.grantId ?? null,
            targetRef: request.targetRef ?? null,
          } as never,
        },
      });
    } catch (error) {
      // The refusal has ALREADY been decided by the time we get here, and it
      // stands whether or not this write lands. A guard whose enforcement
      // depends on a successful database write is a guard that fails open
      // under exactly the load that makes writes fail — which is the one
      // condition under which nobody would notice it had.
      //
      // The cost of swallowing this is a real one and worth naming: a refusal
      // that was never recorded is invisible to the digest, so the log is a
      // lower bound on attempts, not a count. That is the right trade against
      // the alternative, where a failing database authorises a force-push.
      this.logger.error(
        `Refusal recorded in memory only — audit write failed for ` +
          `${request.actionClass}: ${describeError(error)}`,
      );
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
