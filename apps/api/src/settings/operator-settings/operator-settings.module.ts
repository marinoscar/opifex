import { Global, Module } from '@nestjs/common';

import { OperatorSettingsRefreshTask } from './operator-settings-refresh.task';
import { OperatorSettingsService } from './operator-settings.service';

/**
 * The operator settings read and write path (#335, #339, epic #332).
 *
 * ## Why `@Global`
 *
 * The same reason `GitHubModule` is: nearly every feature module will read
 * from this once #340 migrates the consumers off `ConfigService`. Importing it
 * into twenty modules would add twenty edits to that migration and communicate
 * nothing — the same argument `ConfigModule.forRoot({ isGlobal: true })`
 * already makes in `app.module.ts` for the thing this replaces.
 *
 * ## Why there is still no `imports`
 *
 * `PrismaModule` is itself `@Global` and is registered ahead of this module in
 * `app.module.ts`, so `PrismaService` resolves without an import — and
 * `OperatorSettingsService` takes it `@Optional()`, so a spec that constructs
 * this module in isolation still gets a working env-only resolver rather than
 * an unresolvable dependency.
 *
 * ## What is deliberately not here yet
 *
 * No controller: #338 adds the endpoints on top of the `set`/`clear`/`overlay`
 * surface this issue lands.
 */
@Global()
@Module({
  providers: [OperatorSettingsService, OperatorSettingsRefreshTask],
  exports: [OperatorSettingsService],
})
export class OperatorSettingsModule {}
