import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RenewalPromptTask } from './tasks/renewal-prompt.task';
import { TrustGrantService } from './trust-grant.service';
import { TrustRenewalController } from './trust-renewal.controller';

/**
 * Trust grants (VISION §8, epic #22, #96).
 *
 * ## What this module deliberately does not import
 *
 * `PrismaModule`, and nothing else. No dispatcher, no runner registry, no
 * GitHub write module. This module decides whether something MAY run
 * unattended; it must not be able to run it. `SupervisorModule` makes the same
 * argument about itself and #90 states the rule: a capability that is absent
 * from the module graph is structurally unavailable, while a capability that
 * is merely unused is one convenient afternoon from being used.
 *
 * That matters more here than almost anywhere else in the codebase. VISION §8:
 * "An agent that can edit the check enforcing its own trailers, or grant
 * itself trust, has the appearance of guardrails and none of the substance."
 * The authority to grant trust and the ability to act on it are kept in
 * different modules for exactly that reason.
 *
 * ## What it now imports, and why that is still true
 *
 * `NotificationsModule` joined `PrismaModule` for #115's renewal prompt. It is
 * not an executor and cannot become one: it owns two transports and a
 * subscription table, and the edge runs one way — the prompt task reaches into
 * it to send, and nothing under `src/notifications/` knows what a trust grant
 * is beyond a structural payload input. The rule this module is built on is
 * unchanged: no dispatcher, no runner registry, no GitHub write module. The
 * authority to grant trust still cannot reach the ability to act on it.
 *
 * ## The controller
 *
 * `TrustRenewalController` carries exactly one endpoint (#115). #101 owns the
 * general trust surface and is being built in parallel; a renewal endpoint
 * added there would collide across a whole file, where this collides on one
 * line of this array. It is expected to fold into #101's controller.
 *
 * The service is also exported, so #98's approval gate and #99's ladder can
 * reach it.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [TrustRenewalController],
  providers: [TrustGrantService, RenewalPromptTask],
  exports: [TrustGrantService],
})
export class TrustModule {}
