/**
 * Opifex domain types for the cockpit.
 *
 * Epic #19, VISION §9. **Only `RunStatus` lives here for now.** The rest of the
 * cockpit vocabulary (`RunSummary`, `WorkOrderRef`, `QueueEntry`, `RunEvent`,
 * `MetricsSummary`) lands with the data-layer stage, alongside the hooks and
 * the `services/api.ts` functions that produce them — there is no runs/queue/
 * metrics endpoint in `apps/api` yet, so declaring their shapes now would be
 * guessing at a contract nobody has written.
 *
 * `RunStatus` is the exception because it is needed *before* any data exists:
 * it is the vocabulary the status color tokens (`theme/tokens.ts`) and the
 * status registry (`config/runStatus.ts`) are keyed by, and both of those are
 * pure, testable, and useful on their own.
 */

/**
 * The lifecycle state of a run, as the operator reads it.
 *
 * Derived from VISION §9's "three failure modes, three responses" plus the two
 * non-failure states, and deliberately NOT a mirror of the six normalized
 * event types (`run.started`, `run.heartbeat`, `run.progress`, `run.blocked`,
 * `run.completed`, `run.failed`). Events are what the runner reports; a status
 * is what the control plane concluded. `stalled` and `quarantined` have no
 * corresponding event at all — they are watchdog and policy verdicts, which is
 * exactly why the two vocabularies must not be collapsed into one.
 *
 *  - `running`     — events are flowing; nothing to do
 *  - `succeeded`   — completed, pull request open
 *  - `stalled`     — silent or looping; the response is to kill and re-run
 *  - `blocked`     — parked with a reset time; auto-resumes without a human
 *  - `failed`      — terminal failure
 *  - `quarantined` — needs a human; by §8 it cannot clear its own quarantine
 */
export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'stalled'
  | 'blocked'
  | 'failed'
  | 'quarantined';

/**
 * Every `RunStatus`, in the order the cockpit lists them: healthy first, then
 * the three failure modes in escalation order, with `quarantined` last because
 * it is the only one that cannot resolve itself.
 *
 * Exported as a value (not just a type) so tests can be **exhaustive over the
 * union** — a `Record<RunStatus, …>` catches a missing key at compile time,
 * but only iterating a runtime list catches a key that exists and is wrong.
 */
export const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'succeeded',
  'blocked',
  'stalled',
  'failed',
  'quarantined',
];
