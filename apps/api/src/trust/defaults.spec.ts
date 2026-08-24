import {
  DEFAULT_GRANT_BUDGET_CEILING_USD,
  DEFAULT_GRANT_EXPIRY_DAYS,
  DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
  DEFAULT_GRANT_MAX_FAILURE_RATE,
  DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
  defaultGrantAttributes,
} from './defaults';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('defaultGrantAttributes (VISION §8, #96)', () => {
  it('attaches all four attributes from nothing but a clock', () => {
    // VISION §8: "Always approve this class" — "the third option silently
    // attaches all four. Safe by construction, one tap." A one-tap approval
    // supplies no expiry, no ceiling and no thresholds, so if any of these
    // came back undefined the safe-by-construction claim would be false.
    const attributes = defaultGrantAttributes(NOW);

    expect(attributes).toEqual({
      expiresAt: new Date(NOW.getTime() + DEFAULT_GRANT_EXPIRY_DAYS * DAY_MS),
      budgetCeilingUsd: DEFAULT_GRANT_BUDGET_CEILING_USD,
      maxFailureRate: DEFAULT_GRANT_MAX_FAILURE_RATE,
      maxCostPerActionUsd: DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
      minActionsBeforeAutoRevoke: DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
    });
  });

  it('expires in 14 days — inside a sprint, not inside a quarter', () => {
    // The number is the mechanism. "Silence revokes" only revokes on a horizon
    // a human would notice; at 90 days the grant outlives the decision that
    // created it and the rule never fires.
    expect(DEFAULT_GRANT_EXPIRY_DAYS).toBe(14);
    expect(defaultGrantAttributes(NOW).expiresAt.getTime()).toBe(
      NOW.getTime() + 14 * DAY_MS,
    );
  });

  it('reads the clock from its argument, never from the environment', () => {
    // Same reason `budget-overrun.ts` and `run-deadline.ts` take their inputs:
    // a policy function that reads the clock cannot be pinned to its boundary.
    const earlier = new Date('2020-01-01T00:00:00.000Z');
    expect(defaultGrantAttributes(earlier).expiresAt.toISOString()).toBe(
      '2020-01-15T00:00:00.000Z',
    );
  });

  it('keeps every default inside the range create() will accept', () => {
    // The defaults and the validator must not be able to disagree: a default
    // that `create` rejects would make the one-tap path the only path that
    // fails.
    const a = defaultGrantAttributes(NOW);

    expect(a.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(a.budgetCeilingUsd).toBeGreaterThan(0);
    expect(a.maxFailureRate).toBeGreaterThanOrEqual(0);
    expect(a.maxFailureRate).toBeLessThanOrEqual(1);
    expect(a.maxCostPerActionUsd).toBeGreaterThan(0);
    expect(Number.isInteger(a.minActionsBeforeAutoRevoke)).toBe(true);
    expect(a.minActionsBeforeAutoRevoke).toBeGreaterThanOrEqual(1);
  });

  it('caps a single action well below the whole ceiling', () => {
    // The two budget rules are not redundant: the ceiling bounds TOTAL damage,
    // the per-action cap bounds the RATE at which it arrives. If the per-action
    // cap equalled the ceiling, one runaway action would pass the check exactly
    // once — after spending the entire grant.
    expect(DEFAULT_GRANT_MAX_COST_PER_ACTION_USD).toBeLessThan(
      DEFAULT_GRANT_BUDGET_CEILING_USD / 2,
    );
  });

  it('sets a failure threshold that is neither a coin flip nor a hair trigger', () => {
    // At 0.5 the grant survives a class that fails as often as it succeeds,
    // which is not trust. At 0.1 it dies on a bad afternoon and teaches the
    // operator that grants are flaky — and that operator grants blanket trust
    // next time, which is the failure VISION §8 exists to prevent.
    expect(DEFAULT_GRANT_MAX_FAILURE_RATE).toBeGreaterThan(0.2);
    expect(DEFAULT_GRANT_MAX_FAILURE_RATE).toBeLessThan(0.5);
  });
});
