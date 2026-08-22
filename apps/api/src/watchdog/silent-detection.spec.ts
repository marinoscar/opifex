import {
  SILENCE_THRESHOLDS_MS,
  UNDECLARED_THRESHOLD_MS,
  detectSilentRuns,
  thresholdFor,
} from './silent-detection';
import type { StreamingFidelity, WatchedRunState } from './watchdog.types';

const NOW = new Date('2026-08-21T12:00:00Z');

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000);
}

function secondsAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 1000);
}

function run(overrides: Partial<WatchedRunState> = {}): WatchedRunState {
  return {
    runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
    repository: 'marinoscar/opifex',
    issueNumber: 312,
    status: 'running',
    startedAt: minutesAgo(120),
    lastEventAt: secondsAgo(10),
    runnerKey: 'claude-code-local',
    fidelity: 'full',
    ...overrides,
  };
}

describe('detectSilentRuns', () => {
  describe('thresholds derive from declared capabilities', () => {
    it('is not one constant', () => {
      // #54's central requirement. A single global threshold applied to a
      // non-streaming runner kills healthy runs constantly; applied to a
      // streaming one it takes hours to notice a stall, which is the original
      // complaint.
      const values = new Set(Object.values(SILENCE_THRESHOLDS_MS));

      expect(values.size).toBe(3);
    });

    it('gets more permissive as fidelity drops', () => {
      // VISION §6: it gets dumber, not broken.
      expect(SILENCE_THRESHOLDS_MS.full).toBeLessThan(SILENCE_THRESHOLDS_MS.partial);
      expect(SILENCE_THRESHOLDS_MS.partial).toBeLessThan(SILENCE_THRESHOLDS_MS.none);
    });

    it.each<[StreamingFidelity, number]>([
      ['full', 2],
      ['partial', 15],
      ['none', 120],
    ])('flags a %s-fidelity runner silent for %i minutes', (fidelity, silentMinutes) => {
      const verdicts = detectSilentRuns(
        [run({ fidelity, lastEventAt: minutesAgo(silentMinutes) })],
        NOW,
      );

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].fidelity).toBe(fidelity);
    });

    it('does NOT kill a non-streaming runner that a streaming threshold would', () => {
      // The case #54 names explicitly: "A non-streaming runner is judged by
      // git-derived liveness, not starved of signal and killed."
      const quiet = { lastEventAt: minutesAgo(30) };

      expect(detectSilentRuns([run({ ...quiet, fidelity: 'full' })], NOW)).toHaveLength(1);
      expect(detectSilentRuns([run({ ...quiet, fidelity: 'none' })], NOW)).toEqual([]);
    });

    it('detects a streaming stall in SECONDS, not hours', () => {
      // The metric #54 asks for. 90 seconds is several missed heartbeats.
      expect(SILENCE_THRESHOLDS_MS.full).toBeLessThanOrEqual(120_000);

      expect(detectSilentRuns([run({ lastEventAt: secondsAgo(91) })], NOW)).toHaveLength(1);
    });
  });

  describe('an undeclared runner', () => {
    it('gets the MOST permissive threshold, not the strictest', () => {
      // An unregistered runner is an operational gap, and killing its runs is
      // the wrong way to report one — the run is doing real work, and the
      // missing manifest is a separate problem with its own fix.
      expect(UNDECLARED_THRESHOLD_MS).toBe(SILENCE_THRESHOLDS_MS.none);
      expect(thresholdFor(null)).toBe(SILENCE_THRESHOLDS_MS.none);
    });

    it('is not killed at a streaming-runner age', () => {
      expect(detectSilentRuns([run({ fidelity: null, lastEventAt: minutesAgo(30) })], NOW)).toEqual(
        [],
      );
    });

    it('says in its reason that no manifest was declared', () => {
      const [verdict] = detectSilentRuns(
        [run({ fidelity: null, lastEventAt: minutesAgo(120) })],
        NOW,
      );

      expect(verdict.reason).toContain('no capability manifest');
    });
  });

  describe('which runs are judged', () => {
    it('never judges a BLOCKED run as silent', () => {
      // A blocked run is parked with a reset time and is SUPPOSED to be quiet
      // (#56). Killing it would collapse two of VISION §9's three failure
      // modes into one, which it calls the most common supervision bug.
      expect(
        detectSilentRuns([run({ status: 'blocked', lastEventAt: minutesAgo(600) })], NOW),
      ).toEqual([]);
    });

    it.each(['succeeded', 'failed', 'quarantined'] as const)(
      'ignores a %s run',
      (status) => {
        expect(detectSilentRuns([run({ status, lastEventAt: minutesAgo(600) })], NOW)).toEqual([]);
      },
    );

    it('still judges a STALLED run', () => {
      // It has not been killed yet, and re-confirming keeps the verdict
      // current rather than going quiet about a problem that persists.
      expect(
        detectSilentRuns([run({ status: 'stalled', lastEventAt: minutesAgo(30) })], NOW),
      ).toHaveLength(1);
    });
  });

  describe('a run that has never reported', () => {
    it('is measured from when it STARTED, not treated as infinitely old', () => {
      // Otherwise every run is killed in the seconds between dispatch and its
      // first heartbeat.
      expect(
        detectSilentRuns([run({ lastEventAt: null, startedAt: secondsAgo(5) })], NOW),
      ).toEqual([]);
    });

    it('is eventually flagged if it never reports at all', () => {
      const [verdict] = detectSilentRuns(
        [run({ lastEventAt: null, startedAt: minutesAgo(30) })],
        NOW,
      );

      expect(verdict.reason).toContain('no event of any source since the run started');
    });
  });

  describe('the boundary', () => {
    it('does not fire exactly AT the threshold', () => {
      const exactly = new Date(NOW.getTime() - SILENCE_THRESHOLDS_MS.full);

      expect(detectSilentRuns([run({ lastEventAt: exactly })], NOW)).toEqual([]);
    });

    it('fires one millisecond past it', () => {
      const past = new Date(NOW.getTime() - SILENCE_THRESHOLDS_MS.full - 1);

      expect(detectSilentRuns([run({ lastEventAt: past })], NOW)).toHaveLength(1);
    });
  });

  describe('the verdict records why', () => {
    it('names the observed age and the threshold', () => {
      // #54: "Every kill records why, with the event age that triggered it."
      // This is the one decision in the system that destroys work, and a
      // verdict nobody can check is one they will stop trusting.
      const [verdict] = detectSilentRuns([run({ lastEventAt: minutesAgo(10) })], NOW);

      expect(verdict.reason).toContain('silent for 10m');
      expect(verdict.reason).toContain(minutesAgo(10).toISOString());
      expect(verdict.reason).toContain('claude-code-local declares full streaming fidelity');
      expect(verdict.silentForMs).toBe(10 * 60_000);
      expect(verdict.thresholdMs).toBe(SILENCE_THRESHOLDS_MS.full);
    });

    it('distinguishes the observed age from the threshold it crossed', () => {
      // 95 seconds against a 90-second threshold. Rounding both to whole
      // minutes rendered "silent for 2m, exceeding the 2m threshold" — a
      // justification that cannot justify itself, and exactly the kind of
      // number that makes an operator stop trusting a kill.
      const [verdict] = detectSilentRuns([run({ lastEventAt: secondsAgo(95) })], NOW);

      expect(verdict.reason).toContain('silent for 1m 35s');
      expect(verdict.reason).toContain('exceeding the 1m 30s threshold');
    });

    it('expresses a sub-minute duration in seconds', () => {
      const [verdict] = detectSilentRuns(
        [run({ fidelity: 'full', lastEventAt: null, startedAt: secondsAgo(100) })],
        NOW,
      );

      expect(verdict.reason).toMatch(/silent for 1m 40s/);
    });

    it('expresses a multi-hour silence in hours', () => {
      // VISION §1's origin story is four hours of dead time. "240m" is a
      // number you have to convert; "4h 0m" is one you read.
      const [verdict] = detectSilentRuns(
        [run({ fidelity: 'none', lastEventAt: minutesAgo(240) })],
        NOW,
      );

      expect(verdict.reason).toContain('silent for 4h 0m');
    });

    it('carries the repository and issue, so an escalation can be acted on', () => {
      const [verdict] = detectSilentRuns([run({ lastEventAt: minutesAgo(10) })], NOW);

      expect(verdict).toMatchObject({ repository: 'marinoscar/opifex', issueNumber: 312 });
    });
  });

  describe('the properties this must hold', () => {
    it('is deterministic — now is a parameter, not the clock', () => {
      const runs = [run({ lastEventAt: minutesAgo(10) })];

      expect(detectSilentRuns(runs, NOW)).toEqual(detectSilentRuns(runs, NOW));
    });

    it('does no model work: the source is arithmetic on timestamps', () => {
      // VISION §7 puts stall detection firmly in the hot path, deterministic.
      const source = detectSilentRuns.toString();

      expect(source).not.toMatch(/await|fetch|prompt|model/i);
    });

    it('does not mutate its input', () => {
      const runs = [run({ lastEventAt: minutesAgo(10) })];
      const before = JSON.stringify(runs);

      detectSilentRuns(runs, NOW);

      expect(JSON.stringify(runs)).toBe(before);
    });

    it('judges every run in a mixed batch independently', () => {
      const verdicts = detectSilentRuns(
        [
          run({ runId: 'a', lastEventAt: secondsAgo(5) }),
          run({ runId: 'b', lastEventAt: minutesAgo(10) }),
          run({ runId: 'c', status: 'blocked', lastEventAt: minutesAgo(600) }),
          run({ runId: 'd', fidelity: 'none', lastEventAt: minutesAgo(30) }),
        ],
        NOW,
      );

      expect(verdicts.map((v) => v.runId)).toEqual(['b']);
    });
  });
});

describe('the restated fidelity enum', () => {
  it('matches Prisma RunnerStreamingFidelity exactly', async () => {
    // Restated rather than imported so detection stays a pure function over
    // plain data. That is only safe while the two agree, and a fidelity added
    // to the schema and missing here would silently get no threshold.
    const { RunnerStreamingFidelity } = await import('@prisma/client');

    expect(Object.values(RunnerStreamingFidelity).sort()).toEqual(
      Object.keys(SILENCE_THRESHOLDS_MS).sort(),
    );
  });
});
