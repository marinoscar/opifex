/**
 * The repository enablement ladder, as data (#350, epic #332).
 *
 * The module is pure so the cases that matter can be asserted without a React
 * tree: the ORDER (which is the whole reason these four flags are not a set),
 * a rung enabled with something below it off, and a budget ceiling at each
 * boundary the API enforces.
 *
 * Every assertion here is one a plausible implementation gets wrong. A ladder
 * that only checked the rung directly beneath would pass "dispatch on,
 * observe off" as long as spec feedback happened to be on; a ceiling parser
 * that treated an empty field as `0` would send a value the API rejects while
 * appearing to mean "spend nothing".
 */

import { describe, expect, it } from 'vitest';

import {
  BUDGET_CEILING_MAX_USD,
  LADDER_RUNGS,
  ceilingChanged,
  highestEnabledRung,
  ladderWarnings,
  parseBudgetCeiling,
  rungsBelow,
  warningsIntroducedBy,
  type LadderState,
} from '../../config/repositoryLadder';

function state(overrides: Partial<LadderState> = {}): LadderState {
  return {
    observeEnabled: false,
    mirrorLabelsEnabled: false,
    specFeedbackEnabled: false,
    dispatchEnabled: false,
    ...overrides,
  };
}

describe('LADDER_RUNGS', () => {
  it('is the DTO ladder, in the DTO order', () => {
    // repository.dto.ts documents these four as a progression: observe, then
    // write a label, then write prose to a human, then run. The order IS the
    // design, so it is pinned rather than assumed.
    expect(LADDER_RUNGS.map((rung) => rung.key)).toEqual([
      'observeEnabled',
      'mirrorLabelsEnabled',
      'specFeedbackEnabled',
      'dispatchEnabled',
    ]);
    expect(LADDER_RUNGS.map((rung) => rung.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it('points each rung at the one directly beneath it', () => {
    expect(LADDER_RUNGS.map((rung) => rung.requires)).toEqual([
      null,
      'observeEnabled',
      'mirrorLabelsEnabled',
      'specFeedbackEnabled',
    ]);
  });

  it('marks observation as the only rung that writes nothing', () => {
    // The distinction the operator is actually deciding on: rung 1 changes
    // nothing in their repository and every rung above it does.
    const writers = LADDER_RUNGS.filter((rung) => rung.writesToGitHub);
    expect(writers.map((rung) => rung.key)).toEqual([
      'mirrorLabelsEnabled',
      'specFeedbackEnabled',
      'dispatchEnabled',
    ]);
  });

  it('says what each rung permits, in a sentence', () => {
    for (const rung of LADDER_RUNGS) {
      expect(rung.permits.length, `${rung.key} permits`).toBeGreaterThan(40);
      expect(
        rung.separateBecause.length,
        `${rung.key} separateBecause`,
      ).toBeGreaterThan(40);
    }
  });
});

describe('rungsBelow', () => {
  it('returns every lower rung, lowest first', () => {
    expect(rungsBelow('dispatchEnabled').map((rung) => rung.key)).toEqual([
      'observeEnabled',
      'mirrorLabelsEnabled',
      'specFeedbackEnabled',
    ]);
  });

  it('returns nothing below the first rung', () => {
    expect(rungsBelow('observeEnabled')).toEqual([]);
  });
});

describe('ladderWarnings', () => {
  it('says nothing about a ladder climbed in order', () => {
    expect(
      ladderWarnings(
        state({ observeEnabled: true, mirrorLabelsEnabled: true }),
      ),
    ).toEqual([]);
  });

  it('says nothing about a repository with everything off', () => {
    expect(ladderWarnings(state())).toEqual([]);
  });

  it('flags dispatch enabled with observation off', () => {
    const warnings = ladderWarnings(state({ dispatchEnabled: true }));

    expect(warnings).toHaveLength(1);
    expect(warnings[0].rung.key).toBe('dispatchEnabled');
    expect(warnings[0].missing.map((rung) => rung.key)).toEqual([
      'observeEnabled',
      'mirrorLabelsEnabled',
      'specFeedbackEnabled',
    ]);
    expect(warnings[0].message).toContain('Dispatch is on with');
    expect(warnings[0].message).toContain('observe');
  });

  it('looks at ALL the rungs below, not only the next one down', () => {
    // The case a one-step check passes silently: dispatch's immediate
    // predecessor is on, and the repository is not being observed at all.
    const warnings = ladderWarnings(
      state({
        dispatchEnabled: true,
        specFeedbackEnabled: true,
        mirrorLabelsEnabled: true,
      }),
    );

    expect(warnings.map((warning) => warning.rung.key)).toEqual([
      'mirrorLabelsEnabled',
      'specFeedbackEnabled',
      'dispatchEnabled',
    ]);
    expect(warnings[2].missing.map((rung) => rung.key)).toEqual([
      'observeEnabled',
    ]);
  });
});

describe('warningsIntroducedBy', () => {
  it('warns about a rung this save turns on', () => {
    const warnings = warningsIntroducedBy(
      state({ observeEnabled: true }),
      state({ observeEnabled: true, dispatchEnabled: true }),
    );

    expect(warnings.map((warning) => warning.rung.key)).toEqual([
      'dispatchEnabled',
    ]);
  });

  it('stays silent when a save leaves an existing out-of-order state alone', () => {
    // A repository already enabled out of order by a curl call should not
    // re-prompt every time the operator edits a budget. A dialog that fires on
    // every save is one that stops being read.
    const stored = state({ dispatchEnabled: true });
    expect(warningsIntroducedBy(stored, stored)).toEqual([]);
  });

  it('stays silent when a save FIXES the order', () => {
    const warnings = warningsIntroducedBy(
      state({ dispatchEnabled: true }),
      state({
        dispatchEnabled: true,
        observeEnabled: true,
        mirrorLabelsEnabled: true,
        specFeedbackEnabled: true,
      }),
    );

    expect(warnings).toEqual([]);
  });
});

describe('highestEnabledRung', () => {
  it('is null when nothing is enabled', () => {
    expect(highestEnabledRung(state())).toBeNull();
  });

  it('is the topmost enabled rung, not the last one flipped', () => {
    expect(
      highestEnabledRung(state({ observeEnabled: true, dispatchEnabled: true }))
        ?.key,
    ).toBe('dispatchEnabled');
  });
});

describe('parseBudgetCeiling', () => {
  it('reads an empty field as CLEAR, not as zero', () => {
    // The distinction that matters on the wire: null removes the ceiling, and
    // 0 is a value the API rejects outright.
    expect(parseBudgetCeiling('')).toEqual({ ok: true, value: null });
    expect(parseBudgetCeiling('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts a decimal amount', () => {
    expect(parseBudgetCeiling('12.50')).toEqual({ ok: true, value: 12.5 });
  });

  it('refuses zero and negatives, and says to clear instead', () => {
    const zero = parseBudgetCeiling('0');
    expect(zero.ok).toBe(false);
    expect(zero.ok === false && zero.error).toMatch(/clear the field/i);
    expect(parseBudgetCeiling('-5').ok).toBe(false);
  });

  it('refuses anything that is not a number', () => {
    expect(parseBudgetCeiling('ten dollars').ok).toBe(false);
  });

  it('enforces the same maximum the API does', () => {
    expect(parseBudgetCeiling(String(BUDGET_CEILING_MAX_USD)).ok).toBe(true);
    expect(parseBudgetCeiling(String(BUDGET_CEILING_MAX_USD + 1)).ok).toBe(
      false,
    );
  });
});

describe('ceilingChanged', () => {
  it('treats the stored decimal string and the same number as unchanged', () => {
    // The API returns `budgetCeilingUsd` as a string because the column is a
    // Postgres DECIMAL. '50.00' and 50 are the same ceiling, and a naive
    // comparison would PATCH on every save.
    expect(ceilingChanged('50.00', 50)).toBe(false);
  });

  it('sees setting a ceiling where there was none', () => {
    expect(ceilingChanged(null, 25)).toBe(true);
  });

  it('sees clearing a ceiling', () => {
    expect(ceilingChanged('25', null)).toBe(true);
  });

  it('sees nothing in clearing a ceiling that was never set', () => {
    expect(ceilingChanged(null, null)).toBe(false);
  });
});
