import { Logger } from '@nestjs/common';

import {
  HARD_SPEND_CEILING_ENV,
  HARD_SPEND_CEILING_WINDOW_ENV,
  parseHardCeiling,
} from '../../budget/hard-spend-ceiling';
import {
  DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS,
  parseSupervisorCeiling,
  SUPERVISOR_SPEND_CEILING_ENV,
  SUPERVISOR_SPEND_CEILING_WINDOW_ENV,
  SupervisorSpendCeilingService,
} from './supervisor-spend-ceiling';

/**
 * The supervisor's own ceiling (#261, ADR-0017).
 *
 * Three things are under test, and they are not the same thing:
 *
 *  1. That the value parses, including the plausible-looking values that must
 *     NOT be accepted.
 *  2. That it agrees with the dispatch ceiling's parser everywhere the two
 *     overlap. ADR-0017 permits duplicating `parseHardCeiling` rather than
 *     parameterizing it, on condition the rules stay identical in BEHAVIOUR —
 *     which is a promise, and this is the test that holds it. A change made to
 *     one parser and not the other fails here rather than drifting quietly.
 *  3. That there is no way to move it once the process is running, which is
 *     the actual requirement (VISION §8: "a limit an agent can raise is not a
 *     limit").
 */
describe('the supervisor spend ceiling', () => {
  describe('parsing', () => {
    it('reads a plain dollar figure', () => {
      expect(
        parseSupervisorCeiling({ [SUPERVISOR_SPEND_CEILING_ENV]: '5' }),
      ).toEqual({
        limitUsd: 5,
        windowDays: DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS,
        malformed: null,
      });
    });

    it('defaults the window to ONE day, not thirty', () => {
      // The cadence argument, asserted rather than commented. `SupervisorTask`
      // runs hourly at a near-constant per-tick cost, so a monthly window is
      // both slow to catch a pricing regression (weeks of ticks before a
      // monthly figure moves) and slow to recover from one (dark for up to a
      // month) — the worst pair for a control whose failure mode is the
      // supervisor's own absence.
      expect(DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS).toBe(1);
      expect(parseSupervisorCeiling({}).windowDays).toBe(1);
    });

    it('accepts zero, because "spend nothing" is an instruction', () => {
      const ceiling = parseSupervisorCeiling({
        [SUPERVISOR_SPEND_CEILING_ENV]: '0',
      });

      expect(ceiling.limitUsd).toBe(0);
      expect(ceiling.malformed).toBeNull();
    });

    it('treats an empty string as unset rather than as zero', () => {
      expect(
        parseSupervisorCeiling({ [SUPERVISOR_SPEND_CEILING_ENV]: '' }).limitUsd,
      ).toBeNull();
      expect(
        parseSupervisorCeiling({ [SUPERVISOR_SPEND_CEILING_ENV]: '  ' })
          .limitUsd,
      ).toBeNull();
    });

    it('reports a malformed value as malformed, not as absent', () => {
      // The case the distinction exists for: somebody who typed a letter O
      // into 50 believes they have a ceiling. Reporting it as unset would
      // leave them believing it — and here both cases refuse, so without
      // `malformed` the log could never tell them which one they are in.
      const ceiling = parseSupervisorCeiling({
        [SUPERVISOR_SPEND_CEILING_ENV]: '5O',
      });

      expect(ceiling.limitUsd).toBeNull();
      expect(ceiling.malformed).toBe('5O');
    });

    it('reports a negative value as malformed', () => {
      expect(
        parseSupervisorCeiling({ [SUPERVISOR_SPEND_CEILING_ENV]: '-5' })
          .malformed,
      ).toBe('-5');
    });

    it('reads its own variables and not the dispatch ceiling’s', () => {
      // The whole decision in one assertion: two ceilings, two names, and
      // setting one must never be read as setting the other.
      const ceiling = parseSupervisorCeiling({
        [HARD_SPEND_CEILING_ENV]: '500',
        [HARD_SPEND_CEILING_WINDOW_ENV]: '30',
      });

      expect(ceiling.limitUsd).toBeNull();
      expect(ceiling.windowDays).toBe(DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS);
    });

    it('falls back to the default window for a window that is not a positive integer', () => {
      for (const raw of ['0', '-1', 'soon', '']) {
        expect(
          parseSupervisorCeiling({
            [SUPERVISOR_SPEND_CEILING_WINDOW_ENV]: raw,
          }).windowDays,
        ).toBe(DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS);
      }
    });
  });

  describe('agreement with the dispatch ceiling parser', () => {
    // One table, both parsers, same expectations about the LIMIT. ADR-0017
    // lets these two functions be siblings rather than one parameterized
    // function; the cost of that choice is drift, and this is where the cost
    // is paid rather than deferred.
    const cases = [
      { raw: undefined, limitUsd: null, malformed: null },
      { raw: '', limitUsd: null, malformed: null },
      { raw: '   ', limitUsd: null, malformed: null },
      { raw: '0', limitUsd: 0, malformed: null },
      { raw: '12.5', limitUsd: 12.5, malformed: null },
      { raw: '5O', limitUsd: null, malformed: '5O' },
      { raw: '-1', limitUsd: null, malformed: '-1' },
      { raw: 'Infinity', limitUsd: null, malformed: 'Infinity' },
    ];

    it.each(cases)('agrees on %p', ({ raw, limitUsd, malformed }) => {
      const supervisor = parseSupervisorCeiling(
        raw === undefined ? {} : { [SUPERVISOR_SPEND_CEILING_ENV]: raw },
      );
      const dispatch = parseHardCeiling(
        raw === undefined ? {} : { [HARD_SPEND_CEILING_ENV]: raw },
      );

      expect(supervisor.limitUsd).toBe(limitUsd);
      expect(supervisor.malformed).toBe(malformed);
      expect(supervisor.limitUsd).toBe(dispatch.limitUsd);
      expect(supervisor.malformed).toBe(dispatch.malformed);
    });

    it('deliberately does NOT agree on the default window', () => {
      // The one intended difference, asserted so it reads as a decision rather
      // than an oversight (ADR-0017, "The window: one day, not thirty").
      expect(parseSupervisorCeiling({}).windowDays).toBe(1);
      expect(parseHardCeiling({}).windowDays).toBe(30);
    });
  });

  describe('immutability — the actual requirement', () => {
    const ENV = SUPERVISOR_SPEND_CEILING_ENV;
    const original = process.env[ENV];

    afterEach(() => {
      if (original === undefined) delete process.env[ENV];
      else process.env[ENV] = original;
    });

    it('does not move when the environment is changed after construction', () => {
      process.env[ENV] = '5';
      const service = new SupervisorSpendCeilingService();

      process.env[ENV] = '999999';

      expect(service.value.limitUsd).toBe(5);
    });

    it('does not move when a caller mutates the object it handed back', () => {
      const service = new SupervisorSpendCeilingService({ [ENV]: '5' });

      const grabbed = service.value as { limitUsd: number | null };
      grabbed.limitUsd = 999999;

      expect(service.value.limitUsd).toBe(5);
    });

    it('exposes no way to set it', () => {
      // Structural rather than a comment: this fails the moment somebody adds
      // a setter, a public field or a `configure()` helper, which is exactly
      // when a reviewer needs stopping.
      const service = new SupervisorSpendCeilingService({ [ENV]: '5' });

      const surface = [
        ...Object.getOwnPropertyNames(service),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
      ];

      expect(
        surface.filter((name) => /^(set|configure|update|raise)/i.test(name)),
      ).toEqual([]);
    });
  });

  describe('what an operator is told at boot', () => {
    /** Capture what the service logs, without a Nest container. */
    function announcementsFor(env: NodeJS.ProcessEnv) {
      const lines: { level: string; text: string }[] = [];
      const spies = (['log', 'warn', 'error'] as const).map((level) =>
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push({ level, text: String(args[0]) });
          }),
      );

      new SupervisorSpendCeilingService(env);
      spies.forEach((spy) => spy.mockRestore());
      return lines;
    }

    const ENABLED = { SUPERVISOR_ENABLED: 'true' };

    it('warns, naming the variable, when the supervisor is on and no ceiling is set', () => {
      // The behaviour change ADR-0017 accepts on purpose: this deployment's
      // supervisor stops running. An operator must be able to learn that from
      // the boot log rather than from a month of skipped_budget rows.
      const [line] = announcementsFor({ ...ENABLED });

      expect(line.level).toBe('warn');
      expect(line.text).toContain(SUPERVISOR_SPEND_CEILING_ENV);
      expect(line.text).toContain('will not run');
      expect(line.text).toContain('skipped_budget');
    });

    it('errors on a malformed ceiling, because somebody believed they set one', () => {
      const [line] = announcementsFor({
        ...ENABLED,
        [SUPERVISOR_SPEND_CEILING_ENV]: '5O',
      });

      expect(line.level).toBe('error');
      expect(line.text).toContain('"5O"');
    });

    it('states the figure and the window when one is configured', () => {
      const [line] = announcementsFor({
        ...ENABLED,
        [SUPERVISOR_SPEND_CEILING_ENV]: '5',
        [SUPERVISOR_SPEND_CEILING_WINDOW_ENV]: '7',
      });

      expect(line.level).toBe('log');
      expect(line.text).toContain('$5');
      expect(line.text).toContain('7 day(s)');
    });

    it('says nothing at all when the supervisor is switched off', () => {
      // A deployment that never turned the supervisor on does not need an
      // hourly reminder to configure a ceiling for a feature it is not using.
      // A boot warning about a setting nobody chose teaches operators to skim
      // warnings.
      expect(announcementsFor({})).toEqual([]);
      expect(announcementsFor({ SUPERVISOR_ENABLED: 'false' })).toEqual([]);
    });
  });
});
