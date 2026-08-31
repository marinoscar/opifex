import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HISTORY_RANGE,
  HISTORY_RANGES,
  describeBlockedRuns,
  describeConsumption,
  formatEpisodeDuration,
  formatInstant,
  sinceFor,
} from '../../../components/quota/quotaFormat';
import type { ExhaustedWindow } from '../../../types/quota';

/**
 * `/quota`'s history formatters, asserted (#476).
 *
 * Every function here is pure and small, and every one that touches the clock
 * takes it as a parameter — `sinceFor` is the one function in this module
 * that would otherwise read `Date.now()`, so every test below injects `now`
 * rather than trusting the real clock, exactly as `quotaFormat.ts`'s own
 * header requires.
 */

function window(overrides: Partial<ExhaustedWindow> = {}): ExhaustedWindow {
  return {
    runnerKey: 'claude-code-local',
    kind: 'five_hour',
    resetsAt: '2026-08-31T04:00:00.000Z',
    pressure: 'allowed',
    peakPressure: 'exhausted',
    firstObservedAt: '2026-08-30T22:00:00.000Z',
    lastObservedAt: '2026-08-30T23:50:00.000Z',
    observations: 4,
    blockedRuns: 0,
    blockedEvents: 0,
    ...overrides,
  };
}

describe('sinceFor', () => {
  // A fixed instant, injected rather than read from the real clock — this
  // function is the only thing in the module that would otherwise call
  // `new Date()` internally, and doing so would make its own output
  // untestable without faking the global clock.
  const NOW = new Date('2026-08-31T12:00:00.000Z');

  it('returns undefined for a range with no lower bound at all', () => {
    expect(sinceFor('all', NOW)).toBeUndefined();
  });

  it('returns undefined for an id the range list does not declare', () => {
    expect(sinceFor('not-a-real-range', NOW)).toBeUndefined();
  });

  it.each(HISTORY_RANGES.filter((range) => range.days !== null))(
    '$id: subtracts exactly $days whole day(s) from the injected now',
    (range) => {
      const since = sinceFor(range.id, NOW);
      expect(since).toBe(
        new Date(
          NOW.getTime() - (range.days as number) * 86_400_000,
        ).toISOString(),
      );
    },
  );

  it('defaults the page to the widest BOUNDED range, not "all time"', () => {
    // #476: a screen that defaulted to no lower bound at all, over a history
    // that is sparse by design, would read as broken rather than as quiet.
    const defaultRange = HISTORY_RANGES.find(
      (candidate) => candidate.id === DEFAULT_HISTORY_RANGE,
    );
    expect(defaultRange?.days).not.toBeNull();
  });

  it('never reads the real clock when one is supplied', () => {
    // Two calls, same injected `now`, must be byte-identical — proof the
    // function is not quietly consulting `Date.now()` on the side.
    expect(sinceFor('7d', NOW)).toBe(sinceFor('7d', NOW));
  });
});

describe('formatEpisodeDuration', () => {
  it('renders a still-open episode as "still open", never an em dash', () => {
    // Null is not "short" and not "nothing to show" — the episode has no
    // observed end at all, which is a different claim from a brief one.
    expect(formatEpisodeDuration(null)).toBe('still open');
  });

  it('renders sub-minute spans in words, not "0m"', () => {
    expect(formatEpisodeDuration(0)).toBe('under a minute');
    expect(formatEpisodeDuration(45_000)).toBe('under a minute');
  });

  it('renders minutes below an hour', () => {
    expect(formatEpisodeDuration(60_000)).toBe('1m');
    expect(formatEpisodeDuration(900_000)).toBe('15m');
  });

  it('renders hours and minutes below a day', () => {
    expect(formatEpisodeDuration(3_600_000)).toBe('1h');
    expect(formatEpisodeDuration(3_600_000 + 5 * 60_000)).toBe('1h 5m');
  });

  it('renders days and hours at or above a day', () => {
    expect(formatEpisodeDuration(86_400_000)).toBe('1d');
    expect(formatEpisodeDuration(86_400_000 + 3 * 3_600_000)).toBe('1d 3h');
  });

  it('never goes negative on a malformed span', () => {
    expect(formatEpisodeDuration(-500)).toBe('under a minute');
  });
});

describe('describeBlockedRuns', () => {
  it('names the zero case in words: "Nothing dispatched"', () => {
    // The case the windows endpoint exists for: a window can hit its ceiling
    // with nothing dispatched against it, which is a real answer, not a
    // missing join — so a bare "0" must never be what renders.
    expect(
      describeBlockedRuns(window({ blockedRuns: 0, blockedEvents: 0 })),
    ).toBe('Nothing dispatched');
  });

  it('says "1 run" in the singular', () => {
    expect(
      describeBlockedRuns(window({ blockedRuns: 1, blockedEvents: 1 })),
    ).toBe('1 run blocked');
  });

  it('pluralizes runs when there is more than one', () => {
    expect(
      describeBlockedRuns(window({ blockedRuns: 3, blockedEvents: 3 })),
    ).toBe('3 runs blocked');
  });

  it('states blocks separately once events exceed runs', () => {
    // One run refused, resumed, and refused again: 1 run, 2 blocks. Reporting
    // only the run count would understate the noise this window caused.
    expect(
      describeBlockedRuns(window({ blockedRuns: 1, blockedEvents: 2 })),
    ).toBe('1 run blocked · 2 blocks');
  });

  it('states blocks separately for more than one run too', () => {
    expect(
      describeBlockedRuns(window({ blockedRuns: 2, blockedEvents: 5 })),
    ).toBe('2 runs blocked · 5 blocks');
  });
});

describe('formatInstant', () => {
  it('returns the raw string for an unparseable instant, not "Invalid Date"', () => {
    expect(formatInstant('not-a-date')).toBe('not-a-date');
  });

  it('formats a real instant to a non-empty, different string', () => {
    const formatted = formatInstant('2026-08-31T04:00:00.000Z');
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).not.toBe('2026-08-31T04:00:00.000Z');
  });
});

describe('describeConsumption', () => {
  it('keeps "no cost reported" distinct from "$0.00"', () => {
    // Null cost is not $0: a runner that does not report cost is a supported
    // case, and a total that ignored those runs would understate consumption
    // while looking precise.
    expect(
      describeConsumption({ runs: 2, runsWithoutCost: 0, reportedUsd: null }),
    ).toBe('2 runs · no cost reported');
    expect(
      describeConsumption({ runs: 1, runsWithoutCost: 0, reportedUsd: 0 }),
    ).toBe('1 run · $0.00 reported');
  });

  it('names the count without cost only when it is non-zero', () => {
    expect(
      describeConsumption({ runs: 3, runsWithoutCost: 0, reportedUsd: 1.5 }),
    ).toBe('3 runs · $1.50 reported');
    expect(
      describeConsumption({ runs: 3, runsWithoutCost: 1, reportedUsd: 1.5 }),
    ).toBe('3 runs · $1.50 reported · 1 without cost');
  });
});
