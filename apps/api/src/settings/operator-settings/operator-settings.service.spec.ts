import { Logger } from '@nestjs/common';

import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
} from './operator-settings.registry';
import {
  OperatorSettingsService,
  type OperatorSettingsChange,
} from './operator-settings.service';

/**
 * The real service with one seam moved: only `environment()` is replaced, so
 * `rawValue`, the parse path, the fallback and the logging under test are the
 * production ones. Replacing `rawValue` instead would test the double.
 */
class EnvFixedOperatorSettingsService extends OperatorSettingsService {
  constructor(private readonly fixture: NodeJS.ProcessEnv) {
    super();
  }

  protected override environment(): NodeJS.ProcessEnv {
    return this.fixture;
  }
}

function withEnv(env: NodeJS.ProcessEnv): OperatorSettingsService {
  return new EnvFixedOperatorSettingsService(env);
}

describe('OperatorSettingsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('resolution: default -> env', () => {
    it('returns the declared default for every key when nothing is set', () => {
      const settings = withEnv({});

      for (const key of OPERATOR_SETTING_KEYS) {
        expect(settings.get(key)).toEqual(OPERATOR_SETTINGS[key].default);
        expect(settings.resolve(key).source).toBe('default');
      }
    });

    it('reads the environment variable the registry names', () => {
      const settings = withEnv({
        DISPATCH_ENABLED: 'true',
        DISPATCH_MAX_CONCURRENT: '4',
        CLAUDE_CODE_PERMISSION_MODE: 'plan',
        GITHUB_TOKEN: 'ghp_example',
      });

      expect(settings.get('dispatch.enabled')).toBe(true);
      expect(settings.get('dispatch.maxConcurrent')).toBe(4);
      expect(settings.get('runners.claudeCodeLocal.permissionMode')).toBe(
        'plan',
      );
      expect(settings.get('github.token')).toBe('ghp_example');
      expect(settings.resolve('dispatch.enabled').source).toBe('env');
    });

    it('reads process.env when nothing replaces the environment layer', () => {
      // The one assertion that the base `environment()` is wired to the real
      // process, which every other test in this file deliberately bypasses.
      const previous = process.env.GITHUB_USER_AGENT;
      process.env.GITHUB_USER_AGENT = 'opifex-under-test';
      try {
        expect(new OperatorSettingsService().get('github.userAgent')).toBe(
          'opifex-under-test',
        );
      } finally {
        if (previous === undefined) delete process.env.GITHUB_USER_AGENT;
        else process.env.GITHUB_USER_AGENT = previous;
      }
    });

    it('treats an empty or whitespace-only variable as unset', () => {
      // `.env` files are full of `FOO=` meaning "not configured". Reading that
      // as a value makes every string setting resolve to '' instead of to its
      // default.
      const settings = withEnv({
        GITHUB_USER_AGENT: '',
        RUNNER_COMMITTER_NAME: '   ',
      });

      expect(settings.get('github.userAgent')).toBe('opifex');
      expect(settings.get('runners.claudeCodeLocal.committerName')).toBe(
        'Opifex Factory',
      );

      // UNSET, not "supplied and rejected". Both give the same value, so
      // asserting the value alone cannot tell them apart — and the difference
      // is a log line accusing the operator of a misconfiguration they did not
      // make, every time the API boots with a commented-out variable.
      const resolved = settings.resolve('github.userAgent');
      expect(resolved.source).toBe('default');
      expect(resolved.invalid).toBeUndefined();
    });

    it('treats an empty variable as unset even where empty is a legal value', () => {
      // `github.token` and the fallback webhook accept '' as "not configured",
      // so for these two an empty variable would otherwise parse SUCCESSFULLY
      // and resolve from the environment layer. It must still read as unset,
      // or the layer below it — the database overlay in #339 — could never be
      // reached by a deployment whose .env still carries `GITHUB_TOKEN=`.
      const settings = withEnv({
        GITHUB_TOKEN: '',
        NOTIFY_FALLBACK_WEBHOOK_URL: '   ',
      });

      expect(settings.resolve('github.token')).toEqual({
        key: 'github.token',
        value: '',
        source: 'default',
      });
      expect(settings.resolve('notifications.fallbackWebhookUrl').source).toBe(
        'default',
      );
    });

    it('trims a value that a .env file left padded', () => {
      expect(
        withEnv({ RECONCILER_INTERVAL_MS: ' 30000 ' }).get(
          'reconciler.intervalMs',
        ),
      ).toBe(30_000);
    });
  });

  describe('parity between the environment string and the JSON form', () => {
    // The service-level half of the registry spec's per-key assertion: what an
    // operator typed into `.env` and what #339 will read out of a JSON column
    // must reach a consumer as the same value, because seven call sites
    // compare `=== true` and one compares `!== 'false'`.
    it.each([
      ['DISPATCH_ENABLED', 'dispatch.enabled', 'true', true],
      ['GITHUB_WRITES_ENABLED', 'github.writesEnabled', 'true', true],
      ['RECONCILER_ENABLED', 'reconciler.enabled', 'false', false],
      [
        'SUPERVISOR_STAND_DOWN_WHEN_BLOCKED',
        'supervisor.standDownWhenBlocked',
        'false',
        false,
      ],
    ] as const)(
      '%s resolves to the boolean %s, not to a string',
      (envVar, key, raw, expected) => {
        const value = withEnv({ [envVar]: raw }).get(key);

        expect(value).toBe(expected);
        expect(typeof value).toBe('boolean');
        // The two comparisons the codebase actually makes, asserted directly:
        // today one of them is wrong for whichever form it did not expect.
        expect(value === true).toBe(expected);
        expect(value !== false).toBe(expected);
      },
    );

    it('lands a misspelt permission mode on the narrowest one, not the default (#441)', () => {
      // The issue's own examples: three spellings of "stricter than the
      // default", none of them legal, all of which used to resolve to
      // `acceptEdits` — a mode that lets the agent edit files.
      for (const typo of ['ask', 'readonly', 'plan-only']) {
        expect(
          withEnv({ CLAUDE_CODE_PERMISSION_MODE: typo }).get(
            'runners.claudeCodeLocal.permissionMode',
          ),
        ).toBe('plan');
      }

      // The control, and it is the assertion that stops this being satisfied
      // by a resolver that always answers 'plan': a LEGAL broad mode is still
      // honoured exactly as written, because #441 is about rejected values
      // and nothing else.
      expect(
        withEnv({ CLAUDE_CODE_PERMISSION_MODE: 'bypassPermissions' }).get(
          'runners.claudeCodeLocal.permissionMode',
        ),
      ).toBe('bypassPermissions');

      // And an ABSENT value still resolves to the declared default. Absence
      // is a state the operator chose; a rejected value is not.
      expect(withEnv({}).get('runners.claudeCodeLocal.permissionMode')).toBe(
        'acceptEdits',
      );
    });

    it('never yields the string "undefined" for a cleared numeric setting', () => {
      // `ConfigService.set(path, undefined)` writes the STRING 'undefined',
      // which survives `?? null` and makes every `liveRuns >= ceiling`
      // comparison false — the fleet ceiling silently disappearing. This
      // service has no such path: absent is absent, and 'null' is null.
      expect(withEnv({}).get('dispatch.maxConcurrent')).toBeNull();
      expect(
        withEnv({ DISPATCH_MAX_CONCURRENT: 'null' }).get(
          'dispatch.maxConcurrent',
        ),
      ).toBeNull();
      // ...and the string 'undefined' is NOT one of them any more (#441).
      // It used to resolve to `null`, which satisfied this test's letter
      // while inverting its point: the hazard named three lines up is "the
      // fleet ceiling silently disappearing", and falling back to `null` IS
      // that disappearance. An unreadable value now lands on the maximum a
      // valid value could have expressed instead.
      expect(
        withEnv({ DISPATCH_MAX_CONCURRENT: 'undefined' }).get(
          'dispatch.maxConcurrent',
        ),
      ).toBe(128);
      // The one word that DOES express it, so "no ceiling" stays something an
      // operator states rather than something a typo lands on.
      expect(
        withEnv({ DISPATCH_MAX_CONCURRENT: 'unlimited' }).get(
          'dispatch.maxConcurrent',
        ),
      ).toBeNull();
    });
  });

  describe('an invalid value', () => {
    it('falls back to the declared default rather than throwing', () => {
      // A misconfigured variable must not take the API down: env.validation.ts
      // reserves boot failure for JWT_SECRET, where continuing would void every
      // authorization decision. Nothing here is in that class.
      const settings = withEnv({
        CLAUDE_CODE_MAX_CONCURRENCY: 'lots',
        // 'yes' is now a VALID spelling of true (#439), so the unreadable
        // boolean here has to be a genuinely ambiguous one — and it is asserted
        // on a key that still defaults OFF, so that only a real rejection can
        // produce the expected value. On a default-on key, a parser that
        // wrongly accepted 'enabled' would return the same `true` the fallback
        // does, and this test would pass while proving nothing.
        PROMOTION_LADDER_ENABLED: 'enabled',
        CLAUDE_CODE_PERMISSION_MODE: 'yolo',
      });

      expect(settings.get('runners.claudeCodeLocal.maxConcurrency')).toBe(2);
      expect(settings.get('promotion.enabled')).toBe(false);
      // NOT `acceptEdits`, the declared default, since #441. `'yolo'` is an
      // unreadable value, and for this key the declared default is broader
      // than the narrowest legal mode — so a rejected value lands on `plan`
      // instead. The other two keys in this arrangement keep falling back to
      // their declared defaults, which is what makes this a rule about a
      // named subset rather than a change to every key.
      expect(settings.get('runners.claudeCodeLocal.permissionMode')).toBe(
        'plan',
      );
    });

    it('reports the rejection instead of presenting it as accepted', () => {
      const resolved = withEnv({ RECONCILER_INTERVAL_MS: 'soon' }).resolve(
        'reconciler.intervalMs',
      );

      expect(resolved.value).toBe(60_000);
      expect(resolved.source).toBe('default');
      expect(resolved.invalid?.source).toBe('env');
      expect(resolved.invalid?.reason).toBeTruthy();
    });

    it('reports it at ERROR, naming the variable, the value and what is in force — once', () => {
      // ERROR since ADR-0019 (#439), and it used to be a warning. While every
      // switch that spends money or acts outwardly defaulted off, an
      // unreadable value fell back to the inert posture and a warning was
      // proportionate. The fallback now lands on the ACTIVE posture for those
      // keys, so this event means "you tried to change something, we could not
      // read it, and it is on" — which an operator has to be able to find.
      //
      // Asserted once rather than per read: `get()` is a hot path and
      // `refresh()` runs every 15 seconds, so a line per read is how a real
      // error becomes invisible.
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const settings = withEnv({ GITHUB_MAX_RETRIES: 'many' });

      settings.get('github.maxRetries');
      settings.get('github.maxRetries');
      settings.get('github.maxRetries');

      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0]);
      expect(line).toContain('GITHUB_MAX_RETRIES');
      expect(line).toContain('github.maxRetries');
      // The value that could not be read, and the one an operator is actually
      // running with — the half that used to be left to inference.
      expect(line).toContain('"many"');
      expect(line).toContain('3');
    });

    it('refuses a value outside the declared bounds', () => {
      expect(
        withEnv({ CLAUDE_CODE_MAX_CONCURRENCY: '0' }).get(
          'runners.claudeCodeLocal.maxConcurrency',
        ),
      ).toBe(2);
    });
  });

  describe('the read is synchronous', () => {
    it('returns a value, not a promise', () => {
      // Non-negotiable, and asserted rather than assumed: the consumers that
      // migrate in #340 read config inside pure decision functions and
      // property getters — runner-registration.service.ts:536,
      // dispatch.service.ts:96, run-executor.service.ts:272,
      // fleet-state.service.ts:496 — where there is no `await` to add.
      const value: boolean = withEnv({ DISPATCH_ENABLED: 'true' }).get(
        'dispatch.enabled',
      );

      expect(value).toBe(true);
      expect(value).not.toBeInstanceOf(Promise);
    });
  });

  describe('snapshot', () => {
    it('contains every declared key', () => {
      const snapshot = withEnv({ SUPERVISOR_ENABLED: 'true' }).snapshot();

      expect(Object.keys(snapshot).sort()).toEqual(
        [...OPERATOR_SETTING_KEYS].sort(),
      );
      expect(snapshot['supervisor.enabled']).toBe(true);
      // A key the environment did NOT set, carrying its registry default, and
      // deliberately one that still defaults OFF so the assertion has a
      // contrast to make. It has now been re-picked twice for that reason:
      // `dispatch.enabled` stood here until ADR-0019 (#439) flipped it, then
      // `reconciler.enabled` until the same change took the fifth flag too.
      // If `promotion.enabled` ever ships on, this needs re-picking again —
      // and it will fail rather than go quiet, which is the point.
      expect(snapshot['promotion.enabled']).toBe(false);
    });
  });

  describe('the change emitter', () => {
    it('tells subscribers which keys changed', () => {
      const settings = withEnv({});
      const seen: OperatorSettingsChange[] = [];
      settings.onChange((change) => seen.push(change));

      settings.notifyChanged(['dispatch.enabled', 'reconciler.enabled']);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.keys).toEqual(['dispatch.enabled', 'reconciler.enabled']);
      expect(seen[0]?.at).toBeInstanceOf(Date);
    });

    it('says nothing when nothing changed', () => {
      const settings = withEnv({});
      const listener = jest.fn();
      settings.onChange(listener);

      settings.notifyChanged([]);

      expect(listener).not.toHaveBeenCalled();
    });

    it('stops calling a listener that unsubscribed', () => {
      const settings = withEnv({});
      const listener = jest.fn();
      const unsubscribe = settings.onChange(listener);

      unsubscribe();
      settings.notifyChanged(['dispatch.enabled']);

      expect(listener).not.toHaveBeenCalled();
    });

    it('still tells the other subscribers when one throws', () => {
      // A refresh loop must not be stopped by one bad subscriber, and the
      // write that triggered the notification must not fail because of one
      // either.
      const settings = withEnv({});
      const second = jest.fn();
      settings.onChange(() => {
        throw new Error('subscriber exploded');
      });
      settings.onChange(second);

      expect(() => settings.notifyChanged(['dispatch.enabled'])).not.toThrow();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
