import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { FakeOperatorSettingsPrisma } from '../../../test/fixtures/operator-settings.fixture';
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

      // The real service reads `process.env`, and with no database overlay
      // loaded the resolver has no layer above the environment, so this boot is
      // silent whatever the host happens to export.
      new OperatorSettingsEnvDisagreementService(
        new OperatorSettingsService(),
      ).onApplicationBootstrap();

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('at boot, as Nest actually runs it (#437)', () => {
    /**
     * THE regression test, and the reason it goes through a container.
     *
     * Every assertion above calls `operatorEnvDisagreements` directly with an
     * overlay that is already in place — the one arrangement in which this code
     * has always worked. On a real boot it did not, because the whole job ran
     * in the CONSTRUCTOR: constructors run while Nest is still resolving the
     * graph, strictly before `OperatorSettingsService.onModuleInit` loads the
     * overlay, so `resolve()` reported `source: 'env'`, the loop skipped every
     * key, and the warning never fired once in production (#437).
     *
     * So the scenario is the issue's own: `SUPERVISOR_ENABLED=false` in the
     * environment, `supervisor.enabled: true` in `operator_settings`. If the
     * disagreement is computed before the overlay loads there is nothing to
     * disagree WITH, and this fails.
     */
    let warnings: string[];

    /**
     * Every container opened by this block, closed in `afterEach`.
     *
     * NOT closed by each test at its end: an assertion that fails throws
     * before that line, which would leave a live Nest application behind on
     * exactly the run where the suite is red — and the next failure would then
     * be reported as a teardown problem rather than as this one.
     */
    let opened: Array<() => Promise<void>>;

    async function boot(prisma: FakeOperatorSettingsPrisma): Promise<{
      settings: OperatorSettingsService;
      overlayDuringModuleInit: string[];
    }> {
      const overlayDuringModuleInit: string[] = [];
      // The REAL service, not the double: the double's overlay is always
      // 'loaded', which is exactly the state this test exists to deny itself.
      // And the real one reads `process.env`, which is the same environment the
      // reporter compares against.
      const settings = new OperatorSettingsService(prisma.asPrisma());

      const moduleRef = await Test.createTestingModule({
        providers: [
          // Registered in the order `OperatorSettingsModule` registers them, so
          // the ordering this asserts is the deployment's ordering.
          { provide: OperatorSettingsService, useValue: settings },
          {
            // A stand-in for any consumer that reads the overlay in its own
            // `onModuleInit` beside the service — see #436.
            provide: 'OVERLAY_STATUS_PROBE',
            useValue: {
              onModuleInit: (): void => {
                overlayDuringModuleInit.push(settings.overlay().status);
              },
            },
          },
          OperatorSettingsEnvDisagreementService,
        ],
      }).compile();

      await moduleRef.init();
      opened.push(() => moduleRef.close());

      return { settings, overlayDuringModuleInit };
    }

    /** Only the lines about the key under test; the host exports its own. */
    function about(key: string): string[] {
      return warnings.filter((line) => line.includes(key));
    }

    let previousSupervisorEnabled: string | undefined;

    beforeEach(() => {
      opened = [];
      warnings = [];
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
        warnings.push(String(message));
      });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      previousSupervisorEnabled = process.env.SUPERVISOR_ENABLED;
    });

    afterEach(async () => {
      for (const close of opened) await close();
      if (previousSupervisorEnabled === undefined) {
        delete process.env.SUPERVISOR_ENABLED;
      } else {
        process.env.SUPERVISOR_ENABLED = previousSupervisorEnabled;
      }
      jest.restoreAllMocks();
    });

    it('warns about the stale variable through the container, not only when a spec calls it by hand', async () => {
      process.env.SUPERVISOR_ENABLED = 'false';
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.put('supervisor.enabled', true);

      await boot(prisma);

      const [line, ...rest] = about('SUPERVISOR_ENABLED');
      expect(rest).toEqual([]);
      expect(line).toContain('supervisor.enabled');
      expect(line).toContain('database');
      expect(line).toContain('Control Center');
    });

    it('is why the hook moved: the overlay is loaded by the END of the boot and not before', async () => {
      // The diagnosis, pinned. A constructor cannot see 'loaded' under any
      // ordering, and neither can a sibling's `onModuleInit` — which is what
      // makes `onApplicationBootstrap` the earliest hook that can report the
      // truth. If the probe ever starts reporting 'loaded', Nest changed its
      // hook semantics and this file's argument should be re-read.
      process.env.SUPERVISOR_ENABLED = 'false';
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.put('supervisor.enabled', true);

      const booted = await boot(prisma);

      expect(booted.overlayDuringModuleInit).toEqual(['unavailable']);
      expect(booted.settings.overlay().status).toBe('loaded');
    });

    it('still says nothing when the environment agrees with the row', async () => {
      // The discipline of this file, asserted through the boot path too: a boot
      // that warned whenever a managed variable was exported would print a
      // dozen unactionable lines, which is how the one that matters gets
      // skimmed with them.
      process.env.SUPERVISOR_ENABLED = 'true';
      const prisma = new FakeOperatorSettingsPrisma();
      prisma.put('supervisor.enabled', true);

      await boot(prisma);

      expect(about('SUPERVISOR_ENABLED')).toEqual([]);
    });
  });
});
