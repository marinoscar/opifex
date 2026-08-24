import type { TrustGrantEndReason, TrustGrantStatus } from '@prisma/client';

import {
  NEAR_BUDGET_HEADROOM_FRACTION,
  NEAR_EXPIRY_WINDOW_MS,
} from '../../trust/defaults';
import type { TrustGrantView } from '../../trust/trust-grant.types';
import {
  ACTIVITY_SPIKE_FACTOR,
  BUDGET_ALARM_SPENT_FRACTION,
  MAX_TRUST_DIGEST_ITEMS,
  RENEWAL_SIGNAL_WINDOW_MS,
  type Anomaly,
  type AnomalyKind,
  type TrustDigestAction,
  type TrustDigestInput,
  buildTrustDigest,
  renderTrustDigest,
} from './trust-digest';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A grant view with its derived figures computed CONSISTENTLY.
 *
 * The derived fields are not overridable one at a time on purpose: a fixture
 * where `spentUsd` and `budgetHeadroomFraction` disagree would let a test pass
 * against a state the real `toTrustGrantView` can never produce, which is the
 * quiet way a threshold test stops testing the threshold.
 */
function grant(
  options: {
    id?: string;
    actionClass?: string;
    repositoryId?: string;
    spentUsd?: number;
    budgetCeilingUsd?: number;
    msUntilExpiry?: number;
    actionsAuthorized?: number;
    actionsFailed?: number;
    maxCostPerActionUsd?: number;
    minActionsBeforeAutoRevoke?: number;
    status?: TrustGrantStatus;
    endReason?: TrustGrantEndReason | null;
    endDetail?: string | null;
  } = {},
): TrustGrantView {
  const budgetCeilingUsd = options.budgetCeilingUsd ?? 25;
  const spentUsd = options.spentUsd ?? 5;
  const msUntilExpiry = options.msUntilExpiry ?? 10 * DAY;
  const actionsAuthorized = options.actionsAuthorized ?? 10;
  const actionsFailed = options.actionsFailed ?? 0;
  const remainingBudgetUsd = Math.max(0, budgetCeilingUsd - spentUsd);
  const budgetHeadroomFraction =
    budgetCeilingUsd > 0
      ? Math.min(1, Math.max(0, remainingBudgetUsd / budgetCeilingUsd))
      : 0;
  const status = options.status ?? 'active';
  const ended = status !== 'active';

  return {
    id: options.id ?? 'grant-1',
    actionClass: options.actionClass ?? 're-dispatch',
    repositoryId: options.repositoryId ?? 'repo-1',
    expiresAt: new Date(NOW.getTime() + msUntilExpiry).toISOString(),
    budgetCeilingUsd,
    spentUsd,
    actionsAuthorized,
    actionsFailed,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: options.maxCostPerActionUsd ?? 5,
    minActionsBeforeAutoRevoke: options.minActionsBeforeAutoRevoke ?? 3,
    status,
    endedAt: ended ? new Date(NOW.getTime() - HOUR).toISOString() : null,
    endReason: options.endReason ?? null,
    endDetail: options.endDetail ?? null,
    revokedById: null,
    note: null,
    grantedById: 'user-1',
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: new Date(NOW.getTime() - 7 * DAY).toISOString(),
    updatedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    remainingBudgetUsd,
    budgetHeadroomFraction,
    msUntilExpiry,
    failureRate:
      actionsAuthorized > 0 ? actionsFailed / actionsAuthorized : null,
    nearExpiry: msUntilExpiry > 0 && msUntilExpiry <= NEAR_EXPIRY_WINDOW_MS,
    nearBudget: budgetHeadroomFraction <= NEAR_BUDGET_HEADROOM_FRACTION,
  };
}

function action(overrides: Partial<TrustDigestAction> = {}): TrustDigestAction {
  return {
    approvalId: 'appr-1',
    actionClass: 're-dispatch',
    repositoryId: 'repo-1',
    summary: 'Re-dispatched wo_1 after a transient runner failure',
    targetRef: 'wo_1',
    grantId: 'grant-1',
    estimatedCostUsd: 0.5,
    at: new Date(NOW.getTime() - 3 * HOUR),
    origin: 'grant',
    ...overrides,
  };
}

function input(overrides: Partial<TrustDigestInput> = {}): TrustDigestInput {
  const actions = overrides.actions ?? [];
  return {
    now: NOW,
    windowStart: new Date(NOW.getTime() - DAY),
    actions,
    totalActions: overrides.totalActions ?? actions.length,
    activeGrants: [],
    endedGrants: [],
    previousWindowActionsByGrant: {},
    ...overrides,
  };
}

function kinds(anomalies: Anomaly[]): AnomalyKind[] {
  return anomalies.map((anomaly) => anomaly.kind);
}

// ---------------------------------------------------------------------------

describe('buildTrustDigest (#100)', () => {
  describe('a quiet day', () => {
    it('is quiet when nothing ran, nothing ended and nothing looked unusual', () => {
      const digest = buildTrustDigest(input());

      expect(digest.quiet).toBe(true);
      expect(digest.executed).toEqual([]);
      expect(digest.notShown).toBe(0);
    });

    it('renders as ONE line, not as a padded report', () => {
      // #100's explicit acceptance criterion, and the same argument
      // `composeBrief` makes about a quiet day generally: padding one teaches
      // its reader that most of it can be skipped.
      const lines = renderTrustDigest(buildTrustDigest(input()));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('No action class is promoted');
    });

    it('still says how many grants are standing, in that one line', () => {
      const lines = renderTrustDigest(
        buildTrustDigest(
          input({
            activeGrants: [grant({ id: 'g-a' }), grant({ id: 'g-b' })],
          }),
        ),
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('2 grant(s) still authorizing');
      expect(lines[0]).toContain('none near its budget or its expiry');
    });

    it('is NOT quiet when a grant needs a decision, even with no activity', () => {
      // A day where a grant is three days from expiry with $20 left is not
      // quiet. Reporting it as quiet would suppress exactly the signal #100
      // says turns the digest from a report into a control.
      const digest = buildTrustDigest(
        input({ activeGrants: [grant({ msUntilExpiry: 2 * DAY })] }),
      );

      expect(digest.quiet).toBe(false);
      expect(kinds(digest.anomalies)).toContain('expiring-with-budget-left');
      expect(renderTrustDigest(digest).length).toBeGreaterThan(1);
    });

    it('is NOT quiet when a grant ended in the window', () => {
      const digest = buildTrustDigest(
        input({
          endedGrants: [grant({ status: 'expired', endReason: 'expired' })],
        }),
      );

      expect(digest.quiet).toBe(false);
    });
  });

  describe('completeness — every auto-approved action appears or is counted', () => {
    it('lists every action when there are fewer than the backstop', () => {
      const actions = Array.from({ length: 7 }, (_, i) =>
        action({
          approvalId: `appr-${i}`,
          at: new Date(NOW.getTime() - i * HOUR),
        }),
      );

      const digest = buildTrustDigest(input({ actions }));

      expect(digest.executed).toHaveLength(7);
      expect(digest.notShown).toBe(0);
    });

    it('accounts for the remainder EXACTLY when the backstop truncates', () => {
      const total = MAX_TRUST_DIGEST_ITEMS + 37;
      const actions = Array.from({ length: total }, (_, i) =>
        action({ approvalId: `appr-${String(i).padStart(4, '0')}` }),
      );

      const digest = buildTrustDigest(input({ actions, totalActions: total }));

      expect(digest.executed).toHaveLength(MAX_TRUST_DIGEST_ITEMS);
      expect(digest.notShown).toBe(37);
      expect(digest.executed.length + digest.notShown).toBe(total);
    });

    it('counts from the TRUE total when the caller already capped its read', () => {
      // The source pages with `take`. If `notShown` were derived from the list
      // it was handed, a query cap would become a silent omission — the exact
      // failure the guarantee forbids.
      const actions = Array.from({ length: MAX_TRUST_DIGEST_ITEMS }, (_, i) =>
        action({ approvalId: `appr-${i}` }),
      );

      const digest = buildTrustDigest(input({ actions, totalActions: 1000 }));

      expect(digest.notShown).toBe(1000 - MAX_TRUST_DIGEST_ITEMS);
    });

    it('says how many it could not show rather than truncating silently', () => {
      const total = MAX_TRUST_DIGEST_ITEMS + 5;
      const actions = Array.from({ length: total }, (_, i) =>
        action({ approvalId: `appr-${String(i).padStart(4, '0')}` }),
      );

      const text = renderTrustDigest(
        buildTrustDigest(input({ actions, totalActions: total })),
      ).join('\n');

      expect(text).toContain('and 5 more not listed here');
      expect(text).toContain('meant to be complete');
    });

    it('never reports a negative remainder', () => {
      const digest = buildTrustDigest(
        input({ actions: [action()], totalActions: 0 }),
      );

      expect(digest.notShown).toBe(0);
    });
  });

  describe('both origins', () => {
    it('includes timeout-resolved actions alongside grant-authorized ones', () => {
      // VISION §8: "auto-approved actions still record what would have been
      // asked." A timeout auto-approval ran without a human just as surely.
      const digest = buildTrustDigest(
        input({
          actions: [
            action({ approvalId: 'a', origin: 'grant', grantId: 'grant-1' }),
            action({ approvalId: 'b', origin: 'timeout', grantId: null }),
          ],
        }),
      );

      expect(digest.executed).toHaveLength(2);
      expect(digest.executed.map((item) => item.origin)).toEqual([
        'grant',
        'timeout',
      ]);
    });

    it('labels the two distinguishably in the rendered lines', () => {
      // They are not the same fact. A grant is machine action on evidence a
      // human supplied earlier; a timeout is silence, not agreement.
      const text = renderTrustDigest(
        buildTrustDigest(
          input({
            actions: [
              action({
                approvalId: 'a',
                origin: 'grant',
                grantId: 'grant-abc12345',
              }),
              action({
                approvalId: 'b',
                origin: 'timeout',
                grantId: null,
                targetRef: 'wo_2',
              }),
            ],
          }),
        ),
      ).join('\n');

      expect(text).toContain('under grant grant-ab');
      expect(text).toContain('resolved by timeout');
      expect(text).toContain('nobody answered');
    });

    it('says in the header how many nobody ever agreed to', () => {
      const text = renderTrustDigest(
        buildTrustDigest(
          input({
            actions: [
              action({ approvalId: 'a', origin: 'timeout', grantId: null }),
              action({ approvalId: 'b', origin: 'timeout', grantId: null }),
              action({ approvalId: 'c', origin: 'grant' }),
            ],
          }),
        ),
      ).join('\n');

      expect(text).toContain('2 of them resolved by timeout');
    });
  });

  describe('cost and changes, per grant', () => {
    it('attributes cost to the grant that authorized it and sums correctly', () => {
      const digest = buildTrustDigest(
        input({
          actions: [
            action({ approvalId: 'a', grantId: 'g1', estimatedCostUsd: 1.25 }),
            action({ approvalId: 'b', grantId: 'g1', estimatedCostUsd: 2.5 }),
            action({ approvalId: 'c', grantId: 'g2', estimatedCostUsd: 0.75 }),
          ],
        }),
      );

      const byGrant = Object.fromEntries(
        digest.perGrant.map((bucket) => [bucket.grantId, bucket.costUsd]),
      );
      expect(byGrant['g1']).toBe(3.75);
      expect(byGrant['g2']).toBe(0.75);
      expect(digest.totalCostUsd).toBe(4.5);
      expect(
        digest.perGrant.reduce((sum, bucket) => sum + bucket.costUsd, 0),
      ).toBeCloseTo(digest.totalCostUsd, 2);
    });

    it('treats an unknown cost as unknown, never as zero', () => {
      // VISION §6. Counting unknowns as zero understates what ran under
      // trust, and understating it is the direction that flatters the system.
      const digest = buildTrustDigest(
        input({
          actions: [
            action({ approvalId: 'a', estimatedCostUsd: 2 }),
            action({ approvalId: 'b', estimatedCostUsd: null }),
          ],
        }),
      );

      expect(digest.totalCostUsd).toBe(2);
      expect(digest.costUnknownActions).toBe(1);
      expect(digest.perGrant[0].costUnknownActions).toBe(1);
      expect(renderTrustDigest(digest).join('\n')).toContain(
        'plus 1 of unknown cost',
      );
    });

    it('keeps timeout-resolved actions in their own bucket rather than dropping them', () => {
      // Dropping them would make the digest's cost total disagree with the
      // sum of its own lines.
      const digest = buildTrustDigest(
        input({
          actions: [
            action({ approvalId: 'a', grantId: 'g1', estimatedCostUsd: 1 }),
            action({
              approvalId: 'b',
              grantId: null,
              origin: 'timeout',
              estimatedCostUsd: 4,
            }),
          ],
        }),
      );

      const timeoutBucket = digest.perGrant.find(
        (bucket) => bucket.grantId === null,
      );
      expect(timeoutBucket?.costUsd).toBe(4);
      expect(renderTrustDigest(digest).join('\n')).toContain(
        'no grant — resolved by timeout',
      );
    });

    it('reports the distinct targets each grant changed', () => {
      const digest = buildTrustDigest(
        input({
          actions: [
            action({ approvalId: 'a', targetRef: 'wo_1' }),
            action({ approvalId: 'b', targetRef: 'wo_2' }),
            action({ approvalId: 'c', targetRef: 'wo_1' }),
          ],
        }),
      );

      expect(digest.perGrant[0].changedRefs).toEqual(['wo_1', 'wo_2']);
      expect(digest.perGrant[0].actions).toBe(3);
    });
  });

  describe('headroom and expiry — #100 turning the digest into a control', () => {
    it('reports both axes for EVERY active grant', () => {
      const digest = buildTrustDigest(
        input({
          actions: [action()],
          activeGrants: [
            grant({ id: 'g-a' }),
            grant({ id: 'g-b', actionClass: 'label' }),
            grant({ id: 'g-c', actionClass: 'comment' }),
          ],
        }),
      );

      expect(digest.grantStates).toHaveLength(3);
      for (const state of digest.grantStates) {
        expect(typeof state.remainingBudgetUsd).toBe('number');
        expect(typeof state.budgetHeadroomFraction).toBe('number');
        expect(typeof state.msUntilExpiry).toBe('number');
      }
    });

    it('renders a line per grant with dollars, headroom, expiry and failures', () => {
      const text = renderTrustDigest(
        buildTrustDigest(
          input({
            actions: [action()],
            activeGrants: [
              grant({
                id: 'grant-aaaa1111',
                spentUsd: 5,
                budgetCeilingUsd: 25,
                msUntilExpiry: 10 * DAY,
                actionsAuthorized: 10,
                actionsFailed: 2,
              }),
            ],
          }),
        ),
      ).join('\n');

      expect(text).toContain('Grants still authorizing:');
      expect(text).toContain('$5.00 of $25.00 spent');
      expect(text).toContain('80% headroom');
      expect(text).toContain('expires in 10d 0h');
      expect(text).toContain('2 of 10 failed (20%)');
    });

    it('puts the grant that dies soonest first', () => {
      const digest = buildTrustDigest(
        input({
          actions: [action()],
          activeGrants: [
            grant({ id: 'later', msUntilExpiry: 9 * DAY }),
            grant({ id: 'sooner', msUntilExpiry: 5 * DAY }),
          ],
        }),
      );

      expect(digest.grantStates.map((state) => state.grantId)).toEqual([
        'sooner',
        'later',
      ]);
    });

    it('says a grant has expired rather than showing a negative countdown', () => {
      const text = renderTrustDigest(
        buildTrustDigest(
          input({
            actions: [action()],
            activeGrants: [grant({ id: 'stale', msUntilExpiry: -3 * HOUR })],
          }),
        ),
      ).join('\n');

      expect(text).toContain('EXPIRED 3h ago');
    });

    it('reports no failure rate at all rather than 0% when nothing ran', () => {
      // 0/0 is "no evidence"; rendering it as 0% says the opposite of what
      // the data supports.
      const text = renderTrustDigest(
        buildTrustDigest(
          input({
            actions: [action()],
            activeGrants: [grant({ actionsAuthorized: 0, actionsFailed: 0 })],
          }),
        ),
      ).join('\n');

      expect(text).toContain('no actions yet');
    });
  });

  describe('grants that ended in the window', () => {
    it('reports the reason it stopped authorizing', () => {
      const digest = buildTrustDigest(
        input({
          endedGrants: [
            grant({
              id: 'gone',
              status: 'expired',
              endReason: 'expired',
              endDetail: 'Lapsed at its 14-day expiry with $12.00 unspent.',
            }),
          ],
        }),
      );

      expect(digest.endedGrants).toHaveLength(1);
      expect(digest.endedGrants[0].endReason).toBe('expired');

      const text = renderTrustDigest(digest).join('\n');
      expect(text).toContain('Grants that ended:');
      expect(text).toContain('expired');
      expect(text).toContain('$12.00 unspent');
    });

    it('reports a revocation as an ending too, not only an auto-revoke', () => {
      const digest = buildTrustDigest(
        input({
          endedGrants: [
            grant({
              id: 'pulled',
              status: 'revoked',
              endReason: 'manual_revocation',
              endDetail: 'Revoked by an admin.',
            }),
          ],
        }),
      );

      expect(renderTrustDigest(digest).join('\n')).toContain(
        'manual_revocation',
      );
      // A revocation is a human act, so it is an ending but not an anomaly.
      expect(kinds(digest.anomalies)).not.toContain('grant-suspended');
    });
  });

  describe('anomalies — each fires, and each states a number', () => {
    it('a grant suspended in the window, with the sentence that tripped it', () => {
      const digest = buildTrustDigest(
        input({
          endedGrants: [
            grant({
              id: 'burned',
              status: 'suspended',
              endReason: 'failure_rate_exceeded',
              endDetail:
                'Suspended: 4 of 9 authorized actions failed (44%), above the 34% threshold.',
            }),
          ],
        }),
      );

      const anomaly = digest.anomalies.find(
        (candidate) => candidate.kind === 'grant-suspended',
      );
      expect(anomaly?.detail).toContain('4 of 9');
      expect(anomaly?.detail).toContain('44%');
    });

    it('a grant past the budget alarm fraction, still authorizing', () => {
      const digest = buildTrustDigest(
        input({
          activeGrants: [
            grant({ id: 'thin', spentUsd: 22, budgetCeilingUsd: 25 }),
          ],
        }),
      );

      const anomaly = digest.anomalies.find(
        (candidate) => candidate.kind === 'budget-nearly-spent',
      );
      expect(anomaly?.detail).toContain('$22.00 of a $25.00 ceiling');
      expect(anomaly?.detail).toContain('$3.00 left');
      expect(anomaly?.detail).toContain(
        `${Math.round(BUDGET_ALARM_SPENT_FRACTION * 100)}%`,
      );
    });

    it('does not fire the budget alarm on a grant with room left', () => {
      const digest = buildTrustDigest(
        input({
          activeGrants: [
            grant({ id: 'fine', spentUsd: 5, budgetCeilingUsd: 25 }),
          ],
        }),
      );

      expect(kinds(digest.anomalies)).not.toContain('budget-nearly-spent');
    });

    it('a grant expiring inside the renewal window with budget still on it', () => {
      const digest = buildTrustDigest(
        input({
          activeGrants: [
            grant({
              id: 'lapsing',
              msUntilExpiry: RENEWAL_SIGNAL_WINDOW_MS - HOUR,
              spentUsd: 5,
              budgetCeilingUsd: 25,
            }),
          ],
        }),
      );

      const anomaly = digest.anomalies.find(
        (candidate) => candidate.kind === 'expiring-with-budget-left',
      );
      expect(anomaly?.detail).toContain('$20.00 of $25.00');
      expect(anomaly?.detail).toContain('Expires in 2d 23h');
      expect(anomaly?.detail).toContain('silence revokes');
    });

    it('does not fire the renewal signal outside the window', () => {
      const digest = buildTrustDigest(
        input({
          activeGrants: [
            grant({
              id: 'far',
              msUntilExpiry: RENEWAL_SIGNAL_WINDOW_MS + HOUR,
            }),
          ],
        }),
      );

      expect(kinds(digest.anomalies)).not.toContain(
        'expiring-with-budget-left',
      );
    });

    it('partitions the two budget anomalies rather than double-reporting', () => {
      // A grant expiring soon with almost nothing left is reported as nearly
      // spent, not as a renewal opportunity: there is nothing left to renew.
      const digest = buildTrustDigest(
        input({
          activeGrants: [
            grant({
              id: 'both',
              msUntilExpiry: 2 * DAY,
              spentUsd: 24,
              budgetCeilingUsd: 25,
            }),
          ],
        }),
      );

      expect(kinds(digest.anomalies)).toEqual(['budget-nearly-spent']);
    });

    it('cost per action above the grant’s own threshold, un-revoked', () => {
      // Auto-revoke rule 3 is blind below `minActionsBeforeAutoRevoke`. The
      // floor exists to stop a rule ACTING on thin evidence, which is not a
      // reason to withhold the observation from the person who could act.
      const digest = buildTrustDigest(
        input({
          actions: [
            action({ approvalId: 'a', grantId: 'pricey', estimatedCostUsd: 8 }),
            action({ approvalId: 'b', grantId: 'pricey', estimatedCostUsd: 8 }),
          ],
          activeGrants: [
            grant({
              id: 'pricey',
              spentUsd: 16,
              budgetCeilingUsd: 50,
              maxCostPerActionUsd: 5,
              actionsAuthorized: 2,
              minActionsBeforeAutoRevoke: 3,
            }),
          ],
        }),
      );

      const anomaly = digest.anomalies.find(
        (candidate) => candidate.kind === 'cost-per-action-above-threshold',
      );
      expect(anomaly?.detail).toContain('$8.00 per action');
      expect(anomaly?.detail).toContain('2 costed action(s)');
      expect(anomaly?.detail).toContain('$5.00 per-action threshold');
      expect(anomaly?.detail).toContain('3-action');
    });

    it('does not fire the cost anomaly when the window is within threshold', () => {
      const digest = buildTrustDigest(
        input({
          actions: [action({ grantId: 'ok', estimatedCostUsd: 1 })],
          activeGrants: [grant({ id: 'ok', maxCostPerActionUsd: 5 })],
        }),
      );

      expect(kinds(digest.anomalies)).not.toContain(
        'cost-per-action-above-threshold',
      );
    });

    it('excludes unknown-cost actions from the per-action mean and says so', () => {
      const digest = buildTrustDigest(
        input({
          actions: [
            action({ approvalId: 'a', grantId: 'p', estimatedCostUsd: 12 }),
            action({ approvalId: 'b', grantId: 'p', estimatedCostUsd: null }),
          ],
          activeGrants: [
            grant({
              id: 'p',
              spentUsd: 12,
              budgetCeilingUsd: 50,
              maxCostPerActionUsd: 5,
              actionsAuthorized: 2,
            }),
          ],
        }),
      );

      const anomaly = digest.anomalies.find(
        (candidate) => candidate.kind === 'cost-per-action-above-threshold',
      );
      expect(anomaly?.detail).toContain('$12.00 per action across 1 costed');
      expect(anomaly?.detail).toContain('1 further action(s) had no estimate');
    });

    it('a spike against the previous window', () => {
      const actions = Array.from({ length: 6 }, (_, i) =>
        action({
          approvalId: `spike-${i}`,
          grantId: 'busy',
          estimatedCostUsd: 0.5,
          targetRef: `wo_${i}`,
        }),
      );

      const digest = buildTrustDigest(
        input({
          actions,
          activeGrants: [grant({ id: 'busy', spentUsd: 3 })],
          previousWindowActionsByGrant: { busy: 2 },
        }),
      );

      const anomaly = digest.anomalies.find(
        (candidate) => candidate.kind === 'activity-spike',
      );
      expect(anomaly?.detail).toContain('6 actions this window against 2');
      expect(anomaly?.detail).toContain('3.0×');
      expect(anomaly?.detail).toContain(`${ACTIVITY_SPIKE_FACTOR}× line`);
      expect(anomaly?.detail).toContain('6 distinct target(s)');
    });

    it('does not call a grant’s first active window a spike', () => {
      // Firing on it would trip this anomaly once for every grant ever
      // created, which is how "unusual" comes to mean "ignore".
      const actions = Array.from({ length: 12 }, (_, i) =>
        action({
          approvalId: `first-${i}`,
          grantId: 'new',
          estimatedCostUsd: 0.1,
        }),
      );

      const digest = buildTrustDigest(
        input({
          actions,
          activeGrants: [grant({ id: 'new', spentUsd: 1.2 })],
          previousWindowActionsByGrant: {},
        }),
      );

      expect(kinds(digest.anomalies)).not.toContain('activity-spike');
    });

    it('does not call a threefold rise from one action a spike', () => {
      const actions = Array.from({ length: 3 }, (_, i) =>
        action({
          approvalId: `few-${i}`,
          grantId: 'tiny',
          estimatedCostUsd: 0.1,
        }),
      );

      const digest = buildTrustDigest(
        input({
          actions,
          activeGrants: [grant({ id: 'tiny', spentUsd: 0.3 })],
          previousWindowActionsByGrant: { tiny: 1 },
        }),
      );

      expect(kinds(digest.anomalies)).not.toContain('activity-spike');
    });

    it('gives every anomaly a number an operator can check', () => {
      // An anomaly the operator cannot check is one they will learn to
      // ignore, and an ignored list is worse than none because it looks like
      // coverage.
      const digest = buildTrustDigest(
        input({
          actions: [
            ...Array.from({ length: 6 }, (_, i) =>
              action({
                approvalId: `s-${i}`,
                grantId: 'busy',
                estimatedCostUsd: 9,
              }),
            ),
          ],
          activeGrants: [
            grant({
              id: 'busy',
              spentUsd: 54,
              budgetCeilingUsd: 200,
              actionsAuthorized: 6,
            }),
            grant({ id: 'thin', spentUsd: 24, budgetCeilingUsd: 25 }),
            grant({
              id: 'lapsing',
              msUntilExpiry: 2 * DAY,
              spentUsd: 1,
              budgetCeilingUsd: 25,
            }),
          ],
          endedGrants: [
            grant({
              id: 'burned',
              status: 'suspended',
              endReason: 'budget_exhausted',
              endDetail: 'Suspended: $25.00 spent against a $25.00 ceiling.',
            }),
          ],
          previousWindowActionsByGrant: { busy: 1 },
        }),
      );

      expect(new Set(kinds(digest.anomalies))).toEqual(
        new Set([
          'grant-suspended',
          'budget-nearly-spent',
          'expiring-with-budget-left',
          'cost-per-action-above-threshold',
          'activity-spike',
        ]),
      );
      for (const anomaly of digest.anomalies) {
        expect(anomaly.detail).toMatch(/\d/);
        expect(anomaly.detail.length).toBeGreaterThan(30);
      }
    });

    it('renders the anomalies under a heading of their own', () => {
      const text = renderTrustDigest(
        buildTrustDigest(
          input({
            activeGrants: [grant({ id: 'thin', spentUsd: 24 })],
          }),
        ),
      ).join('\n');

      expect(text).toContain('What looked unusual:');
    });
  });

  it('is pure', () => {
    const state = input({
      actions: [action()],
      activeGrants: [grant()],
      endedGrants: [
        grant({ id: 'x', status: 'expired', endReason: 'expired' }),
      ],
      previousWindowActionsByGrant: { 'grant-1': 1 },
    });

    expect(buildTrustDigest(state)).toEqual(buildTrustDigest(state));
  });

  it('orders the executed list chronologically', () => {
    const digest = buildTrustDigest(
      input({
        actions: [
          action({ approvalId: 'late', at: new Date(NOW.getTime() - HOUR) }),
          action({
            approvalId: 'early',
            at: new Date(NOW.getTime() - 9 * HOUR),
          }),
        ],
      }),
    );

    expect(digest.executed.map((item) => item.at)).toEqual(['03:00', '11:00']);
  });
});
