import { Global, Module } from '@nestjs/common';

import { ClaudeAuthController } from './claude-auth/claude-auth.controller';
import { ClaudeAuthService } from './claude-auth/claude-auth.service';
import { OperatorSettingsController } from './operator-settings.controller';
import { OperatorSettingsRefreshTask } from './operator-settings-refresh.task';
import { LegacyModelSettingsMigration } from './legacy-model-settings.migration';
import { OperatorSettingsEnvDisagreementService } from './operator-settings.env-disagreement';
import { OperatorSettingsService } from './operator-settings.service';
import { UnreadableSecretsBootCheck } from './unreadable-secrets.boot';
import { BootCriticalSettingsCheck } from './boot-critical-settings.boot';
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
    // Not exported and injected by nothing: its whole job happens in its
    // constructor, and Nest instantiates it because it is a provider of a
    // module that is loaded. `RetiredSupervisorConfigService` is registered
    // the same way, for the same reason.
    OperatorSettingsEnvDisagreementService,
    // Both injected by nothing, like the disagreement reporter above: their
    // whole job happens once, at startup (#422). Both hang off
    // `onApplicationBootstrap` and NOT `onModuleInit`, because both read the
    // overlay that this module's own service loads in ITS `onModuleInit` — and
    // Nest starts every provider hook in a module together and awaits them
    // with `Promise.all`, so a sibling's `onModuleInit` sees an overlay that
    // has not loaded yet. Registration order does not fix that; only a later
    // hook does. That mistake is #436, and it silently stranded a credential.
    //
    // Their order relative to EACH OTHER is not guaranteed either, and does
    // not need to be: the boot check reports stored rows that will not open,
    // and a row the migration writes was sealed moments earlier by the same
    // process, so it can never be one of them.
    LegacyModelSettingsMigration,
    UnreadableSecretsBootCheck,
    // Injected by nothing and exported to nobody, like the two above, and on
    // `onApplicationBootstrap` for the same reason: it reads the overlay this
    // module's own service loads in ITS `onModuleInit` (#436).
    //
    // Unlike the two above, this one can THROW, and a throw here refuses the
    // boot. That is deliberate and is the whole of #441's third hazard: a
    // rejected `github.apiBaseUrl` has no safe value to fall back to, because
    // the fallback names a host a credential is sent to. Its order relative to
    // the others does not matter — a boot that is going to be refused should
    // still print everything the other two found, and Nest has already
    // started all three by the time this one throws.
    BootCriticalSettingsCheck,
  ],
  exports: [OperatorSettingsService],
})
export class OperatorSettingsModule {}
