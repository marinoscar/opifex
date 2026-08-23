import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { ReconcileAction } from '../reconciler/diff/actions.types';
import {
  actionsForParking,
  decideParking,
  type BlockedRunState,
} from './blocked-parking';
import { detectLoop, type ToolObservation } from './loop-detection';
import { detectSilentRuns } from './silent-detection';
import { actionsForLoop, actionsForSilence } from './watchdog.actions';
import type {
  LivenessSource,
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
  /** Actions computed. During Phase 3 none of the kills execute. */
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
  /** Runs newly parked with a scheduled resume. */
  parkedRuns: number;
  /** Parked runs whose scheduled time has arrived. */
  resumableRuns: number;
}

/**
 * The watchdog.
 *
 * VISION §1, the failure that started the project:
 *
 * > A session stalls at 10am. I find out at 2pm. Four hours dead.
 *
 * This is the part that notices. It computes actions and executes none of
 * them — killing a run and re-dispatching from base is Phase 4 machinery
 * (#61, #66), and #54 says so explicitly. What lands here is the detection,
 * the verdict, and the escalation that makes a human aware.
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
      parkedRuns: parking.parked,
      resumableRuns: parking.resumable,
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
   */
  private async sweepBlocked(now: Date): Promise<{
    parked: number;
    resumable: number;
    judgedRunIds: string[];
    actions: ReconcileAction[];
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
        this.logger.log(
          `${decision.reason} — computed resume action (not dispatched; Phase 4 wires that, #66)`,
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
          select: { capability: { select: { streamingFidelity: true } } },
        },
        workOrder: {
          select: {
            identity: true,
            issueNumber: true,
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
    }));
  }
}
