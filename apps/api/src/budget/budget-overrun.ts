/**
 * Has a run spent more than its work order allowed? (#182)
 *
 * A pure function, like `spend-admission.ts` and `run-deadline.ts`, for the
 * reason VISION §3.6 gives: enforcement lives in deterministic policy, and
 * deterministic policy can be pinned to its boundary without a clock or a
 * database.
 *
 * ## What this can and cannot do, stated rather than implied
 *
 * `claude-code-local` reports cost **once, on its final `result` line** — the
 * per-message `usage` is a streaming snapshot, not a running total, and
 * summing it produces a number that is simply wrong. So for the only runner
 * that exists today, a dollar figure does not arrive until the money is
 * already spent, and the `stoppable` arm of this policy will never fire for
 * it.
 *
 * That is not a reason to skip the arm, and not a reason to pretend it works
 * either. A runner reporting incrementally is stopped; one reporting terminally
 * is recorded and escalated. The verdict carries which of the two happened so
 * nothing downstream — #66's retry decision above all — has to guess. A run
 * that was stopped for its budget and a run that quietly passed it are
 * different facts, and collapsing them loses the one that predicts the next
 * attempt.
 */

export interface OverrunInputs {
  /**
   * What the run has reported spending so far.
   *
   * Null means nothing has reported a cost, which is NOT zero: the capability
   * manifest's `reportsCost` exists to keep those apart, and a run that has
   * told us nothing cannot be judged against a ceiling.
   */
  costUsd: number | null;
  /** The work order's ceiling. Null means it names none. */
  ceilingUsd: number | null;
  /**
   * Whether the run can still be stopped.
   *
   * The caller's fact, not this function's to infer: it depends on the run's
   * status AND on whether this process still holds a handle for it, and #60
   * forbids reconstructing the latter.
   */
  runIsLive: boolean;
}

export type OverrunVerdict =
  | { over: false }
  | {
      over: true;
      costUsd: number;
      ceilingUsd: number;
      /** How far past. The figure #65 requires the record to name. */
      overspendUsd: number;
      /** Whether anything can still be done about it. */
      stoppable: boolean;
      /**
       * The facts, and ONLY the facts.
       *
       * Says nothing about what was done, because this runs before anything is
       * attempted and cannot know. `run-deadline.ts` learned this the
       * expensive way: its reason once ended "so the control plane cancelled
       * it" and printed that for three runs the control plane could not reach.
       * The caller appends the outcome once it is one.
       */
      reason: string;
    };

export function decideBudgetOverrun(inputs: OverrunInputs): OverrunVerdict {
  const { costUsd, ceilingUsd } = inputs;

  // Nothing reported. Not "spent nothing" — unknown, and an unknown cannot
  // pass a ceiling. The spend ledger counts these conservatively at the
  // ORDER's ceiling (#177); that is a different question from this one.
  if (costUsd === null) return { over: false };

  // No ceiling to pass. Whether an order should be allowed to name none is
  // the admission gate's question (#177), asked before the run started.
  if (ceilingUsd === null) return { over: false };

  // `<=`, not `<`. A ceiling of $5 authorizes spending $5; it forbids
  // spending FROM $5. Same rule as the admission gate's projection check, and
  // deliberately the opposite of its tally check — read both together.
  if (costUsd <= ceilingUsd) return { over: false };

  const overspendUsd = round(costUsd - ceilingUsd);

  return {
    over: true,
    costUsd,
    ceilingUsd,
    overspendUsd,
    stoppable: inputs.runIsLive,
    reason:
      `Reported ${usd(costUsd)} against a budget ceiling of ${usd(ceilingUsd)} — ` +
      `${usd(overspendUsd)} over.`,
  };
}

// ---------------------------------------------------------------------------

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
