import { describe, it, expect } from 'vitest';

import {
  NO_DATA,
  NO_EVIDENCE,
  describeAutoRevoke,
  describeExpiry,
  describeHeadroomWarning,
  formatApprovalRate,
  formatDuration,
  formatFailureRate,
  formatHoldEnd,
  formatPercent,
  formatUsd,
  isHoldStanding,
  needsAttention,
} from '../../../components/trust/trustFormat';
import type { TrustGrant } from '../../../types/trust';

/**
 * The three distinctions a component would otherwise get subtly wrong (#101).
 *
 * Tested as pure functions because each one reverses the operator's conclusion
 * when it is wrong, and none of them is visible in a snapshot.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function grant(overrides: Partial<TrustGrant> = {}): TrustGrant {
  return {
    id: 'g-1',
    actionClass: 're-dispatch',
    repositoryId: 'acme/api',
    expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
    budgetCeilingUsd: 25,
    spentUsd: 3,
    actionsAuthorized: 0,
    actionsFailed: 0,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    minActionsBeforeAutoRevoke: 3,
    status: 'active',
    endedAt: null,
    endReason: null,
    endDetail: null,
    revokedById: null,
    note: null,
    grantedById: 'u-1',
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    remainingBudgetUsd: 22,
    budgetHeadroomFraction: 0.88,
    msUntilExpiry: 5 * DAY,
    failureRate: null,
    nearExpiry: false,
    nearBudget: false,
    ...overrides,
  };
}

describe('formatFailureRate', () => {
  it('renders null as no-data, NOT as 0%', () => {
    // Null means no actions have run. Zero means actions ran and all of them
    // succeeded. Rendering the first as the second tells the operator the
    // grant is behaving perfectly when it has never been used.
    expect(formatFailureRate(null)).toBe(NO_DATA);
    expect(formatFailureRate(null)).not.toContain('%');
  });

  it('renders a genuine zero as 0%', () => {
    expect(formatFailureRate(0)).toBe('0%');
  });

  it('renders a real rate as a whole-number percentage', () => {
    expect(formatFailureRate(0.125)).toBe('13%');
    expect(formatFailureRate(1)).toBe('100%');
  });
});

describe('formatApprovalRate', () => {
  it('renders null as no-evidence, NOT as 0%', () => {
    // The stakes are higher than on a failure rate: a 0% APPROVAL rate says
    // humans refuse this class every single time they see it.
    expect(formatApprovalRate(null)).toBe(NO_EVIDENCE);
    expect(formatApprovalRate(null)).not.toContain('%');
  });

  it('renders a genuine zero as 0%', () => {
    expect(formatApprovalRate(0)).toBe('0%');
  });

  it('renders a real rate', () => {
    expect(formatApprovalRate(0.923)).toBe('92%');
  });

  it('uses different wording from the failure rate', () => {
    // On the ladder the absent sample IS the story — an `observe` class is
    // defined by having none — so the string says which kind of nothing it is.
    expect(NO_EVIDENCE).not.toBe(NO_DATA);
  });
});

describe('describeExpiry', () => {
  it('reads a NEGATIVE msUntilExpiry as lapsed, never as time remaining', () => {
    // The single most dangerous string this screen could print. Formatting a
    // negative duration with `Math.abs` — the reflex — turns "expired 3 hours
    // ago" into "expires in 3 hours".
    const lapsed = describeExpiry(-3 * HOUR);
    expect(lapsed.lapsed).toBe(true);
    expect(lapsed.text).toBe('Lapsed 3h ago');
    expect(lapsed.text).not.toContain('Expires');
  });

  it('reads a positive msUntilExpiry as time remaining', () => {
    const live = describeExpiry(4 * HOUR);
    expect(live.lapsed).toBe(false);
    expect(live.text).toBe('Expires in 4h');
  });

  it('treats exactly zero as lapsed', () => {
    // "Expires in 0ms" is a countdown that will never tick. At the boundary
    // the safe reading is that authority is over.
    expect(describeExpiry(0).lapsed).toBe(true);
  });
});

describe('formatDuration', () => {
  it('uses the compact forms the rest of the app uses', () => {
    expect(formatDuration(30_000)).toBe('less than a minute');
    expect(formatDuration(5 * 60_000)).toBe('5m');
    expect(formatDuration(4 * HOUR)).toBe('4h');
    expect(formatDuration(3 * DAY)).toBe('3d');
  });

  it('never returns a negative span', () => {
    expect(formatDuration(-HOUR)).toBe('less than a minute');
  });
});

describe('describeHeadroomWarning', () => {
  it('is silent on a healthy grant', () => {
    expect(describeHeadroomWarning(grant())).toBeNull();
  });

  it('reads the SERVER flags rather than recomputing a threshold', () => {
    // The proof that no threshold is re-derived here: this grant has five
    // days and 88% headroom, and it warns purely because the server said so.
    expect(describeHeadroomWarning(grant({ nearExpiry: true }))).toBe(
      'Expires in 5d',
    );
    expect(describeHeadroomWarning(grant({ nearBudget: true }))).toBe(
      '$22.00 of $25.00 left',
    );
  });

  it('reports BOTH when both are set', () => {
    // Telling an operator about the expiry while dropping the exhausted
    // ceiling would have them renew into a wall.
    expect(
      describeHeadroomWarning(grant({ nearExpiry: true, nearBudget: true })),
    ).toBe('Expires in 5d · $22.00 of $25.00 left');
  });

  it('is silent on an ended grant whatever its flags say', () => {
    // An ended grant authorizes nothing; amber over it is noise on the one
    // screen whose job is to make the live warnings stand out.
    for (const status of ['expired', 'revoked', 'suspended'] as const) {
      expect(
        describeHeadroomWarning(
          grant({ status, nearExpiry: true, nearBudget: true }),
        ),
      ).toBeNull();
      expect(
        needsAttention(grant({ status, nearExpiry: true, nearBudget: true })),
      ).toBe(false);
    }
  });
});

describe('needsAttention', () => {
  it('is true for an active grant with either flag, and false otherwise', () => {
    expect(needsAttention(grant())).toBe(false);
    expect(needsAttention(grant({ nearExpiry: true }))).toBe(true);
    expect(needsAttention(grant({ nearBudget: true }))).toBe(true);
  });
});

describe('describeAutoRevoke', () => {
  it('names the sample floor alongside the rate ceiling', () => {
    // A grant at 100% failure over one action has tripped NOTHING. Showing the
    // rate ceiling without the floor makes the mechanism look broken.
    expect(describeAutoRevoke(grant())).toBe(
      'Revokes itself above 34% failures (once 3 actions have run), or if one action costs more than $5.00.',
    );
  });
});

describe('formatPercent and formatUsd', () => {
  it('rounds percentages to whole numbers', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.1667)).toBe('17%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('always renders two decimal places of money', () => {
    // A grant has a real ceiling, not "about $25".
    expect(formatUsd(25)).toBe('$25.00');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(2.5)).toBe('$2.50');
  });
});

// ---------------------------------------------------------------------------
// The manual-demotion hold (#244)
// ---------------------------------------------------------------------------

describe('formatHoldEnd', () => {
  it('renders an ABSOLUTE instant, not a countdown', () => {
    const iso = '2026-09-06T10:30:00.000Z';
    // Locale-dependent by design, so the assertion is about SHAPE: the date
    // this class comes back is something an operator puts in their week, and
    // "in 14d" — the reflex, and what `describeExpiry` correctly does for a
    // grant — cannot be checked against the instant the API states beside it.
    const text = formatHoldEnd(iso);

    expect(text).not.toMatch(/Invalid Date/);
    expect(text).not.toMatch(/^in /);
    expect(text).not.toMatch(/ago/);
    expect(text).toContain('2026');
    expect(text).toBe(
      new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    );
  });

  it('returns an unparseable value RAW rather than "Invalid Date"', () => {
    // The operator can still act on the string, and nobody can mistake it for
    // a real instant.
    expect(formatHoldEnd('not-a-date')).toBe('not-a-date');
  });
});

describe('isHoldStanding', () => {
  const now = new Date('2026-09-01T00:00:00.000Z');

  it('is true only while the end date is still ahead', () => {
    expect(isHoldStanding('2026-09-06T00:00:00.000Z', now)).toBe(true);
  });

  it('is false once the hold has lapsed, because the column is never cleared', () => {
    // A PAST `manualHoldUntil` is the ordinary resting state of any class that
    // was ever hand-demoted. Treating non-null as "held" would put a standing
    // hold on a class the ladder has had back for a month.
    expect(isHoldStanding('2026-08-01T00:00:00.000Z', now)).toBe(false);
  });

  it('treats an end date of exactly now as lapsed, matching the API', () => {
    expect(isHoldStanding(now.toISOString(), now)).toBe(false);
  });

  it('is false for a class that was never held, or for a broken value', () => {
    expect(isHoldStanding(null, now)).toBe(false);
    expect(isHoldStanding(undefined, now)).toBe(false);
    expect(isHoldStanding('not-a-date', now)).toBe(false);
  });
});
