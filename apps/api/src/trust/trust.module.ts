import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RenewalPromptTask } from './tasks/renewal-prompt.task';
import { TrustController } from './trust.controller';
import { TrustGrantService } from './trust-grant.service';
import { TrustRenewalController } from './trust-renewal.controller';

/**
 * Trust grants (VISION §8, epic #22, #96).
 *
 * The authority to grant trust and the ability to act on it are kept in
 * different modules for exactly that reason.
 *
 * ## What it imports, and why the rule still holds
 *
 * `NotificationsModule` joined `PrismaModule` for #115's renewal prompt. It is
 * not an executor and cannot become one: it owns two transports and a
 * subscription table, and the edge runs one way — the prompt task reaches into
 * it to send, and nothing under `src/notifications/` knows what a trust grant
 * is beyond a structural payload input. The rule this module is built on is
 * unchanged: no dispatcher, no runner registry, no GitHub write module. The
 * authority to grant trust still cannot reach the ability to act on it.
 *
 * ## Two controllers, for now
 *
 * `TrustController` (#101) is the general surface, and it changes none of the
 * above: a controller can only call the service that is already here, so the
 * module still holds no capability to act on a grant it issues. What it adds
 * is the boundary where VISION §8's four attributes are attached from
 * `defaults.ts` and CANNOT be supplied by the caller — see its class doc.
 *
 * `TrustRenewalController` carries exactly one endpoint (#115). It was kept
 * separate deliberately while #101 was being built in parallel, so the two
 * collided on one line of this array rather than across a whole file. Now that
 * both have landed, folding its single route into `TrustController` is a
 * tidy-up worth doing — nothing depends on the split.
 *
 * The service is exported, so #97's approval gate and #99's ladder can reach
 * it.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [TrustController, TrustRenewalController],
  providers: [TrustGrantService, RenewalPromptTask],
  exports: [TrustGrantService],
})
export class TrustModule {}
