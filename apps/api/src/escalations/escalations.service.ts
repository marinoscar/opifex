import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { EscalationKind, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { ReconcileAction } from '../reconciler/diff/actions.types';
import { FactoryMetrics } from '../telemetry/factory-metrics.service';
import { MAX_SAMPLES, stats, type LatencyStats } from './detection-latency';

export interface RaiseResult {
  raised: number;
  /** Suppressed because an unresolved escalation of the same kind exists. */
  deduplicated: number;
}

/**
 * Statuses meaning "a human has not dealt with this yet".
 *
 * The dedupe set. An escalation that was delivered but not acknowledged still
 * counts as outstanding — the operator has been told and has not acted, so
 * telling them again about the same thing is the noise #57 forbids.
 *
 * EXPORTED since #80: the cockpit's `needsAttention` filter asks exactly this
 * question, and it must not be a second opinion about it. A read model with
 * its own list would drift from the dedupe rule the moment either changed, and
 * the two disagreeing means the panel shows a run nobody will be told about —
 * or hides one somebody already was.
 */
export const UNRESOLVED: readonly string[] = [
  'raised',
  'dispatched',
  'delivered',
  'failed',
];

/**
 * Escalations, as first-class records.
 *
 * VISION §9, stated as a rule and a reason:
 *
 * > **Escalation is an action, not telemetry.** A stalled run that nobody is
 * > told about is the exact failure this system exists to eliminate.
 * > Notification is a reconciler output, on the same footing as dispatch.
 *
 * Treating escalation as a logging concern is how a monitoring system ends up
 * not monitoring.
 */
@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: FactoryMetrics,
  ) {}

  /**
   * Raise escalations for the `escalate` actions in a list.
   *
   * ## Deduplication is the whole design
   *
   * #57: "A run that stalls once should produce one escalation, not one per
   * tick — an operator who is paged twelve times about the same stall stops
   * reading escalations, which reproduces the original problem by a different
   * route."
   *
   * The watchdog re-derives the same verdict on every tick by design — it is a
   * reconciler, it recomputes from scratch — so without this a one-minute tick
   * would page sixty times an hour about one stall. Deduped per (run, kind)
   * rather than per run: a run that is both quarantined and over budget has
   * two problems, and collapsing them would hide one.
   */
  async raiseFrom(actions: ReconcileAction[]): Promise<RaiseResult> {
    const escalations = actions.filter((action) => action.type === 'escalate');
    let raised = 0;
    let deduplicated = 0;

    for (const action of escalations) {
      const kind = (action.escalationKind ?? 'system') as EscalationKind;

      const existing = await this.prisma.escalation.findFirst({
        where: {
          runId: action.runId ?? null,
          kind,
          status: { in: UNRESOLVED as never },
        },
        select: { id: true },
      });

      if (existing) {
        deduplicated += 1;
        continue;
      }

      // The STOP side of success metric 1, from the detector that knows what
      // it measured from. `raisedAt` is stamped here rather than left to the
      // column default so the row and the metric agree to the millisecond.
      const raisedAt = new Date();
      const progressStoppedAt = action.progressStoppedAt
        ? new Date(action.progressStoppedAt)
        : null;
      const detectionSource = action.detectionSource ?? null;

      const created = await this.prisma.escalation.create({
        data: {
          runId: action.runId ?? null,
          kind,
          status: 'raised',
          // One line for a phone's notification body.
          summary: summarize(action),
          // The full reason, which already names the numbers that produced it.
          detail: action.reason,
          raisedAt,
          progressStoppedAt,
          detectionSource: detectionSource as never,
          detectLatencyMs: progressStoppedAt
            ? elapsed(progressStoppedAt, raisedAt)
            : null,
        },
      });
      raised += 1;

      // Only when the detector said when progress stopped. Recording a
      // measurement against `raisedAt` alone would put a near-zero latency in
      // the histogram for every escalation that cannot be measured, which is
      // the one way to make success metric 1 lie in the flattering direction.
      if (progressStoppedAt) {
        this.metrics.recordDetected({
          workOrderIdentity: action.evidence.workOrderIdentity,
          repository: action.repository,
          kind,
          detectionSource,
          progressStoppedAt,
          raisedAt: created.raisedAt,
        });
      }

      this.logger.warn(`Escalation raised (${kind}): ${summarize(action)}`);
    }

    return { raised, deduplicated };
  }

  /**
   * Raise one control-plane escalation, with no run behind it and no dedupe.
   *
   * Added for #97's `park_and_escalate` approvals, and kept general because
   * nothing about it is approval-specific. `kind` is `system` — "the control
   * plane itself is in a state it cannot resolve" — which is exactly what a
   * parked approval is: VISION §8 says an irreversible action is never
   * auto-approved, so the request has no timer and nothing but a person moves
   * it.
   *
   * ## Why this is not `raiseFrom`
   *
   * Two reasons, both disqualifying. `raiseFrom` takes `ReconcileAction`s,
   * which carry a repository, an issue number and a projection `evidence`
   * block that a parked approval simply does not have; synthesising them would
   * put invented facts in the escalation record. And `raiseFrom` DEDUPES per
   * `(runId, kind)`, which is right for a watchdog re-deriving the same
   * verdict every tick and wrong here — every parked approval is a distinct
   * question, and with `runId: null, kind: 'system'` the second one and every
   * one after it would be silently suppressed. Nobody would be told about the
   * cases VISION §8 says are most worth telling them about.
   *
   * It returns the id because the caller must link it: `ApprovalRequest.
   * escalationId` is the edge that lets an operator get from the page on their
   * phone to the thing that is waiting.
   */
  async raiseSystem(input: {
    summary: string;
    detail: string;
    raisedAt?: Date;
  }): Promise<{ id: string }> {
    const created = await this.prisma.escalation.create({
      data: {
        runId: null,
        kind: 'system',
        status: 'raised',
        summary: input.summary,
        detail: input.detail,
        raisedAt: input.raisedAt ?? new Date(),
        // No `progressStoppedAt`, and therefore no detection-latency sample.
        // Success metric 1 measures "a run ceasing to make progress" (VISION
        // §10); an approval that nobody has answered yet is not a run that
        // stopped, and folding it into the same histogram would make the
        // headline metric describe two different things at once.
        progressStoppedAt: null,
        detectionSource: null,
        detectLatencyMs: null,
      },
      select: { id: true },
    });

    this.logger.warn(`Escalation raised (system): ${input.summary}`);

    return created;
  }

  async list(query: {
    page: number;
    pageSize: number;
    status?: string;
    unresolvedOnly?: boolean;
    runId?: string;
  }) {
    const where: Prisma.EscalationWhereInput = {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.unresolvedOnly ? { status: { in: UNRESOLVED as never } } : {}),
      // Per-run queryability, the other half of #59's requirement: the
      // aggregate says the fleet is slow, this says which run it was.
      ...(query.runId ? { runId: query.runId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.escalation.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { raisedAt: 'desc' },
      }),
      this.prisma.escalation.count({ where }),
    ]);

    return {
      items: items.map(toResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Record that a human has seen it.
   *
   * The one fact the whole lifecycle exists to capture. `acknowledgedById` is
   * required rather than optional: an acknowledgement with no acknowledger
   * cannot answer the question it is for — who knows about this.
   */
  async acknowledge(id: string, userId: string) {
    const escalation = await this.prisma.escalation.findUnique({
      where: { id },
    });
    if (!escalation) {
      throw new NotFoundException(`Escalation ${id} not found`);
    }

    // Acknowledging twice is not an error — two people reaching for the same
    // page at once is normal, and the first acknowledgement is the true one.
    if (escalation.acknowledgedAt) {
      return toResponse(escalation);
    }

    return toResponse(
      await this.prisma.escalation.update({
        where: { id },
        data: {
          status: 'acknowledged',
          acknowledgedAt: new Date(),
          acknowledgedById: userId,
        },
      }),
    );
  }

  /**
   * Success metric 1, aggregated for the cockpit.
   *
   * ## Four numbers, because three of them can hide the fourth
   *
   * `notified` is THE metric: stop to a human being informed. It can only
   * include escalations a transport actually delivered.
   *
   * `detected` is stop to noticed. Reported alongside so the gap between them
   * is visible — a fast detector behind a broken transport looks perfect on
   * `detected` alone.
   *
   * `awaitingNotification` counts escalations that were measurable and were
   * never delivered. Their true stop-to-notified latency is unbounded.
   * Leaving them out of `notified` without saying so would make a completely
   * broken notification path render as excellent latency over a tiny sample,
   * so the count is reported next to the percentiles it is missing from.
   *
   * `unmeasurable` counts escalations with no stop time at all — a `system`
   * escalation has no run that stopped. Counted rather than measured from
   * `raisedAt`, which would be a zero-latency entry per unmeasurable event.
   */
  async latencySummary(
    query: { since?: Date; until?: Date; repository?: string } = {},
  ) {
    const where: Prisma.EscalationWhereInput = {
      ...(query.since || query.until
        ? {
            raisedAt: {
              ...(query.since ? { gte: query.since } : {}),
              ...(query.until ? { lte: query.until } : {}),
            },
          }
        : {}),
      ...(query.repository
        ? {
            run: {
              workOrder: {
                repository: {
                  owner: query.repository.split('/')[0],
                  name: query.repository.split('/').slice(1).join('/'),
                },
              },
            },
          }
        : {}),
    };

    const rows = await this.prisma.escalation.findMany({
      where,
      select: {
        detectionSource: true,
        progressStoppedAt: true,
        detectLatencyMs: true,
        notifyLatencyMs: true,
      },
      orderBy: { raisedAt: 'desc' },
      // One more than the cap, so exceeding it is DETECTED rather than
      // silently described as the whole window.
      take: MAX_SAMPLES + 1,
    });

    const truncated = rows.length > MAX_SAMPLES;
    const sample = truncated ? rows.slice(0, MAX_SAMPLES) : rows;

    return {
      since: query.since?.toISOString() ?? null,
      until: query.until?.toISOString() ?? null,
      /** True when the window held more escalations than one summary reads. */
      truncated,
      sampleSize: sample.length,
      ...summarizeLatency(sample),
      bySource: Object.fromEntries(
        ['runner', 'git', 'control_plane'].map((source) => [
          source,
          summarizeLatency(
            sample.filter((row) => row.detectionSource === source),
          ),
        ]),
      ),
    };
  }

  /**
   * Record that a transport confirmed delivery.
   *
   * The NOTIFIED side of success metric 1, and it deliberately does not live
   * in the detector. VISION §10 measures to "a human being informed", and only
   * the transport knows when that happened; a detector allowed to guess would
   * be reporting stop-to-detected under the other name.
   *
   * #58 supplies the transport that calls this. Until then the gap between
   * `opifex.escalations.raised` and `opifex.escalations.notified` is the
   * honest reading: stalls nobody was told about.
   */
  async markDelivered(
    id: string,
    transport: string,
    options: { receiptId?: string; deliveredAt?: Date } = {},
  ) {
    const escalation = await this.prisma.escalation.findUnique({
      where: { id },
      select: {
        id: true,
        kind: true,
        raisedAt: true,
        deliveredAt: true,
        progressStoppedAt: true,
        detectionSource: true,
        run: {
          select: {
            workOrder: { select: { identity: true, repository: true } },
          },
        },
      },
    });
    if (!escalation) {
      throw new NotFoundException(`Escalation ${id} not found`);
    }

    // The FIRST delivery is the one that informed the operator. A transport
    // that redelivers must not restart the clock and improve the metric.
    if (escalation.deliveredAt) {
      return this.get(id);
    }

    const deliveredAt = options.deliveredAt ?? new Date();

    const updated = await this.prisma.escalation.update({
      where: { id },
      data: {
        status: 'delivered',
        transport,
        receiptId: options.receiptId ?? null,
        deliveredAt,
        notifyLatencyMs: escalation.progressStoppedAt
          ? elapsed(escalation.progressStoppedAt, deliveredAt)
          : null,
        deliveryAttempts: { increment: 1 },
      },
    });

    if (escalation.progressStoppedAt) {
      this.metrics.recordNotified({
        workOrderIdentity: escalation.run?.workOrder.identity ?? null,
        repository: repositoryName(escalation.run?.workOrder.repository),
        kind: escalation.kind,
        detectionSource: escalation.detectionSource,
        progressStoppedAt: escalation.progressStoppedAt,
        raisedAt: escalation.raisedAt,
        deliveredAt,
      });
    }

    return toResponse(updated);
  }

  async get(id: string) {
    const escalation = await this.prisma.escalation.findUnique({
      where: { id },
    });
    if (!escalation) {
      throw new NotFoundException(`Escalation ${id} not found`);
    }
    return toResponse(escalation);
  }

  /**
   * Mark an escalation resolved because the condition cleared on its own.
   *
   * Distinct from `acknowledged`: nobody saw this one. Recording it as
   * acknowledged would overstate what is known — the lifecycle's whole job is
   * distinguishing "we told you" from "you saw it".
   */
  async resolveStale(runIds: string[]): Promise<number> {
    if (runIds.length === 0) return 0;

    const { count } = await this.prisma.escalation.updateMany({
      where: { runId: { in: runIds }, status: { in: UNRESOLVED as never } },
      data: { status: 'resolved' },
    });

    return count;
  }
}

type EscalationRow = Awaited<
  ReturnType<PrismaService['escalation']['findUniqueOrThrow']>
>;

function toResponse(escalation: EscalationRow) {
  return {
    id: escalation.id,
    runId: escalation.runId,
    kind: escalation.kind,
    status: escalation.status,
    summary: escalation.summary,
    detail: escalation.detail,
    transport: escalation.transport,
    deliveryAttempts: escalation.deliveryAttempts,
    failureReason: escalation.failureReason,
    progressStoppedAt: escalation.progressStoppedAt?.toISOString() ?? null,
    detectionSource: escalation.detectionSource,
    detectLatencyMs: escalation.detectLatencyMs,
    notifyLatencyMs: escalation.notifyLatencyMs,
    raisedAt: escalation.raisedAt.toISOString(),
    dispatchedAt: escalation.dispatchedAt?.toISOString() ?? null,
    deliveredAt: escalation.deliveredAt?.toISOString() ?? null,
    acknowledgedAt: escalation.acknowledgedAt?.toISOString() ?? null,
    acknowledgedById: escalation.acknowledgedById,
  };
}

/**
 * One line, for a phone.
 *
 * #57 requires the payload be "sufficient to act on without opening a laptop".
 * The full reason is kept in `detail`; this is what fits in a notification.
 */
function summarize(action: ReconcileAction): string {
  const where = `${action.repository}#${action.issueNumber}`;
  const what = action.evidence.workOrderIdentity ?? where;

  switch (action.escalationKind) {
    case 'run_stalled':
      return `${what} stalled (${where})`;
    case 'run_looping':
      return `${what} is looping (${where})`;
    case 'run_failed':
      return `${what} failed (${where})`;
    case 'quarantined':
      return `${what} quarantined (${where})`;
    case 'budget_exceeded':
      return `${what} hit its budget ceiling (${where})`;
    default:
      return `${what} needs attention (${where})`;
  }
}

/**
 * Never negative.
 *
 * A runner's `occurredAt` comes from the runner's clock, and skew against the
 * control plane's is ordinary. A negative latency is not a small error: it
 * drags the aggregate below the truth and can make the target look met.
 */
function elapsed(from: Date, to: Date): number {
  return Math.max(0, to.getTime() - from.getTime());
}

function repositoryName(
  repository: { owner: string; name: string } | undefined,
): string {
  return repository ? `${repository.owner}/${repository.name}` : 'unknown';
}

export interface LatencySample {
  progressStoppedAt: Date | null;
  detectLatencyMs: number | null;
  notifyLatencyMs: number | null;
}

export interface LatencySummary {
  /** Stop to a human being informed. VISION §10's success metric 1. */
  notified: LatencyStats;
  /** Stop to Opifex noticing. The easy number, reported so the gap shows. */
  detected: LatencyStats;
  /**
   * Measurable, raised, never delivered. Their real stop-to-notified latency
   * is unbounded, so they are counted here rather than dropped from
   * `notified` without trace.
   */
  awaitingNotification: number;
  /** Raised with no stop time at all, such as a `system` escalation. */
  unmeasurable: number;
}

function summarizeLatency(rows: LatencySample[]): LatencySummary {
  const measurable = rows.filter((row) => row.progressStoppedAt !== null);

  return {
    notified: stats(
      measurable
        .map((row) => row.notifyLatencyMs)
        .filter((value): value is number => value !== null),
    ),
    detected: stats(
      measurable
        .map((row) => row.detectLatencyMs)
        .filter((value): value is number => value !== null),
    ),
    awaitingNotification: measurable.filter(
      (row) => row.notifyLatencyMs === null,
    ).length,
    unmeasurable: rows.length - measurable.length,
  };
}
