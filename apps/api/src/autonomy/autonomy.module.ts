import { Module } from '@nestjs/common';

import { BudgetModule } from '../budget/budget.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NeverTrustableService } from './never-trustable.service';

/**
 * The never-trustable boundary (#95, ADR-0013).
 *
 * Imports `PrismaModule` for the audit row and `BudgetModule` for the one
 * value the guard needs from outside itself — #65's hard spend ceiling, which
 * `BudgetModule` already exports and which is read from the environment once
 * at boot into fields with no setter.
 *
 * Nothing else, for the same reason `SupervisorModule` keeps a short import
 * list: this module decides one question and records the answer, and anything
 * further in here would be a capability it has no use for. In particular a
 * `ConfigModule` appearing in this list would be the first visible step toward
 * a configurable ceiling, which VISION §8 does not permit — `ConfigService`
 * has a public `set()`, which is exactly why #65 avoided it.
 */
@Module({
  imports: [PrismaModule, BudgetModule],
  providers: [NeverTrustableService],
  exports: [NeverTrustableService],
})
export class AutonomyModule {}
