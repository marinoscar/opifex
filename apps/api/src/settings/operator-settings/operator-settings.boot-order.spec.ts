import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LegacyModelSettingsMigration } from './legacy-model-settings.migration';
import { OperatorSettingsEnvDisagreementService } from './operator-settings.env-disagreement';
import { UnreadableSecretsBootCheck } from './unreadable-secrets.boot';

/**
 * When a provider in this module may read the settings overlay (#437, #436).
 *
 * ## The rule, and the two ways to get it wrong
 *
 * `OperatorSettingsService` loads the database overlay in its own
 * `onModuleInit`. Anything else here that wants to SEE that overlay must wait
 * for `onApplicationBootstrap`:
 *
 *  - A CONSTRUCTOR always loses. Nest runs every constructor while resolving
 *    the dependency graph, strictly before any lifecycle hook. That was
 *    `OperatorSettingsEnvDisagreementService` (#437) — it always saw an empty
 *    overlay, so its warning had never fired once on a real boot.
 *  - An `onModuleInit` loses too, and DETERMINISTICALLY rather than as a race.
 *    `callModuleInitHook` starts every provider hook within a module in one
 *    pass and awaits them with `Promise.all`, so a sibling reads
 *    `status: 'unavailable'` before its own first `await`. That was
 *    `LegacyModelSettingsMigration` and `UnreadableSecretsBootCheck` (#436),
 *    and it silently stranded a credential.
 *
 * Both failures are SILENT. Nothing throws; a line simply never appears.
 *
 * ## What this file is FOR, given the behaviour is tested elsewhere
 *
 * `operator-settings.env-disagreement.spec.ts` already drives the #437
 * scenario through a real Nest container, which is the right way to prove the
 * fix works. It proves it for ONE provider. This file is the structural half:
 * it fails when a FOURTH provider repeats the same five-line mistake, which is
 * the thing no behavioural test of the existing three can catch.
 */
describe('when a provider may read the settings overlay (#437, #436)', () => {
  it('puts all three overlay readers on onApplicationBootstrap, and none on onModuleInit', () => {
    // `onModuleInit` is the subtler of the two mistakes and the likelier to be
    // reintroduced, because it LOOKS like the careful choice.
    for (const Provider of [
      OperatorSettingsEnvDisagreementService,
      LegacyModelSettingsMigration,
      UnreadableSecretsBootCheck,
    ]) {
      expect(typeof Provider.prototype.onApplicationBootstrap).toBe('function');
      expect(
        (Provider.prototype as unknown as Record<string, unknown>).onModuleInit,
      ).toBeUndefined();
    }
  });

  it('fails on a NEW provider here that would read the overlay any earlier', () => {
    // The half that outlives whoever read the comment above. Any class in this
    // directory that injects `OperatorSettingsService` must declare
    // `onApplicationBootstrap`, unless it is a listed exemption — and adding
    // to that list is a deliberate, reviewable act rather than an accident.
    const directory = __dirname;

    // Why each is exempt, stated rather than assumed.
    const EXEMPT = new Map<string, string>([
      // Loads the overlay itself; it is what everything else waits for.
      ['operator-settings.service.ts', 'owns the overlay'],
      // A request surface. Every read happens in a handler, long after boot.
      ['operator-settings.controller.ts', 'reads per request'],
      // A scheduled task; its reads happen on a tick, not at boot.
      ['operator-settings-refresh.task.ts', 'reads per tick'],
      // Pure functions that TAKE a service as an argument. Not providers, and
      // they never decide when they are called.
      ['operator-settings.view.ts', 'pure functions, not a provider'],
      ['operator-settings.registry.ts', 'pure functions, not a provider'],
      ['operator-settings.env-disagreement.ts', 'checked above by prototype'],
      ['unreadable-secrets.boot.ts', 'checked above by prototype'],
      ['legacy-model-settings.migration.ts', 'checked above by prototype'],
      ['operator-settings.test-double.ts', 'a test double'],
      ['operator-settings.module.ts', 'the module, not a provider'],
    ]);

    const offenders = readdirSync(directory)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .filter((file) => !EXEMPT.has(file))
      .filter((file) => {
        const source = readFileSync(join(directory, file), 'utf8');
        const injects = /constructor\([^)]*OperatorSettingsService/s.test(
          source,
        );
        return injects && !source.includes('onApplicationBootstrap');
      });

    expect(offenders).toEqual([]);
  });

  it('has an exemption list that still matches the files on disk', () => {
    // An exemption for a file that no longer exists is a rule nobody is
    // reading any more, and would quietly stop covering its replacement.
    const present = new Set(readdirSync(__dirname));
    const stale = [
      'operator-settings.service.ts',
      'operator-settings.controller.ts',
      'operator-settings-refresh.task.ts',
      'operator-settings.view.ts',
      'operator-settings.registry.ts',
      'operator-settings.env-disagreement.ts',
      'unreadable-secrets.boot.ts',
      'legacy-model-settings.migration.ts',
      'operator-settings.test-double.ts',
      'operator-settings.module.ts',
    ].filter((file) => !present.has(file));

    expect(stale).toEqual([]);
  });
});
