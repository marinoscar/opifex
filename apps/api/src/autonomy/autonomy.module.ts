import { Module } from '@nestjs/common';

import { BudgetModule } from '../budget/budget.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NeverTrustableService } from './never-trustable.service';

/**
 * The never-trustable boundary (#95, ADR-0013).
 *
 * Imports `PrismaModule` for the audit row and `BudgetModule` for the one
 * value the guard needs from outside itself — #65's hard spend ceiling, which
 * `BudgetModule` already exports. Since #345 that ceiling resolves through
 * `OperatorSettingsService` and can be moved by an admin at runtime; what has
 * not changed is that the value arrives here as a VALUE, from one place, and
 * that nothing in this module can move it.
 *
 * Nothing else, for the same reason `SupervisorModule` keeps a short import
 * list: this module decides one question and records the answer, and anything
 * further in here would be a capability it has no use for. In particular a
 * `ConfigModule` appearing in this list would still be wrong — not because a
 * ceiling may never be configured, which ADR-0018 §6 settled, but because
 * `ConfigService.set()` writes into `process.env` and is reachable by any
 * holder of the injected instance with nothing recording that it happened.
 * The settings path this ceiling now uses is neither of those things.
 */
@Module({
  imports: [PrismaModule, BudgetModule],
  providers: [NeverTrustableService],
  exports: [NeverTrustableService],
})
export class AutonomyModule {}
