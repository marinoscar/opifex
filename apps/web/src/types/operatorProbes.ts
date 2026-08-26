/**
 * The Test buttons' wire shapes (#349, epic #332).
 *
 * A mirror of `apps/api/src/settings/operator-settings/dto/operator-probe.dto.ts`.
 * Three of its distinctions are load-bearing here and must not be collapsed on
 * the way to the screen:
 *
 *  - **`ok: false` is an ANSWER, not an error.** A rejected token, a missing
 *    binary and an unauthenticated CLI are all things the operator pressed a
 *    button to go and find out. The endpoint answers 2xx for every one of
 *    them, so a red panel here means "we asked and the answer was no" —
 *    never "the request failed".
 *  - **`skipped: true` is a third state.** The probe did not run at all: rate
 *    limited, or nothing configured to probe. Drawing it as a failure would
 *    tell an operator their credential is bad when nothing has tested it.
 *  - **`checkedAt` is the API's clock, not the browser's.** It is rendered
 *    verbatim because it is what makes a result an observation with an age
 *    rather than a status.
 *
 * `rateLimit` is present on the two probes that spend real money, on every
 * result rather than only on a refusal — the UI has to be able to say "3 of 5
 * left" BEFORE the allowance runs out, which is the whole point of the API
 * carrying it.
 */

/** The closed set of probes, in `PROBE_NAMES` order. */
export type OperatorProbeName =
  | 'github-token'
  | 'github-repo'
  | 'claude-cli'
  | 'git'
  | 'claude-credential'
  | 'supervisor-model';

/** What an operator is allowed to spend on the two probes that cost money. */
export interface ProbeRateLimit {
  limit: number;
  windowSeconds: number;
  /** Calls still available in the current window, after this one. */
  remaining: number;
  resetSeconds: number;
}

/** `{ probe, ok, detail, checkedAt, skipped, rateLimit? }`, exactly. */
export interface OperatorProbeResult {
  probe: OperatorProbeName;
  ok: boolean;
  detail: string;
  /** ISO-8601, from the API. */
  checkedAt: string;
  skipped: boolean;
  rateLimit?: ProbeRateLimit;
}
