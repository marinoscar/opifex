import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DEFAULT_DEADLINE_GRACE_MINUTES,
  decideDeadline,
} from '../budget/run-deadline';
import { PrismaService } from '../prisma/prisma.service';
import { RunEventsService } from '../run-events/run-events.service';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly runEvents: RunEventsService,
    private readonly config: ConfigService,
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

    // Ingest BEFORE acting on `unknown`. A runner that lost the run may still
    // have handed back its final events on the way out, and throwing those
    // away would lose the only record of how the run ended.
    if (poll.events.length > 0) {
      const ingested = await this.runEvents.ingest(runId, poll.events);
      result.eventsIngested += ingested.accepted;
      result.duplicates += ingested.duplicates;
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
      where: { id: { in: candidates }, status: { in: LIVE_STATUSES as unknown as never } },
      select: {
        id: true,
        startedAt: true,
        workOrder: { select: { identity: true, wallClockTimeoutMinutes: true } },
      },
    });

    const now = new Date();
    const defaultTimeoutMinutes =
      this.config.get<number | null>('runners.claudeCodeLocal.defaultTimeoutMinutes') ?? null;
    const graceMinutes =
      this.config.get<number>('runners.deadlineGraceMinutes') ??
      DEFAULT_DEADLINE_GRACE_MINUTES;

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
      await this.cancelForDeadline(run.id, run.workOrder?.identity ?? run.id, verdict.reason);
    }
  }

  /**
   * Cancel through the seam, record the figure, and never try twice.
   *
   * The order matters. `attentionReason` is written FIRST, because a cancel
   * that throws still leaves a run that has provably passed its ceiling and an
   * operator who needs to know why -- writing the reason only on success would
   * lose exactly the case worth reporting.
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

    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: LIVE_STATUSES as unknown as never } },
      data: { attentionReason: reason },
    });

    const entry = this.tracked.get(runId);
    if (!entry) return;

    try {
      await entry.runner.cancel(entry.handle);
      this.logger.warn(`${identity}: ${reason}`);
    } catch (error) {
      // Not rethrown: one runner refusing to cancel must not stop the pass
      // from reaching the next overdue run. The reason is already recorded, so
      // the run is not silently over its ceiling -- it is loudly over it and
      // still going, which is the accurate report.
      this.logger.error(
        `${identity}: passed its wall-clock ceiling and the runner refused to cancel it, so ` +
          `it may STILL BE RUNNING: ${asMessage(error)}`,
      );
    }
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
      if (run.status === 'stalled' && run.attentionReason === LOST_HANDLE_REASON) continue;

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
