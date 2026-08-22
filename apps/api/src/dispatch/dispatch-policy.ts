import type { RunnerCapabilities, RunnerNeed } from '../runners/runner.types';

/**
 * Which runner gets a work order, decided by arithmetic.
 *
 * VISION §6 states the constraint the whole seam rests on:
 *
 * > Routing matches a work order's declared *needs* against advertised
 * > capabilities. **Work orders never name a runner.**
 *
 * VISION §3.1 and §7 say how: dispatch is **code, not model**. §7 puts dispatch
 * decisions in the always-on hot path, where *"a model makes it slower,
 * costlier, and less reliable with no upside."* So everything here is a pure
 * function over plain data — no clock, no database, no randomness, nothing to
 * mock. A dispatch decision must be reproducible from its inputs a year later,
 * because the reason it made is part of the provenance record.
 */

/** How a runner is doing right now, as routing needs to see it. */
export interface RunnerPoolEntry {
  capabilities: RunnerCapabilities;
  /** False for a runner an operator has turned off. */
  enabled: boolean;
  /** Runs currently occupying this runner's concurrency. */
  liveRuns: number;
}

export interface DispatchLimits {
  /** Across every runner. Null means no global ceiling. */
  globalMaxConcurrent: number | null;
  /** Live runs across the whole fleet right now. */
  globalLiveRuns: number;
  /**
   * The operator has accepted that a preview runner will be load-bearing.
   *
   * See docs/adr/0007-preview-runner-acknowledgement.md. VISION §11 requires a
   * GA fallback for every preview runner; VISION §3.7 forbids building a second
   * runner before it is needed. With one runner the fallback cannot exist, so
   * without this the only runner is permanently ineligible.
   *
   * What is kept is "never SILENTLY load-bearing" — the acknowledgement is a
   * deployment decision and it is named in the recorded reason, not just in a
   * config file. What is given up is "never load-bearing", which a
   * single-runner fleet cannot honour by construction.
   */
  allowPreviewWithoutGaFallback?: boolean;
}

export type DispatchOutcome = 'dispatch' | 'queued';

/**
 * Why a work order is not being dispatched.
 *
 * Distinct values rather than one "not now", because they call for completely
 * different responses: a missing capability needs a runner registered, a full
 * runner needs waiting, and a preview runner without a fallback needs somebody
 * to notice the fleet is one outage from being unable to work at all.
 */
export type QueueReason =
  | 'no-runners-registered'
  | 'no-runner-has-the-capabilities'
  | 'capable-runners-are-at-capacity'
  | 'global-concurrency-reached'
  | 'only-preview-runners-and-no-ga-fallback';

/** What routing concluded about one runner. */
export interface CandidateVerdict {
  runnerKey: string;
  eligible: boolean;
  /** One line naming the specific fact that decided it. */
  reason: string;
  /** Needs this runner does not advertise. Empty when it meets them all. */
  unmetNeeds: RunnerNeed[];
  /** Runs it could still take. Zero means full. */
  headroom: number;
}

export interface DispatchDecision {
  outcome: DispatchOutcome;
  /** The chosen runner's key, or null when queued. */
  runnerKey: string | null;
  queueReason: QueueReason | null;
  /**
   * Why, naming the facts.
   *
   * #64: *"selection is deterministic and its reasoning is recorded."* Same
   * standard as the diff engine's actions (#47): a reviewer must be able to
   * reconstruct the decision from this line and the verdicts alone, without
   * reading code.
   */
  reason: string;
  /** Every runner considered, in the order routing ranked them. */
  candidates: CandidateVerdict[];
}

/**
 * Whether one capability manifest satisfies one declared need.
 *
 * A closed mapping rather than a lookup by string, so a need added to the
 * union without a rule here fails to compile. A need that silently matched
 * everything would route work to a runner that cannot do it, and the failure
 * would surface as a broken run rather than as a routing error.
 */
export function satisfies(need: RunnerNeed, capabilities: RunnerCapabilities): boolean {
  switch (need) {
    case 'full-streaming':
      return capabilities.streamingFidelity === 'full';
    case 'cost-reporting':
      return capabilities.reportsCost;
    case 'structured-rate-limits':
      return capabilities.rateLimitSignal === 'structured';
    case 'own-infrastructure':
      return capabilities.executionLocus === 'own_infrastructure';
  }
}

/** Needs this runner cannot meet. */
export function unmetNeeds(
  needs: readonly RunnerNeed[],
  capabilities: RunnerCapabilities,
): RunnerNeed[] {
  return needs.filter((need) => !satisfies(need, capabilities));
}

/**
 * A runner Opifex is not willing to depend on.
 *
 * VISION §11: preview-tier runners may never be load-bearing. `stable` is GA;
 * everything else is preview, and the tier is what the runner ITSELF declared
 * — a runner that calls itself experimental is taken at its word.
 */
export function isPreview(capabilities: RunnerCapabilities): boolean {
  return capabilities.stabilityTier !== 'stable';
}

/**
 * Choose a runner, or say precisely why not.
 *
 * ## The preview rule, and why it is checked against the pool rather than the winner
 *
 * VISION §11 requires *"every preview runner needs a GA fallback accepting
 * identical work orders."* The check is therefore not "is this runner stable"
 * — it is "if this preview runner vanished, could a stable one take this exact
 * work order". That means looking for a `stable` runner meeting the SAME
 * needs, whether or not it currently has headroom: a fallback that is
 * momentarily full is still a fallback, while one that cannot meet the needs
 * at all was never one.
 *
 * Getting this backwards is how a fleet ends up quietly load-bearing on
 * something its own vendor calls a preview.
 */
export function decideDispatch(
  input: {
    needs: readonly RunnerNeed[];
    /** Only for the reason line. Routing never branches on it. */
    identity?: string;
  },
  pool: readonly RunnerPoolEntry[],
  limits: DispatchLimits,
): DispatchDecision {
  const enabled = pool.filter((entry) => entry.enabled);

  if (enabled.length === 0) {
    return queued(
      'no-runners-registered',
      pool.length === 0
        ? 'No runners are registered.'
        : `All ${pool.length} registered runner(s) are disabled.`,
      pool.map((entry) => ({
        runnerKey: entry.capabilities.key,
        eligible: false,
        reason: 'disabled by an operator',
        unmetNeeds: [],
        headroom: 0,
      })),
    );
  }

  // Global capacity is checked BEFORE per-runner, because it is the answer
  // that does not depend on which runner would have been chosen — reporting
  // "runner X is full" when the real limit is the fleet's would send somebody
  // to raise the wrong number.
  if (limits.globalMaxConcurrent !== null && limits.globalLiveRuns >= limits.globalMaxConcurrent) {
    return queued(
      'global-concurrency-reached',
      `The fleet is at its global limit of ${limits.globalMaxConcurrent} concurrent run(s).`,
      enabled.map((entry) => verdict(entry, input.needs, false, 'the fleet is at its global limit')),
    );
  }

  const hasGaFallback = (needs: readonly RunnerNeed[]): boolean =>
    enabled.some(
      (entry) => !isPreview(entry.capabilities) && unmetNeeds(needs, entry.capabilities).length === 0,
    );

  const candidates = enabled
    .map((entry) => {
      const unmet = unmetNeeds(input.needs, entry.capabilities);
      const headroom = Math.max(0, entry.capabilities.maxConcurrency - entry.liveRuns);

      if (unmet.length > 0) {
        return verdict(entry, input.needs, false, `does not advertise ${unmet.join(', ')}`);
      }
      if (isPreview(entry.capabilities) && !hasGaFallback(input.needs)) {
        // The one rejection that is about the FLEET rather than the runner.
        if (!limits.allowPreviewWithoutGaFallback) {
          return verdict(
            entry,
            input.needs,
            false,
            `declares stability tier '${entry.capabilities.stabilityTier}' and no GA runner can ` +
              `take this work order, so selecting it would make a preview runner load-bearing`,
          );
        }
        // Eligible, and the reason SAYS why it was allowed. #64 requires the
        // decision be reconstructible from the reason alone, and "this ran on
        // a preview runner because somebody accepted that" is exactly the fact
        // a reader six weeks later needs and cannot recover from anywhere else.
        if (headroom > 0) {
          return verdict(
            entry,
            input.needs,
            true,
            `declares stability tier '${entry.capabilities.stabilityTier}' with no GA fallback, ` +
              'permitted because the operator has acknowledged a load-bearing preview runner',
          );
        }
      }
      if (headroom === 0) {
        return verdict(
          entry,
          input.needs,
          false,
          `is at its concurrency limit of ${entry.capabilities.maxConcurrency}`,
        );
      }

      return verdict(entry, input.needs, true, 'meets every declared need and has headroom');
    })
    .sort(byPreference);

  const chosen = candidates.find((candidate) => candidate.eligible);

  if (!chosen) {
    return queued(diagnose(candidates), explain(candidates, input.needs), candidates);
  }

  const needsText =
    input.needs.length === 0 ? 'no specific capabilities' : input.needs.join(', ');

  return {
    outcome: 'dispatch',
    runnerKey: chosen.runnerKey,
    queueReason: null,
    reason:
      `Dispatch to ${chosen.runnerKey}: it ${chosen.reason} (${needsText}), ` +
      `with ${chosen.headroom} slot(s) free. ` +
      `Considered ${candidates.length} runner(s).`,
    candidates,
  };
}

/**
 * The total order routing ranks candidates by.
 *
 * Deterministic to the last tiebreak, on purpose: a decision that depended on
 * database row order or object key order would be unreproducible, and the
 * reason recorded alongside it would then describe a choice nobody could
 * arrive at again.
 *
 *  1. Eligible before ineligible, so the winner is `candidates[0]` when one
 *     exists and the list reads as a ranking.
 *  2. More headroom first — spread work rather than saturating one runner,
 *     which keeps a single runner's failure from taking every live run with it.
 *  3. Key alphabetically. Arbitrary, and that is the point: two runners
 *     identical on everything above must still order the same way every time.
 */
function byPreference(a: CandidateVerdict, b: CandidateVerdict): number {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.headroom !== b.headroom) return b.headroom - a.headroom;
  return a.runnerKey.localeCompare(b.runnerKey);
}

/**
 * Which of several failures to report.
 *
 * Ordered by what the operator would have to DO about it. "Nothing can meet
 * these needs" needs a runner registered; "everything capable is busy" needs
 * only patience; the preview case needs somebody to notice the fleet has no
 * GA option at all. Reporting the mildest of several would understate the
 * problem.
 */
function diagnose(candidates: readonly CandidateVerdict[]): QueueReason {
  const capable = candidates.filter((candidate) => candidate.unmetNeeds.length === 0);

  if (capable.length === 0) return 'no-runner-has-the-capabilities';
  if (capable.every((candidate) => candidate.reason.includes('preview runner load-bearing'))) {
    return 'only-preview-runners-and-no-ga-fallback';
  }
  return 'capable-runners-are-at-capacity';
}

function explain(candidates: readonly CandidateVerdict[], needs: readonly RunnerNeed[]): string {
  const needsText = needs.length === 0 ? 'no specific capabilities' : needs.join(', ');

  return (
    `Queued: no runner can take this work order (needs ${needsText}). ` +
    candidates.map((candidate) => `${candidate.runnerKey} ${candidate.reason}`).join('; ') +
    '.'
  );
}

function verdict(
  entry: RunnerPoolEntry,
  needs: readonly RunnerNeed[],
  eligible: boolean,
  reason: string,
): CandidateVerdict {
  return {
    runnerKey: entry.capabilities.key,
    eligible,
    reason,
    unmetNeeds: unmetNeeds(needs, entry.capabilities),
    headroom: Math.max(0, entry.capabilities.maxConcurrency - entry.liveRuns),
  };
}

function queued(
  queueReason: QueueReason,
  reason: string,
  candidates: CandidateVerdict[],
): DispatchDecision {
  // Queued, never failed. #64: "a work order with no capable runner queues
  // with a clear reason rather than failing." A failure would need somebody to
  // re-dispatch it by hand once a runner appeared; a queued work order is
  // picked up by the next tick that can serve it.
  return { outcome: 'queued', runnerKey: null, queueReason, reason, candidates };
}
