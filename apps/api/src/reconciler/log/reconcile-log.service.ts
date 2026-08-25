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
   * Record one tick, and return the id of the row it went into.
   *
   * The id is what lets `ReconcilerTask` come back and stamp on what the tick
   * actually executed (#317): the row is created BEFORE the executors run,
   * because a tick that never reaches them must still be logged, so the
   * execution count cannot be known here.
   *
   * Never throws, and returns `null` when the write failed. A tick that
   * reconciled correctly but failed to write its log row must not be reported
   * as a failed tick — that would corrupt the very record being kept, and turn
   * a storage hiccup into a phantom reconciler bug for whoever reviews the
   * week.
   */
  async record(record: TickRecord): Promise<string | null> {
    // Every tick gets a row, including quiet ones: a log with gaps cannot be
    // reviewed, because a missing entry is indistinguishable from a tick that
    // never ran. Only the heavy payload is conditional.
    const worthKeeping =
      record.actions.length > 0 || record.failures.length > 0;

    try {
      const row = await this.prisma.reconcileTick.create({
        // Only the id comes back. The row that just went in holds the whole
        // projection and action list, and reading them straight back out to
        // discard them would double the cost of the heaviest write the loop
        // makes, every minute, forever.
        select: { id: true },
        data: {
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: record.durationMs,
          outcome: record.outcome,
          repositoriesObserved: record.repositoriesObserved,
          actionsComputed: record.actions.length,
          // Zero because nothing has executed YET, not because nothing will.
          //
          // This row is written before `ReconcilerTask` runs the executors, so
          // the real figure arrives later via `recordWritesIssued`. Until it
          // does, the honest value is zero: no write has left the process on
          // this tick's behalf at the moment the row is created.
          //
          // Read #317 before touching this line. It used to be a literal with
          // a comment claiming "we were read-only is checkable against the
          // log", which it was not — nothing anywhere wrote another value, so
          // the observation week's one safety check could not fail.
          actionsExecuted: 0,
          allFromCache: record.allFromCache,
          rateLimitRemaining: record.rateLimitRemaining,
          failures: toJson(record.failures),
          projections: worthKeeping ? toJson(record.projections) : undefined,
          actions: worthKeeping ? toJson(record.actions) : undefined,
        },
      });

      return row.id;
    } catch (error) {
      this.logger.error(
        `Failed to record tick: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Stamp on how many GitHub writes the tick issued.
   *
   * **What the number means, exactly.** It is the count of write requests that
   * got past `GITHUB_WRITES_ENABLED` and were handed to the HTTP layer while
   * this tick was running — mirror labels, spec-feedback comments,
   * authorization records and dispatch branch creation alike, since all of
   * them route through the one write service. It counts writes that changed
   * nothing and writes that threw, because both touched GitHub.
   *
   * **What it is not.** It is not a subset of `actionsComputed`: a
   * spec-feedback comment and a dispatch branch are writes with no computed
   * action behind them, so this figure can legitimately exceed that one. And
   * it is a count of writes made during the tick's window rather than strictly
   * by it, so a write made concurrently from elsewhere — the cockpit, the
   * supervisor — lands on the tick that was in flight. That bias is toward
   * over-reporting on purpose: this figure exists to catch a period that was
   * supposed to be read-only, where a false alarm costs an investigation and a
   * missed write costs the guarantee.
   *
   * Called only when the count is non-zero, so during an observation week —
   * when the kill switch is off and nothing can be issued — the loop makes no
   * second write at all.
   *
   * Never throws, for the same reason `record` does not.
   */
  async recordWritesIssued(tickId: string, writes: number): Promise<void> {
    try {
      await this.prisma.reconcileTick.update({
        where: { id: tickId },
        data: { actionsExecuted: writes },
      });
    } catch (error) {
      // Loud, and worded for whoever finds it: the log now UNDER-REPORTS what
      // happened, which is the one direction this record must not fail in.
      this.logger.error(
        `Tick ${tickId} issued ${writes} GitHub write(s) but the count could not be ` +
          `recorded — the tick log understates this tick: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
