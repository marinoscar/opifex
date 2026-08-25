import type { PromotionChangeReason, PromotionRung } from '@prisma/client';

import {
  ACTION_CLASSES,
  type ActionClassId,
} from '../supervisor/action-classes';

/**
 * The thresholds, and the pure decision they drive (#99, VISION §7).
 *
 * No Prisma, no Nest, no clock. Everything here is a function of numbers that
 * were already gathered, so the arguments below can be tested by stating them
 * rather than by simulating a month of factory history — which is the only way
 * a threshold argument stays checkable once someone wants to change it.
 */

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * The fewest human decisions a class may be promoted on.
 *
 * #99 puts it plainly: "three-for-three is not evidence." The number needs an
 * argument rather than a vibe, and the argument is about LEVERAGE. At a sample
 * of 3, one bad call moves the rate by thirty-three points; at 20, it moves it
 * by five. Twenty is roughly where a single unlucky decision stops being able
 * to carry a class across the promotion line on its own, which is precisely
 * the failure "three-for-three is not evidence" is naming.
 *
 * It is a JUDGEMENT, not a derivation. There is no confidence interval behind
 * it and pretending otherwise would be worse than admitting it — a fake
 * derivation is a number nobody feels entitled to argue with. Twenty human
 * decisions is also achievable inside VISION §7's "two to four weeks" of
 * observation for the classes that actually get proposed, which is the
 * constraint that stops this being set to 200 and making the ladder
 * decorative.
 */
export const MIN_SAMPLE = 20;

/** The approval rate a class must reach, over `MIN_SAMPLE` or more. */
export const PROMOTION_RATE = 0.9;

/**
 * The rate a PROMOTED class must stay above, and deliberately BELOW
 * `PROMOTION_RATE`.
 *
 * The gap is hysteresis, and it is the whole reason there are two numbers
 * instead of one. With a single threshold at 0.9, a class sitting near the
 * line crosses it on individual decisions: promote Tuesday, demote Wednesday,
 * promote Thursday. Each of those sends a notification, and an operator who
 * gets four contradictory notifications about `re-dispatch` in a week learns
 * to ignore all of them — including the one that matters. VISION §8 opens by
 * warning that operators grant blanket trust "out of friction, not
 * conviction"; a ladder that chatters is exactly that friction, manufactured
 * by us.
 *
 * The 0.9/0.7 band means a promoted class has to genuinely deteriorate — not
 * merely fail to keep improving — before autonomy is taken back. The cost of
 * the band is a real one and worth stating: a class drifting at 0.75 stays
 * promoted, running unattended at a quality nobody would have promoted it on.
 * That is the price of not crying wolf, and `demotionCount` on
 * `PromotionState` is what makes the band's failures visible if it turns out
 * to be set wrong.
 */
export const DEMOTION_RATE = 0.7;

/**
 * The fewest RECENT decisions a demotion may rest on.
 *
 * Five, against twenty for promotion, and the asymmetry is deliberate because
 * the two mistakes do not cost the same thing.
 *
 * Wrongly demoting costs a re-promotion: the class goes back to `measure`,
 * accumulates evidence, and climbs again. Nothing happened in the world that
 * anybody has to undo.
 *
 * Wrongly staying promoted costs unsupervised action — a class that has
 * started making bad calls continues making them, unattended, against a real
 * subscription, for however long the extra evidence takes to arrive. VISION §7
 * rung 4 makes demotion "automatic on regression, not a judgment call"
 * precisely because the human version of this decision never gets made, and a
 * demotion threshold set as cautiously as the promotion one would reproduce
 * that hesitation in code.
 *
 * So demotion is allowed to be jumpier than promotion. Asymmetric evidence
 * requirements are the correct answer to asymmetric costs.
 */
export const DEMOTION_MIN_SAMPLE = 5;

/**
 * How far back "recent" reaches, for demotion only.
 *
 * Demotion is assessed on a WINDOW; promotion is assessed on the lifetime
 * record. A class with a year of good history and a terrible fortnight must
 * demote, and a lifetime average cannot see that — 400 good decisions swamp 20
 * bad ones and the rate barely moves. The regression the ladder is looking for
 * is a change in behaviour, and a change is only visible against a window.
 *
 * Fourteen days rather than seven: at DEMOTION_MIN_SAMPLE = 5 a week is short
 * enough that a quiet class simply never has enough recent evidence to be
 * assessed at all, which would make demotion unreachable for exactly the
 * low-traffic classes where each bad decision matters most.
 */
export const REGRESSION_WINDOW_DAYS = 14;

/**
 * How long a HAND-DEMOTION holds a class off the promoted rung (#244).
 *
 * ## Why there is a hold at all
 *
 * Rule 5 promotes any non-promoted class whose lifetime record clears the bar,
 * and a hand-demotion leaves a class exactly there. Without a hold, the hourly
 * evaluation saw a non-promoted class with the same good numbers and put it
 * straight back — `promoted_on_evidence`, typically within the hour, as though
 * the operator had never acted. The anti-oscillation guard in rule 5 does not
 * cover this: it fires only when the class is currently FAILING the recent
 * window, which is the case the ladder would have demoted on its own. An
 * operator demoting a class with good numbers is acting on evidence the
 * numbers do not yet show, so the guard never fires for exactly the demotion
 * that needs it.
 *
 * ## Why it EXPIRES, and why at this number
 *
 * A permanent hold would be the failure VISION §7 rung 4 exists to eliminate,
 * running in reverse: a judgement call made once, in an afternoon, that
 * quietly becomes permanent policy because nobody ever revisits it. Nothing in
 * the system would ever remember to lift it, and "demoted once in anger" would
 * mean "off the ladder forever" — a class that could never be measured again,
 * whatever it went on to do. `TrustGrant.expiresAt` makes the same argument in
 * the other direction: a human's extension of trust gets a stated lifetime
 * rather than a permanent one, because silence should not be able to widen or
 * narrow authority forever.
 *
 * So it expires — and it is tied to `REGRESSION_WINDOW_DAYS` rather than being
 * an independent number, so the two cannot drift apart. The tie is the whole
 * argument. The operator demotes because they know something the record does
 * not yet contain; the regression window is exactly how long it takes for the
 * record to contain it. When the hold lifts, the class is re-judged on a
 * recent window that no longer includes anything the operator was reacting to,
 * and on evidence that has had a full window to show whether they were right.
 * If they were, rule 3 (regression) or rule 5's guard demotes it or refuses to
 * promote it, on the numbers, with no hold needed. If they were not, the class
 * promotes — which is the correct outcome.
 *
 * ## The expiry is not silent, which is the objection worth answering
 *
 * "It re-promotes on a timer" is only a problem if nobody is told. Three
 * things make sure somebody is: the demotion response reports the exact
 * instant the hold lifts, every read of the ladder carries `manualHoldUntil`
 * and this sentence, and the re-promotion itself sends a promotion
 * notification like any other. What #244 is actually about is a re-promotion
 * that happened within the hour, before the operator could observe anything at
 * all. A stated, visible, fortnight-long term with a notification at the end
 * of it is a different thing.
 */
export const MANUAL_HOLD_DAYS = REGRESSION_WINDOW_DAYS;

/**
 * The "lifetime" window, in days, for the sources that only accept one.
 *
 * `ApprovalGateService.approvalRatesByClass` takes `sinceDays` and has no
 * "all of it" argument. Ten years is not a policy choice — it is longer than
 * this system will plausibly hold approval history, so it reads as unbounded
 * while still producing a valid date. Named rather than inlined so nobody
 * later mistakes it for a retention decision.
 */
export const LIFETIME_WINDOW_DAYS = 3650;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Everything the ladder knows about one class, from both evidence sources.
 *
 * ## Why there are two sources and both are summed
 *
 * There are two records of "would a human have approved this", and they exist
 * at different times in the system's life:
 *
 *  - `SupervisorProposal.review` (#90) — a human judging a proposal in the
 *    review queue during VISION §7's observation phase. This is the evidence
 *    that exists TODAY.
 *  - `ApprovalRequest` decided with `decidedVia: 'human'` (#97) — a human
 *    answering a live approval gate.
 *
 * A ladder that counted only the second would have NO evidence at all until
 * the gate had been live for weeks, which would make the observation phase
 * pointless: the whole purpose of two to four weeks of proposals is that
 * somebody judges them, and refusing to count those judgements throws away the
 * only thing the phase produces. A ladder that counted only the first would
 * stop learning the moment the gate went live, freezing every class's record
 * at whatever the observation window happened to contain.
 *
 * So: both, summed, with `fromProposals`/`fromApprovals` recording which
 * contributed. The provenance is not decoration — a class promoted entirely on
 * review-queue judgements and a class promoted entirely on live gate answers
 * have earned the same rate through different acts, and #101 has to be able to
 * say which.
 *
 * ## What is NOT in here
 *
 * Timeouts and grant-authorized actions, from either source. Counting an
 * `auto_approved` timeout would let a class promote itself by being ignored;
 * counting a grant-authorized action would let a grant's own authorisations
 * re-attest to the trust that created them. Both exclusions already live in
 * `ApprovalGateService.approvalRatesByClass`, which is why this module
 * consumes that read model rather than querying `approval_requests` itself.
 * A second implementation of the exclusion is a second thing that can drift,
 * and the drift would show up as autonomy granted on evidence nobody produced.
 */
export interface ClassEvidence {
  actionClass: string;

  /** Human approvals, both sources, over the lifetime window. */
  approved: number;
  /** Human rejections, both sources, over the lifetime window. */
  rejected: number;
  /** `approved + rejected`. The promotion denominator. */
  sample: number;
  /**
   * `approved / sample`, or NULL when `sample` is 0.
   *
   * Null, not zero. 0/0 is NO EVIDENCE; rendering it as a 0% approval rate
   * says the opposite — that humans reject this class every time they see it.
   * Both upstream read models make the same choice for the same reason, and
   * the ladder would undo it by defaulting to 0 here.
   */
  rate: number | null;

  /** The same three counts, restricted to `REGRESSION_WINDOW_DAYS`. */
  recentApproved: number;
  recentRejected: number;
  recentSample: number;
  recentRate: number | null;

  /** How much of `sample` came from `SupervisorProposal.review` (#90). */
  fromProposals: number;
  /** How much of `sample` came from human `ApprovalRequest` decisions (#97). */
  fromApprovals: number;
}

/** An evidence record for a class nothing has ever been judged on. */
export function emptyEvidence(actionClass: string): ClassEvidence {
  return {
    actionClass,
    approved: 0,
    rejected: 0,
    sample: 0,
    rate: null,
    recentApproved: 0,
    recentRejected: 0,
    recentSample: 0,
    recentRate: null,
    fromProposals: 0,
    fromApprovals: 0,
  };
}

/** `approved / (approved + rejected)`, or null when nothing was decided. */
export function rateOf(approved: number, rejected: number): number | null {
  const total = approved + rejected;
  return total === 0 ? null : approved / total;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What the ladder concluded about one class this tick.
 *
 * `hold` carries a `detail` for the same reason promote and demote do: #101
 * shows "what would be needed to promote", and a hold that said only "no" would
 * leave that sentence to be reconstructed by the read layer from thresholds it
 * would then own a second copy of.
 */
export type LadderVerdict =
  | { action: 'promote'; reason: string }
  | { action: 'demote'; reason: PromotionChangeReason; detail: string }
  | { action: 'hold'; detail: string };

/**
 * A hand-demotion's hold over a class, ALREADY RESOLVED to be standing.
 *
 * `evaluateLadder` is a pure function and stays one: it never asks what time
 * it is, so it cannot decide whether a hold has expired. The caller does that
 * — it holds the row and the clock — and passes either `null` ("no hold is in
 * force") or this ("a hold is in force, and here is what to say about it").
 * The same shape `decideDispatch` uses when it takes an already-resolved quota
 * position rather than a clock: the impure decision is made once, at the edge,
 * and the rule reads a settled fact.
 *
 * `heldUntil` is carried for the SENTENCE, not for a comparison. Nothing here
 * compares it to anything; it is in the verdict text because an operator told
 * "held" without being told "until when" has been told half of what happened,
 * and the requirement sentence is the one place the policy layer explains
 * itself.
 */
export interface ManualHold {
  /** When the hold lifts. In the future by construction — see above. */
  heldUntil: Date;
  /** The user who placed it, or null if that account no longer exists. */
  heldById: string | null;
}

/**
 * Whether the RECENT window says this class is currently failing.
 *
 * The demotion test, factored out because two rules need it and they must
 * agree exactly. Rule 3 uses it to take autonomy away; rule 5 uses it to
 * refuse to hand autonomy over to a class that would fail rule 3 an hour
 * later. If those two ever disagreed the ladder would oscillate, which is the
 * one failure mode the hysteresis band cannot fix on its own.
 *
 * False when there is too little recent evidence to judge. Silence is not a
 * regression — a class nobody has decided on lately has not got worse, it has
 * merely gone quiet, and DEMOTION_MIN_SAMPLE is where that line is drawn.
 */
export function isRegressing(evidence: ClassEvidence): boolean {
  return (
    evidence.recentSample >= DEMOTION_MIN_SAMPLE &&
    evidence.recentRate !== null &&
    evidence.recentRate < DEMOTION_RATE
  );
}

/**
 * Apply the rules, in order, first match wins.
 *
 * The order is load-bearing and is asserted by the spec, because three of the
 * six rules exist specifically to BEAT later ones:
 *
 * 1. Ineligible beats everything, including a perfect record.
 * 2. Paused beats promotion AND regression-demotion, in both directions.
 * 3. Regression demotion, on the recent window.
 * 4. A standing manual hold beats promotion — and NOTHING ELSE (#244).
 * 5. Promotion, on the lifetime window.
 * 6. Hold, saying what is missing.
 *
 * Rule 4 sits BELOW rule 3 rather than above it, and that placement is the
 * whole safety argument for the hold. A hold is an operator asking the ladder
 * not to WIDEN authority; it must never be able to stop the ladder narrowing
 * it. Putting it under rules 1 and 3 makes "a held class still demotes on
 * regression, and still demotes on ineligibility" true by the order of the
 * function rather than by a condition someone has to remember to write —
 * which matters because a hand-demotion leaves a class non-promoted, so those
 * rules are unreachable for it anyway and the guarantee would otherwise rest
 * on a coincidence a later refactor could remove without noticing.
 */
export function evaluateLadder(
  current: PromotionRung,
  evidence: ClassEvidence,
  eligible: boolean,
  paused: boolean,
  /**
   * A hand-demotion's hold, if one is standing RIGHT NOW.
   *
   * Defaulted to `null` rather than made required so that every existing call
   * keeps its meaning — "no hold" — instead of silently acquiring a different
   * one. See `ManualHold` for why the caller, not this function, decides
   * whether a hold has expired.
   */
  hold: ManualHold | null = null,
): LadderVerdict {
  // --- 1. Ineligible -------------------------------------------------------
  //
  // #99: "Classes marked ineligible (#95) can never be promoted regardless of
  // record." FIRST, so no amount of evidence can reach the promotion rule
  // below it. `quarantine-decision` is the live case — VISION §7 ranks it last
  // and annotates it "probably never", and VISION §8 puts clearing quarantine
  // on the never-trustable list outright.
  //
  // This rule runs even while paused. Ineligibility is a hardcoded declaration
  // about what the system may ever do, not a ladder judgement about a record,
  // and a pause suspends judgements — not declarations.
  if (!eligible) {
    if (current === 'promoted') {
      return {
        action: 'demote',
        reason: 'demoted_ineligible',
        detail:
          `"${evidence.actionClass}" is not autonomy-eligible in the action-class ` +
          'registry (ADR-0011) and must not stand on the promoted rung. Its record ' +
          `(${evidence.approved}/${evidence.sample} approved) is irrelevant to this: ` +
          'ineligibility is a declaration about what may ever run unattended, not an ' +
          'assessment of how well it has done so far.',
      };
    }
    return {
      action: 'hold',
      detail:
        `"${evidence.actionClass}" is not autonomy-eligible and can never be promoted, ` +
        'whatever its record. Nothing it accumulates changes that.',
    };
  }

  // --- 2. Paused -----------------------------------------------------------
  //
  // #99's last criterion: the ladder "can be paused globally without
  // dismantling the grants". So a pause must not demote either — if pausing
  // demoted, it would suspend every grant for every promoted class (see
  // PromotionService), turning an operator's "stop changing things for a
  // moment" into a mass revocation. Nobody would ever pause a second time.
  //
  // Note this returns `hold` for a promoted class that IS regressing. That is
  // the deliberate cost of the guarantee, and it is bounded: the grant's own
  // auto-revoke (VISION §8's fourth attribute) still fires on failure rate and
  // budget while the ladder is paused, so pausing the ladder does not switch
  // off every check standing between a bad class and a real effect.
  if (paused) {
    return {
      action: 'hold',
      detail:
        'The promotion ladder is paused (PROMOTION_LADDER_ENABLED is not true). ' +
        `"${evidence.actionClass}" stays on the ${current} rung: a pause suspends the ` +
        'ladder, not the grants it has already justified.',
    };
  }

  // --- 3. Regression -------------------------------------------------------
  //
  // The RECENT window, not the lifetime one. A class with a year of good
  // history and a terrible fortnight must demote, and a lifetime average
  // cannot see that — see REGRESSION_WINDOW_DAYS.
  if (current === 'promoted' && isRegressing(evidence)) {
    return {
      action: 'demote',
      reason: 'demoted_on_regression',
      detail:
        `Recent approval rate ${pct(evidence.recentRate)} over ${evidence.recentSample} ` +
        `human decision(s) in the last ${REGRESSION_WINDOW_DAYS} days ` +
        `(${evidence.recentApproved} approved, ${evidence.recentRejected} rejected) is ` +
        `below the ${pct(DEMOTION_RATE)} demotion threshold. Lifetime rate is ` +
        `${pct(evidence.rate)} over ${evidence.sample}, which is why this is measured on ` +
        'the window: a lifetime average would hide a recent regression behind old ' +
        'successes.',
    };
  }

  // --- 4. A standing manual hold -------------------------------------------
  //
  // #244. An operator demoted this class by hand, and the ladder may not undo
  // that judgement while the hold stands. Without this the rung half of a
  // hand-demotion lasted under an hour: rule 5 gates on "not currently
  // promoted", which is precisely where a hand-demotion leaves a class, so the
  // next tick re-promoted it on the unchanged lifetime record.
  //
  // Rule 5's anti-oscillation guard does not cover the case. That guard fires
  // when the class is currently FAILING the recent window — the case the
  // ladder would have demoted on its own. The operator this rule exists for
  // has evidence the numbers do not yet show, which means the numbers are
  // good, which means the guard never fires for exactly the demotion that
  // needs it.
  //
  // It blocks PROMOTION and nothing else. Rules 1 and 3 are above it, so a
  // held class that becomes ineligible is still demoted and a held class that
  // is somehow promoted and regressing is still demoted. A hold narrows what
  // the ladder may do; it can never widen it, and it can never stop it
  // narrowing further.
  //
  // The detail leads with the hold because the hold is the operative fact —
  // no amount of evidence promotes this class today — and then states the
  // underlying position anyway, so an operator reading one sentence learns
  // both why nothing is moving and where the class actually stands.
  if (hold) {
    return {
      action: 'hold',
      detail:
        `"${evidence.actionClass}" was demoted BY HAND` +
        (hold.heldById ? ` by user ${hold.heldById}` : '') +
        `, and the ladder may not promote it back until ` +
        `${hold.heldUntil.toISOString()}. The hold runs for ${MANUAL_HOLD_DAYS} days, ` +
        `the same window a regression is measured over: an operator demotes a class ` +
        `because they know something its record does not yet contain, and that is how ` +
        `long the record takes to contain it. When the hold lifts the class is judged ` +
        `again on the numbers, with no memory of this — so if the concern was real it ` +
        `will show up as a regression by then, and if it was not the class promotes. ` +
        `Demoting it again places a fresh hold; doing nothing lets this one lapse. ` +
        `Note that the hold governs the RUNG only — the trust grants suspended by the ` +
        `demotion stay suspended either way, and nothing recreates one but a human ` +
        `tapping "always approve this class". Underlying position: ` +
        holdDetail(current, evidence),
    };
  }

  // --- 5. Promotion --------------------------------------------------------
  //
  // BOTH conditions, and neither substitutes for the other. #99: "Promotion
  // requires both a rate threshold and a minimum sample."
  if (
    current !== 'promoted' &&
    evidence.sample >= MIN_SAMPLE &&
    evidence.rate !== null &&
    evidence.rate >= PROMOTION_RATE
  ) {
    // NEVER PROMOTE INTO AN IMMEDIATE DEMOTION.
    //
    // Rules 3 and 5 read different windows, and without this guard that
    // asymmetry becomes an infinite loop. Take a class with 400 approvals and
    // 10 rejections lifetime (97.6%) and 2 approvals and 8 rejections in the
    // last fortnight (20%). Rule 5 promotes it on the lifetime rate; the next
    // hourly tick sees `promoted` plus a regressing window and rule 3 demotes
    // it; the tick after that promotes it again — forever, at one HIGH-priority
    // demotion notification an hour.
    //
    // That is not a hypothetical: it is exactly the shape of the class the
    // regression window exists to catch, so the loop would fire precisely when
    // the ladder was working. The hysteresis band between PROMOTION_RATE and
    // DEMOTION_RATE prevents oscillation from single decisions within one
    // window; it cannot prevent oscillation BETWEEN two windows, because a
    // class can sit above 0.9 on one and below 0.7 on the other simultaneously.
    //
    // So promotion additionally requires that the class is not currently
    // failing the demotion test. Stated as a property rather than a threshold:
    // the ladder will not grant autonomy it would take back on the next tick.
    if (isRegressing(evidence)) {
      return {
        action: 'hold',
        detail:
          `Lifetime rate ${pct(evidence.rate)} over ${evidence.sample} decision(s) clears ` +
          `the ${pct(PROMOTION_RATE)} promotion threshold, but recent rate ` +
          `${pct(evidence.recentRate)} over ${evidence.recentSample} decision(s) in the ` +
          `last ${REGRESSION_WINDOW_DAYS} days is below the ${pct(DEMOTION_RATE)} demotion ` +
          'threshold. Promoting would be undone by the next evaluation, so the good ' +
          'lifetime record is being held against a class that is getting worse right now.',
      };
    }

    return {
      action: 'promote',
      reason:
        `Approval rate ${pct(evidence.rate)} over ${evidence.sample} human decision(s) ` +
        `(${evidence.approved} approved, ${evidence.rejected} rejected; ` +
        `${evidence.fromProposals} from the review queue, ${evidence.fromApprovals} from ` +
        `the approval gate) clears the ${pct(PROMOTION_RATE)} threshold at or above the ` +
        `${MIN_SAMPLE}-decision minimum. Recent rate is ${pct(evidence.recentRate)} over ` +
        `${evidence.recentSample} in the last ${REGRESSION_WINDOW_DAYS} days.`,
    };
  }

  // --- 6. Hold, saying what is missing -------------------------------------
  return { action: 'hold', detail: holdDetail(current, evidence) };
}

/**
 * The sentence #101 renders as "what would be needed to promote".
 *
 * Built here rather than in the read layer so there is exactly one place that
 * knows the thresholds. A cockpit that computed "2 more needed" from its own
 * copy of MIN_SAMPLE would be a second copy, and the day someone tuned the
 * threshold the screen would confidently state a requirement that no longer
 * applies.
 */
export function holdDetail(
  current: PromotionRung,
  evidence: ClassEvidence,
): string {
  if (current === 'promoted') {
    if (evidence.recentSample < DEMOTION_MIN_SAMPLE) {
      return (
        `Promoted, and holding: only ${evidence.recentSample} human decision(s) in the ` +
        `last ${REGRESSION_WINDOW_DAYS} days, below the ${DEMOTION_MIN_SAMPLE} a demotion ` +
        'must rest on. Too little recent evidence is not evidence of good behaviour — it ' +
        'is a class nobody has checked lately.'
      );
    }
    return (
      `Promoted, and holding: recent rate ${pct(evidence.recentRate)} over ` +
      `${evidence.recentSample} decision(s) is at or above the ${pct(DEMOTION_RATE)} ` +
      'demotion threshold.'
    );
  }

  if (evidence.sample === 0) {
    return (
      'No human has judged a single decision of this class, so it has NO evidence — ' +
      `which is not the same as bad evidence. ${MIN_SAMPLE} human decision(s) at ` +
      `${pct(PROMOTION_RATE)} or better are needed to promote.`
    );
  }

  const shortBy = MIN_SAMPLE - evidence.sample;
  if (shortBy > 0) {
    // Both numbers, even when the rate is fine, because "18 of 20 samples,
    // rate 94%" tells the operator the class is nearly there and the rate is
    // not the problem — and "2 more needed" alone does not.
    return (
      `${evidence.sample} of ${MIN_SAMPLE} samples, rate ${pct(evidence.rate)}: ` +
      `${shortBy} more needed` +
      (evidence.rate !== null && evidence.rate < PROMOTION_RATE
        ? `, and the rate must also reach ${pct(PROMOTION_RATE)}.`
        : '.')
    );
  }

  return (
    `${evidence.sample} of ${MIN_SAMPLE} samples, rate ${pct(evidence.rate)}: the sample ` +
    `is sufficient but the rate is below the ${pct(PROMOTION_RATE)} promotion threshold. ` +
    `${shortfallCount(evidence)} more approval(s) at the current rejection count would ` +
    'reach it.'
  );
}

/**
 * How many additional approvals, at the present rejection count, would carry a
 * class over `PROMOTION_RATE`.
 *
 * Answers the operator's actual next question — "how far off is it?" — with a
 * number rather than a rate they have to do arithmetic on. Solves
 * `(a + n) / (a + n + r) >= PROMOTION_RATE` for the smallest integer `n`.
 */
export function shortfallCount(evidence: ClassEvidence): number {
  const { approved: a, rejected: r } = evidence;

  // PROMOTION_RATE < 1 by construction, so the denominator is never zero. A
  // threshold of exactly 1.0 would make this unbounded, which is itself a
  // reason not to set one.
  //
  // The closed form is a STARTING POINT, not the answer. `0.9` and `0.1` are
  // not exactly representable in binary, so for a = 18, r = 2 the numerator
  // comes out as 2.2e-16 rather than 0 and `Math.ceil` reports that a class
  // already at exactly 90% needs one more approval. Rounding the ceiling with
  // an epsilon would fix that case and quietly break a different one, so the
  // estimate is corrected against the ACTUAL predicate instead — the same
  // comparison every other caller makes, so the answer cannot disagree with
  // the rule it is describing. The loop runs at most twice.
  const estimate = Math.ceil(
    (PROMOTION_RATE * r - (1 - PROMOTION_RATE) * a) / (1 - PROMOTION_RATE),
  );

  let needed = Math.max(0, estimate - 1);
  while (!meetsPromotionRate(a + needed, r)) needed++;
  return needed;
}

/** The promotion rate test, exactly as `evaluateLadder` applies it. */
function meetsPromotionRate(approved: number, rejected: number): boolean {
  const rate = rateOf(approved, rejected);
  return rate !== null && rate >= PROMOTION_RATE;
}

// ---------------------------------------------------------------------------
// The order sanity check
// ---------------------------------------------------------------------------

/**
 * VISION §7's expected promotion order.
 *
 * "re-dispatch after transient failure → decomposition of timed-out orders →
 * issue shaping → quarantine decisions (probably never)."
 *
 * Ranked by widening blast radius: re-dispatch re-runs work already scoped,
 * decomposition creates new work, issue shaping rewrites what a human wrote,
 * quarantine releases something a human parked. The classes VISION does not
 * rank — `run-diagnosis`, `spec-quality-feedback`, `daily-brief` — are absent
 * on purpose rather than appended: they change nothing outside the decision
 * log, so they have no position in an order that ranks blast radius, and
 * inventing one would produce false anomalies.
 */
export const EXPECTED_PROMOTION_ORDER: readonly ActionClassId[] = Object.freeze(
  ['re-dispatch', 'decomposition', 'issue-shaping', 'quarantine-decision'],
);

/** The expected order, as a list. */
export function expectedPromotionOrder(): readonly ActionClassId[] {
  return EXPECTED_PROMOTION_ORDER;
}

/**
 * Whether the classes currently promoted are consistent with VISION §7's order.
 *
 * #99 states the check as a sentence — "A system that promotes quarantine
 * decisions first has a measurement bug, not a breakthrough" — and a sentence
 * in an issue is a thing nobody runs. This makes it computable, and
 * `PromotionService` puts the result in the promotion notification, where an
 * operator sees it at the moment it would matter.
 *
 * It is a SMELL, not a gate. It never blocks a promotion, because the ordering
 * is an expectation about what good evidence would look like, not a rule about
 * what is permitted — and a heuristic that could veto a decision made on real
 * measured evidence would be overriding data with a prediction. It returns a
 * sentence to show a human, and the human decides whether the measurement or
 * the expectation is wrong.
 *
 * Returns null when nothing is out of order.
 */
export function promotionOrderAnomaly(
  promotedClasses: readonly string[],
): string | null {
  const promoted = new Set(promotedClasses);

  // Quarantine first, and unconditionally: VISION §7 annotates it "probably
  // never" and VISION §8 forbids an agent clearing its own quarantine outright.
  // Promoted quarantine is an anomaly even if every class ahead of it is also
  // promoted, so the ordering rule below would not catch it.
  if (promoted.has('quarantine-decision')) {
    return (
      '"quarantine-decision" is promoted. VISION §7 ranks it last and annotates it ' +
      '"probably never", and VISION §8 puts clearing quarantine on the never-trustable ' +
      'list. #99: a system that promotes quarantine decisions has a measurement bug, not ' +
      'a breakthrough. Check the evidence before trusting this.'
    );
  }

  for (let i = 0; i < EXPECTED_PROMOTION_ORDER.length; i++) {
    const candidate = EXPECTED_PROMOTION_ORDER[i];
    if (!promoted.has(candidate)) continue;

    const skipped = EXPECTED_PROMOTION_ORDER.slice(0, i).filter(
      (earlier) => !promoted.has(earlier),
    );
    if (skipped.length > 0) {
      return (
        `"${candidate}" is promoted while ${skipped.map((s) => `"${s}"`).join(', ')} ` +
        `${skipped.length === 1 ? 'is' : 'are'} not. VISION §7 expects the order ` +
        `${EXPECTED_PROMOTION_ORDER.join(' → ')}, by widening blast radius. This is not ` +
        'forbidden — it may simply be that the earlier class has had no proposals to ' +
        'judge — but it is worth checking that the measurement is binning classes the ' +
        'way you think it is.'
      );
    }
  }

  return null;
}

/**
 * The rung a class belongs on, given whether it is promoted and whether any
 * human has ever judged it.
 *
 * A TOTAL FUNCTION of two facts, which is what makes `evaluate` idempotent: an
 * hourly tick over unchanged evidence computes the same rung and therefore
 * writes nothing. Deriving the rung from a sequence of transitions instead
 * would let two systems that saw the same evidence in a different order end up
 * on different rungs.
 *
 * Note where a DEMOTED class lands: `measure`, not `observe`, whenever it has
 * any evidence at all. `observe` means "no human has judged this even once",
 * and saying that about a class that just regressed would be false — the
 * regression is made of judgements. It also would not survive the next tick,
 * since the evidence would immediately pull it back to `measure`, so a
 * demotion to `observe` would silently un-demote its own rung within the hour.
 */
export function rungFor(
  promoted: boolean,
  evidence: ClassEvidence,
): PromotionRung {
  if (promoted) return 'promoted';
  return evidence.sample > 0 ? 'measure' : 'observe';
}

/** Every class the ladder tracks. The registry is the list; see ADR-0011. */
export const LADDER_CLASSES: readonly ActionClassId[] = Object.freeze(
  ACTION_CLASSES.map((entry) => entry.id),
);

/** `0.9` -> `90%`; null -> `no evidence`, never `0%`. */
export function pct(rate: number | null): string {
  if (rate === null) return 'no evidence';
  return `${Math.round(rate * 1000) / 10}%`;
}
