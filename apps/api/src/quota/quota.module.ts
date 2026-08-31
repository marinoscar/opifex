import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { QuotaController } from './quota.controller';
import { QuotaHistoryService } from './quota-history.service';
import { QuotaService } from './quota.service';

/**
 * Quota windows: what the vendor said about its own rate limits, and what
 * Opifex put through them (#231).
 *
 * Separate from `RunnersModule`, which owns the adapters that OBSERVE these
 * windows, and separate from `CockpitModule`, which owns the read models that
 * display them. A window is neither: it is a fact about the subscription that
 * outlives every run that saw it and every screen that shows it.
 *
 * Imports nothing but Prisma on purpose. `RunnersModule` imports THIS one, so
 * a dependency in the other direction would close a cycle — and there is
 * nothing here that needs a runner, only what one reported.
 *
 * `QuotaHistoryService` (#476) is the read-only retrospective over the same
 * rows: `run_events` blocks joined to the `quota_windows` they were blocked
 * against. It lives here rather than in `CockpitModule` for the reason above —
 * a window outlives every run that saw it and every screen that shows it — and
 * it is deliberately NOT exported, because nothing in the control plane should
 * make a decision from a history read model. Decisions come from
 * `QuotaService.readings()` and `meterQuotaPosition`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [QuotaController],
  providers: [QuotaService, QuotaHistoryService],
  exports: [QuotaService],
})
export class QuotaModule {}
