import type { StreamingFidelity } from './watchdog.types';

/**
 * One `run.progress` event's tool detail, oldest first.
 *
 * Only progress events carry a tool, and only from a runner whose streaming
 * fidelity supplies one — which is why this check is unavailable rather than
 * merely quiet for some runners. See `LoopVerdict.available`.
 */
export interface ToolObservation {
  /** `Bash:sha256:9f2c...` — the name and argument digest, as ingested. */
  signature: string;
  occurredAt: Date;
}

export interface LoopVerdict {
  /**
   * Whether the check could run at all.
   *
   * #55: "Runners without the required streaming fidelity report that this
   * check is unavailable, rather than appearing to pass it." A looping run on
   * a non-streaming runner is undetectable here, and saying "no loop found"
   * about it would be a false negative dressed as a clean bill of health.
   */
  available: boolean;
  looping: boolean;
  /** The signature that repeated, when one did. */
  signature: string | null;
  /** How many times in a row. */
  repeats: number;
  /** Why, naming the signature and the count. */
  reason: string;
}

/**
 * How many identical signatures in a row count as a loop.
 *
 * Tuned against the failure mode #55 names: a legitimate test-fix-retest cycle
 * repeats a signature, so the threshold has to sit above normal iteration.
 * Three identical calls is still plausibly a person debugging; six in a row
 * with nothing else between them is not a cycle, it is a loop.
 */
export const DEFAULT_LOOP_REPEATS = 6;

/**
 * The window this examines.
 *
 * Bounded because an unbounded scan of a long run's event stream would grow
 * with the run, and because a signature repeated an hour apart is not a loop —
 * it is a run that came back to the same tool, which is normal.
 */
export const DEFAULT_LOOP_WINDOW = 40;

/**
 * Detect a repeating tool signature.
 *
 * ## Why this is a separate check from silence
 *
 * VISION §9 warns that collapsing the three failure modes is the most common
 * supervision bug, and a looping run is the one that most resembles a healthy
 * one: **events are flowing**. Event-age detection (#54) will never fire on
 * it, and a wall-clock timeout eventually kills it having burned the entire
 * budget first.
 *
 * ## Consecutive, not merely frequent
 *
 * The check is for the same signature repeating with NOTHING ELSE between the
 * repeats. That is what separates a loop from a test-fix-retest cycle: the
 * cycle runs the tests, edits a file, runs the tests again — so the test
 * signature recurs often, but never consecutively. Counting frequency rather
 * than consecutiveness would kill exactly the legitimate iteration #55
 * requires be spared.
 */
export function detectLoop(
  fidelity: StreamingFidelity | null,
  observations: ToolObservation[],
  options: { repeats?: number; window?: number } = {},
): LoopVerdict {
  // A runner that cannot report tool detail cannot be checked. Reporting that
  // honestly is the requirement; reporting "no loop" would be a false negative
  // presented as a clean result.
  if (fidelity !== 'full') {
    return {
      available: false,
      looping: false,
      signature: null,
      repeats: 0,
      reason:
        `loop detection unavailable: it needs per-tool progress events, which a runner with ` +
        `${fidelity ?? 'undeclared'} streaming fidelity does not report`,
    };
  }

  const threshold = options.repeats ?? DEFAULT_LOOP_REPEATS;
  const window = options.window ?? DEFAULT_LOOP_WINDOW;
  const recent = observations.slice(-window);

  if (recent.length < threshold) {
    return {
      available: true,
      looping: false,
      signature: null,
      repeats: recent.length,
      reason: `no loop: only ${recent.length} tool event(s), fewer than the ${threshold} needed to conclude one`,
    };
  }

  // Walk backwards from the newest. A loop that has since broken is not a
  // loop any more — the run moved on, and killing it for a pattern it has
  // already escaped would destroy work for nothing.
  const newest = recent[recent.length - 1].signature;
  let run = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i].signature !== newest) break;
    run += 1;
  }

  if (run < threshold) {
    return {
      available: true,
      looping: false,
      signature: null,
      repeats: run,
      reason:
        `no loop: the most recent signature repeats ${run} time(s) consecutively, ` +
        `below the threshold of ${threshold}`,
    };
  }

  return {
    available: true,
    looping: true,
    signature: newest,
    repeats: run,
    reason:
      `looping: ${newest} repeated ${run} times consecutively with no other tool call between ` +
      `them, at or past the threshold of ${threshold}`,
  };
}
