import {
  MAX_JITTER_MS,
  MIN_JITTER_MS,
  UNDATED_BLOCK_PATIENCE_MS,
  actionsForParking,
  decideParking,
  jitterFor,
} from './blocked-parking';
import type { BlockedRunState } from './blocked-parking';

const NOW = new Date('2026-08-21T14:00:00Z');

function at(offsetMinutes: number): Date {
  return new Date(NOW.getTime() + offsetMinutes * 60_000);
}

function blocked(overrides: Partial<BlockedRunState> = {}): BlockedRunState {
  return {
    runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
    repository: 'marinoscar/opifex',
    issueNumber: 312,
    blockedSince: at(-5),
    resetAt: at(240),
    reason: 'rate-limit',
    resumesAt: null,
    ...overrides,
  };
}

describe('decideParking', () => {
  describe('a newly blocked run', () => {
    it('parks rather than being killed or counted as a failure', () => {
      // #56: a blocked run is NOT a failure. It carries a reset time, and the
      // correct response is to park and resume automatically.
      const decision = decideParking(blocked(), NOW, () => 0.5);

      expect(decision.kind).toBe('park');
    });

    it('schedules the resume AFTER the reset, never before', () => {
      // Resuming before the quota has refilled guarantees an immediate second
      // block — the loop the jitter exists to prevent.
      const decision = decideParking(blocked(), NOW, () => 0);

      expect(decision.kind).toBe('park');
      if (decision.kind !== 'park') return;
      expect(decision.resumeAt.getTime()).toBeGreaterThanOrEqual(
        at(240).getTime(),
      );
    });

    it('explains the park in terms a human can check', () => {
      const decision = decideParking(blocked(), NOW, () => 0.5);

      expect(decision.reason).toContain('rate-limit');
      expect(decision.reason).toContain('jitter');
      expect(decision.reason).toContain(at(240).toISOString());
    });
  });

  describe('jitter is load-bearing', () => {
    it('spreads simultaneously-parked runs so they do not stampede', () => {
      // #56 names the failure: every run parked by the same quota window would
      // otherwise resume in the same instant and re-exhaust it immediately,
      // converting one block into a thundering-herd loop.
      const run = blocked();
      const resumeTimes = new Set(
        Array.from({ length: 50 }, (_, i) => {
          const decision = decideParking(run, NOW, () => i / 50);
          return decision.kind === 'park' ? decision.resumeAt.getTime() : 0;
        }),
      );

      expect(resumeTimes.size).toBeGreaterThan(40);
    });

    it('scales the window with the block duration', () => {
      // A fixed jitter is wrong in both directions: 30 seconds across fifty
      // runs still lands them within a minute of a gradually-refilling quota,
      // and ten minutes would delay a five-minute block far past its reset.
      const short = jitterFor(at(5), at(0), () => 1);
      const long = jitterFor(at(240), at(0), () => 1);

      expect(long).toBeGreaterThan(short);
    });

    it('never drops below the floor, even for a very short block', () => {
      expect(jitterFor(at(1), at(0), () => 0.999)).toBeGreaterThanOrEqual(
        Math.floor(MIN_JITTER_MS * 0.999),
      );
    });

    it('never exceeds the ceiling, even for a very long block', () => {
      // Otherwise a 24-hour quota block would add hours of dead time — the
      // exact thing being recovered.
      expect(jitterFor(at(60 * 24), at(0), () => 0.999)).toBeLessThanOrEqual(
        MAX_JITTER_MS,
      );
    });

    it('is never negative', () => {
      expect(jitterFor(at(-10), at(0), () => 0.5)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('an already-parked run', () => {
    it('waits rather than re-deciding', () => {
      // Re-deciding every tick would move the resume time on each pass and the
      // run would never resume — the jitter would chase itself.
      const decision = decideParking(
        blocked({ resumesAt: at(60) }),
        NOW,
        () => 0.5,
      );

      expect(decision.kind).toBe('waiting');
    });

    it('resumes once its scheduled time has passed', () => {
      const decision = decideParking(
        blocked({ resumesAt: at(-1) }),
        NOW,
        () => 0.5,
      );

      expect(decision.kind).toBe('resume');
      expect(decision.reason).toContain('has passed');
    });
  });

  describe('a block with NO reset time', () => {
    it('waits at first, rather than escalating immediately', () => {
      const decision = decideParking(
        blocked({ resetAt: null, reason: 'unknown', blockedSince: at(-5) }),
        NOW,
      );

      expect(decision.kind).toBe('waiting');
    });

    it('ESCALATES rather than parking forever', () => {
      // Nothing can compute when it would resume, so parking it indefinitely
      // is exactly the silent dead time this project exists to eliminate.
      const decision = decideParking(
        blocked({
          resetAt: null,
          reason: 'unknown',
          blockedSince: new Date(
            NOW.getTime() - UNDATED_BLOCK_PATIENCE_MS - 60_000,
          ),
        }),
        NOW,
      );

      expect(decision.kind).toBe('escalate');
      expect(decision.reason).toContain('no reset time');
      expect(decision.reason).toContain('needs a human');
    });

    it('says how long it has already waited', () => {
      const decision = decideParking(
        blocked({
          resetAt: null,
          blockedSince: new Date(NOW.getTime() - 45 * 60_000),
        }),
        NOW,
      );

      expect(decision.reason).toContain('45m');
    });
  });

  describe('determinism', () => {
    it('takes now and the randomness as parameters', () => {
      const run = blocked();

      expect(decideParking(run, NOW, () => 0.42)).toEqual(
        decideParking(run, NOW, () => 0.42),
      );
    });
  });
});

describe('actionsForParking', () => {
  it('emits a park action carrying the JITTERED time, not the raw reset', () => {
    const run = blocked();
    const decision = decideParking(run, NOW, () => 0.5);

    const [action] = actionsForParking(run, decision);

    expect(action.type).toBe('park');
    expect(new Date(action.resumeAt!).getTime()).toBeGreaterThan(
      at(240).getTime(),
    );
  });

  it('emits a resume action when due', () => {
    const run = blocked({ resumesAt: at(-1) });

    expect(
      actionsForParking(run, decideParking(run, NOW)).map((a) => a.type),
    ).toEqual(['resume']);
  });

  it('emits an escalation for an undated block that waited too long', () => {
    const run = blocked({
      resetAt: null,
      blockedSince: new Date(
        NOW.getTime() - UNDATED_BLOCK_PATIENCE_MS - 60_000,
      ),
    });

    expect(
      actionsForParking(run, decideParking(run, NOW)).map((a) => a.type),
    ).toEqual(['escalate']);
  });

  it('emits NOTHING while a run is simply waiting', () => {
    // A blocked run waiting out its quota is Opifex succeeding. Emitting an
    // action every tick would bury the real ones.
    const run = blocked({ resumesAt: at(60) });

    expect(actionsForParking(run, decideParking(run, NOW))).toEqual([]);
  });

  it('carries the runId and work order on every action', () => {
    const run = blocked();

    for (const action of actionsForParking(
      run,
      decideParking(run, NOW, () => 0.5),
    )) {
      expect(action.runId).toBe(run.runId);
      expect(action.evidence.workOrderIdentity).toBe(run.workOrderIdentity);
    }
  });
});
