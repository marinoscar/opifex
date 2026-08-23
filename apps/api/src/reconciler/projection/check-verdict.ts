import type { NormalizedCheck } from '../../github/read/github-read.types';
import type { CheckVerdict } from './desired-state.types';

/**
 * Reduce CI's many answers to the one the surfacing gate asks (#107).
 *
 * VISION §10 makes green CI "a hard gate before any PR is surfaced for human
 * review", so the rule is stated as a gate rather than as a tally:
 *
 * - **passing** — every check has completed, and each concluded `success`,
 *   `neutral` or `skipped`.
 * - **failing** — a check completed with anything else.
 * - **pending** — a check has not completed, or none reported at all.
 *
 * Two of those groupings are judgement calls worth naming.
 *
 * `cancelled`, `timed_out` and `action_required` count as **failing** rather
 * than pending, because none of them will ever become a pass on its own and a
 * gate that waits forever is indistinguishable from a broken factory. They did
 * not pass, and "did not pass" is the whole question.
 *
 * `neutral` and `skipped` count as **passing** because that is what they mean
 * to GitHub's own merge protection: a skipped job in a conditional workflow is
 * the normal case, not a failure, and treating it as one would hold every pull
 * request that did not touch every path.
 *
 * An empty list is `pending`, never `passing`. A repository with no CI and one
 * whose Actions have not started yet are indistinguishable from here, and of
 * the two ways to be wrong, surfacing work whose CI had not started is the one
 * #107 exists to prevent.
 */
export function summarizeChecks(checks: NormalizedCheck[]): CheckVerdict {
  if (checks.length === 0) return 'pending';

  const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

  let sawIncomplete = false;
  for (const check of checks) {
    if (check.status !== 'completed' || check.conclusion === null) {
      sawIncomplete = true;
      continue;
    }
    // Failing wins immediately: one red check is enough to hold the pull
    // request, and there is nothing a later green one can do about it.
    if (!PASSING_CONCLUSIONS.has(check.conclusion)) return 'failing';
  }

  return sawIncomplete ? 'pending' : 'passing';
}

/** The checks that are holding or blocking, for a reason string. */
export function failingCheckNames(checks: NormalizedCheck[]): string[] {
  const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
  return checks
    .filter(
      (check) =>
        check.status === 'completed' &&
        check.conclusion !== null &&
        !PASSING_CONCLUSIONS.has(check.conclusion),
    )
    .map((check) => check.name);
}
