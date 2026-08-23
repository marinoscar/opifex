/**
 * When has a run been going on too long? (#180)
 *
 * A pure function, for the reason `spend-admission.ts` is one: VISION §3.6
 * puts enforcement in deterministic policy, and deterministic policy can be
 * pinned to its boundary without a clock, a database or a container.
 *
 * ## Why the control plane has a deadline at all when the runner has one
 *
 * The seam's `submit` contract already says it:
 *
 * > Ceilings the runner should respect, and which the control plane enforces
 * > anyway. [...] A runner that honours them stops sooner and more gracefully;
 * > one that ignores them is still stopped.
 *
 * Until this existed, the second half was false. `claude-code-local` enforces
 * its own deadline with an in-process timer and that was the entirety of
 * wall-clock enforcement — so a second runner would have had to reimplement
 * it, one that did not implement it would have run unbounded, and one whose
 * timer logic was wrong would have failed silently in the direction that costs
 * money.
 *
 * ## Why there is a grace period
 *
 * So this is a BACKSTOP and not a race. Firing at the same instant as the
 * runner's own timer would have the control plane's cancel arrive while the
 * runner is already killing its own process, producing two conflicting reasons
 * for one stop and making the logs unreadable at exactly the moment somebody
 * is reading them. The runner gets first refusal; the control plane steps in
 * only when it demonstrably did not take it.
 */

/**
 * The margin, in minutes, after the runner's own limit.
 *
 * Two minutes: comfortably longer than `RUNNER_KILL_GRACE_MS` (ten seconds of
 * SIGTERM grace before SIGKILL) plus the poll interval, so a runner that IS
 * shutting down cleanly always finishes first. Short enough that a runner
 * which ignored its deadline entirely is not left running for a meaningful
 * fraction of another one.
 */
export const DEFAULT_DEADLINE_GRACE_MINUTES = 2;

export interface DeadlineInputs {
  /** When the run row was created. The only start time the control plane has. */
  startedAt: Date;
  /** The work order's own ceiling. Null means it names none. */
  timeoutMinutes: number | null;
  /**
   * The fallback when the order names none.
   *
   * This must be the SAME value the runner reads, or the two disagree about
   * when a run is late and the grace period stops meaning what it says. There
   * is deliberately no second configuration key for it.
   *
   * Null means genuinely unbounded, which is a deliberate operator choice
   * rather than an oversight — and one this function honours rather than
   * substituting a number for.
   */
  defaultTimeoutMinutes: number | null;
  /** Minutes past the limit before the control plane acts. */
  graceMinutes: number;
}

export type DeadlineVerdict =
  | {
      overdue: false;
      /** Null when nothing bounds this run at all. */
      limitMinutes: number | null;
      elapsedMinutes: number;
    }
  | {
      overdue: true;
      /** The limit that was passed — the order's, or the default. */
      limitMinutes: number;
      /** `limitMinutes + graceMinutes`: when the control plane became willing to act. */
      enforcedAfterMinutes: number;
      elapsedMinutes: number;
      /** One line naming both figures, for `attentionReason`. */
      reason: string;
    };

/**
 * `now` is a parameter, never `new Date()` inside.
 *
 * The same rule the spend ledger follows: a deadline whose boundary cannot be
 * pinned to an instant cannot be tested at its boundary, and the boundary is
 * the only part of a deadline anyone gets wrong.
 */
export function decideDeadline(inputs: DeadlineInputs, now: Date): DeadlineVerdict {
  const elapsedMinutes = round(
    (now.getTime() - inputs.startedAt.getTime()) / MS_PER_MINUTE,
  );

  const limitMinutes = inputs.timeoutMinutes ?? inputs.defaultTimeoutMinutes;

  // Unbounded by construction. Reported as such rather than silently given a
  // number: an operator who set no default and no ceiling has said something,
  // and inventing a limit here would enforce a policy nobody wrote.
  if (limitMinutes === null || limitMinutes <= 0) {
    return { overdue: false, limitMinutes: null, elapsedMinutes };
  }

  const enforcedAfterMinutes = limitMinutes + Math.max(0, inputs.graceMinutes);

  // Strictly greater. A run at exactly the enforcement mark has not yet
  // exceeded it, and the runner's own kill may be landing this very instant --
  // which is the whole point of the grace period.
  if (elapsedMinutes <= enforcedAfterMinutes) {
    return { overdue: false, limitMinutes, elapsedMinutes };
  }

  return {
    overdue: true,
    limitMinutes,
    enforcedAfterMinutes,
    elapsedMinutes,
    reason:
      `Ran for ${elapsedMinutes} minute(s) against a wall-clock ceiling of ` +
      `${limitMinutes} minute(s). Its runner did not stop it within the ` +
      `${inputs.graceMinutes}-minute grace period, so the control plane cancelled it.`,
  };
}

// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60 * 1000;

/** To one decimal place — the precision a duration in minutes is read at. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
