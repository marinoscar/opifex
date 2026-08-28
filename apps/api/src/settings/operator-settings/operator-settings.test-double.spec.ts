import { Logger } from '@nestjs/common';

import { OPERATOR_SETTING_KEYS } from './operator-settings.registry';
import { OperatorSettingsService } from './operator-settings.service';
import { makeOperatorSettings } from './operator-settings.test-double';

describe('makeOperatorSettings', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is an OperatorSettingsService, so it can be substituted for one', () => {
    // `overrideProvider(OperatorSettingsService).useValue(...)` has to be given
    // something that really is one, or a consumer calling a method the double
    // forgot fails at runtime in a spec that looked wired correctly.
    expect(makeOperatorSettings()).toBeInstanceOf(OperatorSettingsService);
  });

  it('resolves every key to its registry default when nothing is overridden', () => {
    const settings = makeOperatorSettings();

    for (const key of OPERATOR_SETTING_KEYS) {
      expect(settings.resolve(key).source).toBe('default');
    }
    // Which since ADR-0019 (#439) is ON for the four switches that make the
    // factory work — so the reason a migrating spec must state what it needs
    // has INVERTED: a spec proving that nothing happens is now the one that
    // has to say so, and a spec that says nothing is exercising a live
    // control plane.
    expect(settings.get('dispatch.enabled')).toBe(true);
    expect(settings.get('github.writesEnabled')).toBe(true);
    expect(settings.get('runners.claudeCodeLocal.enabled')).toBe(true);
    expect(settings.get('dispatch.allowPreviewRunner')).toBe(true);
    // And the one that is still, deliberately, not set: an unset ceiling
    // refuses every dispatch, which is what keeps a default-on install ready
    // rather than running. `test/governing/fresh-install-cannot-spend.spec.ts`
    // is where that is pinned end to end.
    expect(settings.get('dispatch.hardSpendCeilingUsd')).toBe('');
  });

  it('returns the overrides a spec asked for', () => {
    const settings = makeOperatorSettings({
      overrides: {
        'dispatch.enabled': true,
        'dispatch.maxConcurrent': 2,
        'runners.claudeCodeLocal.permissionMode': 'bypassPermissions',
      },
    });

    expect(settings.get('dispatch.enabled')).toBe(true);
    expect(settings.get('dispatch.maxConcurrent')).toBe(2);
    expect(settings.get('runners.claudeCodeLocal.permissionMode')).toBe(
      'bypassPermissions',
    );
  });

  it('ignores the host environment by default', () => {
    // A spec that resolved the developer's shell would pass or fail depending
    // on who ran it, and CI disagreeing with a laptop about RECONCILER_ENABLED
    // is not a thing anyone should have to debug.
    // Set to the OPPOSITE of the registry default (on since ADR-0019), so a
    // double that leaked the host environment in would be caught. Asserting
    // the default against a host value that agrees with it would prove
    // nothing.
    const previous = process.env.DISPATCH_ENABLED;
    process.env.DISPATCH_ENABLED = 'false';
    try {
      expect(makeOperatorSettings().get('dispatch.enabled')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DISPATCH_ENABLED;
      else process.env.DISPATCH_ENABLED = previous;
    }
  });

  it('reads an environment layer when a spec supplies one deliberately', () => {
    const settings = makeOperatorSettings({
      env: { RECONCILER_INTERVAL_MS: '5000' },
    });

    expect(settings.get('reconciler.intervalMs')).toBe(5_000);
    expect(settings.resolve('reconciler.intervalMs').source).toBe('env');
  });

  it('puts an override above the environment', () => {
    const settings = makeOperatorSettings({
      overrides: { 'reconciler.enabled': true },
      env: { RECONCILER_ENABLED: 'false' },
    });

    expect(settings.get('reconciler.enabled')).toBe(true);
    expect(settings.resolve('reconciler.enabled').source).toBe('database');
  });

  it('parses overrides through the registry rather than assigning them', () => {
    // A double that bypassed the registry would let a spec set a value the
    // real service could never produce, and the code under test would then be
    // proven correct against an input that cannot occur.
    const settings = makeOperatorSettings({
      overrides: { 'dispatch.enabled': 'true' as unknown as boolean },
    });

    expect(settings.get('dispatch.enabled')).toBe(true);
    expect(typeof settings.get('dispatch.enabled')).toBe('boolean');
  });

  describe('refuses what the real service tolerates', () => {
    it('throws on an override that does not parse', () => {
      // The opposite of the service's behaviour, for the opposite reason: a
      // deployment must still boot, a spec must not silently assert against a
      // value it never set.
      expect(() =>
        makeOperatorSettings({
          overrides: {
            'runners.claudeCodeLocal.maxConcurrency':
              'two' as unknown as number,
          },
        }),
      ).toThrow(/maxConcurrency/);
    });

    it('throws on an override outside the declared bounds', () => {
      expect(() =>
        makeOperatorSettings({
          overrides: { 'runners.claudeCodeLocal.maxConcurrency': 0 },
        }),
      ).toThrow(/maxConcurrency/);
    });

    it('throws on a key that is not in the registry', () => {
      expect(() =>
        makeOperatorSettings({
          overrides: { 'dispatch.enable': true } as never,
        }),
      ).toThrow(/not a managed setting key/);
    });

    it('still tolerates a bad ENVIRONMENT value, because production must', () => {
      const settings = makeOperatorSettings({
        env: { CLAUDE_CODE_MAX_CONCURRENCY: 'lots' },
      });

      expect(settings.get('runners.claudeCodeLocal.maxConcurrency')).toBe(2);
    });
  });

  describe('changing a setting at runtime', () => {
    it('starts with no recorded changes', () => {
      // A spec's starting configuration is not a change; if it were, every
      // assertion about what a write announced would have to subtract the
      // setup first.
      expect(
        makeOperatorSettings({ overrides: { 'dispatch.enabled': true } })
          .changes,
      ).toEqual([]);
    });

    it('announces a later flip to subscribers and records it', () => {
      // What #352 needs to drive "the operator flips a switch while the system
      // is running", which is the scenario the three reload semantics exist to
      // describe.
      const settings = makeOperatorSettings();
      const seen: string[][] = [];
      settings.onChange((change) => seen.push([...change.keys]));

      settings.setOverride('dispatch.enabled', true);

      expect(settings.get('dispatch.enabled')).toBe(true);
      expect(seen).toEqual([['dispatch.enabled']]);
      expect(settings.changes).toHaveLength(1);
    });

    it('falls back to the layer below when an override is cleared', () => {
      const settings = makeOperatorSettings({
        overrides: { 'reconciler.enabled': true },
        env: { RECONCILER_ENABLED: 'false' },
      });

      settings.clearOverride('reconciler.enabled');

      expect(settings.get('reconciler.enabled')).toBe(false);
      expect(settings.resolve('reconciler.enabled').source).toBe('env');
      expect(settings.changes.at(-1)?.keys).toEqual(['reconciler.enabled']);
    });
  });

  describe('the write surface it stands in for (#339)', () => {
    it('applies and announces a `set`, so a controller spec needs no database', async () => {
      const settings = makeOperatorSettings();
      const seen: string[][] = [];
      settings.onChange((change) => seen.push([...change.keys]));

      const result = await settings.set('dispatch.maxConcurrent', 4, 'user-1');

      expect(settings.get('dispatch.maxConcurrent')).toBe(4);
      expect(result).toMatchObject({
        key: 'dispatch.maxConcurrent',
        changed: true,
        revision: 1,
      });
      expect(result.resolved.value).toBe(4);
      expect(seen).toEqual([['dispatch.maxConcurrent']]);
    });

    it('parses a `set` through the registry, so the env form and the JSON form agree', async () => {
      const settings = makeOperatorSettings();

      await settings.set('dispatch.enabled', 'true', null);

      expect(settings.get('dispatch.enabled')).toBe(true);
    });

    it('reverts to the layer below on `clear`, and reports doing nothing twice', async () => {
      const settings = makeOperatorSettings({
        env: { RECONCILER_ENABLED: 'true' },
      });
      await settings.set('reconciler.enabled', false, null);

      const first = await settings.clear('reconciler.enabled', null);
      const second = await settings.clear('reconciler.enabled', null);

      expect(settings.get('reconciler.enabled')).toBe(true);
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
    });

    it('reports the overlay as loaded, because the overrides ARE in force', () => {
      // Reporting `unavailable` would make every spec of a consumer that
      // renders the status assert against a degraded state it never asked for.
      expect(makeOperatorSettings().overlay()).toMatchObject({
        status: 'loaded',
      });
    });
  });
});
