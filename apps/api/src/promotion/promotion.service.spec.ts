import { ConfigService } from '@nestjs/config';

import type { ApprovalGateService } from '../approvals/approval-gate.service';
import type { ClassApprovalRates } from '../approvals/approval.types';
import type { FallbackWebhookTransport } from '../notifications/fallback-webhook.transport';
import type { NotificationPayload } from '../notifications/notification-payload';
import type { PushSubscriptionsService } from '../notifications/push-subscriptions.service';
import type { WebPushTransport } from '../notifications/web-push.transport';
import type { PrismaService } from '../prisma/prisma.service';
import type { DecisionLogService } from '../supervisor/decision-log/decision-log.service';
import type { ActionClassApprovalRate } from '../supervisor/decision-log/decision-log.types';
import type { TrustGrantService } from '../trust/trust-grant.service';
import { MANUAL_HOLD_DAYS, REGRESSION_WINDOW_DAYS } from './promotion-policy';
import { PromotionService } from './promotion.service';

const NOW = new Date('2026-08-24T12:00:00.000Z');

// --- Fixture builders ------------------------------------------------------

function proposalRate(
  actionClass: string,
  wouldApprove: number,
  wouldReject: number,
): ActionClassApprovalRate {
  const judged = wouldApprove + wouldReject;
  return {
    actionClass,
    proposed: judged,
    declined: 0,
    wouldApprove,
    wouldReject,
    pendingReview: 0,
    approvalRate: judged === 0 ? null : wouldApprove / judged,
  };
}

function gateRate(
  actionClass: string,
  approved: number,
  denied: number,
  extra: Partial<ClassApprovalRates> = {},
): ClassApprovalRates {
  const humanDecisions = approved + denied;
  return {
    actionClass,
    approved,
    denied,
    humanDecisions,
    approvalRate: humanDecisions === 0 ? null : approved / humanDecisions,
    autoApproved: 0,
    autoDenied: 0,
    grantAuthorized: 0,
    pending: 0,
    parked: 0,
    superseded: 0,
    ...extra,
  };
}

interface StoredState {
  actionClass: string;
  rung: 'observe' | 'measure' | 'promoted';
  changedAt: Date;
  changeReason: string | null;
  changeDetail: string | null;
  changedById: string | null;
  evidenceJson: unknown;
  manualHoldUntil: Date | null;
  promotedAt: Date | null;
  demotedAt: Date | null;
  demotionCount: number;
}

function storedState(
  actionClass: string,
  rung: StoredState['rung'],
  overrides: Partial<StoredState> = {},
): StoredState {
  return {
    actionClass,
    rung,
    changedAt: new Date('2026-08-01T00:00:00.000Z'),
    changeReason: rung === 'promoted' ? 'promoted_on_evidence' : null,
    changeDetail: null,
    changedById: null,
    evidenceJson: null,
    manualHoldUntil: null,
    promotedAt:
      rung === 'promoted' ? new Date('2026-08-01T00:00:00.000Z') : null,
    demotedAt: null,
    demotionCount: 0,
    ...overrides,
  };
}

/**
 * An in-memory `promotion_states` table with real upsert semantics.
 *
 * A jest.fn() that resolved undefined would let a broken upsert pass every
 * idempotency test in this file, because the second `findMany` would return
 * the same rows the first did no matter what was written. The whole idempotency
 * claim is about what the SECOND call sees, so the store has to actually store.
 */
function makeStore(initial: StoredState[] = []) {
  const rows = new Map(initial.map((row) => [row.actionClass, { ...row }]));

  const upsert = jest.fn(
    async (args: {
      where: { actionClass: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = args.where.actionClass;
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, { ...existing, ...args.update } as StoredState);
      } else {
        rows.set(key, {
          demotionCount: 0,
          promotedAt: null,
          demotedAt: null,
          ...args.create,
        } as unknown as StoredState);
      }
      return rows.get(key);
    },
  );

  const findMany = jest.fn(async () =>
    [...rows.values()].map((row) => ({ ...row })),
  );

  const findUnique = jest.fn(
    async (args: { where: { actionClass: string } }) => {
      const row = rows.get(args.where.actionClass);
      return row ? { ...row } : null;
    },
  );

  return { rows, upsert, findMany, findUnique };
}

function build(
  options: {
    enabled?: boolean;
    proposalsLifetime?: ActionClassApprovalRate[];
    proposalsRecent?: ActionClassApprovalRate[];
    gateLifetime?: ClassApprovalRates[];
    gateRecent?: ClassApprovalRates[];
    states?: StoredState[];
    activeGrants?: { id: string }[];
    pushConfigured?: boolean;
    pushAccepted?: boolean;
  } = {},
) {
  const store = makeStore(options.states ?? []);

  const grantFindMany = jest.fn().mockResolvedValue(options.activeGrants ?? []);

  const prisma = {
    promotionState: {
      findMany: store.findMany,
      findUnique: store.findUnique,
      upsert: store.upsert,
    },
    trustGrant: { findMany: grantFindMany },
  } as unknown as PrismaService;

  // Two calls with different `since` arguments; the recent one is the second.
  const approvalRates = jest
    .fn()
    .mockImplementation(async (since?: Date) =>
      since === undefined
        ? (options.proposalsLifetime ?? [])
        : (options.proposalsRecent ?? []),
    );

  const approvalRatesByClass = jest
    .fn()
    .mockImplementation(async (sinceDays: number) =>
      sinceDays === REGRESSION_WINDOW_DAYS
        ? (options.gateRecent ?? [])
        : (options.gateLifetime ?? []),
    );

  const suspend = jest.fn().mockResolvedValue(true);

  const pushSend = jest.fn().mockResolvedValue({
    targetId: 't1',
    accepted: options.pushAccepted ?? true,
    gone: false,
  });

  const webhookSend = jest
    .fn()
    .mockResolvedValue({ targetId: 'w', accepted: true, gone: false });

  const service = new PromotionService(
    prisma,
    { approvalRatesByClass } as unknown as ApprovalGateService,
    { approvalRates } as unknown as DecisionLogService,
    { suspend } as unknown as TrustGrantService,
    {
      targets: jest.fn().mockResolvedValue([
        {
          id: 't1',
          endpoint: 'https://push.example/1',
          keys: { p256dh: 'p', auth: 'a' },
        },
      ]),
    } as unknown as PushSubscriptionsService,
    {
      isConfigured: () => options.pushConfigured ?? true,
      send: pushSend,
    } as unknown as WebPushTransport,
    {
      isConfigured: () => false,
      send: webhookSend,
    } as unknown as FallbackWebhookTransport,
    new ConfigService({
      appUrl: 'https://opifex.example',
      promotion: { enabled: options.enabled ?? true },
    }),
  );

  return {
    service,
    store,
    suspend,
    pushSend,
    webhookSend,
    grantFindMany,
    approvalRates,
    approvalRatesByClass,
    /** The payloads an operator would actually have received. */
    payloads: (): NotificationPayload[] =>
      pushSend.mock.calls.map((call) => call[1] as NotificationPayload),
  };
}

// ---------------------------------------------------------------------------

describe('PromotionService.gatherEvidence', () => {
  it('sums BOTH sources and records where each decision came from', () => {
    // #99 says the rate is "computed per class from real history", and there
    // are two records of a human judging: review-queue verdicts (#90), which
    // are the only evidence the observation phase produces, and live approval
    // gate decisions (#97). Counting only one would either leave the ladder
    // with no evidence for weeks or freeze it the day the gate went live.
    const harness = build({
      proposalsLifetime: [proposalRate('re-dispatch', 12, 3)],
      gateLifetime: [gateRate('re-dispatch', 6, 1)],
    });

    return harness.service.gatherEvidence(NOW).then((all) => {
      const item = all.find((e) => e.actionClass === 're-dispatch');
      expect(item).toMatchObject({
        approved: 18,
        rejected: 4,
        sample: 22,
        fromProposals: 15,
        fromApprovals: 7,
      });
      expect(item?.rate).toBeCloseTo(18 / 22, 10);
    });
  });

  it('reads the recent window from the same two sources', async () => {
    const harness = build({
      proposalsLifetime: [proposalRate('re-dispatch', 40, 1)],
      proposalsRecent: [proposalRate('re-dispatch', 1, 4)],
      gateLifetime: [gateRate('re-dispatch', 10, 0)],
      gateRecent: [gateRate('re-dispatch', 0, 3)],
    });

    const all = await harness.service.gatherEvidence(NOW);
    const item = all.find((e) => e.actionClass === 're-dispatch');

    expect(item).toMatchObject({
      recentApproved: 1,
      recentRejected: 7,
      recentSample: 8,
    });

    // The gate read model is asked for the regression window by name, so the
    // exclusion of timeouts and grant-authorized rows is applied by the one
    // implementation that owns it rather than re-derived here.
    expect(harness.approvalRatesByClass).toHaveBeenCalledWith(
      REGRESSION_WINDOW_DAYS,
      NOW,
    );
  });

  it('reports a rate of null, not 0, for a class with no evidence', async () => {
    // 0/0 is NO evidence. A 0% rate would read as a class humans reject every
    // single time, which is the opposite conclusion from the one the data
    // supports.
    const harness = build();
    const all = await harness.service.gatherEvidence(NOW);
    const item = all.find((e) => e.actionClass === 'issue-shaping');

    expect(item?.sample).toBe(0);
    expect(item?.rate).toBeNull();
    expect(item?.recentRate).toBeNull();
  });

  it('seeds every registered class, so a silent class is visible not absent', async () => {
    // #90 makes the same argument about its own read model: a class MISSING
    // from the list is indistinguishable from one that has never been asked
    // for, and the ladder must be able to tell those apart.
    const harness = build();
    const all = await harness.service.gatherEvidence(NOW);
    const ids = all.map((e) => e.actionClass);

    expect(ids).toEqual(
      expect.arrayContaining([
        'run-diagnosis',
        're-dispatch',
        'decomposition',
        'issue-shaping',
        'spec-quality-feedback',
        'daily-brief',
        'quarantine-decision',
      ]),
    );
  });

  it('keeps a class that has left the registry but may still be promoted', async () => {
    // Dropping it would mean a promoted class that is never re-evaluated and
    // therefore never demoted — autonomy that outlives its own taxonomy entry.
    const harness = build({
      gateLifetime: [gateRate('retired-class', 5, 1)],
    });
    const all = await harness.service.gatherEvidence(NOW);
    expect(all.map((e) => e.actionClass)).toContain('retired-class');
  });
});

describe('PromotionService.evaluate: promotion', () => {
  const strongRecord = {
    proposalsLifetime: [proposalRate('re-dispatch', 27, 1)],
    proposalsRecent: [proposalRate('re-dispatch', 9, 0)],
  };

  it('promotes a class that clears both thresholds, and records the evidence', async () => {
    const harness = build(strongRecord);
    const result = await harness.service.evaluate(NOW);

    const change = result.changes.find((c) => c.actionClass === 're-dispatch');
    expect(change).toMatchObject({
      from: 'observe',
      to: 'promoted',
      reason: 'promoted_on_evidence',
      grantsSuspended: 0,
    });

    // Frozen at decision time. #99 requires promotion to "state its evidence",
    // and evidence recomputed later describes a different factory.
    const row = harness.store.rows.get('re-dispatch');
    expect(row?.rung).toBe('promoted');
    expect(row?.promotedAt).toEqual(NOW);
    expect(row?.evidenceJson).toMatchObject({ approved: 27, sample: 28 });
  });

  it('MINTS NOTHING: a promotion makes a class eligible for a grant, not granted', async () => {
    // VISION §8's "Always approve this class" is a TAP — the one edge in the
    // provenance graph that says a human extended trust. A ladder that minted
    // grants would have the system grant itself authority on its own
    // measurements, and would have to invent an expiry and a budget ceiling
    // nobody chose.
    const harness = build(strongRecord);
    await harness.service.evaluate(NOW);

    expect(harness.suspend).not.toHaveBeenCalled();
    // The service holds no way to create one: the only TrustGrantService
    // method it can reach is `suspend`.
    expect(Object.keys(harness.store.rows)).not.toContain('grant');
  });

  it('notifies at NORMAL priority, stating its evidence', async () => {
    const harness = build(strongRecord);
    await harness.service.evaluate(NOW);

    const payload = harness.payloads()[0];
    expect(payload.priority).toBe('normal');
    expect(payload.title).toContain('re-dispatch');
    expect(payload.why).toContain('28 human decision(s)');
    expect(payload.why).toContain('27 approved, 1 rejected');
    // The blast radius must not claim something started running.
    expect(payload.blastRadius).toContain('does not');
  });

  it('puts VISION §7 order check in the notification', async () => {
    const harness = build(strongRecord);
    await harness.service.evaluate(NOW);
    expect(harness.payloads()[0].why).toContain(
      "consistent with VISION §7's expected promotion order",
    );
  });

  it('flags an out-of-order promotion in the notification', async () => {
    // #99: "A system that promotes quarantine decisions first has a
    // measurement bug, not a breakthrough." Made checkable rather than
    // aspirational — and it warns without blocking, because a heuristic that
    // could veto a decision made on real evidence would override data with a
    // prediction.
    const harness = build({
      proposalsLifetime: [proposalRate('issue-shaping', 27, 1)],
      proposalsRecent: [proposalRate('issue-shaping', 9, 0)],
    });
    await harness.service.evaluate(NOW);

    const payload = harness.payloads()[0];
    expect(payload.why).toContain('ORDER CHECK');
    expect(payload.why).toContain('"re-dispatch"');
    // Promoted anyway.
    expect(harness.store.rows.get('issue-shaping')?.rung).toBe('promoted');
  });

  it('is idempotent: a second evaluation over unchanged evidence does nothing', async () => {
    const harness = build(strongRecord);

    const first = await harness.service.evaluate(NOW);
    expect(first.changes).toHaveLength(1);

    harness.pushSend.mockClear();
    harness.store.upsert.mockClear();

    const second = await harness.service.evaluate(NOW);
    expect(second.changes).toHaveLength(0);
    expect(harness.store.upsert).not.toHaveBeenCalled();
    expect(harness.pushSend).not.toHaveBeenCalled();

    // ... and the class is still promoted, held rather than re-promoted.
    expect(
      second.holds.find((h) => h.actionClass === 're-dispatch')?.rung,
    ).toBe('promoted');
  });
});

describe('PromotionService.evaluate: ineligibility', () => {
  it('never promotes quarantine-decision on a perfect record', async () => {
    const harness = build({
      proposalsLifetime: [proposalRate('quarantine-decision', 500, 0)],
      proposalsRecent: [proposalRate('quarantine-decision', 100, 0)],
    });
    await harness.service.evaluate(NOW);

    // It moved to `measure` — evidence exists — but never to `promoted`.
    expect(harness.store.rows.get('quarantine-decision')?.rung).toBe('measure');
    expect(harness.pushSend).not.toHaveBeenCalled();
  });

  it('demotes an ineligible class that is somehow already promoted', async () => {
    const harness = build({
      proposalsLifetime: [proposalRate('quarantine-decision', 500, 0)],
      proposalsRecent: [proposalRate('quarantine-decision', 100, 0)],
      states: [storedState('quarantine-decision', 'promoted')],
      activeGrants: [{ id: 'g1' }],
    });
    const result = await harness.service.evaluate(NOW);

    expect(result.changes[0]).toMatchObject({
      actionClass: 'quarantine-decision',
      reason: 'demoted_ineligible',
      grantsSuspended: 1,
    });
    expect(harness.suspend).toHaveBeenCalledWith(
      'g1',
      'class_demoted',
      expect.stringContaining('quarantine-decision'),
      NOW,
    );
  });
});

describe('PromotionService.evaluate: demotion', () => {
  // Excellent lifetime, terrible fortnight. A lifetime average of 97.6% would
  // hide a recent 20% completely, which is why demotion reads the window.
  const regression = {
    proposalsLifetime: [proposalRate('re-dispatch', 400, 10)],
    proposalsRecent: [proposalRate('re-dispatch', 2, 8)],
    states: [storedState('re-dispatch', 'promoted')],
  };

  it('demotes on a recent regression despite an excellent lifetime record', async () => {
    const harness = build(regression);
    const result = await harness.service.evaluate(NOW);

    expect(result.changes[0]).toMatchObject({
      actionClass: 're-dispatch',
      from: 'promoted',
      to: 'measure',
      reason: 'demoted_on_regression',
    });
    expect(harness.store.rows.get('re-dispatch')?.demotedAt).toEqual(NOW);
  });

  it('suspends active grants for the class with class_demoted', async () => {
    // Not the same as minting: narrowing authority is always safe. Leaving
    // grants live for a demoted class would make demotion cosmetic — the rung
    // would read `measure` while the class carried on executing unattended.
    const harness = build({
      ...regression,
      activeGrants: [{ id: 'g1' }, { id: 'g2' }],
    });
    const result = await harness.service.evaluate(NOW);

    expect(harness.grantFindMany).toHaveBeenCalledWith({
      where: { actionClass: 're-dispatch', status: 'active' },
      select: { id: true },
    });
    expect(harness.suspend).toHaveBeenCalledTimes(2);
    expect(harness.suspend).toHaveBeenCalledWith(
      'g2',
      'class_demoted',
      expect.any(String),
      NOW,
    );
    expect(result.changes[0].grantsSuspended).toBe(2);
  });

  it('notifies at HIGH priority, stating its evidence', async () => {
    // The asymmetry with promotion is the point. A demotion means something
    // that WAS running unattended has been stopped and its grants suspended;
    // the operator should know now rather than in the morning.
    const harness = build({ ...regression, activeGrants: [{ id: 'g1' }] });
    await harness.service.evaluate(NOW);

    const payload = harness.payloads()[0];
    expect(payload.priority).toBe('high');
    expect(payload.title).toContain('Demoted');
    expect(payload.why).toContain('20%');
    expect(payload.why).toContain('10 human decision(s)');
    expect(payload.blastRadius).toContain('1 active trust grant(s)');
  });

  it('increments demotionCount, so repeated demotion is visible', async () => {
    // Promoting something for the fourth time is a different act from
    // promoting it once, and a rung alone cannot tell the two apart.
    const harness = build({
      ...regression,
      states: [storedState('re-dispatch', 'promoted', { demotionCount: 3 })],
    });
    await harness.service.evaluate(NOW);
    expect(harness.store.rows.get('re-dispatch')?.demotionCount).toBe(4);
  });

  it('does not re-promote on the next tick, and notifies once', async () => {
    // Rules 3 and 4 read different windows. Without the oscillation guard,
    // this class would demote and re-promote every hour, at one HIGH-priority
    // notification an hour, forever.
    const harness = build(regression);

    await harness.service.evaluate(NOW);
    harness.pushSend.mockClear();

    const second = await harness.service.evaluate(NOW);
    expect(second.changes).toHaveLength(0);
    expect(harness.pushSend).not.toHaveBeenCalled();
    expect(harness.store.rows.get('re-dispatch')?.rung).toBe('measure');
  });

  it('records the demotion even when nobody could be told', async () => {
    // #58's distinction between "we tried to tell you" and "we never noticed".
    // The row is written first, so a demotion nobody heard about is still
    // where an operator can find it.
    const harness = build({ ...regression, pushConfigured: false });
    const result = await harness.service.evaluate(NOW);

    expect(result.changes[0].notified).toBe(false);
    expect(harness.store.rows.get('re-dispatch')?.rung).toBe('measure');
  });

  it('suspends the remaining grants when one suspension fails', async () => {
    // Abandoning the loop on the first error would leave an arbitrary suffix
    // of grants live for a class that may no longer run unattended, silently.
    const harness = build({
      ...regression,
      activeGrants: [{ id: 'g1' }, { id: 'g2' }],
    });
    harness.suspend
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce(true);

    const result = await harness.service.evaluate(NOW);
    expect(harness.suspend).toHaveBeenCalledTimes(2);
    expect(result.changes[0].grantsSuspended).toBe(1);
  });
});

describe('PromotionService.evaluate: pausing', () => {
  it('promotes nothing while paused, and says why', async () => {
    const harness = build({
      enabled: false,
      proposalsLifetime: [proposalRate('re-dispatch', 27, 1)],
      proposalsRecent: [proposalRate('re-dispatch', 9, 0)],
    });
    const result = await harness.service.evaluate(NOW);

    expect(result.paused).toBe(true);
    expect(result.changes.every((c) => c.reason === null)).toBe(true);
    expect(harness.store.rows.get('re-dispatch')?.rung).toBe('measure');
    expect(harness.pushSend).not.toHaveBeenCalled();
  });

  it('does NOT demote an already-promoted class, or touch its grants', async () => {
    // #99: the ladder "can be paused globally without dismantling the grants".
    // A pause that revoked autonomy would be a mass revocation, and nobody
    // would ever pause a second time.
    const harness = build({
      enabled: false,
      proposalsLifetime: [proposalRate('re-dispatch', 400, 10)],
      proposalsRecent: [proposalRate('re-dispatch', 2, 8)],
      states: [storedState('re-dispatch', 'promoted')],
      activeGrants: [{ id: 'g1' }],
    });
    const result = await harness.service.evaluate(NOW);

    expect(harness.store.rows.get('re-dispatch')?.rung).toBe('promoted');
    expect(harness.suspend).not.toHaveBeenCalled();
    expect(result.changes).toHaveLength(0);
    expect(
      result.holds.find((h) => h.actionClass === 're-dispatch')?.detail,
    ).toContain('paused');
  });

  it('still demotes an ineligible promoted class', async () => {
    // A pause suspends the ladder's JUDGEMENTS. Ineligibility is a hardcoded
    // declaration about what may ever run unattended, not a judgement.
    const harness = build({
      enabled: false,
      states: [storedState('quarantine-decision', 'promoted')],
      activeGrants: [{ id: 'g1' }],
    });
    const result = await harness.service.evaluate(NOW);

    expect(result.changes[0]).toMatchObject({
      actionClass: 'quarantine-decision',
      reason: 'demoted_ineligible',
    });
  });
});

describe('PromotionService.evaluate: the observe -> measure transition', () => {
  it('moves a class to measure on its first judgement, silently', async () => {
    // A rung change, but not a decision: nothing was promoted or demoted and
    // nothing runs differently. Waking somebody to say "one data point exists
    // now" is the interruption VISION §8 exists to remove.
    const harness = build({
      proposalsLifetime: [proposalRate('re-dispatch', 1, 0)],
    });
    const result = await harness.service.evaluate(NOW);

    const change = result.changes.find((c) => c.actionClass === 're-dispatch');
    expect(change).toMatchObject({
      from: 'observe',
      to: 'measure',
      reason: null,
      notified: false,
    });
    expect(harness.pushSend).not.toHaveBeenCalled();
  });

  it('leaves a class with no evidence at all on observe, writing nothing', async () => {
    const harness = build();
    const result = await harness.service.evaluate(NOW);

    expect(result.changes).toHaveLength(0);
    expect(harness.store.upsert).not.toHaveBeenCalled();
    expect(
      result.holds.find((h) => h.actionClass === 'issue-shaping'),
    ).toMatchObject({ rung: 'observe' });
  });
});

/**
 * #244: a hand-demotion used to be undone by the ladder inside the hour.
 *
 * Every test here drives the REAL loop — `demoteManually`, then `evaluate` —
 * over a store that actually stores. The bug was never visible in one call: it
 * lived in what the SECOND one saw.
 */
describe('PromotionService: the manual demotion hold (#244)', () => {
  const HOLD_MS = MANUAL_HOLD_DAYS * 24 * 60 * 60 * 1000;

  /**
   * A record the ladder WOULD promote on, and the whole point of the issue.
   * The operator demoting this class knows something the numbers do not yet
   * show; if the numbers already showed it, the anti-oscillation guard would
   * have refused the promotion on its own and no hold would be needed.
   */
  const goodNumbers = {
    proposalsLifetime: [proposalRate('re-dispatch', 27, 1)],
    proposalsRecent: [proposalRate('re-dispatch', 9, 0)],
  };

  it('does NOT re-promote a hand-demoted class on the next evaluation', async () => {
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });

    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);

    // One hour later — the actual cadence of `PromotionTask`, and the window
    // in which this used to be undone.
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const result = await harness.service.evaluate(later);

    expect(
      result.changes.find((c) => c.actionClass === 're-dispatch'),
    ).toBeUndefined();

    const row = harness.store.rows.get('re-dispatch');
    expect(row?.rung).toBe('measure');
    expect(row?.changeReason).toBe('demoted_manually');
  });

  it('stays demoted for the whole term, not just the first tick', async () => {
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);

    // A day short of the term. 336 hourly evaluations have run by now.
    const nearlyUp = new Date(NOW.getTime() + HOLD_MS - 24 * 60 * 60 * 1000);
    await harness.service.evaluate(nearlyUp);

    expect(harness.store.rows.get('re-dispatch')?.rung).toBe('measure');
  });

  it('STILL PROMOTES a class that was never hand-demoted, on the same evidence', async () => {
    // The control. A fix that stopped the ladder promoting anything would pass
    // every other test in this block.
    const harness = build(goodNumbers);
    const result = await harness.service.evaluate(NOW);

    expect(
      result.changes.find((c) => c.actionClass === 're-dispatch'),
    ).toMatchObject({ to: 'promoted', reason: 'promoted_on_evidence' });
  });

  it('promotes again once the hold has LAPSED, and says so out loud', async () => {
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);

    // A second past the term. The hold expires deliberately: a permanent one
    // would be a judgement made in an afternoon that becomes permanent policy
    // because nothing revisits it.
    const after = new Date(NOW.getTime() + HOLD_MS + 1000);
    const result = await harness.service.evaluate(after);

    expect(
      result.changes.find((c) => c.actionClass === 're-dispatch'),
    ).toMatchObject({ to: 'promoted', reason: 'promoted_on_evidence' });

    // NOT SILENT. "It re-promotes on a timer" is only a failure if nobody is
    // told, and a promotion notification is sent exactly as for any other.
    const promotion = harness
      .payloads()
      .find((p) => p.title.startsWith('Promoted:'));
    expect(promotion?.title).toContain('re-dispatch');
  });

  it('does not clear the hold timestamp when the class is re-promoted', async () => {
    // "A human held this class down until the 8th" stays true after the ladder
    // takes over again, and it is the demotion's only durable trace on the row
    // once the rung has moved back.
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);
    await harness.service.evaluate(new Date(NOW.getTime() + HOLD_MS + 1000));

    const row = harness.store.rows.get('re-dispatch');
    expect(row?.rung).toBe('promoted');
    expect(row?.manualHoldUntil).toEqual(new Date(NOW.getTime() + HOLD_MS));
  });

  it('re-demoting after the lapse places a FRESH hold', async () => {
    // How an operator whose concern outlives the window re-asserts it. The
    // mirror of VISION §8's "renewal is one tap; silence revokes": here
    // silence lets the hold lapse and action renews it.
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);

    const after = new Date(NOW.getTime() + HOLD_MS + 1000);
    await harness.service.evaluate(after);
    const second = await harness.service.demoteManually(
      're-dispatch',
      'admin-9',
      null,
      after,
    );

    expect(second.manualHoldUntil).toBe(
      new Date(after.getTime() + HOLD_MS).toISOString(),
    );
    expect(harness.store.rows.get('re-dispatch')?.demotionCount).toBe(2);
  });

  it('STILL DEMOTES ON REGRESSION while a hold stands', async () => {
    // A hold asks the ladder not to WIDEN authority. It must never stop the
    // ladder narrowing it. This is the defensive shape — a hand-demotion
    // leaves a class non-promoted, so a promoted-and-held row should not occur
    // — and the assertion is what stops a refactor moving the hold above the
    // regression rule.
    const harness = build({
      proposalsLifetime: [proposalRate('re-dispatch', 400, 10)],
      proposalsRecent: [proposalRate('re-dispatch', 2, 8)],
      states: [
        storedState('re-dispatch', 'promoted', {
          manualHoldUntil: new Date(NOW.getTime() + HOLD_MS),
          changedById: 'admin-9',
        }),
      ],
      activeGrants: [{ id: 'g1' }],
    });

    const result = await harness.service.evaluate(NOW);

    expect(
      result.changes.find((c) => c.actionClass === 're-dispatch'),
    ).toMatchObject({ to: 'measure', reason: 'demoted_on_regression' });
    expect(harness.suspend).toHaveBeenCalled();
  });

  it('records the actor as a COLUMN, not only as prose', async () => {
    // The second hole #244 names. `trust_grants.revoked_by_id` is a column
    // precisely because a provenance edge that lives only in a sentence cannot
    // be queried, and VISION §5 says holes in the graph are not detectable
    // after the fact.
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);

    const row = harness.store.rows.get('re-dispatch');
    expect(row?.changedById).toBe('admin-9');
    expect(row?.manualHoldUntil).toEqual(new Date(NOW.getTime() + HOLD_MS));

    // Readable from the read model too, or the column is a write-only edge.
    const view = await harness.service.stateFor('re-dispatch');
    expect(view.changedById).toBe('admin-9');
    expect(view.manualHoldUntil).toBe(
      new Date(NOW.getTime() + HOLD_MS).toISOString(),
    );
  });

  it('leaves changedById NULL on every automatic transition', async () => {
    // The null is meaningful, not missing data: promotion on evidence and
    // demotion on regression happen with nobody deciding.
    const harness = build(goodNumbers);
    await harness.service.evaluate(NOW);

    expect(harness.store.rows.get('re-dispatch')?.changedById).toBeNull();
  });

  it('clears changedById when the ladder overrides a human, rather than leaving them named', async () => {
    // An edge pointing at a person who did not make the decision would be
    // worse than the prose it replaced.
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);
    await harness.service.evaluate(new Date(NOW.getTime() + HOLD_MS + 1000));

    const row = harness.store.rows.get('re-dispatch');
    expect(row?.changeReason).toBe('promoted_on_evidence');
    expect(row?.changedById).toBeNull();
  });

  it('reports rungMayBeRestoredByLadder as FALSE, and says when the hold lifts', async () => {
    // The field stops being a standing caveat and becomes an answer. It is
    // still computed from `evaluateLadder`, so it would report `true` again if
    // the hold ever stopped working.
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });

    const result = await harness.service.demoteManually(
      're-dispatch',
      'admin-9',
      null,
      NOW,
    );

    expect(result.rungMayBeRestoredByLadder).toBe(false);
    expect(result.manualHoldUntil).toBe(
      new Date(NOW.getTime() + HOLD_MS).toISOString(),
    );
    // The rung change is still real, and so is the durable half.
    expect(result.state.rung).toBe('measure');
  });

  it('tells the read model to forecast no promotion, and explains why', async () => {
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);

    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const view = await harness.service.ladderStateFor('re-dispatch', later);

    // A forecast that ignored the hold would be the #244 warning inverted into
    // a lie: "this will promote" about a class the ladder will not promote.
    expect(view.wouldChange).toBeNull();
    expect(view.requirement).toContain('BY HAND');
    expect(view.requirement).toContain(
      new Date(NOW.getTime() + HOLD_MS).toISOString(),
    );
  });

  it('still suspends grants and still counts the demotion', async () => {
    // The half that already worked must keep working. The grant suspension is
    // the safety-relevant effect; the hold is about the rung.
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
      activeGrants: [{ id: 'g1' }, { id: 'g2' }],
    });

    const result = await harness.service.demoteManually(
      're-dispatch',
      'admin-9',
      null,
      NOW,
    );

    expect(result.grantsSuspended).toBe(2);
    expect(harness.store.rows.get('re-dispatch')?.demotionCount).toBe(1);
  });

  it('tells the operator in the notification that the hold is finite', async () => {
    const harness = build({
      ...goodNumbers,
      states: [storedState('re-dispatch', 'promoted')],
    });
    await harness.service.demoteManually('re-dispatch', 'admin-9', null, NOW);

    const payload = harness
      .payloads()
      .find((p) => p.title.startsWith('Demoted:'));
    expect(payload?.priority).toBe('high');
    expect(payload?.ifIgnored).toContain(`${MANUAL_HOLD_DAYS} days`);
    expect(payload?.why).toContain(
      new Date(NOW.getTime() + HOLD_MS).toISOString(),
    );
  });
});

describe('PromotionService reads', () => {
  it('reports an unevaluated class at observe rather than 404ing', async () => {
    // The ladder not having run is not the same as the class not existing.
    const harness = build();
    const view = await harness.service.stateFor('re-dispatch');

    expect(view).toMatchObject({
      actionClass: 're-dispatch',
      rung: 'observe',
      eligible: true,
      demotionCount: 0,
      evidence: null,
    });
  });

  it('marks quarantine-decision ineligible on the view', async () => {
    const harness = build();
    const view = await harness.service.stateFor('quarantine-decision');
    expect(view.eligible).toBe(false);
  });

  it('lists every registered class whether or not it has a row', async () => {
    const harness = build({ states: [storedState('re-dispatch', 'promoted')] });
    const all = await harness.service.allStates();

    expect(all).toHaveLength(7);
    expect(all.find((v) => v.actionClass === 're-dispatch')?.rung).toBe(
      'promoted',
    );
    expect(all.find((v) => v.actionClass === 'daily-brief')?.rung).toBe(
      'observe',
    );
  });

  it('still lists a promoted class that has left the registry', async () => {
    // Hiding it would report less autonomy than the system actually holds.
    const harness = build({
      states: [storedState('retired-class', 'promoted')],
    });
    const all = await harness.service.allStates();
    expect(all.map((v) => v.actionClass)).toContain('retired-class');
  });
});

describe('PromotionService.enabled', () => {
  it('is false unless the flag is exactly true', () => {
    // Unset, misspelled and empty all mean off — the rule every outward-acting
    // switch in configuration.ts follows.
    expect(build({ enabled: false }).service.enabled).toBe(false);
    expect(build({ enabled: true }).service.enabled).toBe(true);
  });
});
