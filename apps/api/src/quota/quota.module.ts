import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { QuotaController } from './quota.controller';
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
 */
@Module({
  imports: [PrismaModule],
  controllers: [QuotaController],
  providers: [QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
