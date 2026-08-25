import { DEFAULT_QUOTA_GATE, assessQuota } from './quota-gate';

describe('assessQuota (#89)', () => {
  const idle = { runsBlocked: 0 };

  it('lets the supervisor run when nothing is parked', () => {
    expect(assessQuota(idle)).toEqual({ standDown: false, reason: null });
  });

  it('stands down while a run is parked on a rate limit', () => {
    // A parked worker is evidence that everything the supervisor exists to
    // advise about has stopped moving. Since ADR-0015 that, rather than a
    // shared budget, is why the gate stands down -- the behaviour is the same,
    // the reason is not.
    const verdict = assessQuota({ runsBlocked: 2 });

    expect(verdict.standDown).toBe(true);
    expect(verdict.reason).toContain('2 run(s) are parked');
  });

  it('always states a reason when it stands down', () => {
    // A skipped invocation with no reason is a gap in the log, and a gap is
    // indistinguishable from an invocation that silently failed.
    const verdict = assessQuota({ runsBlocked: 1 });
    expect(verdict.reason).not.toBeNull();
    expect(verdict.reason?.length).toBeGreaterThan(20);
  });

  it('can be told to ignore parked runs', () => {
    const verdict = assessQuota(
      { runsBlocked: 5 },
      { standDownWhenBlocked: false },
    );
    expect(verdict.standDown).toBe(false);
  });

  it('defaults to standing down when blocked', () => {
    // The default matters: this is the one supervisor switch that defaults ON,
    // because a diagnosis nobody can act on is worth waiting on.
    expect(DEFAULT_QUOTA_GATE.standDownWhenBlocked).toBe(true);
  });

  it('is pure — the same totals always give the same verdict', () => {
    const totals = { runsBlocked: 1 };
    expect(assessQuota(totals)).toEqual(assessQuota(totals));
  });

  describe('the live-run ceiling, removed by ADR-0016', () => {
    // What replaces the ceiling's five tests is not a smaller version of the
    // same suite. It is one assertion that the knob is gone from the shape of
    // the config, so a future PR reintroducing a `liveRunCeiling` has to do it
    // as a new, argued decision rather than as a field quietly restored
    // because no test noticed it had left.
    it('exposes exactly one field on the gate config', () => {
      expect(Object.keys(DEFAULT_QUOTA_GATE)).toEqual(['standDownWhenBlocked']);
    });

    it('proceeds with many runs live and nothing parked', () => {
      // The behaviour change ADR-0016 makes. `runsRunning` does not determine
      // what an invocation spends -- every proposer runs once per tick either
      // way -- so a busy factory is no longer a reason to skip, and a busy
      // factory is when a missed stall is most expensive.
      //
      // The totals are built as a variable rather than passed inline because
      // `assessQuota` no longer declares `runsRunning` at all: an inline
      // literal would not compile, which is itself the assertion that the
      // count is gone from the gate's inputs.
      const busyFactory = { runsBlocked: 0, runsRunning: 500 };

      expect(assessQuota(busyFactory, DEFAULT_QUOTA_GATE)).toEqual({
        standDown: false,
        reason: null,
      });
    });

    it('states nothing about a ceiling when it stands down', () => {
      // The reason string is logged against the `skipped_quota` row an
      // operator reads. ADR-0016's carried-forward lesson is that a
      // reason-string test must assert the CONTENT of the claim: a
      // non-empty-string assertion sat beside the false "yields the shared
      // quota" sentence for as long as that sentence existed.
      const busyAndParked = { runsBlocked: 1, runsRunning: 9 };
      const verdict = assessQuota(busyAndParked);

      expect(verdict.reason).toContain('parked on a rate limit');
      expect(verdict.reason).not.toMatch(/ceiling|live|quota|budget/i);
    });
  });
});
