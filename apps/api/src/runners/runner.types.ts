import type { RunEventPayload } from '../run-events/run-event.types';

/**
 * The four types the seam speaks, and nothing vendor-specific among them.
 *
 * VISION §6 argues the obvious abstraction is the wrong one:
 *
 * > The instinct — `ICodingAgent.execute(task)` with adapters underneath —
 * > fails, because coding agents do not differ superficially. They differ in
 * > **invocation model, execution locus, and observability surface**. An
 * > interface wide enough to cover all of them leaks one vendor's semantics
 * > everywhere; narrow enough to be honest, it is useless.
 *
 * What they genuinely share is only: a repository at a commit plus a task spec
 * → a branch and some trace of what happened. That is what these types say and
 * all they say.
 */

// ---------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------

/**
 * A unit of work, as a runner receives it.
 *
 * ## It never names a runner
 *
 * VISION §6: *"work orders never name a runner."* There is no `runner` field
 * here and there must never be one — routing matches `needs` against
 * advertised capabilities (#64), which is what keeps a work order a
 * description of the WORK rather than a description of who does it. A work
 * order that names its runner cannot be re-dispatched to a different one when
 * the first is at capacity, which is most of the value of having a seam.
 */
export interface WorkOrderSpec {
  /**
   * `wo_<repo>_<issue>_<baseCommit>_a<attempt>` — stable and content-addressed
   * (#62). The runner may use it as an idempotency key: re-submitting the same
   * identity must not produce a second branch.
   */
  identity: string;

  /**
   * The control plane's `Run` id for THIS execution, as a UUID.
   *
   * Distinct from `identity`, and the distinction matters: the identity names
   * the WORK and is stable across executions, while this names one attempt at
   * it. A work order dispatched, killed and re-dispatched keeps its identity
   * and gets a new `runId`.
   *
   * It is passed IN rather than returned by `submit` because the execution
   * record is written before dispatch (#63) — there has to be a row to attach
   * an event to before the first event can arrive. The runner stamps it on
   * every event it emits, which is what lets ingestion correlate them:
   * `POST /runs/:runId/events` rejects a batch whose events claim a different
   * run, and `run-event.schema.json` requires the field be a UUID.
   *
   * Note this is NOT `RunHandle.externalId`. That one is the runner's own
   * identifier and is opaque to everything here; this one is ours.
   */
  runId: string;

  repository: { owner: string; name: string };
  /**
   * The commit the work starts from, pinned.
   *
   * The whole recovery model rests on this. VISION §3.4: recovery is
   * abandon-and-re-run FROM THE PINNED BASE, not session resumption — which is
   * what keeps the system vendor-neutral, because cross-agent session state
   * then never has to exist.
   */
  baseCommit: string;
  /** The branch the runner must create and push to. */
  branch: string;

  /** What to do, in prose, and how anyone will know it is done. */
  taskSpec: string;
  acceptanceCriteria: string[];

  /** Globs the runner may write within. Empty means the whole repository. */
  pathConstraints: string[];

  /**
   * Ceilings the runner should respect, and which the control plane enforces
   * anyway.
   *
   * Advisory here on purpose: VISION §3.6 puts enforcement in deterministic
   * policy (#65), never in the runner's own judgement. A runner that honours
   * them stops sooner and more gracefully; one that ignores them is still
   * stopped.
   */
  budgetCeilingUsd: number | null;
  wallClockTimeoutMinutes: number | null;

  /**
   * What this work needs from a runner, matched against capabilities (#64).
   *
   * Declared as needs rather than as a runner name — that indirection IS the
   * seam. Empty means anything enabled will do.
   */
  needs: RunnerNeed[];
}

/**
 * A capability a work order requires.
 *
 * A closed union rather than free strings: a need nothing advertises must fail
 * to compile or fail loudly at routing, not silently match everything.
 */
export type RunnerNeed =
  /** The run must be observable per tool call — loop detection needs it (#55). */
  | 'full-streaming'
  /** The runner must report cost, for budget enforcement to mean anything. */
  | 'cost-reporting'
  /** The runner must report rate limits structurally, so parking can be dated. */
  | 'structured-rate-limits'
  /** The work must not leave the operator's own infrastructure. */
  | 'own-infrastructure';

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/**
 * A runner's handle on a submitted run.
 *
 * Deliberately opaque. `externalId` is whatever the runner needs to find the
 * work again — a PID, a job id, a URL — and NOTHING in the control plane may
 * parse it. The moment dispatch logic reads inside this string, the seam has
 * leaked and swapping runners means touching dispatch, which #60's first exit
 * criterion forbids.
 */
export interface RunHandle {
  /** Which runner issued it. Its `Runner.key`. */
  runnerKey: string;
  /** The runner's own identifier for the run. Opaque to everything else. */
  externalId: string;
  /** The work order this handle is for, so a lost handle can be recognised. */
  workOrderIdentity: string;
}

/**
 * Where a run has got to, in the control plane's vocabulary.
 *
 * Mirrors the six normalized run-event types rather than inventing a parallel
 * vocabulary: a runner that reports a status the events cannot express would
 * be a second source of truth about the same run.
 */
export type RunnerRunStatus =
  | 'running'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  /** The runner has no record of this handle. See `poll` below. */
  | 'unknown';

/**
 * One `poll`.
 *
 * ## Why events, and why normalized
 *
 * #60: *"`poll` returns normalized events (#33), never a runner's native
 * format."* If a native format reached the control plane, every consumer —
 * watchdog, liveness, loop detection, cost — would need a per-runner branch,
 * and the seam would exist in name only. Normalizing is the adapter's job,
 * and doing it at the boundary is what keeps everything upstream vendor-blind.
 */
export interface RunPollResult {
  status: RunnerRunStatus;
  /**
   * Events observed since the last poll, oldest first.
   *
   * `eventId` is sender-chosen, so re-delivering an event the control plane
   * already has is safe and expected — ingestion is idempotent on
   * `(runId, eventId)` (#53). An adapter that cannot track what it has already
   * returned should return everything rather than risk dropping an event.
   */
  events: RunEventPayload[];
}

/**
 * What a runner can do, as a declaration.
 *
 * ## The pressure valve
 *
 * #60 predicts the pressure on this design: *"the pressure will be to widen it
 * the moment `claude-code-local` wants something specific. Resist that:
 * anything vendor-specific belongs in the capability manifest as a
 * DECLARATION, not in the seam as a method."*
 *
 * So this type is where a runner's peculiarities go. Adding a field here is
 * cheap and honest. Adding a fifth function to the seam is not, and requires
 * an ADR.
 */
export interface RunnerCapabilities {
  key: string;
  displayName: string;
  version: string;
  schemaVersion: string;

  /** How the runner is invoked. */
  invocationModel: 'process' | 'http_api' | 'hosted_job';
  /** Whose hardware the work runs on. */
  executionLocus: 'own_infrastructure' | 'vendor_cloud';
  /**
   * How much of what it is doing Opifex can see.
   *
   * Drives the watchdog's silence thresholds (#54) and gates loop detection
   * (#55) — a runner declaring less than `full` reports loop detection
   * UNAVAILABLE rather than appearing to pass it.
   */
  streamingFidelity: 'full' | 'partial' | 'none';
  /** Whether a rate limit arrives with a reset time or has to be guessed at. */
  rateLimitSignal: 'structured' | 'heuristic' | 'none';
  stabilityTier: 'experimental' | 'beta' | 'stable';

  /** Cost reporting is a capability, so "unknown" and "zero" stay different. */
  reportsCost: boolean;

  /**
   * Vendor-specific session resumption, if this runner has it.
   *
   * VISION §3.4 allows it as an OPTIMIZATION and forbids it being
   * load-bearing: recovery is always abandon-and-re-run from the pinned base,
   * and a runner that declares `resumable: true` may shortcut that. Nothing in
   * the control plane may require it, which is exactly why it is a boolean
   * here and not a fifth function on the seam.
   */
  resumable: boolean;

  /** How many runs this runner will take at once. The concurrency gate (#64). */
  maxConcurrency: number;
  /** Branch globs the runner is allowed to create, e.g. `factory/*`. */
  branchPatterns: string[];

  /** The raw manifest, kept verbatim for the record. */
  manifest: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * Four functions. Adding a fifth requires an ADR.
 *
 * ```
 * submit(WorkOrder) -> handle
 * poll(handle)      -> status + events
 * cancel(handle)    -> void
 * capabilities()    -> RunnerCapability
 * ```
 *
 * This is the CI-runner pattern, and the analogy is load-bearing: GitHub
 * Actions does not abstract over compilers, it abstracts over jobs. It knows
 * how to start one, ask how it is going, stop it, and what the machine can do
 * — and nothing whatsoever about what runs inside.
 *
 * ## What is NOT here, and why
 *
 * No `resume`. Recovery is abandon-and-re-run from the pinned base commit
 * (VISION §3.4); a runner with real resumption declares `resumable` and may
 * use it internally, but the control plane never asks for it. That is what
 * keeps cross-agent session state from ever having to exist.
 *
 * No `getLogs`, no `getCost`, no `getBranch`. All three are events, and events
 * arrive through `poll`. A second retrieval path would be a second source of
 * truth about one run.
 *
 * No `configure`, no `setOptions`. Configuration is the adapter's constructor
 * and the capability manifest. A setter on the seam is how one vendor's
 * options end up in dispatch logic.
 */
export interface Runner {
  /**
   * Start the work. Returns a handle, or throws.
   *
   * **Must be idempotent on `identity`.** #18's exit criteria are explicit:
   * *"re-running the same work order is idempotent — the runner checks whether
   * its branch already exists before doing anything."* Re-submitting an
   * identity that is already running returns the existing handle rather than
   * starting a second run on the same branch.
   */
  submit(workOrder: WorkOrderSpec): Promise<RunHandle>;

  /**
   * Ask how it is going.
   *
   * Returns `status: 'unknown'` for a handle the runner does not recognise,
   * rather than throwing. A runner restarted between submit and poll has lost
   * the run, and that is a fact the watchdog must be able to observe — an
   * exception would be indistinguishable from the runner being down, and the
   * two call for different responses.
   */
  poll(handle: RunHandle): Promise<RunPollResult>;

  /**
   * Stop it.
   *
   * **Idempotent, and never throws for an already-stopped run.** Cancel is
   * what the watchdog reaches for when a run has gone silent, and a cancel
   * that throws because the run is already dead would turn recovery into an
   * error path at exactly the wrong moment.
   */
  cancel(handle: RunHandle): Promise<void>;

  /**
   * What this runner can do.
   *
   * Called by registration and by routing. Must not depend on any particular
   * run, and must be cheap enough to call on a tick.
   */
  capabilities(): Promise<RunnerCapabilities>;
}

/**
 * The seam's surface, as data, so a test can assert it.
 *
 * #60's first acceptance criterion — *"exactly four functions; adding a fifth
 * requires an ADR"* — is only enforceable if something checks. A spec asserts
 * an implementation's prototype against this list, which turns "we agreed not
 * to widen it" into a failing build.
 */
export const RUNNER_SEAM_METHODS = ['submit', 'poll', 'cancel', 'capabilities'] as const;
