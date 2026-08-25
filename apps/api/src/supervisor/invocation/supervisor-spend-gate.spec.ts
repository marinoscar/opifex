import type { HardCeiling } from '../../budget/hard-spend-ceiling';
import { assessSupervisorSpend, withTickSpend } from './supervisor-spend-gate';
import type { SupervisorSpendTally } from './supervisor-spend-ledger.service';

/**
 * The whole truth table of "may the supervisor spend anything" (#261,
 * ADR-0017).
 *
 * Pure, so every branch is reachable without a database, a clock or a Nest
 * container — and so the decision behind a `skipped_budget` row can be
 * reconstructed from the row.
 *
 * The reason strings are asserted, not just the verdicts. ADR-0016's context
 * describes `quota-gate.spec.ts` before it had a reason assertion: a plausible
 * sentence nobody could check against the fact it claimed. A refusal that does
 * not name its figures is one an operator has to read the source to trust.
 */
describe('assessSupervisorSpend (#261)', () => {
  const NOW = new Date('2026-08-25T12:00:00Z');

  const ceiling = (overrides: Partial<HardCeiling> = {}): HardCeiling => ({
    limitUsd: 5,
    windowDays: 1,
    malformed: null,
    ...overrides,
  });

  const tally = (
    overrides: Partial<SupervisorSpendTally> = {},
  ): SupervisorSpendTally => ({
    reportedUsd: 0,
    unpricedCalls: 0,
    invocations: 0,
    window: { from: new Date(NOW.getTime() - 86_400_000), to: NOW, days: 1 },
    ...overrides,
  });

  describe('when there is no usable ceiling', () => {
    it('refuses an unset ceiling rather than permitting unlimited spend', () => {
      // The point of the whole ADR. "Unset means unlimited" is #261 restated
      // as a default, not an answer to it — and ADR-0016 already removed the
      // only other thing that ever stood the supervisor down for a
      // spend-adjacent reason.
      const verdict = assessSupervisorSpend(
        ceiling({ limitUsd: null }),
        tally(),
      );

      expect(verdict.admit).toBe(false);
      expect(verdict).toMatchObject({
        refusal: 'no-supervisor-spend-ceiling-configured',
      });
      expect(verdict.reason).toContain('SUPERVISOR_HARD_SPEND_CEILING_USD');
      expect(verdict.reason).toContain('1d');
    });

    it('points at its OWN variable, not the dispatch one', () => {
      // A refusal that named OPIFEX_HARD_SPEND_CEILING_USD would send an
      // operator to set a value that would not change this outcome. The
      // reason mentions dispatch's ceiling only to say it is a different
      // thing.
      const verdict = assessSupervisorSpend(
        ceiling({ limitUsd: null }),
        tally(),
      );

      expect(verdict.reason).toContain('Set SUPERVISOR_HARD_SPEND_CEILING_USD');
      expect(verdict.reason).toContain('separate from');
    });

    it('refuses a malformed ceiling as its own case', () => {
      // Absence and a typo both refuse, so the reason text is the only thing
      // that can tell an operator which of the two they are in.
      const verdict = assessSupervisorSpend(
        ceiling({ limitUsd: null, malformed: '5O' }),
        tally(),
      );

      expect(verdict).toMatchObject({
        admit: false,
        refusal: 'no-supervisor-spend-ceiling-configured',
      });
      expect(verdict.reason).toContain('"5O"');
      expect(verdict.reason).toContain('not a non-negative number');
    });

    it('checks the ceiling before the tally, so a full window cannot mask a missing limit', () => {
      const verdict = assessSupervisorSpend(
        ceiling({ limitUsd: null }),
        tally({ reportedUsd: 900 }),
      );

      expect(verdict.reason).toContain('No supervisor spend ceiling');
    });
  });

  describe('when the window is at or over the ceiling', () => {
    it('refuses at exactly the limit, not only past it', () => {
      const verdict = assessSupervisorSpend(
        ceiling({ limitUsd: 5 }),
        tally({ reportedUsd: 5, invocations: 20 }),
      );

      expect(verdict).toMatchObject({
        admit: false,
        refusal: 'supervisor-spend-ceiling-reached',
      });
      expect(verdict.reason).toContain('$5.00');
      expect(verdict.reason).toContain('20 invocation(s)');
    });

    it('says the ceiling cannot be raised at runtime', () => {
      const verdict = assessSupervisorSpend(
        ceiling(),
        tally({ reportedUsd: 6 }),
      );

      expect(verdict.reason).toContain('cannot be raised at runtime');
    });

    it('refuses a ceiling of zero, which is an instruction and not an absence', () => {
      const verdict = assessSupervisorSpend(ceiling({ limitUsd: 0 }), tally());

      expect(verdict).toMatchObject({
        admit: false,
        refusal: 'supervisor-spend-ceiling-reached',
      });
    });
  });

  describe('when there is headroom', () => {
    it('admits and reports what is left', () => {
      const verdict = assessSupervisorSpend(
        ceiling({ limitUsd: 5 }),
        tally({ reportedUsd: 1.25, invocations: 3 }),
      );

      expect(verdict).toMatchObject({ admit: true, headroomUsd: 3.75 });
      expect(verdict.reason).toContain('$3.75 of headroom');
    });
  });

  describe('what an unpriced call does', () => {
    it('does not refuse on its own', () => {
      // Refusing here would turn an ordinary event — Anthropic ships a model,
      // the hand-maintained price table has not caught up — into an
      // indefinite outage of the whole supervisor, which is a worse failure
      // than an under-bounded floor.
      const verdict = assessSupervisorSpend(
        ceiling({ limitUsd: 5 }),
        tally({ reportedUsd: 0, unpricedCalls: 40 }),
      );

      expect(verdict.admit).toBe(true);
    });

    it('is never silent — the figure is labelled a floor', () => {
      // The one thing that must never be silent. A floor read as a total is
      // how a ceiling gets passed with nothing appearing to go wrong.
      const admitted = assessSupervisorSpend(
        ceiling({ limitUsd: 5 }),
        tally({ reportedUsd: 1, unpricedCalls: 2 }),
      );
      const refused = assessSupervisorSpend(
        ceiling({ limitUsd: 5 }),
        tally({ reportedUsd: 5, unpricedCalls: 2 }),
      );

      for (const verdict of [admitted, refused]) {
        expect(verdict.reason).toContain('2 model call(s)');
        expect(verdict.reason).toContain('floor, not a total');
      }
    });

    it('says nothing about a floor when everything priced', () => {
      const verdict = assessSupervisorSpend(
        ceiling(),
        tally({ reportedUsd: 1 }),
      );

      expect(verdict.reason).not.toContain('floor');
    });

    it('contributes nothing to the measured figure', () => {
      const withUnpriced = assessSupervisorSpend(
        ceiling({ limitUsd: 5 }),
        tally({ reportedUsd: 2, unpricedCalls: 9 }),
      );
      const without = assessSupervisorSpend(
        ceiling({ limitUsd: 5 }),
        tally({ reportedUsd: 2 }),
      );

      expect(withUnpriced).toMatchObject({ headroomUsd: 3 });
      expect(without).toMatchObject({ headroomUsd: 3 });
    });
  });

  describe('withTickSpend — the between-proposers figure', () => {
    it('adds what this tick has spent to what the window already held', () => {
      const combined = withTickSpend(tally({ reportedUsd: 4.9 }), 0.2, 0);

      expect(combined.reportedUsd).toBeCloseTo(5.1);
      expect(
        assessSupervisorSpend(ceiling({ limitUsd: 5 }), combined),
      ).toMatchObject({
        admit: false,
        refusal: 'supervisor-spend-ceiling-reached',
      });
    });

    it('carries this tick’s unpriced calls into the same floor', () => {
      const combined = withTickSpend(
        tally({ reportedUsd: 1, unpricedCalls: 1 }),
        0,
        2,
      );

      expect(combined.unpricedCalls).toBe(3);
    });

    it('leaves the window alone, so the reason still names the right period', () => {
      const combined = withTickSpend(tally(), 1, 0);

      expect(combined.window.days).toBe(1);
    });

    it('rounds to cents, so a float tail cannot drift the comparison', () => {
      const combined = withTickSpend(tally({ reportedUsd: 0.1 }), 0.2, 0);

      expect(combined.reportedUsd).toBe(0.3);
    });
  });
});
