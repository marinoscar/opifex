import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * One run the sweep observed making no progress, and since when.
 *
 * Produced by the watchdog, which is the only component that knows whether
 * four minutes of silence is a stall — the threshold comes from the runner's
 * declared fidelity, so the judgement cannot be re-made downstream without
 * re-implementing the detector.
 */
export interface DeadObservation {
  runId: string;
  kind: 'stalled' | 'parked';
  /**
   * When progress stopped. For a stall, `SilenceVerdict.progressStoppedAt`;
   * for a park, the `occurredAt` of the `run.blocked` event.
   */
  since: Date;
}

export interface DeadLedgerResult {
  /** Intervals opened this pass. */
  opened: number;
  /** Intervals closed this pass, by how they ended. */
  resumed: number;
  concluded: number;
  quarantined: number;
  /** Intervals still open after this pass. */
  open: number;
}

/**
 * Statuses a run can hold while an interval of non-progress is still running.
 *
 * The same three `dispatch.service.ts` counts as occupying a slot and
 * `run-events.service.ts` allows a run to conclude from — a run that holds a
 * slot is a run that has not finished. Anything outside this set means the
 * interval is over, whatever else happened.
 */
const LIVE_STATUSES = ['running', 'stalled', 'blocked'] as const;

/**
 * The ledger behind VISION §10's metric 2, and the only writer of
 * `dead_intervals`.
 *
 * ## Reconciled, not event-sourced — one writer instead of five
 *
 * The obvious shape is a writer on every transition: open on stall, close on
 * resume, close on conclusion, close on quarantine, close on kill. That is
 * five call sites across `watchdog`, `run-events`, `runners` and wherever
 * quarantine lands, and every one of them is a chance to miss a close. A
 * missed close does not degrade gracefully: the interval stays open forever
 * and reports unbounded, growing dead time for a run that finished last
 * Tuesday. The metric would drift monotonically toward a lie.
 *
 * So this reconciles instead, in the idiom of everything else on the tick. It
 * is handed what the sweep OBSERVED and it makes the ledger agree with that,
 * from whatever state it is in. Every pass is idempotent and self-healing: an
 * interval left open by a crashed tick is closed by the next one, and a row
 * that was never opened is opened late rather than lost.
 *
 * ## Which makes the three ends fall out of one pass
 *
 * - **resumed** — the run was judged and is no longer making no progress.
 *   Closed at its `lastEventAt`, the exact instant it came back, not at the
 *   tick that noticed. That time was lost and then recovered.
 * - **concluded** — the run left the live statuses without ever resuming.
 *   Closed at `endedAt`, which the conclusion itself recorded. That time never
 *   came back.
 * - **quarantined** — policy took it out of the loop. Kept separate from
 *   `concluded` because a quarantined run did not finish; VISION §8 says it
 *   cannot clear its own quarantine, so the interval ends and what the
 *   quarantine costs after that is a different question.
 *
 * ## A run the sweep did not look at is left OPEN
 *
 * Deliberately, and it is the same rule `reconciler.task.ts` applies to
 * resolving escalations: *"a run that dropped out of the sweep has not
 * recovered, it has vanished."* Closing its interval would report the dead
 * time as over on the strength of not having looked.
 */
@Injectable()
export class DeadTimeService {
  private readonly logger = new Logger(DeadTimeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Make the ledger agree with one sweep.
   *
   * @param observations every run the sweep found making no progress
   * @param judgedRunIds every run the sweep actually looked at, healthy or not
   */
  async record(
    observations: DeadObservation[],
    judgedRunIds: string[],
    now: Date = new Date(),
  ): Promise<DeadLedgerResult> {
    const result: DeadLedgerResult = {
      opened: 0,
      resumed: 0,
      concluded: 0,
      quarantined: 0,
      open: 0,
    };

    const observed = new Map(
      observations.map((observation) => [observation.runId, observation]),
    );
    const judged = new Set(judgedRunIds);

    // Every open interval, with the run's current state attached. Bounded by
    // the number of runs that are dead RIGHT NOW, which is the smallest set in
    // play — not by the number of stalls that have ever happened.
    const openIntervals = await this.prisma.deadInterval.findMany({
      where: { endedAt: null },
      select: {
        id: true,
        runId: true,
        kind: true,
        startedAt: true,
        run: { select: { status: true, lastEventAt: true, endedAt: true } },
      },
    });

    /**
     * Runs whose open interval this pass already decided about.
     *
     * Not the same thing as "runs that still have an open interval". A run
     * whose interval was just CLOSED belongs here too, and leaving it out was
     * a real double-count: a run that concluded between the watchdog's query
     * and this pass is still in `observations`, so the loop below would open a
     * second interval on a run that has finished — one that nothing would ever
     * judge again, so it would sit open forever reporting unbounded dead time.
     */
    const handled = new Set<string>();

    for (const interval of openIntervals) {
      handled.add(interval.runId);
      const observation = observed.get(interval.runId);
      const status = interval.run.status as string;

      // The run left the live statuses. This takes precedence over everything
      // below, including a stale observation from the same sweep: a run that
      // has concluded is not still stalled, whatever a detector computed a few
      // milliseconds earlier.
      if (!(LIVE_STATUSES as readonly string[]).includes(status)) {
        const quarantined = status === 'quarantined';
        await this.close(
          interval.id,
          // `endedAt` is the exact conclusion instant when the conclusion
          // recorded one. Quarantine does not set it, so that path falls back
          // to `now` and is at most one tick late — stated rather than hidden,
          // because a tick of over-count on a run that stopped is a far
          // smaller error than leaving the interval open.
          latest(interval.run.endedAt ?? now, interval.startedAt),
          quarantined ? 'quarantined' : 'concluded',
        );
        if (quarantined) result.quarantined += 1;
        else result.concluded += 1;
        continue;
      }

      if (observation) {
        // Same interval, still running. Nothing to write — an UPDATE every
        // tick would churn `updated_at` on rows nothing changed about.
        if (
          observation.kind === interval.kind &&
          observation.since.getTime() <= interval.startedAt.getTime()
        ) {
          result.open += 1;
          continue;
        }

        // A NEW period of non-progress on the same run: it came back, or it
        // went from silent to parked, and then stopped again. #232 requires
        // one interval per stall — *"a run that stalled twice reports only its
        // last"* is the bug — so the old one is closed and a new one opened.
        //
        // Closed AT the new start, which is exact rather than approximate: the
        // new stall begins at the run's last event, and that event is
        // precisely what ended the old one.
        await this.close(interval.id, observation.since, 'resumed');
        result.resumed += 1;
        await this.open(observation);
        result.opened += 1;
        result.open += 1;
        continue;
      }

      if (judged.has(interval.runId)) {
        // Looked at, and no longer making no progress. Closed at the event
        // that brought it back rather than at this tick, so a resume that
        // happened 50 seconds ago is not billed as 50 seconds of dead time.
        await this.close(
          interval.id,
          latest(interval.run.lastEventAt ?? now, interval.startedAt),
          'resumed',
        );
        result.resumed += 1;
        continue;
      }

      // Not judged this sweep. Left open — see the class comment.
      result.open += 1;
    }

    for (const observation of observations) {
      if (handled.has(observation.runId)) continue;
      await this.open(observation);
      result.opened += 1;
      result.open += 1;
    }

    if (result.opened > 0 || result.resumed > 0 || result.concluded > 0) {
      this.logger.log(
        `Dead time: ${result.opened} interval(s) opened, ${result.resumed} closed as resumed, ` +
          `${result.concluded} as concluded, ${result.quarantined} as quarantined; ` +
          `${result.open} still open`,
      );
    }

    return result;
  }

  private async open(observation: DeadObservation): Promise<void> {
    await this.prisma.deadInterval.create({
      data: {
        runId: observation.runId,
        kind: observation.kind as never,
        startedAt: observation.since,
      },
    });
  }

  /**
   * Close one interval, guarded on it still being open.
   *
   * The guard is in the WHERE clause rather than a read-then-compare, in the
   * idiom of `run-events.service.ts`: two ticks overlapping — which the
   * reconciler's lease makes unlikely but not impossible — must produce one
   * close, and the first one must win. A second close would otherwise move the
   * end time and change a duration that was already reported.
   */
  private async close(
    id: string,
    endedAt: Date,
    endedBy: 'resumed' | 'concluded' | 'quarantined',
  ): Promise<void> {
    await this.prisma.deadInterval.updateMany({
      where: { id, endedAt: null },
      data: { endedAt, endedBy: endedBy as never },
    });
  }
}

/**
 * The later of two instants.
 *
 * Every close runs through this so an interval can never end before it began.
 * A negative duration is not a small error — it would SUBTRACT from the
 * window's dead time and make a bad day look better than a good one. The
 * inputs that can go backwards are real: `lastEventAt` only moves forward, but
 * a run concluding on an `occurredAt` the runner stamped from its own clock
 * can land before the stall's start.
 */
function latest(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}
