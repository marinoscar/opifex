import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { HardSpendCeilingService } from './hard-spend-ceiling';
import { SpendLedgerService } from './spend-ledger.service';

/**
 * The spend ceiling and the ledger it is checked against (#65).
 *
 * Its own module rather than a corner of `DispatchModule`, for the reason
 * `DispatchModule`'s own comment gives about deciding and acting: the thing
 * that says how much may be spent should not live inside the thing that
 * spends. Dispatch imports this; nothing here imports dispatch.
 */
@Module({
  imports: [PrismaModule],
  providers: [HardSpendCeilingService, SpendLedgerService],
  exports: [HardSpendCeilingService, SpendLedgerService],
})
export class BudgetModule {}
