import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { ReconcileAction } from '../reconciler/diff/actions.types';
import { detectLoop, type ToolObservation } from './loop-detection';
import { detectSilentRuns } from './silent-detection';
import { actionsForLoop, actionsForSilence } from './watchdog.actions';
import type { StreamingFidelity, WatchedRunState } from './watchdog.types';

export interface WatchdogSweepResult {
  runsJudged: number;
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

    return {
      runsJudged: runs.length,
      silentRuns: verdicts.length,
      loopingRuns,
      loopCheckUnavailable,
      actions,
    };
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
  private async loadToolObservations(runId: string): Promise<ToolObservation[]> {
    const events = await this.prisma.runEvent.findMany({
      where: { runId, toolSignature: { not: null } },
      orderBy: { occurredAt: 'desc' },
      take: 40,
      select: { toolSignature: true, occurredAt: true },
    });

    return events
      .reverse()
      .map((event) => ({ signature: event.toolSignature as string, occurredAt: event.occurredAt }));
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
        runner: { select: { capability: { select: { streamingFidelity: true } } } },
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
      runnerKey: run.runnerKey,
      fidelity: (run.runner?.capability?.streamingFidelity as StreamingFidelity) ?? null,
    }));
  }
}
