import { evaluateAutoRevoke, type AutoRevokeInputs } from './auto-revoke';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const FUTURE = new Date('2026-09-07T12:00:00.000Z');

function grant(overrides: Partial<AutoRevokeInputs> = {}): AutoRevokeInputs {
  return {
    spentUsd: 0,
    budgetCeilingUsd: 25,
    actionsAuthorized: 0,
    actionsFailed: 0,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    minActionsBeforeAutoRevoke: 3,
    expiresAt: FUTURE,
    ...overrides,
  };
}

describe('evaluateAutoRevoke (VISION §8, #96)', () => {
  it('keeps authorizing a healthy grant', () => {
    expect(
      evaluateAutoRevoke(
        grant({ spentUsd: 4, actionsAuthorized: 4, actionsFailed: 1 }),
        NOW,
      ),
    ).toBeNull();
  });

  describe('rule 1 — the budget ceiling', () => {
    it('fires when cumulative spend reaches the ceiling', () => {
      const verdict = evaluateAutoRevoke(
        grant({ spentUsd: 25, actionsAuthorized: 6 }),
        NOW,
      );

      expect(verdict?.reason).toBe('budget_exhausted');
    });

    it('fires ON THE FIRST ACTION, ignoring the sample-size floor', () => {
      // A ceiling is an absolute, not an estimate — it is a ceiling on the
      // first action exactly as much as on the tenth. VISION §8: "the grant
      // dies at a cumulative spend", with no qualifier about how many actions
      // produced it. Gating this on `minActionsBeforeAutoRevoke` would mean a
      // single action that spent the entire budget kept the grant alive on the
      // grounds that we had not seen enough of them.
      const verdict = evaluateAutoRevoke(
        grant({
          spentUsd: 30,
          budgetCeilingUsd: 25,
          actionsAuthorized: 1,
          minActionsBeforeAutoRevoke: 3,
        }),
        NOW,
      );

      expect(verdict?.reason).toBe('budget_exhausted');
    });

    it('wins over a failure-rate breach that is also true', () => {
      // First match wins, and the ceiling is the harder, more absolute fact.
      const verdict = evaluateAutoRevoke(
        grant({
          spentUsd: 25,
          actionsAuthorized: 10,
          actionsFailed: 9,
        }),
        NOW,
      );

      expect(verdict?.reason).toBe('budget_exhausted');
    });
  });

  describe('rule 2 — the failure rate', () => {
    it('fires once the sample is large enough and the rate is over', () => {
      const verdict = evaluateAutoRevoke(
        grant({ actionsAuthorized: 9, actionsFailed: 4, spentUsd: 1 }),
        NOW,
      );

      expect(verdict?.reason).toBe('failure_rate_exceeded');
      // "and explains why" is the requirement, not a nicety — #96: a grant
      // that vanishes silently teaches the operator the system is
      // unpredictable.
      expect(verdict?.detail).toContain('4 of 9');
      expect(verdict?.detail).toContain('44%');
      expect(verdict?.detail).toContain('34%');
    });

    it('does NOT fire below the sample-size floor, even at 100% failure', () => {
      // One failed action is a 100% observed failure rate on a sample of one.
      // Auto-revoking there would kill nearly every grant before it produced
      // the evidence #99's promotion ladder is asking for.
      expect(
        evaluateAutoRevoke(
          grant({
            actionsAuthorized: 2,
            actionsFailed: 2,
            minActionsBeforeAutoRevoke: 3,
            spentUsd: 0.5,
          }),
          NOW,
        ),
      ).toBeNull();
    });

    it('does not fire when the rate merely equals the threshold', () => {
      // `>`, not `>=`: a 34% threshold permits 34%.
      expect(
        evaluateAutoRevoke(
          grant({
            actionsAuthorized: 50,
            actionsFailed: 17,
            maxFailureRate: 0.34,
            spentUsd: 1,
          }),
          NOW,
        ),
      ).toBeNull();
    });
  });

  describe('rule 3 — the average cost per action', () => {
    it('fires once the sample is large enough and the average is over', () => {
      const verdict = evaluateAutoRevoke(
        grant({
          spentUsd: 24,
          budgetCeilingUsd: 100,
          actionsAuthorized: 4,
          maxCostPerActionUsd: 5,
        }),
        NOW,
      );

      expect(verdict?.reason).toBe('cost_per_action_exceeded');
      expect(verdict?.detail).toContain('$6.00');
      expect(verdict?.detail).toContain('$5.00');
    });

    it('does NOT fire below the sample-size floor', () => {
      // One expensive action is an observation, not a trend. The ceiling is
      // what stops a single runaway action from mattering while we wait.
      expect(
        evaluateAutoRevoke(
          grant({
            spentUsd: 20,
            budgetCeilingUsd: 100,
            actionsAuthorized: 2,
            minActionsBeforeAutoRevoke: 3,
            maxCostPerActionUsd: 5,
          }),
          NOW,
        ),
      ).toBeNull();
    });
  });

  it('declines to judge a grant whose expiry has already passed', () => {
    // It is already dead and `authorize` already refuses it. Writing a rate
    // breach onto it would overwrite the true cause of death — `expired`,
    // VISION §8's "silence revokes" — with something that was never what
    // stopped it. The audit trail is the product here.
    expect(
      evaluateAutoRevoke(
        grant({
          expiresAt: new Date(NOW.getTime() - 1),
          spentUsd: 999,
          actionsAuthorized: 10,
          actionsFailed: 10,
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it('names at least one number in every detail it produces', () => {
    // #47's house rule: the reason is not a log message. A suspension a human
    // cannot evaluate is indistinguishable from an arbitrary one.
    const verdicts = [
      evaluateAutoRevoke(grant({ spentUsd: 25, actionsAuthorized: 1 }), NOW),
      evaluateAutoRevoke(
        grant({ actionsAuthorized: 9, actionsFailed: 4, spentUsd: 1 }),
        NOW,
      ),
      evaluateAutoRevoke(
        grant({
          spentUsd: 24,
          budgetCeilingUsd: 100,
          actionsAuthorized: 4,
        }),
        NOW,
      ),
    ];

    expect(verdicts.every((v) => v !== null)).toBe(true);
    for (const verdict of verdicts) {
      expect(verdict!.detail).toMatch(/\d/);
    }
  });
});
