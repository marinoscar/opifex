import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { TickExecutionFailure, TickRecord } from '../reconciler.types';

/**
 * What `ReconcilerTask` knows once the tick's acting phase is over, and the
 * log row does not yet (#317, #320).
 */
export interface TickExecution {
  /** GitHub writes issued during the tick's window. */
  writesIssued: number;
  /**
   * Acting-phase failures, normalized — or null when no acting-phase executor
   * ran at all, which is not the same as one running clean.
   */
  executionFailures: TickExecutionFailure[] | null;
}

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
   * actually executed (#317, #320): the row is created BEFORE the executors
   * run, because a tick that never reaches them must still be logged, so
   * neither the execution count nor the executors' failures can be known
   * here.
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
          // the real figure arrives later via `recordExecution`. Until it
          // does, the honest value is zero: no write has left the process on
          // this tick's behalf at the moment the row is created.
          //
          // Read #317 before touching this line. It used to be a literal with
          // a comment claiming "we were read-only is checkable against the
          // log", which it was not — nothing anywhere wrote another value, so
          // the observation week's one safety check could not fail.
          actionsExecuted: 0,
          // `executionFailures` is deliberately not set here at all, leaving
          // it null: no acting-phase executor has run yet, and `[]` would
          // claim this tick acted and found nothing wrong (#320).
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
   * Stamp on what the tick's acting phase actually did.
   *
   * One update carrying both figures, not two. They are produced by the same
   * pass of `ReconcilerTask` and describe the same window, so splitting them
   * would double the write cost of every acting tick and — worse — allow a
   * crash between the two to leave a row claiming writes with its failure
   * record still null, which is the exact "looks complete and is not" state
   * #320 exists to remove.
   *
   * ## `writesIssued`
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
   * ## `executionFailures`
   *
   * Null when no acting-phase executor ran at all, and the column is then left
   * exactly as `record` created it. `[]` when one ran and reported nothing
   * wrong. That distinction is the whole point of the field — writing `[]`
   * where null belongs would turn "never tried" into a clean bill of health —
   * so this method sets the column ONLY when the caller has an answer, and the
   * caller's `null` is a statement that it has none.
   *
   * Scoped to the reconciler's own executors. A dispatch write that failed is
   * recorded on the RUN, not here; see the Prisma model's comment.
   *
   * Called only when there is something to say — a non-zero count, or an
   * acting phase that ran — so an observation-week tick that computed nothing
   * still makes no second write at all.
   *
   * Never throws, for the same reason `record` does not.
   */
  async recordExecution(
    tickId: string,
    execution: TickExecution,
  ): Promise<void> {
    const { writesIssued, executionFailures } = execution;

    try {
      await this.prisma.reconcileTick.update({
        where: { id: tickId },
        data: {
          actionsExecuted: writesIssued,
          // Omitted, not set to null: the column is already null from
          // `record`, and Prisma's two JSON nulls are a distinction this row
          // does not need to take a position on.
          ...(executionFailures === null
            ? {}
            : { executionFailures: toJson(executionFailures) }),
        },
      });
    } catch (error) {
      // Loud, and worded for whoever finds it: the log now UNDER-REPORTS what
      // happened, which is the one direction this record must not fail in.
      this.logger.error(
        `Tick ${tickId} issued ${writesIssued} GitHub write(s) and reported ` +
          `${executionFailures?.length ?? 0} execution failure(s); none of it could be ` +
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
    // `?? null` on the others is a default for a missing heavy payload; here
    // null is MEANINGFUL and is passed straight through — see the DTO.
    executionFailures: tick.executionFailures,
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
