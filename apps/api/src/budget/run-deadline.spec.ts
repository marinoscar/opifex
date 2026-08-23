import { DEFAULT_DEADLINE_GRACE_MINUTES, decideDeadline } from './run-deadline';

/**
 * The deadline policy's boundary (#180).
 *
 * A deadline is almost entirely boundary: the interesting question is never
 * "is an hour more than ten minutes" but "what happens at exactly the mark",
 * and that is the part that gets written wrong. So `now` is injected and every
 * case below is pinned to an instant rather than to "eventually".
 */
describe('decideDeadline', () => {
  const START = new Date('2026-08-23T12:00:00Z');

  /** `minutes` after the run started. */
  const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

  const inputs = (overrides: Partial<Parameters<typeof decideDeadline>[0]> = {}) => ({
    startedAt: START,
    timeoutMinutes: 10,
    defaultTimeoutMinutes: 60,
    graceMinutes: 2,
    ...overrides,
  });

  describe('the boundary', () => {
    it('is not overdue before the limit', () => {
      const verdict = decideDeadline(inputs(), at(5));

      expect(verdict.overdue).toBe(false);
      expect(verdict.elapsedMinutes).toBe(5);
      expect(verdict.limitMinutes).toBe(10);
    });

    it('is not overdue at the limit itself — the grace period has not started', () => {
      expect(decideDeadline(inputs(), at(10)).overdue).toBe(false);
    });

    it('is not overdue inside the grace period', () => {
      // THE case the grace period exists for: the runner's own timer has
      // fired and it is shutting down. Cancelling here would land a second
      // kill on a process already dying and write a competing reason for it.
      expect(decideDeadline(inputs(), at(11)).overdue).toBe(false);
    });

    it('is not overdue at exactly the enforcement mark', () => {
      // `<=`, not `<`. A run at the mark has not passed it, and the runner's
      // kill may be landing this very instant.
      expect(decideDeadline(inputs(), at(12)).overdue).toBe(false);
    });

    it('is overdue one step past the enforcement mark', () => {
      const verdict = decideDeadline(inputs(), at(12.1));

      expect(verdict.overdue).toBe(true);
      expect(verdict.overdue === true && verdict.enforcedAfterMinutes).toBe(12);
      expect(verdict.limitMinutes).toBe(10);
    });
  });

  describe('which limit applies', () => {
    it("prefers the order's own ceiling over the default", () => {
      const verdict = decideDeadline(
        inputs({ timeoutMinutes: 5, defaultTimeoutMinutes: 60 }),
        at(8),
      );

      expect(verdict.overdue).toBe(true);
      expect(verdict.limitMinutes).toBe(5);
    });

    it('falls back to the default when the order names none', () => {
      const verdict = decideDeadline(
        inputs({ timeoutMinutes: null, defaultTimeoutMinutes: 30 }),
        at(40),
      );

      expect(verdict.overdue).toBe(true);
      expect(verdict.limitMinutes).toBe(30);
    });

    it('is never overdue when neither names a limit', () => {
      // Unbounded is a deliberate operator choice -- `RUNNER_DEFAULT_TIMEOUT_
      // MINUTES` unset means genuinely unbounded, per its own documentation.
      // Inventing a limit here would enforce a policy nobody wrote.
      const verdict = decideDeadline(
        inputs({ timeoutMinutes: null, defaultTimeoutMinutes: null }),
        at(60 * 24),
      );

      expect(verdict.overdue).toBe(false);
      expect(verdict.limitMinutes).toBeNull();
      expect(verdict.elapsedMinutes).toBe(1440);
    });

    it('treats a zero or negative limit as unbounded rather than as instant', () => {
      // A `0` reaching here means a misconfiguration, and the safe reading is
      // "no limit configured" rather than "every run is immediately overdue",
      // which would cancel the entire fleet on the first tick.
      expect(decideDeadline(inputs({ timeoutMinutes: 0 }), at(5)).overdue).toBe(false);
      expect(decideDeadline(inputs({ timeoutMinutes: -5 }), at(5)).overdue).toBe(false);
    });
  });

  describe('the grace period', () => {
    it('extends the mark by exactly its own length', () => {
      const verdict = decideDeadline(inputs({ graceMinutes: 30 }), at(41));

      expect(verdict.overdue).toBe(true);
      expect(verdict.overdue === true && verdict.enforcedAfterMinutes).toBe(40);
    });

    it('with zero grace, fires immediately past the limit', () => {
      expect(decideDeadline(inputs({ graceMinutes: 0 }), at(10)).overdue).toBe(false);
      expect(decideDeadline(inputs({ graceMinutes: 0 }), at(10.1)).overdue).toBe(true);
    });

    it('clamps a negative grace to zero rather than bringing the mark forward', () => {
      // A negative grace would make the control plane fire BEFORE the runner,
      // inverting the whole design.
      expect(decideDeadline(inputs({ graceMinutes: -5 }), at(9)).overdue).toBe(false);
    });

    it('has a default long enough to clear a clean shutdown', () => {
      // Documented as clearing RUNNER_KILL_GRACE_MS (10s) plus a poll interval
      // (15s). If somebody shortens it below that, a runner shutting down
      // correctly starts getting cancelled mid-shutdown.
      expect(DEFAULT_DEADLINE_GRACE_MINUTES * 60_000).toBeGreaterThan(10_000 + 15_000);
    });
  });

  describe('the reason it records', () => {
    it('names the elapsed time, the ceiling and the grace period', () => {
      // #65's first acceptance criterion: the stop is recorded WITH the figure
      // that triggered it. A reason that said only "timed out" would leave an
      // operator reading source to find out which limit and by how much.
      const verdict = decideDeadline(inputs({ timeoutMinutes: 10 }), at(15));

      expect(verdict.overdue).toBe(true);
      expect(verdict.overdue === true && verdict.reason).toContain('15 minute(s)');
      expect(verdict.overdue === true && verdict.reason).toContain(
        'ceiling of 10 minute(s)',
      );
      expect(verdict.overdue === true && verdict.reason).toContain('2-minute grace');
    });

    it('says the runner did not stop it', () => {
      // Two different facts, and #66's retry decision reads them differently:
      // a run the runner stopped is one that was too slow, a run the control
      // plane stopped is one something decided to end.
      const verdict = decideDeadline(inputs(), at(30));

      expect(verdict.overdue === true && verdict.reason).toContain('runner did not stop it');
    });

    it('claims NOTHING about the cancellation', () => {
      // This function is pure and runs before anything is attempted, so it
      // cannot know whether the cancel succeeded, failed, or was even
      // possible. A probe against real rows printed "the control plane
      // cancelled it" for three runs the control plane could not reach --
      // VISION §9's synthesized event masquerading as a report, in one
      // sentence. The caller appends the outcome once it is a fact.
      const verdict = decideDeadline(inputs(), at(30));
      const reason = verdict.overdue === true ? verdict.reason : '';

      expect(reason).not.toContain('cancelled');
      expect(reason).not.toContain('control plane');
    });
  });

  it('rounds elapsed minutes to one decimal rather than showing a float tail', () => {
    const verdict = decideDeadline(inputs(), new Date(START.getTime() + 90_123));

    expect(verdict.elapsedMinutes).toBe(1.5);
  });

  it('reports zero elapsed for a run that has just started', () => {
    expect(decideDeadline(inputs(), START).elapsedMinutes).toBe(0);
  });
});
