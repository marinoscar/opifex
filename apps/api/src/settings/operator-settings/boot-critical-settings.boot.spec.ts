import { Logger } from '@nestjs/common';

import { makeOperatorSettings } from '../../../test/fixtures/operator-settings.fixture';
import {
  BootCriticalSettingsCheck,
  bootCriticalRejections,
} from './boot-critical-settings.boot';
import {
  BOOT_CRITICAL_SETTING_KEYS,
  OPERATOR_SETTINGS,
} from './operator-settings.registry';

/**
 * #441's third hazard: a rejected `github.apiBaseUrl` used to fall back to
 * `https://api.github.com` — public GitHub — for a deployment whose operator
 * had just named their own Enterprise host and whose token is about to be
 * sent there.
 *
 * Both directions are asserted throughout. A check that refuses every boot
 * would pass the "it refuses" half on its own, and would be worthless; so
 * every refusal case here has a control alongside it in which the same check
 * returns nothing and the boot proceeds.
 */
describe('the boot-critical settings check (#441)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses the boot when GITHUB_API_BASE_URL cannot be read', async () => {
    // No scheme. This is the issue's own example, and it is what a GitHub
    // Enterprise operator plausibly types.
    const { settings } = await makeOperatorSettings({
      env: { GITHUB_API_BASE_URL: 'github.corp.example' },
    });

    expect(() =>
      new BootCriticalSettingsCheck(settings).onApplicationBootstrap(),
    ).toThrow(/GITHUB_API_BASE_URL/);
  });

  it('starts normally when the value is a legal URL', async () => {
    // The control. Without this, the test above is satisfied by a check that
    // refuses every boot.
    const { settings } = await makeOperatorSettings({
      env: { GITHUB_API_BASE_URL: 'https://github.corp.example/api/v3' },
    });

    expect(() =>
      new BootCriticalSettingsCheck(settings).onApplicationBootstrap(),
    ).not.toThrow();
    expect(settings.get('github.apiBaseUrl')).toBe(
      'https://github.corp.example/api/v3',
    );
  });

  it('starts normally when nothing is supplied at all', async () => {
    // Absent is not rejected. Absence is a state the operator chose, and the
    // declared default is the right answer for it — the hazard is a SUPPLIED
    // value being discarded, not an unset one.
    const { settings } = await makeOperatorSettings({ env: {} });

    expect(() =>
      new BootCriticalSettingsCheck(settings).onApplicationBootstrap(),
    ).not.toThrow();
  });

  it('refuses a stored Control Center row, not just an environment variable', async () => {
    // The reason this reads through `resolve()` rather than `process.env`.
    // Since #349 either layer can be the supplied value, and a check that
    // only read the environment would pass the deployment whose DATABASE row
    // is the broken one — which is the harder case to diagnose by hand.
    const { settings, prisma } = await makeOperatorSettings({ env: {} });
    prisma.put('github.apiBaseUrl', 'github.corp.example');
    await settings.refresh();

    const rejections = bootCriticalRejections(settings);

    expect(rejections).toHaveLength(1);
    expect(rejections[0].key).toBe('github.apiBaseUrl');
    expect(rejections[0].message).toContain('stored Control Center value');
  });

  it('never puts the rejected value in the message', async () => {
    // The key is not marked `secret`, but the whole reason it refuses the
    // boot is that it decides where a credential is sent — and a startup
    // banner is the most widely pasted text a deployment produces. The
    // operator is looking at the variable they just set; they do not need it
    // quoted back.
    const { settings } = await makeOperatorSettings({
      env: { GITHUB_API_BASE_URL: 'github.corp.example' },
    });

    const [rejection] = bootCriticalRejections(settings);

    expect(rejection.message).not.toContain('github.corp.example');
    expect(rejection.message).toContain('GITHUB_API_BASE_URL');
  });

  it('says the default is a different host, because that is the danger', async () => {
    const { settings } = await makeOperatorSettings({
      env: { GITHUB_API_BASE_URL: 'github.corp.example' },
    });

    const [rejection] = bootCriticalRejections(settings);

    expect(rejection.message).toContain('https://api.github.com');
    expect(rejection.message).toMatch(/no safe value to fall back to/);
  });

  it('is driven off the registry rather than a hardcoded list', () => {
    // So a key marked `bootCritical` tomorrow is covered without anyone
    // remembering this file exists.
    expect(BOOT_CRITICAL_SETTING_KEYS).toEqual(['github.apiBaseUrl']);
    expect(OPERATOR_SETTINGS['github.apiBaseUrl'].bootCritical).toBe(true);
  });

  it('names every offending key at once', async () => {
    // `validateEnv`'s property, for `validateEnv`'s reason: an operator
    // fixing a boot failure should learn everything that is wrong in one
    // restart. Only one key is boot-critical today, so this drives the
    // formatter with a second key explicitly rather than pretending there is
    // one — the assertion is about the MESSAGE shape, which is what would
    // silently regress to "first failure only".
    const { settings } = await makeOperatorSettings({
      env: {
        GITHUB_API_BASE_URL: 'github.corp.example',
        DISPATCH_MAX_CONCURRENT: 'not-a-number',
      },
    });

    const rejections = bootCriticalRejections(settings, [
      'github.apiBaseUrl',
      'dispatch.maxConcurrent',
    ]);

    expect(rejections.map((r) => r.key)).toEqual([
      'github.apiBaseUrl',
      'dispatch.maxConcurrent',
    ]);
  });
});
