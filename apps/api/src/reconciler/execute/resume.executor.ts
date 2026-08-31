import { Injectable, Logger } from '@nestjs/common';

import { RunExecutorService } from '../../dispatch/run-executor.service';
import type { ReconcileAction } from '../diff/actions.types';
import type { DesiredState } from '../projection/desired-state.types';

export interface ResumeExecutionOutcome {
  /** Parked runs actually handed back to their runner. */
  resumed: number;
  /** Resumes a gate refused. Not failures — the gates working is the point. */
  refused: number;
  /** Would have resumed, but `dispatch.enabled` is off. */
  observed: number;
  /**
   * Resumes not attempted because this tick could not vouch for the issue.
   *
   * Its own count rather than folded into `refused`, because it means
   * something different for an operator: a refusal is the factory deciding,
   * this is the factory declining to decide on stale information. Persistently
   * non-zero means a repository is failing to observe, and the parked runs in
   * it are quietly waiting on that rather than on their quota.
   */
  unobserved: number;
  failures: { action: ReconcileAction; reason: string }[];
}

/**
 * Executes the watchdog's `resume` actions (#477).
 *
 * ## The gap this closes
 *
 * `decideParking` has computed `park` and `resume` decisions since #56, and
 * `actionsForParking` has turned them into actions of those types ever since.
 * Nothing consumed one. `MirrorLabelExecutor` is documented to ignore every
 * action type that is not a label, which it does, and three comments in the
 * watchdog pointed forward to #61 and #66 as the issues that would wire the
 * dispatch half — both of which had closed. #66 in particular closed with the
 * criterion *"auto-resume works end to end without human involvement"* unmet,
 * so the trail read as finished while the behaviour did not exist. This class
 * is the consumer those comments now point at.
 *
 * ## Why `park` is counted here and executed elsewhere
 *
 * A `park` is not an outward action. It changes nothing outside the control
 * plane: it schedules a time, and the only thing that reads that schedule is
 * the next watchdog tick. `WatchdogService.sweepBlocked` therefore persists it
 * itself, and deliberately keeps doing so, for a reason this class could not
 * satisfy — the acting phase is skipped on a tick whose projection failed, and
 * a park that did not persist would be RE-DRAWN with fresh jitter next tick.
 * `decideParking` says what that costs: the run would chase its own jitter and
 * never actually resume. Persisting the schedule where the schedule is decided
 * is what makes the decision idempotent across ticks.
 *
 * So a `park` action passes through this executor and is deliberately not
 * acted on — explicitly, in a branch that says so, rather than by falling
 * through a filter. It is also not COUNTED: `WatchdogSweepResult.parkedRuns`
 * already reports that number from the component that produced it, and a
 * second tally here would be a second source of truth for one fact.
 *
 * The resume is the opposite in every respect: it spends real money against a
 * real subscription with nobody watching, which is precisely the kind of act
 * VISION §12 keeps out of the component that decides and puts behind an
 * executor the task calls explicitly.
 *
 * ## The hold gate, and why it is here rather than in the executor below
 *
 * *"A `factory:hold` applied while the run was parked prevents the resume"* is
 * one of this issue's criteria, and it cannot be answered from the run's own
 * rows. `WorkOrderProjectionService.HOLDABLE_STATUSES` moves only `queued` and
 * `held` work orders, on the stated grounds that flipping a `dispatched` one
 * would make its authorization record describe something untrue — so a hold
 * applied to an issue whose run is parked never reaches the database at all.
 * It lives on the issue, and the reconciler's from-scratch projection is what
 * reads issues.
 *
 * So the gate is the projection's own intent, and the rule is the strict one:
 * **resume only an issue this tick projected as `blocked`.** That intent's
 * definition is literally *"parked with a reset time; the watchdog resumes
 * it"*. Everything else is a refusal, and each of them is a case where
 * resuming would be wrong:
 *
 *  - `hold` — a human pressed the brake. It dominates every other intent by
 *    construction (`desired-state.ts` checks it first and unconditionally).
 *  - `quarantined` — VISION §8: it cannot clear its own quarantine.
 *  - `ignore` — the issue was closed or `factory:ready` was removed while the
 *    run was parked. Continuing would spend money on abandoned work.
 *
 * ## Fail closed on an issue the tick did not see
 *
 * An issue with no projection entry — its repository failed to observe, or it
 * fell outside what was fetched — is NOT resumed. The whole gate above rests
 * on the projection having looked at the issue this tick, and a missing entry
 * means nobody can say whether the brake is on. The run stays parked and the
 * next tick tries again, which costs one tick interval; guessing costs a run
 * the operator was trying to stop. VISION §4's promise is that *you can always
 * fix the factory by editing GitHub*, and a resume that proceeded on an
 * unread issue would make that false in the one case where somebody is
 * urgently trying to stop something.
 */
@Injectable()
export class ResumeExecutor {
  private readonly logger = new Logger(ResumeExecutor.name);

  constructor(private readonly executor: RunExecutorService) {}

  /**
   * Resume every parked run this tick judged due, and says nothing about.
   *
   * @param actions     the tick's whole action list, watchdog and reconciler
   * @param projections what the tick computed SHOULD be true, per repository
   *
   * Never throws. It runs from the reconciler tick alongside every other
   * outward step, and one parked run must not abandon the ones behind it.
   */
  async execute(
    actions: readonly ReconcileAction[],
    projections: readonly DesiredState[],
  ): Promise<ResumeExecutionOutcome> {
    const outcome: ResumeExecutionOutcome = {
      resumed: 0,
      refused: 0,
      observed: 0,
      unobserved: 0,
      failures: [],
    };

    const intents = intentsByIssue(projections);

    for (const action of actions) {
      // Named rather than left to the filter below, because "the park is
      // ignored here" is a decision with an argument behind it (see the class
      // comment) and not an accident of which types this loop happens to
      // match. `WatchdogService.sweepBlocked` has already persisted it.
      if (action.type === 'park') continue;
      if (action.type !== 'resume') continue;

      if (!action.runId) {
        // A resume with no run is a watchdog bug, not a quota problem.
        // Recorded rather than thrown so one malformed action cannot abandon
        // the rest of the list.
        outcome.failures.push({
          action,
          reason: 'resume action carried no runId',
        });
        continue;
      }

      const intent = intents.get(
        issueKey(action.repository, action.issueNumber),
      );

      if (intent === undefined) {
        outcome.unobserved += 1;
        this.logger.warn(
          `Not resuming run ${action.runId}: this tick has no projection for ` +
            `${action.repository}#${action.issueNumber}, so nothing can say whether a human ` +
            'applied a hold while it was parked. It stays parked until a tick can.',
        );
        continue;
      }

      if (intent !== 'blocked') {
        outcome.refused += 1;
        this.logger.log(
          `Not resuming run ${action.runId}: ${action.repository}#${action.issueNumber} is ` +
            `now '${intent}' rather than 'blocked'`,
        );
        continue;
      }

      try {
        const result = await this.executor.resumeParkedRun(action.runId);
        switch (result.outcome) {
          case 'resumed':
            outcome.resumed += 1;
            break;
          case 'observed':
            outcome.observed += 1;
            break;
          case 'refused':
            outcome.refused += 1;
            break;
          case 'failed':
            // The executor already marked the run failed and recorded why.
            // Surfaced here as well so the tick row carries it: a resume that
            // killed a run is exactly the entry an operator reviewing the
            // night's ticks needs to find without opening a container log.
            outcome.failures.push({ action, reason: result.reason });
            break;
        }
      } catch (error) {
        // `resumeParkedRun` is written not to throw; this catches anyway,
        // because an exception escaping here would abandon every parked run
        // behind this one.
        outcome.failures.push({
          action,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.log(outcome);
    return outcome;
  }

  private log(outcome: ResumeExecutionOutcome): void {
    if (outcome.resumed === 0 && outcome.failures.length === 0) return;

    this.logger.log(
      `Resumes: ${outcome.resumed} run(s) resumed, ${outcome.refused} refused, ` +
        `${outcome.unobserved} left parked for want of an observation, ` +
        `${outcome.failures.length} failed`,
    );
  }
}

/**
 * `repository#issue` → the intent this tick computed for it.
 *
 * Flattened once per tick rather than searched per action: a fleet with fifty
 * parked runs across five repositories would otherwise scan every projection
 * for every one of them.
 */
function intentsByIssue(
  projections: readonly DesiredState[],
): Map<string, string> {
  const intents = new Map<string, string>();
  for (const projection of projections) {
    for (const issue of projection.issues) {
      intents.set(
        issueKey(projection.repository, issue.issueNumber),
        issue.intent,
      );
    }
  }
  return intents;
}

function issueKey(repository: string, issueNumber: number): string {
  return `${repository}#${issueNumber}`;
}
