import { NEAR_BUDGET_HEADROOM_FRACTION } from '../../trust/defaults';
import type { TrustGrantView } from '../../trust/trust-grant.types';

/**
 * The trust digest (#100, epic #22, ADR-0012).
 *
 * VISION §8, "The digest replaces the interruptions":
 *
 * > Auto-approved actions still record what _would_ have been asked. Instead
 * > of interruptions, a daily rollup: what ran under trust, what it cost, what
 * > it changed, what looked unusual. This is what makes the promotion ladder
 * > honest — grants stay visible while they earn themselves.
 *
 * ## This is a section, not an artifact
 *
 * ADR-0012 decided it: the digest EXTENDS the daily brief rather than becoming
 * a second daily message, because "two competing daily summaries is how both
 * get ignored". `DailyBrief` already carried `trustExecuted`/`trustNotShown`
 * for exactly this, and `composeBrief` already had a `trustSection()`. This
 * file fills that seam; it mints no notification, owns no cron, and exposes no
 * endpoint.
 *
 * ## The completeness guarantee
 *
 * The ranked items in `daily-brief.ts` are capped at `MAX_BRIEF_ITEMS` because
 * attention is scarce. This section is not, because the two halves answer
 * different questions: the ranked list asks _what needs you_, and the digest
 * asks _what happened without you_. A truncated attention list costs an
 * operator one look; a truncated trust list silently omits something that ran
 * on its own and was never reported.
 *
 * So the rule is: rendered IN FULL, or the digest states exactly how many it
 * could not show. `notShown` is that number, and it is computed from the TRUE
 * total rather than from the length of whatever list was handed in — see
 * `TrustDigestInput.totalActions`.
 *
 * ## PURE
 *
 * Like `rankBrief` and `render-snapshot.ts`: no clock, no database, no config.
 * `now` is an argument. A digest that read the clock could not be pinned to
 * its own expiry boundary in a test, and the boundaries are most of the
 * behaviour here.
 */

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * A backstop, not a cap in the ADR-0012 sense.
 *
 * ADR-0012 accepted an unbounded brief deliberately: "a system acting on its
 * own at volume is when 'what happened without me' stops being a formality."
 * This number does not re-litigate that. It exists because every delivery
 * transport has a size limit of its own, and a message truncated BY THE
 * TRANSPORT loses the overflow silently — which is the exact failure the
 * completeness guarantee forbids. Truncating here instead means the overflow
 * is COUNTED, in the `trustNotShown` field ADR-0012 itself specified.
 *
 * 200 is set far above any plausible day on purpose. It should be the
 * guarantee's escape hatch and never its normal path; if a deployment reaches
 * it routinely, the answer is a per-grant summary line rather than a lower
 * number here.
 */
export const MAX_TRUST_DIGEST_ITEMS = 200;

/**
 * 80% of the budget ceiling spent — DERIVED, not restated.
 *
 * `NEAR_BUDGET_HEADROOM_FRACTION` (0.2) is the same threshold expressed from
 * the other end, and `TrustGrantView.nearBudget` already computes it for the
 * cockpit. Writing `0.8` here as an independent constant is precisely how a
 * budget bar and a daily digest end up disagreeing about whether a grant is in
 * trouble — the argument `trust-grant.types.ts` makes about computing
 * `remaining / ceiling` twice, one level up.
 */
export const BUDGET_ALARM_SPENT_FRACTION = 1 - NEAR_BUDGET_HEADROOM_FRACTION;

/**
 * 72 hours: when the digest starts asking for a renewal decision.
 *
 * WIDER than `NEAR_EXPIRY_WINDOW_MS` (48h), and the difference is deliberate
 * rather than an oversight. That constant serves an in-app prompt, seen when
 * the operator is already present. This one serves a DAILY message, and a
 * 48-hour window first mentions a Monday-morning expiry in Saturday's brief —
 * the one nobody reads. Three days means a grant that dies over a weekend is
 * raised on Friday, while there is still somebody to raise it to.
 *
 * #100: this is what "turns the digest from a report into a control". An
 * operator who sees a grant three days from expiry with most of its budget
 * spent has what they need to renew, narrow, or let it lapse.
 */
export const RENEWAL_SIGNAL_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * More than 20% headroom left counts as "meaningful budget" for the renewal
 * signal.
 *
 * Reusing `NEAR_BUDGET_HEADROOM_FRACTION` makes the two budget anomalies
 * PARTITION rather than double-report: a grant with less headroom than this is
 * already reported as nearly spent, and a grant with more is the one where
 * letting the expiry lapse actually throws something away. Two independent
 * numbers here would produce grants that are either in both buckets or in
 * neither, and an anomaly list that contradicts itself is one nobody reads
 * twice.
 */
export const RENEWAL_MEANINGFUL_HEADROOM_FRACTION =
  NEAR_BUDGET_HEADROOM_FRACTION;

/**
 * 3× the previous window's action count is a spike.
 *
 * Chosen against what a grant is for: normal use varies by a factor of two on
 * an ordinary week — one busy afternoon, one quiet one. Three times is outside
 * that, and it is the shape a loop takes when something starts re-proposing
 * the same action.
 */
export const ACTIVITY_SPIKE_FACTOR = 3;

/**
 * A spike needs at least 5 actions in the window before it is called one.
 *
 * 1 → 3 actions is a threefold increase and means nothing. Without a floor,
 * the spike anomaly fires on the quietest grants most often, which is how an
 * operator learns that "unusual" is not worth reading.
 */
export const ACTIVITY_SPIKE_MIN_ACTIONS = 5;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * How an action came to run without a human.
 *
 * Both count, and they are LABELLED DIFFERENTLY rather than merged.
 *
 * VISION §8 says "auto-approved actions still record what _would_ have been
 * asked", and a timeout auto-approval ran without a human just as surely as a
 * grant-authorized one did — omitting it would make the digest incomplete in
 * exactly the way the guarantee forbids. But they are not the same fact, and
 * `approval.types.ts` spends a long comment on why: a grant is machine action
 * taken on evidence a human supplied earlier, while A TIMEOUT IS SILENCE, NOT
 * AGREEMENT. An operator reading "12 actions ran under trust" should be able
 * to see how many of those twelve nobody ever agreed to.
 */
export type TrustExecutionOrigin =
  /** `decidedVia: 'grant'` — a standing `TrustGrant` covered it. */
  | 'grant'
  /**
   * `decidedVia: 'timeout'` with `status: 'auto_approved'` — the resolved
   * `timeoutPolicy` was `auto_approve` and nobody answered in time.
   *
   * NOTE the status half of that condition. `decidedVia: 'timeout'` also pairs
   * with `auto_denied`, and an auto-DENIED action did not run. Reporting it
   * here would put something in "what happened without you" that did not
   * happen at all, which erodes the section's meaning in the opposite
   * direction from a truncation but just as surely.
   */
  | 'timeout';

/**
 * One action that took effect with no human in the loop.
 *
 * Built from an `ApprovalRequest` row, which is the record VISION §8 requires
 * auto-approved actions to leave behind.
 */
export interface TrustDigestAction {
  /** The `ApprovalRequest` id — what a link points at. */
  approvalId: string;
  actionClass: string;
  repositoryId: string;
  /** What was going to be asked, one line. */
  summary: string;
  /** The subject, when there was one. `null` for a factory-wide action. */
  targetRef: string | null;
  /**
   * The grant that authorized it. NULL for `origin: 'timeout'`, and that null
   * is the whole difference between the two origins rather than missing data.
   */
  grantId: string | null;
  /**
   * The cost estimated at gate time.
   *
   * NULL MEANS UNKNOWN, NOT ZERO (VISION §6). The digest carries the two
   * apart all the way to the rendered line: a cost total that quietly counted
   * unknowns as zero would understate what ran under trust, and understating
   * it is the direction that flatters the system.
   */
  estimatedCostUsd: number | null;
  /** When it was resolved — the moment it stopped waiting for a person. */
  at: Date;
  origin: TrustExecutionOrigin;
}

/** Everything the digest is computed from. No clock, no database. */
export interface TrustDigestInput {
  /** The instant the brief is composed against. */
  now: Date;
  /**
   * The start of the reported window.
   *
   * "Since the last brief", not "the last 24 hours". If a brief was missed,
   * the actions in the gap ran without anybody and were never reported, and a
   * fixed 24-hour window would drop them permanently — a silent hole of
   * exactly the kind the completeness guarantee exists to prevent.
   */
  windowStart: Date;
  /** Actions in the window. May be shorter than `totalActions`. */
  actions: TrustDigestAction[];
  /**
   * The TRUE number of actions in the window.
   *
   * Separate from `actions.length` because the caller may have capped its
   * read. `notShown` is computed from this, so the guarantee holds whether the
   * truncation happened in the query or here.
   */
  totalActions: number;
  /** Every grant still authorizing at `now`. */
  activeGrants: TrustGrantView[];
  /** Grants that stopped authorizing inside the window, whatever ended them. */
  endedGrants: TrustGrantView[];
  /**
   * Actions per grant in the PREVIOUS window of the same length.
   *
   * The spike baseline. Keyed by grant id; a grant absent from the map had no
   * actions, which the spike rule treats as "no baseline" rather than as zero
   * — see `ACTIVITY_SPIKE_MIN_ACTIONS`.
   */
  previousWindowActionsByGrant: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * One line of "what ran under trust".
 *
 * Defined here rather than in `daily-brief.ts` (which re-exports it) because
 * the digest is now what produces them; the shape ADR-0012 reserved is
 * unchanged, and the three new fields are optional so a caller constructing
 * the original four still typechecks.
 */
export interface TrustExecutedItem {
  actionClass: string;
  summary: string;
  ref: string;
  /** `HH:MM`, UTC. The brief's date line already carries the day. */
  at: string;
  /** Absent only on hand-built items predating the digest. */
  origin?: TrustExecutionOrigin;
  /** The authorizing grant, when there was one. */
  grantId?: string | null;
  /** Null is UNKNOWN, not zero (VISION §6). */
  costUsd?: number | null;
}

/**
 * Cost and changes attributed to one grant — #100's "Cost and changes are
 * attributed per grant".
 */
export interface GrantActivity {
  /**
   * NULL is the timeout bucket: actions that ran with no grant behind them.
   *
   * Kept as a row rather than dropped, because dropping it would make the
   * digest's own cost total disagree with the sum of its own lines, and a
   * report that does not add up is one an operator stops checking.
   */
  grantId: string | null;
  actionClass: string;
  repositoryId: string;
  /** Actions attributed here, including those with an unknown cost. */
  actions: number;
  /** Sum of the KNOWN estimates only. */
  costUsd: number;
  /** How many of `actions` had no cost estimate. Unknown is not zero. */
  costUnknownActions: number;
  /** Distinct `targetRef`s touched — VISION §8's "what it changed". */
  changedRefs: string[];
}

/**
 * How much life one active grant has left — #100's control surface.
 *
 * Both axes, always, because a grant dies on whichever runs out first and an
 * operator shown only one of them cannot tell which decision is due.
 */
export interface GrantHeadroom {
  grantId: string;
  actionClass: string;
  repositoryId: string;
  spentUsd: number;
  budgetCeilingUsd: number;
  remainingBudgetUsd: number;
  budgetHeadroomFraction: number;
  expiresAt: string;
  /** Negative once lapsed — `TrustGrantView` deliberately does not clamp it. */
  msUntilExpiry: number;
  actionsAuthorized: number;
  actionsFailed: number;
  /** Null when nothing has been authorized: 0/0 is no evidence, not 0%. */
  failureRate: number | null;
}

/** A grant that stopped authorizing inside the window, and why. */
export interface GrantEnding {
  grantId: string;
  actionClass: string;
  repositoryId: string;
  endedAt: string | null;
  /** `expired` | `revoked` | `budget_exhausted` | … — the category. */
  endReason: string | null;
  /**
   * The sentence naming the numbers, written when the grant ended.
   *
   * #96: "a grant that vanishes silently teaches the operator the system is
   * unpredictable, and an operator who believes the system is unpredictable
   * grants blanket trust the next time."
   */
  endDetail: string | null;
}

/** The five things the digest calls out rather than leaving to be spotted. */
export type AnomalyKind =
  /** Auto-revoke fired in the window. Something already happened. */
  | 'grant-suspended'
  /** Past `BUDGET_ALARM_SPENT_FRACTION` of the ceiling and still authorizing. */
  | 'budget-nearly-spent'
  /** Dies within `RENEWAL_SIGNAL_WINDOW_MS` with budget still on it. */
  | 'expiring-with-budget-left'
  /** Costing more per action than the grant's own auto-revoke threshold. */
  | 'cost-per-action-above-threshold'
  /** Far more activity under one grant than in the previous window. */
  | 'activity-spike';

/**
 * Something worth a second look, with the numbers that make it checkable.
 *
 * `detail` follows the house rule `auto-revoke.ts` states outright: "the
 * reason is not a log message". An anomaly an operator cannot verify against
 * figures they can see is one they will learn to ignore, and an ignored
 * anomaly list is worse than none because it looks like coverage.
 */
export interface Anomaly {
  kind: AnomalyKind;
  /** Null only where the anomaly is about actions with no grant behind them. */
  grantId: string | null;
  actionClass: string;
  /** One sentence, naming its numbers. */
  detail: string;
}

/** The digest. */
export interface TrustDigest {
  /** Feeds `DailyBrief.trustExecuted`. Capped only by the backstop above. */
  executed: TrustExecutedItem[];
  /** Feeds `DailyBrief.trustNotShown`. Exact. */
  notShown: number;
  /** Cost and changes per grant, most expensive first. */
  perGrant: GrantActivity[];
  /** Every active grant, soonest to die first. */
  grantStates: GrantHeadroom[];
  /** Grants that ended in the window. */
  endedGrants: GrantEnding[];
  /** Called out rather than left to be spotted. */
  anomalies: Anomaly[];
  /**
   * Nothing to report.
   *
   * NOT merely "nothing ran". A day where a grant is three days from expiry
   * with $20 left on it is not quiet, and rendering it as quiet would suppress
   * exactly the signal #100 says turns the digest from a report into a
   * control. So: no actions, no anomalies, no grant ended.
   *
   * When it is true the section renders as ONE LINE — #100's explicit
   * acceptance criterion, and the same argument `composeBrief` makes about a
   * quiet day generally: padding one teaches its reader that most of it can be
   * skipped, and after that the loud day gets skipped too.
   */
  quiet: boolean;
  /** Sum of every known estimate in the window. */
  totalCostUsd: number;
  /** Actions in the window whose cost nobody could estimate. */
  costUnknownActions: number;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Compute the digest. Pure. */
export function buildTrustDigest(input: TrustDigestInput): TrustDigest {
  // Chronological, id-tie-broken, so the same window always renders in the
  // same order. An unstable order in a daily message reads as churn.
  const actions = [...input.actions].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      a.approvalId.localeCompare(b.approvalId),
  );

  const shown = actions.slice(0, MAX_TRUST_DIGEST_ITEMS);
  // From the TRUE total, not from `actions.length`: the caller may have capped
  // its read, and the guarantee is about what happened, not about what was
  // fetched. Floored at zero so a caller that under-reports its total cannot
  // produce a negative "and N more".
  const notShown = Math.max(0, input.totalActions - shown.length);

  const executed: TrustExecutedItem[] = shown.map((action) => ({
    actionClass: action.actionClass,
    summary: action.summary,
    ref: action.targetRef ?? action.approvalId,
    at: hhmm(action.at),
    origin: action.origin,
    grantId: action.grantId,
    costUsd: action.estimatedCostUsd,
  }));

  const perGrant = attribute(actions);
  const grantStates = input.activeGrants
    .map(toHeadroom)
    .sort(
      (a, b) =>
        a.msUntilExpiry - b.msUntilExpiry ||
        a.budgetHeadroomFraction - b.budgetHeadroomFraction ||
        a.grantId.localeCompare(b.grantId),
    );

  const endedGrants = input.endedGrants.map((grant) => ({
    grantId: grant.id,
    actionClass: grant.actionClass,
    repositoryId: grant.repositoryId,
    endedAt: grant.endedAt,
    endReason: grant.endReason,
    endDetail: grant.endDetail,
  }));

  const anomalies = detectAnomalies(input, perGrant);

  const totalCostUsd = round2(
    actions.reduce((sum, action) => sum + (action.estimatedCostUsd ?? 0), 0),
  );
  const costUnknownActions = actions.filter(
    (action) => action.estimatedCostUsd === null,
  ).length;

  return {
    executed,
    notShown,
    perGrant,
    grantStates,
    endedGrants,
    anomalies,
    quiet:
      input.totalActions === 0 &&
      anomalies.length === 0 &&
      endedGrants.length === 0,
    totalCostUsd,
    costUnknownActions,
  };
}

/**
 * Attribute cost and changes to the grant that authorized them.
 *
 * Timeout-resolved actions land in a single `grantId: null` bucket per action
 * class — see `GrantActivity.grantId` for why they are not dropped.
 */
function attribute(actions: TrustDigestAction[]): GrantActivity[] {
  const buckets = new Map<string, GrantActivity & { refs: Set<string> }>();

  for (const action of actions) {
    // Keyed by grant AND class: one grant is scoped to exactly one class
    // (VISION §8's "action class × repository"), so this only ever splits the
    // null bucket — which is the one that genuinely holds several classes.
    const key = `${action.grantId ?? ''}::${action.actionClass}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        grantId: action.grantId,
        actionClass: action.actionClass,
        repositoryId: action.repositoryId,
        actions: 0,
        costUsd: 0,
        costUnknownActions: 0,
        changedRefs: [],
        refs: new Set<string>(),
      };
      buckets.set(key, bucket);
    }

    bucket.actions += 1;
    if (action.estimatedCostUsd === null) bucket.costUnknownActions += 1;
    else bucket.costUsd += action.estimatedCostUsd;
    if (action.targetRef !== null) bucket.refs.add(action.targetRef);
  }

  return [...buckets.values()]
    .map(({ refs, ...bucket }) => ({
      ...bucket,
      costUsd: round2(bucket.costUsd),
      changedRefs: [...refs].sort(),
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.actions - a.actions ||
        (a.grantId ?? '').localeCompare(b.grantId ?? ''),
    );
}

function toHeadroom(grant: TrustGrantView): GrantHeadroom {
  return {
    grantId: grant.id,
    actionClass: grant.actionClass,
    repositoryId: grant.repositoryId,
    spentUsd: grant.spentUsd,
    budgetCeilingUsd: grant.budgetCeilingUsd,
    remainingBudgetUsd: grant.remainingBudgetUsd,
    budgetHeadroomFraction: grant.budgetHeadroomFraction,
    expiresAt: grant.expiresAt,
    msUntilExpiry: grant.msUntilExpiry,
    actionsAuthorized: grant.actionsAuthorized,
    actionsFailed: grant.actionsFailed,
    failureRate: grant.failureRate,
  };
}

/**
 * The five rules, in the order an operator should read them.
 *
 * Suspensions first because they already happened and nothing else in the list
 * is a completed event. Then the two budget/expiry rules, which are decisions
 * that are DUE. Then the two behavioural ones, which are things to look at.
 */
function detectAnomalies(
  input: TrustDigestInput,
  perGrant: GrantActivity[],
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // --- 1. A grant auto-revoke fired in the window -------------------------
  //
  // `endDetail` was written by `evaluateAutoRevoke`, which already names the
  // numbers that tripped it. Re-deriving the sentence here would risk it
  // disagreeing with the one recorded on the row.
  for (const grant of input.endedGrants) {
    if (grant.status !== 'suspended') continue;
    anomalies.push({
      kind: 'grant-suspended',
      grantId: grant.id,
      actionClass: grant.actionClass,
      detail:
        grant.endDetail ??
        `Suspended (${grant.endReason ?? 'reason not recorded'}) after ` +
          `${grant.actionsAuthorized} authorized action(s) and ` +
          `${usd(grant.spentUsd)} spent.`,
    });
  }

  // --- 2. Nearly out of budget, still authorizing -------------------------
  for (const grant of input.activeGrants) {
    if (grant.budgetHeadroomFraction > NEAR_BUDGET_HEADROOM_FRACTION) continue;
    anomalies.push({
      kind: 'budget-nearly-spent',
      grantId: grant.id,
      actionClass: grant.actionClass,
      detail:
        `${usd(grant.spentUsd)} of a ${usd(grant.budgetCeilingUsd)} ceiling ` +
        `spent (${percent(1 - grant.budgetHeadroomFraction)}), ` +
        `${usd(grant.remainingBudgetUsd)} left. Past ` +
        `${percent(BUDGET_ALARM_SPENT_FRACTION)} the grant dies on budget ` +
        'before it dies on time, so a renewal decision is due now rather than ' +
        `at ${grant.expiresAt.slice(0, 10)}.`,
    });
  }

  // --- 3. Expiring soon with budget still on it ---------------------------
  //
  // The renewal signal #115 needs. Partitioned against rule 2 by the shared
  // headroom threshold: a grant flagged there is not flagged here.
  for (const grant of input.activeGrants) {
    if (grant.msUntilExpiry <= 0) continue;
    if (grant.msUntilExpiry > RENEWAL_SIGNAL_WINDOW_MS) continue;
    if (grant.budgetHeadroomFraction <= RENEWAL_MEANINGFUL_HEADROOM_FRACTION) {
      continue;
    }
    anomalies.push({
      kind: 'expiring-with-budget-left',
      grantId: grant.id,
      actionClass: grant.actionClass,
      detail:
        `Expires in ${duration(grant.msUntilExpiry)} (${grant.expiresAt}) with ` +
        `${usd(grant.remainingBudgetUsd)} of ${usd(grant.budgetCeilingUsd)} ` +
        `unspent (${percent(grant.budgetHeadroomFraction)} headroom). Renew, ` +
        'narrow, or let it lapse — doing nothing lets it lapse, which is what ' +
        'VISION §8 means by "silence revokes".',
    });
  }

  // --- 4. Costing more per action than its own threshold ------------------
  //
  // Auto-revoke rule 3 compares `spentUsd / actionsAuthorized` against
  // `maxCostPerActionUsd`, but only once `minActionsBeforeAutoRevoke` actions
  // have accumulated. Under that floor the rule is DELIBERATELY BLIND, and
  // this is where the observation goes in the meantime.
  //
  // The asymmetry is the point: the sample-size floor exists to stop a rule
  // from ACTING on thin evidence, which is not a reason to withhold the
  // observation from the person who could act on it. So the count is always
  // stated and the operator judges an n of 1 for themselves.
  const activeById = new Map(input.activeGrants.map((g) => [g.id, g]));
  for (const bucket of perGrant) {
    if (bucket.grantId === null) continue;
    const grant = activeById.get(bucket.grantId);
    if (!grant) continue;

    const costed = bucket.actions - bucket.costUnknownActions;
    if (costed < 1) continue;

    const perAction = bucket.costUsd / costed;
    if (perAction <= grant.maxCostPerActionUsd) continue;

    const blind = grant.actionsAuthorized < grant.minActionsBeforeAutoRevoke;
    anomalies.push({
      kind: 'cost-per-action-above-threshold',
      grantId: grant.id,
      actionClass: grant.actionClass,
      detail:
        `${usd(perAction)} per action across ${costed} costed action(s) this ` +
        `window (${usd(bucket.costUsd)} total), above the grant's own ` +
        `${usd(grant.maxCostPerActionUsd)} per-action threshold. Not ` +
        'auto-revoked' +
        (blind
          ? `: only ${grant.actionsAuthorized} action(s) have been authorized ` +
            `in total, below the ${grant.minActionsBeforeAutoRevoke}-action ` +
            'floor auto-revoke needs before it will judge a rate.'
          : `: lifetime spend is ${usd(grant.spentUsd)} across ` +
            `${grant.actionsAuthorized} action(s), which is still under the ` +
            'threshold on average.') +
        (bucket.costUnknownActions > 0
          ? ` ${bucket.costUnknownActions} further action(s) had no estimate ` +
            'and are excluded — unknown is not zero.'
          : ''),
    });
  }

  // --- 5. A spike against the previous window -----------------------------
  for (const bucket of perGrant) {
    if (bucket.grantId === null) continue;
    if (bucket.actions < ACTIVITY_SPIKE_MIN_ACTIONS) continue;

    const previous = input.previousWindowActionsByGrant[bucket.grantId] ?? 0;
    // A grant's first active window is a START, not a spike. Firing on it
    // would trip this anomaly once for every grant ever created, which is how
    // "unusual" comes to mean "ignore".
    if (previous < 1) continue;
    if (bucket.actions < previous * ACTIVITY_SPIKE_FACTOR) continue;

    anomalies.push({
      kind: 'activity-spike',
      grantId: bucket.grantId,
      actionClass: bucket.actionClass,
      detail:
        `${bucket.actions} actions this window against ${previous} in the ` +
        `previous one — ${(bucket.actions / previous).toFixed(1)}×, past the ` +
        `${ACTIVITY_SPIKE_FACTOR}× line. ${usd(bucket.costUsd)} spent, ` +
        `${bucket.changedRefs.length} distinct target(s) touched.`,
    });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * The digest, as the lines `trustSection` splices into the brief.
 *
 * A quiet digest is ONE LINE. The brief is short on a quiet day, so the trust
 * section must be short too — empty headings would be padding, and padding is
 * what teaches a reader to skim.
 */
export function renderTrustDigest(digest: TrustDigest): string[] {
  if (digest.quiet) {
    return [oneLine(digest)];
  }

  const lines: string[] = [];

  if (digest.executed.length === 0 && digest.notShown === 0) {
    lines.push('Ran under trust: nothing ran, but see below.');
  } else {
    const timeouts = digest.executed.filter(
      (item) => item.origin === 'timeout',
    ).length;
    lines.push(
      `Ran under trust: ${digest.executed.length + digest.notShown} action(s), ` +
        `${usd(digest.totalCostUsd)}` +
        (digest.costUnknownActions > 0
          ? ` plus ${digest.costUnknownActions} of unknown cost`
          : '') +
        (timeouts > 0
          ? `. ${timeouts} of them resolved by timeout — nobody agreed, nobody ` +
            'answered.'
          : '.'),
    );
    for (const item of digest.executed) {
      lines.push(
        `- ${item.at} · ${item.actionClass} · ${item.summary} (${item.ref})`,
      );
      lines.push(`  ${provenance(item)}`);
    }
    if (digest.notShown > 0) {
      lines.push(
        `- and ${digest.notShown} more not listed here. This section is meant to be ` +
          'complete; a truncated one is an action that happened without you and was not reported.',
      );
    }
  }

  if (digest.perGrant.length > 0) {
    lines.push('');
    lines.push('Cost and changes, per grant:');
    for (const bucket of digest.perGrant) {
      lines.push(`- ${grantActivityLine(bucket)}`);
    }
  }

  if (digest.grantStates.length > 0) {
    lines.push('');
    lines.push('Grants still authorizing:');
    for (const grant of digest.grantStates) {
      lines.push(`- ${headroomLine(grant)}`);
    }
  }

  if (digest.endedGrants.length > 0) {
    lines.push('');
    lines.push('Grants that ended:');
    for (const ended of digest.endedGrants) {
      lines.push(
        `- ${ended.actionClass} (${short(ended.grantId)}): ` +
          `${ended.endReason ?? 'ended'}${
            ended.endDetail ? ` — ${ended.endDetail}` : ''
          }`,
      );
    }
  }

  if (digest.anomalies.length > 0) {
    lines.push('');
    lines.push('What looked unusual:');
    for (const anomaly of digest.anomalies) {
      lines.push(
        `- ${anomaly.actionClass}${
          anomaly.grantId ? ` (${short(anomaly.grantId)})` : ''
        }: ${anomaly.detail}`,
      );
    }
  }

  return lines;
}

/**
 * The one line a quiet day gets.
 *
 * Still states the grant count and that none is near budget or expiry, because
 * `quiet` already guarantees no anomaly fired — so this sentence is the
 * headroom report, compressed to the size the day deserves.
 */
function oneLine(digest: TrustDigest): string {
  if (digest.grantStates.length === 0) {
    return (
      'Ran under trust: nothing. No action class is promoted, so every action ' +
      'still went through a human.'
    );
  }
  return (
    `Ran under trust: nothing. ${digest.grantStates.length} grant(s) still ` +
    'authorizing, none near its budget or its expiry.'
  );
}

function provenance(item: TrustExecutedItem): string {
  const cost =
    item.costUsd === null || item.costUsd === undefined
      ? 'cost unknown'
      : usd(item.costUsd);
  if (item.origin === 'timeout') {
    return `resolved by timeout — nobody answered before the window closed; ${cost}`;
  }
  return `under grant ${short(item.grantId ?? null)}; ${cost}`;
}

function grantActivityLine(bucket: GrantActivity): string {
  const who =
    bucket.grantId === null
      ? `${bucket.actionClass} (no grant — resolved by timeout)`
      : `${bucket.actionClass} (${short(bucket.grantId)})`;
  const unknown =
    bucket.costUnknownActions > 0
      ? `, ${bucket.costUnknownActions} with no estimate`
      : '';
  const changed =
    bucket.changedRefs.length > 0
      ? `; changed ${bucket.changedRefs.length}: ${bucket.changedRefs.join(', ')}`
      : '; changed nothing with a stable reference';
  return `${who}: ${bucket.actions} action(s), ${usd(bucket.costUsd)}${unknown}${changed}`;
}

function headroomLine(grant: GrantHeadroom): string {
  const failures =
    grant.failureRate === null
      ? 'no actions yet'
      : `${grant.actionsFailed} of ${grant.actionsAuthorized} failed (${percent(
          grant.failureRate,
        )})`;
  const expiry =
    grant.msUntilExpiry > 0
      ? `expires in ${duration(grant.msUntilExpiry)}`
      : `EXPIRED ${duration(-grant.msUntilExpiry)} ago`;
  return (
    `${grant.actionClass} (${short(grant.grantId)}): ${usd(grant.spentUsd)} of ` +
    `${usd(grant.budgetCeilingUsd)} spent, ${percent(
      grant.budgetHeadroomFraction,
    )} headroom; ${expiry}; ${failures}`
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function hhmm(at: Date): string {
  return at.toISOString().slice(11, 16);
}

/** Grant ids are uuids; a brief is read on a phone. Enough to disambiguate. */
function short(id: string | null): string {
  if (id === null) return 'none';
  return id.length > 8 ? id.slice(0, 8) : id;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function duration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d ${hours - days * 24}h`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(0, Math.floor(ms / 60000))}m`;
}

/** Money, to the cent. Float addition over many rows drifts otherwise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
