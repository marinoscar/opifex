import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { TrustModule } from '../trust/trust.module';
import { PromotionController } from './promotion.controller';
import { PromotionService } from './promotion.service';
import { PromotionTask } from './promotion.task';

/**
 * The promotion ladder (#99, epic #22, VISION §7 "Earned autonomy").
 *
 * Five imports, and each one is either a source of evidence or a thing the
 * ladder narrows:
 *
 * - `SupervisorModule` — `DecisionLogService.approvalRates()`, the #90
 *   review-queue evidence produced during the observation phase.
 * - `ApprovalsModule` — `ApprovalGateService.approvalRatesByClass()`, the #97
 *   live-gate evidence, with timeouts and grant-authorized actions already
 *   excluded. Consumed rather than re-derived; see `ClassEvidence`.
 * - `TrustModule` — to SUSPEND grants on demotion. Not to create them.
 * - `NotificationsModule` — the two transports, reused directly the way the
 *   daily brief (#93) does, without minting an escalation to ride.
 * - `PrismaModule` — the `PromotionState` row.
 *
 * ## What is deliberately absent
 *
 * No dispatcher, no runner registry, no GitHub write module. This module
 * decides whether a class MAY eventually run unattended; it must not be able
 * to run anything. `TrustModule`, `ApprovalsModule` and `SupervisorModule` all
 * make this argument about themselves, and #90 states the rule: a capability
 * absent from the module graph is structurally unavailable, while a capability
 * that is merely unused is one convenient afternoon from being used.
 *
 * It matters more here than in any of the three, because this is the module
 * that decides who gets to act without being asked. VISION §8: "An agent that
 * can edit the check enforcing its own trailers, or grant itself trust, has
 * the appearance of guardrails and none of the substance." The import list is
 * load-bearing, and a future PR adding a write module to it is the failure
 * this shape exists to make visible in review.
 *
 * `PromotionController` (#101) is the HTTP surface: the "what would be needed
 * to promote" view that `holdDetail` feeds, and a manual DEMOTION. It adds no
 * capability — it reads this service and, in one direction only, narrows. In
 * particular there is no promote endpoint, so nothing reachable over HTTP can
 * put a class on the promoted rung; only accumulated evidence can. That keeps
 * the absent-capability argument above intact at the edge as well as in the
 * import list.
 */
@Module({
  imports: [
    PrismaModule,
    ApprovalsModule,
    SupervisorModule,
    TrustModule,
    NotificationsModule,
  ],
  controllers: [PromotionController],
  providers: [PromotionService, PromotionTask],
  exports: [PromotionService],
})
export class PromotionModule {}
