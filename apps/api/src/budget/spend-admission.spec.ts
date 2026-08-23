import type { HardCeiling } from './hard-spend-ceiling';
import { decideSpendAdmission, type OrderBudget } from './spend-admission';
import type { SpendTally } from './spend-ledger.service';

/**
 * The gate's whole truth table (#65).
 *
 * A pure function, so this is exhaustive rather than representative — every
 * branch, and every boundary, with no database and no clock. That is the point
 * of having extracted it: enforcement lives in deterministic policy (VISION
 * §3.6), and deterministic policy can be pinned to its edges.
 */
describe('decideSpendAdmission', () => {
  const ceiling = (limitUsd: number | null, malformed: string | null = null): HardCeiling => ({
    limitUsd,
    windowDays: 30,
    malformed,
  });

  const tally = (overrides: Partial<SpendTally> = {}): SpendTally => ({
    reportedUsd: 0,
    estimatedUsd: 0,
    totalUsd: 0,
    runs: 0,
    runsWithoutCost: 0,
    unboundedRuns: 0,
    window: { from: new Date(0), to: new Date(0), days: 30 },
    ...overrides,
  });

  const order = (overrides: Partial<OrderBudget> = {}): OrderBudget => ({
    ceilingUsd: 5,
    runnerReportsCost: true,
    ...overrides,
  });

  describe('no usable ceiling', () => {
    it('refuses when none is configured', () => {
      const verdict = decideSpendAdmission(ceiling(null), tally(), order());

      expect(verdict.admit).toBe(false);
      expect(verdict.admit === false && verdict.refusal).toBe('no-hard-spend-ceiling-configured');
      expect(verdict.reason).toContain('OPIFEX_HARD_SPEND_CEILING_USD');
    });

    it('refuses when it is malformed, and quotes what was typed', () => {
      // The operator has to be able to see their own typo in the message,
      // otherwise "no ceiling configured" sends them looking for an unset
      // variable that is in fact set.
      const verdict = decideSpendAdmission(ceiling(null, '5O'), tally(), order());

      expect(verdict.admit).toBe(false);
      expect(verdict.reason).toContain('"5O"');
    });

    it('refuses before considering anything about the order', () => {
      // Including an order that could never be budgeted. Without a ceiling
      // there is nothing to budget against, and reporting the order's problem
      // would send the operator to fix the wrong thing.
      const verdict = decideSpendAdmission(
        ceiling(null),
        tally(),
        order({ ceilingUsd: null, runnerReportsCost: false }),
      );

      expect(verdict.admit === false && verdict.refusal).toBe('no-hard-spend-ceiling-configured');
    });
  });

  describe('the ceiling itself', () => {
    it('admits with headroom to spare', () => {
      const verdict = decideSpendAdmission(ceiling(100), tally({ totalUsd: 10 }), order());

      expect(verdict.admit).toBe(true);
      expect(verdict.admit === true && verdict.headroomUsd).toBe(90);
    });

    it('refuses at exactly the ceiling, not just past it', () => {
      // The boundary is the whole point of a hard ceiling: "at most $50"
      // means $50 is not available to spend again.
      const verdict = decideSpendAdmission(ceiling(50), tally({ totalUsd: 50 }), order());

      expect(verdict.admit === false && verdict.refusal).toBe('hard-spend-ceiling-reached');
    });

    it('refuses a projected overshoot, using what the order MIGHT spend', () => {
      // $47 spent, $10 authorized, $50 ceiling. The order will probably not
      // spend its whole ceiling -- and a hard limit has to reason about the
      // worst case anyway, or it is a soft one.
      const verdict = decideSpendAdmission(
        ceiling(50),
        tally({ totalUsd: 47, reportedUsd: 47 }),
        order({ ceilingUsd: 10 }),
      );

      expect(verdict.admit).toBe(false);
      expect(verdict.reason).toContain('$57.00');
      expect(verdict.reason).toContain('$50.00');
    });

    it('admits when the projection lands exactly on the ceiling', () => {
      // `>` not `>=` here, unlike the tally check: spending UP TO the ceiling
      // is what the ceiling permits. Spending FROM it is what it forbids.
      const verdict = decideSpendAdmission(
        ceiling(50),
        tally({ totalUsd: 40 }),
        order({ ceilingUsd: 10 }),
      );

      expect(verdict.admit).toBe(true);
    });

    it('refuses everything when the ceiling is zero', () => {
      const verdict = decideSpendAdmission(ceiling(0), tally(), order());

      expect(verdict.admit === false && verdict.refusal).toBe('hard-spend-ceiling-reached');
    });
  });

  describe('an order that cannot be budgeted', () => {
    it('refuses when it names no ceiling and its runner reports no cost', () => {
      // Nothing downstream could ever stop this run: there is no authorized
      // figure to project with and no reported figure to compare against.
      const verdict = decideSpendAdmission(
        ceiling(100),
        tally(),
        order({ ceilingUsd: null, runnerReportsCost: false }),
      );

      expect(verdict.admit).toBe(false);
      expect(verdict.admit === false && verdict.refusal).toBe('work-order-cannot-be-budgeted');
      expect(verdict.reason).toContain('budgetCeilingUsd');
    });

    it('admits when it names no ceiling but its runner does report cost', () => {
      // The documented gap. It is admitted on headroom alone and bounded only
      // after the fact, and the reason line says exactly that rather than
      // implying the order was checked against a limit it does not have.
      const verdict = decideSpendAdmission(
        ceiling(100),
        tally({ totalUsd: 10 }),
        order({ ceilingUsd: null, runnerReportsCost: true }),
      );

      expect(verdict.admit).toBe(true);
      expect(verdict.reason).toContain('names no ceiling of its own');
    });

    it('still refuses an unbudgetable order once the ceiling is reached', () => {
      const verdict = decideSpendAdmission(
        ceiling(50),
        tally({ totalUsd: 50 }),
        order({ ceilingUsd: null, runnerReportsCost: false }),
      );

      expect(verdict.admit === false && verdict.refusal).toBe('hard-spend-ceiling-reached');
    });
  });

  describe('what the reason says about the figure', () => {
    it('calls a clean measurement reported', () => {
      const verdict = decideSpendAdmission(ceiling(100), tally({ totalUsd: 10, reportedUsd: 10 }), order());

      expect(verdict.reason).toContain('spent $10.00 reported');
    });

    it('separates the estimated part from the measured part', () => {
      // #65's fourth acceptance criterion. An estimate folded into the same
      // figure as a measurement is indistinguishable one call later.
      const verdict = decideSpendAdmission(
        ceiling(100),
        tally({ totalUsd: 30, reportedUsd: 10, estimatedUsd: 20, runsWithoutCost: 4 }),
        order(),
      );

      expect(verdict.reason).toContain('at most $30.00');
      expect(verdict.reason).toContain('$10.00 reported');
      expect(verdict.reason).toContain('$20.00 estimated');
      expect(verdict.reason).toContain('4 run(s)');
    });

    it('says the figure is a floor when some runs cannot be bounded at all', () => {
      // The one thing that must never be silent: a floor read as a total is
      // how a ceiling gets passed with nothing appearing to go wrong.
      const verdict = decideSpendAdmission(
        ceiling(100),
        tally({ totalUsd: 10, reportedUsd: 10, runsWithoutCost: 3, unboundedRuns: 3 }),
        order(),
      );

      expect(verdict.reason).toContain('a floor, not a total');
      expect(verdict.reason).toContain('3 run(s)');
    });

    it('says the ceiling cannot be raised, on every refusal that is about money', () => {
      // The operator's next move on hitting a limit is to look for the knob.
      // The message has to answer that before they go looking.
      const verdict = decideSpendAdmission(ceiling(10), tally({ totalUsd: 10 }), order());

      expect(verdict.reason).toContain('cannot be raised at runtime');
    });
  });
});
