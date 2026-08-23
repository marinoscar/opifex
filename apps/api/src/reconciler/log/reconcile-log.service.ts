import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { TickRecord } from '../reconciler.types';

export interface TickHistoryQuery {
  page: number;
  pageSize: number;
  /** Only ticks with this outcome. */
  outcome?: string;
  /** Only ticks that computed at least one action — how a week is read. */
  actionsOnly?: boolean;
}

/**
 * Persists what every tick observed, computed, and would have done.
 *
 * #50 is explicit that this log "is the actual deliverable of Phase 2 — not a
 * debugging aid". VISION §12 ends the observation week by reviewing it, so a
 * gap in it is not a missing log line; it is a hole in the evidence the phase
 * exists to produce.
 */
@Injectable()
export class ReconcileLogService {
  private readonly logger = new Logger(ReconcileLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one tick.
   *
   * Never throws. A tick that reconciled correctly but failed to write its log
   * row must not be reported as a failed tick — that would corrupt the very
   * record being kept, and turn a storage hiccup into a phantom reconciler
   * bug for whoever reviews the week.
   */
  async record(record: TickRecord): Promise<void> {
    // Every tick gets a row, including quiet ones: a log with gaps cannot be
    // reviewed, because a missing entry is indistinguishable from a tick that
    // never ran. Only the heavy payload is conditional.
    const worthKeeping =
      record.actions.length > 0 || record.failures.length > 0;

    try {
      await this.prisma.reconcileTick.create({
        data: {
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: record.durationMs,
          outcome: record.outcome,
          repositoriesObserved: record.repositoriesObserved,
          actionsComputed: record.actions.length,
          // Zero for the whole observation week. Recorded rather than assumed
          // so "we were read-only" is checkable against the log.
          actionsExecuted: 0,
          allFromCache: record.allFromCache,
          rateLimitRemaining: record.rateLimitRemaining,
          failures: toJson(record.failures),
          projections: worthKeeping ? toJson(record.projections) : undefined,
          actions: worthKeeping ? toJson(record.actions) : undefined,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record tick: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async history(query: TickHistoryQuery) {
    const where: Prisma.ReconcileTickWhereInput = {
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.actionsOnly ? { actionsComputed: { gt: 0 } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.reconcileTick.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.reconcileTick.count({ where }),
    ]);

    return {
      items: items.map(toResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findById(id: string) {
    const tick = await this.prisma.reconcileTick.findUnique({ where: { id } });
    return tick ? toResponse(tick) : null;
  }

  /** Delete ticks older than the cutoff. Returns how many went. */
  async prune(olderThan: Date): Promise<number> {
    const { count } = await this.prisma.reconcileTick.deleteMany({
      where: { startedAt: { lt: olderThan } },
    });
    return count;
  }
}

type ReconcileTickRow = Awaited<
  ReturnType<PrismaService['reconcileTick']['findUniqueOrThrow']>
>;

function toResponse(tick: ReconcileTickRow) {
  return {
    id: tick.id,
    startedAt: tick.startedAt.toISOString(),
    finishedAt: tick.finishedAt.toISOString(),
    durationMs: tick.durationMs,
    outcome: tick.outcome,
    repositoriesObserved: tick.repositoriesObserved,
    actionsComputed: tick.actionsComputed,
    actionsExecuted: tick.actionsExecuted,
    allFromCache: tick.allFromCache,
    rateLimitRemaining: tick.rateLimitRemaining,
    failures: tick.failures,
    projections: tick.projections ?? null,
    actions: tick.actions ?? null,
  };
}

/**
 * Round-trip through JSON rather than cast.
 *
 * The tick record holds `Date` objects and a discriminated union of action
 * types, neither of which Prisma's `InputJsonValue` accepts structurally even
 * though every value in them is valid JSON. Serialising makes the column's
 * contract true at the boundary instead of asserted past the type system —
 * and it is what turns the `Date`s into ISO strings a reviewer can read.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
