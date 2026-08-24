/**
 * Opifex domain types for the cockpit.
 *
 * Epic #19. VISION §4 (work orders), §9 (statuses and the normalized event
 * floor) and §10 (the six success metrics) are the sources; this file is their
 * TypeScript projection.
 *
 * ## These shapes are a PROPOSAL, not a contract — read this before trusting them
 *
 * `apps/api` has no runs, queue or metrics module and `schema.prisma` has zero
 * domain models, so nothing here has been validated against a wire format.
 * They are modelled on the documents above so the cockpit can be built and
 * tested with honest types instead of `any`, and they are deliberately narrow:
 * every field below exists because a component on the dashboard renders it.
 *
 * What that means in practice: when the first domain endpoint lands, this file
 * is reconciled against the endpoint's response schema in the SAME pull
 * request, and the parse boundary (`services/api.ts`) is where a mismatch must
 * surface — never a component reading `undefined` and drawing a blank.
 *
 * `RunStatus` is the exception to all of the above. It predates the data layer
 * because it is the vocabulary the status color tokens (`theme/tokens.ts`) and
 * the status registry (`config/runStatus.ts`) are keyed by, and both of those
 * are pure, testable, and useful with no API at all.
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
  'running' | 'succeeded' | 'stalled' | 'blocked' | 'failed' | 'quarantined';

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

// ---------------------------------------------------------------------------
// Work orders (VISION §4)
// ---------------------------------------------------------------------------

/**
 * A work order, reduced to what the cockpit displays.
 *
 * The full work order is a large document (task spec, acceptance criteria,
 * path constraints, budget ceiling, provenance links); a run row needs its
 * IDENTITY and a way back to GitHub, and nothing else. Keeping this a `Ref`
 * rather than the whole schema is what stops the dashboard from becoming the
 * place the work-order shape is defined — that lives in
 * `schemas/work-order.schema.json`, which is the actual source of truth.
 *
 * Identity is deterministic (VISION §4):
 *
 *   wo_<repo>_<issue>_<base_commit[0:7]>_a<attempt>
 *   factory/<issue>-<base_commit[0:7]>-a<attempt>
 *
 * Both strings are carried rather than recomputed from the parts, because a
 * UI that re-derives an identifier can disagree with the control plane about
 * what a run IS — and re-run idempotency is built on that string matching
 * exactly. The parts are here for display (a chip reading "#312, attempt 2"),
 * never for reconstruction.
 */
export interface WorkOrderRef {
  /** `wo_opifex_312_a3f91c2_a1`. Rendered in the mono token, always in full. */
  id: string;
  /** The GitHub issue this work order projects. */
  issueNumber: number;
  /** `owner/name`. */
  repository: string;
  /** The pinned base commit, already shortened to 7 characters upstream. */
  baseCommit: string;
  /** 1-based. Attempt count is success metric #4 (VISION §10). */
  attempt: number;
  /** `factory/312-a3f91c2-a1` — the branch a runner checks for before acting. */
  branch: string;
  /** The issue title, for humans. */
  title: string;
  /** Link back to the issue. Null when the projection has no URL yet. */
  issueUrl: string | null;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * A run, as a list row or an attention row renders it.
 *
 * `attentionReason` and `resumesAt` are the two fields that make the
 * escalation panel possible, and they are separate on purpose. VISION §9 gives
 * three failure modes three different responses, and the operator's decision
 * is driven by which of these is populated:
 *
 *  - `attentionReason` set    → a human has to do something (kill, re-plan,
 *                               review a quarantine)
 *  - `resumesAt` set          → the system will handle it; doing anything is
 *                               wasted effort
 *
 * A single "message" field would have collapsed exactly that distinction,
 * which is the most expensive mistake this UI can make.
 */
export interface RunSummary {
  id: string;
  workOrder: WorkOrderRef;
  status: RunStatus;
  /** ISO-8601. */
  startedAt: string;
  /**
   * ISO-8601, or null when nothing has ever been reported. Detection latency
   * (success metric #1) is measured from this, so it is the age the attention
   * panel shows — NOT `startedAt`. A run that has been running happily for
   * six hours is not the problem; one silent for six minutes is.
   */
  lastEventAt: string | null;
  /** One line: what the watchdog concluded, and what the operator should do. */
  attentionReason: string | null;
  /** ISO-8601 reset time for a `blocked` run. Null for every other status. */
  resumesAt: string | null;
  /** Which runner executed it — VISION §6 makes this vendor-neutral. */
  runner: string;
  /** Cumulative spend so far. Null when the runner reports no cost. */
  costUsd: number | null;
  /** Present once the run has opened a pull request. */
  pullRequestUrl: string | null;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * Why a queued work order is not running yet.
 *
 * `held` is deliberately distinct from `waiting`: waiting is a scheduling
 * outcome (something else is ahead of it, or quota is short — VISION §11's
 * shared quota), while held is a POLICY outcome (an approval gate, a trust
 * grant that has not been earned — VISION §8). Waiting clears on its own;
 * held clears when a human acts, and the queue panel has to be able to say
 * which.
 */
export type QueueEntryState = 'waiting' | 'ready' | 'dispatching' | 'held';

export interface QueueEntry {
  id: string;
  workOrder: WorkOrderRef;
  state: QueueEntryState;
  /** 1-based position in dispatch order. */
  position: number;
  /** ISO-8601. */
  enqueuedAt: string;
  /** What must clear first, in one line. Null when nothing blocks it. */
  waitingOn: string | null;
}

/**
 * A work order as `GET /api/work-orders/:idOrIdentity` returns it (#84).
 *
 * The `document` is the work order itself — the same bytes that went into the
 * authorization record on the issue and the execution record on the branch
 * (#63). Shapes mirror `apps/api/src/cockpit/dto/work-orders.dto.ts`.
 */
export interface WorkOrderDocument {
  schemaVersion: string;
  identity: string;
  branch: string;
  repository: { owner: string; name: string };
  baseCommit: string;
  attempt: number;
  issue: { number: number; url: string };
  decisionRefs?: string[];
  taskSpec: string;
  acceptanceCriteria: string[];
  pathConstraints: string[];
  budgetCeilingUsd: number | null;
  wallClockTimeoutMinutes: number | null;
  needs: string[];
}

export interface WorkOrderRunRef {
  id: string;
  status: string;
  runner: string;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  pullRequestUrl: string | null;
}

export interface WorkOrderDetail {
  id: string;
  status: string;
  holdReason: string | null;
  queuedAt: string | null;
  createdAt: string;
  /** The issue comment carrying the authorization record. Null until dispatch. */
  authorizationCommentUrl: string | null;
  /** The pinned base commit, in full. */
  baseCommit: string;
  document: WorkOrderDocument;
  /** Every attempt, which is success metric 4 made visible. */
  runs: WorkOrderRunRef[];
}

// ---------------------------------------------------------------------------
// Events (VISION §9, "the normalized event floor")
// ---------------------------------------------------------------------------

/**
 * The six normalized event types. Every runner maps into these.
 *
 * This is NOT a mirror of `RunStatus`, and the two must not be collapsed:
 * events are what a runner REPORTS, a status is what the control plane
 * CONCLUDED. `stalled` and `quarantined` have no event because no runner ever
 * reports them — they are watchdog and policy verdicts.
 */
export type RunEventType =
  | 'run.started'
  | 'run.heartbeat'
  | 'run.progress'
  | 'run.blocked'
  | 'run.completed'
  | 'run.failed';

export const RUN_EVENT_TYPES: readonly RunEventType[] = [
  'run.started',
  'run.heartbeat',
  'run.progress',
  'run.blocked',
  'run.completed',
  'run.failed',
];

/**
 * Where an event came from. VISION §9 is emphatic about this field:
 *
 * > a synthesized event must never masquerade as a report.
 *
 * Which is why the activity feed renders it as a visible label rather than
 * treating all three as interchangeable rows. Two independent liveness
 * sources only buy anything if the operator can tell which one spoke.
 */
export type RunEventSource = 'runner' | 'git' | 'control-plane';

export interface RunEvent {
  id: string;
  type: RunEventType;
  source: RunEventSource;
  /** ISO-8601. */
  occurredAt: string;
  runId: string;
  /** The work-order id this event belongs to; shown in the mono token. */
  workOrderId: string;
  /** One line, already rendered for humans by the API. */
  summary: string;
}

// ---------------------------------------------------------------------------
// The six success metrics (VISION §10)
// ---------------------------------------------------------------------------

/**
 * The six metrics the web application, per VISION §10, "exists primarily to
 * show". Their labels, definitions, units and targets live in
 * `components/dashboard/metrics.ts`; only the IDENTIFIERS are here, because
 * both the API type below and the presentation module have to agree on them.
 */
export type MetricId =
  | 'detectionLatency'
  | 'deadTimePerDay'
  | 'firstPassAcceptance'
  | 'attemptsPerWorkOrder'
  | 'costPerMergedPr'
  | 'quotaBurn';

/**
 * Every metric id, in VISION §10's table order — which is also cockpit display
 * order, and is not alphabetical or arbitrary: it runs from the original
 * complaint (detection latency) outward to scheduling health.
 *
 * A value, not just a type, so tests can be exhaustive over the union: a
 * `Record<MetricId, …>` catches a MISSING key at compile time, but only
 * iterating a runtime list catches a key that exists and is wrong.
 */
export const METRIC_IDS: readonly MetricId[] = [
  'detectionLatency',
  'deadTimePerDay',
  'firstPassAcceptance',
  'attemptsPerWorkOrder',
  'costPerMergedPr',
  'quotaBurn',
];

/**
 * One metric's current reading.
 *
 * `value: number | null` is load-bearing and is the type-level half of the
 * honesty contract in `components/common/NotWiredState.tsx`: a metric that has
 * not been computed is `null`, and `null` renders as `—`. Typing it as a bare
 * `number` would have forced the API — or worse, the UI — to invent a `0`, and
 * a zero detection latency is a spectacular claim to make by accident.
 *
 * `trend` is the sparkline series, oldest first. An empty or one-point array
 * draws NOTHING (see `Sparkline`), never a flat line.
 */
export interface MetricSample {
  value: number | null;
  trend: readonly number[];
}

/**
 * `GET /metrics/summary`'s response — the whole dashboard stat row in one
 * request, because six requests to paint one row is six chances to render a
 * half-updated screen.
 */
export interface MetricsSummary {
  /** ISO-8601: when the control plane computed these, not when we fetched. */
  generatedAt: string;
  /** The observation window every value below is computed over. */
  window: { from: string; to: string };
  metrics: Record<MetricId, MetricSample>;
}
