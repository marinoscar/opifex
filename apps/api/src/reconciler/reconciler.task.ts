import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { DeadTimeService } from '../dead-time/dead-time.service';
import { DispatchQueueService } from '../dispatch/dispatch-queue.service';
import { EscalationsService } from '../escalations/escalations.service';
import { GitHubWriteService } from '../github/write/github-write.service';
import { GitLivenessService } from '../liveness/git-liveness.service';
import { EscalationDispatcher } from '../notifications/escalation-dispatcher.service';
import {
  OperatorSettingsService,
  type OperatorSettingsChange,
} from '../settings/operator-settings/operator-settings.service';
import { tallyCoverage } from '../watchdog/check-coverage';
import {
  WatchdogService,
  type WatchdogSweepResult,
} from '../watchdog/watchdog.service';
import type { ReconcileAction } from './diff/actions.types';
import {
  fromMirrorLabels,
  fromResumes,
  fromSpecFeedback,
} from './execute/execution-failures';
import { MirrorLabelExecutor } from './execute/mirror-label.executor';
import { ResumeExecutor } from './execute/resume.executor';
import { SpecFeedbackExecutor } from './execute/spec-feedback.executor';
import { ReconcileLogService } from './log/reconcile-log.service';
import { ReconcilerService } from './reconciler.service';
import type { TickExecutionFailure, TickRecord } from './reconciler.types';
import { RepositoriesService } from '../repositories/repositories.service';

const INTERVAL_NAME = 'reconciler-tick';

/**
 * What this tick's acting phase has established so far (#320).
 *
 * Accumulated as a local of `runOnce` and threaded through the steps that can
 * act, rather than held on the instance: `setInterval` does not await, so two
 * `runOnce` calls can overlap when one runs long, and instance state would
 * cross-contaminate their records.
 *
 * `ran` is what separates a null `executionFailures` from an empty one, and it
 * is set only when an executor RETURNS. An executor that threw outright — a
 * bug, since both catch per-item — leaves it false, so the column stays null
 * rather than saying `[]`: null reads as "nothing acted", which an operator
 * can see is inconsistent with a non-zero `actionsExecuted`, whereas `[]`
 * would read as a clean bill of health nobody issued.
 */
interface ActingPhase {
  /** True once either executor has returned an outcome this tick. */
  ran: boolean;
  failures: TickExecutionFailure[];
}

/**
 * Drives {@link ReconcilerService.tick} on a schedule.
 *
 * ## Why a registered interval rather than `@Cron`
 *
 * The three existing tasks in this codebase (`auth/tasks`, `device-auth/tasks`,
 * `storage/tasks`) use `@Cron(CronExpression.EVERY_DAY_AT_4AM)` and are the
 * pattern #45 points at — but a decorator argument is evaluated at class
 * definition time, so the interval would be baked into the build. #45 requires
 * it be configurable without a code change, which means registering the
 * interval at runtime once the settings have been read.
 *
 * `SchedulerRegistry` is part of the `@nestjs/schedule` already wired at the
 * root, so this adds no dependency.
 *
 * ## Why the interval is registered even when the reconciler is off (#343)
 *
 * This method used to decide once, at boot, whether to call `setInterval` at
 * all, and argued for it: a disabled reconciler that still wakes every 60
 * seconds to decide it is disabled shows up in every profile and every log,
 * and invites the question of whether it is really off. That argument was
 * correct for exactly as long as enablement could only change at boot. In that
 * world "off" is fixed for the life of the process, and never registering the
 * interval is strictly better than registering one that immediately no-ops.
 *
 * `reconciler.enabled` is a live managed key now (ADR-0018 §5), and the
 * argument inverts. `onModuleInit` runs exactly once. An interval created only
 * there, conditioned on the value at that instant, has no way to come into
 * existence later — so a flip that turns the reconciler on has nothing to turn
 * on, silently, until somebody restarts. Worse, the interval's presence or
 * absence is then a SECOND copy of the enablement state, one that can disagree
 * with the first for as long as the process stays up. State in two places is
 * exactly what makes an operator unable to say which one is true, which is the
 * doubt the old comment set out to avoid — reached by the other road.
 *
 * So the interval is registered unconditionally and the check moves inside
 * {@link runOnce}, re-read on every firing. This is not a new shape for this
 * codebase: `supervisor.task.ts` registers its `@Cron` at class-definition
 * time and checks enablement in the handler, and `daily-brief.task.ts` and
 * `reconcile-log.cleanup.task.ts` do the same. Only the two `setInterval`
 * tasks ever took the other branch.
 *
 * The cost is real and is accepted rather than hidden: a deployment that never
 * turns the reconciler on now runs a no-op callback every `intervalMs`. The
 * skip logs at `debug` so it costs no attention, and the enablement state is
 * stated once in the boot line below — which answers the old comment's
 * objection without keeping a second copy of the state.
 *
 * ## Why a period change re-registers, and enablement does not
 *
 * `setInterval` fixes its period at the call that created it, so
 * `reconciler.intervalMs` — also a managed key — cannot be honoured by a
 * check inside the callback the way enablement can. It is the one key here
 * that has to reach back into `SchedulerRegistry`, and it does so by
 * subscribing to {@link OperatorSettingsService.onChange}. Enablement
 * deliberately does NOT: re-registering on a flag flip would put the two
 * copies of the enablement state back, which is the bug this file just closed.
 */
@Injectable()
export class ReconcilerTask implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcilerTask.name);

  constructor(
    private readonly settings: OperatorSettingsService,
    private readonly scheduler: SchedulerRegistry,
    private readonly reconciler: ReconcilerService,
    private readonly executor: MirrorLabelExecutor,
    private readonly specFeedback: SpecFeedbackExecutor,
    // The other outward executor the task holds (#477). On the same side of
    // the compute/act line as the two above: `WatchdogService` decides that a
    // parked run is due and `ReconcilerService` decides whether a human has
    // held its issue, and neither of them can act on either conclusion.
    private readonly resumes: ResumeExecutor,
    private readonly dispatchQueue: DispatchQueueService,
    private readonly repositories: RepositoriesService,
    private readonly liveness: GitLivenessService,
    private readonly watchdog: WatchdogService,
    private readonly deadTime: DeadTimeService,
    private readonly escalations: EscalationsService,
    private readonly dispatcher: EscalationDispatcher,
    // The two halves of #317's fix: the one place that knows how many writes
    // left the process, and the log row they have to be written back onto.
    private readonly writes: GitHubWriteService,
    private readonly log: ReconcileLogService,
  ) {}

  /**
   * The period the interval currently in the registry was created with.
   *
   * The only reason a copy of a managed value is held on the instance: it is
   * not the source of truth for the setting, it is a record of what was
   * actually handed to `setInterval`, which nothing else can report. It is
   * what makes a change detectable and, just as importantly, a NON-change
   * ignorable — see {@link applyIntervalPeriod}.
   */
  private registeredIntervalMs: number | undefined;

  /** Detaches the settings listener. Undefined before init, after destroy. */
  private unsubscribe: (() => void) | undefined;

  /**
   * The in-process mutex around the delete/add pair in
   * {@link applyIntervalPeriod}, and the coalescing flag that goes with it.
   *
   * The write path is HTTP-concurrent and `SchedulerRegistry.addInterval`
   * throws on a duplicate name, so a second re-registration that began between
   * this one's `deleteInterval` and its `addInterval` would either throw or
   * leave two live timers behind the one name. The critical section is
   * synchronous today, which on a single-threaded runtime is already atomic —
   * the flag is what keeps that true if a future edit introduces an `await`
   * into it, or if a listener ever re-enters the emitter.
   *
   * `pending` rather than a plain "already running, give up": dropping the
   * second change would leave the interval running at a period nobody asked
   * for, which is the same class of stale-copy bug this whole file is fixing.
   * The loop re-reads the current value on each pass, so N overlapping changes
   * collapse to at most one extra re-registration at the newest value.
   */
  private reregistering = false;
  private reregisterPending = false;

  onModuleInit(): void {
    // Unconditional. Whether the reconciler is enabled is decided in
    // `runOnce`, on every firing — see the class comment for why this is no
    // longer a boot-time decision.
    this.registerInterval(this.settings.get('reconciler.intervalMs'));

    // The period cannot be honoured by a check inside the callback, so it is
    // the one key here that listens. Subscribed AFTER the first registration,
    // so a change that lands during boot cannot re-register an interval that
    // does not exist yet.
    this.unsubscribe = this.settings.onChange((change) =>
      this.onSettingsChanged(change),
    );

    // The one place the enablement state of this loop is reported, which is
    // what lets the per-tick skip stay at `debug`.
    //
    // Two levels since ADR-0019 (#439), not one line with a ternary in it.
    // The reconciler ships ENABLED, so a disabled one is now a deliberate act
    // whose consequence is total: this loop gates observation, projection,
    // liveness, the watchdog, escalations, notification dispatch, spec
    // feedback and the dispatch drain, so a deployment with it off does
    // nothing at all however much else is switched on. "Why is nothing
    // happening" has one answer and this is it, which makes it worth a WARN
    // rather than a line in the same colour as everything else at boot.
    if (this.settings.get('reconciler.enabled')) {
      this.logger.log(
        `Reconciler tick registered every ${this.registeredIntervalMs}ms; ` +
          'the reconciler is ENABLED and will observe GitHub. No repository ' +
          'is written to until it opts in, and no run starts until a hard ' +
          'spend ceiling is set.',
      );
    } else {
      this.logger.warn(
        `Reconciler tick registered every ${this.registeredIntervalMs}ms, but ` +
          'the reconciler is DISABLED — it ships enabled, so something turned ' +
          'it off. NOTHING will happen while it is off: no observation, no ' +
          'work orders, no escalations and no dispatch, whatever else is ' +
          'enabled.',
      );
    }
  }

  onModuleDestroy(): void {
    // Unsubscribed FIRST. A change that arrives while the module is being torn
    // down must not re-register an interval nothing will ever delete.
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
    this.registeredIntervalMs = undefined;
  }

  /** Create the timer and put it in the registry under {@link INTERVAL_NAME}. */
  private registerInterval(intervalMs: number): void {
    const handle = setInterval(() => {
      // Deliberately not awaited: `setInterval` cannot await, and the lease is
      // what makes a slow tick safe. If this one runs long, the next fires,
      // fails to take the lease, and records `skipped-locked` — which is the
      // designed behaviour, not a race.
      void this.runOnce();
    }, intervalMs);

    this.scheduler.addInterval(INTERVAL_NAME, handle);
    this.registeredIntervalMs = intervalMs;
  }

  /**
   * React to a settings change.
   *
   * ONLY `reconciler.intervalMs`. `reconciler.enabled` is deliberately absent:
   * it is honoured by the check in `runOnce`, and re-registering on it would
   * restore the second copy of the enablement state that #343 removed.
   */
  private onSettingsChanged(change: OperatorSettingsChange): void {
    if (!change.keys.includes('reconciler.intervalMs')) return;
    this.reregisterInterval();
  }

  /** The mutex. See {@link reregistering}. */
  private reregisterInterval(): void {
    if (this.reregistering) {
      this.reregisterPending = true;
      return;
    }

    this.reregistering = true;
    try {
      do {
        this.reregisterPending = false;
        this.applyIntervalPeriod();
      } while (this.reregisterPending);
    } finally {
      this.reregistering = false;
    }
  }

  /**
   * Move the interval onto the currently configured period.
   *
   * Guarded by `doesExist` before deleting rather than assuming the timer is
   * there: `onModuleDestroy` may have removed it, and `deleteInterval` throws
   * on a name it does not hold — a throw here would escape into the settings
   * emitter and be reported as a failure of somebody else's write.
   *
   * A tick already in flight is NOT affected. `clearInterval` cancels future
   * firings and has no opinion about a callback that has already started, and
   * `runOnce` keeps everything it needs — including the write counter it
   * deltas and the acting phase it records — in locals. So the in-flight tick
   * runs to completion and still writes its row, on the schedule it started
   * under; only the next firing uses the new period.
   */
  private applyIntervalPeriod(): void {
    const intervalMs = this.settings.get('reconciler.intervalMs');

    // A change announcement is not proof the value moved: the emitter carries
    // keys, not values, and an operator can PATCH the period it already had.
    // Re-registering on that would reset the countdown, so a repeated write
    // could hold off the tick indefinitely.
    if (intervalMs === this.registeredIntervalMs) return;

    const previous = this.registeredIntervalMs;

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }

    this.registerInterval(intervalMs);

    this.logger.log(
      `Reconciler tick re-registered every ${intervalMs}ms (was ${previous}ms)`,
    );
  }

  /**
   * The scheduler's entry point.
   *
   * `tick()` is written not to throw, but this catches anyway: an unhandled
   * rejection from a `setInterval` callback has no caller to propagate to and
   * takes the process down under Node's default policy. A dead process is a
   * dead factory, which is precisely the silent failure this system exists to
   * eliminate.
   */
  /**
   * Derive git liveness for every live run.
   *
   * Separated and independently caught: the git watcher is one of two
   * INDEPENDENT liveness sources (VISION §9), and a failure in it must not
   * stop the reconciler tick that follows. An outage in one source is exactly
   * when the other matters most.
   */
  private async sweepLiveness(): Promise<void> {
    try {
      const result = await this.liveness.sweep();
      if (result.eventsRecorded > 0 || result.disagreements.length > 0) {
        this.logger.log(
          `Git liveness: ${result.runsWatched} run(s), ${result.eventsRecorded} new event(s), ` +
            `${result.disagreements.length} disagreement(s) with runner-reported liveness`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Git liveness sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Judge every live run for silence.
   *
   * Independently caught, like the liveness sweep: a watchdog failure must not
   * stop the reconciler, and a reconciler failure must not stop the watchdog.
   * They answer different questions and one being broken is when the other
   * matters most.
   */
  private async sweepWatchdog(): Promise<WatchdogSweepResult> {
    try {
      const result = await this.watchdog.sweep();
      if (result.parkedRuns > 0 || result.resumableRuns > 0) {
        // Logged at `log` rather than `warn`: a parked run is the system
        // working, and VISION §1's rate-limit case is where Opifex most
        // visibly recovers hours with nobody involved.
        this.logger.log(
          `Watchdog: ${result.parkedRuns} run(s) parked, ${result.resumableRuns} due to resume`,
        );
      }
      if (result.silentRuns > 0 || result.loopingRuns > 0) {
        this.logger.warn(
          `Watchdog: ${result.runsJudged} run(s) judged — ${result.silentRuns} silent, ` +
            `${result.loopingRuns} looping` +
            (result.loopCheckUnavailable > 0
              ? `, ${result.loopCheckUnavailable} unmeasurable for loops`
              : ''),
        );
      }
      return result;
    } catch (error) {
      this.logger.error(
        `Watchdog sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // No runs judged, rather than an empty sweep: a watchdog that threw has
      // established nothing about any run, and reporting them healthy would
      // resolve their escalations on the strength of a failure.
      return {
        runsJudged: 0,
        judgedRunIds: [],
        actions: [],
        silentRuns: 0,
        loopingRuns: 0,
        loopCheckUnavailable: 0,
        // Empty tallies rather than an omitted field: a sweep that threw has
        // established nothing about anything, including what was covering it.
        checkCoverage: tallyCoverage([]),
        parkedRuns: 0,
        resumableRuns: 0,
        // Empty, for the same reason `judgedRunIds` is: a sweep that threw
        // observed nothing. The ledger leaves every open interval open on an
        // empty pass, which is the correct degradation — a watchdog failure
        // must not close a stall by claiming it looked and found nothing.
        deadObservations: [],
      };
    }
  }

  /**
   * Keep the dead-time ledger in step with what the sweep just saw (#232).
   *
   * On the same side of the compute/act line as `raiseEscalations`, and for
   * the same reason: the watchdog decides what is true, the task writes it
   * down. Independently caught, like every other step here — a ledger write
   * that fails must not stop the escalation that tells a human, which is the
   * one thing on this tick that matters more.
   *
   * Runs on EVERY tick including empty ones, because the ledger's closes are
   * driven by absence: a run that recovered shows up as an observation that is
   * no longer there, and a pass skipped for having nothing to add is exactly
   * the pass that would have closed it.
   */
  private async recordDeadTime(watchdog: WatchdogSweepResult): Promise<void> {
    try {
      await this.deadTime.record(
        watchdog.deadObservations,
        watchdog.judgedRunIds,
      );
    } catch (error) {
      this.logger.error(
        `Recording dead time failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Turn `escalate` actions into escalation records.
   *
   * VISION §9: escalation is an action, not telemetry — so it happens here,
   * alongside the label executor, and NOT inside the components that decide
   * to escalate. Detection stays a pure function over data; persistence stays
   * in the one place that is allowed to act.
   *
   * Independently caught for the same reason the sweeps are: an escalation
   * that cannot be written must not take down the tick that would notice the
   * next problem.
   */
  private async raiseEscalations(
    actions: ReconcileAction[],
    judgedRunIds: string[],
  ): Promise<void> {
    try {
      const { raised, deduplicated } =
        await this.escalations.raiseFrom(actions);
      if (raised > 0) {
        this.logger.warn(
          `Escalations: ${raised} raised, ${deduplicated} suppressed as duplicates`,
        );
      }

      // A run the watchdog judged and did NOT escalate about has recovered.
      // Conservatively per RUN rather than per kind: if anything at all is
      // still wrong with a run, nothing about it is cleared automatically.
      // Over-resolving would delete a problem nobody ever saw.
      const stillEscalating = new Set(
        actions
          .filter((action) => action.type === 'escalate')
          .map((action) => action.runId)
          .filter((runId): runId is string => Boolean(runId)),
      );
      const recovered = judgedRunIds.filter(
        (runId) => !stillEscalating.has(runId),
      );

      const resolved = await this.escalations.resolveStale(recovered);
      if (resolved > 0) {
        this.logger.log(
          `Escalations: ${resolved} resolved because the condition cleared`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Raising escalations failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Actually tell somebody.
   *
   * Separate from raising, and independently caught, because they fail
   * independently: a push service outage must not stop escalations being
   * RECORDED, and a database problem must not stop the ones already recorded
   * being SENT.
   *
   * Runs unconditionally rather than only when this tick raised something.
   * The queue is what is `raised`, not what this pass produced — an
   * escalation raised while the push service was down has to be picked up by
   * a later tick, and a dispatch conditional on new work never would.
   */
  private async dispatchEscalations(): Promise<void> {
    try {
      const result = await this.dispatcher.dispatchPending();

      if (result.dispatched > 0 || result.rerouted > 0) {
        this.logger.log(
          `Notifications: ${result.dispatched} dispatched` +
            (result.rerouted > 0
              ? `, ${result.rerouted} via the fallback path`
              : '') +
            // Reported even on success: escalations that only went out on a
            // retry mean the transport is limping, and a line that said only
            // "dispatched" would make that look healthy.
            (result.retried > 0 ? `, ${result.retried} on a retry` : ''),
        );
      }
      if (result.failed > 0 || result.timedOut > 0 || result.abandoned > 0) {
        this.logger.error(
          `Notifications: ${result.failed} could not be sent, ` +
            `${result.timedOut} were sent and never confirmed by a device` +
            (result.abandoned > 0
              ? `, ${result.abandoned} hit the attempt cap and will NOT be retried`
              : ''),
        );
      }
    } catch (error) {
      this.logger.error(
        `Dispatching escalations failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Tell issue authors why their specs were refused.
   *
   * Independently caught, like every other outward step: a GitHub outage while
   * commenting must not stop the label executor below, and vice versa.
   *
   * Runs BEFORE the mirror-label gate and outside `actions.length === 0`,
   * because a rejection produces no action — the issue never became a work
   * order, so there is nothing for the diff engine to have an opinion about.
   * Folding it in behind that early return would mean the one repository with
   * nothing else happening is the one whose authors never hear back.
   */
  private async reportSpecRejections(
    record: TickRecord,
    acting: ActingPhase,
  ): Promise<void> {
    if (record.rejections.length === 0) return;

    try {
      const outcome = await this.specFeedback.report(record.rejections);
      // The executor returned, so this tick's acting phase has an answer —
      // even if every rejection was suppressed and nothing was posted. See
      // `ActingPhase`.
      acting.ran = true;
      acting.failures.push(...fromSpecFeedback(outcome));
      if (outcome.failures.length > 0) {
        this.logger.error(
          `Spec feedback: ${outcome.failures.length} comment(s) could not be posted — ` +
            outcome.failures
              .map((f) => `${f.repository}#${f.issueNumber}: ${f.reason}`)
              .join('; '),
        );
      }
    } catch (error) {
      this.logger.error(
        `Reporting spec rejections failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Wake the parked runs whose reset time has passed (#477).
   *
   * Independently caught, like every other outward step: a resume that threw
   * must not cost this tick its dispatch drain or its execution record.
   *
   * The whole action list goes in, not just the watchdog's half. The executor
   * needs both — the `resume` actions come from the watchdog, and the decision
   * about whether a human has since applied `factory:hold` comes from the
   * projection the reconciler just computed. Handing it the pieces separately
   * would be handing it the same tick twice.
   *
   * A tick with no `record` never reaches here: `runOnce` assigns it from
   * `reconciler.tick()` on the line above, so a projection that threw skips
   * this step entirely. That is the fail-closed behaviour the executor's hold
   * gate depends on, and it is structural rather than a check.
   */
  private async resumeParkedRuns(
    actions: ReconcileAction[],
    record: TickRecord,
    acting: ActingPhase,
  ): Promise<void> {
    // Nothing to resume is the common case, and it must leave the acting
    // phase untouched. `executionFailures` distinguishes null ("no
    // acting-phase executor ran at all this tick") from `[]` ("one ran and
    // found nothing wrong"), and an executor that reported a clean run on
    // every quiet tick would erase that distinction — the same reason the
    // mirror-label step is skipped outright when no repository has opted in.
    if (!actions.some((action) => action.type === 'resume')) return;

    try {
      const outcome = await this.resumes.execute(actions, record.projections);
      // Set after the call returns, for the same reason the mirror-label and
      // spec-feedback steps do: an executor that threw outright has
      // established nothing, and `[]` would say it ran clean.
      acting.ran = true;
      acting.failures.push(...fromResumes(outcome));
    } catch (error) {
      this.logger.error(
        `Resuming parked runs failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Hand queued work orders to a runner.
   *
   * Independently caught, like every other outward step. Runs BEFORE the
   * mirror-label gate and outside `actions.length === 0`, for the same reason
   * spec feedback does: a queued work order produces no ACTION — the diff
   * engine's actions are about issues — so gating dispatch on the action list
   * would mean the queue never drains on a quiet tick, which is most of them.
   *
   * Runs AFTER the tick, so a work order projected by this very tick can be
   * dispatched by it rather than waiting another 60 seconds.
   *
   * Both gates live below this: `Repository.dispatchEnabled` is checked per
   * work order in the queue service, and `DISPATCH_ENABLED` inside the
   * executor — which still runs the whole decision when off and reports what
   * it WOULD have done, because that is the observation-week artifact.
   */
  private async drainDispatchQueue(): Promise<void> {
    try {
      await this.dispatchQueue.drain();
    } catch (error) {
      this.logger.error(
        `Draining the dispatch queue failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Write back what this tick actually did to GitHub (#317), and what went
   * wrong doing it (#320).
   *
   * The count is a DELTA over `GitHubWriteService`'s issued-writes counter,
   * taken across the whole of `runOnce`, rather than a sum of what each
   * executor returned. Both matter:
   *
   *  - **Delta, because the write service is the choke point.** A tick can
   *    reach GitHub through four paths — mirror labels, spec-feedback
   *    comments, the authorization record a dispatch posts, and the branch it
   *    creates — and only the first two return a tally the task can see. Add
   *    up what the executors report and the dispatch writes, the most
   *    consequential the factory makes, are silently missing. That is #317's
   *    own bug rebuilt one layer down, which is why it is not done that way.
   *  - **Across the whole method, in a `finally`.** `runOnce` returns early on
   *    a quiet tick, and a step that threw must not cost the count either. By
   *    the time control leaves this method, whatever left for GitHub has left.
   *
   * The delta can attribute a concurrent write — one the cockpit or the
   * supervisor made while the tick was in flight — to this tick. Accepted, and
   * documented on `ReconcileLogService.recordExecution`: the number's job
   * is to catch a window that was meant to be read-only, so it is biased to
   * over-report rather than to miss.
   *
   * The failures go the OPPOSITE way — they are exactly what the executors
   * returned, and nothing else. The write service counts requests and cannot
   * say which one failed or on whose behalf; the executors can. And dispatch's
   * own write failures deliberately do not appear here: they are recorded on
   * the RUN, which is the row dispatch already has to fail onto.
   */
  private async recordExecution(
    record: TickRecord | undefined,
    issued: number,
    acting: ActingPhase,
  ): Promise<void> {
    // The row is created holding 0 and a null failure list, so a tick where
    // nothing was issued and no executor ran is already correct on disk.
    // During an observation week with nothing to report that is every tick,
    // and this costs the loop nothing.
    if (issued === 0 && !acting.ran) return;

    if (!record?.id) {
      this.logger.error(
        `${issued} GitHub write(s) were issued and ${acting.failures.length} execution ` +
          `failure(s) reported on a tick with no log row to record them against — the ` +
          `reconcile log understates this tick` +
          (acting.failures.length > 0
            ? `: ${acting.failures
                .map(
                  (failure) =>
                    `${failure.repository}#${failure.issueNumber} (${failure.actionType}): ${failure.reason}`,
                )
                .join('; ')}`
            : ''),
      );
      return;
    }

    try {
      await this.log.recordExecution(record.id, {
        writesIssued: issued,
        // Null, not `[]`, when no executor ran: the distinction is the field's
        // only way to separate "acted, nothing failed" from "never acted".
        executionFailures: acting.ran ? acting.failures : null,
      });
    } catch (error) {
      // Independently caught, like every other outward step here — and this
      // one runs in a `finally`, where an escaping rejection has no caller to
      // propagate to and would take the process down under Node's default
      // policy. The log service already swallows its own storage failures;
      // this is the belt to that pair of braces.
      this.logger.error(
        `Recording ${issued} issued write(s) and ${acting.failures.length} execution ` +
          `failure(s) against tick ${record.id} threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  private async runOnce(): Promise<void> {
    // Re-read every firing. This is the half of #343 that makes the flag live:
    // the interval always exists, and this is what decides whether it does
    // anything.
    //
    // It gates the WHOLE loop, not just the projection. `ReconcilerService`
    // has its own check and would return `skipped-disabled` on its own, but
    // the liveness sweep, the watchdog, escalations, dead time, notification
    // dispatch, spec feedback and the dispatch drain all hang off this method
    // too — and none of them ran at all while a disabled reconciler registered
    // no interval. Gating only the projection would silently turn the whole
    // rest of that list on for every deployment that has the reconciler off,
    // which is not a change #343 is entitled to make.
    if (!this.settings.get('reconciler.enabled')) {
      // `debug`, not `log`. A disabled deployment now ticks every `intervalMs`
      // forever; an INFO line each time is how a log stops being read, and
      // this one competes with the escalations that matter. The state an
      // operator needs is stated once, in the boot line.
      this.logger.debug('Reconciler tick skipped: the reconciler is disabled');
      return;
    }

    // Read before anything runs, and compared after everything has. See
    // `recordExecution` for why this is a delta over the write service
    // rather than a sum of what the executors returned.
    const writesBefore = this.writes.writesIssued;
    let record: TickRecord | undefined;
    // Threaded through the acting steps below and read in the `finally`. See
    // `ActingPhase` for why it is a local and not a field.
    const acting: ActingPhase = { ran: false, failures: [] };

    try {
      // Liveness FIRST, so the tick's projection sees the freshest run state.
      // Deriving it after would mean every conclusion is one tick stale — and
      // for a stalled run, one tick stale is the difference the watchdog in
      // #54 is measuring.
      await this.sweepLiveness();

      // Then judge liveness, on the freshest state the sweep just produced.
      // Running the watchdog BEFORE the sweep would judge every run one tick
      // stale — and for a stall, one tick stale is exactly the latency #54 is
      // trying to minimise.
      const watchdog = await this.sweepWatchdog();

      // COMPUTE, then APPLY — two steps, two components. This method is the
      // only place they meet, which is what keeps `ReconcilerService` unable
      // to act on its own conclusions.
      record = await this.reconciler.tick();

      // The watchdog's actions are computed alongside the reconciler's and,
      // in Phase 3, executed just as little. The mirror-label executor below
      // ignores everything that is not a label action, so a kill-and-re-run
      // passing through it is inert by construction rather than by a check.
      const actions = [...watchdog.actions, ...record.actions];

      // BEFORE the mirror-label gate below. Notification is a reconciler
      // output on the same footing as dispatch (VISION §9), so it must not
      // sit behind a flag that exists to keep label writes off during the
      // observation week — the whole point of that week is being told what
      // the system would have done.
      await this.raiseEscalations(actions, watchdog.judgedRunIds);

      // Alongside the escalations, from the same sweep result. The two record
      // the same stall from opposite ends: an escalation measures how fast a
      // human was told (metric 1), the ledger how long the factory was down
      // (metric 2). Sharing a start instant is why they are written together
      // and why they are not the same row.
      await this.recordDeadTime(watchdog);

      // Unconditional, and before the early return below: the notification
      // queue is everything still `raised`, not what this pass produced. An
      // escalation raised while the push service was down is picked up here
      // on a later tick, which a dispatch gated on new work never would.
      await this.dispatchEscalations();

      // Also before the early return: a rejected issue produces no ACTION —
      // it never became a work order — so gating this on the action list
      // would silence feedback in exactly the repository where nothing else
      // is happening.
      await this.reportSpecRejections(record, acting);

      // BEFORE the dispatch drain, deliberately. Both spend money and a fleet
      // at capacity cannot do both, so the order is a policy: finishing work
      // that has already started beats starting more of it. A parked run is
      // also holding a concurrency slot that nothing else can use until it
      // resumes (`dispatch.service.ts`, `OCCUPYING_STATUSES`), so resuming it
      // first is what frees the fleet rather than what competes with it.
      //
      // Also before the early return below: a resume needs the projection this
      // tick just computed, and the action that triggers it comes from the
      // watchdog rather than from the diff engine.
      await this.resumeParkedRuns(actions, record, acting);

      // Also before the early return, and for the same reason: a queued work
      // order produces no action, so gating this on the action list would
      // mean the queue never drains on a quiet tick.
      await this.drainDispatchQueue();

      if (actions.length === 0) return;

      const enabledFor = new Set(
        (await this.repositories.listObserved())
          .filter((repository) => repository.mirrorLabelsEnabled)
          .map((repository) => `${repository.owner}/${repository.name}`),
      );

      // Skip the call entirely when nothing has opted in, rather than handing
      // the executor a list it will suppress item by item. During the
      // observation week this is every tick.
      if (enabledFor.size === 0) return;

      const outcome = await this.executor.execute(actions, enabledFor);
      // Set after the call returns, for the same reason spec feedback does:
      // an executor that threw outright has established nothing, and `[]`
      // would say it ran clean.
      acting.ran = true;
      acting.failures.push(...fromMirrorLabels(outcome));
    } catch (error) {
      this.logger.error(
        `Reconciler tick threw, which tick() is supposed to prevent: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      // In a `finally` so the two early returns above, and any path that
      // threw, still record what went out. A write that happened and was not
      // logged is the failure this whole field exists to make impossible.
      await this.recordExecution(
        record,
        this.writes.writesIssued - writesBefore,
        acting,
      );
    }
  }
}
