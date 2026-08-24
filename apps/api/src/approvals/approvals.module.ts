import { Module } from '@nestjs/common';

import { AutonomyModule } from '../autonomy/autonomy.module';
import { EscalationsModule } from '../escalations/escalations.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TrustModule } from '../trust/trust.module';
import { ApprovalGateService } from './approval-gate.service';
import { ApprovalGateTask } from './approval-gate.task';

/**
 * The approval gate (#97, epic #22, VISION §8).
 *
 * Four imports, and each is one of the three answers the gate can give plus
 * the store that records them:
 *
 * - `AutonomyModule` — ADR-0013's never-trustable guard, consulted FIRST so no
 *   grant can be the reason a forbidden effect proceeds.
 * - `TrustModule` — #96's grants, the thing that actually delivers autonomy
 *   under ADR-0014's order.
 * - `EscalationsModule` — for `park_and_escalate`, where VISION §8 requires a
 *   human be told rather than the request closing silently.
 * - `PrismaModule` — the `ApprovalRequest` row, which is the record VISION §8's
 *   digest and #99's ladder both read.
 *
 * ## What is deliberately absent
 *
 * No dispatcher, no GitHub client, no runner registry. This module decides
 * whether something MAY proceed; it must not be able to make it proceed.
 * `TrustModule` and `SupervisorModule` both make this argument about
 * themselves and #90 states the rule: a capability absent from the module
 * graph is structurally unavailable, while a capability that is merely unused
 * is one convenient afternoon from being used. It matters here for the same
 * reason it matters there — the gate is the thing standing between a proposal
 * and an effect, and a gate that can also open the door is not a gate.
 *
 * No `ConfigModule` either. `TIMEOUT_WINDOW_MS` is a constant in code, and
 * ADR-0014 disqualifies configurable timeouts: "a safety default that can be
 * set per class is a policy, not a guarantee." A `ConfigModule` in this list
 * would be the first visible step toward one.
 *
 * No controller — #98 owns the HTTP surface, including the `approvals:read` /
 * `approvals:decide` split and the extra `trust:grant` check that "Always
 * approve this class" requires.
 */
@Module({
  imports: [PrismaModule, AutonomyModule, TrustModule, EscalationsModule],
  providers: [ApprovalGateService, ApprovalGateTask],
  exports: [ApprovalGateService],
})
export class ApprovalsModule {}
