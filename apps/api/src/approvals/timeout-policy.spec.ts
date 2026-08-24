import {
  ACTION_CLASSES,
  type ActionClassId,
} from '../supervisor/action-classes';
import {
  resolveTimeoutPolicy,
  timeoutAtFor,
  TIMEOUT_WINDOW_MS,
  type TimeoutPolicy,
} from './timeout-policy';

const NOW = new Date('2026-08-24T12:00:00.000Z');

/**
 * The three classes ADR-0014 names as the only ones that auto-approve.
 *
 * Written out as a literal rather than derived from the registry, on purpose.
 * A derived expectation would recompute the same rule the code under test
 * applies and agree with it by construction — including when both are wrong.
 * This list is ADR-0014's claim, quoted: "Auto-approve-on-timeout applies only
 * to `run-diagnosis`, `spec-quality-feedback`, and `daily-brief` — the three
 * that change nothing outside the decision log."
 */
const ONLY_AUTO_APPROVED: readonly ActionClassId[] = [
  'run-diagnosis',
  'spec-quality-feedback',
  'daily-brief',
];

describe('resolveTimeoutPolicy (ADR-0014)', () => {
  describe('the total order, over every registered class', () => {
    it.each(ACTION_CLASSES.map((c) => [c.id, c] as const))(
      '%s resolves by first match wins',
      (_id, actionClass) => {
        const policy = resolveTimeoutPolicy(actionClass.id);

        // The order re-stated independently of the implementation, so this
        // fails if the implementation reorders its branches rather than
        // agreeing with itself.
        let expected: TimeoutPolicy;
        if (actionClass.reversibility === 'irreversible') {
          expected = 'park_and_escalate';
        } else if (actionClass.spendsMoney) {
          expected = 'deny';
        } else if (actionClass.reversibility === 'reversible-with-effort') {
          expected = 'deny';
        } else {
          expected = 'auto_approve';
        }

        expect(policy).toBe(expected);
      },
    );

    /**
     * ADR-0014's central claim, and the test that should fail the day somebody
     * flips a `spendsMoney` flag or reclassifies a reversibility.
     *
     * If this goes red, the right response is almost never to update the
     * expectation. It means a class that previously required a human (or a
     * grant) now runs on silence, which is the safety property ADR-0014 exists
     * to state — and the ADR's consequences section would need rewriting
     * before the list here does.
     */
    it('auto-approves ONLY the three classes that change nothing outside the decision log', () => {
      const autoApproved = ACTION_CLASSES.filter(
        (c) => resolveTimeoutPolicy(c.id) === 'auto_approve',
      ).map((c) => c.id);

      expect(autoApproved.sort()).toEqual([...ONLY_AUTO_APPROVED].sort());
    });

    it('holds because those three neither spend money nor need effort to undo', () => {
      // The reason the set above is what it is, asserted separately so a
      // failure says WHICH property moved rather than only that the set did.
      for (const id of ONLY_AUTO_APPROVED) {
        const entry = ACTION_CLASSES.find((c) => c.id === id);
        expect(entry).toBeDefined();
        expect(entry?.spendsMoney).toBe(false);
        expect(entry?.reversibility).toBe('reversible');
      }
    });

    /**
     * ADR-0014's headline consequence: the timeout is not the autonomy
     * mechanism, the grant is. Stated as a test because the ADR predicts
     * someone will "fix" the timeout policy to make autonomy work.
     */
    it('denies every autonomy-eligible class with a real effect', () => {
      const withRealEffects = ACTION_CLASSES.filter(
        (c) => c.autonomyEligible && c.spendsMoney,
      );

      expect(withRealEffects.map((c) => c.id).sort()).toEqual([
        'decomposition',
        'issue-shaping',
        're-dispatch',
      ]);

      for (const entry of withRealEffects) {
        expect(resolveTimeoutPolicy(entry.id)).toBe('deny');
      }
    });
  });

  describe('an unrecognised class', () => {
    it.each([
      'not-a-class',
      'RunDiagnosis',
      'run_diagnosis',
      'run-diagnosis ',
      '',
    ])('parks rather than auto-approving: %p', (unknown) => {
      // The asymmetry that matters: a typo in a class name must not be an
      // auto-approval path. Asserted as both the positive and the negative,
      // because "not auto_approve" alone would pass for a policy of `deny`,
      // which would close the case silently.
      expect(resolveTimeoutPolicy(unknown)).toBe('park_and_escalate');
      expect(resolveTimeoutPolicy(unknown)).not.toBe('auto_approve');
    });
  });
});

describe('timeoutAtFor', () => {
  /**
   * The null IS the never-auto-approve guarantee (VISION §8, ADR-0014 rule 1).
   *
   * Not "a long timeout" and not "a timeout far in the future": no timestamp
   * at all, so no sweeper query can select the row and no bug iterating
   * "everything with a due timeout" can include it by accident.
   */
  it('returns null for park_and_escalate — there is no timer', () => {
    expect(timeoutAtFor('park_and_escalate', NOW)).toBeNull();
  });

  it('returns now plus the window for the two policies that resolve', () => {
    expect(timeoutAtFor('auto_approve', NOW)).toEqual(
      new Date(NOW.getTime() + TIMEOUT_WINDOW_MS),
    );
    expect(timeoutAtFor('deny', NOW)).toEqual(
      new Date(NOW.getTime() + TIMEOUT_WINDOW_MS),
    );
  });

  it('reads the clock from its argument, never from the process', () => {
    const other = new Date('2030-01-01T00:00:00.000Z');
    expect(timeoutAtFor('deny', other)?.toISOString()).toBe(
      '2030-01-01T04:00:00.000Z',
    );
  });

  it('waits four hours — VISION §1s "four hours dead"', () => {
    // Pinned because the number is an argument, not an implementation detail.
    // Changing it should be a deliberate pull request against the constant's
    // doc comment, which is exactly the friction ADR-0014 wants in place of a
    // configurable knob.
    expect(TIMEOUT_WINDOW_MS).toBe(4 * 60 * 60 * 1000);
  });
});
