import type { NotificationPayload } from './notification-payload';

/**
 * What arrives on the phone when a trust grant is about to lapse (#115,
 * VISION §8).
 *
 * > Expiry — days or session. Renewal is one tap; silence revokes.
 *
 * This is the "one tap" half. #96 built the other half — an expired grant
 * stops authorizing on the timestamp, with no grace period — and without a
 * prompt that half is pure friction: every grant dies on schedule, the
 * operator re-approves from scratch, and the pressure VISION §8 opens by
 * naming ("operators grant blanket trust out of friction, not conviction")
 * returns as somebody widening the default expiry.
 *
 * ## The payload carries the grant's RECORD, and that is the point
 *
 * A renewal prompt that said only "grant expiring, renew?" would ask the
 * operator to re-approve blind — which is how blanket trust gets granted, one
 * uninformed yes at a time. So `why` names what the grant authorized, what it
 * cost, and how often it failed. Those are the same three figures #99's
 * promotion ladder judges a class on, and the operator is being asked the same
 * question the ladder asks: has this earned another fortnight?
 *
 * ## `ifIgnored` is load-bearing and must not be softened
 *
 * The honest answer is that the grant expires and is not renewed. Nothing
 * catches it, nothing extends it, and no second prompt arrives — the prompt is
 * sent ONCE per grant. VISION §8's "silence revokes" is only a mechanism if
 * the operator is told plainly that silence is a decision; hedging it into
 * "you may want to review this" would describe a system that keeps things
 * alive out of politeness, which this one deliberately does not.
 *
 * ## `priority: 'normal'`
 *
 * A batched decision, never an interruption. VISION §8's goal is "not fewer
 * decisions but decisions batched and moved off the critical path", and a
 * grant with 48 hours left is the archetypal case: the outcome of ignoring it
 * is safe, bounded and already decided. Sending it at `high` would make trust
 * notifications the thing an operator learns to swipe away, and the escalation
 * that actually needs them would be swiped with it.
 *
 * ## No registry import
 *
 * `actionClassTitle` is RESOLVED BY THE CALLER, exactly as
 * `ApprovalForNotification` requires and for the same reason: the governing
 * test for #94 forbids anything under `src/notifications/` importing
 * `src/supervisor/`, because "escalation to a human" is on VISION §7's
 * left-hand column and the erosion arrives "one convenient dependency at a
 * time, each individually reasonable". This would be exactly such a
 * dependency — the registry is a frozen array with no I/O — and it was caught
 * once already in #98.
 */

/**
 * The subset of a grant this builder needs.
 *
 * Structural rather than `TrustGrantView`, matching
 * `ApprovalForNotification`: the builder is a pure function and should be
 * callable from a spec with a literal, and from the task with the view it just
 * read, without either side owning the other's shape.
 */
export interface GrantForRenewalNotification {
  id: string;
  /** A registry id where possible; an unrecognised string is tolerated. */
  actionClass: string;
  /** The ADR-0011 registry title, resolved by the caller. Null falls back. */
  actionClassTitle?: string | null;
  /** Scope, half two. VISION §8: never "trust the agent". */
  repositoryId: string;
  /** When it stops authorizing. */
  expiresAt: Date;
  /** When it started authorizing — the other end of "what it did". */
  createdAt: Date;

  // --- The record ---------------------------------------------------------

  spentUsd: number;
  budgetCeilingUsd: number;
  remainingBudgetUsd: number;
  actionsAuthorized: number;
  actionsFailed: number;
  /**
   * NULL when nothing has been authorized: 0/0 is no evidence, and rendering
   * it as a 0% failure rate says the opposite of what the data supports —
   * `TrustGrantView.failureRate` makes the same call, and this prompt is one
   * of the few places an operator acts on the number.
   */
  failureRate: number | null;
}

export function buildRenewalPayload(
  grant: GrantForRenewalNotification,
  appUrl: string,
  now: Date,
): NotificationPayload {
  const title = grant.actionClassTitle ?? grant.actionClass;
  const msLeft = grant.expiresAt.getTime() - now.getTime();

  return {
    // No `escalationId` and no `receiptId`, and neither is an omission. A
    // grant approaching its expiry is not a stall: nothing is broken, nothing
    // is stopped, and the default outcome is the safe one. Minting an
    // escalation row so this could carry an id would put every renewal prompt
    // into the stop-to-notified percentiles that VISION success metric 1
    // computes over escalations — a measure of how long a BROKEN RUN went
    // unnoticed — and report a detection problem that does not exist. The
    // daily brief is deliberately not an escalation for exactly this reason.
    priority: 'normal',
    title: `Trust grant expiring: ${title}`,
    // WHAT.
    body:
      `Your trust grant for "${title}" expires in ${describe(msLeft)} ` +
      `(${grant.expiresAt.toISOString()}). Renewing is one tap; doing ` +
      'nothing lets it lapse.',
    // WHY — the record, so the decision is not made blind. Three figures,
    // because they are the three a renewal turns on: what it did, what it
    // cost, and whether it worked.
    why: recordSentence(grant),
    // BLAST RADIUS. Scoped to one action class in one repository, and saying
    // so is half the reassurance: an operator who cannot remember what a
    // grant covers assumes the worst, and an operator who assumes the worst
    // renews everything to be safe.
    blastRadius:
      `One action class in one repository: "${title}" in repository ` +
      `${grant.repositoryId}. Renewing affects nothing else — a grant is ` +
      'never "trust the agent" (VISION §8), and this prompt cannot widen ' +
      'its scope, its ceiling or its thresholds.',
    // WHAT HAPPENS IF IGNORED. Do not soften this.
    ifIgnored:
      `The grant expires at ${grant.expiresAt.toISOString()} and is NOT ` +
      'renewed. From that instant actions of this class in this repository ' +
      'stop running unattended and start asking you again, one at a time. ' +
      'Nothing extends it, nothing catches it, and this is the only prompt ' +
      'you will get about this grant — VISION §8: silence revokes. Nothing ' +
      'is lost by letting it lapse except the automation; no work is ' +
      'destroyed and no money is spent.',
    // Straight to the one grant. VISION §8's "one tap" is literal, and the
    // link carries NO AUTHORITY: it opens the authenticated cockpit, and the
    // renewal endpoint requires a real session with `trust:grant` — the same
    // argument `ApprovalsController` makes at length about why a notification
    // may not be a credential.
    url: `${appUrl}/trust/grants/${grant.id}`,
    kind: 'trust_grant_expiring',
    raisedAt: now.toISOString(),
  };
}

/**
 * What this grant actually did, in one sentence naming its numbers.
 *
 * #47's house rule — "the reason is not a log message" — applied to a renewal:
 * a prompt the operator cannot check is one they will answer by reflex, and a
 * reflex "yes" to a trust question is the blanket grant VISION §8 exists to
 * prevent.
 */
function recordSentence(grant: GrantForRenewalNotification): string {
  const spend =
    `$${grant.spentUsd.toFixed(2)} of its ` +
    `$${grant.budgetCeilingUsd.toFixed(2)} ceiling spent ` +
    `($${grant.remainingBudgetUsd.toFixed(2)} left)`;

  if (grant.actionsAuthorized === 0) {
    // Zero actions is a real and useful answer, not an empty state. A grant
    // that never authorized anything is the clearest possible case for
    // letting it lapse, and saying "0 failures" instead would imply a clean
    // record where there is no record at all.
    return (
      `Granted ${grant.createdAt.toISOString()}. It authorized NOTHING in ` +
      `that time — 0 actions, ${spend}. Nothing has used this grant, so ` +
      'letting it lapse costs you nothing you are currently getting.'
    );
  }

  const failures =
    grant.failureRate === null
      ? 'failure rate unknown'
      : `${grant.actionsFailed} failed (${(grant.failureRate * 100).toFixed(0)}%)`;

  return (
    `Granted ${grant.createdAt.toISOString()}. It authorized ` +
    `${grant.actionsAuthorized} action(s) without asking you, of which ` +
    `${failures}, and ${spend}. Renewing starts a fresh budget and a fresh ` +
    "expiry from the defaults, narrowed by this grant's own terms — a " +
    'renewal can never widen what was granted.'
  );
}

/**
 * A duration as a phrase.
 *
 * Coarse on purpose, mirroring `describeDuration` in `trust-grant.service.ts`:
 * "2 days" is what makes a lock-screen line legible, and "1 day, 23 hours and
 * 47 minutes" is what makes it get skipped. Duplicated rather than imported
 * because importing it would drag the trust service — and its Prisma client —
 * into a pure payload builder on the escalation path.
 */
function describe(ms: number): string {
  if (ms <= 0) return 'less than a minute';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
