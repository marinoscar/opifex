import { Injectable, Logger } from '@nestjs/common';

import type { DeadObservation } from '../dead-time/dead-time.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ReconcileAction } from '../reconciler/diff/actions.types';
import {
  actionsForParking,
  decideParking,
  type BlockedRunState,
} from './blocked-parking';
import {
  describeCheckCoverage,
  tallyCoverage,
  type CoverageTallies,
} from './check-coverage';
import { detectLoop, type ToolObservation } from './loop-detection';
import { detectSilentRuns } from './silent-detection';
import { actionsForLoop, actionsForSilence } from './watchdog.actions';
import type {
  LivenessSource,
  RateLimitSignal,
  StreamingFidelity,
  WatchedRunState,
} from './watchdog.types';

export interface WatchdogSweepResult {
  runsJudged: number;
  /**
   * Every run this sweep actually looked at, live and blocked.
   *
   * Reported so the caller can tell "judged and found healthy" apart from
   * "not judged at all". Only the first clears an outstanding escalation: a
   * run that dropped out of the sweep has not recovered, it has vanished, and
   * quietly resolving its escalation would be exactly the silent failure this
   * system exists to eliminate.
   */
  judgedRunIds: string[];
  /**
   * Actions computed. The `resume` ones execute (#477); no kill does.
   */
  actions: ReconcileAction[];
  silentRuns: number;
  loopingRuns: number;
  /**
   * Runs where loop detection could not run at all, because the runner does
   * not report tool detail.
   *
   * Reported rather than folded into "no loop found": #55 requires the
   * unavailability be visible, and a count of zero looping runs that quietly
   * included unmeasurable ones would be a false reassurance.
   */
  loopCheckUnavailable: number;
  /**
   * How many of the judged runs each check is protecting, and how well (#104).
   *
   * `loopCheckUnavailable` above answers "what happened this tick"; this
   * answers "what is standing" — how much of the fleet sits on runners that
   * can never support a given check at all. One sweep is then enough to see
   * the coverage picture, instead of it being reconstructible only by reading
   * three detectors and a capability table.
   *
   * The two counts deliberately differ: `loopCheckUnavailable` counts checks
   * ATTEMPTED and refused, so a run already found silent is not counted twice
   * for the same tick, while these tallies cover every live run judged.
   *
   * Tallied over the live runs only. Blocked runs come from a separate query
   * that does not join capabilities, and adding the join purely for a tally
   * would put work on a tick to report on runs the tally would not change.
   */
  checkCoverage: CoverageTallies;
  /** Runs newly parked with a scheduled resume. */
  parkedRuns: number;
  /**
   * Parked runs whose scheduled time has arrived.
   *
   * What this tick found DUE, not what it resumed. `ResumeExecutor` re-checks
   * every admission gate afterwards and can refuse any of them, so the two
   * numbers legitimately differ and are reported by the components that know
   * their own half.
   */
  resumableRuns: number;
  /**
   * Every run this sweep found making NO PROGRESS, and since when (#232).
   *
   * The ledger behind VISION §10's metric 2 is written from this. It is
   * reported rather than written here for the same reason the escalations are:
   * the watchdog decides, `reconciler.task.ts` persists, and a detector that
   * could write rows would be on the wrong side of that line.
   *
   * Both kinds, because VISION §10 defines metric 2 as *"hours parked or
   * stalled"*. They stay tagged rather than merged — a stalled hour is a
   * supervision failure and a parked hour is the system waiting out a quota,
   * and collapsing them is the conflation VISION §9 calls the most common
   * supervision bug.
   *
   * Distinct from `silentRuns` and `parkedRuns` above, which count what
   * CHANGED this tick. This lists what is true right now, which is what a
   * reconciled ledger needs.
   */
  deadObservations: DeadObservation[];
}

/**
 * The watchdog.
 *
 * VISION §1, the failure that started the project:
 *
 * > A session stalls at 10am. I find out at 2pm. Four hours dead.
 *
 * This is the part that notices. It computes actions and executes none of
 * them, which is #54's phase boundary and still holds: what lands here is the
 * detection, the verdict, and the escalation that makes a human aware.
 *
 * Two of the computed actions now reach something. `resume` is executed by
 * `reconciler/execute/resume.executor.ts` (#477) — this class still only
 * decides that a park is over. `park` is persisted below, by this class, and
 * that is the one deliberate exception to "executes none of them": a park is
 * not an outward action, it is this component recording its own schedule, and
 * {@link sweepBlocked} says why it cannot live in the executor.
 *
 * The kill actions — `kill-and-re-run`, `kill-and-re-plan` — still execute
 * nowhere. Nothing in the codebase can end a run on a verdict, and the log
 * lines below say so in the present tense rather than pointing at an issue.
 */
@Injectable()
export class WatchdogService {
  private readonly logger = new Logger(WatchdogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Judge every live run.
   *
   * `now` is injectable so a test can place runs at exact ages, and so the
   * whole sweep stays deterministic — VISION §7 puts stall detection in the
   * hot path with no model involvement, and reading the clock in three places
   * is the first step away from that.
   */
  async sweep(now: Date = new Date()): Promise<WatchdogSweepResult> {
    const runs = await this.loadLiveRuns();
    const verdicts = detectSilentRuns(runs, now);

    // Arithmetic over data already loaded, with no query of its own — this
    // runs on every tick, and coverage that cost a round trip per run would be
    // the first thing an operator turned off.
    const checkCoverage = tallyCoverage(
      runs.map((run) =>
        describeCheckCoverage({
          runnerKey: run.runnerKey,
          fidelity: run.fidelity,
          rateLimitSignal: run.rateLimitSignal,
          branch: run.branch,
        }),
      ),
    );

    const actions = verdicts.flatMap(actionsForSilence);

    for (const verdict of verdicts) {
      this.logger.warn(
        `Silent run ${verdict.workOrderIdentity}: ${verdict.reason} — computed kill-and-re-run ` +
          `(not executed; no runner executor exists until Phase 4)`,
      );
    }

    // Loop detection is checked only on runs that are NOT already silent. A
    // run cannot be both — silence means no events at all, and a loop is
    // defined by events flowing — and computing two different kill responses
    // for one run would put contradictory instructions in front of the
    // operator.
    const silentIds = new Set(verdicts.map((v) => v.runId));
    let loopingRuns = 0;
    let loopCheckUnavailable = 0;

    for (const run of runs) {
      if (silentIds.has(run.runId)) continue;

      const observations = await this.loadToolObservations(run.runId);
      const loop = detectLoop(run.fidelity, observations);

      if (!loop.available) {
        loopCheckUnavailable += 1;
        continue;
      }
      if (!loop.looping) continue;

      loopingRuns += 1;
      this.logger.warn(
        `Looping run ${run.workOrderIdentity}: ${loop.reason} — computed kill-and-re-plan ` +
          `(not executed; re-planning needs the supervisor from epic #21)`,
      );
      actions.push(...actionsForLoop(loop, run));
    }

    const parking = await this.sweepBlocked(now);
    actions.push(...parking.actions);

    return {
      runsJudged: runs.length,
      judgedRunIds: [...runs.map((run) => run.runId), ...parking.judgedRunIds],
      silentRuns: verdicts.length,
      loopingRuns,
      loopCheckUnavailable,
      checkCoverage,
      parkedRuns: parking.parked,
      resumableRuns: parking.resumable,
      // Silent runs first, then parked. A run cannot be both — `blocked` is
      // excluded from the silence detector's judgeable set precisely so a
      // parked run is never also called stalled — so the two lists are
      // disjoint by construction rather than by de-duplication here.
      deadObservations: [
        ...verdicts.map((verdict) => ({
          runId: verdict.runId,
          kind: 'stalled' as const,
          // NOT `now`, and not the tick that noticed. The interval begins when
          // progress actually stopped, which is the same instant
          // `Escalation.progressStoppedAt` records — metric 1 and metric 2
          // share a start and differ entirely in where they end.
          since: verdict.progressStoppedAt,
        })),
        ...parking.deadObservations,
      ],
      actions,
    };
  }

  /**
   * Park blocked runs and wake the ones whose time has come.
   *
   * The other half of VISION §1's origin story:
   *
   * > An agent hits a rate limit at 2pm. I find out at 6pm. Four hours dead.
   *
   * This is where Opifex most visibly recovers hours with no human involved,
   * which is why a parked run produces no action at all while it waits — the
   * system working should be quiet, and an action every tick would bury the
   * ones that need attention.
   *
   * ## Why the PARK is written here and the RESUME is not
   *
   * The resume leaves through an action, to `ResumeExecutor`, because it
   * spends money against a real subscription with nobody watching. The park
   * does not leave at all: it schedules a time, and the only thing that ever
   * reads that time is the next tick of this same sweep.
   *
   * It is persisted here rather than by an executor for a reason the executor
   * could not satisfy. `ReconcilerTask.runOnce` skips its acting phase on a
   * tick whose projection threw, and a park that had not persisted would be
   * RE-DRAWN with fresh jitter next tick — leaving the run chasing its own
   * jitter and never actually resuming, which is the failure {@link
   * decideParking} is written to avoid. Persisting the schedule where the
   * schedule is decided is what makes the decision idempotent across ticks.
   *
   * That also makes this method the single writer of a `resumesAt` PLAN, which
   * is the invariant `blocked-parking.ts` states and #477 settled.
   */
  private async sweepBlocked(now: Date): Promise<{
    parked: number;
    resumable: number;
    judgedRunIds: string[];
    actions: ReconcileAction[];
    deadObservations: DeadObservation[];
  }> {
    const runs = await this.loadBlockedRuns();
    const actions: ReconcileAction[] = [];
    let parked = 0;
    let resumable = 0;

    for (const run of runs) {
      const decision = decideParking(run, now);
      actions.push(...actionsForParking(run, decision));

      if (decision.kind === 'park') {
        parked += 1;
        // Persisted so the next tick sees it already scheduled and waits,
        // rather than re-deciding and moving the time again — which would
        // leave the run chasing its own jitter and never resuming.
        await this.prisma.run.update({
          where: { id: run.runId },
          data: { resumesAt: decision.resumeAt },
        });
        this.logger.log(decision.reason);
      } else if (decision.kind === 'resume') {
        resumable += 1;
        // Computed here, executed by `ResumeExecutor` later in the same tick
        // (#477). Logged at `log` rather than `warn`: a park reaching its end
        // is the system working, and it is the line an operator looks for to
        // confirm auto-resume is alive. Whether the resume actually happened —
        // and which gate refused it if not — is that executor's line, because
        // this class cannot know.
        this.logger.log(
          `${decision.reason} — handing it to the resume executor`,
        );
      } else if (decision.kind === 'escalate') {
        this.logger.warn(decision.reason);
      }
    }

    return {
      parked,
      resumable,
      judgedRunIds: runs.map((run) => run.runId),
      actions,
      // EVERY blocked run, not just the ones this tick parked. The ledger is
      // reconciled against what is true now, and a run parked three ticks ago
      // is still accruing dead time — reporting only the transitions would
      // record the first minute of a four-hour quota wait and none of the
      // rest. `blockedSince` is the CURRENT block's own event, so a run that
      // blocked, resumed and blocked again dates its second park correctly.
      deadObservations: runs.map((run) => ({
        runId: run.runId,
        kind: 'parked' as const,
        since: run.blockedSince,
      })),
    };
  }

  /**
   * Blocked runs, with the reason and reset time #53 carried through.
   *
   * `blockedSince` comes from the newest `run.blocked` event rather than the
   * run's own timestamps: a run can block, resume and block again, and the
   * patience clock for an undated block has to start at the CURRENT block.
   */
  private async loadBlockedRuns(): Promise<BlockedRunState[]> {
    const runs = await this.prisma.run.findMany({
      where: { status: 'blocked' },
      select: {
        id: true,
        startedAt: true,
        resumesAt: true,
        workOrder: {
          select: {
            identity: true,
            issueNumber: true,
            repository: { select: { owner: true, name: true } },
          },
        },
        events: {
          where: { type: 'run_blocked' },
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { occurredAt: true, blockedReason: true, blockedUntil: true },
        },
      },
    });

    return runs.map((run) => {
      const event = run.events[0];
      return {
        runId: run.id,
        workOrderIdentity: run.workOrder.identity,
        repository: `${run.workOrder.repository.owner}/${run.workOrder.repository.name}`,
        issueNumber: run.workOrder.issueNumber,
        blockedSince: event?.occurredAt ?? run.startedAt,
        resetAt: event?.blockedUntil ?? null,
        reason: event?.blockedReason ?? null,
        resumesAt: run.resumesAt,
      };
    });
  }

  /**
   * Recent tool signatures for one run, oldest first.
   *
   * Only `run.progress` events carry one, and only from a runner whose
   * fidelity supplies it — so this returns empty for most runners, and
   * `detectLoop` reports that as UNAVAILABLE rather than as "no loop".
   *
   * Bounded, and ordered newest-first in the query then reversed: fetching the
   * whole stream of a long-running job to look at its tail would grow with the
   * run.
   */
  private async loadToolObservations(
    runId: string,
  ): Promise<ToolObservation[]> {
    const events = await this.prisma.runEvent.findMany({
      where: { runId, toolSignature: { not: null } },
      orderBy: { occurredAt: 'desc' },
      take: 40,
      select: { toolSignature: true, occurredAt: true },
    });

    return events.reverse().map((event) => ({
      signature: event.toolSignature as string,
      occurredAt: event.occurredAt,
    }));
  }

  /**
   * Live runs, with the runner's DECLARED fidelity attached.
   *
   * Joined through `Runner.capability` rather than assumed, because the whole
   * point of #54's thresholds is that they come from what a runner says it can
   * do. A runner with no manifest yields `fidelity: null`, which the detector
   * treats permissively rather than as a reason to kill.
   */
  private async loadLiveRuns(): Promise<WatchedRunState[]> {
    const runs = await this.prisma.run.findMany({
      // `blocked` is excluded here as well as in the detector: a parked run is
      // supposed to be quiet, and loading it only to discard it invites
      // someone to "fix" the filter later without knowing why it was there.
      where: { status: { in: ['running', 'stalled'] } },
      select: {
        id: true,
        status: true,
        startedAt: true,
        lastEventAt: true,
        runnerKey: true,
        // The newest event's SOURCE, for #59's per-source latency split. One
        // nested read rather than a second query per run: the watchdog runs
        // every tick over every live run, and a query per run is how a sweep
        // that is supposed to be arithmetic becomes an N+1.
        events: {
          take: 1,
          orderBy: { occurredAt: 'desc' as const },
          select: { source: true },
        },
        runner: {
          select: {
            capability: {
              select: { streamingFidelity: true, rateLimitSignal: true },
            },
          },
        },
        workOrder: {
          select: {
            identity: true,
            issueNumber: true,
            // The branch git-derived liveness watches. Read here rather than
            // in a second pass: whether a run HAS a second liveness source is
            // part of what covers it (#104).
            branch: true,
            repository: { select: { owner: true, name: true } },
          },
        },
      },
    });

    return runs.map((run) => ({
      runId: run.id,
      workOrderIdentity: run.workOrder.identity,
      repository: `${run.workOrder.repository.owner}/${run.workOrder.repository.name}`,
      issueNumber: run.workOrder.issueNumber,
      status: run.status,
      startedAt: run.startedAt,
      lastEventAt: run.lastEventAt,
      lastEventSource: (run.events[0]?.source as LivenessSource) ?? null,
      runnerKey: run.runnerKey,
      fidelity:
        (run.runner?.capability?.streamingFidelity as StreamingFidelity) ??
        null,
      rateLimitSignal:
        (run.runner?.capability?.rateLimitSignal as RateLimitSignal) ?? null,
      branch: run.workOrder.branch || null,
    }));
  }
}
