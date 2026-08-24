import { formatDuration, thresholdFor } from './silent-detection';
import type { RateLimitSignal, StreamingFidelity } from './watchdog.types';

/**
 * Which watchdog checks are actually protecting one run, and which are not.
 *
 * ## The failure this exists to prevent
 *
 * #104, stating it as plainly as it can be stated:
 *
 * > A check that is **unavailable** must report itself as unavailable, not
 * > silently pass. A tool-loop detector that quietly does nothing on a
 * > non-streaming runner looks identical, in the cockpit, to one that ran and
 * > found no loop — and that is worse than not having the check, because it
 * > manufactures false confidence.
 *
 * Every fact this module needs already exists somewhere: `silent-detection.ts`
 * knows its thresholds vary by fidelity, `detectLoop` already refuses to run
 * below `full`, `blocked-parking.ts` already escalates a block it cannot date,
 * and the git watcher already runs for every branch. What did NOT exist is
 * anything that answers the operator's actual question — *which of those are
 * covering the run I am looking at right now?* — because the answer was spread
 * across three detectors and a capability manifest, and assembling it by hand
 * requires knowing all four.
 *
 * ## Why this is derived from the manifest, not from detector output
 *
 * A verdict says what a check FOUND. Coverage says what a check CAN find.
 * Deriving coverage from a run's verdicts would reintroduce exactly the
 * ambiguity above — a `looping: false` from an unavailable check and one from
 * a check that genuinely found nothing would both read as "fine". So nothing
 * here consults an observation, a verdict or an event. It reads the runner's
 * DECLARED capabilities and says what those capabilities buy, which is why
 * `unavailable` here can never be the residue of a check that ran: no check
 * runs in this file.
 *
 * A consequence worth being explicit about: coverage is a statement about the
 * runner, not about the run's lifecycle state. It reads the same for a
 * finished run as for a live one. That is deliberate — the moment an operator
 * most needs to know that loop detection was never available is the postmortem
 * on a run that burned four hours going in circles.
 *
 * ## Three statuses, and why not two
 *
 * Two (`available` / `unavailable`) would force silence detection on a
 * non-streaming runner to claim the same protection as on a streaming one.
 * It is genuinely running there — but it is watching git commits at a 90
 * minute threshold instead of heartbeats at 90 seconds, and calling those the
 * same thing is a smaller version of the same lie this module exists to stop.
 *
 * Four or more would need a rank nobody can apply consistently. Three maps
 * onto the decision an operator actually makes:
 *
 *  - `active`      — this check protects the run as designed. Nothing to do.
 *  - `degraded`    — it runs, but on a weaker signal or a coarser number.
 *                    Detection will be slower or approximate; carry that risk
 *                    knowingly.
 *  - `unavailable` — it cannot run at all. The failure mode it guards is
 *                    UNGUARDED on this run, and no amount of green elsewhere
 *                    changes that.
 *
 * Every entry carries a reason, `active` included. The nullable-reason design
 * was rejected because a UI that only renders a reason when one is present
 * teaches operators that a silent badge means "no explanation available",
 * which is the habit that makes the unavailable case easy to skim past.
 */

/**
 * The four checks, in the order the cockpit should show them.
 *
 * A closed union rather than free strings, for the reason `RunnerNeed` is one:
 * a check id nothing produces must fail to compile, not silently render an
 * empty row. Exported as a const array so the cockpit's zod DTO can restate
 * the enum without keeping a second copy of the values.
 */
export const WATCHDOG_CHECKS = [
  'silence-detection',
  'loop-detection',
  'rate-limit-parking',
  'git-liveness',
] as const;

export type WatchdogCheckId = (typeof WATCHDOG_CHECKS)[number];

export const CHECK_STATUSES = ['active', 'degraded', 'unavailable'] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** One check, and what it is worth on this run. */
export interface CheckCoverage {
  check: WatchdogCheckId;
  status: CheckStatus;
  /**
   * WHAT the check is watching, in one noun phrase.
   *
   * Separate from `status` because the two degrade independently and the
   * signal is the part an operator has to weigh: silence detection is running
   * on every runner, but "runner heartbeats" and "git commits" are not the
   * same guarantee, and a uniform `active` would present them as if they were.
   */
  signal: string;
  /**
   * Why this status, naming the declared capability that produced it.
   *
   * Always populated. For a non-`active` status it must name the specific
   * declaration responsible — "declares `partial` streaming fidelity" — so the
   * operator can go and check the manifest rather than take this file's word.
   */
  reason: string;
  /**
   * The silence threshold in force, in milliseconds. Null on every other
   * check, which has no threshold to state.
   *
   * Sourced from `thresholdFor` rather than restated. A second copy of 90_000
   * in this file is precisely the drift that would let the cockpit promise one
   * number while the detector applies another — and the number it promises is
   * the one an operator uses to decide whether a quiet run is worth chasing.
   */
  thresholdMs: number | null;
}

/** The whole picture for one run. */
export interface RunCheckCoverage {
  /** The runner whose declarations produced all of this. */
  runnerKey: string;
  /** Declared streaming fidelity, or null when the runner filed no manifest. */
  streamingFidelity: StreamingFidelity | null;
  /** Declared rate-limit signal, or null when the runner filed no manifest. */
  rateLimitSignal: RateLimitSignal | null;
  /**
   * The WORST status among the checks.
   *
   * A rollup so a list row or a badge does not have to re-derive one, and
   * `unavailable` deliberately dominates: three healthy checks do not average
   * away a fourth that cannot run, because the failure mode it guards is
   * still unguarded.
   */
  weakest: CheckStatus;
  /** Always all four, always in `WATCHDOG_CHECKS` order. */
  checks: CheckCoverage[];
}

/** What the derivation needs. Declarations only — no events, no verdicts. */
export interface RunCoverageInput {
  runnerKey: string;
  fidelity: StreamingFidelity | null;
  rateLimitSignal: RateLimitSignal | null;
  /**
   * The branch the git watcher would watch, or null when the run has none.
   *
   * The one non-capability input, and it is structural rather than observed:
   * git-derived liveness works by polling a branch (`git-liveness.service.ts`),
   * so a run without one has no second liveness source at all. Whether git has
   * yet SEEN anything on that branch is an observation, and observations are
   * what this module refuses to mix in — a bare branch on a healthy new run
   * would otherwise report the check as failing.
   */
  branch: string | null;
}

/**
 * Derive the coverage for one run.
 *
 * Pure: no clock, no database, no `now` — nothing here depends on time, which
 * is itself the point. Coverage is a property of the runner's declarations,
 * and a function of time would be a function of observations.
 */
export function describeCheckCoverage(
  input: RunCoverageInput,
): RunCheckCoverage {
  const checks: CheckCoverage[] = [
    silenceCoverage(input),
    loopCoverage(input),
    rateLimitCoverage(input),
    gitLivenessCoverage(input),
  ];

  return {
    runnerKey: input.runnerKey,
    streamingFidelity: input.fidelity,
    rateLimitSignal: input.rateLimitSignal,
    weakest: weakest(checks),
    checks,
  };
}

/**
 * Silence detection. Never unavailable, never uniformly active.
 *
 * It runs for every runner — `detectSilentRuns` judges any live run and
 * `thresholdFor` has an answer for every fidelity including none at all — so
 * `unavailable` would be false. But `active` everywhere would be the more
 * expensive falsehood: at `full` this is several missed heartbeats over 90
 * seconds, and at `none` it is 90 minutes of no commits landing. Both catch a
 * stalled run; only one of them catches it before lunch.
 */
function silenceCoverage(input: RunCoverageInput): CheckCoverage {
  const thresholdMs = thresholdFor(input.fidelity);
  const base = { check: 'silence-detection' as const, thresholdMs };

  switch (input.fidelity) {
    case 'full':
      return {
        ...base,
        status: 'active',
        signal: 'runner heartbeats and per-tool progress events',
        reason:
          `${input.runnerKey} declares full streaming fidelity, so silence is measured on ` +
          `heartbeats the runner emits continuously: a stall shows up within ` +
          `${formatDuration(thresholdMs)}.`,
      };
    case 'partial':
      return {
        ...base,
        status: 'degraded',
        signal: 'runner phase-transition events',
        reason:
          `${input.runnerKey} declares partial streaming fidelity — coarse progress with no ` +
          `tool detail — so long gaps between phases are normal and the threshold is relaxed ` +
          `to ${formatDuration(thresholdMs)}. A run that stalls mid-phase is not detected until then.`,
      };
    case 'none':
      return {
        ...base,
        status: 'degraded',
        signal: 'git commits and pull-request transitions, via the git watcher',
        reason:
          `${input.runnerKey} declares no streaming, so silence is measured on git activity ` +
          `rather than on anything the runner reports. A run can legitimately think for a long ` +
          `time before committing, so the threshold is ${formatDuration(thresholdMs)} — the run is ` +
          `still detectably stalled, but materially later than a streaming runner.`,
      };
    case null:
      return {
        ...base,
        status: 'degraded',
        signal: 'any event, from any source — nothing is declared',
        reason:
          `${input.runnerKey} has filed no capability manifest, so nothing is known about what ` +
          `it reports and the most permissive threshold (${formatDuration(thresholdMs)}) applies. ` +
          `Registering the runner is what fixes this.`,
      };
  }
}

/**
 * Tool-loop detection. Available only at `full`.
 *
 * The gate is `detectLoop`'s own — `fidelity !== 'full'` — restated here as a
 * status rather than re-derived from a verdict, and a spec asserts the two
 * agree for every fidelity. If they ever disagreed, the cockpit would promise
 * a check the detector declines to run, which is the exact shape of the lie
 * #104 is about.
 */
function loopCoverage(input: RunCoverageInput): CheckCoverage {
  const base = {
    check: 'loop-detection' as const,
    thresholdMs: null,
    signal: 'consecutive repeats of one tool-call signature',
  };

  if (input.fidelity === 'full') {
    return {
      ...base,
      status: 'active',
      reason:
        `${input.runnerKey} declares full streaming fidelity, which reports a signature per ` +
        `tool call — the signal loop detection needs.`,
    };
  }

  return {
    ...base,
    status: 'unavailable',
    reason:
      input.fidelity === null
        ? `${input.runnerKey} has filed no capability manifest, so nothing establishes that it ` +
          `reports per-tool detail. A run looping on this runner is NOT detected here.`
        : `${input.runnerKey} declares ${
            input.fidelity === 'none'
              ? 'no streaming at all'
              : 'partial streaming fidelity'
          }, which carries no ` +
          `per-tool detail. A run looping on this runner is NOT detected here — this check ` +
          `is not passing, it is absent.`,
  };
}

/**
 * Rate-limit parking, graded exactly as the capability schema grades its input.
 *
 * `runner-capability.schema.json` already spells out the consequence of each
 * value, and this restates it rather than inventing a second reading:
 * `structured` — "a reset time arrives as data, auto-resume is possible";
 * `heuristic` — "auto-resume is possible but approximate"; `none` — "rate
 * limits are not distinguishable. A blocked run escalates."
 *
 * The last one is why this check can be unavailable rather than merely worse.
 * `decideParking` escalates an undated block after 30 minutes of patience, so
 * the run is not lost — but the recovery VISION §1 is about ("an agent hits a
 * rate limit at 2pm, I find out at 6pm") does not happen unattended here. A
 * human resumes it, and the operator should know that before 2pm.
 */
function rateLimitCoverage(input: RunCoverageInput): CheckCoverage {
  const base = {
    check: 'rate-limit-parking' as const,
    thresholdMs: null,
    signal: 'a reset time on the run.blocked event',
  };

  switch (input.rateLimitSignal) {
    case 'structured':
      return {
        ...base,
        status: 'active',
        reason:
          `${input.runnerKey} declares structured rate-limit signals, so a block arrives with a ` +
          `machine-readable reset time and the run parks with a dated, jittered resume.`,
      };
    case 'heuristic':
      return {
        ...base,
        status: 'degraded',
        signal: 'a reset time inferred from the blocked reason text',
        reason:
          `${input.runnerKey} declares heuristic rate-limit signals: the reset time is inferred ` +
          `from prose, so the run still parks and resumes on its own, but the resume time is ` +
          `approximate and a misparse would resume it early or late.`,
      };
    case 'none':
      return {
        ...base,
        status: 'unavailable',
        signal:
          'none — a rate limit is indistinguishable from any other failure',
        reason:
          `${input.runnerKey} declares no rate-limit signal, so a rate limit cannot be told ` +
          `apart from any other failure and nothing can compute when the run would resume. ` +
          `A block on this runner ESCALATES to a human instead of parking.`,
      };
    case null:
      return {
        ...base,
        status: 'unavailable',
        reason:
          `${input.runnerKey} has filed no capability manifest, so nothing establishes that a ` +
          `block from it can be dated. A block on this runner escalates rather than parking.`,
      };
  }
}

/**
 * Git-derived liveness — VISION §9's SECOND independent source.
 *
 * The grading is about independence, not about whether the watcher runs. It
 * runs for any run with a branch. But on a `full` runner it is a second
 * opinion that can contradict the first (`git-liveness.service.ts` records
 * exactly those disagreements), while on a non-streaming runner it is the only
 * opinion there is — nothing corroborates it, nothing contradicts it, and its
 * detection latency is bounded by the git poll interval rather than by
 * anything the runner does. Two sources and one source are not the same
 * guarantee, and the run where the difference matters most is the one where
 * an `active` badge would be most misleading.
 */
function gitLivenessCoverage(input: RunCoverageInput): CheckCoverage {
  const base = {
    check: 'git-liveness' as const,
    thresholdMs: null,
    signal: 'commits, pull-request transitions and CI verdicts on the branch',
  };

  if (!input.branch) {
    return {
      ...base,
      status: 'unavailable',
      signal: 'none — there is no branch to watch',
      reason:
        `This run has no branch, so the git watcher has nothing to poll and there is no ` +
        `liveness source independent of ${input.runnerKey} itself.`,
    };
  }

  if (input.fidelity === 'full' || input.fidelity === 'partial') {
    return {
      ...base,
      status: 'active',
      reason:
        `The git watcher polls ${input.branch}, giving this run a liveness source independent ` +
        `of ${input.runnerKey}'s own reporting — the two can be compared, and disagreements ` +
        `between them are recorded rather than reconciled.`,
    };
  }

  return {
    ...base,
    status: 'degraded',
    reason:
      `The git watcher polls ${input.branch}, and on this run it is the ONLY liveness source: ` +
      `${input.runnerKey} ${
        input.fidelity === null
          ? 'has filed no capability manifest'
          : 'declares no streaming'
      }, so nothing corroborates or contradicts what git shows, and detection is bounded by ` +
      `the git poll interval.`,
  };
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

const SEVERITY: Record<CheckStatus, number> = {
  active: 0,
  degraded: 1,
  unavailable: 2,
};

function weakest(checks: CheckCoverage[]): CheckStatus {
  return checks.reduce<CheckStatus>(
    (worst, check) =>
      SEVERITY[check.status] > SEVERITY[worst] ? check.status : worst,
    'active',
  );
}

/** How many runs sit at each status, for one check. */
export interface CoverageTally {
  active: number;
  degraded: number;
  unavailable: number;
}

export type CoverageTallies = Record<WatchdogCheckId, CoverageTally>;

/**
 * Roll a sweep's worth of coverage into one fleet-wide picture.
 *
 * The sweep already counts `loopCheckUnavailable`, and this does NOT replace
 * it — the two count different things on purpose. That counter is how many
 * loop checks were ATTEMPTED and could not run this tick; this tally is how
 * many judged runs are on a runner that can never support the check at all.
 * The first is an event, the second is a standing condition, and an operator
 * watching the second go up has learned something about their fleet rather
 * than about their tick.
 *
 * Cheap by construction: arithmetic over data the sweep already loaded, with
 * no query of its own. This runs on every tick.
 */
export function tallyCoverage(coverages: RunCheckCoverage[]): CoverageTallies {
  const tallies = Object.fromEntries(
    WATCHDOG_CHECKS.map((check) => [
      check,
      { active: 0, degraded: 0, unavailable: 0 },
    ]),
  ) as CoverageTallies;

  for (const coverage of coverages) {
    for (const check of coverage.checks) {
      tallies[check.check][check.status] += 1;
    }
  }

  return tallies;
}
