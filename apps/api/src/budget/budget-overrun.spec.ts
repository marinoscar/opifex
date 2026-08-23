import { decideBudgetOverrun } from './budget-overrun';

/**
 * The budget overrun policy's boundary (#182).
 *
 * Small surface, and every one of its rules is a distinction that costs
 * something to get wrong: null is not zero, `<=` is not `<`, and "stopped" is
 * not "exceeded and finished anyway".
 */
describe('decideBudgetOverrun', () => {
  const inputs = (
    overrides: Partial<Parameters<typeof decideBudgetOverrun>[0]> = {},
  ) => ({
    costUsd: 10,
    ceilingUsd: 5,
    runIsLive: true,
    ...overrides,
  });

  describe('when there is nothing to judge', () => {
    it('is not over when nothing reported a cost', () => {
      // Null is UNKNOWN, not zero. A run that has told us nothing cannot have
      // passed a ceiling, and treating null as zero would make every silent
      // run look thrifty. The spend ledger counts these conservatively at the
      // order's ceiling (#177) -- a different question from this one.
      expect(decideBudgetOverrun(inputs({ costUsd: null })).over).toBe(false);
    });

    it('is not over when the order names no ceiling', () => {
      // Whether an order should be ALLOWED to name none is the admission
      // gate's question, asked before the run started.
      expect(decideBudgetOverrun(inputs({ ceilingUsd: null })).over).toBe(
        false,
      );
    });

    it('is not over when neither is known', () => {
      expect(
        decideBudgetOverrun(inputs({ costUsd: null, ceilingUsd: null })).over,
      ).toBe(false);
    });
  });

  describe('the boundary', () => {
    it('is not over below the ceiling', () => {
      expect(
        decideBudgetOverrun(inputs({ costUsd: 4.99, ceilingUsd: 5 })).over,
      ).toBe(false);
    });

    it('is not over AT the ceiling', () => {
      // A ceiling of $5 authorizes spending $5; it forbids spending FROM $5.
      // Same rule as the admission gate's projection check, and deliberately
      // the opposite of its tally check.
      expect(
        decideBudgetOverrun(inputs({ costUsd: 5, ceilingUsd: 5 })).over,
      ).toBe(false);
    });

    it('is over one cent past it', () => {
      const verdict = decideBudgetOverrun(
        inputs({ costUsd: 5.01, ceilingUsd: 5 }),
      );

      expect(verdict.over).toBe(true);
      expect(verdict.over === true && verdict.overspendUsd).toBe(0.01);
    });

    it('handles a zero ceiling, which means spend nothing', () => {
      // "$0" is an instruction, not an absence -- the same distinction
      // `parseHardCeiling` makes. Any reported spend passes it.
      expect(
        decideBudgetOverrun(inputs({ costUsd: 0.01, ceilingUsd: 0 })).over,
      ).toBe(true);
      expect(
        decideBudgetOverrun(inputs({ costUsd: 0, ceilingUsd: 0 })).over,
      ).toBe(false);
    });
  });

  describe('what it reports', () => {
    it('names both figures and the gap between them', () => {
      // #65's first acceptance criterion: the record names the figure that
      // triggered it. "Over budget" alone would send an operator to the
      // source to find out by how much.
      const verdict = decideBudgetOverrun(
        inputs({ costUsd: 40, ceilingUsd: 5 }),
      );

      expect(verdict.over === true && verdict.costUsd).toBe(40);
      expect(verdict.over === true && verdict.ceilingUsd).toBe(5);
      expect(verdict.over === true && verdict.overspendUsd).toBe(35);
      expect(verdict.over === true && verdict.reason).toBe(
        'Reported $40.00 against a budget ceiling of $5.00 — $35.00 over.',
      );
    });

    it('claims NOTHING about what was done about it', () => {
      // `run-deadline.ts` learned this the expensive way: its reason once
      // ended "so the control plane cancelled it" and printed exactly that
      // for three runs the control plane could not reach. This function runs
      // before anything is attempted and cannot know the outcome.
      const live = decideBudgetOverrun(inputs({ runIsLive: true }));
      const done = decideBudgetOverrun(inputs({ runIsLive: false }));

      for (const verdict of [live, done]) {
        const reason = verdict.over === true ? verdict.reason : '';
        expect(reason).not.toContain('cancel');
        expect(reason).not.toContain('control plane');
        expect(reason).not.toContain('stopped');
      }
    });

    it('carries whether anything can still be done, without changing the facts', () => {
      // Two different facts, and #66's retry decision reads them differently:
      // a run stopped for its budget and a run that quietly passed it predict
      // different things about the next attempt.
      const live = decideBudgetOverrun(inputs({ runIsLive: true }));
      const done = decideBudgetOverrun(inputs({ runIsLive: false }));

      expect(live.over === true && live.stoppable).toBe(true);
      expect(done.over === true && done.stoppable).toBe(false);
      // The overspend is the same either way — liveness changes what can be
      // done, never what happened.
      expect(live.over === true && live.reason).toBe(
        done.over === true && done.reason,
      );
    });

    it('rounds the overspend to cents rather than showing a float tail', () => {
      const verdict = decideBudgetOverrun(
        inputs({ costUsd: 0.3, ceilingUsd: 0.1 }),
      );

      expect(verdict.over === true && verdict.overspendUsd).toBe(0.2);
    });
  });
});
