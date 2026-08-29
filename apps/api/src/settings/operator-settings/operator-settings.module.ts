import { Global, Module } from '@nestjs/common';

import { ClaudeAuthController } from './claude-auth/claude-auth.controller';
import { ClaudeAuthService } from './claude-auth/claude-auth.service';
import { OperatorSettingsController } from './operator-settings.controller';
import { OperatorSettingsRefreshTask } from './operator-settings-refresh.task';
import { LegacyModelSettingsMigration } from './legacy-model-settings.migration';
import { OperatorSettingsEnvDisagreementService } from './operator-settings.env-disagreement';
import { OperatorSettingsService } from './operator-settings.service';
import { UnreadableSecretsBootCheck } from './unreadable-secrets.boot';
import { SupervisorModelCatalogService } from '../../supervisor/invocation/model-catalog.service';
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
    // Lives under `supervisor/invocation/` because listing models is
    // irreducibly vendor-shaped and that is the only directory allowed to know
    // which vendors exist (#392). It is PROVIDED here, and not exported,
    // because the only thing that should reach it is the Control Center
    // endpoint an operator opens — the same reasoning as the probes above,
    // one notch weaker: this one spends nothing, but it still puts a
    // credential on the wire.
    SupervisorModelCatalogService,
    // Not exported either, and for a stronger version of the same reason: it
    // spawns a process that mints a credential. The only thing that should be
    // able to reach it is the endpoint an operator clicks (#386).
    ClaudeAuthService,
    // All three are injected by nothing and exported to nobody: their whole
    // job happens once, at startup, and Nest runs them because they are
    // providers of a module that is loaded (#340, #422).
    //
    // All three hang off `onApplicationBootstrap`, and NOT off `onModuleInit`
    // or a constructor, because all three read the overlay that this module's
    // own service loads in ITS `onModuleInit`. Nest starts every provider hook
    // within a module together and awaits them with `Promise.all`, so a
    // sibling's `onModuleInit` sees an overlay that has not loaded yet — and a
    // constructor runs earlier still, before any hook at all, so it can never
    // see one. Registration order does not fix either; only a later hook does.
    // That mistake silently stranded a credential (#436) and silenced the
    // env-disagreement warning for its whole life (#437).
    // `operator-settings.boot-order.spec.ts` now asserts this over the source.
    //
    // Their order relative to EACH OTHER is not guaranteed, and does not need
    // to be: the boot check reports stored rows that will not open, and a row
    // the migration writes was sealed moments earlier by the same process, so
    // it can never be one of them.
    OperatorSettingsEnvDisagreementService,
    LegacyModelSettingsMigration,
    UnreadableSecretsBootCheck,
  ],
  exports: [OperatorSettingsService],
})
export class OperatorSettingsModule {}
