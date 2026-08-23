import {
  DEFAULT_CEILING_WINDOW_DAYS,
  HARD_SPEND_CEILING_ENV,
  HARD_SPEND_CEILING_WINDOW_ENV,
  HardSpendCeilingService,
  parseHardCeiling,
} from './hard-spend-ceiling';

/**
 * The ceiling VISION §8 calls never-trustable (#65).
 *
 * Two things are under test here and they are not the same thing:
 *
 *  1. That the value is parsed correctly, including the cases where a
 *     plausible-looking value must NOT be accepted.
 *  2. That there is no way to move it once the process is running. That
 *     second one is the actual requirement -- "the hard spend ceiling cannot
 *     be raised by any trust grant or runtime setting" -- and it is asserted
 *     structurally rather than by inspection, because a comment saying a field
 *     is immutable stops being true the first time somebody adds a setter.
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
      expect(parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '' }).limitUsd).toBeNull();
      expect(parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '   ' }).limitUsd).toBeNull();
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
      expect(parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: '-10' }).malformed).toBe('-10');
    });

    it('refuses Infinity, which parses as a finite-looking number', () => {
      // `Number('Infinity')` is a number and is greater than every tally, so
      // an unguarded parse would turn a typo into "no limit at all" while
      // reporting that a ceiling was configured.
      expect(parseHardCeiling({ [HARD_SPEND_CEILING_ENV]: 'Infinity' }).malformed).toBe('Infinity');
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
      expect(parseHardCeiling({ [HARD_SPEND_CEILING_WINDOW_ENV]: '0' }).windowDays).toBe(
        DEFAULT_CEILING_WINDOW_DAYS,
      );
      expect(parseHardCeiling({ [HARD_SPEND_CEILING_WINDOW_ENV]: 'soon' }).windowDays).toBe(
        DEFAULT_CEILING_WINDOW_DAYS,
      );
    });
  });

  describe('immutability — the actual requirement', () => {
    const original = process.env[HARD_SPEND_CEILING_ENV];

    afterEach(() => {
      if (original === undefined) delete process.env[HARD_SPEND_CEILING_ENV];
      else process.env[HARD_SPEND_CEILING_ENV] = original;
    });

    it('does not move when the environment is changed after construction', () => {
      process.env[HARD_SPEND_CEILING_ENV] = '25';
      const service = new HardSpendCeilingService();

      process.env[HARD_SPEND_CEILING_ENV] = '999999';

      expect(service.value.limitUsd).toBe(25);
    });

    it('does not move when a caller mutates the object it handed back', () => {
      // `value` returns a copy. Without that, a caller could raise the ceiling
      // for every subsequent reader by assigning to one field of the object it
      // was given -- no setter required, and nothing recording it happened.
      process.env[HARD_SPEND_CEILING_ENV] = '25';
      const service = new HardSpendCeilingService();

      const grabbed = service.value as { limitUsd: number | null };
      grabbed.limitUsd = 999999;

      expect(service.value.limitUsd).toBe(25);
    });

    it('exposes no way to set it', () => {
      // Structural rather than a comment: the assertion fails the moment
      // somebody adds a setter, a public field, or a `configure()` helper,
      // which is precisely when a reviewer needs to be stopped.
      process.env[HARD_SPEND_CEILING_ENV] = '25';
      const service = new HardSpendCeilingService();

      const surface = [
        ...Object.getOwnPropertyNames(service),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
      ];

      expect(surface.filter((name) => /^set|^raise|^update|^configure/i.test(name))).toEqual([]);
      // And the one property it does expose is a getter with no companion
      // setter, so `service.value = ...` cannot work either.
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(service),
        'value',
      );
      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.set).toBeUndefined();
    });
  });
});
