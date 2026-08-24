import { Module } from '@nestjs/common';

import { AutonomyModule } from '../autonomy/autonomy.module';
import { EscalationsModule } from '../escalations/escalations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TrustModule } from '../trust/trust.module';
import { ApprovalGateService } from './approval-gate.service';
import { ApprovalGateTask } from './approval-gate.task';
import { ApprovalsController } from './approvals.controller';

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
 * - `NotificationsModule` — #98's other half. VISION §8's requirement is not
 *   that an approval be RECORDED but that it be answerable "one tap from a
 *   phone", and a queue nobody is told about is the 2am email read at 9am the
 *   vision opens by naming. This imports the two transports only; it does NOT
 *   import a dispatcher that could act.
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
 * Still no executor. `NotificationsModule` is a way to TELL a human, not a way
 * to do anything: the transports send text to a device, and the strongest
 * thing this module can now cause is a phone to light up. That is the same
 * line #90 draws — a capability absent from the module graph is structurally
 * unavailable — and it is intact.
 *
 * No `ConfigModule` either. `TIMEOUT_WINDOW_MS` is a constant in code, and
 * ADR-0014 disqualifies configurable timeouts: "a safety default that can be
 * set per class is a policy, not a guarantee." A `ConfigModule` in this list
 * would be the first visible step toward one.
 *
 * The controller (#98) owns the HTTP surface, including the `approvals:read` /
 * `approvals:decide` split and the extra `trust:grant` check that "Always
 * approve this class" requires — a composition `ApprovalGateService` cannot
 * make, because it has no view of the caller's permissions and should not
 * acquire one.
 */
@Module({
  imports: [
    PrismaModule,
    AutonomyModule,
    TrustModule,
    EscalationsModule,
    NotificationsModule,
  ],
  controllers: [ApprovalsController],
  providers: [ApprovalGateService, ApprovalGateTask],
  exports: [ApprovalGateService],
})
export class ApprovalsModule {}
