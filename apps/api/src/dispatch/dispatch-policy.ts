import type {
  ModelTier,
  RunnerCapabilities,
  RunnerNeed,
} from '../runners/runner.types';

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

/**
 * What is known about one runner's quota, ALREADY RESOLVED against a clock.
 *
 * ## Why this is resolved outside and passed in
 *
 * "Is this runner out of quota" is a question about now, and `decideDispatch`
 * has no now — see this file's header. So the caller
 * (`DispatchService.loadPool`, which owns a clock and a database) does the
 * comparison and hands the ANSWER in. Nothing here compares `resumesAt` to
 * anything; it exists only to be printed.
 *
 * ## It is binary and dated, not a percentage
 *
 * Both things Opifex observes are first-hand and already recorded: runs of
 * this runner sitting `blocked` on a rate-limit reason with a reset time still
 * in the future (#105), and vendor rate-limit lines the runner emitted while
 * still serving (#231). Each supports exactly one claim — *this runner is out
 * of quota until T*, or *it had room at time U* — and no fraction of headroom
 * is derivable from either, because no vendor publishes a capacity to divide
 * by (see `quota/quota-window.ts`).
 *
 * There are now two producers and this is still ONE field, which held: #231
 * populated this same shape with a better basis, #285 stated the precedence
 * between them in `DispatchService`, and the routing rule below did not
 * change. It still reads one already-resolved fact and does not know, or need
 * to know, which source produced it — `basis` says so for the record.
 *
 * ## Absent means UNKNOWN, and unknown is usable
 *
 * A runner that has simply never blocked has no quota position at all, which is
 * why the field on `RunnerPoolEntry` is optional. VISION §6 is explicit that
 * unknown is not zero: an absent position must route as freely as a healthy
 * one, never as an exhausted one. `exhausted: false` stays representable so a
 * future meter can assert availability positively rather than by silence.
 */
export interface RunnerQuotaPosition {
  /** True only when an observed, dated block is still in force. */
  exhausted: boolean;
  /**
   * When it lifts, ISO 8601, or null when nothing could date it.
   *
   * A pre-formatted string rather than a `Date` on purpose: a `Date` invites
   * exactly the comparison this function must not make, and a string keeps the
   * whole input JSON-round-trippable — which is what "reproducible from its
   * inputs a year later" means in practice.
   */
  resumesAt: string | null;
  /** The observation this was derived from, named in the recorded reason. */
  basis: string;
}

/** How a runner is doing right now, as routing needs to see it. */
export interface RunnerPoolEntry {
  capabilities: RunnerCapabilities;
  /** False for a runner an operator has turned off. */
  enabled: boolean;
  /** Runs currently occupying this runner's concurrency. */
  liveRuns: number;
  /**
   * Its quota position, or undefined when NEITHER source knows anything.
   *
   * Resolved before it gets here, from the blocked-run signal (#105) and the
   * runner's own meter (#231), by the precedence rule #285 states in
   * `DispatchService`. Undefined is UNKNOWN and routes freely.
   *
   * Note this is NOT how Opifex limits its share of a shared subscription.
   * VISION §11 notes automated runs compete with the operator's own
   * interactive use, and `RunnerCapabilities.maxConcurrency` is already the
   * encoding of that competition — "the runner's own limit on how much of that
   * quota it will take, not a performance hint". This field is about quota that
   * is already SPENT, and deliberately adds no second mechanism for sharing it.
   */
  quota?: RunnerQuotaPosition;
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
  // Split from an empty fleet (#296), because the two are opposite events
  // wearing one name: nothing registered is a failure worth escalating
  // (#162's case), while every runner disabled is a human's deliberate switch
  // that must never page anyone. The reason sentence has always said which of
  // the two it was; saying it only in prose left the CODE asserting something
  // false, since a fleet of disabled runners is a fleet whose runners are
  // registered.
  | 'all-runners-disabled'
  | 'no-runner-has-the-capabilities'
  // Distinct from having no capable runner at all: these runners CAN do this
  // work, they just do not do it at the size asked for (#205). Distinct from
  // capacity for the stronger reason — a full runner frees a slot on its own,
  // while no amount of waiting adds a tier to a manifest, so the only fixes
  // are to change the tier the work order asks for or to register a runner
  // that serves it.
  | 'no-runner-serves-the-model-tier'
  | 'capable-runners-are-at-capacity'
  // Distinct from being at capacity, because the two need different patience
  // and different fixes: a full runner frees a slot when one of ITS runs ends,
  // while an exhausted one waits on a vendor window nothing here controls, and
  // the standing answer to it is a second runner with separate quota (#105).
  | 'capable-runners-quota-exhausted'
  | 'global-concurrency-reached'
  | 'only-preview-runners-and-no-ga-fallback'
  // The three spend refusals (#65). They queue rather than fail for the same
  // reason capacity does: the work order is fine, the money is not, and both
  // are conditions that can change without the order being rewritten. They
  // stay three values rather than one because they need three different
  // responses — set a ceiling, wait for the window to roll, and fix an order
  // or its routing, respectively.
  | 'no-hard-spend-ceiling-configured'
  | 'hard-spend-ceiling-reached'
  | 'work-order-cannot-be-budgeted';

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
  /**
   * Its quota position as routing saw it (#105), when one was known.
   *
   * Recorded on every verdict, not only on the runner it disqualified: "the
   * runner we chose had no known quota problem" is part of reconstructing the
   * decision, and undefined here says honestly that nothing was observed.
   */
  quota?: RunnerQuotaPosition;
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
  /**
   * True when quota-aware routing moved work that would otherwise have parked.
   *
   * The countable event behind #105's justification: at least one runner that
   * could have taken this work order was out of quota, and a DIFFERENT capable
   * runner took it instead. Counting these over time is the before-and-after
   * measure of VISION §10's metric 2.
   *
   * It is the event, not the arithmetic. A park that did not happen has no
   * duration to measure — turning one into "hours saved" would need an
   * estimate of how long it WOULD have lasted, which is a guess wearing a
   * measurement's clothes. So this says only "a park was avoided here", and
   * claims nothing about how many minutes that saved.
   *
   * Always false on a queued decision: nothing moved.
   *
   * Derived from `avoidedPark` at the single site that builds it, so the two
   * cannot drift: true exactly when `avoidedPark !== null`.
   */
  avoidedQuotaPark: boolean;
  /**
   * The same event, with the facts that make it explainable (#264).
   *
   * Non-null exactly when `avoidedQuotaPark` is true. It exists because a bare
   * integer is not actionable: *"work moved off claude-code-local 14 times
   * while it was rate-limited"* names a runner an operator can go and look at,
   * and *"14"* does not.
   *
   * These facts cannot be recovered from `candidates` afterwards. A verdict
   * carries its runner's `quota` position whether or not that position is what
   * disqualified it, and the one thing that would separate "capable but out of
   * quota" from "rejected for its tier, and also out of quota" is the reason
   * PROSE — which nothing downstream may parse, on the same grounds routing
   * itself never parses it. So the policy states it, because the policy is the
   * only place that knows.
   */
  avoidedPark: AvoidedPark | null;
}

/**
 * One capable runner that was observably out of quota when routing decided.
 *
 * "Capable" means the same thing here it means in the decision: it met every
 * declared need AND served the requested tier. A runner rejected for its tier
 * is not an alternative this work order lost, and counting it as one would
 * inflate the very number #105 is judged by.
 */
export interface ExhaustedRunner {
  runnerKey: string;
  /**
   * When its window rolls, ISO 8601, or null when nothing could date it.
   *
   * Carried verbatim from `RunnerQuotaPosition.resumesAt` — a string rather
   * than a `Date` for the reason stated there, and because the one arithmetic
   * it invites (`resumesAt − now`, "how long the park would have been") is
   * precisely the counterfactual #264 exists to refuse.
   */
  resumesAt: string | null;
  /** The observation the exhaustion rests on, verbatim. */
  basis: string;
}

/**
 * A park that quota-aware routing prevented, as a record rather than a flag.
 *
 * ONE of these per dispatch, never one per exhausted runner: two spent runners
 * and a third that took the work is a single avoided park. Counting rows has
 * to equal counting events, or the number stops meaning what its label says.
 */
export interface AvoidedPark {
  /** The runner that took the work instead. */
  chosenRunnerKey: string;
  /** Every capable runner that was spent, ordered by key. Never empty. */
  exhausted: ExhaustedRunner[];
}

/**
 * Whether one capability manifest satisfies one declared need.
 *
 * A closed mapping rather than a lookup by string, so a need added to the
 * union without a rule here fails to compile. A need that silently matched
 * everything would route work to a runner that cannot do it, and the failure
 * would surface as a broken run rather than as a routing error.
 */
export function satisfies(
  need: RunnerNeed,
  capabilities: RunnerCapabilities,
): boolean {
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

/**
 * Whether a runner can serve the tier this work order asked for (#205).
 *
 * Absent on the work order means the runner's own default is fine. Absent on
 * the manifest means the runner serves anything — which is what keeps the field
 * additive in behaviour as well as in schema: a runner written before tiers
 * existed stays eligible for everything, rather than becoming ineligible for
 * work it had been taking all along.
 *
 * Deliberately separate from `satisfies`. The `needs` enum is closed and its
 * mapping is exhaustive by design, so folding a tier into it would mean either
 * a major schema bump (ADR-0010: adding an enum value is breaking, because
 * consumers switch on the set) or a need whose rule is not a capability at all.
 */
export function servesTier(
  modelTier: ModelTier | undefined,
  capabilities: RunnerCapabilities,
): boolean {
  if (!modelTier) return true;
  const served = capabilities.modelTiers;
  if (!served || served.length === 0) return true;
  return served.includes(modelTier);
}

/**
 * Whether a runner can take work right now (#253).
 *
 * ABSENT MEANS AVAILABLE, and the whole function exists to make that hard to
 * get wrong: `!capabilities.available` reads a manifest that has never heard of
 * the field as unavailable, which would ground every runner written before it
 * — the same trap `servesTier` avoids for `modelTiers`, and the reason both are
 * functions rather than inline truthiness tests.
 *
 * Availability is NOT capacity and NOT the operator's switch. A runner with
 * `available: false` still declares its real `maxConcurrency`, because the
 * slots exist and are momentarily unusable; and `RunnerPoolEntry.enabled` is
 * still the flag a human sets. Three facts, three fields, three different
 * things for an operator to do about them.
 */
export function isAvailable(capabilities: RunnerCapabilities): boolean {
  return capabilities.available !== false;
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
 *
 * ## The quota rule, and why it is checked where it is
 *
 * #105: *"quota is a tiebreaker among capable runners, not an override."* So
 * the quota check sits strictly AFTER `unmetNeeds` and `servesTier` — a runner
 * with quota to spare and the wrong capabilities is rejected before its quota
 * is ever looked at, which makes "capability requirements are never relaxed for
 * quota reasons" a property of the control flow rather than of somebody's care.
 *
 * It sits strictly BEFORE the preview branch for the mirror-image reason: that
 * branch can return ELIGIBLE (for an acknowledged preview runner), and no path
 * may return eligible for a runner that is known to be out of quota. The cost
 * is that a preview runner which is also exhausted reports the quota fact
 * rather than the structural one; the structural one comes back the moment its
 * quota does, and dispatching into a spent quota does not.
 */
export function decideDispatch(
  input: {
    needs: readonly RunnerNeed[];
    /** The model class this work asked for, if it asked (#205). */
    modelTier?: ModelTier;
    /** Only for the reason line. Routing never branches on it. */
    identity?: string;
  },
  pool: readonly RunnerPoolEntry[],
  limits: DispatchLimits,
): DispatchDecision {
  const enabled = pool.filter((entry) => entry.enabled);

  if (enabled.length === 0) {
    // One condition, asked once and answered in both the code and the
    // sentence, so the two cannot come to disagree.
    const nothingRegistered = pool.length === 0;
    return queued(
      nothingRegistered ? 'no-runners-registered' : 'all-runners-disabled',
      nothingRegistered
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
  if (
    limits.globalMaxConcurrent !== null &&
    limits.globalLiveRuns >= limits.globalMaxConcurrent
  ) {
    return queued(
      'global-concurrency-reached',
      `The fleet is at its global limit of ${limits.globalMaxConcurrent} concurrent run(s).`,
      enabled.map((entry) =>
        verdict(entry, input.needs, false, 'the fleet is at its global limit'),
      ),
    );
  }

  const hasGaFallback = (needs: readonly RunnerNeed[]): boolean =>
    enabled.some(
      (entry) =>
        !isPreview(entry.capabilities) &&
        unmetNeeds(needs, entry.capabilities).length === 0 &&
        // The fallback has to be able to take THIS work order, tier included.
        // A stable runner that cannot serve the requested tier is not a
        // fallback for it, and counting it as one is how a fleet ends up
        // load-bearing on a preview runner without noticing.
        servesTier(input.modelTier, entry.capabilities),
    );

  // Capable runners whose quota is observably spent — computed from the pool
  // rather than read back out of the verdict text, so "capable" here means the
  // same thing it means above: meets every need AND serves the tier. A runner
  // rejected for its tier is not an alternative this work order lost, and
  // counting it as one would inflate the very metric #105 is judged by.
  //
  // Kept as ENTRIES rather than only keys since #264, because the reset time
  // and the basis sentence are what make the persisted count explainable, and
  // both live on the pool entry. The key set below is derived from it, so the
  // two are one fact rather than two.
  const quotaExhaustedEntries = enabled.filter(
    (entry) =>
      entry.quota?.exhausted === true &&
      unmetNeeds(input.needs, entry.capabilities).length === 0 &&
      servesTier(input.modelTier, entry.capabilities),
  );
  const quotaExhaustedCapable = new Set(
    quotaExhaustedEntries.map((entry) => entry.capabilities.key),
  );

  // The two refusals `diagnose` classifies on that cannot be read back off a
  // verdict, recorded AT THE BRANCH THAT DECIDES THEM rather than re-derived
  // afterwards. Both are invisible in `CandidateVerdict`: a runner refused for
  // its tier has an empty `unmetNeeds` exactly like an eligible one, and the
  // preview refusal is a fact about the FLEET that leaves no field behind at
  // all. Recording them here rather than re-testing the conditions below
  // keeps them in step with the branch order — a re-derivation would have to
  // restate that a preview runner which is also out of quota reports quota,
  // and would drift the first time the order changed.
  const refusedForTier = new Set<string>();
  const refusedAsLoadBearingPreview = new Set<string>();

  const candidates = enabled
    .map((entry) => {
      const unmet = unmetNeeds(input.needs, entry.capabilities);
      const headroom = Math.max(
        0,
        entry.capabilities.maxConcurrency - entry.liveRuns,
      );

      if (unmet.length > 0) {
        return verdict(
          entry,
          input.needs,
          false,
          `does not advertise ${unmet.join(', ')}`,
        );
      }
      if (!servesTier(input.modelTier, entry.capabilities)) {
        // Refused rather than dispatched-and-hoped: a runner that cannot serve
        // the tier would run the work at whatever size it does have, which is
        // the quota decision VISION §11 wants made deliberately.
        refusedForTier.add(entry.capabilities.key);
        return verdict(
          entry,
          input.needs,
          false,
          `serves model tier(s) ${entry.capabilities.modelTiers?.join(', ')} ` +
            `and this work order asked for '${input.modelTier}'`,
        );
      }
      if (!isAvailable(entry.capabilities)) {
        // Sits with the quota check rather than with capacity, because it is
        // the same KIND of fact: a transient condition the runner reported
        // about itself, after the structural questions — does it advertise the
        // needs, does it serve the tier — have already been answered. A runner
        // that could never do this work should say so rather than saying it is
        // temporarily unwell.
        //
        // The reason is the runner's own sentence, printed verbatim. Routing
        // branches on the boolean and never on the prose: a reason string the
        // policy parsed would be a capability in disguise.
        return verdict(
          entry,
          input.needs,
          false,
          entry.capabilities.unavailableReason
            ? `reports it cannot take work right now: ${entry.capabilities.unavailableReason}`
            : 'reports it cannot take work right now, and gave no reason',
        );
      }
      if (entry.quota?.exhausted) {
        // Queued, not dispatched-and-hoped. Sending work to a runner already
        // known to be out of quota buys a blocked run, another attempt on the
        // ceiling and another park — the dead time #105 exists to remove.
        return verdict(
          entry,
          input.needs,
          false,
          entry.quota.resumesAt
            ? `is out of quota until ${entry.quota.resumesAt} (${entry.quota.basis})`
            : `is out of quota (${entry.quota.basis})`,
        );
      }
      if (isPreview(entry.capabilities) && !hasGaFallback(input.needs)) {
        // The one rejection that is about the FLEET rather than the runner.
        if (!limits.allowPreviewWithoutGaFallback) {
          refusedAsLoadBearingPreview.add(entry.capabilities.key);
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

      return verdict(
        entry,
        input.needs,
        true,
        'meets every declared need and has headroom',
      );
    })
    .sort(byPreference);

  const chosen = candidates.find((candidate) => candidate.eligible);

  if (!chosen) {
    return queued(
      diagnose(candidates, {
        tier: refusedForTier,
        loadBearingPreview: refusedAsLoadBearingPreview,
        quotaExhausted: quotaExhaustedCapable,
      }),
      explain(candidates, input.needs),
      candidates,
    );
  }

  const needsText =
    input.needs.length === 0
      ? 'no specific capabilities'
      : input.needs.join(', ');

  // The chosen runner can never be in that set — the check above rejects an
  // exhausted runner outright — so this reads "somebody else was out of quota
  // and this work moved anyway", which is exactly the countable event.
  //
  // Built as the RECORD, with the boolean derived from it one line later.
  // Two fields that had to be kept in agreement by hand would eventually
  // disagree, and the shape that disagrees silently is the one where a
  // persisted count and a logged flag stop matching.
  const avoidedPark: AvoidedPark | null =
    quotaExhaustedCapable.size > 0 &&
    !quotaExhaustedCapable.has(chosen.runnerKey)
      ? {
          chosenRunnerKey: chosen.runnerKey,
          exhausted: quotaExhaustedEntries
            .map((entry) => ({
              runnerKey: entry.capabilities.key,
              // Non-null by construction — `exhausted` is only ever set
              // alongside these — but read defensively rather than asserted,
              // because a pure function must not throw on a pool somebody
              // hand-built for a test.
              resumesAt: entry.quota?.resumesAt ?? null,
              basis: entry.quota?.basis ?? 'reported out of quota',
            }))
            .sort((a, b) => a.runnerKey.localeCompare(b.runnerKey)),
        }
      : null;
  const avoidedQuotaPark = avoidedPark !== null;

  return {
    outcome: 'dispatch',
    runnerKey: chosen.runnerKey,
    queueReason: null,
    reason:
      `Dispatch to ${chosen.runnerKey}: it ${chosen.reason} (${needsText}), ` +
      `with ${chosen.headroom} slot(s) free. ` +
      `Considered ${candidates.length} runner(s).` +
      (avoidedQuotaPark
        ? ` Quota-aware routing avoided a park: ${[...quotaExhaustedCapable]
            .sort()
            .join(', ')} could have taken this work order but ` +
          `${quotaExhaustedCapable.size === 1 ? 'is' : 'are'} out of quota.`
        : ''),
    candidates,
    avoidedQuotaPark,
    avoidedPark,
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
 *
 * Quota exhaustion slots in ABOVE capacity and below the preview case, and the
 * ordering is the point rather than an accident of where it was appended. A
 * full runner is the factory working — a slot frees when one of its own runs
 * ends, and the operator does nothing. An exhausted one is the factory unable
 * to work at all until a window nothing here controls rolls over, which is the
 * dead time VISION §1 opens with; it is reported whenever it is present among
 * capable runners, not only when it is the sole cause, because "a capable
 * runner is out of quota until T" is the more serious of the two and the one
 * whose standing answer (register a second runner) an operator can act on.
 *
 * The tier refusal sits between the two structural failures rather than beside
 * capacity, and the difference is the whole point: a runner refused for its
 * tier meets every declared need, so classifying on `unmetNeeds` alone counted
 * it as capable and reported the fleet as merely BUSY (#296). Waiting is then
 * exactly the wrong response — the tier is not a queue that drains.
 *
 * Excluding those runners narrows every judgement below it too, which is the
 * same correction applied further down: "all the capable runners are preview"
 * and "a capable runner is out of quota" are both claims about the runners
 * that could actually take THIS work order, and a runner that does not serve
 * its tier is not one of them.
 *
 * Every set is passed in rather than recovered from the verdict text: a
 * `reason.includes(...)` on a sentence written for humans is a coupling that
 * breaks silently the first time the sentence is reworded. That rule was
 * stated here and broken three lines below it until #296 — the preview branch
 * matched on its own prose, so rewording one sentence would have stopped
 * `only-preview-runners-and-no-ga-fallback` being reported, with every test
 * that asserts the sentence still passing.
 */
function diagnose(
  candidates: readonly CandidateVerdict[],
  refused: {
    /** Met every need, but does not serve the requested tier. */
    tier: ReadonlySet<string>;
    /** Preview, with no GA fallback and no acknowledgement. */
    loadBearingPreview: ReadonlySet<string>;
    /** Capable and observably out of quota. */
    quotaExhausted: ReadonlySet<string>;
  },
): QueueReason {
  const meetsNeeds = candidates.filter(
    (candidate) => candidate.unmetNeeds.length === 0,
  );

  if (meetsNeeds.length === 0) return 'no-runner-has-the-capabilities';

  // Narrowed in that order so each answer is TRUE rather than merely ranked:
  // with one runner short of a need and another short of the tier, "no runner
  // has the capabilities" is a false sentence — one of them has them — while
  // "none of the runners that can do this work serves the tier" is exact.
  const capable = meetsNeeds.filter(
    (candidate) => !refused.tier.has(candidate.runnerKey),
  );

  if (capable.length === 0) return 'no-runner-serves-the-model-tier';
  if (
    capable.every((candidate) =>
      refused.loadBearingPreview.has(candidate.runnerKey),
    )
  ) {
    return 'only-preview-runners-and-no-ga-fallback';
  }
  if (refused.quotaExhausted.size > 0) return 'capable-runners-quota-exhausted';
  return 'capable-runners-are-at-capacity';
}

function explain(
  candidates: readonly CandidateVerdict[],
  needs: readonly RunnerNeed[],
): string {
  const needsText =
    needs.length === 0 ? 'no specific capabilities' : needs.join(', ');

  return (
    `Queued: no runner can take this work order (needs ${needsText}). ` +
    candidates
      .map((candidate) => `${candidate.runnerKey} ${candidate.reason}`)
      .join('; ') +
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
    quota: entry.quota,
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
  return {
    outcome: 'queued',
    runnerKey: null,
    queueReason,
    reason,
    candidates,
    // Nothing moved, so there is nothing to count. A queued decision on an
    // exhausted fleet is the OLD behaviour still working (#56 parks it), not
    // this feature doing something.
    avoidedQuotaPark: false,
    avoidedPark: null,
  };
}
