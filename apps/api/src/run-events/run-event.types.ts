/**
 * TypeScript for `schemas/run-event.schema.json`.
 *
 * ## Hand-written, and pinned to the schema by a test
 *
 * #35 (in epic #14) asks for types GENERATED from the schemas rather than
 * hand-written alongside them, and the reason is sound: two definitions drift.
 * That issue is not done, and generating properly means a codegen step, a
 * build-time dependency and a generated file in the tree — worth doing once,
 * for all three schemas, rather than improvised here for one.
 *
 * So this file is the interim, and it is safe only because
 * `run-event.types.spec.ts` pins every enum against the schema JSON itself. A
 * value added to the schema and not here fails that test. When #35 lands, this
 * file is deleted rather than reconciled.
 */

export const RUN_EVENT_SCHEMA_VERSION = '1.0.0';

/** The six normalized types. Closed — a seventh is a schema version bump. */
export type RunEventTypeName =
  | 'run.started'
  | 'run.heartbeat'
  | 'run.progress'
  | 'run.blocked'
  | 'run.completed'
  | 'run.failed';

export const RUN_EVENT_TYPES: readonly RunEventTypeName[] = [
  'run.started',
  'run.heartbeat',
  'run.progress',
  'run.blocked',
  'run.completed',
  'run.failed',
];

/**
 * Where an event came from.
 *
 * VISION §9: *a synthesized event must never masquerade as a report.* Required
 * on every event, with no default, because a watchdog that cannot tell "the
 * runner told me it was blocked" from "I decided it looked blocked" will
 * eventually make an unrecoverable decision on its own guess.
 */
export type RunEventSourceName = 'runner-reported' | 'git-derived' | 'control-plane-synthesized';

export const RUN_EVENT_SOURCES: readonly RunEventSourceName[] = [
  'runner-reported',
  'git-derived',
  'control-plane-synthesized',
];

/**
 * Why a run is blocked.
 *
 * `unknown` is not a synonym for the others: a run blocked for a reason the
 * runner cannot name still parks, but #56 escalates it rather than parking
 * forever, because nothing can compute when it would resume.
 */
export type BlockedReason =
  | 'rate-limit'
  | 'quota-exhausted'
  | 'awaiting-approval'
  | 'upstream-unavailable'
  | 'unknown';

export const BLOCKED_REASONS: readonly BlockedReason[] = [
  'rate-limit',
  'quota-exhausted',
  'awaiting-approval',
  'upstream-unavailable',
  'unknown',
];

export interface RunEventTrace {
  traceId: string;
  spanId?: string;
}

/**
 * Incremental cost for one event.
 *
 * Absent means NOT REPORTED, which is different from zero — VISION §6 makes
 * cost reporting a declared capability, so a runner that cannot report cost
 * must not look like one that spent nothing.
 */
export interface RunEventCost {
  usd?: number;
  tokensInput?: number;
  tokensOutput?: number;
}

/**
 * Tool name plus a normalized argument signature.
 *
 * The signature is a DIGEST computed by the sender, not the raw arguments:
 * arguments can be enormous and can contain secrets, and loop detection (#55)
 * only ever compares them for equality.
 */
export interface RunEventTool {
  name: string;
  signature: string;
  phase?: string;
}

export interface RunEventBlocked {
  reason: BlockedReason;
  /** Absent when the runner cannot say — see `reason: 'unknown'`. */
  resetAt?: string;
  detail?: string;
}

export interface RunEventResult {
  branch?: string;
  headCommit?: string;
  pullRequestUrl?: string;
}

export interface RunEventFailure {
  reason: string;
  /**
   * The runner's own view of whether a retry could succeed. Advisory: policy
   * decides, per VISION §3.6 — no model output takes effect without passing
   * through deterministic policy.
   */
  retryable?: boolean;
}

/** One event on the wire, as `run-event.schema.json` defines it. */
export interface RunEventPayload {
  schemaVersion: string;
  /**
   * Chosen by the SENDER. This is what makes ingestion idempotent: a runner
   * retrying a delivery reuses the id, and the second delivery is recognised
   * rather than stored twice (#53).
   */
  eventId: string;
  runId: string;
  workOrderId: string;
  type: RunEventTypeName;
  source: RunEventSourceName;
  /** When it HAPPENED, per its source — not when Opifex stored it. */
  occurredAt: string;
  summary?: string;
  runner?: string;
  trace?: RunEventTrace;
  cost?: RunEventCost;
  tool?: RunEventTool;
  blocked?: RunEventBlocked;
  result?: RunEventResult;
  failure?: RunEventFailure;
}

// ---------------------------------------------------------------------------
// Mapping onto the Prisma enums
// ---------------------------------------------------------------------------
//
// The database cannot hold a dot in an enum label, and Prisma's `@map` handles
// that at the SQL level — but the generated CLIENT enum uses the underscore
// form, so a translation is needed in one direction. Kept here, next to the
// wire types, rather than scattered across the ingestion and watcher paths.

/** `run.started` -> `run_started`, the generated Prisma client's spelling. */
export function toPrismaEventType(type: RunEventTypeName): string {
  return type.replace('.', '_');
}

/** `control-plane-synthesized` -> `control_plane`. */
export function toPrismaEventSource(source: RunEventSourceName): string {
  switch (source) {
    case 'runner-reported':
      return 'runner';
    case 'git-derived':
      return 'git';
    case 'control-plane-synthesized':
      return 'control_plane';
  }
}
