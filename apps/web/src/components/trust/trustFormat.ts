/**
 * How a grant's numbers are rendered (#101, epic #22).
 *
 * Small, pure and tested, like `approvals/approvalFormat.ts` — because the
 * three distinctions below are the ones a component gets subtly wrong, each in
 * a direction that reverses the operator's conclusion.
 */

import { isAuthorizingGrant } from '../../config/trustStatus';
import type { TrustGrant } from '../../types/trust';

/**
 * What a rate reads as when there is NO SAMPLE.
 *
 * Not `0%`, and not an em dash either. An em dash is read as "nothing to
 * show"; this has to be read as "nothing has happened yet", by somebody
 * deciding whether a grant is behaving. `formatEstimatedCost` refuses the dash
 * for the same reason and says "Unknown".
 */
export const NO_DATA = 'No data';

/**
 * A failure rate, or **"No data"**.
 *
 * NULL IS NOT ZERO, and this is the figure where the difference decides
 * something. `failureRate === null` means the grant has authorized nothing
 * yet; `failureRate === 0` means actions ran and every one of them succeeded.
 * They support opposite conclusions about whether the grant is safe to leave
 * standing, and `0%` would state the second while the data says the first.
 */
export function formatFailureRate(rate: number | null): string {
  return rate === null ? NO_DATA : formatPercent(rate);
}

/**
 * An approval rate off `ClassEvidence`, or **"No evidence yet"**.
 *
 * Separate wording from `formatFailureRate` on purpose: on the ladder the
 * absent sample is the WHOLE STORY — an `observe` class is defined by having
 * none — so the string says which kind of nothing it is. A 0% approval rate
 * would claim humans refuse this class every single time they see it.
 */
export const NO_EVIDENCE = 'No evidence yet';

export function formatApprovalRate(rate: number | null): string {
  return rate === null ? NO_EVIDENCE : formatPercent(rate);
}

/** A fraction in [0, 1] as a whole-number percentage. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Dollars, always two places. Grants have real ceilings, not "about $25". */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * How long a grant has left, or how long ago it lapsed.
 *
 * `msUntilExpiry` is SIGNED and the API deliberately does not clamp it, so
 * this is the one function allowed to read the sign. Formatting a negative
 * duration with `Math.abs` — the reflex — turns "expired 3 hours ago" into
 * "expires in 3 hours", which is the single most dangerous string this screen
 * could print: it tells the operator autonomy is still live when it stopped.
 */
export interface ExpiryDescription {
  /** Has it already gone? Drives the wording AND the emphasis. */
  lapsed: boolean;
  /** The sentence, ready to render. Never a bare duration. */
  text: string;
}

export function describeExpiry(msUntilExpiry: number): ExpiryDescription {
  if (msUntilExpiry <= 0) {
    return {
      lapsed: true,
      text: `Lapsed ${formatDuration(-msUntilExpiry)} ago`,
    };
  }
  return { lapsed: false, text: `Expires in ${formatDuration(msUntilExpiry)}` };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A non-negative span, in the compact forms the rest of the app uses. */
export function formatDuration(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE) return 'less than a minute';
  if (span < HOUR) return `${Math.floor(span / MINUTE)}m`;
  if (span < DAY) return `${Math.floor(span / HOUR)}h`;
  return `${Math.floor(span / DAY)}d`;
}

/**
 * When a hand-demotion's hold lifts, as an absolute local instant (#244).
 *
 * ABSOLUTE, where a grant's expiry is relative, and the asymmetry is the same
 * one `formatClockTime` makes: `describeExpiry` answers "is this still live?",
 * which is a question about now, while a hold answers "when may the ladder
 * promote this again?", which is a date an operator puts in their week. "In
 * 14d" is also the one form that cannot be checked against the sentence the
 * API prints beside it.
 *
 * The format matches `approvals/ifIgnored.ts`'s `formatDeadline`, because both
 * are the same kind of fact — an instant something happens by itself unless a
 * person acts — and two spellings of that on one cockpit is drift.
 *
 * An unparseable value is returned RAW rather than as "Invalid Date": the
 * operator can still act on the string, and nobody can mistake it for a real
 * instant.
 */
export function formatHoldEnd(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Does a manual hold still stand at `now`?
 *
 * `manualHoldUntil` is NEVER CLEARED once set, so a past instant is the normal
 * resting state of any class that was ever hand-demoted — and a component
 * treating non-null as "held" would show a standing hold over a class the
 * ladder has had back for a month.
 *
 * Strictly in the future, matching `activeHold` in the API's promotion service
 * exactly: a hold that ends at `now` has lapsed. `now` is a parameter for the
 * usual reason — a function that reads its own clock cannot be tested — and
 * callers pass the ladder's own `readAt`, so this agrees with the server's
 * `requirement` sentence rather than with the browser's clock skew.
 */
export function isHoldStanding(
  manualHoldUntil: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!manualHoldUntil) return false;
  const until = new Date(manualHoldUntil);
  if (Number.isNaN(until.getTime())) return false;
  return until.getTime() > now.getTime();
}

/**
 * The one-line reason a grant is drawn as wanting attention, or null.
 *
 * **Both flags come from the server** (`nearExpiry`, `nearBudget`) and are not
 * recomputed here from `msUntilExpiry` and `budgetHeadroomFraction`. Two
 * independently written versions of the same threshold is exactly how a
 * warning chip and a budget bar end up disagreeing on one screen, and the API
 * computes them for this reason. This function only turns them into words.
 *
 * A grant that is BOTH gets both, joined — telling an operator about the
 * expiry while silently dropping the exhausted ceiling would have them renew
 * into a wall.
 */
export function describeHeadroomWarning(grant: TrustGrant): string | null {
  // An ended grant has no headroom to warn about: it authorizes nothing, and
  // "runs out of budget soon" over a revoked row is noise on the one screen
  // that must make the live warnings obvious. The predicate lives in
  // `config/trustStatus.ts` rather than as a `!== 'active'` written out here
  // for the fifth time — that is the shape of a rule one future status quietly
  // escapes.
  if (!isAuthorizingGrant(grant.status)) return null;

  const reasons: string[] = [];
  if (grant.nearExpiry) reasons.push(describeExpiry(grant.msUntilExpiry).text);
  if (grant.nearBudget) {
    reasons.push(
      `${formatUsd(grant.remainingBudgetUsd)} of ${formatUsd(grant.budgetCeilingUsd)} left`,
    );
  }

  return reasons.length === 0 ? null : reasons.join(' · ');
}

/** Does this grant want a human's eye? Server-computed, never re-derived. */
export function needsAttention(grant: TrustGrant): boolean {
  return (
    isAuthorizingGrant(grant.status) && (grant.nearExpiry || grant.nearBudget)
  );
}

/**
 * The auto-revoke thresholds as one readable sentence.
 *
 * The sample floor is included rather than left implicit: a grant at 100%
 * failure over one action has tripped nothing, and a screen that showed the
 * rate ceiling without the floor would make the mechanism look broken.
 */
export function describeAutoRevoke(grant: TrustGrant): string {
  return (
    `Revokes itself above ${formatPercent(grant.maxFailureRate)} failures ` +
    `(once ${grant.minActionsBeforeAutoRevoke} actions have run), or if one action ` +
    `costs more than ${formatUsd(grant.maxCostPerActionUsd)}.`
  );
}
