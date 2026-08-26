import { Logger } from '@nestjs/common';

import {
  OperatorSettingsEnvDisagreementService,
  operatorEnvDisagreements,
} from './operator-settings.env-disagreement';
import { OperatorSettingsService } from './operator-settings.service';
import { makeOperatorSettings } from './operator-settings.test-double';

/**
 * The boot warning for a managed variable that no longer decides anything
 * (#340, epic #332).
 *
 * The requirement is narrow, and the narrowness is the point: an operator
 * whose `.env` disagrees with the value in force must be TOLD, and an operator
 * whose `.env` merely still contains the same value must be told NOTHING. A
 * warning per exported managed variable would print a dozen unactionable lines
 * on a normal boot, which is how the one line that matters gets skimmed along
 * with them.
 */
describe('operator settings env disagreement (#340)', () => {
  describe('which environments earn a warning', () => {
    it('warns when the environment and the value in force differ', () => {
      const env = { DISPATCH_ENABLED: 'true' };
      // An override stands in for #339's database row, which is the layer that
      // will really overrule the environment.
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.enabled': false },
        env,
      });

      const warnings = operatorEnvDisagreements(env, settings);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('DISPATCH_ENABLED');
      expect(warnings[0]).toContain('dispatch.enabled');
    });

    it('says NOTHING when the environment agrees with the value in force', () => {
      // The whole discipline of this file. `.env` exporting the same value the
      // database holds is the normal state of a deployment mid-migration, and
      // it is not a problem worth a line.
      const env = { DISPATCH_ENABLED: 'true' };
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.enabled': true },
        env,
      });

      expect(operatorEnvDisagreements(env, settings)).toEqual([]);
    });

    it('says nothing when the environment is the value in force', () => {
      // With no database layer at all — which is every deployment until #339 —
      // the environment always wins, so it can never be overruled and there is
      // never anything to report.
      const env = { DISPATCH_ENABLED: 'true', RECONCILER_INTERVAL_MS: '30000' };

      expect(
        operatorEnvDisagreements(env, makeOperatorSettings({ env })),
      ).toEqual([]);
    });

    it('says nothing about a variable that is not set', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.enabled': true },
      });

      expect(operatorEnvDisagreements({}, settings)).toEqual([]);
    });

    it('treats an exported-but-empty variable as unset', () => {
      // `FOO=` in a `.env` file means "unset" and the resolver reads it that
      // way. A variable supplying nothing cannot disagree with anything.
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.enabled': true },
      });

      expect(
        operatorEnvDisagreements({ DISPATCH_ENABLED: '' }, settings),
      ).toEqual([]);
      expect(
        operatorEnvDisagreements({ DISPATCH_ENABLED: '   ' }, settings),
      ).toEqual([]);
    });

    it('leaves an unparseable variable to the resolver, which already reports it', () => {
      // `OperatorSettingsService.onInvalid` names the variable and says the
      // default is in use instead. A second message here, in different words,
      // would be two reports of one mistake.
      const env = { RECONCILER_INTERVAL_MS: 'quite often' };
      const settings = makeOperatorSettings({
        overrides: { 'reconciler.intervalMs': 30_000 },
        env,
      });

      expect(operatorEnvDisagreements(env, settings)).toEqual([]);
    });

    it('compares the PARSED value, so `true` and true do not look different', () => {
      // The env form is a string and the database form is JSON. Comparing them
      // raw would report every boolean and every number in the environment as
      // a disagreement, which is the noisy failure this file is built around.
      const env = { RECONCILER_INTERVAL_MS: '30000' };
      const settings = makeOperatorSettings({
        overrides: { 'reconciler.intervalMs': 30_000 },
        env,
      });

      expect(operatorEnvDisagreements(env, settings)).toEqual([]);
    });

    it('reports each disagreeing variable separately', () => {
      const env = { DISPATCH_ENABLED: 'true', SUPERVISOR_ENABLED: 'true' };
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.enabled': false, 'supervisor.enabled': false },
        env,
      });

      expect(operatorEnvDisagreements(env, settings)).toHaveLength(2);
    });
  });

  describe('what the warning says', () => {
    const env = { RECONCILER_INTERVAL_MS: '30000' };
    const [warning] = operatorEnvDisagreements(
      env,
      makeOperatorSettings({
        overrides: { 'reconciler.intervalMs': 120_000 },
        env,
      }),
    );

    it('names the variable, the key, and both values', () => {
      // An operator greps for the variable name; a developer reads the key.
      // Both values are there because "your file disagrees" without saying
      // what with is a message that sends someone to read the source.
      expect(warning).toContain('RECONCILER_INTERVAL_MS');
      expect(warning).toContain('reconciler.intervalMs');
      expect(warning).toContain('30000');
      expect(warning).toContain('120000');
    });

    it('says which layer overrode it', () => {
      expect(warning).toContain('database');
    });

    it('says what to do about it', () => {
      expect(warning).toContain('Control Center');
      expect(warning).toMatch(/remove RECONCILER_INTERVAL_MS/);
    });
  });

  describe('secrets', () => {
    it('reports the disagreement without printing either value', () => {
      // Two credentials in a log line, to report one stale `.env` entry, would
      // be a worse outcome than the confusion being reported.
      const env = { GITHUB_TOKEN: 'ghp_from_the_env_file' };
      const settings = makeOperatorSettings({
        overrides: { 'github.token': 'ghp_from_the_database' },
        env,
      });

      const [line] = operatorEnvDisagreements(env, settings);

      expect(line).toContain('GITHUB_TOKEN');
      expect(line).toContain('<redacted>');
      expect(line).not.toContain('ghp_from_the_env_file');
      expect(line).not.toContain('ghp_from_the_database');
    });
  });

  describe('the boot-time service', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('logs nothing when the process environment agrees with everything', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      // The real service reads `process.env`, and the real resolver has no
      // layer above it, so a boot with no database overlay is silent whatever
      // the host happens to export.
      new OperatorSettingsEnvDisagreementService(new OperatorSettingsService());

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
