import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  RehydrationError,
  rehydrateWorkOrder,
  type StoredWorkOrder,
} from '../work-orders/work-order-rehydrate';
import { RunExecutorService } from './run-executor.service';

/**
 * Drains the queue #155 fills.
 *
 * ## The other half of the join
 *
 * #155 made issues become `queued` work order rows on every tick. Nothing read
 * them: `RunExecutorService.dispatchWorkOrder()` takes a `GeneratedWorkOrder`
 * and the only code holding one was the code that had just built it in memory.
 * So the queue filled and nothing drained it — the same shape of gap #155
 * itself closed one link up the chain.
 *
 * ## The authorized thing is the stored thing
 *
 * Each row is rebuilt with `rehydrateWorkOrder` (#154) rather than
 * re-projected from its issue. Re-deriving would fit the reconciler pattern
 * (VISION §4) and is still wrong here: #63 posted an authorization record for
 * ONE specific document, and if the issue has since been edited a
 * re-projection is a *different* work order wearing the same issue number.
 * #63 exists so that *"the agent did something I did not ask for"* is a
 * checkable claim rather than an argument.
 *
 * ## What it does not do
 *
 * It posts nothing. The authorization and execution records are written by
 * the executor, inside the same try that submits — writing them here would
 * put a record on an issue for a run that then failed to start.
 *
 * It also cannot dispatch a `held` work order, and that is structural rather
 * than a check: the query asks for `status: 'queued'`, and `held` is a
 * different value. A hold applied between ticks moves the row back to `held`
 * (#155), so it stops being selected at all.
 */

/**
 * How many work orders one tick will consider.
 *
 * A bound rather than the whole backlog. Fifty issues marked ready at once
 * would otherwise mean fifty `decide()` calls — each its own pair of database
 * queries — inside a tick that has 60 seconds and a rate-limit budget to
 * respect. They would queue on concurrency anyway; the only thing an unbounded
 * pass buys is a slower tick.
 */
export const DISPATCH_BATCH_SIZE = 25;

export interface DrainResult {
  /** Work orders actually handed to a runner. */
  dispatched: number;
  /** Considered, and left queued — no capable runner, or no headroom. */
  stillQueued: number;
  /** Would have dispatched, but `DISPATCH_ENABLED` is off. */
  observed: number;
  /** Failed before the run started. */
  failed: number;
  /** Rows that could not be rebuilt, and were quarantined. */
  unrebuildable: number;
  /** Repositories skipped because dispatch is not enabled for them. */
  repositoriesDisabled: number;
}

@Injectable()
export class DispatchQueueService {
  private readonly logger = new Logger(DispatchQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: RunExecutorService,
  ) {}

  /**
   * Hand queued work orders to the executor, oldest first.
   *
   * Never throws. This runs from the reconciler tick, and one unrebuildable
   * row must not stop the ones behind it — nor take down the loop that would
   * notice the next problem.
   */
  async drain(): Promise<DrainResult> {
    const result: DrainResult = {
      dispatched: 0,
      stillQueued: 0,
      observed: 0,
      failed: 0,
      unrebuildable: 0,
      repositoriesDisabled: 0,
    };

    const rows = await this.prisma.workOrder.findMany({
      where: { status: 'queued' },
      // Oldest first, and `queuedAt` rather than `createdAt`: a work order
      // that was held and later released is queued from the moment the hold
      // lifted, not from the moment it was projected. Ordering on creation
      // would let a long-held work order jump ahead of everything that has
      // actually been waiting.
      orderBy: { queuedAt: 'asc' },
      take: DISPATCH_BATCH_SIZE,
      select: WORK_ORDER_SELECT,
    });

    if (rows.length === 0) return result;

    for (const row of rows) {
      try {
        await this.dispatchOne(row, result);
      } catch (error) {
        // The executor is written not to throw; this catches anyway, because
        // an exception escaping here would abandon every work order behind
        // this one in the batch.
        result.failed += 1;
        this.logger.error(
          `Dispatching ${row.identity} threw, which dispatchWorkOrder is supposed to prevent: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.log(result, rows.length);
    return result;
  }

  // -------------------------------------------------------------------------

  private async dispatchOne(
    row: StoredRow,
    result: DrainResult,
  ): Promise<void> {
    // Per work order rather than filtered in the query, so the skip is
    // COUNTED. A repository quietly excluded by a `where` clause looks
    // identical to one with an empty queue, and during the observation week
    // the difference is the whole point.
    if (!row.repository.dispatchEnabled) {
      result.repositoriesDisabled += 1;
      this.logger.debug(
        `${row.identity} not dispatched: ${row.repository.owner}/${row.repository.name} ` +
          `has dispatch disabled`,
      );
      return;
    }

    let workOrder;
    try {
      workOrder = rehydrateWorkOrder(row);
    } catch (error) {
      if (error instanceof RehydrationError) {
        await this.quarantine(row, error.message, result);
        return;
      }
      throw error;
    }

    const execution = await this.executor.dispatchWorkOrder({
      workOrder,
      workOrderId: row.id,
    });

    switch (execution.outcome) {
      case 'dispatched':
        result.dispatched += 1;
        return;
      case 'queued':
        // Left `queued` deliberately — no row update. A work order waiting for
        // headroom is in exactly the right state already, and writing the
        // status back would touch `updatedAt` on every row on every tick for
        // no change.
        result.stillQueued += 1;
        return;
      case 'observed':
        result.observed += 1;
        return;
      case 'failed':
        // The executor already marked the RUN failed and recorded why. The
        // work order is left `queued` so a later tick retries — the failure
        // was before the run started, so nothing was spent and nothing is
        // half-done. #66 owns the attempt ceiling that stops this repeating
        // forever.
        result.failed += 1;
        return;
    }
  }

  /**
   * A row that disagrees with itself needs a human.
   *
   * `rehydrateWorkOrder` refuses a row whose stored identity its own
   * coordinates do not derive, or that declares a need this build does not
   * understand. Both are data-integrity problems, and both would repeat on
   * every tick forever if the row were left `queued`.
   *
   * Quarantine rather than `failed`, because VISION §8 is explicit that a
   * quarantined work order cannot clear its own quarantine — which is the
   * correct handling for something no amount of retrying will fix.
   */
  private async quarantine(
    row: StoredRow,
    reason: string,
    result: DrainResult,
  ): Promise<void> {
    result.unrebuildable += 1;
    this.logger.error(`Quarantining ${row.identity}: ${reason}`);

    await this.prisma.workOrder.update({
      where: { id: row.id },
      // `holdReason`, not `attentionReason` — the latter is on `Run` and does
      // not exist here. Prisma's generated `data` argument accepts an unknown
      // field WITHOUT a type error (it is checked against a union, so excess
      // properties slip through), so this compiled cleanly and would have
      // thrown at runtime. The schema documents `holdReason` as "why it is
      // held or quarantined", which is exactly this.
      data: { status: 'quarantined', holdReason: reason },
    });
  }

  private log(result: DrainResult, considered: number): void {
    if (
      result.dispatched > 0 ||
      result.failed > 0 ||
      result.unrebuildable > 0
    ) {
      this.logger.log(
        `Dispatch queue: ${considered} considered, ${result.dispatched} dispatched, ` +
          `${result.stillQueued} still queued, ${result.failed} failed, ` +
          `${result.unrebuildable} quarantined`,
      );
    } else if (result.observed > 0) {
      this.logger.warn(
        `Dispatch queue: ${result.observed} work order(s) would have been dispatched ` +
          `(DISPATCH_ENABLED is off)`,
      );
    }
  }
}

/**
 * Exactly the columns `rehydrateWorkOrder` reads, plus the row id and the
 * repository's dispatch flag.
 *
 * Selected rather than loaded whole so the shape stays checkable against
 * `StoredWorkOrder`: a column dropped from the select is a compile error here
 * rather than an `undefined` that surfaces as a work order missing a field it
 * was authorized with.
 */
const WORK_ORDER_SELECT = {
  id: true,
  identity: true,
  branch: true,
  issueNumber: true,
  issueUrl: true,
  issueTitle: true,
  baseCommit: true,
  attempt: true,
  taskSpec: true,
  acceptanceCriteria: true,
  pathConstraints: true,
  decisionRefs: true,
  needs: true,
  modelTier: true,
  budgetCeilingUsd: true,
  wallClockTimeoutMinutes: true,
  repository: { select: { owner: true, name: true, dispatchEnabled: true } },
} as const;

type StoredRow = StoredWorkOrder & {
  id: string;
  repository: { owner: string; name: string; dispatchEnabled: boolean };
};
