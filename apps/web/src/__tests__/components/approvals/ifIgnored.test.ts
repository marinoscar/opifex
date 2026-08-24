import { describe, it, expect } from 'vitest';
import {
  describeIfIgnored,
  formatCountdown,
  formatDeadline,
  millisecondsUntil,
} from '../../../components/approvals/ifIgnored';

/**
 * VISION §8's fourth field, and the rule that matters most about it: a UI must
 * never imply a deadline that does not exist. `park_and_escalate` has no timer
 * at all, and this suite pins that as a property of the DATA the component
 * renders from (`countdownAt: null`) rather than only as a rendering detail.
 */
describe('describeIfIgnored', () => {
  it('promises the auto-approve case will proceed on its own, with a countdown', () => {
    const description = describeIfIgnored(
      'auto_approve',
      '2026-08-24T18:00:00.000Z',
    );

    expect(description.sentence).toMatch(/proceeds on its own/i);
    expect(description.short).toBe('Proceeds on its own');
    expect(description.countdownAt).toBe('2026-08-24T18:00:00.000Z');
    expect(description.waitsForever).toBe(false);
  });

  it('says the deny case changes nothing and can be raised again', () => {
    const description = describeIfIgnored('deny', '2026-08-24T18:00:00.000Z');

    expect(description.sentence).toMatch(/refused/i);
    expect(description.sentence).toMatch(/raised again/i);
    expect(description.countdownAt).toBe('2026-08-24T18:00:00.000Z');
  });

  it('gives the parked case NO instant to count down to', () => {
    const description = describeIfIgnored('park_and_escalate', null);

    // The null is the never-auto-approve guarantee expressed as data. A caller
    // that renders a countdown from this renders one from `null`.
    expect(description.countdownAt).toBeNull();
    expect(description.waitsForever).toBe(true);
    expect(description.sentence).toMatch(/there is no timer/i);
    expect(description.short).toMatch(/no timer/i);
  });

  it('puts no time-shaped substring in the parked sentence', () => {
    // The same assertion the API's notification builder is held to: a sentence
    // with a time in it — even a hedged one — describes a timer that does not
    // exist.
    const { sentence } = describeIfIgnored('park_and_escalate', null);

    expect(sentence).not.toMatch(/\d{1,2}:\d{2}/);
    expect(sentence).not.toMatch(/\b\d+\s*(hours?|minutes?|days?)\b/i);
  });

  it('still names the outcome when a timed policy arrives without an instant', () => {
    // Not reachable through the API's own writes. If it ever happens, naming
    // the right OUTCOME beats refusing to render the field — but it must not
    // offer a countdown to an instant nobody supplied.
    const description = describeIfIgnored('deny', null);

    expect(description.sentence).toMatch(/when its window closes/i);
    expect(description.countdownAt).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('counts down in the units that matter at each scale', () => {
    expect(formatCountdown(45 * 1000)).toBe('45s');
    expect(formatCountdown(4 * 60 * 1000 + 20 * 1000)).toBe('4m 20s');
    expect(formatCountdown(3 * 3600 * 1000 + 12 * 60 * 1000)).toBe('3h 12m');
    expect(formatCountdown(2 * 86_400 * 1000 + 6 * 3600 * 1000)).toBe('2d 6h');
  });

  it('says the window lapsed rather than rendering a zero', () => {
    // A decision made now still counts — it comes back with
    // `decidedAfterTimeout: true` — so "0s" would be both wrong and useless.
    expect(formatCountdown(0)).toBe('window lapsed');
    expect(formatCountdown(-5000)).toBe('window lapsed');
    expect(formatCountdown(Number.NaN)).toBe('window lapsed');
  });
});

describe('millisecondsUntil', () => {
  it('is positive before the instant and negative after it', () => {
    const now = new Date('2026-08-24T12:00:00.000Z');

    expect(millisecondsUntil('2026-08-24T12:01:00.000Z', now)).toBe(60_000);
    expect(millisecondsUntil('2026-08-24T11:59:00.000Z', now)).toBe(-60_000);
  });

  it('returns NaN for an unparseable instant rather than pretending it is now', () => {
    expect(millisecondsUntil('not-a-date')).toBeNaN();
  });
});

describe('formatDeadline', () => {
  it('renders an unparseable timestamp raw rather than as Invalid Date', () => {
    expect(formatDeadline('nonsense')).toBe('nonsense');
  });

  it('renders a real instant as something other than the raw ISO string', () => {
    expect(formatDeadline('2026-08-24T18:00:00.000Z')).not.toBe(
      '2026-08-24T18:00:00.000Z',
    );
  });
});
