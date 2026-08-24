import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { toNumberOrNull } from '../../common/decimal';
import { PrismaService } from '../../prisma/prisma.service';
import { renderSnapshot } from './render-snapshot';
import {
  DEFAULT_SNAPSHOT_LIMITS,
  type RenderedSnapshot,
  type SnapshotInput,
  type SnapshotLimits,
  type SnapshotRun,
  type SnapshotWorkOrder,
} from './snapshot.types';

/** How far back the windowed counts and the recent-run list reach. */
export const SNAPSHOT_WINDOW_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read the factory's state out of Postgres and render it for the supervisor
 * (#88).
 *
 * The split between this class and `renderSnapshot` is the whole design.
 * Postgres holds the state (VISION §7), this service narrows it to plain
 * values, and the renderer is a pure function of those values. Nothing about
 * the supervisor's view of the world survives between invocations — there is
 * no cache here, and adding one would reintroduce exactly the context drift
 * VISION §7 describes: "an agent confidently reasoning about a run that ended
 * two days ago".
 *
 * Every query is ORDERED and LIMITED at the database. Ordering in the query
 * rather than in the renderer is what makes truncation meaningful: the rows
 * that survive the cap are the ones that matter most, not an arbitrary subset.
 * The limit is `cap + 1` so the renderer can say how many were dropped without
 * a second count query — a snapshot that reports "12 more not shown" when it
 * fetched exactly 15 rows would be lying about a number it never measured.
 */
@Injectable()
export class SnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gather and render.
   *
   * `now` is a parameter with a default rather than a call to `new Date()`
   * inside, so a test can pin it and a caller that already has an invocation
   * timestamp can pass the same one it records.
   */
  async render(
    now: Date = new Date(),
    limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
  ): Promise<{ input: SnapshotInput; rendered: RenderedSnapshot }> {
    const input = await this.collect(now, limits);
    return { input, rendered: renderSnapshot(input, limits) };
  }

  /** The state half: everything the renderer is a pure function of. */
  async collect(
    now: Date = new Date(),
    limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
  ): Promise<SnapshotInput> {
    const since = new Date(now.getTime() - SNAPSHOT_WINDOW_DAYS * DAY_MS);

    const [
      runsByStatus,
      runsSucceededInWindow,
      runsFailedInWindow,
      workOrdersByStatus,
      escalationsOutstanding,
      attentionRuns,
      recentRuns,
      queuedWorkOrders,
      quarantinedWorkOrders,
      escalations,
      specRejections,
    ] = await Promise.all([
      this.prisma.run.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.run.count({
        where: { status: 'succeeded', endedAt: { gte: since } },
      }),
      this.prisma.run.count({
        where: { status: 'failed', endedAt: { gte: since } },
      }),
      this.prisma.workOrder.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.escalation.count({ where: { status: 'raised' } }),
      // Ordered by how long they have been silent, nulls first: a run that has
      // never produced an event is the most suspicious thing in the factory,
      // not the least.
      this.prisma.run.findMany({
        where: { status: { in: ['stalled', 'blocked', 'quarantined'] } },
        orderBy: [
          { lastEventAt: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
        take: limits.attentionRuns + 1,
        include: RUN_INCLUDE,
      }),
      this.prisma.run.findMany({
        where: {
          status: { in: ['succeeded', 'failed'] },
          endedAt: { gte: since },
        },
        orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
        take: limits.recentRuns + 1,
        include: RUN_INCLUDE,
      }),
      this.prisma.workOrder.findMany({
        where: { status: 'queued' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limits.queuedWorkOrders + 1,
        include: WORK_ORDER_INCLUDE,
      }),
      this.prisma.workOrder.findMany({
        where: { status: 'quarantined' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limits.quarantinedWorkOrders + 1,
        include: WORK_ORDER_INCLUDE,
      }),
      this.prisma.escalation.findMany({
        where: { status: 'raised' },
        orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
        take: limits.escalations + 1,
      }),
      // Newest first, unlike the queues above. A rejection from three months
      // ago is history; the ones worth shaping are the ones somebody is
      // waiting on right now.
      this.prisma.issueSpecRejection.findMany({
        orderBy: [{ commentedAt: 'desc' }, { id: 'desc' }],
        take: limits.specRejections + 1,
        include: { repository: { select: { owner: true, name: true } } },
      }),
    ]);

    const runCount = countByStatus(runsByStatus);
    const workOrderCount = countByStatus(workOrdersByStatus);

    return {
      generatedAt: now,
      windowDays: SNAPSHOT_WINDOW_DAYS,
      totals: {
        runsRunning: runCount('running'),
        runsStalled: runCount('stalled'),
        runsBlocked: runCount('blocked'),
        runsSucceededInWindow,
        runsFailedInWindow,
        workOrdersQueued: workOrderCount('queued'),
        workOrdersHeld: workOrderCount('held'),
        workOrdersQuarantined: workOrderCount('quarantined'),
        escalationsOutstanding,
      },
      attentionRuns: attentionRuns.map(toSnapshotRun),
      recentRuns: recentRuns.map(toSnapshotRun),
      queuedWorkOrders: queuedWorkOrders.map(toSnapshotWorkOrder),
      quarantinedWorkOrders: quarantinedWorkOrders.map(toSnapshotWorkOrder),
      escalations: escalations.map((esc: (typeof escalations)[number]) => ({
        id: esc.id,
        kind: String(esc.kind),
        status: String(esc.status),
        summary: esc.summary,
        raisedAt: esc.raisedAt,
        runId: esc.runId,
      })),
      specRejections: specRejections.map((rejection) => ({
        repository: repoName(rejection.repository),
        issueNumber: rejection.issueNumber,
        message: rejection.message,
        rejectedAt: rejection.commentedAt,
      })),
    };
  }
}

const RUN_INCLUDE = {
  workOrder: {
    include: { repository: { select: { owner: true, name: true } } },
  },
} as const;

const WORK_ORDER_INCLUDE = {
  repository: { select: { owner: true, name: true } },
} as const;

type RunRow = Prisma.RunGetPayload<{ include: typeof RUN_INCLUDE }>;
type WorkOrderRow = Prisma.WorkOrderGetPayload<{
  include: typeof WORK_ORDER_INCLUDE;
}>;

function toSnapshotRun(run: RunRow): SnapshotRun {
  return {
    id: run.id,
    workOrderIdentity: run.workOrder.identity,
    repository: repoName(run.workOrder.repository),
    issueNumber: run.workOrder.issueNumber,
    issueTitle: run.workOrder.issueTitle,
    status: String(run.status),
    runnerKey: run.runnerKey,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    lastEventAt: run.lastEventAt,
    attemptCount: run.attemptCount,
    // The null is CARRIED, not defaulted: a runner that declares no cost
    // reporting (VISION §6) must not appear to have run for free. Converted
    // through the shared helper for the reason its own comment gives — two
    // call sites converting a Decimal two ways is a bug that only shows up
    // against a test double.
    costUsd: toNumberOrNull(run.costUsd),
    attentionReason: run.attentionReason,
    stopReason: run.stopReason,
    pullRequestNumber: run.pullRequestNumber,
    pullRequestState:
      run.pullRequestState === null ? null : String(run.pullRequestState),
    acceptanceCriteriaCount: run.workOrder.acceptanceCriteria.length,
  };
}

function toSnapshotWorkOrder(wo: WorkOrderRow): SnapshotWorkOrder {
  return {
    identity: wo.identity,
    repository: repoName(wo.repository),
    issueNumber: wo.issueNumber,
    issueTitle: wo.issueTitle,
    status: String(wo.status),
    attempt: wo.attempt,
    acceptanceCriteriaCount: wo.acceptanceCriteria.length,
    createdAt: wo.createdAt,
  };
}

function repoName(repo: { owner: string; name: string } | null): string {
  return repo ? `${repo.owner}/${repo.name}` : 'unknown/unknown';
}

/**
 * Turn a `groupBy` result into a lookup that reports zero for an absent status.
 *
 * `groupBy` omits statuses with no rows, and treating "absent" as anything but
 * zero would put `undefined` into the totals line.
 */
function countByStatus(
  rows: readonly { status: unknown; _count: { _all: number } }[],
): (status: string) => number {
  const map = new Map(rows.map((row) => [String(row.status), row._count._all]));
  return (status) => map.get(status) ?? 0;
}
