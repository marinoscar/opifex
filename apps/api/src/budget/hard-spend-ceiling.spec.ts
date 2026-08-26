import { Logger } from '@nestjs/common';

import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
import {
  DEFAULT_CEILING_WINDOW_DAYS,
  HARD_SPEND_CEILING_ENV,
  HARD_SPEND_CEILING_WINDOW_ENV,
  HardSpendCeilingService,
  parseHardCeiling,
} from './hard-spend-ceiling';

/**
 * The ceiling VISION §8 calls never-trustable (#65, #345, ADR-0018 §6).
 *
 * Two things are under test here and they are not the same thing:
 *
 *  1. That the value is parsed correctly, including the cases where a
 *     plausible-looking value must NOT be accepted. Unchanged by #345 —
 *     `parseHardCeiling` is still the single parser, on both layers.
 *  2. That the ceiling MOVES when an operator moves it. That second one used
 *     to be its exact opposite: this file asserted structurally that no setter
 *     existed, because the guarantee was that no runtime path to a higher
 *     ceiling existed at all. ADR-0018 §6 replaced that structural guarantee
 *     with an access-controlled one, deliberately and as a named downgrade, on
 *     the strength of #334 (the agent subprocess inherits no credential) and
 *     #346 (the settings write path refuses a non-interactive one). So the
 *     assertions here follow it: the ceiling resolves through
 *     `OperatorSettingsService`, a raised ceiling permits more spend
 *     immediately, and a lowered one permits less.
 *
 * What is NOT re-asserted here is who may reach the write path — that is
 * `interactive-session.guard.ts`'s spec and the controller's, and duplicating
 * it here would produce two places to update when the barrier changes.
 */
describe('the hard spend ceiling', () => {
  describe('parsing', () => {
    it('reads a plain dollar figure', () => {
      expect(parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '50' })).toEqual({
        limitUsd: 50,
        windowDays: DEFAULT_CEILING_WINDOW_DAYS,
        malformed: null,
      });
    });

    it('accepts zero, because "spend nothing" is an instruction', () => {
      // Distinct from unset. An operator who sets the ceiling to zero has
      // said something specific, and the gate must refuse spend rather than
      // fall through to "no ceiling configured".
      const ceiling = parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '0' });

      expect(ceiling.limitUsd).toBe(0);
      expect(ceiling.malformed).toBeNull();
    });

    it('treats an empty string as unset rather than as zero', () => {
      // `Number('')` is 0. Without the explicit empty check, an exported-but-
      // empty variable would silently become the strictest possible ceiling
      // and stop the factory, which is the wrong failure for a typo.
      expect(
        parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '' }).limitUsd,
      ).toBeNull();
      expect(
        parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '   ' }).limitUsd,
      ).toBeNull();
    });

    it('reports a malformed value as malformed, not as absent', () => {
      // THE case this distinction exists for: somebody who typed a letter O
      // into 50 believes they have a ceiling. Reporting it as unset would
      // leave them believing it.
      const ceiling = parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '5O' });

      expect(ceiling.limitUsd).toBeNull();
      expect(ceiling.malformed).toBe('5O');
    });

    it('refuses a negative ceiling', () => {
      expect(
        parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '-10' }).malformed,
      ).toBe('-10');
    });

    it('refuses Infinity, which parses as a finite-looking number', () => {
      // `Number('Infinity')` is a number and is greater than every tally, so
      // an unguarded parse would turn a typo into "no limit at all" while
      // reporting that a ceiling was configured.
      expect(
        parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: 'Infinity' }).malformed,
      ).toBe('Infinity');
    });

    it('defaults the window and accepts an override', () => {
      expect(parseHardCeiling({}).windowDays).toBe(DEFAULT_CEILING_WINDOW_DAYS);
      expect(
        parseHardCeiling({ [HARD_SPEND_CEILING_WINDOW_ENV]: '7' }).windowDays,
      ).toBe(7);
    });

    it('falls back to the default window for a nonsense one', () => {
      // A zero-day window would make every tally empty and the ceiling
      // unreachable -- the failure mode where the safety mechanism reports
      // success forever.
      expect(
        parseHardCeiling({ [HARD_SPEND_CEILING_WINDOW_ENV]: '0' }).windowDays,
      ).toBe(DEFAULT_CEILING_WINDOW_DAYS);
      expect(
        parseHardCeiling({ [HARD_SPEND_CEILING_WINDOW_ENV]: 'soon' })
          .windowDays,
      ).toBe(DEFAULT_CEILING_WINDOW_DAYS);
    });
  });

  describe('resolving through the operator settings resolver (#345)', () => {
    it('reads the environment layer exactly as it always did', () => {
      const service = new HardSpendCeilingService(
        makeOperatorSettings({
          env: {
            [HARD_SPEND_CEILING_ENV]: '25',
            [HARD_SPEND_CEILING_WINDOW_ENV]: '7',
          },
        }),
      );

      expect(service.value).toEqual({
        limitUsd: 25,
        windowDays: 7,
        malformed: null,
      });
    });

    it('lets a stored override win over the environment', () => {
      // The reversal, in one assertion: a value an admin stored beats the
      // variable an operator exported, which before #345 nothing could do.
      const service = new HardSpendCeilingService(
        makeOperatorSettings({
          env: { [HARD_SPEND_CEILING_ENV]: '25' },
          overrides: { 'dispatch.hardSpendCeilingUsd': '250' },
        }),
      );

      expect(service.value.limitUsd).toBe(250);
    });

    it('falls back to the declared window when neither layer names one', () => {
      const service = new HardSpendCeilingService(
        makeOperatorSettings({ env: { [HARD_SPEND_CEILING_ENV]: '25' } }),
      );

      expect(service.value.windowDays).toBe(DEFAULT_CEILING_WINDOW_DAYS);
    });

    it('still refuses to spend when nothing anywhere sets a ceiling', () => {
      // Unset is not unlimited, on the resolver path as much as on the env
      // one: the registry's default for this key is the empty string, which
      // `parseHardCeiling` reads as absent rather than as zero.
      const service = new HardSpendCeilingService(makeOperatorSettings({}));

      expect(service.value).toEqual({
        limitUsd: null,
        windowDays: DEFAULT_CEILING_WINDOW_DAYS,
        malformed: null,
      });
    });

    it('still tells a malformed ceiling apart from an unset one', () => {
      // The reason the registry declares this key as a string. A numeric
      // schema would reject '5O' at the resolver, resolve the key to its
      // default, and report exactly what an unset ceiling reports — losing the
      // one signal that says somebody believed they had set a limit.
      const service = new HardSpendCeilingService(
        makeOperatorSettings({ env: { [HARD_SPEND_CEILING_ENV]: '5O' } }),
      );

      expect(service.value.limitUsd).toBeNull();
      expect(service.value.malformed).toBe('5O');
    });
  });

  describe('changing at runtime — the requirement that reversed', () => {
    let logs: { level: string; text: string }[];

    beforeEach(() => {
      logs = [];
      for (const level of ['log', 'warn', 'error'] as const) {
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            logs.push({ level, text: String(args[0]) });
          });
      }
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('permits more spend the moment an admin raises it', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '10' },
      });
      const service = new HardSpendCeilingService(settings);
      expect(service.value.limitUsd).toBe(10);

      settings.setOverride('dispatch.hardSpendCeilingUsd', '400');

      expect(service.value.limitUsd).toBe(400);
    });

    it('permits less the moment an admin lowers it, with no restart', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '400' },
      });
      const service = new HardSpendCeilingService(settings);

      settings.setOverride('dispatch.hardSpendCeilingUsd', '1');

      expect(service.value.limitUsd).toBe(1);
    });

    it('follows the window too, not only the figure', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '10' },
      });
      const service = new HardSpendCeilingService(settings);
      expect(service.value.windowDays).toBe(DEFAULT_CEILING_WINDOW_DAYS);

      settings.setOverride('dispatch.hardSpendCeilingWindowDays', 1);

      expect(service.value.windowDays).toBe(1);
    });

    it('ignores a change to a key that is not this ceiling', () => {
      // Not an optimisation. Re-announcing the ceiling every time an unrelated
      // timeout moved would put a spend limit in the log often enough that
      // nobody reads it, which is how the announcement stops working.
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '10' },
      });
      new HardSpendCeilingService(settings);
      logs.length = 0;

      settings.setOverride('github.maxRetries', 4);

      expect(logs).toEqual([]);
    });

    it('announces the new ceiling when it moves, so a live change is visible', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '10' },
      });
      new HardSpendCeilingService(settings);
      logs.length = 0;

      settings.setOverride('dispatch.hardSpendCeilingUsd', '400');

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('log');
      expect(logs[0].text).toContain('$400');
    });

    it('escalates to an error when a live change makes it malformed', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '10' },
      });
      new HardSpendCeilingService(settings);
      logs.length = 0;

      settings.setOverride('dispatch.hardSpendCeilingUsd', '4OO');

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].text).toContain('"4OO"');
    });

    it('says nothing when a change resolves to the same ceiling', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '10' },
      });
      new HardSpendCeilingService(settings);
      logs.length = 0;

      settings.setOverride('dispatch.hardSpendCeilingUsd', '10');

      expect(logs).toEqual([]);
    });

    it('picks up an overlay whose change event never arrived', () => {
      // The belt to the listener's braces. In the running system the listener
      // is enough: every provider is CONSTRUCTED before any `onModuleInit`
      // runs, so this class is already subscribed when
      // `OperatorSettingsService` loads the overlay and announces it. What
      // `onModuleInit` covers is the case where that announcement does not
      // reach us — a resolver instantiated ahead of this one, or a refresh
      // whose diff reported nothing — where the alternative is a stored
      // ceiling that stays invisible until the next time somebody edits it.
      const settings = makeOperatorSettings({
        env: { [HARD_SPEND_CEILING_ENV]: '25' },
      });
      const service = new HardSpendCeilingService(settings);
      expect(service.value.limitUsd).toBe(25);

      const swallowed = jest
        .spyOn(settings, 'notifyChanged')
        .mockImplementation(() => undefined);
      settings.setOverride('dispatch.hardSpendCeilingUsd', '250');
      swallowed.mockRestore();
      expect(service.value.limitUsd).toBe(25);

      service.onModuleInit();

      expect(service.value.limitUsd).toBe(250);
    });

    it('stops following changes once the module is destroyed', () => {
      const settings = makeOperatorSettings({
        overrides: { 'dispatch.hardSpendCeilingUsd': '10' },
      });
      const service = new HardSpendCeilingService(settings);

      service.onModuleDestroy();
      settings.setOverride('dispatch.hardSpendCeilingUsd', '400');

      expect(service.value.limitUsd).toBe(10);
    });
  });

  describe('what did NOT change', () => {
    it('hands back a copy, so a caller cannot raise it by mutating one', () => {
      // Still true and still load-bearing. Without it a caller could raise the
      // ceiling for every subsequent reader by assigning to one field of the
      // object it was given — no write path, no audit row, nothing recording
      // that it happened, which is exactly what the access-controlled
      // guarantee claims cannot occur.
      const service = new HardSpendCeilingService(
        makeOperatorSettings({
          overrides: { 'dispatch.hardSpendCeilingUsd': '25' },
        }),
      );

      const grabbed = service.value as { limitUsd: number | null };
      grabbed.limitUsd = 999999;

      expect(service.value.limitUsd).toBe(25);
    });

    it('exposes no mutator that takes a value', () => {
      // The inversion of the old "exposes no way to set it", and the part of
      // it that survives. A setter now exists, but it is fed by the resolver
      // and takes no argument: nothing holding this instance can name a
      // number. A `set(usd)` would be the `ConfigService.set()` hazard this
      // file was originally written against, rebuilt inside the class that
      // was written to avoid it.
      const service = new HardSpendCeilingService(makeOperatorSettings({}));

      const named = [
        ...Object.getOwnPropertyNames(service),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
      ].filter((name) => /^(set|raise|update|configure)/i.test(name));

      // Narrowed to callables so the injected `settings` resolver — a field
      // whose name begins with "set" and which nothing can call — does not
      // read as a mutator. Widening this back to every matching NAME would
      // make the assertion fail for a reason that has nothing to do with what
      // it is claiming.
      const mutators = named.filter(
        (name) =>
          typeof (service as unknown as Record<string, unknown>)[name] ===
          'function',
      );

      expect(mutators).toEqual([]);
      // The one mutator there is takes no parameter: `refresh()` asks the
      // resolver, and a caller cannot name a number for it.
      expect(service.refresh).toHaveLength(0);
    });

    it('exposes `value` as a getter with no companion setter', () => {
      const service = new HardSpendCeilingService(makeOperatorSettings({}));

      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(service),
        'value',
      );

      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.set).toBeUndefined();
    });
  });
});
