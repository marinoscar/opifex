import { describe, expect, it } from 'vitest';

import {
  ceilingUsedPercent,
  floorCaveat,
  money,
  preciseMoney,
} from '../../../components/cost/costFormat';

/**
 * The cost screen's honesty argument, asserted (#213).
 *
 * VISION §10 makes cost per merged PR success metric 5, and #86 is emphatic
 * that an estimate presented as a measurement would make it untrustworthy
 * exactly where it matters.
 */

describe('money', () => {
  it('keeps "nothing reported" distinct from "nothing spent"', () => {
    // VISION §6 makes cost reporting a declared capability. A window in which
    // no runner reported must not render as one in which nothing was spent.
    expect(money(null)).toBe('—');
    expect(money(0)).toBe('$0.00');
  });

  it('renders two places for headline figures', () => {
    expect(money(12.3456)).toBe('$12.35');
  });

  it('renders four where two would round to nothing', () => {
    expect(preciseMoney(0.0042)).toBe('$0.0042');
    expect(preciseMoney(null)).toBe('—');
  });
});

describe('floorCaveat', () => {
  it('says nothing when every run reported', () => {
    expect(floorCaveat({ runsWithoutCost: 0, unboundedRuns: 0 })).toBeNull();
  });

  it('names the estimate when runs had a ceiling to bound them', () => {
    const caveat = floorCaveat({ runsWithoutCost: 3, unboundedRuns: 0 });
    expect(caveat).toContain('estimate');
    expect(caveat).toContain('3 run(s)');
  });

  it('calls it a floor when runs had no ceiling at all', () => {
    // The stronger caveat wins: an unbounded run means the total below it
    // could be arbitrarily wrong, which is a different claim than "some of
    // this is estimated".
    const caveat = floorCaveat({ runsWithoutCost: 3, unboundedRuns: 1 });
    expect(caveat).toContain('floor');
    expect(caveat).toContain('no ceiling');
  });
});

describe('ceilingUsedPercent', () => {
  it('is null when no ceiling is configured', () => {
    // Null rather than 0: a missing ceiling REFUSES dispatch rather than
    // permitting it, so an empty bar would say the opposite of what it means.
    expect(ceilingUsedPercent(null, 10)).toBeNull();
  });

  it('is null for a nonsensical ceiling rather than dividing by zero', () => {
    expect(ceilingUsedPercent(0, 10)).toBeNull();
  });

  it('computes the share of the ceiling used', () => {
    expect(ceilingUsedPercent(100, 25)).toBe(25);
  });

  it('clamps at 100 rather than drawing a bar past its own end', () => {
    expect(ceilingUsedPercent(100, 250)).toBe(100);
  });
});
