import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { HardSpendCeilingService } from '../budget/hard-spend-ceiling';
import { decideSpendAdmission } from '../budget/spend-admission';
import { SpendLedgerService } from '../budget/spend-ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClaudeCodeLocalRunner,
  RunnerAtCapacityError,
} from '../runners/claude-code-local/claude-code-local.runner';
import { RunPollerService } from '../runners/run-poller.service';
import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import type { Runner, WorkOrderSpec } from '../runners/runner.types';
import type { GeneratedWorkOrder } from '../work-orders/work-order-generator';
import { WorkOrderRecordsService } from '../work-orders/work-order-records.service';
import { DispatchService } from './dispatch.service';
import type { DispatchDecision, QueueReason } from './dispatch-policy';

/**
 * Hands an authorized work order to a runner.
 *
 * ## The gap this closes
 *
 * Every piece existed and none of them were joined. #62 turned an issue into a
 * work order, #63 wrote its records, #64 decided which runner should take it,
 * #61 implemented that runner, #147 registered it and polled it — and nothing
 * called `submit()`. `decide()` returned a decision to nobody. The seam was
 * complete, registered, routable, pollable, and unreachable.
 *
 * ## This is the first thing in the system that spends money
 *
 * VISION §3.5 gates on reversibility, not importance, and this action is not
 * reversible: it starts an agent that costs real money against a real
 * subscription. So it is off unless explicitly enabled, and when off it still
 * runs the whole decision and reports what it WOULD have done — which is
 * VISION §12's observation-week posture applied to execution rather than to
 * labels.
 */

export type ExecutionResult =
  | {
      outcome: 'dispatched';
      runId: string;
      runnerKey: string;
      reason: string;
    }
  | { outcome: 'queued'; queueReason: QueueReason | null; reason: string }
  | { outcome: 'failed'; runId: string; reason: string }
  | {
      outcome: 'observed';
      /** Where it would have gone. Null when it would have queued anyway. */
      wouldDispatchTo: string | null;
      reason: string;
    };

@Injectable()
export class RunExecutorService {
  private readonly logger = new Logger(RunExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OperatorSettingsService,
    private readonly dispatch: DispatchService,
    private readonly records: WorkOrderRecordsService,
    private readonly poller: RunPollerService,
    private readonly claudeCodeLocal: ClaudeCodeLocalRunner,
    private readonly ceiling: HardSpendCeilingService,
    private readonly ledger: SpendLedgerService,
  ) {}

  /**
   * Decide, record, submit, track.
   *
   * The order is not arbitrary and each step has a reason it cannot move:
   *
   * 1. **Decide first**, so a work order nothing can take never gets a `Run`
   *    row. A queue is a normal outcome (#64), not a failure.
   * 2. **Create the run before submitting.** There has to be a row for an
   *    event to attach to before the first event can arrive, which is exactly
   *    why `WorkOrderSpec.runId` is passed IN rather than returned by
   *    `submit`.
   * 3. **Write the records before submitting.** #63's execution record is the
   *    branch's first commit, and the runner's workspace starts from that
   *    branch — writing them afterwards would leave the agent unable to push.
   * 4. **Track before returning.** An untracked run is one nothing polls, and
   *    the poller reports those as stalled within a tick.
   */
  async dispatchWorkOrder(
    input: DispatchWorkOrderInput,
  ): Promise<ExecutionResult> {
    const { workOrder } = input;
    const decision = await this.dispatch.decide(
      workOrder.needs,
      workOrder.identity,
      workOrder.modelTier,
    );

    if (decision.outcome === 'queued' || decision.runnerKey === null) {
      return {
        outcome: 'queued',
        queueReason: decision.queueReason,
        reason: decision.reason,
      };
    }

    const runner = this.runnerFor(decision.runnerKey);
    if (!runner) {
      // Routing chose a runner this build cannot instantiate — a registration
      // left behind by an older deployment, most likely. Queue rather than
      // fail: the work order is fine, the fleet is not.
      const reason = `Routing chose ${decision.runnerKey}, which this build has no implementation for`;
      this.logger.error(reason);
      return { outcome: 'queued', queueReason: null, reason };
    }

    const capabilities = await runner.capabilities();

    // The spend gate (#65), deliberately placed BEFORE the observation-mode
    // check rather than after it. An install running with dispatch off is
    // exactly the one that needs to be told its ceiling is unset, while there
    // is still time to fix it — VISION §12's observation week is for finding
    // out what would happen, and "it would have refused to spend" is one of
    // the things that would happen.
    const spend = decideSpendAdmission(
      this.ceiling.value,
      await this.ledger.tally(this.ceiling.value.windowDays),
      {
        ceilingUsd: workOrder.budgetCeilingUsd,
        runnerReportsCost: capabilities.reportsCost,
      },
    );

    if (!spend.admit) {
      // Logged at warn rather than debug: this is money not being spent
      // because a limit said so, which is the system working, and an operator
      // who cannot see it working will assume it is not.
      this.logger.warn(
        `${workOrder.identity} not dispatched — ${spend.reason}`,
      );
      return {
        outcome: 'queued',
        queueReason: spend.refusal,
        reason: spend.reason,
      };
    }

    if (!this.enabled) {
      // The whole decision, none of the consequences. VISION §12 asks for
      // exactly this before an outward action is switched on: a record of what
      // it would have done, produced by the same code path that will do it.
      const reason =
        `DISPATCH DISABLED — would have dispatched ${workOrder.identity} to ` +
        `${decision.runnerKey}@${capabilities.version}. Dispatch ships enabled ` +
        `(ADR-0019), so this was turned off deliberately; turn it back on to act.`;
      this.logger.warn(reason);
      return {
        outcome: 'observed',
        wouldDispatchTo: decision.runnerKey,
        reason,
      };
    }

    // Generated here rather than by the database, because it has to be inside
    // the work-order spec the runner receives and on the records written
    // before the run exists.
    const runId = randomUUID();

    await this.prisma.run.create({
      data: {
        id: runId,
        workOrderId: input.workOrderId,
        runnerKey: decision.runnerKey,
        runnerVersion: capabilities.version,
        status: 'running',
        // The avoided park (#264), written in the SAME statement as the run
        // rather than after it. See `avoidedParkRow` for why it is written
        // here at all and not where the decision was made.
        ...avoidedParkRow(decision, new Date()),
      },
    });

    try {
      await this.records.write({
        workOrder,
        runnerKey: decision.runnerKey,
        runnerVersion: capabilities.version,
        runId,
      });

      const handle = await runner.submit(toSpec(workOrder, runId));
      this.poller.track(runId, runner, handle);

      await this.prisma.workOrder.update({
        where: { id: input.workOrderId },
        data: { status: 'dispatched' },
      });

      const reason = `Dispatched ${workOrder.identity} to ${decision.runnerKey} as run ${runId}`;
      this.logger.log(reason);

      return {
        outcome: 'dispatched',
        runId,
        runnerKey: decision.runnerKey,
        reason,
      };
    } catch (error) {
      return this.recover(runId, workOrder, error);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Something failed after the run row existed. Leave nothing phantom behind.
   *
   * A `running` row with no process is the worst available outcome: the
   * watchdog will find it ninety seconds later and report a silent run, which
   * is true but useless — the run never started, and the reason is already
   * known right here.
   */
  private async recover(
    runId: string,
    workOrder: GeneratedWorkOrder,
    error: unknown,
  ): Promise<ExecutionResult> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof RunnerAtCapacityError) {
      // NOT a failed run. The runner's own backstop refused after routing said
      // yes — routing reads the database while the ceiling counts live
      // children, so the two can legitimately disagree by one. #66 counts
      // attempts to judge decomposition quality (metric 4), and a capacity
      // refusal is not an attempt: the row is removed rather than failed,
      // because a run that never started is not a run.
      await this.prisma.run
        .delete({ where: { id: runId } })
        .catch(() => undefined);
      this.logger.warn(`${workOrder.identity} re-queued: ${message}`);
      return {
        outcome: 'queued',
        queueReason: 'capable-runners-are-at-capacity',
        reason: message,
      };
    }

    await this.prisma.run.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'failed', endedAt: new Date(), attentionReason: message },
    });

    this.logger.error(
      `${workOrder.identity} failed before it started: ${message}`,
    );
    return { outcome: 'failed', runId, reason: message };
  }

  /**
   * The key routing chose, as something that can be submitted to.
   *
   * A switch over one runner rather than a registry abstraction. VISION §3.7
   * says not to build the second runner until it is needed, and a registry for
   * a single entry is how the second one starts looking easy while the first
   * becomes hard to read. Adding one here is a line.
   */
  private runnerFor(key: string): Runner | null {
    return key === ClaudeCodeLocalRunner.KEY ? this.claudeCodeLocal : null;
  }

  private get enabled(): boolean {
    return this.settings.get('dispatch.enabled');
  }
}

export interface DispatchWorkOrderInput {
  workOrder: GeneratedWorkOrder;
  /** The `WorkOrder` row's id. The generated document carries the identity. */
  workOrderId: string;
}

/**
 * The avoided park, as a nested create on the run that carries it (#264).
 *
 * ## Why HERE, and not in `DispatchService` where the decision is made
 *
 * That is the obvious home and it is the wrong one. `cockpit/queue.service.ts`
 * calls `decide()` HYPOTHETICALLY — once per distinct needs set, every time
 * the queue panel polls, to answer "why is this work order not running yet".
 * Persisting inside the decision would manufacture avoided parks for work that
 * never dispatched, at whatever rate a browser refreshes, and the count would
 * measure dashboard traffic. The executor is the only place that knows a
 * dispatch actually happened: the spend gate, observation mode and an
 * unimplementable runner key all abort after a perfectly good decision.
 *
 * ## Why in the same statement as the run
 *
 * A nested create is one INSERT pair in one call. A second `create` afterwards
 * could fail on its own and leave a dispatched run whose avoided park was
 * silently lost — an undercount with no symptom, which is the failure mode a
 * metric can least afford.
 *
 * ## Still a count, never a duration
 *
 * `resumesAt` is carried so the count is explainable, and nothing subtracts it
 * from anything. The park did not happen; it has no length. See the
 * `AvoidedPark` model comment in `schema.prisma`.
 */
// Annotated, and that annotation is load-bearing. Prisma's `data:` slot is a
// generic inference target, so nothing inside it is excess-property-checked
// (#159) — a typo here would compile and then be REJECTED at runtime by the
// whole `run.create`. A concrete return type is a non-generic position, which
// is where TypeScript does check.
function avoidedParkRow(
  decision: DispatchDecision,
  occurredAt: Date,
): Pick<Prisma.RunUncheckedCreateInput, 'avoidedPark'> {
  const park = decision.avoidedPark;
  if (!park) return {};

  // The SOONEST reset among the spent runners. Undated positions are dropped
  // rather than treated as "no reset": routing only calls a DATED block
  // exhaustion, so an undated entry here would be a pool somebody hand-built.
  const resets = park.exhausted
    .map((runner) => runner.resumesAt)
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    avoidedPark: {
      create: {
        occurredAt,
        chosenRunnerKey: park.chosenRunnerKey,
        exhaustedRunnerKeys: park.exhausted.map((runner) => runner.runnerKey),
        resumesAt: resets[0] ?? null,
        basis: park.exhausted.map(
          (runner) => `${runner.runnerKey} ${runner.basis}`,
        ),
      },
    },
  };
}

/**
 * The work order as the seam receives it.
 *
 * A translation rather than a cast, and the notable thing is what is NOT
 * carried across: there is no runner field, because VISION §6 requires that a
 * work order never name one. The seam type has no such field to fill, which is
 * what makes the rule structural rather than a convention.
 */
function toSpec(workOrder: GeneratedWorkOrder, runId: string): WorkOrderSpec {
  return {
    identity: workOrder.identity,
    runId,
    repository: {
      owner: workOrder.repositoryOwner,
      name: workOrder.repositoryName,
    },
    baseCommit: workOrder.baseCommit,
    branch: workOrder.branch,
    taskSpec: workOrder.taskSpec,
    acceptanceCriteria: workOrder.acceptanceCriteria,
    pathConstraints: workOrder.pathConstraints,
    budgetCeilingUsd: workOrder.budgetCeilingUsd,
    wallClockTimeoutMinutes: workOrder.wallClockTimeoutMinutes,
    needs: workOrder.needs,
    // Carried across, not just routed on. Routing having chosen a runner that
    // SERVES the tier is not the same as the runner knowing which tier to use:
    // dropping it here would leave a `tier:small` work order running on the
    // runner's default model, which is the spend the tier exists to avoid.
    // Spread so an unstated tier stays an absent key rather than an explicit
    // undefined the seam would have to interpret.
    ...(workOrder.modelTier ? { modelTier: workOrder.modelTier } : {}),
  };
}
