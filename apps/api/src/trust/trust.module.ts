import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TrustGrantService } from './trust-grant.service';

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
 * No controller yet — #101 and #98 own the HTTP surface. The service is
 * exported so they, and #115's renewal prompt, can reach it.
 */
@Module({
  imports: [PrismaModule],
  providers: [TrustGrantService],
  exports: [TrustGrantService],
})
export class TrustModule {}
