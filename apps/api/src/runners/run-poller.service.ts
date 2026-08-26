import { Injectable, Logger } from '@nestjs/common';

import { decideBudgetOverrun } from '../budget/budget-overrun';
// The grace default now lives in the operator settings registry, which
// `operator-settings.parity.spec.ts` pins to `DEFAULT_DEADLINE_GRACE_MINUTES`
// so the two cannot drift apart.
import { decideDeadline } from '../budget/run-deadline';
import { toNumberOrNull } from '../common/decimal';
import { EscalationsService } from '../escalations/escalations.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaService } from '../quota/quota.service';
import { RunEventsService } from '../run-events/run-events.service';
import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import { SILENCE_THRESHOLDS_MS } from '../watchdog/silent-detection';
import type { RunHandle, Runner } from './runner.types';

/**
 * Carries a runner's events into the control plane.
 *
 * ## The gap this closes
 *
 * `Runner.poll()` drains events into memory and returns them, and until now
 * nothing called it. Everything downstream was therefore watching an empty
 * stream:
 *
 * - loop detection (#55) compares tool signatures it never received
 * - the silent-run watchdog (#54) measures age from a `lastEventAt` that never
 *   moved, so every run looked silent from the moment it started — the
 *   watchdog's own failure mode
 * - a run was never recorded as finished, because the terminal event stayed in
 *   the runner's memory until the process restarted
 *
 * Ingestion (#53) already existed and is idempotent on `(runId, eventId)`, so
 * this is deliberately a dumb pump: poll, hand over, repeat. The runner is
 * explicit that re-returning an already-delivered event is safe and expected,
 * which is what lets this be dumb without being lossy.
 *
 * ## Handles are NOT persisted, and that is the decision
 *
 * #147 asks for this to be settled rather than discovered: either persist the
 * handle so a run survives an API restart, or accept that `poll` returns
 * `unknown` and let that drive recovery.
 *
 * **We accept `unknown`.** Persisting a handle in order to re-attach to a
 * still-running child is session resumption by another name, and VISION §3.4
 * is unambiguous that recovery is abandon-and-re-run from the pinned base —
 * *that* is what keeps cross-agent session state from ever having to exist.
 * There is a mechanical reason too: `RunHandle.externalId` is opaque by
 * contract, and for `claude-code-local` the thing that would have to be
 * rebuilt is a live `SupervisedProcess` holding the child's stdout pipe. That
 * pipe is gone once the API restarts. A persisted handle would name a run
 * nothing could actually read.
 *
 * So a lost handle is reported honestly: the run is marked `stalled` with a
 * reason saying so, which is exactly the state #66's retry policy is built to
 * act on. The detached child may still be running — git-derived liveness (#52)
 * is the second source that covers precisely that window, and VISION §9 wants
 * two independent liveness sources for exactly this reason.
 */

/** Statuses worth polling. A finished run has nothing left to report. */
const LIVE_STATUSES = ['running', 'stalled', 'blocked'] as const;

/**
 * How often to poll, in milliseconds.
 *
 * ## Why this number and not a rounder one
 *
 * #147 requires the poll interval and #54's silence thresholds be consistent,
 * and the tightest threshold is what binds: a `full`-streaming runner is
 * declared silent after {@link SILENCE_THRESHOLDS_MS.full}. Poll less often
 * than that and every healthy run is declared silent, because its
 * `lastEventAt` simply has not been updated yet — the watchdog would be
 * measuring OUR latency rather than the runner's.
 *
 * Fifteen seconds gives six polls inside the tightest window, so a run has to
 * miss several in a row before silence detection even begins to consider it.
 * A test pins the relationship rather than trusting this comment.
 */
export const POLL_INTERVAL_MS = 15_000;

/** How many runs one tick will poll. Bounds a tick's cost, not the fleet. */
export const POLL_BATCH_SIZE = 50;

interface TrackedRun {
  runner: Runner;
  handle: RunHandle;
}

export interface PollTickResult {
  polled: number;
  eventsIngested: number;
  duplicates: number;
  /** Runs whose handle this process no longer holds. */
  lost: number;
  failed: number;
  /** Runs cancelled for passing their wall-clock ceiling (#180). */
  timedOut: number;
  /** Runs found to have passed their work order's budget ceiling (#182). */
  overBudget: number;
  /** Vendor quota windows recorded from what runners reported (#231). */
  quotaWindows: number;
}

@Injectable()
export class RunPollerService {
  private readonly logger = new Logger(RunPollerService.name);
  /** runId → the handle needed to poll it. Deliberately in memory only. */
  private readonly tracked = new Map<string, TrackedRun>();

  /**
   * Runs this process has already cancelled for their deadline.
   *
   * In memory, like `tracked`, and for the same reason: it is a fact about
   * what THIS process has done, not about the run. A restart re-deriving the
   * decision from `startedAt` and cancelling once more is harmless and
   * arguably correct -- the run is, after all, still over its ceiling.
   */
  private readonly deadlineEnforced = new Set<string>();

  /** Runs this process has already acted on for their budget (#182). */
  private readonly budgetEnforced = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly runEvents: RunEventsService,
    private readonly settings: OperatorSettingsService,
    private readonly escalations: EscalationsService,
    private readonly quota: QuotaService,
  ) {}

  /**
   * Start polling a run.
   *
   * Called by whatever submitted the work — the handle exists only there, and
   * the seam has no way to enumerate a runner's live runs (adding one would be
   * a fifth function, which #60 forbids without an ADR).
   */
  track(runId: string, runner: Runner, handle: RunHandle): void {
    this.tracked.set(runId, { runner, handle });
  }

  /** Stop polling. Safe for a run that was never tracked. */
  forget(runId: string): void {
    this.tracked.delete(runId);
    // Dropped together. Leaving the marker behind would grow without bound
    // across a long-lived process, and it has nothing left to guard once the
    // run is no longer tracked.
    this.deadlineEnforced.delete(runId);
    this.budgetEnforced.delete(runId);
  }

  /** How many runs this process can currently poll. */
  trackedCount(): number {
    return this.tracked.size;
  }

  /**
   * One pass: drain every tracked run, then account for the ones we cannot.
   *
   * Never throws. This runs on a tick, and a poller that dies on one bad run
   * stops carrying events for every other run — which would present as the
   * whole fleet going silent at once, the single most alarming and least
   * accurate thing this system could report.
   */
  async tick(): Promise<PollTickResult> {
    const result: PollTickResult = {
      polled: 0,
      eventsIngested: 0,
      duplicates: 0,
      lost: 0,
      failed: 0,
      timedOut: 0,
      overBudget: 0,
      quotaWindows: 0,
    };

    // BEFORE polling, not after. A run that is already past its ceiling
    // should be cancelled on the tick that notices, not on the one after --
    // and polling it first would spend a round trip on a run we are about to
    // stop anyway.
    try {
      await this.enforceDeadlines(result);
    } catch (error) {
      result.failed += 1;
      this.logger.error(
        `Could not enforce wall-clock deadlines this tick: ${asMessage(error)}`,
      );
    }

    for (const [runId, entry] of [...this.tracked].slice(0, POLL_BATCH_SIZE)) {
      try {
        await this.pollOne(runId, entry, result);
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Polling run ${runId} failed; its events will be re-requested next tick: ` +
            `${asMessage(error)}`,
        );
      }
    }

    // Guarded for the same reason the per-run loop is: this pass is about
    // runs nothing is watching, and a database blip in it must not discard
    // the events already polled above. Failing loudly here would also make a
    // transient outage look like the fleet going silent.
    try {
      await this.reconcileUntracked(result);
    } catch (error) {
      result.failed += 1;
      this.logger.error(
        `Could not check for runs with no handle; they stay unreported this tick: ` +
          `${asMessage(error)}`,
      );
    }

    return result;
  }

  // -------------------------------------------------------------------------

  private async pollOne(
    runId: string,
    entry: TrackedRun,
    result: PollTickResult,
  ): Promise<void> {
    const poll = await entry.runner.poll(entry.handle);
    result.polled += 1;

    // Before the `unknown` check and before ingestion, for the same reason
    // ingestion itself is: a runner that lost the run may still have handed
    // back what it saw on the way out. A window sighting is a fact about the
    // SUBSCRIPTION rather than about this run, so it stays true even when the
    // run it arrived with is gone. Never throws, by contract (#231), so it
    // needs no guard of its own.
    if (poll.quota && poll.quota.length > 0) {
      result.quotaWindows += await this.quota.record(poll.quota);
    }

    // Ingest BEFORE acting on `unknown`. A runner that lost the run may still
    // have handed back its final events on the way out, and throwing those
    // away would lose the only record of how the run ended.
    if (poll.events.length > 0) {
      const ingested = await this.runEvents.ingest(runId, poll.events);
      result.eventsIngested += ingested.accepted;
      result.duplicates += ingested.duplicates;

      // Checked HERE, immediately after ingestion, because this is the one
      // moment when everything needed is true at once: the roll-up (#183) has
      // just written the run's cost, ingestion has just written its terminal
      // status if it ended, and the run is still in `tracked` -- so if it can
      // be stopped, the handle to stop it with is still in hand. A tick later
      // it would have been forgotten.
      //
      // Guarded separately: a budget check that throws must not lose the
      // events already ingested above, nor stop the poller reaching the rest
      // of the fleet.
      try {
        await this.enforceBudget(runId, poll.status === 'running', result);
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Could not check run ${runId} against its budget: ${asMessage(error)}`,
        );
      }
    }

    if (poll.status === 'unknown') {
      result.lost += 1;
      this.forget(runId);
      await this.markLost(runId);
      return;
    }

    // Terminal: stop polling, but leave the status to ingestion. The events
    // are the record of what happened; a second writer deciding the same fact
    // from a different input is how two sources of truth appear.
    if (poll.status === 'succeeded' || poll.status === 'failed') {
      this.forget(runId);
    }
  }

  /**
   * Act on a work order's budget ceiling once its run has passed it (#182).
   *
   * ## Two arms, and only one of them fires today
   *
   * A run that is STILL LIVE is cancelled through the seam. A run that has
   * already FINISHED cannot be — so it is recorded and escalated instead, and
   * the record says which of the two happened rather than implying the
   * stronger one.
   *
   * With the current fleet only the second arm can fire. `claude-code-local`
   * reports cost once, on its final `result` line: the per-message `usage` is
   * a streaming snapshot rather than a running total, and summing it produces
   * a number that is simply wrong. So its dollar figure never arrives while
   * there is still something to stop.
   *
   * The first arm is not therefore dead code — it is the seam's contract held
   * up for any runner that reports incrementally, exactly as the wall-clock
   * sweep (#180) is. What would be wrong is shipping only the first arm and
   * calling the budget enforced: from outside it would look identical to a
   * working ceiling while never once firing.
   *
   * ## Escalated, not just logged
   *
   * `budget_exceeded` has been in `EscalationKind` since the schema was
   * written and nothing has ever raised it. An operator who learns a $5
   * ceiling was passed by $35 can stop it being a habit; one who finds out
   * from a monthly bill cannot. `raiseFrom` dedupes per `(run, kind)`, so a
   * re-check on a later tick cannot page twice for the same overrun.
   */
  private async enforceBudget(
    runId: string,
    runIsLive: boolean,
    result: PollTickResult,
  ): Promise<void> {
    if (this.budgetEnforced.has(runId)) return;

    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: {
        costUsd: true,
        workOrder: { select: { identity: true, budgetCeilingUsd: true } },
      },
    });
    if (!run) return;

    const verdict = decideBudgetOverrun({
      costUsd: toNumberOrNull(run.costUsd),
      ceilingUsd: toNumberOrNull(run.workOrder?.budgetCeilingUsd ?? null),
      runIsLive,
    });

    if (!verdict.over) return;

    this.budgetEnforced.add(runId);
    result.overBudget += 1;

    const identity = run.workOrder?.identity ?? runId;

    // The certain part first, for the reason the deadline sweep writes twice:
    // a cancel that throws still leaves a run that has provably passed its
    // ceiling and an operator who needs to know by how much.
    await this.record(runId, verdict.reason);

    const outcome = verdict.stoppable
      ? await this.stopForBudget(runId, identity, verdict.reason)
      : `${verdict.reason} The run had already finished, so nothing could be stopped.`;

    await this.record(runId, outcome);
    await this.escalations.raiseFrom([
      {
        type: 'escalate',
        runId,
        escalationKind: 'budget_exceeded',
        reason: outcome,
        detectionSource: 'control-plane',
      } as unknown as Parameters<EscalationsService['raiseFrom']>[0][number],
    ]);

    this.logger.warn(`${identity}: ${outcome}`);
  }

  /** Cancel through the seam, and say honestly whether it worked. */
  private async stopForBudget(
    runId: string,
    identity: string,
    reason: string,
  ): Promise<string> {
    const entry = this.tracked.get(runId);
    if (!entry) {
      return `${reason} No runner handle in this process, so nothing could stop it.`;
    }

    try {
      await entry.runner.cancel(entry.handle);
      return `${reason} The control plane cancelled it.`;
    } catch (error) {
      this.logger.error(`${identity}: refused cancel after passing its budget`);
      return (
        `${reason} The control plane tried to cancel it and the runner refused, so it may ` +
        `STILL BE RUNNING and still spending: ${asMessage(error)}`
      );
    }
  }

  /**
   * Cancel every tracked run that has passed its wall-clock ceiling (#180).
   *
   * Only TRACKED runs, and that limit is honest rather than incidental: to
   * cancel a run the control plane needs its handle, and #60 forbids reaching
   * inside a `RunHandle` to reconstruct one. A run whose handle this process
   * lost is already reported by `reconcileUntracked` as stalled with nobody
   * watching it -- which is true. Claiming to have cancelled it would be the
   * synthesized-event-as-report VISION §9 forbids, so this pass does not try.
   *
   * Reaping genuinely orphaned process groups after a restart needs a durable
   * handle the control plane may act on, and is a separate problem.
   */
  private async enforceDeadlines(result: PollTickResult): Promise<void> {
    const candidates = [...this.tracked.keys()].filter(
      (runId) => !this.deadlineEnforced.has(runId),
    );
    if (candidates.length === 0) return;

    const runs = await this.prisma.run.findMany({
      where: {
        id: { in: candidates },
        status: { in: LIVE_STATUSES as unknown as never },
      },
      select: {
        id: true,
        startedAt: true,
        workOrder: {
          select: { identity: true, wallClockTimeoutMinutes: true },
        },
      },
    });

    const now = new Date();
    // Re-read every sweep, which is what lets a lowered ceiling still cancel
    // a run that is already over it — see the registry's note on this key.
    const defaultTimeoutMinutes = this.settings.get(
      'runners.claudeCodeLocal.defaultTimeoutMinutes',
    );
    const graceMinutes = this.settings.get('runners.deadlineGraceMinutes');

    for (const run of runs) {
      const verdict = decideDeadline(
        {
          startedAt: run.startedAt,
          timeoutMinutes: run.workOrder?.wallClockTimeoutMinutes ?? null,
          defaultTimeoutMinutes,
          graceMinutes,
        },
        now,
      );

      if (!verdict.overdue) continue;

      result.timedOut += 1;
      await this.cancelForDeadline(
        run.id,
        run.workOrder?.identity ?? run.id,
        verdict.reason,
      );
    }
  }

  /**
   * Cancel through the seam, record what is true, and never try twice.
   *
   * ## Why the reason is written twice
   *
   * Because two different things are true at two different moments, and
   * writing one sentence for both would make the first one a claim nobody had
   * earned yet.
   *
   * `decideDeadline` returns only what is CERTAIN before anything is
   * attempted: the run passed its ceiling and its runner did not stop it. That
   * is written first, so a `cancel` that throws -- or a process that dies
   * mid-pass -- still leaves an operator the reason. Whether the control plane
   * then actually stopped it is a separate fact, appended once it IS a fact.
   *
   * The alternative, writing "the control plane cancelled it" up front, was
   * what this code did until a probe against real rows printed that sentence
   * for three runs the control plane could not cancel at all. VISION §9: a
   * synthesized event must never masquerade as a report.
   */
  private async cancelForDeadline(
    runId: string,
    identity: string,
    reason: string,
  ): Promise<void> {
    // Marked before the attempt, so a `cancel` that throws does not put this
    // run back in the queue for another cancel fifteen seconds later, and the
    // one after that. One enforcement per run per process; a failure to stop
    // it is an escalation, not something to retry in a loop.
    this.deadlineEnforced.add(runId);

    await this.record(runId, reason);

    const entry = this.tracked.get(runId);
    if (!entry) return;

    try {
      await entry.runner.cancel(entry.handle);
      await this.record(runId, `${reason} The control plane cancelled it.`);
      this.logger.warn(
        `${identity}: ${reason} The control plane cancelled it.`,
      );
    } catch (error) {
      // Not rethrown: one runner refusing to cancel must not stop the pass
      // from reaching the next overdue run. And the recorded reason says it
      // MAY still be running rather than that it was stopped -- which is the
      // accurate report, and the one an operator has to act on.
      const outcome =
        `${reason} The control plane tried to cancel it and the runner refused, so it may ` +
        `STILL BE RUNNING: ${asMessage(error)}`;
      await this.record(runId, outcome);
      this.logger.error(`${identity}: ${outcome}`);
    }
  }

  /**
   * Write an `attentionReason`, guarded so a run that reached a terminal state
   * between the read and this write is not dragged back out of it.
   */
  private async record(runId: string, reason: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: LIVE_STATUSES as unknown as never } },
      data: { attentionReason: reason },
    });
  }

  /**
   * A run the database thinks is live and this process cannot poll.
   *
   * Almost always an API restart: the handles were in memory and the child was
   * detached, so the run may genuinely still be executing while nothing here
   * can see it. Marked `stalled` rather than `failed` because that is what it
   * is — VISION §9's three failure modes stay distinct only if the control
   * plane refuses to guess between them.
   *
   * The `attentionReason` is written because #66 and the cockpit both read it,
   * and "nobody is watching this run" is exactly the sentence an operator
   * needs rather than a status with no explanation.
   */
  private async reconcileUntracked(result: PollTickResult): Promise<void> {
    const live = await this.prisma.run.findMany({
      where: { status: { in: LIVE_STATUSES as unknown as never } },
      select: { id: true, status: true, attentionReason: true },
      take: POLL_BATCH_SIZE,
    });

    for (const run of live) {
      if (this.tracked.has(run.id)) continue;
      // Already reported. Rewriting the same reason every 15 seconds would
      // churn `updatedAt` and make the cockpit look like something is
      // happening when nothing is.
      if (
        run.status === 'stalled' &&
        run.attentionReason === LOST_HANDLE_REASON
      )
        continue;

      result.lost += 1;
      await this.markLost(run.id);
    }
  }

  private async markLost(runId: string): Promise<void> {
    await this.prisma.run.updateMany({
      // Guarded so a run that finished between the poll and this write is not
      // dragged back out of a terminal state.
      where: { id: runId, status: { in: LIVE_STATUSES as unknown as never } },
      data: { status: 'stalled', attentionReason: LOST_HANDLE_REASON },
    });

    this.logger.warn(
      `Run ${runId}: no runner handle in this process, so nothing is watching it. ` +
        'Marked stalled — recovery is abandon-and-re-run from the pinned base (VISION §3.4).',
    );
  }
}

/**
 * The exact sentence written to `attentionReason` for a lost handle.
 *
 * A constant because the reconcile pass compares against it to avoid rewriting
 * the same reason on every tick, and a drifting string would silently turn
 * that comparison into a no-op.
 */
export const LOST_HANDLE_REASON =
  'The runner handle was lost (most likely an API restart). Nothing is polling this run; ' +
  're-run it from its pinned base commit.';

/**
 * The invariant #147 asks to be written down, as executable arithmetic.
 *
 * Exported so a spec can assert it rather than a comment asserting it.
 */
export const POLLS_INSIDE_TIGHTEST_SILENCE_WINDOW =
  SILENCE_THRESHOLDS_MS.full / POLL_INTERVAL_MS;

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
