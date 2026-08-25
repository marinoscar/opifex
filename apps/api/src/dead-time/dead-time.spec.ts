import {
  DAY_MS,
  deadTimeInWindow,
  describeBasis,
  overlapMs,
  type DeadIntervalSample,
} from './dead-time';

const FROM = new Date('2026-08-18T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function interval(
  startHours: number,
  endHours: number | null,
  kind: 'stalled' | 'parked' = 'stalled',
): DeadIntervalSample {
  return {
    kind,
    startedAt: new Date(FROM.getTime() + startHours * HOUR),
    endedAt:
      endHours === null ? null : new Date(FROM.getTime() + endHours * HOUR),
  };
}

describe('overlapMs', () => {
  const to = new Date(FROM.getTime() + DAY_MS);

  it('counts an interval entirely inside the window', () => {
    expect(overlapMs(interval(2, 5), FROM, to)).toBe(3 * HOUR);
  });

  it('clips an interval that started before the window', () => {
    expect(overlapMs(interval(-10, 4), FROM, to)).toBe(4 * HOUR);
  });

  it('clips an interval that outlives the window', () => {
    expect(overlapMs(interval(20, 40), FROM, to)).toBe(4 * HOUR);
  });

  /**
   * The behaviour #232 asks to be explicit about. An open interval runs to the
   * window's end — not to zero, which would report a factory that is dead
   * right now as perfectly healthy.
   */
  it('runs an OPEN interval to the end of the window', () => {
    expect(overlapMs(interval(18, null), FROM, to)).toBe(6 * HOUR);
  });

  it('is zero, never negative, for an interval outside the window', () => {
    expect(overlapMs(interval(-10, -5), FROM, to)).toBe(0);
    expect(overlapMs(interval(30, 40), FROM, to)).toBe(0);
  });
});

describe('deadTimeInWindow', () => {
  it('divides by the REQUESTED days, not the days that had data', () => {
    // Six dead hours, all on day one of a seven-day window.
    const window = deadTimeInWindow([interval(1, 7)], FROM, 7);

    expect(window.hoursPerDay).toBeCloseTo(6 / 7);
    expect(window.perDayHours).toHaveLength(7);
    expect(window.perDayHours[0]).toBeCloseTo(6);
    expect(window.perDayHours.slice(1)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  /**
   * The convention that makes days comparable. Attributing a 30-hour stall
   * wholly to the day it began would put 30 hours inside a 24-hour day.
   */
  it('SPLITS an interval that spans a day boundary across both days', () => {
    // Starts 18h into day one, runs 30 hours: 6h on day 1, 24h on day 2, 0 on
    // day 3 — it ends exactly at the start of day 3.
    const window = deadTimeInWindow([interval(18, 48)], FROM, 3);

    expect(window.perDayHours[0]).toBeCloseTo(6);
    expect(window.perDayHours[1]).toBeCloseTo(24);
    expect(window.perDayHours[2]).toBeCloseTo(0);
    // And the daily values sum back to the window total, which is the whole
    // reason splitting is the right convention.
    const summed = window.perDayHours.reduce((a, b) => a + b, 0);
    expect(summed / 3).toBeCloseTo(window.hoursPerDay);
    expect(window.perDayHours[1]).toBeLessThanOrEqual(24);
  });

  it('keeps stalled and parked separable', () => {
    const window = deadTimeInWindow(
      [interval(0, 4, 'stalled'), interval(4, 12, 'parked')],
      FROM,
      1,
    );

    expect(window.hoursPerDay).toBeCloseTo(12);
    expect(window.stalledHoursPerDay).toBeCloseTo(4);
    expect(window.parkedHoursPerDay).toBeCloseTo(8);
    // Both halves add up to the whole — the split is a decomposition, not a
    // second opinion.
    expect(window.stalledHoursPerDay + window.parkedHoursPerDay).toBeCloseTo(
      window.hoursPerDay,
    );
  });

  it('counts an open interval and says how many are still open', () => {
    const window = deadTimeInWindow([interval(20, null)], FROM, 1);

    expect(window.hoursPerDay).toBeCloseTo(4);
    expect(window.openIntervals).toBe(1);
    expect(window.intervals).toBe(1);
  });

  it('ignores intervals that fall entirely outside the window', () => {
    const window = deadTimeInWindow([interval(-40, -30)], FROM, 1);

    expect(window.hoursPerDay).toBe(0);
    expect(window.intervals).toBe(0);
  });

  it('reports a full-length series even when every day is zero', () => {
    // A zero day is a REAL measurement for dead time, unlike a zero latency:
    // "nothing was stalled or parked today" is the metric's best value.
    const window = deadTimeInWindow([], FROM, 5);
    expect(window.perDayHours).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('describeBasis', () => {
  it('states every convention the number rests on', () => {
    const window = deadTimeInWindow(
      [interval(0, 4, 'stalled'), interval(6, null, 'parked')],
      FROM,
      1,
    );
    const basis = describeBasis(window, 1);

    expect(basis).toContain('stalled');
    expect(basis).toContain('parked');
    expect(basis).toContain('split');
    expect(basis).toContain('still');
    expect(basis).toContain('1 rolling 24h day(s)');
  });
});
