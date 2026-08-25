import { NotFoundException } from '@nestjs/common';
import type { ApprovalStatus } from '@prisma/client';

import type {
  AutonomyEffect,
  NeverTrustableRefusal,
} from '../autonomy/never-trustable';
import type { NeverTrustableService } from '../autonomy/never-trustable.service';
import type { EscalationsService } from '../escalations/escalations.service';
import type { ApprovalNotifier } from '../notifications/approval-notifier.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_GRANT_BUDGET_CEILING_USD,
  DEFAULT_GRANT_EXPIRY_DAYS,
  DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
  DEFAULT_GRANT_MAX_FAILURE_RATE,
  DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
} from '../trust/defaults';
import type { TrustGrantService } from '../trust/trust-grant.service';
import type { TrustGrantView } from '../trust/trust-grant.types';
import { ApprovalNotPendingException } from './approval-not-pending.exception';
import {
  ApprovalGateService,
  PARKED_BACKFILL_WINDOW_MS,
  parkedApprovalMarker,
  type ApprovalRequestRow,
} from './approval-gate.service';
import type { RaiseApprovalInput } from './approval.types';
import { TIMEOUT_WINDOW_MS } from './timeout-policy';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const REPO = 'repo-1';
const USER = 'user-1';

// =============================================================================
// Doubles
// =============================================================================

/**
 * A Prisma double that honours the WHERE clauses the behaviour depends on.
 *
 * Deliberately not a per-call `mockResolvedValue`. Two of the properties under
 * test ARE the WHERE clause — "the sweep never selects a parked row" and "a
 * conditional update loses the race cleanly" — and a double that returns a
 * canned answer regardless of the filter would pass whether or not the filter
 * were there. This one applies the filter, so deleting `status: 'pending'`
 * from the sweeper's query turns tests red rather than green.
 *
 * Same approach as `trust-grant.service.spec.ts`, for the same reason.
 */
/**
 * The subset of `Escalation` the backfill's dedupe lookup reads (#237).
 *
 * Deliberately holds `detail`, because the dedupe key IS a substring of the
 * detail — there is no column pointing back at an approval — and a double that
 * matched on anything else would pass whether or not the marker was written.
 */
interface EscalationRow {
  id: string;
  kind: string;
  runId: string | null;
  summary: string;
  detail: string;
  raisedAt: Date;
}

function prismaDouble(
  seed: ApprovalRequestRow[] = [],
  escalationSeed: EscalationRow[] = [],
) {
  const rows: ApprovalRequestRow[] = seed.map((r) => ({ ...r }));
  const escalationRows: EscalationRow[] = escalationSeed.map((e) => ({ ...e }));
  let seq = 0;

  function matches(row: ApprovalRequestRow, where: any = {}): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (
      where.repositoryId !== undefined &&
      row.repositoryId !== where.repositoryId
    )
      return false;
    if (
      where.actionClass !== undefined &&
      row.actionClass !== where.actionClass
    )
      return false;

    const status = where.status;
    if (status !== undefined) {
      if (typeof status === 'string') {
        if (row.status !== status) return false;
      } else if (Array.isArray(status.in)) {
        if (!status.in.includes(row.status)) return false;
      }
    }

    const timeoutAt = where.timeoutAt;
    if (timeoutAt !== undefined) {
      if (timeoutAt.not === null && row.timeoutAt === null) return false;
      if (timeoutAt.lte !== undefined) {
        if (row.timeoutAt === null) return false;
        if (row.timeoutAt.getTime() > timeoutAt.lte.getTime()) return false;
      }
    }

    if (where.escalationId !== undefined) {
      if (where.escalationId === null) {
        if (row.escalationId !== null) return false;
      } else if (row.escalationId !== where.escalationId) return false;
    }

    const createdAt = where.createdAt;
    if (createdAt?.gte !== undefined) {
      if (row.createdAt.getTime() < createdAt.gte.getTime()) return false;
    }
    if (createdAt?.lt !== undefined) {
      if (row.createdAt.getTime() >= createdAt.lt.getTime()) return false;
    }

    return true;
  }

  const approvalRequest = {
    create: jest.fn(async ({ data }: any) => {
      seq += 1;
      const row: ApprovalRequestRow = {
        id: data.id ?? `approval-${seq}`,
        actionClass: data.actionClass,
        repositoryId: data.repositoryId,
        proposalId: data.proposalId ?? null,
        targetKind: data.targetKind ?? null,
        targetRef: data.targetRef ?? null,
        summary: data.summary,
        reasoning: data.reasoning,
        blastRadius: data.blastRadius,
        effects: data.effects,
        estimatedCostUsd: data.estimatedCostUsd ?? null,
        timeoutPolicy: data.timeoutPolicy,
        timeoutAt: data.timeoutAt ?? null,
        status: data.status ?? 'pending',
        decidedAt: data.decidedAt ?? null,
        decidedById: data.decidedById ?? null,
        decidedVia: data.decidedVia ?? null,
        decisionNote: data.decisionNote ?? null,
        grantId: data.grantId ?? null,
        createdGrantId: data.createdGrantId ?? null,
        escalationId: data.escalationId ?? null,
        createdAt: data.createdAt ?? NOW,
        updatedAt: NOW,
      };
      rows.push(row);
      return { ...row };
    }),

    findUnique: jest.fn(async ({ where }: any) => {
      const found = rows.find((r) => matches(r, where));
      return found ? { ...found } : null;
    }),

    findUniqueOrThrow: jest.fn(async ({ where }: any) => {
      const found = rows.find((r) => matches(r, where));
      if (!found) throw new Error('not found');
      return { ...found };
    }),

    findMany: jest.fn(async ({ where, orderBy, take }: any) => {
      let found = rows.filter((r) => matches(r, where));
      if (orderBy?.timeoutAt === 'asc') {
        found = [...found].sort(
          (a, b) =>
            (a.timeoutAt?.getTime() ?? 0) - (b.timeoutAt?.getTime() ?? 0),
        );
      }
      if (orderBy?.createdAt === 'asc') {
        found = [...found].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
      }
      return (take ? found.slice(0, take) : found).map((r) => ({ ...r }));
    }),

    updateMany: jest.fn(async ({ where, data }: any) => {
      const targets = rows.filter((r) => matches(r, where));
      for (const target of targets)
        Object.assign(target, data, { updatedAt: NOW });
      return { count: targets.length };
    }),

    update: jest.fn(async ({ where, data }: any) => {
      const target = rows.find((r) => matches(r, where));
      if (!target) throw new Error('not found');
      Object.assign(target, data, { updatedAt: NOW });
      return { ...target };
    }),

    count: jest.fn(async ({ where }: any) => {
      return rows.filter((r) => matches(r, where)).length;
    }),

    groupBy: jest.fn(async ({ where }: any) => {
      const buckets = new Map<string, any>();
      for (const row of rows.filter((r) => matches(r, where))) {
        const key = `${row.actionClass}|${row.status}|${row.decidedVia ?? ''}`;
        const bucket = buckets.get(key) ?? {
          actionClass: row.actionClass,
          status: row.status,
          decidedVia: row.decidedVia,
          _count: { _all: 0 },
        };
        bucket._count._all += 1;
        buckets.set(key, bucket);
      }
      return [...buckets.values()];
    }),
  };

  const escalation = {
    findFirst: jest.fn(async ({ where, orderBy }: any) => {
      let found = escalationRows.filter((e) => {
        if (where.kind !== undefined && e.kind !== where.kind) return false;
        if (where.runId !== undefined && e.runId !== where.runId) return false;
        // The whole point of the lookup. A double that ignored `contains`
        // would report "already escalated" for every approval and hide a
        // broken marker instead of failing on it.
        if (
          where.detail?.contains !== undefined &&
          !e.detail.includes(where.detail.contains)
        )
          return false;
        return true;
      });
      if (orderBy?.raisedAt === 'asc') {
        found = [...found].sort(
          (a, b) => a.raisedAt.getTime() - b.raisedAt.getTime(),
        );
      }
      return found[0] ? { ...found[0] } : null;
    }),
  };

  return {
    prisma: { approvalRequest, escalation } as unknown as PrismaService,
    rows,
    escalationRows,
    approvalRequest,
    escalation,
  };
}

function neverTrustableDouble(refusals: NeverTrustableRefusal[] = []) {
  return {
    enforce: jest.fn(async () =>
      refusals.length === 0
        ? { permitted: true as const }
        : { permitted: false as const, refusals },
    ),
  } as unknown as NeverTrustableService & { enforce: jest.Mock };
}

function grantView(overrides: Partial<TrustGrantView> = {}): TrustGrantView {
  return {
    id: 'grant-1',
    actionClass: 're-dispatch',
    repositoryId: REPO,
    expiresAt: '2026-09-07T12:00:00.000Z',
    budgetCeilingUsd: 25,
    spentUsd: 0,
    actionsAuthorized: 0,
    actionsFailed: 0,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    minActionsBeforeAutoRevoke: 3,
    status: 'active',
    endedAt: null,
    endReason: null,
    endDetail: null,
    revokedById: null,
    note: null,
    grantedById: USER,
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    remainingBudgetUsd: 25,
    budgetHeadroomFraction: 1,
    msUntilExpiry: 14 * 24 * 60 * 60 * 1000,
    failureRate: null,
    nearExpiry: false,
    nearBudget: false,
    ...overrides,
  };
}

function trustDouble(
  authorized: boolean,
  grant: TrustGrantView = grantView(),
  createResult: TrustGrantView | Error = grantView({ id: 'grant-new' }),
) {
  return {
    authorize: jest.fn(async () =>
      authorized
        ? { authorized: true as const, grant }
        : {
            authorized: false as const,
            reason: 'no-grant' as const,
            detail: 'No grant covers this scope. 0 grants were considered.',
          },
    ),
    create: jest.fn(async () => {
      if (createResult instanceof Error) throw createResult;
      return createResult;
    }),
  } as unknown as TrustGrantService & {
    authorize: jest.Mock;
    create: jest.Mock;
  };
}

/**
 * A stand-in for `EscalationsService` that also RECORDS what it raised.
 *
 * The recording is not incidental. #237's dedupe asks the escalation table
 * whether the question has already been asked, so a double whose raises leave
 * no trace would make "the escalation exists but the link failed" untestable —
 * and that is the case the whole design turns on.
 */
function escalationsDouble(store: EscalationRow[]) {
  let seq = 0;
  return {
    raiseSystem: jest.fn(
      async (input: { summary: string; detail: string; raisedAt?: Date }) => {
        seq += 1;
        const created: EscalationRow = {
          id: `escalation-${seq}`,
          kind: 'system',
          runId: null,
          summary: input.summary,
          detail: input.detail,
          raisedAt: input.raisedAt ?? NOW,
        };
        store.push(created);
        return { id: created.id };
      },
    ),
  } as unknown as EscalationsService & { raiseSystem: jest.Mock };
}

/**
 * A notifier double that can be made to fail.
 *
 * The failure mode is the interesting one: #98 requires that a send which
 * cannot happen never converts a raised approval into a failure, because an
 * approval that exists and was not delivered is recoverable while one that was
 * never written is not.
 */
function notifierDouble(failure?: Error) {
  return {
    send: jest.fn(async () => {
      if (failure) throw failure;
      return true;
    }),
  } as unknown as ApprovalNotifier & { send: jest.Mock };
}

function build(
  options: {
    rows?: ApprovalRequestRow[];
    refusals?: NeverTrustableRefusal[];
    authorized?: boolean;
    grant?: TrustGrantView;
    createResult?: TrustGrantView | Error;
    notifyFailure?: Error;
    escalations?: EscalationRow[];
  } = {},
) {
  const db = prismaDouble(options.rows ?? [], options.escalations ?? []);
  const neverTrustable = neverTrustableDouble(options.refusals ?? []);
  const grants = trustDouble(
    options.authorized ?? false,
    options.grant,
    options.createResult,
  );
  const escalations = escalationsDouble(db.escalationRows);
  const notifier = notifierDouble(options.notifyFailure);
  const service = new ApprovalGateService(
    db.prisma,
    neverTrustable,
    grants,
    escalations,
    notifier,
  );
  return { service, db, neverTrustable, grants, escalations, notifier };
}

// =============================================================================
// Fixtures
// =============================================================================

const SPEND: AutonomyEffect = { kind: 'spend', usd: 1.5 };

function raiseInput(
  overrides: Partial<RaiseApprovalInput> = {},
): RaiseApprovalInput {
  return {
    actionClass: 're-dispatch',
    repositoryId: REPO,
    effects: [SPEND],
    summary: 'Re-dispatch work order 312 at attempt 2',
    reasoning: 'The run failed with a 429 from the runner, judged transient.',
    blastRadius: 'One new branch and one runner invocation on the same quota.',
    estimatedCostUsd: 1.5,
    ...overrides,
  };
}

function row(overrides: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    id: 'approval-seed',
    actionClass: 're-dispatch',
    repositoryId: REPO,
    proposalId: null,
    targetKind: 'work-order',
    targetRef: 'owner/name#312',
    summary: 'Re-dispatch',
    reasoning: 'Transient failure',
    blastRadius: 'One runner invocation',
    effects: [SPEND],
    estimatedCostUsd: 1.5,
    timeoutPolicy: 'deny',
    timeoutAt: new Date(NOW.getTime() + TIMEOUT_WINDOW_MS),
    status: 'pending',
    decidedAt: null,
    decidedById: null,
    decidedVia: null,
    decisionNote: null,
    grantId: null,
    createdGrantId: null,
    escalationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const FORCE_PUSH_REFUSAL: NeverTrustableRefusal = {
  rule: 'force-push',
  effect: {
    kind: 'git-push',
    repository: 'owner/name',
    branch: 'main',
    force: true,
    protectedBranch: true,
  },
  reason: 'Refused: force-push to owner/name@main.',
};

// =============================================================================
// Tests
// =============================================================================

describe('ApprovalGateService', () => {
  describe('gate — never-trustable runs first (ADR-0013 rule 0)', () => {
    it('refuses and writes NO ApprovalRequest row', async () => {
      const { service, db } = build({ refusals: [FORCE_PUSH_REFUSAL] });

      const outcome = await service.gate(raiseInput(), NOW);

      expect(outcome).toEqual({
        outcome: 'refused',
        refusals: [FORCE_PUSH_REFUSAL],
      });
      // The design choice, asserted: a pending approval for something that can
      // never be approved would be an unanswerable question in the operator's
      // queue, and an `approved` row for it would sit in #99's numerator as
      // evidence humans endorse an action the system will never perform.
      expect(db.approvalRequest.create).not.toHaveBeenCalled();
      expect(db.rows).toHaveLength(0);
    });

    it('refuses even when a maximally permissive grant covers the class', async () => {
      // The grant is valid, active, unspent and covers exactly this scope. If
      // the guard ran second, this would authorize.
      const { service, db, grants } = build({
        refusals: [FORCE_PUSH_REFUSAL],
        authorized: true,
        grant: grantView({
          budgetCeilingUsd: 1_000_000,
          remainingBudgetUsd: 1_000_000,
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      });

      const outcome = await service.gate(raiseInput(), NOW);

      expect(outcome.outcome).toBe('refused');
      // VISION §8: "regardless of any grant". The only way to make that true
      // is to not consult grants at all, which is what this asserts.
      expect(grants.authorize).not.toHaveBeenCalled();
      expect(db.rows).toHaveLength(0);
    });
  });

  describe('gate — a standing grant', () => {
    it('still writes a row, with decidedVia grant (VISION §8s digest)', async () => {
      const { service, db } = build({ authorized: true });

      const outcome = await service.gate(raiseInput(), NOW);

      expect(outcome).toEqual({
        outcome: 'authorized',
        grantId: 'grant-1',
        approvalId: expect.any(String),
      });

      // "Auto-approved actions still record what *would* have been asked."
      // An action running under a grant with no row is invisible autonomy.
      expect(db.rows).toHaveLength(1);
      const written = db.rows[0]!;
      expect(written.status).toBe('approved');
      expect(written.decidedVia).toBe('grant');
      expect(written.decidedById).toBeNull();
      expect(written.grantId).toBe('grant-1');
      expect(written.decidedAt).toEqual(NOW);
      // What would have happened had nobody answered, recorded even though
      // nobody was asked — #100's digest reads it.
      expect(written.timeoutPolicy).toBe('deny');
      // No timer on a decided row.
      expect(written.timeoutAt).toBeNull();
    });

    it('prices an unknown estimate as unknown, never as zero, for a spending class', async () => {
      const { service, grants } = build({ authorized: false });

      await service.gate(raiseInput({ estimatedCostUsd: null }), NOW);

      // NaN, not 0. `TrustGrantService.authorize` already owns the rule that a
      // non-finite figure cannot be checked against a ceiling; passing 0 would
      // make the budget check pass for exactly the actions it cannot price.
      const projected = grants.authorize.mock.calls[0]?.[2] as number;
      expect(Number.isNaN(projected)).toBe(true);
    });

    it('prices an unknown estimate as zero for a class that spends nothing', async () => {
      const { service, grants } = build({ authorized: false });

      await service.gate(
        raiseInput({ actionClass: 'daily-brief', estimatedCostUsd: null }),
        NOW,
      );

      expect(grants.authorize.mock.calls[0]?.[2]).toBe(0);
    });
  });

  describe('gate — raising a pending request', () => {
    it('records the resolved policy and its deadline', async () => {
      const { service, db } = build({ authorized: false });

      const outcome = await service.gate(raiseInput(), NOW);

      expect(outcome).toEqual({
        outcome: 'pending',
        approvalId: expect.any(String),
        timeoutPolicy: 'deny',
        timeoutAt: new Date(NOW.getTime() + TIMEOUT_WINDOW_MS),
      });
      expect(db.rows[0]!.status).toBe('pending');
      // Frozen at raise time, per ADR-0013: a later change to `effectsFor`
      // must not retroactively change what this approval authorized.
      expect(db.rows[0]!.effects).toEqual([SPEND]);
    });

    it('parks an unrecognised class, with no timer, and escalates', async () => {
      const { service, db, escalations } = build({ authorized: false });

      const outcome = await service.gate(
        raiseInput({ actionClass: 'invented-class' as never }),
        NOW,
      );

      expect(outcome).toMatchObject({
        outcome: 'pending',
        timeoutPolicy: 'park_and_escalate',
        timeoutAt: null,
      });

      const written = db.rows[0]!;
      expect(written.status).toBe('parked');
      // The null is the guarantee, not a missing value.
      expect(written.timeoutAt).toBeNull();
      expect(escalations.raiseSystem).toHaveBeenCalledTimes(1);
      expect(written.escalationId).toBe('escalation-1');

      // The marker #237's dedupe searches for. Written here and read by
      // `findEscalationFor`; if the two ever disagree the backfill stops
      // recognising its own work and starts raising duplicates.
      const detail = (escalations.raiseSystem as jest.Mock).mock.calls[0][0]
        .detail as string;
      expect(detail).toContain(parkedApprovalMarker(written.id));
    });

    it('keeps the request parked even when the escalation cannot be raised', async () => {
      const { service, db, escalations } = build({ authorized: false });
      (escalations.raiseSystem as jest.Mock).mockRejectedValueOnce(
        new Error('push service down'),
      );

      const outcome = await service.gate(
        raiseInput({ actionClass: 'invented-class' as never }),
        NOW,
      );

      // The block is the safety-relevant fact and it holds. The missing
      // escalation is a real cost, and it is visible: the row is queryable
      // with a null escalationId and the failure is logged at error level.
      expect(outcome.outcome).toBe('pending');
      expect(db.rows[0]!.status).toBe('parked');
      expect(db.rows[0]!.escalationId).toBeNull();
    });
  });

  describe('sweepTimeouts', () => {
    it('never selects a park_and_escalate row', async () => {
      const parked = row({
        id: 'parked-1',
        actionClass: 'invented-class',
        timeoutPolicy: 'park_and_escalate',
        timeoutAt: null,
        status: 'parked',
      });
      const { service, db } = build({ rows: [parked] });

      // Sweeping a year later. There is no timestamp for the query to match,
      // so the passage of time cannot reach this row at all.
      const result = await service.sweepTimeouts(
        new Date('2027-08-24T12:00:00.000Z'),
      );

      expect(result.examined).toBe(0);
      expect(result.autoApproved).toBe(0);
      expect(result.autoDenied).toBe(0);
      const survivor = db.rows.find((r) => r.id === 'parked-1')!;
      expect(survivor.status).toBe('parked');
      expect(survivor.decidedVia).toBeNull();
    });

    it('resolves an auto_approve row by the clock, recorded as timeout', async () => {
      const due = row({
        id: 'due-1',
        actionClass: 'daily-brief',
        timeoutPolicy: 'auto_approve',
        timeoutAt: new Date(NOW.getTime() - 1),
      });
      const { service, db } = build({ rows: [due] });

      const result = await service.sweepTimeouts(NOW);

      expect(result).toMatchObject({
        examined: 1,
        autoApproved: 1,
        autoDenied: 0,
      });
      const resolved = db.rows[0]!;
      expect(resolved.status).toBe('auto_approved');
      expect(resolved.decidedVia).toBe('timeout');
      // No actor. Naming one for a resolution nobody personally made would be
      // inventing one.
      expect(resolved.decidedById).toBeNull();
    });

    it('resolves a deny row to auto_denied', async () => {
      const due = row({ id: 'due-2', timeoutAt: new Date(NOW.getTime() - 1) });
      const { service, db } = build({ rows: [due] });

      const result = await service.sweepTimeouts(NOW);

      expect(result).toMatchObject({ autoApproved: 0, autoDenied: 1 });
      expect(db.rows[0]!.status).toBe('auto_denied');
    });

    it('leaves a request alone until its deadline has actually passed', async () => {
      const { service, db } = build({ rows: [row({ id: 'future' })] });

      const result = await service.sweepTimeouts(NOW);

      expect(result.examined).toBe(0);
      expect(db.rows[0]!.status).toBe('pending');
    });

    /**
     * The recorded policy is what the operator was TOLD would happen. This row
     * is recorded `auto_approve` for a class the registry now resolves to
     * `deny` — recomputing would silently do something other than what the
     * notification promised.
     */
    it('uses the RECORDED policy, not what the registry says today', async () => {
      const stale = row({
        id: 'stale-1',
        // `re-dispatch` resolves to `deny` today (spendsMoney: true).
        actionClass: 're-dispatch',
        timeoutPolicy: 'auto_approve',
        timeoutAt: new Date(NOW.getTime() - 1),
      });
      const { service, db } = build({ rows: [stale] });

      const result = await service.sweepTimeouts(NOW);

      expect(result.autoApproved).toBe(1);
      expect(result.autoDenied).toBe(0);
      expect(db.rows[0]!.status).toBe('auto_approved');
      expect(db.rows[0]!.decisionNote).toContain('auto_approve');
    });

    it('skips and reports a park_and_escalate row that somehow carries a deadline', async () => {
      // Structurally impossible through `gate`; constructed directly to prove
      // the defensive branch does not fall through to a resolution.
      const impossible = row({
        id: 'impossible-1',
        timeoutPolicy: 'park_and_escalate',
        timeoutAt: new Date(NOW.getTime() - 1),
        status: 'pending',
      });
      const { service, db } = build({ rows: [impossible] });

      const result = await service.sweepTimeouts(NOW);

      expect(result).toMatchObject({
        examined: 1,
        skippedParked: 1,
        autoApproved: 0,
        autoDenied: 0,
      });
      expect(db.rows[0]!.status).toBe('pending');
    });

    it('loses cleanly to a human who decided in the same instant', async () => {
      const due = row({
        id: 'raced-1',
        timeoutAt: new Date(NOW.getTime() - 1),
      });
      const { service, db } = build({ rows: [due] });

      // The query has already returned the row; a human writes before the
      // conditional update lands.
      (db.approvalRequest.updateMany as jest.Mock).mockImplementationOnce(
        async () => ({ count: 0 }),
      );

      const result = await service.sweepTimeouts(NOW);

      expect(result).toMatchObject({ examined: 1, raced: 1, autoDenied: 0 });
    });
  });

  // ==========================================================================
  // The backfill (#237)
  // ==========================================================================

  describe('backfillParkedEscalations (#237)', () => {
    const FIVE_MINUTES = 5 * 60 * 1000;
    const LATER = new Date(NOW.getTime() + FIVE_MINUTES);

    /** A request that parked and never got its escalation. */
    function unescalated(
      overrides: Partial<ApprovalRequestRow> = {},
    ): ApprovalRequestRow {
      return row({
        id: 'parked-1',
        actionClass: 'invented-class',
        timeoutPolicy: 'park_and_escalate',
        timeoutAt: null,
        status: 'parked',
        escalationId: null,
        createdAt: NOW,
        ...overrides,
      });
    }

    /** An escalation already raised for `approvalId`, carrying the marker. */
    function escalationFor(
      approvalId: string,
      id = 'escalation-existing',
    ): EscalationRow {
      return {
        id,
        kind: 'system',
        runId: null,
        summary: 'Approval parked, waiting on a human: Re-dispatch',
        detail: `Whatever else it says.\n${parkedApprovalMarker(approvalId)}`,
        raisedAt: NOW,
      };
    }

    it('escalates a parked approval whose raise failed, on a later pass', async () => {
      const { service, db, escalations } = build({ authorized: false });
      (escalations.raiseSystem as jest.Mock).mockRejectedValueOnce(
        new Error('escalations are down'),
      );

      await service.gate(
        raiseInput({ actionClass: 'invented-class' as never }),
        NOW,
      );

      // The state #237 describes: blocked, recorded, and nothing pointing at
      // an escalation.
      expect(db.rows[0]!.status).toBe('parked');
      expect(db.rows[0]!.escalationId).toBeNull();

      const result = await service.backfillParkedEscalations(LATER);

      expect(result).toMatchObject({
        examined: 1,
        raised: 1,
        linked: 0,
        raced: 0,
        failed: 0,
        abandoned: 0,
      });
      expect(db.rows[0]!.escalationId).toBe('escalation-1');
      expect(db.rows[0]!.status).toBe('parked');
    });

    /**
     * THE test. `escalateParked` can fail in two ways that leave IDENTICAL
     * rows: the raise throws (no escalation exists) or the link write throws
     * (an escalation exists, is dispatched, and may already be on somebody's
     * phone). A backfill defined as "parked with a null escalationId, raise
     * one" pages the operator twice for the second case — the exact noise
     * VISION §8 and #57 exist to remove, delivered by the mechanism that was
     * supposed to fix a missed notification.
     */
    it('does NOT raise a second escalation when only the link write failed', async () => {
      const { service, db, escalations } = build({ authorized: false });
      // The raise lands; the pointer write does not.
      (db.approvalRequest.updateMany as jest.Mock).mockRejectedValueOnce(
        new Error('write conflict'),
      );

      await service.gate(
        raiseInput({ actionClass: 'invented-class' as never }),
        NOW,
      );

      expect(escalations.raiseSystem).toHaveBeenCalledTimes(1);
      expect(db.escalationRows).toHaveLength(1);
      // Indistinguishable from the failed-raise case, from the row alone.
      expect(db.rows[0]!.escalationId).toBeNull();

      const result = await service.backfillParkedEscalations(LATER);

      // Nobody was paged a second time.
      expect(escalations.raiseSystem).toHaveBeenCalledTimes(1);
      expect(db.escalationRows).toHaveLength(1);
      // And the pointer is repaired to the escalation that already existed.
      expect(result).toMatchObject({ examined: 1, raised: 0, linked: 1 });
      expect(db.rows[0]!.escalationId).toBe('escalation-1');
    });

    it('links a pre-existing escalation rather than raising a new one', async () => {
      const { service, db, escalations } = build({
        rows: [unescalated()],
        escalations: [escalationFor('parked-1')],
      });

      const result = await service.backfillParkedEscalations(LATER);

      expect(escalations.raiseSystem).not.toHaveBeenCalled();
      expect(result).toMatchObject({ examined: 1, raised: 0, linked: 1 });
      expect(db.rows[0]!.escalationId).toBe('escalation-existing');
    });

    /**
     * The dedupe must key on THIS approval, not on "some parked approval was
     * escalated once". A marker match that were merely fuzzy would silently
     * convert every real recovery into a no-op, which fails in the direction
     * that leaves nobody told.
     */
    it('ignores an escalation raised for a different approval', async () => {
      const { service, db, escalations } = build({
        rows: [unescalated()],
        escalations: [escalationFor('some-other-approval')],
      });

      const result = await service.backfillParkedEscalations(LATER);

      expect(escalations.raiseSystem).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ raised: 1, linked: 0 });
      expect(db.rows[0]!.escalationId).toBe('escalation-1');
    });

    /**
     * The question was answered. Raising it now is pure noise, and the filter
     * that prevents it is the status itself: a parked request a human decides
     * becomes `approved` or `denied`, and a retired one becomes `superseded`.
     */
    it.each<ApprovalStatus>(['approved', 'denied', 'superseded'])(
      'never backfills a request already decided as %s',
      async (status) => {
        const { service, db, escalations } = build({
          rows: [
            unescalated({
              id: `decided-${status}`,
              status,
              decidedAt: NOW,
              decidedById: status === 'superseded' ? null : USER,
              decidedVia: status === 'superseded' ? null : 'human',
            }),
          ],
        });

        const result = await service.backfillParkedEscalations(LATER);

        expect(result).toMatchObject({ examined: 0, raised: 0, abandoned: 0 });
        expect(escalations.raiseSystem).not.toHaveBeenCalled();
        expect(db.rows[0]!.escalationId).toBeNull();
      },
    );

    it('leaves a parked approval that already has an escalation alone', async () => {
      const { service, db, escalations } = build({
        rows: [unescalated({ escalationId: 'escalation-7' })],
      });

      const result = await service.backfillParkedEscalations(LATER);

      expect(result).toMatchObject({ examined: 0, raised: 0, linked: 0 });
      expect(escalations.raiseSystem).not.toHaveBeenCalled();
      expect(db.rows[0]!.escalationId).toBe('escalation-7');
    });

    /**
     * The bound. Past the window nothing more is attempted — the same end
     * state #136's attempt cap produces — and the count is what makes that
     * honest rather than quiet.
     */
    it('reports a request older than the window as abandoned, and does not retry it', async () => {
      const wayLater = new Date(
        NOW.getTime() + PARKED_BACKFILL_WINDOW_MS + FIVE_MINUTES,
      );
      const { service, db, escalations } = build({ rows: [unescalated()] });

      const result = await service.backfillParkedEscalations(wayLater);

      expect(result).toMatchObject({ examined: 0, raised: 0, abandoned: 1 });
      expect(escalations.raiseSystem).not.toHaveBeenCalled();
      // Still blocked, still waiting on a person. Nothing auto-resolves it.
      expect(db.rows[0]!.status).toBe('parked');
      expect(db.rows[0]!.escalationId).toBeNull();
      expect(db.rows[0]!.decidedVia).toBeNull();
    });

    it('still retries at the last moment inside the window', async () => {
      const justInside = new Date(
        NOW.getTime() + PARKED_BACKFILL_WINDOW_MS - 1,
      );
      const { service } = build({ rows: [unescalated()] });

      const result = await service.backfillParkedEscalations(justInside);

      expect(result).toMatchObject({ examined: 1, raised: 1, abandoned: 0 });
    });

    it('counts a retry that failed again, and leaves the row for the next tick', async () => {
      const { service, db, escalations } = build({ rows: [unescalated()] });
      (escalations.raiseSystem as jest.Mock).mockRejectedValue(
        new Error('escalations are still down'),
      );

      const result = await service.backfillParkedEscalations(LATER);

      expect(result).toMatchObject({ examined: 1, raised: 0, failed: 1 });
      expect(db.rows[0]!.escalationId).toBeNull();
      expect(db.rows[0]!.status).toBe('parked');
    });

    /**
     * A human answering between the select and the link write. The escalation
     * is already raised at that point and stands; it is counted as `raced`
     * rather than as a repair, because nothing was repaired.
     */
    it('does not overwrite a request that stopped being parked mid-pass', async () => {
      const { service, db, escalations } = build({ rows: [unescalated()] });
      (escalations.raiseSystem as jest.Mock).mockImplementationOnce(
        async () => {
          // The human taps approve while the escalation is being raised.
          db.rows[0]!.status = 'approved';
          return { id: 'escalation-late' };
        },
      );

      const result = await service.backfillParkedEscalations(LATER);

      expect(result).toMatchObject({ examined: 1, raised: 0, raced: 1 });
      expect(db.rows[0]!.status).toBe('approved');
      expect(db.rows[0]!.escalationId).toBeNull();
    });

    it('is a no-op when nothing is parked', async () => {
      const { service, escalations } = build({ rows: [row({ id: 'a1' })] });

      const result = await service.backfillParkedEscalations(LATER);

      expect(result).toMatchObject({
        examined: 0,
        raised: 0,
        linked: 0,
        raced: 0,
        failed: 0,
        abandoned: 0,
      });
      expect(escalations.raiseSystem).not.toHaveBeenCalled();
    });

    it('says the escalation is late rather than letting it read as fresh', async () => {
      const { service, escalations } = build({ rows: [unescalated()] });

      await service.backfillParkedEscalations(
        new Date(NOW.getTime() + 90 * 60 * 1000),
      );

      const detail = (escalations.raiseSystem as jest.Mock).mock.calls[0][0]
        .detail as string;
      expect(detail).toContain('Raised late');
      expect(detail).toContain('90 minute(s) ago');
      // The consequence-for-silence is unchanged: still no timer, ever.
      expect(detail).toContain('never auto-approved');
    });
  });

  describe('decide', () => {
    it('records a human approval', async () => {
      const { service, db } = build({ rows: [row({ id: 'a1' })] });

      const result = await service.decide(
        'a1',
        { decision: 'approve', actorUserId: USER, note: 'Looks right.' },
        NOW,
      );

      expect(result.approval.status).toBe('approved');
      expect(result.approval.decidedVia).toBe('human');
      expect(result.approval.decidedById).toBe(USER);
      expect(result.createdGrantId).toBeNull();
      expect(result.grantSkippedReason).toBeNull();
      expect(result.decidedAfterTimeout).toBe(false);
      expect(db.rows[0]!.decisionNote).toBe('Looks right.');
    });

    it('records a human denial', async () => {
      const { service } = build({ rows: [row({ id: 'a1' })] });

      const result = await service.decide(
        'a1',
        { decision: 'deny', actorUserId: USER },
        NOW,
      );

      expect(result.approval.status).toBe('denied');
      expect(result.approval.decidedVia).toBe('human');
    });

    it('lets a human decide a parked request — only a person moves it', async () => {
      const parked = row({
        id: 'p1',
        actionClass: 'invented-class',
        timeoutPolicy: 'park_and_escalate',
        timeoutAt: null,
        status: 'parked',
      });
      const { service } = build({ rows: [parked] });

      const result = await service.decide(
        'p1',
        { decision: 'deny', actorUserId: USER },
        NOW,
      );

      expect(result.approval.status).toBe('denied');
    });

    it('accepts a late verdict and says the window had lapsed', async () => {
      const { service } = build({ rows: [row({ id: 'late-1' })] });
      const afterDeadline = new Date(
        NOW.getTime() + TIMEOUT_WINDOW_MS + 60_000,
      );

      const result = await service.decide(
        'late-1',
        { decision: 'approve', actorUserId: USER },
        afterDeadline,
      );

      // The recorded state is the authority: nothing had resolved it, so the
      // human's verdict counts as human evidence. The flag is how the caller
      // tells them the window had lapsed rather than leaving them to wonder.
      expect(result.approval.status).toBe('approved');
      expect(result.approval.decidedVia).toBe('human');
      expect(result.decidedAfterTimeout).toBe(true);
    });

    it('404s on a request that does not exist', async () => {
      const { service } = build();
      await expect(
        service.decide('nope', { decision: 'approve', actorUserId: USER }, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('a request that is no longer pending', () => {
      async function refuse(overrides: Partial<ApprovalRequestRow>) {
        const { service } = build({ rows: [row({ id: 'x1', ...overrides })] });
        try {
          await service.decide(
            'x1',
            { decision: 'approve', actorUserId: 'user-2' },
            NOW,
          );
        } catch (error) {
          return error as ApprovalNotPendingException;
        }
        throw new Error('expected a refusal');
      }

      /**
       * #98's acceptance criterion. A generic 409 cannot say which of these
       * happened, and they call for completely different things from the
       * operator: a stale view versus an action denied by silence.
       */
      it('distinguishes a timeout resolution from a human one', async () => {
        const timedOut = await refuse({
          status: 'auto_denied',
          decidedVia: 'timeout',
          decidedAt: NOW,
        });
        const byHuman = await refuse({
          status: 'approved',
          decidedVia: 'human',
          decidedAt: NOW,
          decidedById: 'user-9',
        });

        expect(timedOut.reason).toBe('already-timed-out');
        expect(byHuman.reason).toBe('already-decided-by-human');
        expect(timedOut.reason).not.toBe(byHuman.reason);

        // And the sentence a human reads differs too, not only the id.
        expect(timedOut.message).toContain('timed out');
        expect(byHuman.message).toContain('user-9');

        // The discriminator travels in `details`, because the exception filter
        // overwrites the envelope's `code` from the status code.
        const details = (timedOut.getResponse() as any).details;
        expect(details.reason).toBe('already-timed-out');
        expect(details.status).toBe('auto_denied');
      });

      it('names a grant authorization as its own case', async () => {
        const byGrant = await refuse({
          status: 'approved',
          decidedVia: 'grant',
          decidedAt: NOW,
          grantId: 'grant-1',
        });
        expect(byGrant.reason).toBe('already-authorized-by-grant');
      });

      it('names supersession as its own case', async () => {
        const superseded = await refuse({
          status: 'superseded',
          decidedAt: NOW,
          decisionNote: 'The run finished.',
        });
        expect(superseded.reason).toBe('superseded');
        expect(superseded.message).toContain('Nobody refused it');
      });

      it('refuses when another writer wins the race after the read', async () => {
        const { service, db } = build({ rows: [row({ id: 'r1' })] });
        (db.approvalRequest.updateMany as jest.Mock).mockImplementationOnce(
          async () => {
            // Somebody else resolves it between our read and our write.
            db.rows[0]!.status = 'auto_denied';
            db.rows[0]!.decidedVia = 'timeout';
            db.rows[0]!.decidedAt = NOW;
            return { count: 0 };
          },
        );

        await expect(
          service.decide('r1', { decision: 'approve', actorUserId: USER }, NOW),
        ).rejects.toMatchObject({ reason: 'already-timed-out' });
      });
    });

    describe('"Always approve this class" (VISION §8s third option)', () => {
      it('mints a grant carrying all four attributes and nothing broader', async () => {
        const { service, db, grants } = build({ rows: [row({ id: 'g1' })] });

        const result = await service.decide(
          'g1',
          {
            decision: 'approve',
            actorUserId: USER,
            alwaysApproveThisClass: true,
          },
          NOW,
        );

        expect(grants.create).toHaveBeenCalledTimes(1);
        const [created] = grants.create.mock.calls[0] as [any, Date];

        // Scope: this class, this repository. There is no "all repositories"
        // and no "all classes" value to pass, and none is invented here.
        expect(created.actionClass).toBe('re-dispatch');
        expect(created.repositoryId).toBe(REPO);
        expect(created.grantedById).toBe(USER);

        // Expiry, budget ceiling, auto-revoke — all four from `defaults.ts`,
        // never assembled at the call site.
        expect(created.expiresAt).toEqual(
          new Date(NOW.getTime() + DEFAULT_GRANT_EXPIRY_DAYS * 86_400_000),
        );
        expect(created.budgetCeilingUsd).toBe(DEFAULT_GRANT_BUDGET_CEILING_USD);
        expect(created.maxFailureRate).toBe(DEFAULT_GRANT_MAX_FAILURE_RATE);
        expect(created.maxCostPerActionUsd).toBe(
          DEFAULT_GRANT_MAX_COST_PER_ACTION_USD,
        );
        expect(created.minActionsBeforeAutoRevoke).toBe(
          DEFAULT_GRANT_MIN_ACTIONS_BEFORE_AUTO_REVOKE,
        );

        expect(result.createdGrantId).toBe('grant-new');
        expect(result.grantSkippedReason).toBeNull();
        // A separate column from `grantId`: one grant may authorize a request
        // and a different grant be born from the decision on it.
        expect(db.rows[0]!.createdGrantId).toBe('grant-new');
        expect(db.rows[0]!.grantId).toBeNull();
      });

      it('approves without minting on an ineligible class, and says so', async () => {
        const { service, db, grants } = build({
          rows: [row({ id: 'q1', actionClass: 'quarantine-decision' })],
        });

        const result = await service.decide(
          'q1',
          {
            decision: 'approve',
            actorUserId: USER,
            alwaysApproveThisClass: true,
          },
          NOW,
        );

        // The single action still gets its verdict...
        expect(result.approval.status).toBe('approved');
        // ...and the flag is reported, not silently dropped. An operator who
        // believes they hold a grant they do not stops watching a class nobody
        // promoted.
        expect(grants.create).not.toHaveBeenCalled();
        expect(result.createdGrantId).toBeNull();
        expect(result.grantSkippedReason).toContain('not autonomy-eligible');
        expect(db.rows[0]!.createdGrantId).toBeNull();
      });

      it('reports, rather than swallows, a failure to mint', async () => {
        const { service } = build({
          rows: [row({ id: 'f1' })],
          createResult: new Error('repository not registered'),
        });

        const result = await service.decide(
          'f1',
          {
            decision: 'approve',
            actorUserId: USER,
            alwaysApproveThisClass: true,
          },
          NOW,
        );

        // The verdict — the part that was hard to obtain — is kept.
        expect(result.approval.status).toBe('approved');
        expect(result.createdGrantId).toBeNull();
        expect(result.grantSkippedReason).toContain(
          'repository not registered',
        );
      });

      it('mints nothing on a denial, and says why', async () => {
        const { service, grants } = build({ rows: [row({ id: 'd1' })] });

        const result = await service.decide(
          'd1',
          {
            decision: 'deny',
            actorUserId: USER,
            alwaysApproveThisClass: true,
          },
          NOW,
        );

        expect(grants.create).not.toHaveBeenCalled();
        expect(result.grantSkippedReason).toContain('only to an approval');
      });
    });
  });

  describe('supersede', () => {
    it('resolves an open request with no decidedVia — nobody decided it', async () => {
      const { service, db } = build({ rows: [row({ id: 's1' })] });

      const view = await service.supersede('s1', 'The run finished.', NOW);

      expect(view.status).toBe('superseded');
      // Not `denied`: recording a refusal nobody made would put it in #99's
      // denominator.
      expect(db.rows[0]!.decidedVia).toBeNull();
      expect(db.rows[0]!.decisionNote).toBe('The run finished.');
    });

    it('is a no-op on an already-decided request', async () => {
      const decided = row({
        id: 's2',
        status: 'approved',
        decidedVia: 'human',
        decidedAt: NOW,
        decidedById: USER,
      });
      const { service, db } = build({ rows: [decided] });

      const view = await service.supersede('s2', 'too late', NOW);

      expect(view.status).toBe('approved');
      expect(db.rows[0]!.decisionNote).toBeNull();
    });

    it('404s on a request that does not exist', async () => {
      const { service } = build();
      await expect(
        service.supersede('nope', 'why', NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listPending', () => {
    it('includes parked requests — they are the ones that wait forever', async () => {
      const { service } = build({
        rows: [
          row({ id: 'p-pending', status: 'pending' }),
          row({
            id: 'p-parked',
            status: 'parked',
            timeoutAt: null,
            timeoutPolicy: 'park_and_escalate',
          }),
          row({ id: 'p-done', status: 'auto_denied', decidedVia: 'timeout' }),
        ],
      });

      const pending = await service.listPending();

      expect(pending.map((p) => p.id).sort()).toEqual([
        'p-parked',
        'p-pending',
      ]);
    });

    it('filters by repository and action class', async () => {
      const { service } = build({
        rows: [
          row({
            id: 'one',
            repositoryId: 'repo-a',
            actionClass: 're-dispatch',
          }),
          row({
            id: 'two',
            repositoryId: 'repo-b',
            actionClass: 're-dispatch',
          }),
          row({
            id: 'three',
            repositoryId: 'repo-a',
            actionClass: 'daily-brief',
          }),
        ],
      });

      const filtered = await service.listPending({
        repositoryId: 'repo-a',
        actionClass: 're-dispatch',
      });

      expect(filtered.map((p) => p.id)).toEqual(['one']);
    });

    it('narrows to one open status without widening to a decided row', async () => {
      const { service } = build({
        rows: [
          row({ id: 'q-pending', status: 'pending' }),
          row({
            id: 'q-parked',
            status: 'parked',
            timeoutAt: null,
            timeoutPolicy: 'park_and_escalate',
          }),
          row({ id: 'q-approved', status: 'approved', decidedVia: 'human' }),
        ],
      });

      expect(
        (await service.listPending({ status: 'parked' })).map((p) => p.id),
      ).toEqual(['q-parked']);
      // The narrowing REPLACES the open-status set rather than being ANDed
      // onto it, so this asserts the replacement cannot reach a decided row.
      // It cannot: the parameter's type holds only the two open statuses.
      expect(
        (await service.listPending({ status: 'pending' })).map((p) => p.id),
      ).toEqual(['q-pending']);
    });
  });

  describe('get', () => {
    it('returns a view with dates as ISO strings', async () => {
      const { service } = build({ rows: [row({ id: 'v1' })] });

      const view = await service.get('v1');

      expect(view.createdAt).toBe(NOW.toISOString());
      expect(view.timeoutAt).toBe(
        new Date(NOW.getTime() + TIMEOUT_WINDOW_MS).toISOString(),
      );
      expect(view.estimatedCostUsd).toBe(1.5);
    });

    it('404s on a request that does not exist', async () => {
      const { service } = build();
      await expect(service.get('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('approvalRatesByClass (#99)', () => {
    /**
     * The single most important property of this read model: a timeout is
     * silence, not agreement. A class that is never actually asked about and
     * always times out reversible must not read as unanimously approved.
     */
    it('excludes auto_approved and grant-authorized rows from BOTH numerator and denominator', async () => {
      const statuses: Array<Partial<ApprovalRequestRow>> = [
        // Two genuine human verdicts: one yes, one no. 1/2 = 0.5.
        { id: 'h1', status: 'approved', decidedVia: 'human' },
        { id: 'h2', status: 'denied', decidedVia: 'human' },
        // Everything below must move neither number.
        { id: 't1', status: 'auto_approved', decidedVia: 'timeout' },
        { id: 't2', status: 'auto_approved', decidedVia: 'timeout' },
        { id: 't3', status: 'auto_approved', decidedVia: 'timeout' },
        { id: 't4', status: 'auto_denied', decidedVia: 'timeout' },
        {
          id: 'g1',
          status: 'approved',
          decidedVia: 'grant',
          grantId: 'grant-1',
        },
        {
          id: 'g2',
          status: 'approved',
          decidedVia: 'grant',
          grantId: 'grant-1',
        },
        { id: 'x1', status: 'pending' as ApprovalStatus },
        { id: 'x2', status: 'superseded' },
      ];
      const { service } = build({
        rows: statuses.map((s) => row({ actionClass: 're-dispatch', ...s })),
      });

      const [rates] = await service.approvalRatesByClass(30, NOW);

      expect(rates).toMatchObject({
        actionClass: 're-dispatch',
        approved: 1,
        denied: 1,
        humanDecisions: 2,
        approvalRate: 0.5,
        autoApproved: 3,
        autoDenied: 1,
        grantAuthorized: 2,
        pending: 1,
        superseded: 1,
      });

      // Stated the other way round, because this is the failure mode: without
      // the `decidedVia` filter the numerator would be 1+3+2 = 6 over a
      // denominator of 7, i.e. 0.857.
      expect(rates!.approvalRate).not.toBeCloseTo(6 / 7);
    });

    it('reports a null rate when no human has decided one — 0/0 is no evidence', async () => {
      const { service } = build({
        rows: [
          row({ id: 'a', status: 'auto_approved', decidedVia: 'timeout' }),
          row({ id: 'b', status: 'auto_approved', decidedVia: 'timeout' }),
        ],
      });

      const [rates] = await service.approvalRatesByClass(30, NOW);

      // Null, not 0. A 0% approval rate reads as "humans always reject this",
      // which is the opposite of what the data supports.
      expect(rates!.approvalRate).toBeNull();
      expect(rates!.humanDecisions).toBe(0);
      expect(rates!.autoApproved).toBe(2);
    });

    it('counts parked rows separately from pending ones', async () => {
      const { service } = build({
        rows: [
          row({ id: 'p', status: 'pending' }),
          row({
            id: 'k',
            status: 'parked',
            timeoutAt: null,
            timeoutPolicy: 'park_and_escalate',
          }),
        ],
      });

      const [rates] = await service.approvalRatesByClass(30, NOW);

      expect(rates).toMatchObject({ pending: 1, parked: 1 });
    });

    it('partitions by action class and ignores rows outside the window', async () => {
      const { service } = build({
        rows: [
          row({
            id: 'r1',
            actionClass: 're-dispatch',
            status: 'approved',
            decidedVia: 'human',
          }),
          row({
            id: 'd1',
            actionClass: 'daily-brief',
            status: 'denied',
            decidedVia: 'human',
          }),
          row({
            id: 'old',
            actionClass: 're-dispatch',
            status: 'approved',
            decidedVia: 'human',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        ],
      });

      const rates = await service.approvalRatesByClass(30, NOW);

      expect(rates.map((r) => r.actionClass)).toEqual([
        'daily-brief',
        're-dispatch',
      ]);
      expect(rates.find((r) => r.actionClass === 're-dispatch')!.approved).toBe(
        1,
      );
    });
  });

  describe('gate — telling a human (#98)', () => {
    it('notifies when a request is raised for a person', async () => {
      const { service, notifier } = build();

      const outcome = await service.gate(raiseInput(), NOW);

      expect(outcome.outcome).toBe('pending');
      expect(notifier.send).toHaveBeenCalledTimes(1);
      expect(notifier.send.mock.calls[0][0]).toMatchObject({
        actionClass: 're-dispatch',
        status: 'pending',
        // The RECORDED policy travels with the notification, because the
        // sentence built from it is the promise the sweeper must later keep.
        timeoutPolicy: 'deny',
        // Resolved from the ADR-0011 registry HERE rather than in the payload
        // builder: `src/notifications/` is on VISION §7's hot path and #94's
        // governing test forbids it importing `src/supervisor/`. Pinned so
        // the title cannot quietly degrade to the raw class id, which is what
        // an operator would see on a lock screen.
        actionClassTitle: 'Re-dispatch after transient failure',
      });
    });

    it('passes the escalation id along for a parked request', async () => {
      // A parked approval already has an escalation, so the payload can carry
      // its id and a device can group the two rather than showing two
      // unrelated alerts.
      const { service, notifier } = build();

      await service.gate(
        raiseInput({ actionClass: 'invented-class' as never }),
        NOW,
      );

      expect(notifier.send.mock.calls[0][0]).toMatchObject({
        status: 'parked',
        timeoutPolicy: 'park_and_escalate',
        timeoutAt: null,
        escalationId: 'escalation-1',
        // Null, not a placeholder sentence: the registry does not know this
        // class, and the payload falls back to the raw id, which is what
        // ADR-0014 says a parked approval most likely means today.
        actionClassTitle: null,
      });
    });

    it('does not notify when a standing grant authorized it', async () => {
      // Nobody was asked, so there is nothing to ask. The row still exists as
      // the record of what WOULD have been asked (VISION §8), and #100's
      // digest is what surfaces it — as a rollup, not as an interruption.
      const { service, notifier } = build({
        authorized: true,
        grant: grantView(),
      });

      await service.gate(raiseInput(), NOW);

      expect(notifier.send).not.toHaveBeenCalled();
    });

    it('does not notify for a refused action — no row exists to notify about', async () => {
      const { service, notifier } = build({ refusals: [FORCE_PUSH_REFUSAL] });

      await service.gate(raiseInput(), NOW);

      expect(notifier.send).not.toHaveBeenCalled();
    });

    it('NEVER turns a raised approval into a failure when the send throws', async () => {
      // The whole point. An approval that exists and was not delivered is
      // recoverable — the row is queryable and its timeout policy still
      // resolves it. One that was never written is not, and a caller whose
      // gate() threw would most likely retry, producing a second question
      // about the same action.
      const { service, db, notifier } = build({
        notifyFailure: new Error('push service unreachable'),
      });

      const outcome = await service.gate(raiseInput(), NOW);

      expect(notifier.send).toHaveBeenCalledTimes(1);
      expect(outcome.outcome).toBe('pending');
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0]!.status).toBe('pending');
    });
  });
});
