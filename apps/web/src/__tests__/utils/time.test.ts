import { describe, it, expect } from 'vitest';
import { formatRelativeTime, formatClockTime } from '../../utils/time';

/**
 * `now` is always passed explicitly. That is the reason these helpers exist as
 * pure functions at all — an age string an operator makes decisions on should
 * be testable without faking the process clock.
 */
describe('formatRelativeTime', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');

  it('renders compact ages', () => {
    expect(formatRelativeTime('2026-08-19T11:59:30.000Z', now)).toBe(
      'just now',
    );
    expect(formatRelativeTime('2026-08-19T11:57:00.000Z', now)).toBe('3m ago');
    expect(formatRelativeTime('2026-08-19T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-08-17T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(formatRelativeTime(new Date('2026-08-19T11:55:00.000Z'), now)).toBe(
      '5m ago',
    );
  });

  /**
   * Clock skew between the control plane and the browser is real. A negative
   * age ("-5m ago") looks like a bug in the UI rather than a fact about the
   * data, and an operator who distrusts the clock distrusts the panel.
   */
  it('phrases a future timestamp as the future', () => {
    expect(formatRelativeTime('2026-08-19T12:05:00.000Z', now)).toBe('in 5m');
    expect(formatRelativeTime('2026-08-19T12:00:30.000Z', now)).toBe(
      'in a moment',
    );
  });

  /**
   * Null rather than a placeholder string: the CALLER decides how absence
   * reads. `AttentionRow` says "no events yet", which is a meaningful fact
   * about a run; a shared "—" would have thrown that away.
   */
  it('returns null rather than inventing a time', () => {
    expect(formatRelativeTime(null, now)).toBeNull();
    expect(formatRelativeTime(undefined, now)).toBeNull();
    expect(formatRelativeTime('not a date', now)).toBeNull();
  });
});

describe('formatClockTime', () => {
  it('renders a wall-clock time', () => {
    const value = formatClockTime(new Date('2026-08-19T12:34:00.000Z'));
    // Locale- and timezone-dependent, so the assertion is on the SHAPE. The
    // header uses an absolute time precisely because it cannot go stale, and
    // the shape is what carries that.
    expect(value).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it('returns null for a missing or invalid date', () => {
    expect(formatClockTime(null)).toBeNull();
    expect(formatClockTime(undefined)).toBeNull();
    expect(formatClockTime(new Date('nope'))).toBeNull();
  });
});
