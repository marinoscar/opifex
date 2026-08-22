import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { EscalationKind, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { ReconcileAction } from '../reconciler/diff/actions.types';

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
 */
const UNRESOLVED: readonly string[] = ['raised', 'dispatched', 'delivered', 'failed'];

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

  constructor(private readonly prisma: PrismaService) {}

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

      await this.prisma.escalation.create({
        data: {
          runId: action.runId ?? null,
          kind,
          status: 'raised',
          // One line for a phone's notification body.
          summary: summarize(action),
          // The full reason, which already names the numbers that produced it.
          detail: action.reason,
        },
      });
      raised += 1;

      this.logger.warn(`Escalation raised (${kind}): ${summarize(action)}`);
    }

    return { raised, deduplicated };
  }

  async list(query: {
    page: number;
    pageSize: number;
    status?: string;
    unresolvedOnly?: boolean;
  }) {
    const where: Prisma.EscalationWhereInput = {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.unresolvedOnly ? { status: { in: UNRESOLVED as never } } : {}),
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

    return { items: items.map(toResponse), total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * Record that a human has seen it.
   *
   * The one fact the whole lifecycle exists to capture. `acknowledgedById` is
   * required rather than optional: an acknowledgement with no acknowledger
   * cannot answer the question it is for — who knows about this.
   */
  async acknowledge(id: string, userId: string) {
    const escalation = await this.prisma.escalation.findUnique({ where: { id } });
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

type EscalationRow = Awaited<ReturnType<PrismaService['escalation']['findUniqueOrThrow']>>;

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
