import { DEFAULT_QUOTA_GATE, assessQuota } from './quota-gate';

describe('assessQuota (#89)', () => {
  const idle = { runsBlocked: 0, runsRunning: 0 };

  it('lets the supervisor run when nothing is parked', () => {
    expect(assessQuota(idle)).toEqual({ standDown: false, reason: null });
  });

  it('stands down while a run is parked on a rate limit', () => {
    // VISION §7: "a supervisor competing for the quota it is managing is a bad
    // loop." A parked worker is the evidence that the budget already ran out.
    const verdict = assessQuota({ runsBlocked: 2, runsRunning: 1 });

    expect(verdict.standDown).toBe(true);
    expect(verdict.reason).toContain('2 run(s) are parked');
  });

  it('always states a reason when it stands down', () => {
    // A skipped invocation with no reason is a gap in the log, and a gap is
    // indistinguishable from an invocation that silently failed.
    const verdict = assessQuota({ runsBlocked: 1, runsRunning: 0 });
    expect(verdict.reason).not.toBeNull();
    expect(verdict.reason?.length).toBeGreaterThan(20);
  });

  it('can be told to ignore parked runs', () => {
    const verdict = assessQuota(
      { runsBlocked: 5, runsRunning: 0 },
      { standDownWhenBlocked: false, liveRunCeiling: null },
    );
    expect(verdict.standDown).toBe(false);
  });

  it('defaults to standing down when blocked, and to no live-run ceiling', () => {
    // The default matters: this is the one supervisor switch that defaults ON,
    // because respecting an already-exhausted budget costs nothing.
    expect(DEFAULT_QUOTA_GATE.standDownWhenBlocked).toBe(true);
    expect(DEFAULT_QUOTA_GATE.liveRunCeiling).toBeNull();
  });

  it('stands down at the live-run ceiling, not one past it', () => {
    const config = { standDownWhenBlocked: true, liveRunCeiling: 3 };

    expect(
      assessQuota({ runsBlocked: 0, runsRunning: 2 }, config).standDown,
    ).toBe(false);
    expect(
      assessQuota({ runsBlocked: 0, runsRunning: 3 }, config).standDown,
    ).toBe(true);
  });

  it('never stands down on a live-run count when the ceiling is unset', () => {
    // Pressure is not exhaustion, and a gate that fires constantly is a
    // supervisor that never runs.
    expect(
      assessQuota({ runsBlocked: 0, runsRunning: 500 }, DEFAULT_QUOTA_GATE)
        .standDown,
    ).toBe(false);
  });

  it('reports the parked reason first when both conditions hold', () => {
    const verdict = assessQuota(
      { runsBlocked: 1, runsRunning: 9 },
      { standDownWhenBlocked: true, liveRunCeiling: 2 },
    );
    expect(verdict.reason).toContain('parked on a rate limit');
  });

  it('is pure — the same totals always give the same verdict', () => {
    const totals = { runsBlocked: 1, runsRunning: 4 };
    expect(assessQuota(totals)).toEqual(assessQuota(totals));
  });
});
