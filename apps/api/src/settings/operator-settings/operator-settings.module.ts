import { Global, Module } from '@nestjs/common';

import { ClaudeAuthController } from './claude-auth/claude-auth.controller';
import { ClaudeAuthService } from './claude-auth/claude-auth.service';
import { OperatorSettingsController } from './operator-settings.controller';
import { OperatorSettingsRefreshTask } from './operator-settings-refresh.task';
import { OperatorSettingsEnvDisagreementService } from './operator-settings.env-disagreement';
import { OperatorSettingsService } from './operator-settings.service';
import { OperatorProbesService } from './probes/operator-probes.service';

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
 * ## Why the controller lives here and not in `SettingsModule`
 *
 * `SettingsModule` holds the two JSONB-document settings services, which share
 * a shape with each other and nothing with this one. The Control Center's
 * endpoints are a thin surface over `OperatorSettingsService`'s own
 * `resolve`/`set`/`clear`/`overlay`, and every one of them would have to
 * import this module to reach it — so they sit beside it.
 *
 * `OperatorProbesService` is deliberately NOT exported. It spends real money
 * and acts outwardly; the only thing that should be able to reach it is the
 * endpoint an operator presses (#338).
 */
@Global()
@Module({
  controllers: [OperatorSettingsController, ClaudeAuthController],
  providers: [
    OperatorSettingsService,
    OperatorSettingsRefreshTask,
    OperatorProbesService,
    // Not exported either, and for a stronger version of the same reason: it
    // spawns a process that mints a credential. The only thing that should be
    // able to reach it is the endpoint an operator clicks (#386).
    ClaudeAuthService,
    // Not exported and injected by nothing: its whole job happens in its
    // constructor, and Nest instantiates it because it is a provider of a
    // module that is loaded. `RetiredSupervisorConfigService` is registered
    // the same way, for the same reason.
    OperatorSettingsEnvDisagreementService,
  ],
  exports: [OperatorSettingsService],
})
export class OperatorSettingsModule {}
