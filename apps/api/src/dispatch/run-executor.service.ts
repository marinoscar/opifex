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
import {
  RehydrationError,
  rehydrateWorkOrder,
} from '../work-orders/work-order-rehydrate';
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

/**
 * Why a resume did not happen, as a value rather than as prose (#477).
 *
 * One member per gate, because "the resume was refused" is not an operational
 * answer — every one of these is a DIFFERENT thing for an operator to do, and
 * a single refusal string would flatten them into a sentence somebody has to
 * read to act on. `QueueReason` earns its existence the same way on the
 * dispatch path.
 */
export type ResumeRefusal =
  /** `dispatch.autoResumeParked` is off. A human resumes it, or turns it on. */
  | 'auto-resume-disabled'
  /**
   * The run is no longer parked.
   *
   * Not an error: the watchdog computed the resume from a sweep taken earlier
   * in the same tick, and a run can report again on its own in between — which
   * is precisely the case `RunEventsService.resumeRun` handles. Also the
   * outcome when two ticks race, since the claim below is a guarded write.
   */
  | 'not-parked'
  /**
   * A human applied `factory:hold`, or the work order left `dispatched` while
   * the run was parked (quarantined, cancelled, superseded).
   */
  | 'held-or-not-dispatched'
  /** `Repository.dispatchEnabled` was turned off while the run was parked. */
  | 'repository-dispatch-disabled'
  /**
   * The run has already spent its repository's per-run ceiling.
   *
   * Its own member rather than folding into `spend-refused`, because it is a
   * different limit set by a different person in a different place: the
   * repository's, not the deployment's.
   */
  | 'repository-budget-reached'
  /** The stored row no longer rebuilds into the document that was authorized. */
  | 'work-order-unrebuildable'
  /** Nothing in this build can submit to the runner the run was dispatched to. */
  | 'runner-unavailable'
  /** The spend gate refused. Carries `QueueReason`'s own vocabulary in the text. */
  | 'spend-refused'
  /**
   * The runner's own ceiling refused the re-invocation.
   *
   * The park is restored rather than failed, and this is the one refusal that
   * is expected to clear itself: the next tick re-plans the park from the
   * block event and tries again with fresh jitter.
   */
  | 'runner-at-capacity';

export type ResumeResult =
  | {
      outcome: 'resumed';
      runId: string;
      runnerKey: string;
      /** The `RunAttempt.number` this resume opened. */
      attempt: number;
      reason: string;
    }
  | { outcome: 'refused'; refusal: ResumeRefusal; reason: string }
  /** `dispatch.enabled` is off. The whole decision ran; nothing was invoked. */
  | { outcome: 'observed'; reason: string }
  | { outcome: 'failed'; runId: string; reason: string };

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
        // The FIRST invocation, as a row (#477). Denormalized onto the run in
        // the same breath, which is what the column's own schema comment says
        // it is for: "1 on dispatch, incremented by each auto-resume". It was
        // 0 on every run in the database until now, because nothing ever wrote
        // either side of that sentence.
        attemptCount: 1,
        attempts: { create: { number: 1, outcome: 'running' } },
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
  // Resume (#477, and the criterion #66 closed without meeting)
  // -------------------------------------------------------------------------

  /**
   * Re-invoke the runner for a run that was parked on a rate limit.
   *
   * ## What #66 left, and why the trail read as finished
   *
   * #66 closed on 2026-08-23 with *"auto-resume works end to end without human
   * involvement"* unmet. `decideParking` computed a `resume` decision,
   * `actionsForParking` turned it into a `resume` ACTION, and nothing anywhere
   * consumed one — while three comments pointed forward at #66 and #61 as
   * though the wiring were still coming. Both issues were closed. This method
   * is the consumer, and those comments now point here.
   *
   * The operational cost of the gap was not subtle: a run that hits a usage
   * limit at 2pm is VISION §1's second origin story, and it also holds its
   * runner's concurrency slot for the whole park —
   * {@link OCCUPYING_STATUSES} counts `blocked` deliberately, on the stated
   * grounds that *"the bound on the cost is auto-resume"*. Until this method
   * existed, that bound did not.
   *
   * ## The same work order, and not a new attempt
   *
   * The run row is REUSED. Nothing here creates a `Run`, and nothing touches
   * `WorkOrder.attempt`:
   *
   *  - A new `Run` would double-count the concurrency slot the parked run
   *    never gave up, and would present in the cockpit as a silent second run
   *    of the same work order.
   *  - `WorkOrder.attempt` is the RETRY counter behind VISION §10's metric 4,
   *    and #66 is explicit that a park is not a failure. Counting a park would
   *    make the number that reads decomposition quality report quota weather
   *    instead. The projection already refuses to spend an attempt on a parked
   *    run (`desired-state.ts`, the `blocked` branch, which returns before the
   *    ceiling is consulted); this is the other half of that promise, on the
   *    write side.
   *
   * What IS recorded is a `RunAttempt` — see {@link openResumedAttempt} for
   * why that model stops being an empty table here rather than being deleted.
   *
   * ## Every gate, re-checked
   *
   * A resume that skipped admission would be a hole around every control the
   * first dispatch honoured, and the hole would be invisible: the run was
   * authorized once, hours ago, and everything below can have changed since.
   * In order, each named where it is checked:
   *
   *  1. `dispatch.autoResumeParked` — this behaviour's own switch (#477).
   *  2. The run is still parked — a guarded write, which is also the lock.
   *  3. The work order is still `dispatched` — catches quarantine, cancel and
   *     supersession. A `factory:hold` is checked by the CALLER, because it
   *     lives on the issue rather than on this row; see `ResumeExecutor`.
   *  4. `Repository.dispatchEnabled`, exactly as `DispatchQueueService` checks
   *     it for a first dispatch, and the repository's own per-run budget
   *     ceiling — which the projection cannot check for a parked run, because
   *     the `blocked` intent returns before the branch that would.
   *  5. The stored row still rebuilds into the document that was authorized
   *     (#154) — the resume runs the authorized thing or nothing.
   *  6. The hard spend ceiling and the work order's own budget, through the
   *     same `decideSpendAdmission` the first dispatch went through (#65).
   *  7. `dispatch.enabled`, which reports what it WOULD have resumed.
   *  8. The runner's own concurrency ceiling, enforced inside `submit`.
   *
   * ## The concurrency slot, stated precisely
   *
   * There are two of them and they behave differently, which is why "frees and
   * re-takes its slot" needs saying rather than assuming:
   *
   *  - **The database slot** (`OCCUPYING_STATUSES`) is never freed. `blocked`
   *    occupies, `running` occupies, and the run moves between them without
   *    ever leaving the count. That is the point: freeing it would
   *    over-subscribe the runner the moment the run came back, which
   *    `dispatch.service.ts` calls the worse failure. So the resume must not
   *    re-take it either, and it does not — no second row is created, and
   *    `dispatch.maxConcurrent` is deliberately NOT re-evaluated here, because
   *    a run already inside the ceiling would otherwise be refused re-entry to
   *    a slot it is still holding.
   *  - **The runner's process slot** WAS freed: the CLI exited when it hit the
   *    limit. `submit` re-takes it, under the runner's own declared ceiling,
   *    and refuses with `RunnerAtCapacityError` if the fleet filled up while
   *    this run was parked. That refusal restores the park rather than failing
   *    the run.
   *
   * Never throws. It runs from the reconciler tick, alongside every other
   * outward step, and one parked run must not abandon the ones behind it.
   */
  async resumeParkedRun(runId: string): Promise<ResumeResult> {
    // FIRST, before a single query. An operator who has turned this off is
    // owed a system that stops asking the database whether it may spend.
    if (!this.settings.get('dispatch.autoResumeParked')) {
      return {
        outcome: 'refused',
        refusal: 'auto-resume-disabled',
        reason:
          `Auto-resume is disabled, so run ${runId} stays parked until a human acts. ` +
          'Its runner slot stays occupied while it waits (#477).',
      };
    }

    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: RESUME_SELECT,
    });

    if (!run || run.status !== 'blocked') {
      return {
        outcome: 'refused',
        refusal: 'not-parked',
        reason: `Run ${runId} is ${run ? run.status : 'gone'} and no longer parked`,
      };
    }

    const identity = run.workOrder.identity;

    // `dispatched` and nothing else. `held` means a human applied
    // `factory:hold` before the work order was ever dispatched, `quarantined`
    // means VISION §8 has taken it out of the factory's hands, and `cancelled`
    // and `superseded` both mean this document is no longer the live one.
    if (run.workOrder.status !== 'dispatched') {
      return {
        outcome: 'refused',
        refusal: 'held-or-not-dispatched',
        reason: `${identity} is ${run.workOrder.status}, not dispatched, so its run is not resumed`,
      };
    }

    const repository = run.workOrder.repository;
    if (!repository.dispatchEnabled) {
      return {
        outcome: 'refused',
        refusal: 'repository-dispatch-disabled',
        reason:
          `${identity} is not resumed: dispatch is disabled for ` +
          `${repository.owner}/${repository.name}`,
      };
    }

    // The repository's per-run ceiling, re-applied. The projection applies
    // this same comparison (`desired-state.ts`, the READY branch) and a parked
    // run never reaches it — the `blocked` intent returns two branches
    // earlier, deliberately, so that waiting out a quota cannot consume an
    // attempt. That is right for the attempt counter and it means the ceiling
    // is not checked for us here, so it is checked here.
    //
    // `>=` and the same direction as the projection: at the ceiling is at the
    // ceiling. A null cost is NOT treated as zero (VISION §6) — an unmeasured
    // run cannot be shown to have passed a limit, and refusing on that basis
    // would stop every run on a runner that does not report cost.
    const repositoryCeiling = repository.budgetCeilingUsd?.toNumber() ?? null;
    const spentSoFar = run.costUsd?.toNumber() ?? null;
    if (
      repositoryCeiling !== null &&
      spentSoFar !== null &&
      spentSoFar >= repositoryCeiling
    ) {
      const reason =
        `${identity} is not resumed: it has spent ${spentSoFar}, which has reached the ` +
        `${repository.owner}/${repository.name} ceiling of ${repositoryCeiling}`;
      this.logger.warn(reason);
      return {
        outcome: 'refused',
        refusal: 'repository-budget-reached',
        reason,
      };
    }

    let workOrder: GeneratedWorkOrder;
    try {
      workOrder = rehydrateWorkOrder(run.workOrder);
    } catch (error) {
      if (!(error instanceof RehydrationError)) throw error;
      // NOT quarantined from here. `DispatchQueueService` quarantines an
      // unrebuildable row because it is about to hand it to a runner for the
      // first time; this row was already dispatched and already has an
      // authorization record posted for it, so flipping it to `quarantined`
      // would make that record describe something no longer true — the same
      // rule `HOLDABLE_STATUSES` encodes. It is reported and left parked,
      // where the undated-block escalation will eventually surface it.
      this.logger.error(
        `${identity} cannot be rebuilt from its stored row, so its parked run cannot be ` +
          `resumed: ${error.message}`,
      );
      return {
        outcome: 'refused',
        refusal: 'work-order-unrebuildable',
        reason: error.message,
      };
    }

    const runner = this.runnerFor(run.runnerKey);
    if (!runner) {
      return {
        outcome: 'refused',
        refusal: 'runner-unavailable',
        reason:
          `Run ${runId} was dispatched to ${run.runnerKey}, which this build has no ` +
          'implementation for, so it cannot be resumed',
      };
    }

    const capabilities = await runner.capabilities();

    // The same gate, the same function, the same inputs as a first dispatch
    // (#65). Deliberately re-run rather than trusted from the original
    // admission: the ceiling may have been lowered, the window may have
    // rolled, and the fleet has spent money since.
    //
    // The order's own ceiling is passed WHOLE rather than reduced by what this
    // run has already spent. That over-states the remaining exposure, which is
    // the correct direction for a hard ceiling — `decideSpendAdmission` reasons
    // about the worst case on purpose — and the money already spent is not
    // double-counted, because the ledger tally below is a fact about the
    // window and already includes it.
    const spend = decideSpendAdmission(
      this.ceiling.value,
      await this.ledger.tally(this.ceiling.value.windowDays),
      {
        ceilingUsd: workOrder.budgetCeilingUsd,
        runnerReportsCost: capabilities.reportsCost,
      },
    );

    if (!spend.admit) {
      this.logger.warn(`${identity} not resumed — ${spend.reason}`);
      return {
        outcome: 'refused',
        refusal: 'spend-refused',
        reason: spend.reason,
      };
    }

    if (!this.enabled) {
      const reason =
        `DISPATCH DISABLED — would have resumed ${identity} on ` +
        `${run.runnerKey}@${capabilities.version}, whose park expired at ` +
        `${run.resumesAt?.toISOString() ?? 'an unrecorded time'}.`;
      this.logger.warn(reason);
      return { outcome: 'observed', reason };
    }

    // THE CLAIM, and the lock. Guarded on `blocked` so two overlapping ticks
    // cannot both resume one run: the second finds nothing to update, and
    // `loadBlockedRuns` cannot see the row again once it says `running`.
    //
    // Written BEFORE `submit` for the same reason `dispatchWorkOrder` creates
    // the run before submitting: events start arriving the moment the process
    // does, and they must not land on a row still claiming to be parked.
    // `resumesAt` is cleared in the same statement because it IS the park —
    // see `blocked-parking.ts` for why that column has one meaning and one
    // writer.
    const attempt = Math.max(run.attemptCount, 1) + 1;
    const claimed = await this.prisma.run.updateMany({
      where: { id: runId, status: 'blocked' },
      data: { status: 'running', resumesAt: null, attemptCount: attempt },
    });

    if (claimed.count === 0) {
      return {
        outcome: 'refused',
        refusal: 'not-parked',
        reason: `Run ${runId} stopped being parked while its resume was being admitted`,
      };
    }

    try {
      const handle = await runner.submit(toSpec(workOrder, runId));
      // NOT `records.write`. The authorization and execution records were
      // written when this work order was first dispatched (#63) and are
      // idempotent per identity, so calling it again would be a no-op that
      // still spent GitHub reads — and VISION §11 holds that budget back for
      // the operator. The branch the workspace clones already carries the
      // execution record's commit.
      await this.openResumedAttempt(run, attempt, handle.externalId);
      this.poller.track(runId, runner, handle);

      const reason =
        `Resumed ${identity} on ${run.runnerKey} as attempt ${attempt}; it was parked on ` +
        `'${run.events[0]?.blockedReason ?? 'an unreported reason'}' since ` +
        `${run.events[0]?.occurredAt.toISOString() ?? 'an unrecorded time'}`;
      this.logger.log(reason);

      return {
        outcome: 'resumed',
        runId,
        runnerKey: run.runnerKey,
        attempt,
        reason,
      };
    } catch (error) {
      return this.recoverResume(
        runId,
        identity,
        attempt,
        run.attemptCount,
        error,
      );
    }
  }

  /**
   * The resume failed after the run was claimed. Put it back, or fail it.
   *
   * Deliberately NOT {@link recover}: that one DELETES the run row on a
   * capacity refusal, on the reasoning that a run which never started is not a
   * run. That reasoning does not survive here — this run started hours ago,
   * has events, cost and possibly commits behind it, and deleting the row
   * would cascade every one of them away to record a re-invocation that did
   * not happen.
   */
  private async recoverResume(
    runId: string,
    identity: string,
    attempt: number,
    previousAttemptCount: number,
    error: unknown,
  ): Promise<ResumeResult> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof RunnerAtCapacityError) {
      // Back to parked, with `resumesAt` left null on purpose. The next
      // watchdog tick re-plans the park from the block event's reset time and
      // draws FRESH jitter, which is exactly the spread wanted when a fleet
      // full of runs is all trying to come back at once — a fixed retry delay
      // here would re-synchronise them.
      await this.prisma.run.updateMany({
        where: { id: runId, status: 'running' },
        data: { status: 'blocked', attemptCount: previousAttemptCount },
      });
      this.logger.warn(`${identity} stays parked: ${message}`);
      return {
        outcome: 'refused',
        refusal: 'runner-at-capacity',
        reason: message,
      };
    }

    await this.prisma.run.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'failed', endedAt: new Date(), attentionReason: message },
    });

    this.logger.error(
      `${identity} failed while being resumed as attempt ${attempt}: ${message}`,
    );
    return { outcome: 'failed', runId, reason: message };
  }

  /**
   * Close the attempt that was parked, and open the one that replaces it.
   *
   * ## Why `RunAttempt` starts being written here rather than being dropped
   *
   * The model was declared with the schema and never read or written by a line
   * of TypeScript — an empty table with a convincing doc comment, which is
   * worse than no table at all: #476 needed *"the run blocked here and resumed
   * there"*, found this, and had to fall back to an approximation derived from
   * `Run.lastEventAt` because joining onto an empty table reports "never
   * resumed" for everything. Leaving it empty after adding resume would set
   * exactly that trap for the next person.
   *
   * Writing it is also what makes this issue's hardest criterion CHECKABLE
   * rather than merely asserted. "A resume does not count as an attempt" is a
   * claim about two different counters: `WorkOrder.attempt` (the retry counter
   * behind metric 4, untouched here) and the invocation count (recorded here).
   * With both written, neither has to be inferred from the other.
   *
   * ## The lifecycle, and who writes each transition
   *
   * An attempt row is written by whoever writes the corresponding `Run.status`
   * transition, so the two can never disagree:
   *
   *  - `dispatchWorkOrder` opens attempt 1, nested in the same statement that
   *    creates the run.
   *  - This closes the parked attempt as `blocked` and opens the next.
   *  - `RunEventsService.concludeRun` closes whichever attempt is open when a
   *    terminal event arrives.
   *
   * A BLOCK does not close an attempt, which is the one that looks wrong and
   * is not. `RunAttemptOutcome.blocked` means *"parked; a later attempt
   * resumes it"* — a statement that the invocation ENDED. A run can park while
   * its process is still alive (the CLI reports a `rate_limit_event` and may
   * keep going), so closing on the block would record an ending that had not
   * happened. The resume is the proof that it did, which is why the close
   * happens here, dated at the resume rather than at the park.
   *
   * ## The gap a pre-existing run leaves, on purpose
   *
   * A run dispatched before this shipped has `attemptCount = 0` and no attempt
   * rows. Its first resume opens number 2, leaving no number 1 — an honest gap
   * saying "attempt 1 was never recorded" rather than a fabricated row
   * claiming a start time nobody observed.
   */
  private async openResumedAttempt(
    run: ParkedRunRow,
    attempt: number,
    runnerRunId: string,
  ): Promise<void> {
    const block = run.events[0];
    const resumedAt = new Date();

    // `updateMany` over every open attempt rather than a targeted update: a
    // run with two open rows is a bug somewhere upstream, and leaving one of
    // them open forever would hide it behind a table that merely looks
    // populated.
    await this.prisma.runAttempt.updateMany({
      where: { runId: run.id, outcome: 'running' },
      data: {
        outcome: 'blocked',
        endedAt: resumedAt,
        stopReason:
          `parked on '${block?.blockedReason ?? 'an unreported reason'}'` +
          (block?.blockedUntil
            ? ` until ${block.blockedUntil.toISOString()}`
            : ' with no reset time'),
        blockedUntil: block?.blockedUntil ?? null,
      },
    });

    await this.prisma.runAttempt.create({
      data: {
        runId: run.id,
        number: attempt,
        outcome: 'running',
        startedAt: resumedAt,
        runnerRunId,
      },
    });
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
 * Everything a resume needs about a parked run, in one query.
 *
 * The work-order half is exactly `StoredWorkOrder`'s columns plus `status`, so
 * `rehydrateWorkOrder` type-checks against it: a column dropped from this
 * select is a compile error rather than a work order silently rebuilt without
 * a field it was authorized with. `DispatchQueueService.WORK_ORDER_SELECT`
 * makes the same argument for the first dispatch.
 *
 * The newest `run_blocked` event comes along for the ride because the resume
 * has to be able to SAY what the run was parked on, and because the vendor's
 * raw reset time lives there — see `blocked-parking.ts` on why that is the
 * event row's fact rather than the run's.
 */
const RESUME_SELECT = {
  id: true,
  status: true,
  runnerKey: true,
  attemptCount: true,
  resumesAt: true,
  costUsd: true,
  events: {
    where: { type: 'run_blocked' },
    orderBy: { occurredAt: 'desc' },
    take: 1,
    select: { occurredAt: true, blockedReason: true, blockedUntil: true },
  },
  workOrder: {
    select: {
      id: true,
      status: true,
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
      repository: {
        select: {
          owner: true,
          name: true,
          dispatchEnabled: true,
          budgetCeilingUsd: true,
        },
      },
    },
  },
} as const;

/**
 * The parts of that row {@link RunExecutorService.openResumedAttempt} reads.
 *
 * Structural rather than `Prisma.RunGetPayload<...>`: the attempt writer needs
 * an id and the block it is closing, and naming only those keeps it callable
 * from a test with a two-field object instead of a whole generated payload.
 */
interface ParkedRunRow {
  id: string;
  events: {
    occurredAt: Date;
    blockedReason: string | null;
    blockedUntil: Date | null;
  }[];
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
