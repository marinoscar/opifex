import { FakeRunner } from '../runners/fake-runner';
import type { RunnerCapabilities } from '../runners/runner.types';
import {
  CHECK_STATUSES,
  WATCHDOG_CHECKS,
  describeCheckCoverage,
  tallyCoverage,
  type CheckStatus,
  type RunCheckCoverage,
  type RunCoverageInput,
  type WatchdogCheckId,
} from './check-coverage';
import { detectLoop } from './loop-detection';
import { SILENCE_THRESHOLDS_MS, thresholdFor } from './silent-detection';
import type { RateLimitSignal, StreamingFidelity } from './watchdog.types';

/**
 * #104's sixth acceptance criterion: *"tests cover a full-streaming and a
 * near-zero-streaming runner side by side."*
 *
 * There is exactly one real runner today (`claude-code-local`, `full`), and
 * #102/#103 are blocked because the vendor cloud has no non-interactive
 * invocation surface — so the second side is a FakeRunner manifest rather
 * than a second vendor. That is not a shortcut: coverage is derived from a
 * declaration, so a declaration is the whole input, and a manifest saying
 * `streamingFidelity: 'none'` is exactly as real to this module as one from a
 * runner that exists.
 */
async function manifest(
  overrides: Partial<RunnerCapabilities>,
): Promise<RunnerCapabilities> {
  return new FakeRunner({ capabilities: overrides }).capabilities();
}

function inputFrom(
  capabilities: RunnerCapabilities,
  overrides: Partial<RunCoverageInput> = {},
): RunCoverageInput {
  return {
    runnerKey: capabilities.key,
    fidelity: capabilities.streamingFidelity,
    rateLimitSignal: capabilities.rateLimitSignal,
    branch: 'factory/312-a3f91c2-a1',
    ...overrides,
  };
}

function input(overrides: Partial<RunCoverageInput> = {}): RunCoverageInput {
  return {
    runnerKey: 'claude-code-local',
    fidelity: 'full',
    rateLimitSignal: 'structured',
    branch: 'factory/312-a3f91c2-a1',
    ...overrides,
  };
}

function statusOf(
  coverage: RunCheckCoverage,
  check: WatchdogCheckId,
): CheckStatus {
  const entry = coverage.checks.find((c) => c.check === check);
  if (!entry) throw new Error(`no coverage entry for ${check}`);
  return entry.status;
}

function entryOf(coverage: RunCheckCoverage, check: WatchdogCheckId) {
  const entry = coverage.checks.find((c) => c.check === check);
  if (!entry) throw new Error(`no coverage entry for ${check}`);
  return entry;
}

describe('describeCheckCoverage: a full-streaming and a near-zero-streaming runner, side by side', () => {
  let streaming: RunCheckCoverage;
  let dark: RunCheckCoverage;

  beforeEach(async () => {
    streaming = describeCheckCoverage(
      inputFrom(
        await manifest({
          key: 'claude-code-local',
          streamingFidelity: 'full',
          rateLimitSignal: 'structured',
        }),
      ),
    );
    // The near-zero-streaming side: nothing until the run ends, and a rate
    // limit indistinguishable from any other failure.
    dark = describeCheckCoverage(
      inputFrom(
        await manifest({
          key: 'dark-runner',
          streamingFidelity: 'none',
          rateLimitSignal: 'none',
        }),
      ),
    );
  });

  it('reports loop detection ACTIVE on one and UNAVAILABLE on the other — never "no loop found" on both', () => {
    // The whole point of #104. A `looping: false` from a runner that cannot
    // report tool calls and one from a runner that reported forty of them are
    // the same value, and only one of them is a clean bill of health.
    expect(statusOf(streaming, 'loop-detection')).toBe('active');
    expect(statusOf(dark, 'loop-detection')).toBe('unavailable');
  });

  it('reports silence detection on BOTH, because it genuinely runs on both', () => {
    expect(statusOf(streaming, 'silence-detection')).not.toBe('unavailable');
    expect(statusOf(dark, 'silence-detection')).not.toBe('unavailable');
  });

  it('does not call the two silence checks the same thing', () => {
    // Ninety seconds of missed heartbeats and ninety minutes of no commits
    // both catch a stalled run. Only one catches it before lunch, and a
    // uniform `active` would present them as equivalent.
    expect(statusOf(streaming, 'silence-detection')).toBe('active');
    expect(statusOf(dark, 'silence-detection')).toBe('degraded');
  });

  it('names the SIGNAL each silence check is watching, not just its status', () => {
    expect(entryOf(streaming, 'silence-detection').signal).toContain(
      'heartbeat',
    );
    expect(entryOf(dark, 'silence-detection').signal).toContain('git');
  });

  it('carries thresholds that differ by runner rather than sharing one constant', () => {
    expect(entryOf(streaming, 'silence-detection').thresholdMs).toBe(
      SILENCE_THRESHOLDS_MS.full,
    );
    expect(entryOf(dark, 'silence-detection').thresholdMs).toBe(
      SILENCE_THRESHOLDS_MS.none,
    );
    expect(entryOf(dark, 'silence-detection').thresholdMs).toBeGreaterThan(
      entryOf(streaming, 'silence-detection').thresholdMs as number,
    );
  });

  it('parks a block on one and escalates it on the other', () => {
    expect(statusOf(streaming, 'rate-limit-parking')).toBe('active');
    expect(statusOf(dark, 'rate-limit-parking')).toBe('unavailable');
    expect(entryOf(dark, 'rate-limit-parking').reason).toMatch(/escalat/i);
  });

  it('calls git liveness a SECOND source on one and the ONLY source on the other', () => {
    // VISION §9 runs two independent liveness sources. On a non-streaming
    // runner there is only one, and nothing corroborates or contradicts it.
    expect(statusOf(streaming, 'git-liveness')).toBe('active');
    expect(statusOf(dark, 'git-liveness')).toBe('degraded');
    expect(entryOf(dark, 'git-liveness').reason).toContain('ONLY');
  });

  it('rolls up to the weakest status, so an unavailable check is not averaged away', () => {
    expect(streaming.weakest).toBe('active');
    expect(dark.weakest).toBe('unavailable');
  });

  it('carries the declarations that produced the verdict, so it can be checked', () => {
    expect(dark.runnerKey).toBe('dark-runner');
    expect(dark.streamingFidelity).toBe('none');
    expect(dark.rateLimitSignal).toBe('none');
  });
});

describe('unavailable means unavailable', () => {
  it('agrees with detectLoop for EVERY fidelity, including no manifest', () => {
    // The anti-drift test. The cockpit must never promise a check the detector
    // declines to run: `detectLoop`'s gate and this module's status are two
    // statements of one rule, and only a test keeps them one rule.
    const fidelities: (StreamingFidelity | null)[] = [
      'full',
      'partial',
      'none',
      null,
    ];

    for (const fidelity of fidelities) {
      const coverage = describeCheckCoverage(input({ fidelity }));
      const verdict = detectLoop(fidelity, []);

      expect(statusOf(coverage, 'loop-detection') === 'active').toBe(
        verdict.available,
      );
    }
  });

  it('never reports a check as unavailable because it merely found nothing', () => {
    // A check that RAN and found nothing is a pass, not an absence. Nothing in
    // this module can produce `unavailable` from an observation, because it
    // takes no observations at all — the input is declarations and a branch.
    const clean = describeCheckCoverage(input());

    expect(clean.checks.map((c) => c.status)).not.toContain('unavailable');
  });

  it('gives every non-active status a reason that names the runner', () => {
    const fidelities: (StreamingFidelity | null)[] = [
      'full',
      'partial',
      'none',
      null,
    ];
    const signals: (RateLimitSignal | null)[] = [
      'structured',
      'heuristic',
      'none',
      null,
    ];

    for (const fidelity of fidelities) {
      for (const rateLimitSignal of signals) {
        const coverage = describeCheckCoverage(
          input({ runnerKey: 'some-runner', fidelity, rateLimitSignal }),
        );
        for (const check of coverage.checks) {
          expect(check.reason).toContain('some-runner');
          expect(check.reason.length).toBeGreaterThan(40);
        }
      }
    }
  });

  it('says WHAT is missing, not merely that something is', () => {
    const partial = describeCheckCoverage(input({ fidelity: 'partial' }));

    expect(entryOf(partial, 'loop-detection').reason).toContain(
      'partial streaming fidelity',
    );
    expect(entryOf(partial, 'loop-detection').reason).toContain('per-tool');
  });
});

describe('a runner that declared nothing', () => {
  it('gets the most permissive silence threshold, matching the detector', () => {
    const coverage = describeCheckCoverage(
      input({ fidelity: null, rateLimitSignal: null }),
    );

    expect(entryOf(coverage, 'silence-detection').thresholdMs).toBe(
      thresholdFor(null),
    );
  });

  it('cannot claim loop detection or parking on the strength of no manifest', () => {
    const coverage = describeCheckCoverage(
      input({ fidelity: null, rateLimitSignal: null }),
    );

    expect(statusOf(coverage, 'loop-detection')).toBe('unavailable');
    expect(statusOf(coverage, 'rate-limit-parking')).toBe('unavailable');
    expect(entryOf(coverage, 'loop-detection').reason).toContain(
      'no capability manifest',
    );
  });
});

describe('the graded rate-limit signal', () => {
  it('degrades rather than disappears when the reset is inferred from prose', () => {
    // `runner-capability.schema.json`: heuristic means "auto-resume is
    // possible but approximate". Approximate is not absent, and reporting it
    // as unavailable would send a human at a run the system will recover.
    const coverage = describeCheckCoverage(
      input({ rateLimitSignal: 'heuristic' }),
    );

    expect(statusOf(coverage, 'rate-limit-parking')).toBe('degraded');
    expect(entryOf(coverage, 'rate-limit-parking').reason).toMatch(
      /approximate/i,
    );
  });
});

describe('git-derived liveness', () => {
  it('is unavailable when there is no branch to watch', () => {
    const coverage = describeCheckCoverage(input({ branch: null }));

    expect(statusOf(coverage, 'git-liveness')).toBe('unavailable');
  });

  it('names the branch it polls, so the claim can be verified', () => {
    const coverage = describeCheckCoverage(
      input({ branch: 'factory/999-deadbee-a2' }),
    );

    expect(entryOf(coverage, 'git-liveness').reason).toContain(
      'factory/999-deadbee-a2',
    );
  });

  it('does NOT downgrade because git has seen nothing yet — that is an observation', () => {
    // A brand-new run with a bare branch is not a run whose liveness source
    // has failed. Mixing observation into coverage would report a healthy new
    // run as under-protected, and operators would learn to ignore the field.
    const coverage = describeCheckCoverage(input());

    expect(statusOf(coverage, 'git-liveness')).toBe('active');
  });
});

describe('the shape the cockpit renders', () => {
  it('always reports all four checks, in a stable order', () => {
    const coverage = describeCheckCoverage(input({ fidelity: 'none' }));

    expect(coverage.checks.map((c) => c.check)).toEqual([...WATCHDOG_CHECKS]);
  });

  it('only ever uses the declared statuses', () => {
    const coverage = describeCheckCoverage(
      input({ fidelity: null, rateLimitSignal: null, branch: null }),
    );

    for (const check of coverage.checks) {
      expect(CHECK_STATUSES).toContain(check.status);
    }
  });

  it('states a threshold only where there is one', () => {
    const coverage = describeCheckCoverage(input());

    for (const check of coverage.checks) {
      if (check.check === 'silence-detection') {
        expect(typeof check.thresholdMs).toBe('number');
      } else {
        expect(check.thresholdMs).toBeNull();
      }
    }
  });
});

describe('the properties this must hold', () => {
  it('is pure: no clock, and the same input always gives the same answer', () => {
    const args = input({ fidelity: 'partial', rateLimitSignal: 'heuristic' });

    expect(describeCheckCoverage(args)).toEqual(describeCheckCoverage(args));
  });

  it('takes no `now`, because coverage is not a function of time', () => {
    expect(describeCheckCoverage.length).toBe(1);
  });

  it('does not mutate its input', () => {
    const args = input();
    const before = JSON.stringify(args);

    describeCheckCoverage(args);

    expect(JSON.stringify(args)).toBe(before);
  });

  it('takes declarations and a branch, and nothing observed', () => {
    // A guard on the INPUT rather than the output. Coverage stops being a
    // statement about capability the moment an event age or a verdict reaches
    // it, and the way that happens is somebody adding one field here. This
    // test is what makes them argue for it in a review first.
    expect(Object.keys(input()).sort()).toEqual([
      'branch',
      'fidelity',
      'rateLimitSignal',
      'runnerKey',
    ]);
  });
});

describe('tallyCoverage', () => {
  it('counts each check at each status across a sweep', () => {
    const tallies = tallyCoverage([
      describeCheckCoverage(input()),
      describeCheckCoverage(
        input({ fidelity: 'none', rateLimitSignal: 'none' }),
      ),
      describeCheckCoverage(
        input({ fidelity: 'none', rateLimitSignal: 'none' }),
      ),
    ]);

    expect(tallies['loop-detection']).toEqual({
      active: 1,
      degraded: 0,
      unavailable: 2,
    });
    expect(tallies['silence-detection']).toEqual({
      active: 1,
      degraded: 2,
      unavailable: 0,
    });
  });

  it('reports every check even when no run exercised it', () => {
    // A missing key would read as zero unavailable, which is the reassuring
    // reading of "not measured" this whole issue exists to stop.
    const tallies = tallyCoverage([]);

    expect(Object.keys(tallies).sort()).toEqual([...WATCHDOG_CHECKS].sort());
    for (const check of WATCHDOG_CHECKS) {
      expect(tallies[check]).toEqual({
        active: 0,
        degraded: 0,
        unavailable: 0,
      });
    }
  });
});

describe('the restated rate-limit enum', () => {
  it('matches Prisma RunnerSignalQuality exactly', async () => {
    // Restated rather than imported so the derivation stays a pure function
    // over plain data — safe only while the two agree. A value added to the
    // schema and missing here would fall through to the null branch and be
    // reported as "no manifest", which is a different and wrong story.
    const { RunnerSignalQuality } = await import('@prisma/client');
    const declared: RateLimitSignal[] = ['structured', 'heuristic', 'none'];

    expect(Object.values(RunnerSignalQuality).sort()).toEqual(declared.sort());
  });
});
